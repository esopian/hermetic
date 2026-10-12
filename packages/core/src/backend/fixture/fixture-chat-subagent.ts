/**
 * Delegated children (`delegate_task`) in the fixture, for the subagent UI
 * (WI-14): three prompt triggers, child steer and stop, and the observation
 * stream a background delegation keeps reporting on after its turn ends.
 *
 * - `E2E_SUBAGENT` — synchronous: one child (thinking, three tools, progress,
 *   a `completed` finish with usage), then the parent's own text.
 * - `E2E_SUBAGENT_PARALLEL` — three children at once: one finishes early, one
 *   runs out its budget (`timeout`), one finishes last.
 * - `E2E_SUBAGENT_BACKGROUND` — the top-level default upstream: the tool
 *   answers `{status: "dispatched", delegation_id, goals}` at once and the
 *   parent turn ends; the children keep going on the observation stream as
 *   whole blocks (`ChatObserveHint.subagent`), and a results turn lands in the
 *   transcript when they are done.
 *
 * Every child update is produced the way the real adapter produces it: wire
 * events (`subagent.spawn_requested|start|thinking|tool|progress|complete`,
 * upstream's field names) applied to a real `SubagentLedger`, so a head sees
 * exactly the blocks a box would give it.
 *
 * Control mirrors upstream's answers. A steer on a running child is `queued`
 * and echoes into that child's next tool preview (so "likely applied" is
 * testable); one queued after its last tool misses, and the child's summary
 * carries upstream's `[steer did not land — …]` note; a finished or unknown
 * child is `rejected`. A stop on a running child ends it `interrupted` at its
 * next step and answers `found: true`; anything else is `found: false`.
 *
 * The persisted row keeps the `delegate_task` call with its result in
 * upstream's envelope (`{results: […]}` or the `dispatched` handle) and drops
 * the live blocks, so a history read rebuilds the children through
 * `settledDelegation`, as it does for a real box (`settleFixtureSubagents`).
 *
 * Pacing: every child step waits `delayMs * CHILD_STEP` and a background
 * delegation's results turn `delayMs * RESULTS_GAP` after its last child, both
 * through the injected `sleep` — so the default zero delay (the suite's) runs
 * without a timer, and the heads' `chatDelayMs` knob slows it to watchable.
 */
import { settledDelegation } from "../../chat/hermes/hermes-chat-history.ts";
import { createSubagentLedger, type SubagentLedger } from "../../chat/hermes/hermes-chat-subagent.ts";
import type { SubagentSteerStatus } from "../../chat/hermes/hermes-chat-types.ts";
import type { ChatObserveHint } from "../../chat/chat-observe.ts";
import type { ChatBlock, ChatFrame, SubagentBlock } from "../../schema/index.ts";
import type { FixtureChatActivity, FixtureChatWhere } from "./fixture-chat-activity.ts";
import { usage } from "./fixture-chat-catalog.ts";

export const FIXTURE_SUBAGENT_TRIGGER = "E2E_SUBAGENT";
export const FIXTURE_SUBAGENT_PARALLEL_TRIGGER = "E2E_SUBAGENT_PARALLEL";
export const FIXTURE_SUBAGENT_BACKGROUND_TRIGGER = "E2E_SUBAGENT_BACKGROUND";

/** A child step lasts this many `delayMs`. */
const CHILD_STEP = 6;
/** A background delegation's results turn lands this many `delayMs` after its last child. */
const RESULTS_GAP = 20;

type SequencedFrame = Extract<ChatFrame, { seq: number }>;

interface ChildPlan {
  goal: string;
  model: string;
  thinking: string;
  progress: string;
  tools: { name: string; preview: string }[];
  status: "completed" | "timeout";
  summary: string;
  seconds: number;
  tokens: { input: number; output: number };
  api_calls: number;
  files_read?: string[];
}

