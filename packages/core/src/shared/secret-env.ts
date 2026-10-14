/**
 * Text secrets (plan §06b): what an operator pastes or drops into a secret
 * request card, read the way the card previews it and the way the box stores
 * it. One parser, here, so the laptop's preview and the box's authoritative
 * re-parse of the canonical form cannot disagree.
 *
 * Two shapes are accepted. **raw**: the whole text is the value of the one key
 * the request names (a PEM block, a bare token). **dotenv**: `KEY=value` lines
 * with comments, `export`, single and double quotes. `auto` picks between them
 * (`detectSecretFormat`); the operator's "Treat as" overrides.
 *
 * The parser never throws on bad input — it returns `errors` (refuse) and
 * `warnings` (advise, `ok` may still be true). Only a malformed *spec* — a
 * programmer error — throws `HermeticError("VALIDATION")`. Issue messages name
 * line numbers and only the keys the request named (or their lower-case
 * spelling), never a value or a fragment of one. A key name read from the
 * paste that the request did not name is never echoed — in a message, an
 * issue's `key` or a chip — because a padded base64 secret (`Q2xh…YWJj=`)
 * parses as `KEY=` and its body would become the "name" (D10: such a key is
 * still refused, not silently dropped; it is referred to by its line).
 *
 * Judgement calls, all pinned by `packages/core/test/secret-env.test.ts`:
 * - Tab is allowed in a value (JSON blobs, TSV); every other C0 control, DEL
 *   and C1 control is refused anywhere in the text. `\n` survives only inside
 *   a double-quoted or raw value, since every other form ends at the line.
 * - `auto` reads a single-line paste as raw when it is base64-padding shaped
 *   (`abc=`, `ABC==`) or its "key" is not an upper-case env name: a lone
 *   `dGVzdA==` is a secret, not an assignment of `=` to `dGVzdA`.
 * - `auto` with a spec that needs two or more keys parses as dotenv even when
 *   the text is mixed, so the operator sees the offending line rather than
 *   "paste as KEY=value lines".
 * - Double quotes take `\n`, `\"`, `\\`, and sh's `\$` and `` \` ``; any
 *   other backslash is kept literally. `$` is never expanded.
 * - A chip's `length` counts Unicode code points.
 * - Entries (and so the canonical form) follow the spec's key order, not the
 *   paste's, so the same secret always canonicalises to the same text.
 *
 * Pure: no Zod, no `node:*`; UTF-8 via the `TextEncoder`/`TextDecoder` globals.
 */
import { HermeticError } from "../errors.ts";

// --- Contract -----------------------------------------------------------------

/** What a request may name as a secret env key. */
export const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Largest paste or dropped text file, in UTF-8 bytes. */
export const SECRET_TEXT_MAX_BYTES = 64 * 1024;

/** The operator's "Treat as". */
export type SecretInputMode = "auto" | "raw" | "dotenv";
/** What was detected, or forced by the mode, and used. */
export type SecretFormat = "raw" | "dotenv";

export const SECRET_ENV_ERROR_CODES = [
  "INVALID_UTF8",
  "TOO_LARGE",
  "EMPTY_INPUT",
  "NOT_DOTENV_LINE",
  "BAD_KEY_NAME",
  "UNTERMINATED_QUOTE",
  "UNEXPECTED_TEXT",
  "RAW_NEEDS_ONE_KEY",
  "UNREQUESTED_KEY",
  "MISSING_KEY",
  "DUPLICATE_KEY",
  "EMPTY_VALUE",
  "CONTROL_CHARACTER",
] as const;
export type SecretEnvErrorCode = (typeof SECRET_ENV_ERROR_CODES)[number];

export const SECRET_ENV_WARNING_CODES = [
  "PLACEHOLDER_VALUE",
  "VALUE_WHITESPACE",
  "LOWERCASE_KEY",
  "RAW_LOOKS_LIKE_OTHER_KEY",
  "RAW_LOOKS_LIKE_ASSIGNMENT",
  "TOKEN_SHAPE_MISMATCH",
] as const;
export type SecretEnvWarningCode = (typeof SECRET_ENV_WARNING_CODES)[number];

