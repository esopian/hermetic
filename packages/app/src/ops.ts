/**
 * The ops registry. Every streaming core method (§3.2 rule 2) runs here as a
 * background op: the POST returns `202 { op_id }` at once and the events are
 * buffered in memory, so `GET /api/ops/:id/stream` can replay what already
 * happened and then tail the rest. That is what makes the UI's "run in
 * background" real — closing the tab does not cancel anything, and reopening it
 * shows the whole op, not just the tail.
 */
import { randomUUID } from "node:crypto";
import type {
  OpEvent,
  PendingOpIdentity,
  PendingOpStore,
  RunRecorder,
  RunTarget,
} from "@hermetic/core";
import { isHermeticError } from "@hermetic/core";
import { type Contention, classifyContention } from "./contention.ts";
import { INTERNAL_MESSAGE } from "./errors.ts";
import type { AppLog } from "./log.ts";

/** Ring-buffer cap. Older events are dropped, and the drop is reported. */
export const MAX_BUFFERED_EVENTS = 5000;

/** How many settled ops are kept for inspection. Running ops are never evicted. */
export const MAX_FINISHED_OPS = 200;

/** Settled ops older than this are evicted regardless of the count. */
export const FINISHED_OP_TTL_MS = 24 * 60 * 60 * 1000;

/** Default page size for `ops.list`. */
export const OPS_PAGE_SIZE = 50;

/**
 * How long a tailing `follow` goes quiet before it yields a keepalive.
 *
 * Long phases are minutes of silence — a CloudFormation create is the usual
 * one — and a transport that reads silence as a dead channel drops it, then
 * reconnects and replays, and the operator watches the same two lines repeat.
 * The quiet is the source's to notice (`handlers/streams.ts`), so it is
 * measured here.
 */
export const FOLLOW_KEEPALIVE_MS = 5000;

export type OpStatus = "running" | "ok" | "error" | "aborted";

export interface OpError {
  code: string;
  message: string;
}

export interface OpStartOptions {
  /**
   * What the op was started with, for a client that wants to show it. Callers
   * pass a *redacted* copy — `init` runs it through core's `redactInitInput`
   * first, because the Tailscale OAuth client secret must not survive the
   * request that carried it (§8.3).
   */
  input?: unknown;
  /**
   * Record this op in the durable pending log, so a process that dies while it
   * runs leaves a row saying so (`resume.ts`). Only ops whose `input` carries
   * no secret may set it — it is the same `input` a boot replays, so a caller
   * that redacts must not set this.
   *
   * Recording the row is not the same as promising to replay it. `resume.ts`
   * decides that: a method that is idempotent against reality is finished
   * automatically, and one that is not (`agents.recreate`) is reported to the
   * operator instead, which needs the row just as much (`core/local/recovery.ts`).
   */
  resumable?: boolean;
  /**
   * Set when this op *is* a resume: the pending row already exists under this
   * id and must be reused rather than re-claimed with a fresh one.
   */
  resumedId?: string;
  /**
   * Which attempt at that id this is, from the pending row's attempt count.
   * Carried onto every frame of the stream so a browser holding a cursor from
   * the attempt before a restart can tell that its cursor is obsolete rather
   * than filtering out an entire resumed run.
   */
  generation?: number;
  /**
   * What the op's target looked like when it was started (§4.7): the instance
   * id and the creation stamp of the agent row it names. Recorded on the
   * pending row so a resume at the next boot can tell the agent the operator
   * confirmed from a successor that took its name (`resume.ts`).
   */
  identity?: PendingOpIdentity | null;
  /**
   * The agent the run row names, when it is not `target`: a fleet-level plan's
   * target (`tailnet`, a `fleet_id`) is no agent (§4.6/§4.9). Absent, `target`.
   */
  agent?: string | null;
}

export interface OpSummary {
  id: string;
  /** Dotted core method, e.g. `agents.create`. */
  method: string;
  target: string | null;
  status: OpStatus;
  /** Present when the caller supplied one; never carries a secret. */
  input?: unknown;
  started_at: string;
  finished_at: string | null;
  event_count: number;
  dropped: number;
  error: OpError | null;
}

/**
 * What every op-starting method answers with: the op, and its id at the top
 * level, which is what the page follows (`Accepted` in `ui/src/api/types.ts`).
 * The HTTP head answered `202 {op_id, op}`; when the routes became handlers the
 * `op_id` was dropped, and every progress rail in the app followed `undefined`.
 */
export interface Accepted {
  op_id: string;
  op: OpSummary;
}

export function accepted(op: OpSummary): Accepted {
  return { op_id: op.id, op };
}