const SURVEY: ChildPlan = {
  goal: "Survey disk I/O on the box and name the busiest volume",
  model: "claude-haiku-5",
  thinking: "Start with the device stats, then find which process is writing.",
  progress: "nvme1n1 is at 99% utilisation; looking for the writer",
  tools: [
    { name: "terminal", preview: "iostat -x 1 3" },
    { name: "terminal", preview: "iotop -b -n 1 -o" },
    { name: "read_file", preview: "/etc/fstab" },
  ],
  status: "completed",
  summary:
    "nvme1n1 (the data volume, gp3 at 3000 IOPS) is saturated by postgres WAL writes. " +
    "Raising provisioned IOPS or moving WAL to its own volume would clear it.",
  seconds: 14.2,
  tokens: { input: 18_420, output: 1_210 },
  api_calls: 4,
  files_read: ["/etc/fstab"],
};

const PARALLEL: ChildPlan[] = [
  {
    goal: "Check the postgres slow query log for the last hour",
    model: "claude-haiku-5",
    thinking: "The slow log is under the data directory; read its tail.",
    progress: "Three queries over 2s, all on the events table",
    tools: [
      { name: "terminal", preview: "tail -n 200 /var/lib/postgresql/log/slow.log" },
      { name: "search_files", preview: "events_created_at_idx" },
      { name: "terminal", preview: "psql -c '\\d events'" },
    ],
    status: "completed",
    summary: "Three slow queries, all sequential scans on `events`: the created_at index is missing.",
    seconds: 21.6,
    tokens: { input: 22_104, output: 1_480 },
    api_calls: 5,
    files_read: ["/var/lib/postgresql/log/slow.log"],
  },
  {
    goal: "Read the current gp3 volume settings",
    model: "claude-haiku-5",
    thinking: "One describe call answers this.",
    progress: "Volume found: 500 GiB gp3",
    tools: [{ name: "terminal", preview: "aws ec2 describe-volumes --volume-ids vol-0fixture" }],
    status: "completed",
    summary: "500 GiB gp3, 3000 IOPS, 125 MiB/s — the baseline, never raised.",
    seconds: 6.3,
    tokens: { input: 6_210, output: 402 },
    api_calls: 2,
  },
  {
    goal: "Benchmark the volume with fio",
    model: "claude-haiku-5",
    thinking: "A short random-write run is enough to compare against the baseline.",
    progress: "fio is still running its first pass",
    tools: [
      { name: "terminal", preview: "fio --name=randwrite --rw=randwrite --bs=16k --runtime=60" },
      { name: "terminal", preview: "fio --name=randwrite --rw=randwrite --bs=16k --runtime=120" },
    ],
    status: "timeout",
    summary: "Timed out after 30s waiting for fio; no benchmark result.",
    seconds: 30,
    tokens: { input: 9_880, output: 611 },
    api_calls: 3,
  },
];

const BACKGROUND: ChildPlan[] = [
  {
    goal: "Draft a runbook for raising gp3 IOPS",
    model: "claude-haiku-5",
    thinking: "Outline the steps and the rollback first.",
    progress: "Runbook outline written; adding the rollback",
    tools: [
      { name: "read_file", preview: "/srv/runbooks/README.md" },
      { name: "write_file", preview: "/srv/runbooks/gp3-iops.md" },
    ],
    status: "completed",
    summary: "Wrote /srv/runbooks/gp3-iops.md: modify-volume, wait for optimizing, verify, rollback.",
    seconds: 18.4,
    tokens: { input: 12_030, output: 2_204 },
    api_calls: 4,
    files_read: ["/srv/runbooks/README.md"],
  },
  {
    goal: "Estimate the monthly cost of 6000 IOPS",
    model: "claude-haiku-5",
    thinking: "gp3 charges for IOPS above 3000.",
    progress: "3000 extra IOPS at the regional rate",
    tools: [{ name: "web_search", preview: "gp3 provisioned IOPS price us-east-1" }],
    status: "completed",
    summary: "About $15/month for the extra 3000 IOPS in us-east-1.",
    seconds: 9.1,
    tokens: { input: 7_400, output: 520 },
    api_calls: 2,
  },
];

