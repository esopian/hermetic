/**
 * The one door every byte of a transcript leaves core through.
 *
 * Three things are asserted and they pull against each other, which is the
 * point. Every pattern must mask — a table below names each entry in
 * `SECRET_PATTERNS` and fails if one is added without a case. Every mask must
 * keep the text around it: `Bearer [redacted]` and not `[redacted]`, because a
 * transcript that blanks a whole tool result the moment it sees a credential is
 * a transcript nobody can debug from, and the pattern list is always going to be
 * incomplete. And the module must survive being *used*: a caller that inspects
 * an exported pattern, a payload that refers to itself, a `Uint8Array` that
 * wandered in — none of those may turn redaction off or throw.
 *
 * Every sample value here is a `FIXTURE` sentinel (§11.3). Nothing in this file
 * resembles a real credential, and the leak-grep test greps for these spellings.
 */
import { describe, expect, test } from "bun:test";
import {
  CYCLE_MARK,
  DEPTH_MARK,
  MAX_DEPTH,
  REDACTED,
  redactBlock,
  redactDeep,
  redactFrame,
  redactMessage,
  redactText,
  SECRET_PATTERNS,
} from "../src/chat/chat-redact.ts";
import type { ChatBlock, ChatMessage } from "../src/schema/index.ts";

/**
 * One case per pattern, keyed by the pattern's own name. The test below asserts
 * this table and `SECRET_PATTERNS` name the same set, so a pattern added
 * without a case fails rather than shipping untested.
 */
const CASES: Record<string, { input: string; want: string }> = {
  "pem-private-key": {
    input:
      "key follows\n-----BEGIN RSA PRIVATE KEY-----\nFIXTUREFIXTUREFIXTURE\n" +
      "-----END RSA PRIVATE KEY-----\nand that was it",
    want: `key follows\n${REDACTED}\nand that was it`,
  },
  "tailscale-key": {
    input: "joined with tskey-auth-FIXTURE-SECRET today",
    want: `joined with ${REDACTED} today`,
  },
  "aws-access-key-id": {
    input: "caller is AKIAFIXTUREFIXTURE00 in us-east-1",
    want: `caller is ${REDACTED} in us-east-1`,
  },
  "aws-secret-access-key": {
    input: "aws_secret_access_key = FIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTU",
    want: `aws_secret_access_key = ${REDACTED}`,
  },
  "anthropic-key": {
    input: "export ANTHROPIC=sk-ant-api03-FIXTUREVALUE",
    want: `export ANTHROPIC=${REDACTED}`,
  },
  "openrouter-key": {
    input: "openrouter uses sk-or-v1-FIXTURE-PROVIDER-KEY here",
    want: `openrouter uses ${REDACTED} here`,
  },
  "stripe-key": {
    // Underscores, not hyphens, so the `sk-` family never sees it.
    input: "charged with sk_live_FIXTUREFIXTURE00 just now",
    want: `charged with ${REDACTED} just now`,
  },
  "openai-key": {
    input: "and openai uses sk-proj-FIXTUREFIXTUREVALUE",
    want: `and openai uses ${REDACTED}`,
  },
  "github-token": {
    input: "gh auth login --with-token ghp_FIXTUREFIXTUREFIXTURE",
    want: `gh auth login --with-token ${REDACTED}`,
  },
  "bitwarden-token": {
    // The value `memory-fixture.ts` defines and `secrets-leak.test.ts` greps
    // for, pasted bare — no key name beside it, no vendor prefix any other
    // family knows.
    input: "pasted bws-token-FIXTURE-SECRET into the prompt",
    want: `pasted ${REDACTED} into the prompt`,
  },
  "slack-token": {
    input: "posted with xoxb-FIXTURE-SLACK-VALUE-0 ok",
    want: `posted with ${REDACTED} ok`,
  },
  "google-api-key": {
    input: "maps key AIzaFIXTUREFIXTUREFIXTUREFIXTUREFIX in config",
    want: `maps key ${REDACTED} in config`,
  },
  "npm-token": {
    input: "//registry.npmjs.org/:_authToken=npm_FIXTUREFIXTUREFIXTURE00",
    want: `//registry.npmjs.org/:_authToken=${REDACTED}`,
  },
  "sendgrid-key": {
    input: "mail via SG.FIXTUREFIXTURE.FIXTUREFIXTURE today",
    want: `mail via ${REDACTED} today`,
  },
  jwt: {
    input: "cookie was eyJFIXTURE.eyJGIXTUREBODY.FIXTURESIG and expired",
    want: `cookie was ${REDACTED} and expired`,
  },
  "bearer-token": {
    input: "curl -H 'Authorization: Bearer FIXTUREBEARERVALUE' https://example.test",
    want: `curl -H 'Authorization: Bearer ${REDACTED}' https://example.test`,
  },
  "assignment-double-quoted": {
    input: '{"api_key": "FIXTURE-JSON-VALUE", "region": "us-east-1"}',
    want: `{"api_key": "${REDACTED}", "region": "us-east-1"}`,
  },
  "assignment-single-quoted": {
    input: "password='FIXTURE SINGLE VALUE'",
    want: `password='${REDACTED}'`,
  },
  "assignment-bare": {
    input: "password: FIXTURE-YAML-VALUE",
    want: `password: ${REDACTED}`,
  },
};