export type OpMessage =
  | { type: "event"; seq: number; generation: number; event: OpEvent }
  | { type: "done"; seq: number; generation: number; ok: boolean; error: OpError | null }
  /** Nothing happened for the keepalive period; the socket is still wanted. Never buffered. */
  | { type: "keepalive" };

export interface FollowOptions {
  /** Resume after this sequence number (`Last-Event-ID`); the replay skips up to and including it. */
  after?: number;
  /**
   * Which attempt that sequence number came from. A resumed op keeps its id but
   * starts a fresh buffer at `seq` 0, so a cursor from the attempt before the
   * restart would filter out every event of this one — `done` included, leaving
   * the browser on keepalives for ever over a backend that had finished. A
   * cursor whose generation is not this record's is an obsolete cursor and is
   * ignored, which replays this attempt from the start.
   */
  generation?: number;
}

interface OpRecord extends OpSummary {
  events: OpEvent[];
  /** Absolute sequence number of `events[0]`. */
  base: number;
  next: number;
  /**
   * Which attempt this record is. Zero for an op started here; the pending
   * row's attempt count for one picked up at boot (`resume.ts`), so every
   * attempt at the same op id numbers itself differently and a client can tell
   * a replay of *this* attempt from a cursor it kept across the restart.
   */
  generation: number;
  /** Whether a pending row exists for this op, so a settle has one to clear. */
  resumable: boolean;
  /** The last phase pushed, so a change is written to the pending row once. */
  phase: string | null;
  controller: AbortController;
  listeners: Set<(m: OpMessage) => void>;
  finished: Promise<void>;
}

export interface OpRegistryOptions {
  /**
   * The local `runs` log (§4.6). Every op the server starts is recorded there,
   * so `hermetic runs` is the whole laptop's history and not just the CLI's.
   * Tests leave it out and touch no disk.
   */
  runs?: RunRecorder;
  /**
   * The durable in-flight log (§4.6). An op started with `resumable` writes a
   * row here and deletes it the moment it settles, so anything still present at
   * boot is an op whose process died. Tests leave it out and touch no disk.
   */
  pending?: PendingOpStore;
  /**
   * Where op starts, outcomes and events go so a failure is visible in the
   * server terminal and `<home>/app.log`, not only in the browser that
   * happened to be streaming it (see `log.ts`).
   */
  log?: AppLog;
  /**
   * What the ops started here are against (§4.6/§4.8) — account, region,
   * `fleet_id` and the display alias at the time — read at `start` time.
   * `main/index.ts` passes `AppState.runTarget`; tests may pass a constant.
   */
  target?: () => RunTarget | null;
  /** Quiet period before `follow` yields a keepalive. Default `FOLLOW_KEEPALIVE_MS`; tests shorten it. */
  keepaliveMs?: number;
  /**
   * The clock every timestamp and every eviction decision reads. Injected so
   * `FINISHED_OP_TTL_MS` can be tested in milliseconds rather than in a day,
   * and so ops started in the same millisecond still order deterministically.
   */
  now?: () => number;
}

export class OpRegistry {
  private readonly ops = new Map<string, OpRecord>();
  private readonly runs: RunRecorder | undefined;
  private readonly pending: PendingOpStore | undefined;
  private readonly log: AppLog | undefined;
  private readonly keepaliveMs: number;
  private readonly now: () => number;
  /**
   * §4.8: what the ops started here are against. A getter rather than a value
   * because the portal can switch fleets under a registry that outlives the
   * switch, and mutable rather than a constructor option for the same reason
   * `createApp` binds it: the registry is a `--hot` singleton while the
   * `AppState` it reads is not.
   */
  private runTarget: () => RunTarget | null = () => null;

  constructor(options: OpRegistryOptions = {}) {
    this.runs = options.runs;
    this.pending = options.pending;
    this.log = options.log;
    this.keepaliveMs = options.keepaliveMs ?? FOLLOW_KEEPALIVE_MS;
    this.now = options.now ?? Date.now;
    if (options.target) this.runTarget = options.target;
  }

  /**
   * Tells the registry which fleet it is recording against (§4.6). Called by
   * `createApp` with the live `AppState`, so a fleet switch moves the target
   * on everything started after it without moving it on anything already
   * running.
   */
  bindTarget(target: () => RunTarget | null): void {
    this.runTarget = target;
  }

