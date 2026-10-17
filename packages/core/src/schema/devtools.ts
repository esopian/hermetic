/**
 * Developer tools (§9.2 "Developer tools"): the laptop-only stream inspector.
 *
 * Nothing here is a §9 command. The surface these shapes describe lives on the
 * `Hermetic` object as `hermetic.devtools`, outside `PUBLIC_METHODS`, with no
 * CLI verb; the desktop head reaches it through machinery requests
 * (`packages/app/src/handlers/devtools.ts`).
 *
 * The capture itself is a per-conversation ring buffer in core's memory
 * (`packages/core/src/chat/devtap.ts`). It is never written to disk and is gone
 * when the process quits.
 */
import { z } from "zod";

// The Diff view's field map is a plain value the UI reads through `shared`; the
// schema door re-exports it like every other shared module.
export { DEVTOOLS_FIELD_MAP, devtoolsFieldMap } from "../shared/devtools-field-map.ts";
export type {
  DevtoolsEventMap,
  DevtoolsFieldFate,
  DevtoolsFieldRule,
} from "../shared/devtools-field-map.ts";

/** How many records each conversation's ring keeps before the oldest is evicted. */
export const DevtoolsKeep = z.union([z.literal(1000), z.literal(5000), z.literal(20000)]);
export type DevtoolsKeep = z.infer<typeof DevtoolsKeep>;

/**
 * `always`: every conversation is captured while the tools are on.
 * `while_open`: only while an inspector is subscribed to that conversation.
 */
export const DevtoolsCapture = z.enum(["always", "while_open"]);
export type DevtoolsCapture = z.infer<typeof DevtoolsCapture>;

/** This laptop's developer-tools preferences, one `prefs` row each. */
export const DevtoolsSettings = z.object({
  enabled: z.boolean(),
  capture: DevtoolsCapture,
  keep: DevtoolsKeep,
});
export type DevtoolsSettings = z.infer<typeof DevtoolsSettings>;

export const DEFAULT_DEVTOOLS_SETTINGS: DevtoolsSettings = {
  enabled: false,
  capture: "always",
  keep: 5000,
};

/** An empty request reads; a stated field writes it (the `chat.settings` shape). */
export const DevtoolsSettingsInput = DevtoolsSettings.partial().strict();
export type DevtoolsSettingsInput = z.infer<typeof DevtoolsSettingsInput>;

/**
 * Which conversation a record belongs to. `session: null` is the bot's
 * canonical conversation, the same convention chat observation uses.
 */
export const DevtoolsConversation = z.object({
  instance: z.string().min(1),
  bot: z.string().min(1),
  session: z.string().min(1).nullable(),
});
export type DevtoolsConversation = z.infer<typeof DevtoolsConversation>;

/**
 * What became of a raw wire message, or of a frame on its way to the page.
 *
 * - `frames`: it produced `count` ChatFrames (the frames carry it as `parent`).
 * - `drop`: it was discarded, and why.
 * - `buffer`: it was held and folded into a later frame.
 * - `none`: it was read and acted on without producing a frame (a status, an ack).
 */
export const DevtoolsDropReason = z.enum([
  "internal",
  "replay",
  "child_session",
  "hidden_row",
  "queue_overflow",
]);
export type DevtoolsDropReason = z.infer<typeof DevtoolsDropReason>;

export const DevtoolsFate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frames"), count: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("drop"), reason: DevtoolsDropReason }),
  z.object({ kind: z.literal("buffer"), into: z.enum(["reasoning", "media"]) }),
  z.object({ kind: z.literal("none") }),
]);
export type DevtoolsFate = z.infer<typeof DevtoolsFate>;

/**
 * - `wire`: a raw JSON-RPC message on a Hermes dashboard socket (T1).
 * - `frame`: a ChatFrame core handed to the head, after redaction (T2).
 * - `observe`: an observation event — a hint, a history re-read (T2).
 * - `conn`: a connection fact — dial, token scrape, capabilities, session
 *   create/resume, close, reconnect, replay.
 */
export const DevtoolsLayer = z.enum(["wire", "frame", "observe", "conn"]);
export type DevtoolsLayer = z.infer<typeof DevtoolsLayer>;

export const TapRecord = z.object({
  /** Unique within this process, monotonically increasing: `t<n>`. */
  id: z.string().min(1),
  /** Wall clock, epoch milliseconds. */
  at: z.number(),
  /** `performance.now()` at capture, for intervals. */
  mono: z.number(),
  conversation: DevtoolsConversation,
  /** Which socket carried it, e.g. `held#3`, `hint#1`. Null for records with no socket. */
  socket: z.string().nullable(),
  layer: DevtoolsLayer,
  dir: z.enum(["in", "out"]),
  /** The JSON-RPC method or event name, the frame type, or the conn fact's name. */
  type: z.string(),
  seq: z.number().nullable(),
  /** The record this one came from: a frame's wire message. */
  parent: z.string().nullable(),
  fate: DevtoolsFate.nullable(),
  /** Size of the payload as received, before any masking. */
  bytes: z.number().int().nonnegative(),
  /** Made up by the fixture backend rather than read off a socket. */
  synthetic: z.boolean().optional(),
  /** The parsed payload; masked when Chat › Redact secrets is on. */
  payload: z.unknown(),
});
export type TapRecord = z.infer<typeof TapRecord>;

/** Open a tap on one conversation: its backlog, then everything after. */
export const DevtoolsTapInput = z.object({ conversation: DevtoolsConversation });
export type DevtoolsTapInput = z.infer<typeof DevtoolsTapInput>;

/** Clear one conversation's capture, or every conversation's when omitted. */
export const DevtoolsClearInput = z.object({ conversation: DevtoolsConversation.optional() }).strict();
export type DevtoolsClearInput = z.infer<typeof DevtoolsClearInput>;

/** An export is always masked, whatever the redaction preference says. */
export const DevtoolsExportInput = z.object({
  conversation: DevtoolsConversation,
  /** Only these record ids; omitted means the whole ring. */
  ids: z.array(z.string().min(1)).optional(),
});
export type DevtoolsExportInput = z.infer<typeof DevtoolsExportInput>;

export const DevtoolsExport = z.object({
  /** Newline-delimited JSON, one masked `TapRecord` per line. */
  ndjson: z.string(),
  count: z.number().int().nonnegative(),
});
export type DevtoolsExport = z.infer<typeof DevtoolsExport>;

/** The Settings › Developer facts. */
export const DevtoolsStats = z.object({
  conversations: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  /** Approximate bytes held across every ring. */
  bytes: z.number().int().nonnegative(),
  /** Records evicted from a full ring since the last clear. */
  dropped: z.number().int().nonnegative(),
});
export type DevtoolsStats = z.infer<typeof DevtoolsStats>;