export interface SecretEnvSpec {
  keys: readonly string[];
  optional_keys?: readonly string[];
  maxBytes?: number;
}
export interface SecretEnvIssue {
  code: SecretEnvErrorCode | SecretEnvWarningCode;
  message: string;
  key?: string;
  line?: number;
}
export interface SecretEnvChip {
  /**
   * The key, for a requested one. For `unrequested`, the pasted name only when
   * its upper-case form was requested; otherwise a neutral label (`key on
   * line 3`), never text taken from the paste.
   */
  key: string;
  state: "ok" | "unrequested" | "missing";
  /** `unrequested` only: the line that set it. */
  line?: number;
  optional?: boolean;
  /** Code points in the value, for `ok` chips. Never the value. */
  length?: number;
}
export interface SecretEnvEntry {
  key: string;
  value: string;
}
export type SecretEnvResult =
  | {
      ok: true;
      format: SecretFormat;
      entries: SecretEnvEntry[];
      canonical: string;
      chips: SecretEnvChip[];
      warnings: SecretEnvIssue[];
      lines: number;
      bytes: number;
    }
  | {
      ok: false;
      format: SecretFormat | null;
      chips: SecretEnvChip[];
      errors: SecretEnvIssue[];
      warnings: SecretEnvIssue[];
      lines: number;
      bytes: number;
    };

// --- Text normalisation ---------------------------------------------------------

const BOM = "\uFEFF";

/** Strip one leading BOM, fold CRLF and lone CR to LF. */
function normalise(text: string): string {
  const t = text.startsWith(BOM) ? text.slice(1) : text;
  return t.replace(/\r\n?/g, "\n");
}

