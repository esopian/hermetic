/**
 * The developer tools' capture (§9.2 "Developer tools"): one bounded ring of
 * `TapRecord`s per conversation, held in this process's memory and nowhere
 * else.
 *
 * ## What is captured, and where
 *
 * Four layers feed it, each from the one place that sees them:
 *
 * - `wire`: every JSON-RPC document read off or written to a Hermes dashboard
 *   socket (`hermes-chat-rpc.ts`), through the socket's `TapSlot`
 *   (`devtap-slot.ts`), which also knows which conversation the socket is for.
 * - `frame`: every `ChatFrame` `chat.send` hands a head, after the redaction
 *   door (`chat-send.ts`), with `parent` naming the wire record it came from.
 * - `observe`: what the observation service saw and said (`chat-observe.ts`).
 * - `conn`: connection facts — dial, token scrape, session create/resume,
 *   close, reconnect, replay.
 *
 * ## Off means absent
 *
 * The tools are off by default, and off is not "on, but quiet": there is no
 * `DevTap` at all (`devtools.ts` hands out `null`), every tap site is a single
 * optional chain on that null, and turning the tools off discards every ring at
 * once (`close`). A record never outlives the switch that allowed it.
 *
 * ## Masking
 *
 * Three rules, in the order they apply:
 *
 * 1. Credentials are masked whatever any preference says (`alwaysMask`): the
 *    dashboard token in a socket URL, an `Authorization` header, an error's
 *    text. These are never content the operator chose to see whole.
 * 2. With Chat › Redact secrets on at capture, the payload is masked *before*
 *    it is buffered, so the ring never holds the secret.
 * 3. With it off at capture, the record is held as captured — and masked on
 *    the way out if redaction is on by the time it is read. An export is always
 *    masked (`exportRing`), because an export is a file that leaves the app.
 *
 * `bytes` is the size as received, before any of that.
 */
import type {
  ChatFrame,
  DevtoolsCapture,
  DevtoolsConversation,
  DevtoolsExport,
  DevtoolsFate,
  DevtoolsKeep,
  DevtoolsLayer,
  DevtoolsStats,
  TapRecord,
} from "../schema/index.ts";
import { REDACTED, redactDeep } from "./chat-redact.ts";

/** What a tap site hands in. Everything not stated defaults to "not known". */
export interface TapEntry {
  layer: DevtoolsLayer;
  dir: "in" | "out";
  type: string;
  socket?: string | null | undefined;
  seq?: number | null | undefined;
  parent?: string | null | undefined;
  fate?: DevtoolsFate | null | undefined;
  synthetic?: boolean | undefined;
  payload: unknown;
  /** The payload as it arrived, when the site has it: sized instead of re-serialising. */
  raw?: string | undefined;
}

export interface DevTapOptions {
  capture: DevtoolsCapture;
  keep: DevtoolsKeep;
  /** Chat › Redact secrets, read at each capture and each read. */
  redact: () => boolean;
  /** Epoch milliseconds; injected so a test is deterministic. */
  now?: (() => number) | undefined;
  /** Monotonic milliseconds; defaults to `performance.now`. */
  mono?: (() => number) | undefined;
}

/** Where a tap site finds the tap: `null` whenever the tools are off. */
export type TapSource = () => DevTap | null;

/** Every record id in this process, `t1`, `t2`, … across every tap ever built. */
let nextRecord = 0;

/**
 * The most one conversation's ring may hold, in bytes as received, whatever
 * `keep` says. `keep` counts records, and a few tool results carrying a file
 * or a screenshot can be megabytes each: 20,000 of those would be a laptop's
 * memory. The oldest records go first, and count as `dropped`; the newest is
 * kept even when it alone is over.
 */
export const DEVTAP_RING_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How many conversations hold a ring at once. A fleet of thirteen boxes with a
 * handful of bots and sessions each stays under it; past it, the ring written
 * to longest ago is discarded whole (its records count as `dropped`). A ring an
 * inspector is reading is never discarded, so this may be exceeded by those.
 */
export const DEVTAP_MAX_RINGS = 64;

