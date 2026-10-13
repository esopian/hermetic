/**
 * The adapter's subagent ledgers: one per live session, outliving any turn.
 *
 * A background `delegate_task` ends the parent turn at once while its children
 * keep reporting on the parent session, so the ledger that folds their events
 * (`hermes-chat-subagent.ts`) cannot belong to the turn. It belongs to the
 * client, keyed by box and runtime session, and three paths share it: the turn
 * that saw the delegation start (`hermes-chat-turn.ts`), the observation that
 * keeps hearing the children after it ended (`hermes-chat-observe.ts`), and
 * child control (`hermes-chat-subagent-control.ts`), which needs the runtime
 * session a child was spawned under to know whether a resumed session is still
 * that one.
 *
 * Ownership is also the attribution rule for observation. A gateway broadcasts
 * every profile's events, and an event names only a runtime session; the only
 * thing that says which bot and which durable conversation a session belongs
 * to is the turn that opened it. So a turn registers its session as soon as it
 * has one — before the prompt, because a background delegation's children may
 * not say a word until after the turn has ended — and the observation stream
 * carries a child's block only for a registered session whose bot and durable
 * conversation are the watch's own.
 */
import type { ChatBlock, SubagentBlock } from "../../schema/chat.ts";
import type { BoxAddress } from "./hermes-chat-types.ts";
import { createSubagentLedger, type SubagentLedger } from "./hermes-chat-subagent.ts";
import { arr, rec, str } from "./hermes-chat-wire.ts";

/** One session's ledger and the addressing control needs to reach it again. */
export interface SubagentSession {
  box: BoxAddress;
  bot: string;
  /** The runtime session id the children were spawned under. */
  runtime: string;
  /** The durable session `session.resume` takes, when the turn learnt it. */
  stored: string | null;
  ledger: SubagentLedger;
  /**
   * The `delegate_task` calls seen on this session, newest last: what a child
   * is matched to, also when it first reports after its turn ended.
   */
  calls: DelegateCall[];
  /** Turns attached to this session right now: while any is, it is never evicted. */
  turns: number;
}

interface DelegateCall {
  toolId: string;
  goals: string[];
}

/** Calls kept per session. */
const CALLS_MAX = 32;

/**
 * Sessions kept per client. Past it the least recently touched one goes:
 * first one with nothing running, then — when every detached session still
 * has a child its ledger thinks is running, which a session nobody watches
 * again would keep forever — the stalest detached one anyway. A session a
 * turn is attached to is never evicted, so the cap is exceeded only by
 * sessions with a turn in flight.
 */
export const SUBAGENT_SESSIONS_MAX = 64;

export interface SubagentLedgersOptions {
  now?: (() => string) | undefined;
}

export function createSubagentLedgers(opts: SubagentLedgersOptions = {}) {
  /** Insertion-ordered, re-inserted on every touch: the first key is the stalest. */
  const sessions = new Map<string, SubagentSession>();
  const keyOf = (box: BoxAddress, runtime: string): string => `${box.baseUrl}\0${runtime}`;

  function touch(key: string, session: SubagentSession): SubagentSession {
    sessions.delete(key);
    sessions.set(key, session);
    let excess = sessions.size - SUBAGENT_SESSIONS_MAX;
    for (const idle of [true, false]) {
      for (const [stale, held] of sessions) {
        if (excess <= 0) return session;
        if (stale === key || held.turns > 0 || (idle && held.ledger.pending())) continue;
        sessions.delete(stale);
        excess -= 1;
      }
    }
    return session;
  }

  /** The session's ledger, made on first use. A later turn may name its durable id. */
  function session(
    box: BoxAddress,
    bot: string,
    runtime: string,
    stored: string | null,
  ): SubagentSession {
    const key = keyOf(box, runtime);
    const found = sessions.get(key);
    if (found) {
      if (stored && !found.stored) found.stored = stored;
      return touch(key, found);
    }
    const ledger = createSubagentLedger(opts.now ? { now: opts.now } : {});
    return touch(key, { box, bot, runtime, stored, ledger, calls: [], turns: 0 });
  }

  /** A session a turn registered, or null. Never creates one. */
  function existing(box: BoxAddress, runtime: string): SubagentSession | null {
    return sessions.get(keyOf(box, runtime)) ?? null;
  }

  /**
   * The session holding child `subagentId` on this box and bot. When the caller
   * named a durable session, only a ledger for that session (or one that never
   * learnt its durable id) answers.
   */
  function owning(
    box: BoxAddress,
    bot: string,
    subagentId: string,
    stored?: string | null,
  ): SubagentSession | null {
    let found: SubagentSession | null = null;
    for (const s of sessions.values()) {
      if (s.box.baseUrl !== box.baseUrl || s.bot !== bot) continue;
      if (stored && s.stored && s.stored !== stored) continue;
      if (s.ledger.get(subagentId)) found = s;
    }
    return found;
  }

  /** This bot's sessions with a child still running as far as anyone saw. */
  function open(box: BoxAddress, bot: string): SubagentSession[] {
    return [...sessions.values()].filter(
      (s) => s.box.baseUrl === box.baseUrl && s.bot === bot && s.ledger.pending(),
    );
  }

  return { session, existing, owning, open };
}