function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** A JS string with an unpaired surrogate cannot be UTF-8. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Every control character but tab and LF: C0, DEL, C1. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function codePoints(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

// --- Tokenising ------------------------------------------------------------------

/** A dotenv assignment's head: what detection counts as a `KEY=` line. */
const ASSIGN_RE = /^[ \t]*(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
/** Something shaped like an assignment whose key is not a valid name. */
const BAD_KEY_RE = /^[ \t]*(export[ \t]+)?[^\s=#'"]+[ \t]*=/;
const DOTENV_KEY_MAX = 64;
/** What may follow a closing quote on its line. */
const QUOTE_TAIL_RE = /^[ \t]*(#.*)?$/;

interface AssignToken {
  kind: "assign";
  line: number;
  endLine: number;
  key: string;
  value: string;
  quoted: boolean;
  /** Unquoted only: whitespace trimmed off either end. */
  padded: boolean;
  error?: "UNTERMINATED_QUOTE" | "UNEXPECTED_TEXT";
}
interface LineToken {
  kind: "blank" | "comment" | "other" | "badkey";
  line: number;
}
type Token = LineToken | AssignToken;

/**
 * One pass over normalised text. Each token is a logical line; a
 * double-quoted value consumes its continuation lines, so a multi-line PEM in
 * `KEY="…"` is one assignment, not a run of stray lines.
 */
function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let pos = 0;
  let line = 1;
  while (pos < n) {
    const eol = text.indexOf("\n", pos);
    const end = eol === -1 ? n : eol;
    const lineText = text.slice(pos, end);
    if (/^[ \t]*$/.test(lineText)) {
      tokens.push({ kind: "blank", line });
    } else if (/^[ \t]*#/.test(lineText)) {
      tokens.push({ kind: "comment", line });
    } else {
      const m = ASSIGN_RE.exec(lineText);
      if (!m) {
        tokens.push({ kind: BAD_KEY_RE.test(lineText) ? "badkey" : "other", line });
      } else {
        const key = m[2] ?? "";
        const rest = lineText.slice(m[0].length);
        const after = rest.replace(/^[ \t]+/, "");
        if (after.startsWith('"')) {
          // Double quotes: escapes, and the value may run over lines.
          let i = pos + m[0].length + (rest.length - after.length) + 1;
          let value = "";
          let closed = false;
          let cur = line;
          while (i < n) {
            const c = text[i];
            if (c === "\\" && i + 1 < n) {
              const d = text[i + 1];
              if (d === "n" || d === '"' || d === "\\" || d === "$" || d === "`") {
                value += d === "n" ? "\n" : d;
                i += 2;
                continue;
              }
              value += c;
              i++;
              continue;
            }
            if (c === '"') {
              closed = true;
              i++;
              break;
            }
            if (c === "\n") cur++;
            value += c;
            i++;
          }
          if (!closed) {
            tokens.push({
              kind: "assign",
              line,
              endLine: cur,
              key,
              value,
              quoted: true,
              padded: false,
              error: "UNTERMINATED_QUOTE",
            });
            return tokens;
          }
          const eol2 = text.indexOf("\n", i);
          const end2 = eol2 === -1 ? n : eol2;
          const tok: AssignToken = {
            kind: "assign",
            line,
            endLine: cur,
            key,
            value,
            quoted: true,
            padded: false,
          };
          if (!QUOTE_TAIL_RE.test(text.slice(i, end2))) tok.error = "UNEXPECTED_TEXT";
          tokens.push(tok);
          pos = end2 + 1;
          line = cur + 1;
          continue;
        }
        if (after.startsWith("'")) {
          // Single quotes: literal, one line.
          const close = after.indexOf("'", 1);
          if (close === -1) {
            tokens.push({
              kind: "assign",
              line,
              endLine: line,
              key,
              value: after.slice(1),
              quoted: true,
              padded: false,
              error: "UNTERMINATED_QUOTE",
            });
          } else {
            const tok: AssignToken = {
              kind: "assign",
              line,
              endLine: line,
              key,
              value: after.slice(1, close),
              quoted: true,
              padded: false,
            };
            if (!QUOTE_TAIL_RE.test(after.slice(close + 1))) tok.error = "UNEXPECTED_TEXT";
            tokens.push(tok);
          }
        } else {
          // Unquoted: up to whitespace-then-`#`, trimmed. The run of blanks
          // before a comment is its delimiter, not padding, so it never warns.
          const hash = rest.search(/[ \t]#/);
          const body = hash === -1 ? rest : rest.slice(0, hash).replace(/[ \t]+$/, "");
          const value = body.replace(/^[ \t]+|[ \t]+$/g, "");
          tokens.push({
            kind: "assign",
            line,
            endLine: line,
            key,
            value,
            quoted: false,
            padded: value !== body,
          });
        }
      }
    }
    pos = end + 1;
    line++;
  }
  return tokens;
}

/** A single line that is base64 with padding, or whose "key" is no env name. */
function singleLineLooksRaw(text: string, tokens: readonly Token[]): boolean {
  const content = tokens.filter((t) => t.kind !== "blank");
  const only = content[0];
  if (content.length !== 1 || only === undefined || only.kind !== "assign") return false;
  if (only.endLine !== only.line) return false;
  if (!SECRET_KEY_RE.test(only.key)) return true;
  const lineText = text.split("\n")[only.line - 1] ?? "";
  return /^[ \t]*[^=\s]+==+[ \t]*$/.test(lineText);
}

function detectNormalised(text: string, tokens: readonly Token[]): SecretFormat {
  let assigns = 0;
  for (const t of tokens) {
    if (t.kind === "other" || t.kind === "badkey") return "raw";
    if (t.kind === "assign") assigns++;
  }
  if (assigns === 0) return "raw";
  return singleLineLooksRaw(text, tokens) ? "raw" : "dotenv";
}

/**
 * `dotenv` iff every non-blank, non-comment logical line is a `KEY=` line
 * (double-quoted values may span lines) and there is at least one, unless the
 * whole text is one base64-shaped line; otherwise `raw`.
 */
export function detectSecretFormat(text: string): SecretFormat {
  const norm = normalise(text);
  return detectNormalised(norm, tokenise(norm));
}

// --- Advisories -------------------------------------------------------------------

const PLACEHOLDER_WORDS = new Set([
  "changeme",
  "change_me",
  "change-me",
  "changeit",
  "replaceme",
  "replace_me",
  "replace-me",
  "placeholder",
  "todo",
  "tbd",
]);

function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v === "") return false;
  if (PLACEHOLDER_WORDS.has(v.toLowerCase())) return true;
  if (/(^|[-_])x{3,}$/i.test(v)) return true; // xxx, sk-xxxx
  if (/^<[^<>\n]*>$/.test(v)) return true; // <token>, <...>
  if (/^your[-_ ]/i.test(v) || /[-_ ]here$/i.test(v)) return true; // your-api-key, put_key_here
  if (v.length >= 3 && /^(.)\1+$/su.test(v)) return true; // aaaa, ....
  return false;
}

/** Known token prefixes, most specific first, and the service each names. */
const TOKEN_SHAPES: ReadonlyArray<{ re: RegExp; service: string; label: string }> = [
  { re: /^(github_pat_|ghp_|gho_)/, service: "GITHUB", label: "GitHub" },
  { re: /^sk-ant-/, service: "ANTHROPIC", label: "Anthropic" },
  { re: /^sk-or-/, service: "OPENROUTER", label: "OpenRouter" },
  { re: /^sk-/, service: "OPENAI", label: "OpenAI" },
  { re: /^xox[bp]-/, service: "SLACK", label: "Slack" },
  { re: /^AKIA/, service: "AWS", label: "AWS" },
  { re: /^glpat-/, service: "GITLAB", label: "GitLab" },
];

/** Key-name words that name a service. */
const KEY_SERVICES: Readonly<Record<string, string>> = {
  GITHUB: "GITHUB",
  GH: "GITHUB",
  ANTHROPIC: "ANTHROPIC",
  CLAUDE: "ANTHROPIC",
  OPENROUTER: "OPENROUTER",
  OPENAI: "OPENAI",
  SLACK: "SLACK",
  AWS: "AWS",
  GITLAB: "GITLAB",
};

function keyService(key: string): string | null {
  for (const word of key.toUpperCase().split("_")) {
    const s = KEY_SERVICES[word];
    if (s !== undefined) return s;
  }
  return null;
}

function valueAdvisories(key: string, value: string, warnings: SecretEnvIssue[], line?: number): void {
  const at = line === undefined ? {} : { line };
  if (isPlaceholder(value)) {
    warnings.push({
      code: "PLACEHOLDER_VALUE",
      key,
      ...at,
      message: `${key} looks like a placeholder, not a real secret.`,
    });
  }
  const wants = keyService(key);
  if (wants === null) return;
  const shape = TOKEN_SHAPES.find((s) => s.re.test(value));
  if (shape !== undefined && shape.service !== wants) {
    warnings.push({
      code: "TOKEN_SHAPE_MISMATCH",
      key,
      ...at,
      message: `${key} holds what looks like a ${shape.label} token.`,
    });
  }
}

// --- Parsing --------------------------------------------------------------------

interface Spec {
  keys: readonly string[];
  optional: readonly string[];
  maxBytes: number;
}

function checkSpec(spec: SecretEnvSpec, mode: SecretInputMode): Spec {
  if (mode !== "auto" && mode !== "raw" && mode !== "dotenv") {
    throw new HermeticError("VALIDATION", "parseSecretEnv: mode must be auto, raw or dotenv");
  }
  const optional = spec.optional_keys ?? [];
  const seen = new Set<string>();
  for (const key of [...spec.keys, ...optional]) {
    if (!SECRET_KEY_RE.test(key)) {
      throw new HermeticError(
        "VALIDATION",
        `parseSecretEnv: ${JSON.stringify(key)} is not a valid secret key`,
      );
    }
    if (seen.has(key)) throw new HermeticError("VALIDATION", `parseSecretEnv: ${key} is named twice`);
    seen.add(key);
  }
  if (seen.size === 0) throw new HermeticError("VALIDATION", "parseSecretEnv: the spec names no keys");
  const maxBytes = spec.maxBytes ?? SECRET_TEXT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new HermeticError("VALIDATION", "parseSecretEnv: maxBytes must be a positive integer");
  }
  return { keys: spec.keys, optional, maxBytes };
}

/** The key a raw paste fills, or null when the spec needs more than one. */
function rawTarget(spec: Spec): string | null {
  if (spec.keys.length === 1) return spec.keys[0] ?? null;
  if (spec.keys.length === 0 && spec.optional.length === 1) return spec.optional[0] ?? null;
  return null;
}

/** A key set in the paste that the request did not name. */
interface Unrequested {
  key: string;
  line: number;
}

/**
 * What an issue or chip may call a key read from the paste: the key itself
 * when it, or its upper-case form, is one the request named; otherwise
 * nothing, since a pasted "key" may be the body of a base64 secret.
 */
function echoable(spec: Spec, key: string): string | undefined {
  const named = (k: string): boolean => spec.keys.includes(k) || spec.optional.includes(k);
  return named(key) || named(key.toUpperCase()) ? key : undefined;
}

function chipsFor(
  spec: Spec,
  found: ReadonlyMap<string, string>,
  unrequested: readonly Unrequested[],
): SecretEnvChip[] {
  const chips: SecretEnvChip[] = [];
  for (const key of spec.keys) {
    const v = found.get(key);
    chips.push(
      v === undefined ? { key, state: "missing" } : { key, state: "ok", length: codePoints(v) },
    );
  }
  for (const key of spec.optional) {
    const v = found.get(key);
    chips.push(
      v === undefined
        ? { key, state: "missing", optional: true }
        : { key, state: "ok", optional: true, length: codePoints(v) },
    );
  }
  for (const u of unrequested) {
    const label = echoable(spec, u.key) ?? `key on line ${u.line}`;
    chips.push({ key: label, state: "unrequested", line: u.line });
  }
  return chips;
}

function fail(
  spec: Spec,
  format: SecretFormat | null,
  errors: SecretEnvIssue[],
  meta: { lines: number; bytes: number },
  warnings: SecretEnvIssue[] = [],
): SecretEnvResult {
  return { ok: false, format, chips: chipsFor(spec, new Map(), []), errors, warnings, ...meta };
}

/** One error per line carrying a control character, attributed to its key. */
function controlErrors(text: string, owner: (line: number) => string | undefined): SecretEnvIssue[] {
  const errors: SecretEnvIssue[] = [];
  text.split("\n").forEach((l, i) => {
    if (!CONTROL_RE.test(l)) return;
    const line = i + 1;
    const key = owner(line);
    errors.push({
      code: "CONTROL_CHARACTER",
      line,
      ...(key === undefined ? {} : { key }),
      message: `Line ${line} contains a control character${key === undefined ? "" : ` (in ${key})`}.`,
    });
  });
  return errors;
}

function parseRaw(text: string, spec: Spec, meta: { lines: number; bytes: number }): SecretEnvResult {
  const key = rawTarget(spec);
  if (key === null) {
    return fail(
      spec,
      "raw",
      [
        {
          code: "RAW_NEEDS_ONE_KEY",
          message: "This request needs several keys: paste as KEY=value lines.",
        },
      ],
      meta,
    );
  }
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  const errors = controlErrors(text, () => key);
  const warnings: SecretEnvIssue[] = [];
  if (value === "") errors.push({ code: "EMPTY_VALUE", key, message: `${key} is empty.` });
  else {
    if (/^[ \t\n]|[ \t\n]$/.test(value)) {
      warnings.push({
        code: "VALUE_WHITESPACE",
        key,
        message: `${key} starts or ends with whitespace, which is kept.`,
      });
    }
    const first = ASSIGN_RE.exec(value.split("\n")[0] ?? "");
    const name = first?.[2];
    if (name !== undefined) {
      if (name.toUpperCase() === key) {
        warnings.push({
          code: "RAW_LOOKS_LIKE_ASSIGNMENT",
          key,
          message: `The value starts with ${name}=: did you mean to paste it as KEY=value?`,
        });
      } else if (/^[A-Z_][A-Z0-9_]*$/.test(name) && !/^[^=\s]+=*$/.test(value.split("\n")[0] ?? "")) {
        // An env-shaped name with a real value after it; `ABC==` is padding.
        // Named only when the request names it: otherwise it is paste text.
        const other = echoable(spec, name);
        warnings.push({
          code: "RAW_LOOKS_LIKE_OTHER_KEY",
          key,
          message:
            other === undefined
              ? `The value starts with something that looks like another key name: is this the secret for ${key}?`
              : `The value starts with ${other}=: did you mean to paste ${other}?`,
        });
      }
    }
    valueAdvisories(key, value, warnings);
  }
  const found = new Map([[key, value]]);
  const chips = chipsFor(spec, found, []);
  if (errors.length > 0) return { ok: false, format: "raw", chips, errors, warnings, ...meta };
  const entries = [{ key, value }];
  return {
    ok: true,
    format: "raw",
    entries,
    canonical: canonicalSecretEnv(entries),
    chips,
    warnings,
    ...meta,
  };
}

function parseDotenv(
  text: string,
  tokens: readonly Token[],
  spec: Spec,
  meta: { lines: number; bytes: number },
): SecretEnvResult {
  const errors: SecretEnvIssue[] = [];
  const warnings: SecretEnvIssue[] = [];
  const allowed = new Set([...spec.keys, ...spec.optional]);
  const found = new Map<string, string>();
  // Keys whose only line is malformed: neither found (no "✓" chip beside the
  // error) nor missing (the line's own error already says what is wrong).
  const broken = new Set<string>();
  const unrequested: Unrequested[] = [];
  const owners: AssignToken[] = [];

  for (const t of tokens) {
    if (t.kind !== "assign") {
      if (t.kind === "other") {
        errors.push({
          code: "NOT_DOTENV_LINE",
          line: t.line,
          message: `Line ${t.line} is neither KEY=value nor a comment.`,
        });
      } else if (t.kind === "badkey") {
        errors.push({
          code: "BAD_KEY_NAME",
          line: t.line,
          message: `Line ${t.line}: the key is not a valid variable name.`,
        });
      }
      continue;
    }
    owners.push(t);
    const { key, line } = t;
    // What this line may be called by: the key when the request names it.
    const shown = echoable(spec, key);
    const named = shown === undefined ? {} : { key: shown };
    if (key.length > DOTENV_KEY_MAX) {
      errors.push({
        code: "BAD_KEY_NAME",
        line,
        message: `Line ${line}: the key is longer than ${DOTENV_KEY_MAX} characters.`,
      });
      continue;
    }
    if (t.error === "UNTERMINATED_QUOTE") {
      errors.push({
        code: "UNTERMINATED_QUOTE",
        ...named,
        line,
        message:
          shown === undefined
            ? `Line ${line}: a quote is never closed.`
            : `Line ${line}: the quote opened for ${shown} is never closed.`,
      });
    } else if (t.error === "UNEXPECTED_TEXT") {
      errors.push({
        code: "UNEXPECTED_TEXT",
        ...named,
        line: t.endLine,
        message:
          shown === undefined
            ? `Line ${t.endLine}: unexpected text after a closing quote.`
            : `Line ${t.endLine}: unexpected text after ${shown}'s closing quote.`,
      });
    }
    if (t.error !== undefined) {
      broken.add(key);
      continue;
    }
    if (/[a-z]/.test(key)) {
      warnings.push({
        code: "LOWERCASE_KEY",
        ...named,
        line,
        message:
          shown === undefined
            ? `Line ${line}: the key has lower-case letters.`
            : `Line ${line}: ${shown} has lower-case letters. Did you mean ${shown.toUpperCase()}?`,
      });
    }
    if (found.has(key) || broken.has(key) || unrequested.some((u) => u.key === key)) {
      errors.push({
        code: "DUPLICATE_KEY",
        ...named,
        line,
        message:
          shown === undefined
            ? `Line ${line} repeats a key.`
            : `Line ${line}: ${shown} is set more than once.`,
      });
      continue;
    }
    if (!allowed.has(key)) {
      unrequested.push({ key, line });
      errors.push({
        code: "UNREQUESTED_KEY",
        ...named,
        line,
        message:
          shown === undefined
            ? `Line ${line} sets a key that was not requested; remove it.`
            : `Line ${line}: ${shown} was not requested; remove it.`,
      });
      continue;
    }
    found.set(key, t.value);
    if (t.value === "") {
      errors.push({ code: "EMPTY_VALUE", key, line, message: `Line ${line}: ${key} is empty.` });
      continue;
    }
    if (t.padded) {
      warnings.push({
        code: "VALUE_WHITESPACE",
        key,
        line,
        message: `Line ${line}: whitespace around ${key}'s value was trimmed.`,
      });
    }
    valueAdvisories(key, t.value, warnings, line);
  }

  for (const key of spec.keys) {
    if (!found.has(key) && !broken.has(key)) {
      errors.push({ code: "MISSING_KEY", key, message: `${key} is missing.` });
    }
  }
  errors.push(
    ...controlErrors(text, (line) => {
      const owner = owners.find((o) => line >= o.line && line <= o.endLine);
      return owner === undefined ? undefined : echoable(spec, owner.key);
    }),
  );

  const chips = chipsFor(spec, found, unrequested);
  if (errors.length > 0) return { ok: false, format: "dotenv", chips, errors, warnings, ...meta };
  const entries: SecretEnvEntry[] = [];
  for (const key of [...spec.keys, ...spec.optional]) {
    const value = found.get(key);
    if (value !== undefined) entries.push({ key, value });
  }
  return {
    ok: true,
    format: "dotenv",
    entries,
    canonical: canonicalSecretEnv(entries),
    chips,
    warnings,
    ...meta,
  };
}

/**
 * Read a pasted or dropped secret text against the keys a request named.
 * Throws only for a malformed `spec` or `mode`; everything about the input is
 * reported in the result.
 */
export function parseSecretEnv(
  input: string | Uint8Array,
  spec: SecretEnvSpec,
  mode: SecretInputMode = "auto",
): SecretEnvResult {
  const s = checkSpec(spec, mode);
  const bytes = typeof input === "string" ? new TextEncoder().encode(input).length : input.length;
  if (bytes > s.maxBytes) {
    return fail(
      s,
      null,
      [{ code: "TOO_LARGE", message: `The text is larger than ${s.maxBytes} bytes.` }],
      { lines: 0, bytes },
    );
  }
  let decoded: string;
  if (typeof input === "string") {
    if (!wellFormed(input)) {
      return fail(s, null, [{ code: "INVALID_UTF8", message: "The text is not valid UTF-8." }], {
        lines: 0,
        bytes,
      });
    }
    decoded = input;
  } else {
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      return fail(s, null, [{ code: "INVALID_UTF8", message: "The text is not valid UTF-8." }], {
        lines: 0,
        bytes,
      });
    }
  }
  const text = normalise(decoded);
  const meta = { lines: countLines(text), bytes };
  if (/^[\s]*$/.test(text)) {
    return fail(s, null, [{ code: "EMPTY_INPUT", message: "Nothing was pasted." }], meta);
  }
  const tokens = tokenise(text);
  let format: SecretFormat = mode === "auto" ? detectNormalised(text, tokens) : mode;
  // Raw cannot fill a multi-key request; if the text has any KEY= line, the
  // operator is better served by line-level dotenv errors.
  if (
    mode === "auto" &&
    format === "raw" &&
    rawTarget(s) === null &&
    tokens.some((t) => t.kind === "assign")
  ) {
    format = "dotenv";
  }
  return format === "raw" ? parseRaw(text, s, meta) : parseDotenv(text, tokens, s, meta);
}

