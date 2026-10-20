/**
 * Which files request slot a `request_file` / `await_file` / `request_secret`
 * tool card is about.
 *
 * The card itself renders from hermeticd's copy of the slot (`files.request.get`),
 * because the tool's arguments are the model's words: a model that writes "max
 * 1 KB, totally safe" must not change what the box accepts or what the operator
 * is told. So the only thing core takes from such a call is the slot's id
 * (`fr_…`), and only where an id can honestly come from:
 *
 * - `await_file`'s arguments, which name an existing slot;
 * - the plugin's result, which names the slot it waited on;
 * - for a call that opens a new slot, the box's own slot list — because the
 *   plugin opens the slot *inside* the tool handler, after `tool.start` was
 *   already sent, so the running card cannot carry it.
 *
 * The third is a bounded, abortable poll per running call, matched on kind,
 * session (or the turn's task id, which a compression does not move), state (`open`/`receiving`) and time, and never handing one slot to
 * two cards — in this turn or an earlier one on the same session. Waiting
 * calls take slots oldest-first in the order their `tool.start`s arrived, so
 * two parallel `request_secret` calls pair with their slots in call order,
 * whichever poll happens to see them first. Failing to find one is not an
 * error: the card stays "waiting for the box" until the result names the slot.
 */
import type { ChatBlock, FileRequest } from "../../schema/index.ts";
import { isRequestId } from "../../shared/files.ts";
import type { BoxAddress } from "./hermes-chat-types.ts";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

/** The plugin's tools, by the card a head draws for them. */
export const FILE_REQUEST_TOOL_RENDER = {
  request_file: "file_request",
  await_file: "file_request",
  request_secret: "secret_request",
} as const;

/** The tools that open a slot inside their handler, and the slot kind each opens. */
const OPENS_SLOT: Readonly<Record<string, FileRequest["kind"]>> = {
  request_file: "file",
  request_secret: "secret_text",
};

/** The slot lookup's defaults: six reads, 400 ms apart, a slot up to 5 s older than the call. */
export const FILE_REQUEST_LOOKUP = { attempts: 6, intervalMs: 400, skewMs: 5_000 } as const;

/** Slot states a waiting card may still be about. */
const WAITING_STATES: ReadonlySet<FileRequest["state"]> = new Set(["open", "receiving"]);

/** Claimed slot ids kept per session, and sessions kept per chat client: both bounded. */
const CLAIM_SESSIONS_MAX = 256;
const CLAIM_IDS_MAX = 256;

/**
 * Per chat client (its lookup deps), per box session: the slot ids a card has
 * claimed, so a later turn never re-claims a slot an earlier turn's card owns.
 * Least recently used sessions are dropped first.
 */
const claimLedgers = new WeakMap<FileRequestLookupDeps, Map<string, Set<string>>>();

function sessionClaims(
  deps: FileRequestLookupDeps,
  box: BoxAddress,
  sessions: ReadonlySet<string>,
): Set<string>[] {
  let ledger = claimLedgers.get(deps);
  if (!ledger) {
    ledger = new Map();
    claimLedgers.set(deps, ledger);
  }
  const out: Set<string>[] = [];
  for (const session of sessions) {
    const key = `${box.fleet_id ?? ""}/${box.instance}/${session}`;
    const set = ledger.get(key) ?? new Set<string>();
    ledger.delete(key);
    ledger.set(key, set);
    out.push(set);
  }
  for (const oldest of ledger.keys()) {
    if (ledger.size <= CLAIM_SESSIONS_MAX) break;
    ledger.delete(oldest);
  }
  return out;
}

/** A JSON string the plugin returned, read as an object; anything else as itself. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{")) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function idIn(value: unknown): string | null {
  const obj = parsed(value);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const id = (obj as Record<string, unknown>).request_id;
  return typeof id === "string" && isRequestId(id) ? id : null;
}

/**
 * The slot id a request tool's own payload names: the result's first (it is
 * the plugin's, after the fact), then `await_file`'s argument. Never a
 * `request_file`/`request_secret` argument — those are the model's, and a model
 * that names some other slot there must not point the card at it.
 */