describe("chat-redact · the pattern set", () => {
  test("every pattern has a case and every case names a pattern", () => {
    expect(Object.keys(CASES).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort());
  });

  test("every pattern is global, because maskAll walks matches", () => {
    // A non-global pattern throws in `matchAll`; a non-global pattern that
    // silently masked only the first match would be worse.
    for (const { name, pattern } of SECRET_PATTERNS) {
      expect(`${name}: ${pattern.flags}`).toContain("g");
    }
  });

  for (const [name, { input, want }] of Object.entries(CASES)) {
    test(`${name} masks the secret and nothing else`, () => {
      expect(redactText(input)).toBe(want);
    });
  }

  test("a real Bitwarden access token is masked by its own shape", () => {
    const token =
      "0.11111111-2222-3333-4444-555555555555.FIXTUREFIXTUREFIXTUREAA=:FIXTUREFIXTUREFIXTUREBB=";
    expect(redactText(`BWS said ${token} today`)).toBe(`BWS said ${REDACTED} today`);
  });

  test("the exact case the owner specified: Bearer keeps its word", () => {
    expect(redactText("Bearer sk-ant-api03-FIXTUREVALUE")).toBe(`Bearer ${REDACTED}`);
  });

  test("several secrets in one string are all masked, together with the prose", () => {
    const line = "tried tskey-auth-FIXTURE-ONE then tskey-auth-FIXTURE-TWO and gave up at 3am";
    expect(redactText(line)).toBe(`tried ${REDACTED} then ${REDACTED} and gave up at 3am`);
  });

  test("a string with nothing in it is returned unchanged", () => {
    const clean = "systemctl status hermes-gateway.service → active (running)";
    expect(redactText(clean)).toBe(clean);
  });

  test("redaction is idempotent — a second pass changes nothing", () => {
    const once = redactText('API_KEY="FIXTURE-ENV-VALUE"');
    expect(redactText(once)).toBe(once);
  });
});

/* ── the two regressions that turn redaction off ──────────────────────────── */

