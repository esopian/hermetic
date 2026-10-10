/**
 * The session origins (§9.2), as plain values.
 *
 * Here rather than only in `schema/chat.ts` because the browser needs the list
 * too and may not import the schema door: `SessionOrigin` there is
 * `z.enum(SESSION_ORIGIN_NAMES)`, and the UI's `ORIGIN_NAMES` is this array, so
 * the two cannot drift.
 */
export const SESSION_ORIGIN_NAMES = [
  "portal",
  /**
   * A session some hermetic created (upstream lists back the `source` hermetic
   * stamps on `session.create`) that this laptop has no record of sending
   * into — another operator's, or this one's before its first turn or after the
   * local record was pruned. Foreign, like every value but `portal`: only the
   * local record (§9.2) may grant that.
   */
  "hermetic",
  "desktop",
  "cli",
  "routine",
  "peer",
  "room",
  "channel",
] as const;

export type SessionOriginName = (typeof SESSION_ORIGIN_NAMES)[number];