/**
 * The most every ring together may hold, in bytes as received: the two caps
 * above multiply to 2 GiB, which no laptop should spend on a debugging aid.
 * Past it, unread rings are discarded whole, least recently written first;
 * if every ring left is being read (or is the one just written), the largest
 * ring loses its oldest records instead, down to its newest one. Either way
 * the loss counts as `dropped`.
 */
export const DEVTAP_TOTAL_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Which record a wire document became, by the object the reader handed up.
 *
 * Process-wide and weak: the turn loop holds the event object, not the tap, and
 * looking its record up here is what lets it settle a fate and give a frame its
 * `parent` without either module knowing about the other's bookkeeping. An
 * object nobody holds any more takes its entry with it.
 */
const tags = new WeakMap<object, TapMark>();

export function tagRecord(value: object, mark: TapMark): void {
  tags.set(value, mark);
}

/** The record `value` was read as, when the tap saw it. */
export function recordOf(value: unknown): TapMark | undefined {
  return value !== null && typeof value === "object" ? tags.get(value) : undefined;
}

/** One captured record, and the handle a tap site settles its fate through. */
export class TapMark {
  /** The ring it was placed in; null while its socket is not yet bound. */
  ring: Ring | null = null;
  constructor(
    readonly record: TapRecord,
    /** Whether `payload` was masked before it was held. */
    readonly masked: boolean,
    /** The tap that made it; another tap refuses to place it (`DevTap.place`). */
    readonly owner: DevTap,
  ) {}

  get id(): string {
    return this.record.id;
  }

  /**
   * What became of it. A record already delivered to an inspector is delivered
   * again with the same id, so a reader upserts by id.
   */
  settle(fate: DevtoolsFate): void {
    if (sameFate(this.record.fate, fate)) return;
    this.record.fate = fate;
    if (this.ring !== null) this.owner.notify(this.ring, this);
  }
}

interface Subscriber {
  push(mark: TapMark): void;
  end(): void;
}

interface Ring {
  key: string;
  conversation: DevtoolsConversation;
  marks: TapMark[];
  bytes: number;
  subscribers: Set<Subscriber>;
}

export class DevTap {
  private capture: DevtoolsCapture;
  private keep: number;
  private readonly redact: () => boolean;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly rings = new Map<string, Ring>();
  /** `instance\0bot` → the session currently known to be that bot's canonical one. */
  private readonly canonicals = new Map<string, string>();
  private dropped = 0;
  private alive = true;

  constructor(opts: DevTapOptions) {
    this.capture = opts.capture;
    this.keep = opts.keep;
    this.redact = opts.redact;
    this.now = opts.now ?? Date.now;
    this.mono = opts.mono ?? (() => performance.now());
  }

  /** A `keep` change re-bounds every ring at once; a `capture` change applies from now. */
  configure(opts: { capture: DevtoolsCapture; keep: DevtoolsKeep }): void {
    this.capture = opts.capture;
    this.keep = opts.keep;
    for (const ring of this.rings.values()) this.trim(ring);
  }

  /**
   * Remember that `session` is `bot`'s canonical conversation, so a record a
   * socket filed under its id lands in the `session: null` ring an inspector
   * opened for "this bot's chat".
   *
   * One id per bot, replaced rather than added to: a compaction or reset
   * moves the canonical conversation to a new id, and the old one is then an
   * ordinary session whose later records file under their own id. Records
   * already in the canonical ring stay there. Saying the same id again is a
   * no-op, which is what lets `chat.send` re-register at every frame.
   */
  canonical(instance: string, bot: string, session: string): void {
    if (this.alive) this.canonicals.set(`${instance}\0${bot}`, session);
  }

  /** The conversation a record belongs in, canonical ids folded to `null`. */
  resolve(conversation: DevtoolsConversation): DevtoolsConversation {
    const { instance, bot, session } = conversation;
    return session !== null && this.canonicals.get(`${instance}\0${bot}`) === session
      ? { instance, bot, session: null }
      : conversation;
  }

  /**
   * Whether every conversation is being captured. A socket that does not yet
   * know its conversation holds records only then: under `while_open` it
   * cannot tell whether anyone will be reading it.
   */
  capturesAll(): boolean {
    return this.alive && this.capture === "always";
  }