describe("chat-redact · shared RegExp state", () => {
  /**
   * The exported patterns carry the `g` flag, and `RegExp.prototype.test`
   * advances `lastIndex` on a global pattern. Sharing one object between the
   * export and the redactor meant a single `.test()` — by a test, by a head, by
   * anything — moved the redactor's scan start and disabled that pattern for the
   * rest of the process. A security control switched off by a read.
   */
  test("a caller calling .test() on an exported pattern cannot disable redaction", () => {
    const entry = SECRET_PATTERNS.find((p) => p.name === "tailscale-key");
    if (!entry) throw new Error("tailscale-key pattern is gone");

    expect(redactText("tskey-auth-FIXTURE-A and more")).toBe(`${REDACTED} and more`);
    // Advance it, twice, the way any caller inspecting the set would.
    expect(entry.pattern.test("tskey-auth-FIXTURE-A")).toBe(true);
    expect(entry.pattern.lastIndex).toBeGreaterThan(0);
    expect(redactText("tskey-auth-FIXTURE-A and more")).toBe(`${REDACTED} and more`);
  });

  test("every exported pattern survives being advanced", () => {
    for (const { pattern } of SECRET_PATTERNS) pattern.lastIndex = 9_999;
    for (const [, { input, want }] of Object.entries(CASES)) {
      expect(redactText(input)).toBe(want);
    }
  });
});

describe("chat-redact · PEM blocks", () => {
  /**
   * A private key reaches a transcript through `head`, a truncated `cat`, or a
   * stream the agent cut off — so the `-----END-----` line is precisely what is
   * missing in the common case. Requiring it returned the key verbatim.
   */
  test("a truncated PEM block, with no END line, is still masked", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowFIXTUREBODY\nMIIEowFIXTUREBODY2";
    expect(redactText(input)).toBe(REDACTED);
  });

  test("a PEM block with a word after KEY is masked", () => {
    const input =
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nFIXTUREBODY\n-----END PGP PRIVATE KEY BLOCK-----";
    expect(redactText(input)).toBe(REDACTED);
  });

  test("the prose before a truncated block is kept", () => {
    expect(redactText("here it is:\n-----BEGIN EC PRIVATE KEY-----\nFIXTUREBODY")).toBe(
      `here it is:\n${REDACTED}`,
    );
  });
});

/* ── value shapes that used to leak or break ──────────────────────────────── */

describe("chat-redact · value shapes", () => {
  test("a quoted value is consumed to its closing quote, not to its first space", () => {
    expect(redactText('PASSWORD="FIXTURE VALUE HERE"')).toBe(`PASSWORD="${REDACTED}"`);
    expect(redactText("PASSWORD='FIXTURE VALUE HERE'")).toBe(`PASSWORD='${REDACTED}'`);
  });

  test("an escaped quote inside a JSON value neither leaks nor breaks the JSON", () => {
    const out = redactText('{"api_key": "FIX\\"TURE", "ok": true}');
    expect(out).toBe(`{"api_key": "${REDACTED}", "ok": true}`);
    // And whatever parses it next still can.
    expect(JSON.parse(out)).toEqual({ api_key: REDACTED, ok: true });
  });

  test("masking one query parameter keeps the rest of the URL", () => {
    expect(redactText("GET /api/thing?api_key=FIXTUREKEY&id=5&page=2")).toBe(
      `GET /api/thing?api_key=${REDACTED}&id=5&page=2`,
    );
  });

  test("a multi-line env dump masks each line and keeps the others", () => {
    const input = ["HOME=/root", "API_KEY=FIXTURE-ENV-VALUE", "PATH=/usr/bin"].join("\n");
    expect(redactText(input)).toBe(["HOME=/root", `API_KEY=${REDACTED}`, "PATH=/usr/bin"].join("\n"));
  });
});

/* ── the deep walk ────────────────────────────────────────────────────────── */