// --- Canonical form --------------------------------------------------------------

/**
 * `KEY="value"` lines: the one form the box stores, re-parses, and sources
 * with `set -a; . <file>; set +a`. So the quoting is sh's: inside double
 * quotes `\`, `"`, `$` and backtick are backslash-escaped (nothing expands,
 * nothing runs) and a newline is a real newline, which sh keeps verbatim.
 * There is no `\n` escape — sh would leave it as backslash-n.
 */
const CANONICAL_RE = /^(?:[A-Z_][A-Z0-9_]{0,63}="(?:[^"\\$`]|\\["\\$`])*"\n)*$/;
const CANONICAL_ENTRY_RE = /([A-Z_][A-Z0-9_]{0,63})="((?:[^"\\$`]|\\["\\$`])*)"\n/g;

/**
 * `KEY="escaped"\n` per entry, escaping `\`, `"`, `$` and backtick; newlines
 * stay literal inside the quotes. Throws `VALIDATION` on a key outside
 * `SECRET_KEY_RE`, a repeated key, or a value carrying a control character
 * other than tab and newline — none of which `parseSecretEnv` ever returns in
 * `entries`. `parseSecretEnv(out, spec, "dotenv")` gives the entries back,
 * and canonicalising those gives `out` again, byte for byte.
 */
