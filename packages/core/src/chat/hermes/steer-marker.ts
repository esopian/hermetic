/**
 * A mid-turn steer as the transcript stores it.
 *
 * Hermes delivers a `/steer` sent while a turn is running as its own `role:
 * "user"` row, placed after the newest tool result and typed `display_kind:
 * "steer"` (upstream `agent/prompt_builder.py` `steer_user_row`). The row's
 * content is the operator's text wrapped in a self-describing marker the model
 * is told to trust (`format_steer_marker`): `STEER_MARKER_OPEN`, a newline, the
 * text as typed (neither trimmed nor escaped), a newline, `STEER_MARKER_CLOSE`.
 *
 * The operator typed only the text, so history shows the text and flags the
 * row `steered` instead of rendering the marker. The match is exact: the
 * marker is the one trusted shape upstream, and a lookalike stays the
 * operator's literal text.
 */

/** Upstream `STEER_MARKER_OPEN`, one line, with a U+2014 em dash. */
export const STEER_MARKER_OPEN =
  "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]";

/** Upstream `STEER_MARKER_CLOSE`. */
export const STEER_MARKER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]";

/** Upstream `STEER_DISPLAY_KIND`: the `display_kind` a steer's user row carries. */
export const STEER_DISPLAY_KIND = "steer";

const PREFIX = `${STEER_MARKER_OPEN}\n`;
const SUFFIX = `\n${STEER_MARKER_CLOSE}`;

/**
 * The operator's text inside a steer marker, or null when `text` does not open
 * with the exact open marker and close with the exact close marker, each on its
 * own line. Whitespace around the wrapper is tolerated (upstream left-strips the
 * leading blank lines `format_steer_marker` adds); the text between the markers
 * is returned as stored, since upstream neither trims nor escapes it.
 */
export function unwrapSteer(text: string): string | null {
  const whole = text.trim();
  if (whole.length < PREFIX.length + SUFFIX.length) return null;
  if (!whole.startsWith(PREFIX) || !whole.endsWith(SUFFIX)) return null;
  return whole.slice(PREFIX.length, whole.length - SUFFIX.length);
}