describe("chat-redact · the deep walk", () => {
  test("masks strings nested in objects and arrays, and leaves everything else", () => {
    expect(
      redactDeep({
        env: ["HOME=/root", "OPENROUTER_API_KEY=sk-or-v1-FIXTURE-PROVIDER-KEY"],
        depth: 3,
        ok: true,
        missing: null,
        nested: { inner: { note: "tskey-auth-FIXTURE-SECRET" } },
      }),
    ).toEqual({
      env: ["HOME=/root", `OPENROUTER_API_KEY=${REDACTED}`],
      depth: 3,
      ok: true,
      missing: null,
      nested: { inner: { note: REDACTED } },
    });
  });

  test("object keys are not renamed — a masked key destroys the only clue", () => {
    expect(Object.keys(redactDeep({ api_key: "x" }) as object)).toEqual(["api_key"]);
  });

  /**
   * The rule that catches a credential which has already been parsed. Once
   * upstream hands over decoded JSON, a key and its value never share a string
   * again, so the `assignment-*` patterns can never fire — and a tool called
   * with `{"api_key": "<opaque>"}`, which is the ordinary way a tool takes a
   * credential, passed through whole.
   */
  test("a shapeless value under a secret-sounding key is masked anyway", () => {
    expect(
      redactDeep({
        api_key: "FIXTURE-OPAQUE-NO-PREFIX",
        apiKey: "FIXTURE-OPAQUE-NO-PREFIX",
        password: "FIXTURE-OPAQUE-NO-PREFIX",
        access_token: "FIXTURE-OPAQUE-NO-PREFIX",
        aws_credential: "FIXTURE-OPAQUE-NO-PREFIX",
        // Not a secret-sounding key, and the value has no recognisable shape,
        // so nothing claims it. That is the honest limit of the rule.
        region: "us-east-1",
      }),
    ).toEqual({
      api_key: REDACTED,
      apiKey: REDACTED,
      password: REDACTED,
      access_token: REDACTED,
      aws_credential: REDACTED,
      region: "us-east-1",
    });
  });

  test("a list under a secret-sounding key is masked element by element", () => {
    expect(redactDeep({ secrets: ["FIXTURE-ONE", "FIXTURE-TWO"] })).toEqual({
      secrets: [REDACTED, REDACTED],
    });
  });

  /**
   * `ChatUsage` is `input_tokens`, `output_tokens` — accounting figures an
   * operator needs and an attacker cannot use. A rule that masked them because
   * the key contains "token" would blank the cost of every turn.
   */
  test("a token *count* is not a token", () => {
    expect(
      redactDeep({
        input_tokens: 13300,
        output_tokens: 4,
        tokens: "4",
        cost_usd: 0.12,
        token_budget: "1000000",
        empty_secret: "",
      }),
    ).toEqual({
      input_tokens: 13300,
      output_tokens: 4,
      tokens: "4",
      cost_usd: 0.12,
      token_budget: "1000000",
      empty_secret: "",
    });
  });

  /**
   * A nested object under a secret-sounding key is judged key by key rather
   * than masked wholesale: blanking a whole config blob because one key above
   * it is called `credentials` destroys the structure an operator reads it for.
   */
  test("a nested object under a secret-sounding key keeps its own structure", () => {
    expect(redactDeep({ credentials: { region: "us-east-1", api_key: "FIXTURE-OPAQUE" } })).toEqual({
      credentials: { region: "us-east-1", api_key: REDACTED },
    });
  });

  /**
   * Rebuilding these from `Object.entries` turned a `Map` into `{}` and a
   * `Uint8Array` into a dictionary of byte indices — a walk that destroyed the
   * data it was asked to clean.
   */
  test("a Map, a Set, a Date and a typed array survive the walk", () => {
    const map = new Map([["k", "v"]]);
    const set = new Set(["v"]);
    const date = new Date("2026-09-16T19:48:41.000Z");
    const bytes = new Uint8Array([1, 2, 3]);
    const out = redactDeep({ map, set, date, bytes }) as Record<string, unknown>;
    expect(out.map).toBe(map);
    expect(out.set).toBe(set);
    expect(out.date).toBe(date);
    expect(out.bytes).toBe(bytes);
  });

  test("a cycle is marked rather than thrown", () => {
    const node: Record<string, unknown> = { note: "tskey-auth-FIXTURE-SECRET" };
    node.self = node;
    const out = redactDeep(node) as Record<string, unknown>;
    expect(out.note).toBe(REDACTED);
    expect(out.self).toBe(CYCLE_MARK);
  });

  test("a cycle inside a message does not throw out of redactMessage", () => {
    const payload: Record<string, unknown> = { note: "tskey-auth-FIXTURE-SECRET" };
    payload.loop = [payload];
    const message: ChatMessage = {
      id: "m1",
      session: "s1",
      role: "bot",
      author: null,
      at: "2026-09-16T19:48:41.000Z",
      blocks: [{ kind: "unknown", name: "x", payload }],
      usage: null,
      error: null,
      incomplete: null,
    };
    expect(() => redactMessage(message)).not.toThrow();
  });

  test("the same object appearing twice is not mistaken for a cycle", () => {
    const shared = { note: "tskey-auth-FIXTURE-SECRET" };
    expect(redactDeep({ a: shared, b: shared })).toEqual({
      a: { note: REDACTED },
      b: { note: REDACTED },
    });
  });

  test("a payload deeper than MAX_DEPTH is truncated rather than overflowing", () => {
    let deep: unknown = "tskey-auth-FIXTURE-SECRET";
    for (let i = 0; i < MAX_DEPTH + 10; i += 1) deep = { next: deep };
    let walked = redactDeep(deep);
    for (let i = 0; i < MAX_DEPTH; i += 1) {
      if (walked === DEPTH_MARK) break;
      walked = (walked as Record<string, unknown>).next;
    }
    expect(walked).toBe(DEPTH_MARK);
  });
});

