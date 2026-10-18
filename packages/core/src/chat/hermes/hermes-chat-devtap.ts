/**
 * The adapter's half of the developer tools' capture (`../devtap.ts`): which
 * conversation a socket serves, and what became of each event a turn read.
 *
 * Kept out of the transport and the turn loop so each of them grows by a few
 * optional chains and nothing else. With the tools off every one of those
 * chains ends on `null` — `TapSlot` asks its source for the tap before it does
 * anything, and `turnTrace` returns `null` for a socket that has no slot.
 */
import type { DevtoolsConversation, DevtoolsDropReason, DevtoolsFate } from "../../schema/index.ts";
import { recordOf, tagRecord, type TapEntry, type TapMark, type TapSource } from "../devtap.ts";
import type { ChatFrame } from "../../schema/index.ts";
import { num, rec, str } from "./hermes-chat-wire.ts";

export type { TapSource } from "../devtap.ts";

/** How many records a socket holds before it knows its conversation. */
/**
 * How many records a socket holds before it knows its conversation. A turn or
 * a watch names its conversation within its first handful of records (dial,
 * scrape, open, capabilities, create); a socket that has said this much
 * without being bound is a roster read or a pooled Bot Mode socket that never
 * will be, so it drops what it held and stops holding (`abandoned`).
 */
const PENDING_MAX = 64;

let nextSocket = 0;

/**
 * One socket's capture. Every socket a connection dials gets one, before it
 * knows what it is for: the dial and the token scrape happen first, and the
 * turn or watch that leased the socket names its conversation afterwards
 * (`bind`). Records made in between wait here — bounded — and land in the ring
 * once the socket is bound; a socket that is never bound (a roster read, a
 * pooled Bot Mode request) is never captured.
 */
export class TapSlot {
  private readonly n: number;
  private kind = "sock";
  private where: { bot: string; session: string | null } | null = null;
  private pending: TapMark[] = [];
  private abandoned = false;

  constructor(
    private readonly source: TapSource,
    readonly instance: string,
  ) {
    nextSocket += 1;
    this.n = nextSocket;
  }

  get label(): string {
    return `${this.kind}#${this.n}`;
  }

  /** Name the conversation this socket serves, and place what it held until now. */
  bind(bot: string, session: string | null, kind?: string): void {
    this.where = { bot, session };
    if (kind !== undefined) this.kind = kind;
    const tap = this.source();
    const held = this.pending;
    this.pending = [];
    if (!tap) return;
    const conversation = this.conversation();
    for (const mark of held) {
      mark.record.socket = this.label;
      tap.place(mark, conversation);
    }
  }

  /** A reconnect's socket serves whatever the socket it replaces did. */
  follow(other: TapSlot | undefined): void {
    if (other?.where) this.bind(other.where.bot, other.where.session, other.kind);
  }

  /** A JSON-RPC document read or written on this socket. */
  wire(
    dir: "in" | "out",
    doc: Record<string, unknown>,
    raw: string | undefined,
    type: string,
    fate: DevtoolsFate | null = null,
  ): TapMark | null {
    const params = rec(doc.params);
    return this.record({
      layer: "wire",
      dir,
      type,
      seq: num(params?.seq),
      fate,
      payload: doc,
      raw,
    });
  }

  /** A connection fact: a dial, a scrape, a close, a reconnect. */
  conn(type: string, payload: unknown, dir: "in" | "out" = "out"): TapMark | null {
    return this.record({ layer: "conn", dir, type, payload });
  }

  /**
   * A turn event that reached the loop without a record of its own — one
   * replayed inside an `events.since` reply, or the resume snapshot turned
   * back into an event — recorded as the wire event it stands for.
   */
  derived(event: Record<string, unknown>): TapMark | null {
    return this.record({
      layer: "wire",
      dir: "in",
      type: str(event.type) ?? "event",
      seq: num(event.seq),
      payload: event,
    });
  }

  private conversation(): DevtoolsConversation {
    return {
      instance: this.instance,
      bot: this.where?.bot ?? "",
      session: this.where?.session ?? null,
    };
  }

  private record(entry: TapEntry): TapMark | null {
    const tap = this.source();
    if (!tap) return null;
    entry.socket = this.label;
    if (this.where === null) {
      // Held only while it could be kept: everything is captured, or some
      // inspector is open (`while_open` cannot know yet whether it is this one's).
      if (this.abandoned || !(tap.capturesAll() || tap.reading())) return null;
      const mark = tap.make(entry, { instance: this.instance, bot: "", session: null });
      if (mark === null) return null;
      this.pending.push(mark);
      if (this.pending.length >= PENDING_MAX) {
        this.pending = [];
        this.abandoned = true;
      }
      return mark;
    }
    const conversation = this.conversation();
    if (!tap.wants(conversation)) return null;
    const mark = tap.make(entry, conversation);
    return mark !== null && tap.place(mark, conversation) ? mark : null;
  }
}

/** The record type of an inbound document: its event, its method, or the request it answers. */
export function inboundType(
  doc: Record<string, unknown>,
  answering: (id: number) => string | undefined,
): string {
  if (doc.method === "event") return str(rec(doc.params)?.type) ?? "event";
  if (typeof doc.method === "string") return doc.method;
  const id = num(doc.id);
  return (id !== null ? answering(id) : undefined) ?? "response";
}

/** A fate that needs no frame count: read and acted on, nothing drawn. */
export const FATE_NONE: DevtoolsFate = { kind: "none" };

/**
 * One turn's lineage: which wire record the loop is working on, how many
 * frames it has produced, and what became of it.
 *
 * The loop calls `event` as it takes each event, says `drop`/`buffer` where it
 * discards or holds one, and the turn's `for await` calls `frame` on every
 * frame the loop yields. A record nobody stated a fate for is settled when the
 * next event arrives (or the turn ends): `frames` with the count when it
 * produced any, `none` when it did not.
 */
export interface TurnTrace {
  event(event: Record<string, unknown>): void;
  drop(reason: DevtoolsDropReason): void;
  buffer(into: "reasoning" | "media"): void;
  frame(frame: ChatFrame): void;
  end(): void;
}

export function turnTrace(slot: TapSlot | undefined): TurnTrace | null {
  if (slot === undefined) return null;
  let current: TapMark | null = null;
  let stated: DevtoolsFate | null = null;
  let count = 0;
  const settle = (): void => {
    current?.settle(stated ?? (count > 0 ? { kind: "frames", count } : FATE_NONE));
    current = null;
    stated = null;
    count = 0;
  };
  return {
    event(event) {
      settle();
      current = recordOf(event) ?? slot.derived(event);
    },
    drop(reason) {
      stated = { kind: "drop", reason };
    },
    buffer(into) {
      stated = { kind: "buffer", into };
    },
    frame(frame) {
      if (current === null) return;
      count += 1;
      tagRecord(frame, current);
    },
    end: settle,
  };
}