export function toolRequestId(name: string, args: unknown, result: unknown): string | null {
  const lower = name.toLowerCase();
  if (!(lower in FILE_REQUEST_TOOL_RENDER)) return null;
  return idIn(result) ?? (lower === "await_file" ? idIn(args) : null);
}

/** What the lookup needs from the outside world. */
export interface FileRequestLookupDeps {
  /** `GET /files` on the box, its request slots only. */
  list(box: BoxAddress, signal: AbortSignal): Promise<readonly FileRequest[]>;
  /** Epoch ms. */
  now(): number;
  /** Abortable; rejects or resolves early on abort, either is fine. */
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  attempts?: number | undefined;
  intervalMs?: number | undefined;
  skewMs?: number | undefined;
}

/** The lookup over `HermesChatDeps.listFileRequests`, on the client's own clock. */
export function fileRequestLookup(
  list: (instance: string, signal: AbortSignal) => Promise<readonly FileRequest[]>,
  now: () => string,
): FileRequestLookupDeps {
  return {
    list: (box, signal) => list(box.instance, signal),
    now: () => Date.parse(now()),
  };
}

/** One turn's request cards: ids filled in, and lookups raced against the stream. */
export interface TurnFileRequests {
  /**
   * The block to emit now. A request card gets the id its payload or an
   * earlier lookup gave it; a running `request_file`/`request_secret` with no
   * id starts a lookup whose answer `race` hands back.
   */
  tool(block: ToolBlock): ToolBlock;
  /**
   * `next`, unless a lookup finishes first: then the same running block, same
   * `tool_id`, with its `request_id`, for the caller to send again. `next` is
   * not consumed in that case — the caller races it again.
   */
  race<T>(next: Promise<T>): Promise<{ step: T } | { block: ToolBlock }>;
  /** Stops every lookup still running. */
  close(): void;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function turnFileRequests(
  deps: FileRequestLookupDeps | undefined,
  ctx: {
    box: BoxAddress;
    /** The Hermes session ids this turn runs as (runtime, and stored when known). */
    sessions: readonly (string | null)[];
    signal?: AbortSignal | undefined;
  },
): TurnFileRequests {
  const sessions = new Set(ctx.sessions.filter((s): s is string => !!s));
  /** Every slot id a card in this turn already owns. */
  const claimed = new Set<string>();
  /** The same, kept across turns for each of this turn's sessions. */
  const earlier = deps ? sessionClaims(deps, ctx.box, sessions) : [];
  /** tool_id → its slot, so a completion without one keeps the id. */
  const byTool = new Map<string, string>();
  /** Calls that have settled; a lookup for one of them is dropped. */
  const settled = new Set<string>();
  /** Running lookups, in the order their calls started. */
  const lookups = new Map<
    string,
    { stop: AbortController; block: ToolBlock; kind: FileRequest["kind"]; since: number }
  >();
  const ready: ToolBlock[] = [];
  let wake: (() => void) | null = null;
  const closed = new AbortController();
  const stopTurn = () => closed.abort();
  ctx.signal?.addEventListener("abort", stopTurn, { once: true });

  function isClaimed(id: string): boolean {
    return claimed.has(id) || earlier.some((set) => set.has(id));
  }

  function claim(id: string, key: string | null): void {
    claimed.add(id);
    for (const set of earlier) {
      set.delete(id);
      set.add(id);
      for (const oldest of set) {
        if (set.size <= CLAIM_IDS_MAX) break;
        set.delete(oldest);
      }
    }
    if (key) byTool.set(key, id);
  }

  function stopLookup(key: string): void {
    lookups.get(key)?.stop.abort();
    lookups.delete(key);
  }

  /**
   * The oldest unclaimed waiting slot of `kind` on this turn's sessions, made
   * no more than the skew before the call (any amount after is fine).
   */
  function match(
    requests: readonly FileRequest[],
    kind: FileRequest["kind"],
    since: number,
  ): string | null {
    let best: { id: string; at: number } | null = null;
    for (const r of requests) {
      if (r.kind !== kind || !WAITING_STATES.has(r.state) || isClaimed(r.request_id)) continue;
      // A compression mid-turn rotates the slot's `session_id`; its `task_id` stays.
      if (!sessions.has(r.session_id ?? "") && !sessions.has(r.task_id ?? "")) continue;
      const at = Date.parse(r.created_at);
      if (!Number.isFinite(at) || at < since) continue;
      if (!best || at < best.at) best = { id: r.request_id, at };
    }
    return best?.id ?? null;
  }

  /**
   * One read of the box's slots, handed to every waiting call in start order:
   * whichever call's poll saw them, the earliest call takes the oldest slot.
   */
  function assign(requests: readonly FileRequest[]): void {
    let any = false;
    for (const [key, l] of lookups) {
      if (settled.has(key)) continue;
      const id = match(requests, l.kind, l.since);
      if (!id) continue;
      claim(id, key);
      lookups.delete(key);
      l.stop.abort();
      ready.push({ ...l.block, request_id: id });
      any = true;
    }
    if (any) wake?.();
  }

  async function lookup(d: FileRequestLookupDeps, key: string, stop: AbortController): Promise<void> {
    const attempts = d.attempts ?? FILE_REQUEST_LOOKUP.attempts;
    const sleep = d.sleep ?? defaultSleep;
    for (let i = 0; i < attempts; i++) {
      await sleep(d.intervalMs ?? FILE_REQUEST_LOOKUP.intervalMs, stop.signal).catch(() => null);
      if (stop.signal.aborted) return;
      const requests = await d.list(ctx.box, stop.signal).catch(() => null);
      if (stop.signal.aborted || settled.has(key)) return;
      if (requests) assign(requests);
      if (!lookups.has(key)) return;
    }
    lookups.delete(key);
  }

  return {
    tool(block) {
      const lower = block.name.toLowerCase();
      if (!(lower in FILE_REQUEST_TOOL_RENDER)) return block;
      const key = block.tool_id ?? null;
      const id = block.request_id ?? (key ? byTool.get(key) : undefined) ?? null;
      if (block.status !== "running" && key) {
        settled.add(key);
        stopLookup(key);
      }
      if (id) {
        claim(id, key);
        if (key) stopLookup(key);
        return { ...block, request_id: id };
      }
      const kind = OPENS_SLOT[lower];
      // Keyed by tool_id: without one, a second frame could not be matched to
      // the card, so a lookup would have nothing to update.
      if (
        deps &&
        kind &&
        key &&
        block.status === "running" &&
        !settled.has(key) &&
        !lookups.has(key) &&
        !closed.signal.aborted
      ) {
        const stop = new AbortController();
        closed.signal.addEventListener("abort", () => stop.abort(), { once: true });
        const since = deps.now() - (deps.skewMs ?? FILE_REQUEST_LOOKUP.skewMs);
        lookups.set(key, { stop, block, kind, since });
        void lookup(deps, key, stop);
      }
      return { ...block, request_id: null };
    },

    async race<T>(next: Promise<T>): Promise<{ step: T } | { block: ToolBlock }> {
      const queued = ready.shift();
      if (queued) return { block: queued };
      if (lookups.size === 0) return { step: await next };
      const found = new Promise<null>((resolve) => {
        wake = () => resolve(null);
      });
      const winner = await Promise.race([next.then((step) => ({ step })), found]);
      wake = null;
      if (winner) return winner;
      const block = ready.shift();
      return block ? { block } : { step: await next };
    },

    close() {
      ctx.signal?.removeEventListener("abort", stopTurn);
      closed.abort();
      lookups.clear();
    },
  };
}