  /** Whether any inspector is open on any conversation. */
  reading(): boolean {
    if (!this.alive) return false;
    for (const ring of this.rings.values()) if (ring.subscribers.size > 0) return true;
    return false;
  }

  /** Whether a record for this conversation would be kept right now. */
  wants(conversation: DevtoolsConversation): boolean {
    if (!this.alive) return false;
    if (this.capture === "always") return true;
    return (this.rings.get(keyOf(this.resolve(conversation)))?.subscribers.size ?? 0) > 0;
  }

  /**
   * A record not yet placed in any ring: what a socket captures before it knows
   * which conversation it serves (`TapSlot`). Masked as it is made, so a held
   * pending record is no less safe than a placed one.
   */
  make(entry: TapEntry, conversation: DevtoolsConversation): TapMark | null {
    if (!this.alive) return null;
    const bytes = entry.raw !== undefined ? byteLength(entry.raw) : sizeOf(entry.payload);
    let payload = alwaysMask(entry);
    const masked = this.redact();
    if (masked) payload = redactDeep(payload);
    nextRecord += 1;
    const record: TapRecord = {
      id: `t${nextRecord}`,
      at: this.now(),
      mono: this.mono(),
      conversation,
      socket: entry.socket ?? null,
      layer: entry.layer,
      dir: entry.dir,
      type: entry.type,
      seq: entry.seq ?? null,
      parent: entry.parent ?? null,
      fate: entry.fate ?? null,
      bytes,
      ...(entry.synthetic === true ? { synthetic: true } : {}),
      payload,
    };
    return new TapMark(record, masked, this);
  }

  /** Put a made record into its conversation's ring, if that ring is capturing. */
  place(mark: TapMark, conversation: DevtoolsConversation): boolean {
    // A record made before the tools were last turned off belongs to a capture
    // that no longer exists, and must not survive into this one.
    if (mark.owner !== this) return false;
    const where = this.resolve(conversation);
    if (!this.wants(where)) return false;
    mark.record.conversation = where;
    const ring = this.ringFor(where);
    mark.ring = ring;
    ring.marks.push(mark);
    ring.bytes += mark.record.bytes;
    // Re-inserted, so the map's order is least recently written first.
    this.rings.delete(ring.key);
    this.rings.set(ring.key, ring);
    this.trim(ring);
    this.budget(ring);
    this.notify(ring, mark);
    return true;
  }

  /** Make and place in one step: a site that already knows its conversation. */
  add(conversation: DevtoolsConversation, entry: TapEntry): TapMark | null {
    if (!this.wants(conversation)) return null;
    const mark = this.make(entry, conversation);
    return mark !== null && this.place(mark, conversation) ? mark : null;
  }

  /** @internal Deliver a placed record (again) to every inspector open on its ring. */
  notify(ring: Ring, mark: TapMark): void {
    for (const sub of ring.subscribers) sub.push(mark);
  }