/* ── blocks ───────────────────────────────────────────────────────────────── */

describe("chat-redact · blocks", () => {
  test("a secret inside a tool block's args and result — the likeliest place", () => {
    const block: ChatBlock = {
      kind: "tool",
      name: "bash",
      server: null,
      args: { cmd: "curl -H 'Authorization: Bearer FIXTUREBEARERVALUE' https://example.test" },
      result: {
        stdout: ["TAILSCALE_AUTH_KEY=tskey-auth-FIXTURE-SECRET", "done"],
        exit: 0,
      },
      status: "ok",
      exit_code: 0,
      duration_ms: 120,
      render: "terminal",
    };
    const out = redactBlock(block);
    expect(out).toEqual({
      ...block,
      args: { cmd: `curl -H 'Authorization: Bearer ${REDACTED}' https://example.test` },
      result: { stdout: [`TAILSCALE_AUTH_KEY=${REDACTED}`, "done"], exit: 0 },
    });
  });

  test("a secret inside an unknown block's payload — the field no schema walks", () => {
    const block: ChatBlock = {
      kind: "unknown",
      name: "vault.entry.revealed",
      payload: { entry: { value: "sk-ant-api03-FIXTUREVALUE" }, count: 1 },
    };
    expect(redactBlock(block)).toEqual({
      kind: "unknown",
      name: "vault.entry.revealed",
      payload: { entry: { value: REDACTED }, count: 1 },
    });
  });

  test("text, reasoning, approval, question, sources and attachment all pass through it", () => {
    const secret = "tskey-auth-FIXTURE-SECRET";
    expect(redactBlock({ kind: "text", markdown: `the key is ${secret}` })).toEqual({
      kind: "text",
      markdown: `the key is ${REDACTED}`,
    });
    expect(redactBlock({ kind: "reasoning", text: secret, duration_ms: 1, tokens: 2 })).toEqual({
      kind: "reasoning",
      text: REDACTED,
      duration_ms: 1,
      tokens: 2,
    });
    expect(
      redactBlock({
        kind: "approval",
        tool: "bash",
        summary: `run with ${secret}`,
        detail: secret,
        expires_at: null,
      }),
    ).toEqual({
      kind: "approval",
      tool: "bash",
      summary: `run with ${REDACTED}`,
      detail: REDACTED,
      expires_at: null,
    });
    expect(redactBlock({ kind: "question", prompt: secret, choices: [secret, "no"] })).toEqual({
      kind: "question",
      prompt: REDACTED,
      choices: [REDACTED, "no"],
    });
    expect(
      redactBlock({
        kind: "sources",
        items: [{ title: "t", href: `https://x.test/?token=${secret}`, snippet: secret }],
      }),
    ).toEqual({
      kind: "sources",
      // A signed URL carries its credential in the query string.
      items: [{ title: "t", href: `https://x.test/?token=${REDACTED}`, snippet: REDACTED }],
    });
    expect(
      redactBlock({
        kind: "attachment",
        name: "log.txt",
        mime: "text/plain",
        bytes: 12,
        href: `/files/log.txt?sig=${secret}`,
      }),
    ).toEqual({
      kind: "attachment",
      name: "log.txt",
      mime: "text/plain",
      bytes: 12,
      href: `/files/log.txt?sig=${REDACTED}`,
    });
  });

  test("a hermetic card is a ref and survives intact", () => {
    expect(redactBlock({ kind: "hermetic", card: "agent", ref: "ember" })).toEqual({
      kind: "hermetic",
      card: "agent",
      ref: "ember",
    });
  });
});