export function canonicalSecretEnv(entries: readonly SecretEnvEntry[]): string {
  const seen = new Set<string>();
  let out = "";
  for (const { key, value } of entries) {
    if (!SECRET_KEY_RE.test(key))
      throw new HermeticError(
        "VALIDATION",
        `canonicalSecretEnv: ${JSON.stringify(key)} is not a valid secret key`,
      );
    if (seen.has(key))
      throw new HermeticError("VALIDATION", `canonicalSecretEnv: ${key} appears twice`);
    if (CONTROL_RE.test(value))
      throw new HermeticError("VALIDATION", `canonicalSecretEnv: ${key} carries a control character`);
    seen.add(key);
    out += `${key}="${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"\n`;
  }
  return out;
}

/**
 * The inverse of `canonicalSecretEnv`, strict: any deviation from its exact
 * output (a comment, a missing final newline, an unescaped `$`, backtick or
 * quote, any escape but the four, a repeated key, a control character) is
 * `null`.
 */
export function readCanonicalSecretEnv(text: string): SecretEnvEntry[] | null {
  if (!CANONICAL_RE.test(text) || CONTROL_RE.test(text)) return null;
  const entries: SecretEnvEntry[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CANONICAL_ENTRY_RE)) {
    const key = m[1] ?? "";
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ key, value: (m[2] ?? "").replace(/\\(["\\$`])/g, "$1") });
  }
  return entries;
}