  /**
   * One conversation's backlog, then every record placed after it, until
   * `signal` aborts or the tools are turned off. Registered when iteration
   * starts, which is also when a `while_open` conversation starts capturing.
   */
  subscribe(conversation: DevtoolsConversation, signal?: AbortSignal): AsyncIterable<TapRecord> {
    const tap = this;
    return (async function* () {
      if (!tap.alive || signal?.aborted) return;
      const ring = tap.ringFor(tap.resolve(conversation));
      const queue: TapMark[] = [...ring.marks];
      let ended = false;
      let wake: (() => void) | null = null;
      const bump = (): void => {
        const resume = wake;
        wake = null;
        resume?.();
      };
      const sub: Subscriber = {
        push(mark) {
          queue.push(mark);
          // A reader that stopped reading must not grow without bound.
          if (queue.length > tap.keep) queue.splice(0, queue.length - tap.keep);
          bump();
        },
        end() {
          ended = true;
          bump();
        },
      };
      const onAbort = (): void => sub.end();
      ring.subscribers.add(sub);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          const mark = queue.shift();
          if (mark !== undefined) {
            yield tap.view(mark, tap.redact());
            continue;
          }
          if (ended || !tap.alive) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        ring.subscribers.delete(sub);
        signal?.removeEventListener("abort", onAbort);
        tap.prune(ring);
      }
    })();
  }

  /** Clear one conversation's ring, or every ring; returns how many records went. */
  clear(conversation?: DevtoolsConversation): number {
    if (conversation === undefined) {
      let cleared = 0;
      for (const ring of this.rings.values()) cleared += this.empty(ring);
      this.dropped = 0;
      return cleared;
    }
    const ring = this.rings.get(keyOf(this.resolve(conversation)));
    if (!ring) return 0;
    return this.empty(ring);
  }

  stats(): DevtoolsStats {
    let records = 0;
    let bytes = 0;
    let conversations = 0;
    for (const ring of this.rings.values()) {
      if (ring.marks.length === 0) continue;
      conversations += 1;
      records += ring.marks.length;
      bytes += ring.bytes;
    }
    return { conversations, records, bytes, dropped: this.dropped };
  }

  /** NDJSON of one ring, or of the named records in it — always masked. */
  exportRing(conversation: DevtoolsConversation, ids?: readonly string[]): DevtoolsExport {
    const ring = this.rings.get(keyOf(this.resolve(conversation)));
    const wanted = ids === undefined ? null : new Set(ids);
    const lines: string[] = [];
    for (const mark of ring?.marks ?? []) {
      if (wanted !== null && !wanted.has(mark.id)) continue;
      lines.push(JSON.stringify(this.view(mark, true)));
    }
    return { ndjson: lines.length === 0 ? "" : `${lines.join("\n")}\n`, count: lines.length };
  }

  /** Turn the tap off: every inspector ends and every ring is discarded. */
  close(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const ring of this.rings.values()) {
      for (const sub of ring.subscribers) sub.end();
      for (const mark of ring.marks) mark.ring = null;
      ring.marks = [];
    }
    this.rings.clear();
    this.canonicals.clear();
    this.dropped = 0;
  }

  get open(): boolean {
    return this.alive;
  }

  /** A record as a reader sees it: a copy, masked now if it was not when held. */
  private view(mark: TapMark, redact: boolean): TapRecord {
    const record = { ...mark.record };
    if (redact && !mark.masked) record.payload = redactDeep(record.payload);
    return record;
  }

  private ringFor(conversation: DevtoolsConversation): Ring {
    const key = keyOf(conversation);
    let ring = this.rings.get(key);
    if (!ring) {
      this.evictRings();
      ring = { key, conversation, marks: [], bytes: 0, subscribers: new Set() };
      this.rings.set(key, ring);
    }
    return ring;
  }

  /** Bound a ring by `keep` and by `maxBytes`, oldest first, keeping its newest. */
  private trim(ring: Ring, maxBytes = DEVTAP_RING_MAX_BYTES): void {
    let over = Math.max(0, ring.marks.length - this.keep);
    let bytes = ring.bytes;
    for (let i = 0; i < over; i += 1) bytes -= ring.marks[i]?.record.bytes ?? 0;
    while (bytes > maxBytes && over < ring.marks.length - 1) {
      bytes -= ring.marks[over]?.record.bytes ?? 0;
      over += 1;
    }
    if (over === 0) return;
    for (const gone of ring.marks.splice(0, over)) gone.ring = null;
    ring.bytes = bytes;
    this.dropped += over;
  }

  /** Make room for one more ring: discard the least recently written unread ones. */
  private evictRings(): void {
    for (const ring of this.rings.values()) {
      if (this.rings.size < DEVTAP_MAX_RINGS) return;
      if (ring.subscribers.size > 0) continue;
      this.discard(ring);
    }
  }

  /** Hold every ring together to `DEVTAP_TOTAL_MAX_BYTES` (see there for the order). */
  private budget(written: Ring): void {
    let total = 0;
    for (const ring of this.rings.values()) total += ring.bytes;
    if (total <= DEVTAP_TOTAL_MAX_BYTES) return;
    for (const ring of this.rings.values()) {
      if (total <= DEVTAP_TOTAL_MAX_BYTES) return;
      if (ring === written || ring.subscribers.size > 0) continue;
      total -= ring.bytes;
      this.discard(ring);
    }
    while (total > DEVTAP_TOTAL_MAX_BYTES) {
      let largest: Ring | null = null;
      for (const ring of this.rings.values())
        if (ring.marks.length > 1 && (largest === null || ring.bytes > largest.bytes)) largest = ring;
      if (largest === null) return;
      const before = largest.bytes;
      this.trim(largest, Math.max(0, largest.bytes - (total - DEVTAP_TOTAL_MAX_BYTES)));
      if (largest.bytes === before) return;
      total -= before - largest.bytes;
    }
  }

  /** Drop a ring whole; its records count as `dropped`. */
  private discard(ring: Ring): void {
    this.dropped += ring.marks.length;
    for (const mark of ring.marks) mark.ring = null;
    this.rings.delete(ring.key);
  }

  /** Empty one ring, detaching its records so a later fate is not re-delivered. */
  private empty(ring: Ring): number {
    const cleared = ring.marks.length;
    for (const mark of ring.marks) mark.ring = null;
    ring.marks = [];
    ring.bytes = 0;
    this.prune(ring);
    return cleared;
  }

  /** Forget a ring with nothing in it and nobody reading it. */
  private prune(ring: Ring): void {
    if (ring.marks.length === 0 && ring.subscribers.size === 0) this.rings.delete(ring.key);
  }
}