  /** Kicks the op off immediately; the caller gets an id, not a stream. */
  start(
    method: string,
    target: string | null,
    /**
     * The op's own id is handed back to the runner, for the one core method
     * that records it: `teardown` stamps it on the receipt (§4.6) so a stored
     * record and the stream a browser watched are recognisably one run.
     */
    run: (signal: AbortSignal, opId: string) => AsyncIterable<OpEvent>,
    options: OpStartOptions = {},
  ): OpSummary {
    // A resume keeps the original id, so the pending row, the `runs` row and
    // the op the browser reattaches to all stay one run across a restart.
    const id = options.resumedId ?? randomUUID();
    const controller = new AbortController();
    const rec: OpRecord = {
      id,
      method,
      target,
      status: "running",
      ...(options.input !== undefined ? { input: options.input } : {}),
      started_at: new Date(this.now()).toISOString(),
      finished_at: null,
      event_count: 0,
      dropped: 0,
      error: null,
      events: [],
      base: 0,
      next: 0,
      generation: options.generation ?? 0,
      resumable: options.resumable === true || options.resumedId !== undefined,
      phase: null,
      controller,
      listeners: new Set(),
      finished: Promise.resolve(),
    };
    this.ops.set(id, rec);
    this.log?.line("info", `op:${method}`, "started", { op: id, target });
    // The row is opened before the op runs, so an op still in flight is visible
    // in `hermetic runs` rather than appearing only once it ends.
    const against = this.runTarget();
    try {
      this.runs?.start({
        id,
        command: method,
        args: target === null ? [] : [target],
        agent: options.agent !== undefined ? options.agent : target,
        started_at: rec.started_at,
        /**
         * §4.6: the whole target, not just its id. The portal resolved its
         * fleet before it served a single request, so unlike the CLI it can
         * write the attribution as the row is opened rather than stamping it
         * afterwards.
         */
        fleet: against?.fleet_id ?? null,
        account_id: against?.account_id ?? null,
        region: against?.region ?? null,
        fleet_name: against?.fleet_name ?? null,
      });
    } catch {
      // A run log that cannot be written must never stop the fleet working.
    }
    if (options.resumable === true && options.resumedId === undefined) {
      try {
        this.pending?.claim({
          id,
          method,
          target,
          input: options.input ?? null,
          started_at: rec.started_at,
          // §4.8: so a portal that comes back up on another fleet leaves this
          // row alone rather than replaying it against the wrong one — and
          // §4.7, so "another fleet" means the whole triple and not eight
          // characters two accounts could both mint.
          fleet: against?.fleet_id ?? null,
          account_id: against?.account_id ?? null,
          region: against?.region ?? null,
          target_identity: options.identity ?? null,
        });
      } catch {
        // Same as the run log: losing the ability to resume must never stop
        // the op that is about to run.
      }
    }
    rec.finished = this.consume(rec, run);
    return summarize(rec);
  }