/* ── one child's run ──────────────────────────────────────────────────────── */

interface ChildState {
  key: string;
  /** A steer waiting for the next tool call. */
  steer: string | null;
  /** Tool calls not yet made. */
  toolsLeft: number;
  interrupted: boolean;
  done: boolean;
}

/** One child, its plan, its control state, and the wire params every event repeats. */
interface Child {
  id: string;
  index: number;
  plan: ChildPlan;
  state: ChildState;
  base: Record<string, unknown>;
}

type Step = {
  child: Child;
  kind: "spawn" | "start" | "thinking" | "tool" | "progress" | "complete";
  tool?: number;
};

/** A child's steps in order: spawn, start, thinking, the tools with progress after the first, complete. */
function stepsOf(child: Child): Step[] {
  const steps: Step[] = [
    { child, kind: "spawn" },
    { child, kind: "start" },
    { child, kind: "thinking" },
  ];
  child.plan.tools.forEach((_, tool) => {
    steps.push({ child, kind: "tool", tool });
    if (tool === 0) steps.push({ child, kind: "progress" });
  });
  steps.push({ child, kind: "complete" });
  return steps;
}

/**
 * The children's steps interleaved, round robin from the third step on — every
 * child is spawned and started first, as upstream's dispatcher does — so the
 * child with the fewest steps finishes first.
 */
function interleave(children: Child[]): Step[] {
  const lists = children.map(stepsOf);
  const out: Step[] = [];
  for (const list of lists) out.push(...list.splice(0, 2));
  while (lists.some((list) => list.length > 0))
    for (const list of lists) {
      const next = list.shift();
      if (next) out.push(next);
    }
  return out;
}

/* ── the module ───────────────────────────────────────────────────────────── */

export interface FixtureSubagentOptions {
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Where a background delegation's results turn lands; absent drops it. */
  activity?: FixtureChatActivity | undefined;
  /** ISO now, for a child's `started_at`. Live-only: never persisted. */
  now?: (() => string) | undefined;
}

/** What a scripted turn needs from the client that runs it. */
export interface FixtureSubagentTurn {
  /**
   * The turn's frames, from seq 1. `signal` stops it: no further step, no
   * further wait, and the children it enlisted are no longer controllable.
   */
  frames(
    message: string,
    where: FixtureChatWhere,
    signal?: AbortSignal,
  ): AsyncGenerator<SequencedFrame>;
}