/* ── messages and frames ──────────────────────────────────────────────────── */

describe("chat-redact · messages and frames", () => {
  test("a message's blocks and its error string are both walked", () => {
    const message: ChatMessage = {
      id: "m1",
      session: "e2b4cc2c",
      role: "bot",
      author: null,
      at: "2026-09-16T19:48:41.000Z",
      blocks: [{ kind: "text", markdown: "sk-or-v1-FIXTURE-PROVIDER-KEY" }],
      usage: { input_tokens: 1, output_tokens: 2, cost_usd: null, model: "m" },
      error: "provider refused sk-ant-api03-FIXTUREVALUE",
      incomplete: null,
    };
    const out = redactMessage(message);
    expect(out.blocks).toEqual([{ kind: "text", markdown: REDACTED }]);
    expect(out.error).toBe(`provider refused ${REDACTED}`);
    expect(out.usage).toEqual(message.usage);
  });

  test("every frame type: block and delta and error are walked, done is not", () => {
    expect(
      redactFrame({
        type: "block",
        seq: 1,
        message: "m1",
        block: { kind: "text", markdown: "tskey-auth-FIXTURE-SECRET" },
      }),
    ).toEqual({
      type: "block",
      seq: 1,
      message: "m1",
      block: { kind: "text", markdown: REDACTED },
    });

    // The one that actually matters at speed: a secret pasted into a prompt
    // comes back token by token, and a delta is the smallest thing on the wire.
    expect(
      redactFrame({ type: "delta", seq: 2, message: "m1", text: "use tskey-auth-FIXTURE-SECRET" }),
    ).toEqual({ type: "delta", seq: 2, message: "m1", text: `use ${REDACTED}` });

    expect(
      redactFrame({ type: "error", code: "CHAT_PROTOCOL", message: "sent Bearer FIXTUREBEARER1" }),
    ).toEqual({ type: "error", code: "CHAT_PROTOCOL", message: `sent Bearer ${REDACTED}` });

    const done = {
      type: "done",
      seq: 3,
      message: "m1",
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model: "m" },
      incomplete: null,
    } as const;
    expect(redactFrame(done)).toEqual(done);
  });
});

test("activity and server-request payloads use the transcript redaction boundary", () => {
  const secret = "sk-ant-api03-FIXTUREVALUE";
  const blocks: ChatBlock[] = [
    {
      kind: "activity",
      category: "notice",
      key: secret,
      title: secret,
      detail: secret,
      state: "warning",
      payload: { nested: { api_key: "FIXTURE-VALUE" }, text: secret },
    },
    { kind: "approval", tool: "terminal", summary: secret, payload: { command: secret } },
    {
      kind: "question",
      prompt: secret,
      choices: [secret],
      payload: { question: secret, secret: "FIXTURE-VALUE" },
    },
  ];
  for (const block of blocks) {
    const result = JSON.stringify(redactBlock(block));
    expect(result).not.toContain(secret);
    expect(result).not.toContain("FIXTURE-VALUE");
    expect(result).toContain(REDACTED);
  }
});
