/**
 * Hermes' intentional-silence markers (§9.2), ported from upstream
 * `gateway/response_filters.py` at v2026.9.24.
 *
 * A bot that decides a message needs no answer replies with a bare control
 * token — `NO_REPLY`, `[SILENT]`, or one of their translations. Upstream keeps
 * that row in the transcript and suppresses only its *delivery*: a messaging
 * gateway sends nothing, and a Bot Chat session completes with empty text. So
 * the token reaches this laptop on every path that reads the transcript, and
 * without a matcher it would be drawn as a reply reading "NO_REPLY".
 *
 * The rule is upstream's, verbatim, and it is deliberately narrow: the whole
 * response must be a marker, give or take whitespace, case and stray edge
 * punctuation. Prose that merely mentions a marker is a real answer, and an
 * empty response is not silence (upstream treats that as a failure). Square
 * brackets are structural, so `[SILENT` is not `SILENT`.
 *
 * Python's string semantics are reproduced rather than approximated: length is
 * counted in code points, `str.strip()`/`str.split()` use Python's whitespace
 * set (which is not JavaScript's `\s` — it adds U+001C–U+001F and U+0085 and
 * drops U+FEFF), and "punctuation" is Unicode general category P*.
 *
 * Shared because two packages decide on it: core, so a silent reply raises no
 * inbox row, and the UI, so it renders as a marker and never streams a prefix
 * of one. Neither restates the token list.
 */

/** Upstream's `LIVE_GATEWAY_SILENT_MARKERS`, in canonical (upper-cased) form. */
export const SILENCE_TOKENS: readonly string[] = Object.freeze([
  "[SILENT]",
  "SILENT",
  "NO_REPLY",
  "NO REPLY",
  "[静默]",
  "静默",
  "[沉默]",
  "沉默",
]);

const TOKENS = new Set(SILENCE_TOKENS);

/** Longer than any marker could plausibly be, even with stray punctuation (`_MARKER_LENGTH_CAP`). */
const MARKER_LENGTH_CAP = 64;

/** Python's `str.isspace()` set, as a character-class body. */
const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_SPACE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`);
const PUNCTUATION = /^\p{P}$/u;

/** Python's `str.strip()` with no argument. */
function pyStrip(text: string): string {
  return text.replace(EDGE_SPACE, "");
}

/** `" ".join(text.strip().upper().split())`. */
function canonicalCandidate(text: string): string {
  const upper = pyStrip(text).toUpperCase();
  return upper === "" ? "" : upper.split(SPACE_RUN).join(" ");
}

/** Square brackets stay structural so malformed `[SILENT` cannot become `SILENT`. */
function isEdgePunctuation(ch: string): boolean {
  return ch !== "[" && ch !== "]" && PUNCTUATION.test(ch);
}

/** Strip stray edge punctuation (`.NO_REPLY`, `*NO_REPLY*`) without erasing marker structure. */
function stripEdgePunctuation(chars: readonly string[]): string {
  let start = 0;
  let end = chars.length;
  while (start < end && isEdgePunctuation(chars[start]!)) start += 1;
  while (end > start && isEdgePunctuation(chars[end - 1]!)) end -= 1;
  return pyStrip(chars.slice(start, end).join(""));
}

/** Canonical forms of a short, marker-sized response; empty when it is not a candidate at all. */
function canonicalCandidates(text: unknown): string[] {
  const stripped = typeof text === "string" ? pyStrip(text) : "";
  const chars = Array.from(stripped);
  if (chars.length === 0 || chars.length > MARKER_LENGTH_CAP) return [];
  const depunctuated = stripEdgePunctuation(chars);
  const forms = depunctuated === stripped ? [stripped] : [stripped, depunctuated];
  return forms.map(canonicalCandidate);
}

/**
 * True only when `text` is exactly a silence marker (`is_intentional_silence_response`).
 *
 * Upstream applies it to successful turns only: a failed turn that happens to
 * end on a marker is a failure, and its text is shown. That half is the
 * caller's, because only the caller knows whether the turn failed.
 */
export function isIntentionalSilence(text: unknown): boolean {
  return canonicalCandidates(text).some((candidate) => TOKENS.has(candidate));
}

/**
 * True while streamed `text` could still resolve to a silence marker
 * (`is_partial_silence_marker`).
 *
 * A buffer whose canonical form is a non-empty prefix of a marker — `NO` on
 * the way to `NO_REPLY`, or a whole marker the stream has not finished — is
 * held back, so a raw marker is never shown and then retracted. Diverging from
 * every marker, or outgrowing the length cap, resumes normal streaming.
 */
export function isPartialSilenceMarker(text: unknown): boolean {
  return canonicalCandidates(text).some(
    (candidate) => candidate !== "" && SILENCE_TOKENS.some((token) => token.startsWith(candidate)),
  );
}