  private async consume(
    rec: OpRecord,
    run: (signal: AbortSignal, opId: string) => AsyncIterable<OpEvent>,
  ): Promise<void> {
    /**
     * §4.4: set when the op was refused by a lease that was still live rather
     * than by anything it could have done differently. The pending row survives
     * that outcome — see the `finally` below.
     */
    let contention: Contention | null = null;
    try {
      for await (const event of run(rec.controller.signal, rec.id)) {
        this.push(rec, event);
      }
      rec.status = "ok";
      this.log?.line("info", `op:${rec.method}`, "ok", {
        op: rec.id,
        target: rec.target,
        events: rec.event_count,
      });
    } catch (e) {
      const code = isHermeticError(e) ? e.code : "INTERNAL";
      rec.status = code === "ABORTED" ? "aborted" : "error";
      contention = rec.resumable ? classifyContention(e, this.now()) : null;
      const message = e instanceof Error ? e.message : String(e);
      /**
       * The same split `errors.ts` makes on the request path, and for the same
       * reason: this record is served verbatim by `GET /api/ops`, `GET
       * /api/ops/:id` and the stream's `done` frame. A `HermeticError`'s
       * message is core's, written to be shown, and goes out whole — including
       * `INTERNAL` ones, which name the AWS call that failed and are the most
       * useful line the init wizard ever displays. Anything *unclassified* is a
       * bug's message: a TypeError, an SDK internal naming an ARN, a string
       * built from whatever the caller sent. The operator still gets it, in the
       * log line immediately below.
       */
      rec.error = { code, message: isHermeticError(e) ? message : INTERNAL_MESSAGE };
      // The line an operator reading the terminal needs: which op, which
      // code, core's message — or, for an unclassified throw, the real text
      // the client was not given. A non-Hermetic error also gets its stack at
      // debug (file only) — that is the bug report.
      this.log?.line(
        rec.status === "aborted" ? "warn" : "error",
        `op:${rec.method}`,
        `${rec.status} ${code}: ${message}`,
        {
          op: rec.id,
          target: rec.target,
        },
      );
      if (!isHermeticError(e) && e instanceof Error && e.stack) {
        this.log?.line("debug", `op:${rec.method}`, e.stack, { op: rec.id });
      }
    } finally {
      rec.finished_at = new Date(this.now()).toISOString();
      try {
        if (contention === null) {
          // Settled is settled, however it settled: the pending row means "this
          // process died mid-op", and an op that reached an outcome did not.
          this.pending?.clear(rec.id);
        } else {
          /**
           * §4.4: the one outcome that is neither. The op was refused by
           * somebody else's live lease, so the operator's instruction is still
           * outstanding and the row stays — stamped with the moment that lease
           * lapses, which is when a boot or this process may try it again.
           * Taking the work back any sooner would mean overriding an owner
           * that is, as far as anything here knows, still working.
           */
          this.pending?.defer(rec.id, contention.retry_after);
          this.log?.line(
            "warn",
            `op:${rec.method}`,
            `left pending until ${contention.retry_after}: ${contention.owner ?? "another operator"} holds it`,
            { op: rec.id, target: rec.target },
          );
        }
      } catch {
        // A stale row costs one wasted resume, which core is idempotent against.
      }
      const message: OpMessage = {
        type: "done",
        seq: rec.next,
        generation: rec.generation,
        ok: rec.status === "ok",
        error: rec.error,
      };
      rec.next += 1;
      for (const l of [...rec.listeners]) l(message);
      try {
        this.runs?.finish(rec.id, {
          exit_code: rec.status === "ok" ? 0 : 1,
          // Op events carry phases and messages, never values (§8.3).
          log: rec.events.map((e) => `${e.phase}: ${e.message}`).join("\n"),
          /**
           * §4.9: the seam both heads pass through. Everything in
           * this registry is a long operation by construction, so the only
           * question is how it settled — and core words the row, so the portal
           * and the CLI cannot come to describe the same failure differently.
           *
           * An **aborted** op is deliberately silent: stopping an op is the
           * operator's own action, and a notification about it would be the
           * portal telling them what they just clicked.
           */
          ...(rec.status === "aborted"
            ? {}
            : { op: { method: rec.method, ...(rec.error ? { error: rec.error } : {}) } }),
        });
      } catch {
        // Same: the log is a convenience, not a dependency.
      }
      this.evict();
    }
  }

  private push(rec: OpRecord, event: OpEvent): void {
    const seq = rec.next;
    rec.next += 1;
    // Every event lands in the file; warnings also reach the terminal.
    this.log?.line(
      event.level === "warn" || event.level === "error" ? event.level : "debug",
      `op:${rec.method}`,
      `${event.phase}: ${event.message}`,
      { op: rec.id },
    );
    rec.events.push(event);
    rec.event_count += 1;
    // §4.6: how far the op had got, on the durable row, so an interrupted one
    // can say where it stopped. Written on a change of phase rather than on
    // every event — a phase is a label, and the row is not an event log.
    if (rec.resumable && event.phase !== rec.phase) {
      rec.phase = event.phase;
      try {
        this.pending?.progress(rec.id, event.phase);
      } catch {
        // Losing the marker costs a vaguer message, never the op.
      }
    }
    while (rec.events.length > MAX_BUFFERED_EVENTS) {
      rec.events.shift();
      rec.base += 1;
      rec.dropped += 1;
    }
    for (const l of [...rec.listeners]) l({ type: "event", seq, generation: rec.generation, event });
  }

  get(id: string): OpSummary | undefined {
    const rec = this.ops.get(id);
    return rec ? summarize(rec) : undefined;
  }

  /**
   * Newest first, paged. An operator who has been running the server for a week
   * should not receive every op they ever started in one response.
   */
  list(options: { limit?: number; cursor?: string; target?: string; status?: OpStatus } = {}): {
    ops: OpSummary[];
    next_cursor: string | null;
  } {
    const all = [...this.ops.values()]
      .map(summarize)
      .filter((o) => options.target === undefined || o.target === options.target)
      .filter((o) => options.status === undefined || o.status === options.status)
      .sort((a, b) =>
        a.started_at === b.started_at ? (a.id < b.id ? 1 : -1) : a.started_at < b.started_at ? 1 : -1,
      );
    const limit = Math.min(Math.max(options.limit ?? OPS_PAGE_SIZE, 1), 500);
    const from = options.cursor === undefined ? 0 : all.findIndex((o) => o.id === options.cursor) + 1;
    const page = all.slice(from, from + limit);
    const next = from + limit < all.length ? (page[page.length - 1]?.id ?? null) : null;
    return { ops: page, next_cursor: next };
  }