export type SubagentLedgers = ReturnType<typeof createSubagentLedgers>;

/* ── matching a child to its call ───────────────────────────────────────── */

const normalize = (goal: string): string => goal.trim().replace(/\s+/g, " ").toLowerCase();

/** The goals a `delegate_task` call asked for, in task order. */
function delegationGoals(args: unknown): string[] {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  const asked = rec(value);
  if (!asked) return [];
  const tasks = arr(asked.tasks);
  if (tasks.length > 0) return tasks.map((task) => str(rec(task)?.goal) ?? "");
  const goal = str(asked.goal);
  return goal ? [goal] : [];
}

/**
 * Native events carry no tool linkage, but they carry the goal verbatim from
 * the call's arguments, so a child is matched by goal at its `task_index`
 * first and by goal alone second (Hermes Desktop's `mergeDelegateRows`). No
 * match leaves `tool_id` absent and a head renders the row at the end of the
 * group.
 */
function matchCall(calls: readonly DelegateCall[], block: SubagentBlock): string | null {
  const goal = normalize(block.goal);
  if (!goal) return null;
  const newest = [...calls].reverse();
  const atIndex = newest.find((call) => normalize(call.goals[block.task_index] ?? "") === goal);
  if (atIndex) return atIndex.toolId;
  return newest.find((call) => call.goals.some((g) => normalize(g) === goal))?.toolId ?? null;
}

/** One event through a session's ledger, tied to its call when it first can be. */
function applyLinked(
  session: SubagentSession,
  type: string,
  payload: Record<string, unknown>,
  seq: number,
): SubagentBlock | null {
  const block = session.ledger.apply(type, payload, seq);
  if (!block || block.tool_id) return block;
  const toolId = matchCall(session.calls, block);
  return toolId ? (session.ledger.link(block.subagent_id, toolId) ?? block) : block;
}

/* ── the turn's half ──────────────────────────────────────────────────────── */

/**
 * One turn's view of its session's ledger: every `subagent.*` event on the
 * parent session goes through the ledger and comes back as the child's whole
 * block, tied to the `delegate_task` call that spawned it.
 *
 * Constructing it registers the session, which is why the turn does so before
 * it submits the prompt: a background delegation may spawn its children only
 * after the turn ends, and the observation can attribute them only to a
 * session somebody registered.
 */
export function subagentTurn(
  ledgers: SubagentLedgers,
  where: { box: BoxAddress; bot: string; runtime: string; stored: string | null },
) {
  const attached = ledgers.session(where.box, where.bot, where.runtime, where.stored);
  attached.turns += 1;
  let closed = false;
  /** The registered session, every time: the one the observation reads too. */
  const current = (): SubagentSession =>
    ledgers.session(where.box, where.bot, where.runtime, where.stored);

  function tool(block: ChatBlock): void {
    if (block.kind !== "tool" || block.name.toLowerCase() !== "delegate_task" || !block.tool_id) return;
    const session = current();
    const goals = delegationGoals(block.args);
    const known = session.calls.find((call) => call.toolId === block.tool_id);
    if (known) {
      if (goals.length > 0) known.goals = goals;
      return;
    }
    session.calls.push({ toolId: block.tool_id, goals });
    if (session.calls.length > CALLS_MAX) session.calls.shift();
  }

  function event(type: string, payload: Record<string, unknown>, seq: number): SubagentBlock | null {
    return applyLinked(current(), type, payload, seq);
  }

  /** The turn is over: its session may be evicted again once no child runs. */
  function close(): void {
    if (closed) return;
    closed = true;
    attached.turns -= 1;
  }

  return { tool, event, close };
}

/* ── the observation's half ───────────────────────────────────────────────── */

/** What a watch is about: its bot, and the durable conversation(s) it answers for. */
export interface SubagentWatch {
  box: BoxAddress;
  bot: string;
  session?: string | undefined;
  sessions?: (() => readonly string[]) | undefined;
}

/**
 * Whether a registered session belongs to this watch: the same bot, and a
 * durable session the watch answers for — the one it is pinned to, or the one
 * its last authoritative read resolved to (`sessions`, which is how an
 * unpinned watch on the canonical conversation names it). A session whose
 * durable id is unknown, or a watch that can name none, matches nothing:
 * showing a child in the wrong conversation is worse than not showing it.
 */
export function watches(watch: SubagentWatch, session: SubagentSession): boolean {
  if (session.bot !== watch.bot || !session.stored) return false;
  if (watch.session === session.stored) return true;
  return watch.sessions?.().includes(session.stored) === true;
}

/**
 * A `subagent.*` event heard on the observation socket, as the child's whole
 * block and the durable session it belongs to — or null when no turn in this
 * process registered the event's session, or it is not this watch's.
 */
export function observedSubagent(
  ledgers: SubagentLedgers,
  watch: SubagentWatch,
  event: { runtime: string; type: string; payload: Record<string, unknown>; seq: number },
): { stored: string; block: SubagentBlock } | null {
  const owner = ledgers.existing(watch.box, event.runtime);
  if (!owner?.stored || !watches(watch, owner)) return null;
  const block = applyLinked(owner, event.type, event.payload, event.seq);
  return block ? { stored: owner.stored, block } : null;
}