/**
 * One frame on its way to a head (T2), after the redaction door. `from` is the
 * frame the adapter yielded, whose wire record becomes `parent`.
 */
export function tapFrame(
  tap: DevTap | null,
  conversation: DevtoolsConversation,
  frame: ChatFrame,
  from?: unknown,
): void {
  if (tap === null) return;
  tap.add(conversation, {
    layer: "frame",
    dir: "out",
    type: frame.type === "block" ? `block.${frame.block.kind}` : frame.type,
    seq: "seq" in frame && typeof frame.seq === "number" ? frame.seq : null,
    parent: recordOf(from ?? frame)?.id ?? null,
    payload: frame,
  });
}

/** What the observation service saw or said (T2): a hint, a re-read, an event it emitted. */
export function tapObserve(
  tap: DevTap | null,
  conversation: DevtoolsConversation,
  type: string,
  payload: unknown,
  dir: "in" | "out" = "out",
): void {
  tap?.add(conversation, { layer: "observe", dir, type, payload });
}

function keyOf(conversation: DevtoolsConversation): string {
  return `${conversation.instance}\0${conversation.bot}\0${conversation.session ?? ""}`;
}

function sameFate(a: DevtoolsFate | null, b: DevtoolsFate): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sizeOf(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

/* ── the masks no preference turns off ────────────────────────────────────── */

/** `?token=…`/`&access_token=…` in a URL: the dashboard token rides in the socket's query. */
const URL_TOKEN = /([?&](?:token|access_token|session_token)=)[^&#\s"']+/gi;

/** Header names whose value is a credential by definition. */
const CREDENTIAL_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-hermes-session-token)$/i;

/** A failure's text, wherever it sits: `error`, `errors`, `error_message`. */
const ERROR_KEY = /^errors?(?:_message)?$/i;

/**
 * The masks that hold whatever Chat › Redact secrets says: a URL's token, a
 * credential header, and any error — an error quotes the request that failed,
 * headers included, and is never the transcript the operator chose to see.
 */
export function alwaysMask(entry: TapEntry): unknown {
  const credentials = maskCredentials(entry.payload, 0);
  return /error/i.test(entry.type) ? redactDeep(credentials) : credentials;
}

function maskCredentials(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    URL_TOKEN.lastIndex = 0;
    return URL_TOKEN.test(value) ? value.replace(URL_TOKEN, `$1${REDACTED}`) : value;
  }
  if (value === null || typeof value !== "object" || depth > 32) return value;
  if (Array.isArray(value)) return value.map((item) => maskCredentials(item, depth + 1));
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== null && proto !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      CREDENTIAL_HEADER.test(key) && typeof inner === "string" && inner !== ""
        ? REDACTED
        : ERROR_KEY.test(key)
          ? redactDeep(inner)
          : maskCredentials(inner, depth + 1);
  }
  return out;
}