export function createFixtureSubagents(opts: FixtureSubagentOptions) {
  const children = new Map<string, ChildState>();
  const listeners = new Map<string, Set<(hint: ChatObserveHint) => void>>();
  const whereKey = (instance: string, bot: string): string => `${instance}\0${bot}`;
  const childKey = (instance: string, bot: string, id: string): string => `${instance}\0${bot}\0${id}`;
  let serial = 0;
  /** A child step's wait, cut short by an abort. */
  const stepPause = (signal?: AbortSignal): Promise<void> => {
    if (opts.delayMs <= 0 || signal?.aborted) return Promise.resolve();
    if (!signal) return opts.sleep(opts.delayMs * CHILD_STEP);
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      void opts.sleep(opts.delayMs * CHILD_STEP).then(done);
    });
  };

  /** Children that will make no further step: no longer steerable or stoppable. */
  function retire(kids: readonly Child[]): void {
    for (const kid of kids) {
      kid.state.done = true;
      children.delete(kid.state.key);
    }
  }

  /** Announce a child's block on every hint stream open for this bot. */
  function announce(where: FixtureChatWhere, block: SubagentBlock): void {
    for (const push of listeners.get(whereKey(where.instance, where.bot)) ?? [])
      push({ session: where.session ?? null, subagent: block });
  }

  /**
   * A delegation's children, registered for control. `delegation` is the
   * background handle's id, absent for a synchronous run.
   */
  function enlist(where: FixtureChatWhere, plans: ChildPlan[], delegation: string): Child[] {
    return plans.map((plan, index) => {
      const id = `sa-fixture-${++serial}`;
      const state: ChildState = {
        key: childKey(where.instance, where.bot, id),
        steer: null,
        toolsLeft: plan.tools.length,
        interrupted: false,
        done: false,
      };
      children.set(state.key, state);
      return {
        id,
        index,
        plan,
        state,
        base: {
          subagent_id: id,
          goal: plan.goal,
          task_index: index,
          task_count: plans.length,
          delegation_id: delegation,
          depth: 0,
          model: plan.model,
        },
      };
    });
  }

  /**
   * Run steps through the delegation's ledger, yielding each changed block. A
   * stopped child finishes `interrupted` at its next step and skips the rest.
   */
  async function* run(
    steps: Step[],
    toolId: string,
    ledger: SubagentLedger,
    signal?: AbortSignal,
  ): AsyncGenerator<SubagentBlock> {
    for (const { child, kind, tool } of steps) {
      const { state, plan } = child;
      if (signal?.aborted) return;
      if (state.done) continue;
      if (kind !== "spawn") await stepPause(signal);
      if (signal?.aborted) return;
      if (state.done) continue;
      let method = `subagent.${kind === "spawn" ? "spawn_requested" : kind}`;
      let params: Record<string, unknown> = { ...child.base };
      if (state.interrupted) {
        method = "subagent.complete";
        params = {
          ...params,
          status: "interrupted",
          summary: "Stopped by the operator before it finished.",
          duration_seconds: plan.seconds / 2,
        };
      } else if (kind === "thinking") params.text = plan.thinking;
      else if (kind === "progress") params.text = plan.progress;
      else if (kind === "tool" && tool !== undefined) {
        const call = plan.tools[tool];
        // A queued steer reaches the child at this tool checkpoint; the echo
        // in the preview is the fixture's evidence it was applied.
        const preview = state.steer
          ? `${call?.preview} · steer: ${state.steer}`
          : (call?.preview ?? "");
        state.steer = null;
        state.toolsLeft -= 1;
        params = {
          ...params,
          tool_name: call?.name,
          tool_preview: preview,
          tool_count: plan.tools.length - state.toolsLeft,
        };
      } else if (kind === "complete") {
        const missed = state.steer
          ? `\n\n[steer did not land — the subagent finished before it could be delivered: ${state.steer}]`
          : "";
        params = {
          ...params,
          status: plan.status,
          summary: `${plan.summary}${missed}`,
          duration_seconds: plan.seconds,
          input_tokens: plan.tokens.input,
          output_tokens: plan.tokens.output,
          api_calls: plan.api_calls,
          tool_count: plan.tools.length,
          ...(plan.files_read ? { files_read: plan.files_read } : {}),
          output_tail: plan.tools.slice(-2).map((t) => ({ tool: t.name, preview: t.preview })),
        };
      }
      if (method === "subagent.complete") {
        state.done = true;
        state.steer = null;
      }
      const block = ledger.apply(method, params);
      if (!block) continue;
      ledger.link(block.subagent_id, toolId);
      yield { ...block, tool_id: toolId };
    }
  }

  /** The `{results: […]}` envelope a synchronous `delegate_task` returns. */
  function resultsEnvelope(finished: SubagentBlock[]): string {
    return JSON.stringify({
      results: finished.map((block) => ({
        task_index: block.task_index,
        subagent_id: block.subagent_id,
        status: block.status,
        summary: block.summary ?? "",
        api_calls: block.usage?.api_calls ?? 0,
        duration_seconds: (block.duration_ms ?? 0) / 1000,
        model: block.model ?? "",
        exit_reason: block.status === "completed" ? "completed" : block.status,
        tokens: {
          input: block.usage?.input_tokens ?? 0,
          output: block.usage?.output_tokens ?? 0,
        },
        tool_trace: block.tools.map((t) => ({
          tool: t.name,
          input_summary: t.preview,
          status: t.is_error ? "error" : "ok",
        })),
      })),
      total_duration_seconds: Math.max(0, ...finished.map((b) => (b.duration_ms ?? 0) / 1000)),
    });
  }

  function delegateTool(
    toolId: string,
    plans: ChildPlan[],
    status: "running" | "ok",
    result: string | null,
  ): ChatBlock {
    return {
      kind: "tool",
      tool_id: toolId,
      name: "delegate_task",
      server: null,
      args:
        plans.length === 1 ? { goal: plans[0]?.goal } : { tasks: plans.map((p) => ({ goal: p.goal })) },
      result,
      status,
      exit_code: null,
      duration_ms: status === "ok" ? 0 : null,
      render: null,
    };
  }

  /**
   * The results turn a background delegation lands once its children are
   * done: a bot row in the transcript and a hint on every open stream.
   *
   * Landed through the activity store, because it is the one table both the
   * plain fixture client and the Bot Mode wrapper read a conversation from
   * (`extras`).
   */
  function land(where: FixtureChatWhere, finished: SubagentBlock[]): void {
    if (!opts.activity) return;
    const lines = finished.map((b) => `- **${b.goal}** — ${b.summary ?? b.status}`);
    const markdown = ["Both background tasks are done.", "", ...lines].join("\n");
    opts.activity.arrive(where, markdown, `mx-fixture-delegation-${++serial}`, opts.activity.stamp(), {
      role: "bot",
      blocks: [{ kind: "text", markdown }],
    });
  }

  function script(prompt: string): FixtureSubagentTurn | null {
    const background = prompt.includes(FIXTURE_SUBAGENT_BACKGROUND_TRIGGER);
    const parallel = prompt.includes(FIXTURE_SUBAGENT_PARALLEL_TRIGGER);
    if (!background && !parallel && !prompt.includes(FIXTURE_SUBAGENT_TRIGGER)) return null;
    const plans = background ? BACKGROUND : parallel ? PARALLEL : [SURVEY];
    return {
      async *frames(message, where, signal) {
        let seq = 0;
        const frame = (block: ChatBlock): SequencedFrame => ({
          type: "block",
          seq: ++seq,
          message,
          block,
        });
        const toolId = `tl-fixture-delegate-${++serial}`;
        const delegation = `dlg-fixture-${serial}`;
        const kids = enlist(where, plans, delegation);
        const ledger = createSubagentLedger(opts.now ? { now: opts.now } : {});
        /** Set once a background delegation's children outlive this turn. */
        let handedOff = false;
        try {
          const intro = background
            ? "I'll run these in the background and report back."
            : plans.length > 1
              ? "Splitting this into three parallel tasks."
              : "Handing the disk survey to a subagent.";
          yield frame({ kind: "text", markdown: "" });
          yield { type: "delta", seq: ++seq, message, text: intro };
          yield frame(delegateTool(toolId, plans, "running", null));

          if (background) {
            // Spawned in the turn; everything after rides the observation.
            const steps = interleave(kids);
            const opening = steps.splice(0, kids.length * 2);
            for await (const block of run(opening, toolId, ledger, signal)) yield frame(block);
            if (signal?.aborted) return;
            const handle = JSON.stringify({
              status: "dispatched",
              delegation_id: delegation,
              goals: plans.map((p) => p.goal),
              subagent_ids: kids.map((k) => k.id),
            });
            yield frame(delegateTool(toolId, plans, "ok", handle));
            yield frame({ kind: "text", markdown: "" });
            yield {
              type: "delta",
              seq: ++seq,
              message,
              text: "Dispatched. I will resume when the background tasks finish.",
            };
            yield {
              type: "done",
              seq: ++seq,
              message,
              usage: usage(4_210, 96, 0.0041, "claude-sonnet-5"),
              incomplete: null,
            };
            // The rest happens after the turn, as it does upstream.
            handedOff = true;
            void (async () => {
              const finished = new Map<string, SubagentBlock>();
              for await (const block of run(steps, toolId, ledger)) {
                announce(where, block);
                if (block.verdict !== "running") finished.set(block.subagent_id, block);
              }
              retire(kids);
              if (opts.delayMs > 0) await opts.sleep(opts.delayMs * RESULTS_GAP);
              land(
                where,
                [...finished.values()].sort((a, b) => a.task_index - b.task_index),
              );
            })();
            return;
          }

          const finished = new Map<string, SubagentBlock>();
          for await (const block of run(interleave(kids), toolId, ledger, signal)) {
            if (block.verdict !== "running") finished.set(block.subagent_id, block);
            yield frame(block);
          }
          if (signal?.aborted) return;
          const done = [...finished.values()].sort((a, b) => a.task_index - b.task_index);
          yield frame(delegateTool(toolId, plans, "ok", resultsEnvelope(done)));
          yield frame({ kind: "text", markdown: "" });
          const report =
            done.length === 1
              ? `The subagent reports: ${done[0]?.summary ?? "nothing"}`
              : `${done.filter((b) => b.verdict === "done").length} of ${done.length} tasks finished; ` +
                "the benchmark timed out, so the IOPS numbers come from the volume settings alone.";
          yield { type: "delta", seq: ++seq, message, text: report };
          yield {
            type: "done",
            seq: ++seq,
            message,
            usage: usage(16_880, 402, 0.0233, "claude-sonnet-5"),
            incomplete: null,
          };
        } finally {
          // Finished, aborted, or abandoned by its consumer: unless a
          // background delegation took its children over, none of them will
          // step again, so none may answer a steer or a stop as running.
          if (!handedOff) retire(kids);
        }
      },
    };
  }

  /** Register a hint stream for this bot's child updates. */
  function listen(where: FixtureChatWhere, push: (hint: ChatObserveHint) => void): () => void {
    const key = whereKey(where.instance, where.bot);
    const set = listeners.get(key) ?? new Set();
    set.add(push);
    listeners.set(key, set);
    return () => {
      set.delete(push);
    };
  }

  /** `subagent.steer`: queued on a running child, rejected otherwise. */
  function steer(instance: string, bot: string, id: string, text: string): SubagentSteerStatus {
    const state = children.get(childKey(instance, bot, id));
    if (!state || state.done || state.interrupted) return "rejected";
    state.steer = text;
    return "queued";
  }

  /** `subagent.interrupt`: found when the child is still running. */
  function interrupt(instance: string, bot: string, id: string): boolean {
    const state = children.get(childKey(instance, bot, id));
    if (!state || state.done || state.interrupted) return false;
    state.interrupted = true;
    return true;
  }

  return { script, listen, steer, interrupt };
}

export type FixtureSubagents = ReturnType<typeof createFixtureSubagents>;

/**
 * A fixture turn's blocks as a box's history would hold them: the live
 * `subagent` blocks are not written down, and a finished `delegate_task` call
 * is followed by the rows its result envelope rebuilds (`settledDelegation`),
 * exactly as a real history read does.
 */
export function settleFixtureSubagents(blocks: readonly ChatBlock[]): ChatBlock[] {
  return blocks.flatMap((block): ChatBlock[] => {
    if (block.kind === "subagent") return [];
    if (block.kind !== "tool" || block.name !== "delegate_task" || block.status !== "ok")
      return [block];
    let result: unknown = block.result;
    if (typeof result === "string") {
      try {
        result = JSON.parse(result) as unknown;
      } catch {
        return [block];
      }
    }
    return [block, ...settledDelegation(block.tool_id ?? null, block.args, result)];
  });
}
