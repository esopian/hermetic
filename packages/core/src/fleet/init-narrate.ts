/**
 * The narrated CloudFormation wait: `narrateStack` turns a stack operation's
 * progress callback into `OpEvent`s, and `narrateStackCreate` is the `init`
 * shape of it. Split from `init.ts` so `stack-change.ts` (§6.6) can share the
 * narration without importing the command.
 */
import { STACK_NAME } from "../schema/index.ts";
import type { OpEvent } from "../schema/index.ts";
import type { Backend, StackProgress } from "../backend/types.ts";
import { evt, type EvtFn } from "../events.ts";
import type { InitDeps } from "./init-run.ts";

/** How often the foundation wait says "still creating" when nothing else has happened. */
export const FOUNDATION_HEARTBEAT_MS = 30_000;

/** `foundation` spans this much of the bar; resources landing move it, heartbeats do not. */
export const FOUNDATION_PROGRESS_FROM = 0.35;
export const FOUNDATION_PROGRESS_TO = 0.5;

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Await `p`, a wake-up, or a timer — whichever first — and never leave the timer running. */
function waitAny(p: Promise<unknown>, wake: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    wake,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).then(
    () => {
      if (timer) clearTimeout(timer);
    },
    () => {
      if (timer) clearTimeout(timer);
    },
  );
}

/**
 * What `narrateStack` needs to turn a stack wait into `OpEvent`s. It is the
 * whole difference between narrating a create and narrating an update: the
 * phase name, the slice of the progress bar, the verb the heartbeat uses, and
 * which resource status counts as one resource landing.
 */
export interface StackNarration {
  phase: string;
  /** The slice of the bar this phase owns; resources landing move it, heartbeats do not. */
  from: number;
  to: number;
  /** How many resources are expected, so the events can say `(3/31)`. */
  total: number;
  heartbeatMs: number;
  /** `creating` / `updating`, for the "still …" line. */
  verb: string;
  stackName: string;
  /**
   * Which resource event counts as one resource landing. A create only ever
   * sees `CREATE_COMPLETE`; an *update* lands an `Add` as `CREATE_COMPLETE`, a
   * `Remove` as `DELETE_COMPLETE` and a `Modify` as `UPDATE_COMPLETE`, so
   * matching one spelling would have left the bar at zero for half of them.
   */
  landed: (status: string, resourceType: string) => boolean;
  /**
   * Called once per loop turn, including on every heartbeat. `foundation.update`
   * uses it to push its fleet-wide TTL lock out during a stack update that can
   * outlast the lock (§4.4) — the same job `lockKeeper` does for the unbounded
   * per-agent waits, and it self-throttles the same way.
   */
  heartbeat?: () => Promise<void>;
  evt: EvtFn;
  nowIso: () => string;
}

/**
 * Run a long CloudFormation operation and narrate it: each resource as it
 * lands, each real failure, and a heartbeat after `heartbeatMs` of silence.
 * Returns whatever the operation returned; rethrows whatever it threw.
 *
 * Generic over the operation rather than tied to `createStack`, because
 * `foundation.update` (§6.6) executes a change set and needs exactly the same
 * narration — a stack that says nothing for four minutes is the same problem
 * whichever verb it is doing.
 */
export async function* narrateStack<T>(
  run: (onProgress: (progress: StackProgress) => void) => Promise<T>,
  opts: StackNarration,
): AsyncGenerator<OpEvent, T> {
  const { evt, nowIso } = opts;
  const queue: StackProgress[] = [];
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const running = run((p) => {
    queue.push(p);
    notify();
  });
  let settled = false;
  const done = running.then(
    () => {
      settled = true;
      notify();
    },
    () => {
      settled = true;
      notify();
    },
  );

  let completed = 0;
  let latest: StackProgress | null = null;
  let lastEmitAt = Date.now();
  let progress = opts.from;
  const span = opts.to - opts.from;
  for (;;) {
    while (queue.length > 0) {
      const p = queue.shift() as StackProgress;
      latest = p;
      for (const e of p.events) {
        if (opts.landed(e.status, e.resource_type)) {
          completed += 1;
          progress = Math.min(opts.to - 0.01, opts.from + span * (completed / Math.max(opts.total, 1)));
          yield evt(
            opts.phase,
            progress,
            `${e.logical_id} ${e.status} (${completed}/${opts.total})`,
            nowIso(),
          );
          lastEmitAt = Date.now();
        } else if (e.status.endsWith("_FAILED") && !/creation cancelled/i.test(e.reason ?? "")) {
          yield evt(
            opts.phase,
            progress,
            `${e.logical_id} (${e.resource_type}) ${e.status}: ${e.reason ?? "no reason given"}`,
            nowIso(),
            "error",
          );
          lastEmitAt = Date.now();
        }
      }
    }
    if (settled) break;
    await opts.heartbeat?.();
    const sinceEmit = Date.now() - lastEmitAt;
    if (sinceEmit >= opts.heartbeatMs) {
      yield evt(
        opts.phase,
        progress,
        `still ${opts.verb} ${opts.stackName} — ${latest?.status ?? "waiting for CloudFormation"}, ${fmtElapsed(latest?.elapsed_ms ?? sinceEmit)}${completed > 0 ? `, ${completed}/${opts.total} resources` : ""}${latest && !latest.events_available ? " (grant cloudformation:DescribeStackEvents to see each resource)" : ""}`,
        nowIso(),
      );
      lastEmitAt = Date.now();
      continue;
    }
    await waitAny(
      done,
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
      opts.heartbeatMs - sinceEmit,
    );
  }
  return await running;
}

/**
 * Runs `createStack` and turns its progress callback into events: each
 * resource as it completes, each real failure, and a heartbeat after
 * `heartbeatMs` of silence. Returns the stack; rethrows the create's error.
 */
export async function* narrateStackCreate(
  deps: InitDeps,
  create: Backend["foundation"]["createStack"],
  params: {
    fleet_id: string;
    network: "public" | "nat";
    tags: Record<string, string>;
    signal?: AbortSignal;
  },
  total: number,
): AsyncGenerator<OpEvent, Awaited<ReturnType<Backend["foundation"]["createStack"]>>> {
  return yield* narrateStack(
    (onProgress) =>
      create({
        fleet_id: params.fleet_id,
        network: params.network,
        tags: params.tags,
        ...(params.signal ? { signal: params.signal } : {}),
        onProgress,
      }),
    {
      phase: "foundation",
      from: FOUNDATION_PROGRESS_FROM,
      to: FOUNDATION_PROGRESS_TO,
      total,
      heartbeatMs: deps.heartbeatMs ?? FOUNDATION_HEARTBEAT_MS,
      verb: "creating",
      stackName: STACK_NAME,
      landed: (status) => status === "CREATE_COMPLETE",
      evt,
      nowIso: deps.ctx.nowIso,
    },
  );
}