  /** Settled ops are kept for inspection, but not forever and not unboundedly. */
  private evict(now = this.now()): void {
    const finished = [...this.ops.values()].filter((r) => r.status !== "running");
    for (const rec of finished) {
      const at = rec.finished_at === null ? now : Date.parse(rec.finished_at);
      if (now - at > FINISHED_OP_TTL_MS) this.ops.delete(rec.id);
    }
    // Newest first, and — for two ops that started in the same millisecond —
    // insertion order, which `Map` preserves and a stable sort keeps. Without
    // the tiebreak the tail this slices off is whichever of a tied group the
    // sort happened to move, rather than the oldest.
    const remaining = [...this.ops.values()]
      .filter((r) => r.status !== "running")
      .reverse()
      .sort((a, b) => (a.started_at === b.started_at ? 0 : a.started_at < b.started_at ? 1 : -1));
    for (const rec of remaining.slice(MAX_FINISHED_OPS)) this.ops.delete(rec.id);
  }

  /** Trips the op's AbortSignal. Core unwinds and throws `ABORTED`. */
  abort(id: string): boolean {
    const rec = this.ops.get(id);
    if (rec?.status !== "running") return false;
    rec.controller.abort();
    return true;
  }

  /** Waits for an op to settle. Tests use it; routes never do. */
  async wait(id: string): Promise<OpSummary | undefined> {
    const rec = this.ops.get(id);
    if (!rec) return undefined;
    await rec.finished;
    return summarize(rec);
  }

  /**
   * Replays the buffer (from `options.after` on, if given), then tails live
   * until the op finishes, yielding a keepalive whenever the tail goes quiet.
   * Ends with exactly one `done` message however the op ended.
   */
  async *follow(
    id: string,
    signal?: AbortSignal,
    options: FollowOptions = {},
  ): AsyncGenerator<OpMessage> {
    const rec = this.ops.get(id);
    if (!rec) return;
    /**
     * A cursor is only worth honouring when it came from the attempt this
     * record *is*. A resumed op reuses its id and starts counting again from
     * zero, so a browser that reconnects with what it had before the restart
     * would otherwise ask to skip past the whole of the new attempt. An
     * unstated generation is read as this record's, which is what every client
     * of a never-resumed op sends.
     */
    const stale = options.generation !== undefined && options.generation !== rec.generation;
    const after = stale ? -1 : (options.after ?? -1);

    const queue: OpMessage[] = [];
    let wake: (() => void) | null = null;
    const listener = (m: OpMessage) => {
      queue.push(m);
      wake?.();
    };
    // A disconnecting client must be able to unblock the wait below, or the
    // listener leaks until the op finishes.
    const onAbort = () => wake?.();
    signal?.addEventListener("abort", onAbort);
    rec.listeners.add(listener);
    try {
      let last = after;
      for (const [i, event] of rec.events.entries()) {
        const seq = rec.base + i;
        if (seq <= after) continue;
        last = seq;
        yield { type: "event", seq, generation: rec.generation, event };
      }
      if (rec.status !== "running") {
        yield {
          type: "done",
          seq: rec.next,
          generation: rec.generation,
          ok: rec.status === "ok",
          error: rec.error,
        };
        return;
      }
      for (;;) {
        if (signal?.aborted) return;
        if (queue.length === 0) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const quiet = await new Promise<boolean>((resolve) => {
            wake = () => resolve(false);
            timer = setTimeout(() => resolve(true), this.keepaliveMs);
          });
          wake = null;
          if (timer !== null) clearTimeout(timer);
          if (signal?.aborted) return;
          if (quiet) {
            yield { type: "keepalive" };
            continue;
          }
        }
        const message = queue.shift();
        if (!message || message.type === "keepalive") continue; // listeners never queue keepalives
        /**
         * The de-duplication is for replayed *events*, and it never applies to
         * `done`. An op ends exactly once, the client is waiting for that frame
         * to stop waiting, and a sequence number is not a reason good enough to
         * withhold the end of a stream from somebody watching it.
         */
        if (message.type !== "done" && message.seq <= last) continue;
        last = message.seq;
        yield message;
        if (message.type === "done") return;
      }
    } finally {
      rec.listeners.delete(listener);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function summarize(rec: OpRecord): OpSummary {
  return {
    id: rec.id,
    method: rec.method,
    target: rec.target,
    status: rec.status,
    ...(rec.input !== undefined ? { input: rec.input } : {}),
    started_at: rec.started_at,
    finished_at: rec.finished_at,
    event_count: rec.event_count,
    dropped: rec.dropped,
    error: rec.error,
  };
}
