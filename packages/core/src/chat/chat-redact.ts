/**
 * The one door every byte of a transcript leaves core through.
 *
 * A chat transcript is the only thing in hermetic that carries text nobody in
 * this repo wrote. The box runs a model with a shell, an editor and a browser;
 * an operator pastes a key into a prompt to ask why it does not work; a tool
 * echoes `env` into its result. Every one of those is a credential arriving in
 * a payload that no schema constrains, on its way to a renderer that will
 * happily draw it.
 *
 * Three decisions in here are worth stating, because each was made against a
 * plausible alternative.
 *
 * **It masks rather than drops.** `Bearer sk-ant-…` becomes `Bearer [redacted]`
 * and not `[redacted]`, and a tool result containing one secret keeps its other
 * four hundred lines. The alternative — blank anything suspicious — makes the
 * transcript useless for the debugging it exists for, and it makes an
 * incomplete pattern list *look* safe while it quietly eats output. The pattern
 * list below is going to be incomplete; the honest response to that is to fix
 * the list, not to blind the operator.
 *
 * **It deep-walks.** A secret is far likelier to appear inside a tool block's
 * `args` or `result`, or an `unknown` block's `payload`, than in a top-level
 * field — and those three are exactly the fields typed `unknown`, so no schema
 * walk reaches them. Every object, array and string under a block is visited.
 *
 * **Nothing a caller touches is load-bearing.** `SECRET_PATTERNS` is exported so
 * a test can assert the whole set rather than a sample of it, and a `RegExp`
 * with the `g` flag carries mutable `lastIndex` state that `RegExp.prototype.test`
 * advances. One `.test()` against a shared, exported pattern would therefore
 * disable that pattern for the rest of the process — a security control turned
 * off by a *read*. So the exported array holds freshly compiled copies, the
 * internal ones are never handed out, and `maskAll` resets `lastIndex` anyway.
 * Both belts, because this is the failure that leaves no trace.
 *
 * Note what this file is *not*: it is not the leak-grep test. The existing test
 * (`test/secrets-leak.test.ts`) asserts a handful of known `FIXTURE` sentinel
 * values plus one generic tailscale-key pattern; it was never a reusable
 * pattern library, and the design's claim that redaction "reuses the patterns the
 * existing leak-grep test greps for" describes something that did not exist.
 * This is that library.
 */
import type { ChatBlock, ChatFrame, ChatMessage } from "../schema/index.ts";

/** What every match is replaced with. Bracketed so it cannot re-match as a value. */
export const REDACTED = "[redacted]";

/** Stands in for a value that referred back to something already walked. */
export const CYCLE_MARK = "[cycle]";

/** Stands in for a subtree deeper than `MAX_DEPTH`. */
export const DEPTH_MARK = "[truncated]";

/**
 * How deep the walk goes before it gives up.
 *
 * Generous — a real tool result nests three or four levels — and present only
 * so that a pathological payload cannot turn a history read into a stack
 * overflow surfacing as an unclassified 500.
 */
export const MAX_DEPTH = 64;

/**
 * The key half of the three assignment patterns, shared so the three cannot
 * drift apart. The optional quotes let one expression match a bare `API_KEY=`,
 * a YAML `password:` and a JSON `"api_key":` alike.
 */
const SECRET_KEY =
  '"?\\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|token|credential)[A-Za-z0-9_.-]*\\b"?';

/**
 * Every pattern, in the order they are applied — **the internal copies**. These
 * objects never leave the module; see `SECRET_PATTERNS` below.
 *
 * Two conventions hold for all of them:
 *
 * - Every pattern is global (`g`), because `maskAll` walks matches with
 *   `matchAll`, which throws on a non-global pattern.
 * - A pattern may carry two named groups, `keep` and `tail`, which are the
 *   prefix and suffix preserved around the mask. That is how
 *   `"api_key": "…"` survives as valid JSON and how `Bearer …` keeps the word
 *   `Bearer`. A pattern with neither group has its whole match replaced.
 *
 * Order is significant for two reasons. Vendor patterns run before the generic
 * assignment ones so a match is attributed to the thing it actually is; and the
 * quoted assignment forms run before the bare one so that a quoted value is
 * consumed to its closing quote rather than to its first space.
 */
const PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  /**
   * A PEM block first, because it is the one secret that spans lines and the
   * only one a line-oriented pattern would shred into unmatched fragments.
   *
   * The terminator is optional, and that is the whole point: a private key
   * usually reaches a transcript through `head`, a truncated `cat`, or a stream
   * the agent cut off, so the `-----END-----` line is exactly what is missing in
   * the common case. Requiring it meant a truncated key was returned verbatim.
   * The trailing `[A-Z ]*` covers `-----BEGIN PGP PRIVATE KEY BLOCK-----`,
   * which has a word after `KEY`.
   */
  {
    name: "pem-private-key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY[A-Z ]*-----|$)/g,
  },
  /**
   * Tailscale auth keys and OAuth client secrets share the `tskey-` prefix.
   * This is the one pattern the existing leak-grep test already carried, and
   * the spelling is kept identical to it so the two cannot drift apart.
   */
  { name: "tailscale-key", pattern: /\btskey-[A-Za-z0-9-]+/g },
  /**
   * AWS access key ids are self-identifying: a four-letter resource prefix and
   * sixteen base-32 characters. They are not secret on their own, but they name
   * the account and they travel next to the thing that is.
   */
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  /**
   * The secret half has no prefix — forty characters of base64 is not a
   * distinguishable shape — so it is only recognisable where it is named. The
   * generic assignment patterns below would catch it too; this one exists so
   * the match is *named* for what it is.
   */
  {
    name: "aws-secret-access-key",
    pattern: /(?<keep>\baws_secret_access_key\b\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}(?<tail>["']?)/gi,
  },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "openrouter-key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{8,}/g },
  /**
   * Stripe, before the `sk-` family: its separator is an underscore, so
   * `sk_live_…` is not a near-miss of `sk-…` — it is invisible to it.
   */
  { name: "stripe-key", pattern: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  /**
   * Last of the `sk-` family, so `sk-ant-` and `sk-or-v1-` are attributed to
   * their own vendors first. The optional infixes are OpenAI's project,
   * service-account and admin key shapes.
   */
  { name: "openai-key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{12,}/g },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  /**
   * Bitwarden Secrets Manager, which hermetic itself pushes to boxes (§8.3), so
   * an agent printing one is an ordinary event rather than a mishap. Two shapes:
   * the `bws-token-` spelling this repo uses for the SSM slot and its fixture
   * (`FIXTURE_BWS_TOKEN` in `memory-fixture.ts`, grepped for by
   * `secrets-leak.test.ts`), and the access token Bitwarden actually issues,
   * which is a version byte, a client UUID and two base64 halves.
   */
  {
    name: "bitwarden-token",
    pattern:
      /\bbws-token-[A-Za-z0-9._-]+|\b0\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.[A-Za-z0-9+/=]{20,}:[A-Za-z0-9+/=]{20,}/g,
  },
  { name: "slack-token", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{20,}/g },
  { name: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  /**
   * A bare JWT. Over-masking is possible — anything base64url in three dotted
   * parts beginning `eyJ` — and accepted: a JWT in a transcript is a session an
   * attacker can resume, and the false positives are opaque blobs nobody reads.
   */
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_=-]{6,}\.[A-Za-z0-9_=-]{6,}(?:\.[A-Za-z0-9_=-]*)?/g },
  /**
   * `Bearer` without requiring `Authorization:` in front of it: the header is
   * quoted into curl commands, logged by request tracers and pasted into chat
   * far more often than it appears as a literal header line.
   */
  { name: "bearer-token", pattern: /(?<keep>\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g },
  /**
   * The three assignment shapes, by the name of the key rather than the shape
   * of the value. A value is only a secret because of what it was called; no
   * pattern can recognise an opaque token that has no vendor prefix, and every
   * attempt to recognise one by entropy alone masks git SHAs and base64 images.
   *
   * The double-quoted form handles JSON and `KEY="value"` together, and its
   * body is `(?:[^"\\]|\\.)*` rather than `[^"]*` so an escaped quote inside the
   * value does not end the match early — which would leak the tail of the
   * secret *and* leave the JSON malformed for whatever parses it next.
   */
  {
    name: "assignment-double-quoted",
    pattern: new RegExp(`(?<keep>${SECRET_KEY}\\s*[:=]\\s*")(?:[^"\\\\]|\\\\.)*(?<tail>")`, "gi"),
  },
  {
    name: "assignment-single-quoted",
    pattern: new RegExp(`(?<keep>${SECRET_KEY}\\s*[:=]\\s*')[^']*(?<tail>')`, "gi"),
  },
  /**
   * The unquoted form, last, so a quoted value has already been consumed whole.
   *
   * `&` is excluded from the value class so that masking one query parameter
   * does not eat the rest of a URL: `?api_key=K&id=5` has to keep `&id=5`, or
   * the operator loses the parameters they needed the log line for.
   */
  {
    name: "assignment-bare",
    pattern: new RegExp(`(?<keep>${SECRET_KEY}\\s*[:=]\\s*)[^\\s"',;&}]+`, "gi"),
  },
];

/**
 * The same set, as objects no caller shares with the redactor.
 *
 * Exported for tests and for the leak grep. A consumer is free to `.test()`,
 * `.exec()` or otherwise advance `lastIndex` on any of these; it cannot reach
 * the patterns `redactText` actually runs.
 */
export const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = PATTERNS.map(
  ({ name, pattern }) => ({ name, pattern: new RegExp(pattern.source, pattern.flags) }),
);

/**
 * Masks every match in a string, preserving everything around it.
 *
 * Built with `matchAll` rather than `String.replace` with a replacer function
 * because the replacer's named-groups argument arrives last in a variadic
 * `any[]`, and this package may not write `any` (lint rule 2). Walking the
 * matches directly is a few more lines and fully typed.
 */
export function redactText(text: string): string {
  let out = text;
  for (const { pattern } of PATTERNS) {
    out = maskAll(out, pattern);
  }
  return out;
}

function maskAll(text: string, pattern: RegExp): string {
  // `matchAll` seeds its internal clone from `lastIndex`, so a pattern left
  // mid-string by an earlier `exec`/`test` would silently start scanning from
  // the middle. Nothing in this module advances it; the reset is here because
  // *something else* eventually will.
  pattern.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    // `matchAll` always reports an index; the guard is for the type, not the case.
    if (at === undefined) continue;
    const keep = match.groups?.keep ?? "";
    const tail = match.groups?.tail ?? "";
    out += text.slice(cursor, at) + keep + REDACTED + tail;
    cursor = at + match[0].length;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

/**
 * Masks every string anywhere inside a value of unknown shape.
 *
 * This is the half that matters. `args`, `result` and `payload` are typed
 * `unknown` precisely because hermetic does not model what upstream puts there,
 * so nothing but a structural walk can reach a secret sitting four levels down
 * in a tool's JSON result.
 *
 * Three things it deliberately does not do.
 *
 * Object *keys* are left alone. A key is a field name chosen by whoever wrote
 * the tool, never the credential; masking keys would rename `api_key` to
 * `[redacted]` and destroy the only clue about what was masked.
 *
 * Anything that is not a plain object or an array is returned as it arrived.
 * Rebuilding a `Map`, a `Set`, a `Date` or a `Uint8Array` from `Object.entries`
 * turns it into `{}` or into a dictionary of byte indices — a walk that
 * destroys the data it was asked to clean. Everything reaching this function
 * from the adapter is `JSON.parse` output, so a non-plain object is by
 * construction not transcript text; a caller that hands one in gets it back.
 *
 * And it stops. A cyclic value would recurse until the stack gave out, and a
 * `RangeError` thrown out of `redactMessage` surfaces to the operator as an
 * unclassified 500 on a history read rather than as a transcript.
 */
export function redactDeep(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>(), false);
}

/**
 * The same key names the assignment patterns look for, applied to an **object
 * key** rather than to text.
 *
 * This is the rule that catches a credential which has already been parsed. The
 * `assignment-*` patterns only fire when a key and its value sit in one string,
 * and once upstream hands over decoded JSON they never do again — so a tool
 * called with `{"api_key": "<opaque value>"}`, which is the ordinary way a tool
 * takes a credential, passed through untouched. No pattern can recognise that
 * value: it has no vendor prefix and there is nothing but the key to say what it
 * is. The key is enough.
 *
 * No `g` flag: `test` on a global pattern advances `lastIndex`, and this one is
 * called once per key of every object walked.
 */
const SECRET_KEY_NAME = /api[_-]?key|secret|password|passwd|token|credential/i;

/** A count, a size, a version — not a credential, whatever the key is called. */
const NUMERIC_VALUE = /^-?\d+(?:\.\d+)?$/;

/**
 * A string that sits under a secret-sounding key.
 *
 * Masked whole, because its *shape* proves nothing either way. The two
 * exceptions exist to keep the rule from lying about data that is obviously not
 * a credential: an empty string says "not set" and masking it would invent a
 * secret that was never there, and a bare number under a key like `tokens` or
 * `input_tokens` is an accounting figure — `ChatUsage` is full of them — that an
 * operator needs and an attacker cannot use.
 */
function maskNamedValue(value: string): string {
  if (value === "" || NUMERIC_VALUE.test(value)) return value;
  return REDACTED;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, named: boolean): unknown {
  if (typeof value === "string") return named ? maskNamedValue(value) : redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return DEPTH_MARK;
  if (seen.has(value)) return CYCLE_MARK;

  if (Array.isArray(value)) {
    // `named` travels through an array — `{"secrets": ["a", "b"]}` is a list of
    // secrets — but not into a nested object below, where each key is judged on
    // its own name. Propagating it down an object would turn a whole config
    // blob under one key called `credentials` into a wall of `[redacted]`,
    // destroying the structure an operator reads it for.
    seen.add(value);
    const out = value.map((item) => walk(item, depth + 1, seen, named));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value;

  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walk(inner, depth + 1, seen, SECRET_KEY_NAME.test(key));
  }
  seen.delete(value);
  return out;
}

/** A `{}` literal or a `JSON.parse` result — not a class instance, not a builtin. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}

/**
 * Deep-walks one block.
 *
 * Written as an exhaustive switch rather than as a generic object walk so that
 * adding a block kind to `schema/chat.ts` fails to compile here. A new block
 * type that silently bypassed redaction is the exact failure §9.2 puts this
 * module in core to prevent, and a renderer is where it would be noticed —
 * which is to say, after it had already been drawn.
 */
export function redactBlock(block: ChatBlock): ChatBlock {
  switch (block.kind) {
    case "text":
      return { ...block, markdown: redactText(block.markdown) };
    case "activity":
      return {
        ...block,
        key: redactText(block.key),
        title: redactText(block.title),
        detail: typeof block.detail === "string" ? redactText(block.detail) : block.detail,
        ...(block.payload !== undefined ? { payload: redactDeep(block.payload) } : {}),
      };
    case "reasoning":
      return { ...block, text: redactText(block.text) };
    case "tool":
      return {
        ...block,
        args: redactDeep(block.args),
        result: block.result === undefined ? block.result : redactDeep(block.result),
      };
    case "attachment":
      // `href` is a URL the box minted, and a signed one carries its credential
      // in the query string.
      return { ...block, name: redactText(block.name), href: redactText(block.href) };
    case "approval":
      return {
        ...block,
        summary: redactText(block.summary),
        detail: typeof block.detail === "string" ? redactText(block.detail) : block.detail,
        ...(block.payload !== undefined ? { payload: redactDeep(block.payload) } : {}),
      };
    case "question":
      return {
        ...block,
        prompt: redactText(block.prompt),
        choices: block.choices.map(redactText),
        ...(block.payload !== undefined ? { payload: redactDeep(block.payload) } : {}),
      };
    case "sources":
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          title: redactText(item.title),
          href: redactText(item.href),
          snippet: typeof item.snippet === "string" ? redactText(item.snippet) : item.snippet,
        })),
      };
    case "hermetic":
      // A ref is an agent or op name and cannot hold a secret, but it costs
      // nothing to run and this switch is the place a future ref shape lands.
      return { ...block, ref: redactText(block.ref) };
    case "unknown":
      // The whole point of the fallthrough block: hermetic does not know what
      // is in `payload`, which is the strongest possible reason to walk it.
      return { ...block, payload: redactDeep(block.payload) };
  }
}

export function redactMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    blocks: message.blocks.map(redactBlock),
    error: typeof message.error === "string" ? redactText(message.error) : message.error,
  };
}

/**
 * One live frame.
 *
 * `done` needs no walk: its only free-text field is a model name, and usage is
 * numbers. `error` does need one — an upstream failure message quotes the
 * request that failed, headers included.
 */
export function redactFrame(frame: ChatFrame): ChatFrame {
  switch (frame.type) {
    case "block":
      return { ...frame, block: redactBlock(frame.block) };
    case "delta":
      return { ...frame, text: redactText(frame.text) };
    case "done":
      return frame;
    case "error":
      return { ...frame, message: redactText(frame.message) };
  }
}
