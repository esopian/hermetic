/**
 * The `MEDIA:` tag parser, ported from the Hermes desktop app
 * (`apps/desktop/src/lib/chat-messages/parts.ts`) so that hermetic reads a
 * reply's `MEDIA:` values the way the desktop renderer does: a quoted or
 * backticked path is unquoted, and an unquoted path may hold interior spaces
 * when it starts at a path anchor (`~/`, `/`, `X:\`, `X:/`) and ends on a known
 * deliverable extension.
 *
 * Reading a value is all this does. Whether a value becomes a file on the
 * page is decided elsewhere (`parseOutboxMediaLine`): only a path in the box's
 * outbox is ever fetched, and it is fetched by share id, never by path. A
 * `MEDIA:` value naming any other path — another machine's, or a box file the
 * plugin never shared — stays prose, which is the desktop's `media={false}`
 * rule applied to every path the page cannot vouch for.
 *
 * Pure: no imports, so both `files.ts` and the browser can use it.
 */

/** The desktop's `MEDIA_DELIVERY_EXTS` (the gateway's own list), verbatim. */
export const MEDIA_DELIVERY_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "svg",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "3gp",
  "mp3",
  "m2a",
  "wav",
  "ogg",
  "opus",
  "m4a",
  "flac",
  "pdf",
  "docx",
  "doc",
  "odt",
  "rtf",
  "txt",
  "md",
  "epub",
  "xlsx",
  "xls",
  "ods",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "kmz",
  "kml",
  "geojson",
  "gpx",
  "pptx",
  "ppt",
  "odp",
  "key",
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "apk",
  "ipa",
  "html",
  "htm",
] as const;

// Longest first, so the alternation never settles on a shorter extension that
// is a prefix of a longer one.
const EXT_ALTERNATION = [...MEDIA_DELIVERY_EXTS].sort((a, b) => b.length - a.length).join("|");

/**
 * The unquoted path branch: a path anchor, interior blanks allowed, ending on
 * a known extension followed by a delimiter, another tag or the end.
 */
const PATH_ANCHORED = `(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${EXT_ALTERNATION})(?=[\\s\`"'*_,;:)\\]}]|MEDIA:|$)`;

/** One value: backticked, double- or single-quoted, an anchored path, or a bare token. */
const VALUE = `\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${PATH_ANCHORED}|\\S+`;

/** Every `MEDIA:` tag in a text, inline or on its own line (the desktop's `MEDIA_TAG_RE`). */
const MEDIA_TAG_RE = new RegExp(`[\`"']?MEDIA:\\s*(${VALUE})[\`"']?`, "g");

/**
 * A line that is one `MEDIA:` tag and nothing else: blanks, up to three `*`/`_`
 * of emphasis (the same on both sides), the tag, blanks, then one value
 * (quoted, backticked, or the rest of the line), then the emphasis again. The
 * files plugin's `_MEDIA_LINE_RE` shape, with the tag in capitals as the
 * desktop writes it. The unquoted value runs to the end of the line, so a
 * spaced name with no known extension still reads whole.
 */
const MEDIA_LINE_RE =
  /^[ \t]*([*_]{0,3})MEDIA:[ \t]*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"'][^\n]*?)\1$/;

/** A longer line is never a `MEDIA:` line (the plugin's `MEDIA_LINE_MAX`). */
const MEDIA_LINE_MAX = 4096;

/** A value with one matching pair of `"`, `'` or `` ` `` around it, without them. */
export function unquoteMediaPath(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return quote && quote === trimmed.at(-1) && trimmed.length > 1 && ['"', "'", "`"].includes(quote)
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Every `MEDIA:` value in `text`, inline or alone on a line, in order, quotes
 * intact: the desktop's `mediaTagValues`, kept verbatim as the reference
 * reading `mediaLinePath` is held to (`media-tags.test.ts`).
 */
export function mediaTagValues(text: string): string[] {
  return [...text.matchAll(MEDIA_TAG_RE)].map((match) => match[1] ?? "");
}

/**
 * The path a whole line names when the line is a single `MEDIA:` tag, unquoted;
 * `null` for any other line. A trailing `\r` is ignored. This, not
 * `mediaTagValues`, is what draws a chip: the box shares only a tag alone on
 * its line, so an inline tag never names a share.
 */
export function mediaLinePath(line: string): string | null {
  if (line.length > MEDIA_LINE_MAX) return null;
  // Trailing blanks (and the `\r`) go first, as the plugin strips them: a lazy
  // value followed by a blank run in the pattern would rescan the run.
  const match = MEDIA_LINE_RE.exec(line.trimEnd());
  if (!match) return null;
  const path = unquoteMediaPath(match[2] ?? "");
  return path === "" ? null : path;
}
