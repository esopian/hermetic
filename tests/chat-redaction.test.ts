/**
 * The redaction seam (§9.2): what the box says against what the app
 * hands the page.
 *
 * It lives here rather than in either package because it is the one assertion
 * neither side can make alone. `packages/core` owns the redaction door —
 * `chat-redact.ts`, applied by `chat.ts` to everything leaving it — and
 * `packages/app` owns what crosses the bridge, because a frame is only a leak
 * once it has been serialized and handed to the webview. Core may not import
 * the app, and the app's own tests reach the chat surface only through the
 * `Hermetic` interface, so there is nowhere inside either package that a fake
 * box and a real handler can be held in one hand.
 *
 * §9.2 says redaction happens "in core, before the head sees it — not in the
 * renderer, where a new block type would silently bypass it". That sentence is
 * a claim about a *path*, and the unit tests at either end of it cannot check a
 * path: `chat-redact.test.ts` proves the masker masks and `app.test.ts` proves
 * the handlers answer, and both of them pass whether or not the two are wired
 * to each other. What neither can see is a field the masker never visits
 * because the surface above it rebuilt the object, or a frame the handler
 * builds from something other than what core returned. So this test drives a
 * transcript from a faked box through `chat.swarms` / `chat.sessions` /
 * `chat.history` / `chat.send` and greps the **serialized** answers and stream
 * frames — not parsed objects, because a parsed object is read field by field
 * by somebody who has already decided which fields matter, and the leak that
 * gets shipped is always in the field nobody thought to check.
 *
 * The HTTP head is gone, so there is no `data:` line to read any more. What
 * replaced it is what the bridge actually carries: a handler's
 * resolved value, and every frame it pushed to its `StreamSink`, each run
 * through `JSON.stringify` — which is the serialization step Electrobun
 * performs itself before the page sees anything. Grepping the structure after
 * stringifying it is the same assertion the `data:` lines were; grepping the
 * objects before would not be.
 *
 * The app's own log is grepped alongside them, for the same reason and in the
 * same string: `portal.log`/the app log records every failed request with its
 * message, an upstream error message is the one chat value that is *composed*
 * rather than passed through, and a secret on disk is a leak whether or not a
 * page ever rendered it.
 *
 * Two structural rules the fixtures below follow, both load-bearing:
 *
 * - **The secrets are planted where they hide, not where they are convenient.**
 *   A tool call's `args`, its `result` and an `unknown` block's `payload` are
 *   the three fields typed `unknown` in `schema/chat.ts`, so no schema walk
 *   reaches into them; a session `title` is generated from the first thing said
 *   in the session, so a pasted key lands there before it lands anywhere else;
 *   an attachment `name` is a filename the box chose, and boxes name dumps
 *   after what is in them. Each of those gets one, and several are nested
 *   inside an array inside an object.
 *
 * - **There is a positive control.** A grep for absence passes trivially
 *   against a transcript that never carried the secret, so one test below
 *   asserts that the *unredacted* fixtures really do contain every sentinel.
 *   Without it this whole file would go green the day somebody simplifies a
 *   fixture, and would go on reporting that nothing leaks.
 *
 * Nothing here touches a network, and nothing here is a transport: requests go
 * straight into `dispatch`, which is the one function `rpc/bind.ts` hands every
 * request off to. The box is a hand-written `HermesChatClient` injected into
 * `createChat` — the seam the Phase 5 contract exists to make fakeable — and
 * every value planted in it is a `FIXTURE` sentinel.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryInstanceListeningStore } from "../packages/core/src/chat/instance-listening.ts";
import { createChat } from "../packages/core/src/chat/chat.ts";
import { REDACTED, SECRET_PATTERNS } from "../packages/core/src/chat/chat-redact.ts";
import type { HermesChatClient } from "../packages/core/src/chat/hermes/hermes-chat.ts";
import { openHermetic } from "../packages/core/src/open.ts";
import type { Hermetic } from "../packages/core/src/hermetic.ts";
import {
  FIXTURE_BWS_TOKEN,
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_KEY,
  FIXTURE_SHARED_NOUS_KEY,
  FIXTURE_TS_KEY,
  MemoryBackend,
  seedFixtureFleet,
} from "../packages/core/src/backend/memory.ts";
import type { StackInfo } from "../packages/core/src/backend/types.ts";
import type {
  Agent,
  ChatFrame,
  ChatMessage,
  Session,
  Swarm,
} from "../packages/core/src/schema/index.ts";
import { createChatOwner, type ChatOwner } from "../packages/app/src/chat-owner.ts";
import type { HandlerContext } from "../packages/app/src/handlers/ctx.ts";
import { dispatch } from "../packages/app/src/handlers/dispatch.ts";
import {
  createStreamRegistry,
  KEEPALIVE_EVENT,
  type StreamFrame,
} from "../packages/app/src/handlers/streams.ts";
import { memoryLog } from "../packages/app/src/log.ts";
import { OpRegistry } from "../packages/app/src/ops.ts";
import { AppState, fixedInstance } from "../packages/app/src/state.ts";

/* ── the sentinels ────────────────────────────────────────────────────────── */

/**
 * One planted secret.
 *
 * `text` is what goes into the transcript and `value` is what must not come out
 * of it, and the two differ for every pattern that masks only part of its
 * match: `Bearer <token>` keeps the word `Bearer`, `api_key="…"` keeps the key
 * and the quotes, because a transcript reduced to `[redacted]` is useless for
 * the debugging it exists for. The assertion is therefore always about the
 * *value*, never about the line it sat on.
 *
 * `family` names the `SECRET_PATTERNS` entry the value is expected to trip.
 */
interface Sentinel {
  readonly id: string;
  readonly family: string;
  readonly text: string;
  readonly value: string;
}

/** Exactly forty characters of the AWS secret-key alphabet, all of them fixture. */
const AWS_SECRET = "FIXTUREAWSSECRETFIXTUREAWSSECRETFIXTUREA";
/** Sixteen upper-case characters after `AKIA`, which is what makes it self-identifying. */
const AWS_KEY_ID = "AKIAFIXTUREFIXTURE00";
const PEM_BODY = "FIXTUREPEMBODYFIXTUREPEMBODY";
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;
const JWT = "eyJFIXTUREHEADER.eyJFIXTUREPAYLOAD.FIXTURESIGNATURE";

/**
 * One instance of every `SECRET_PATTERNS` family, plus the `FIXTURE` sentinels
 * this repository already defines for the credentials that travel through the
 * rest of hermetic (`memory-fixture.ts`, grepped for by `secrets-leak.test.ts`).
 *
 * The coverage test below fails if a pattern is added without a sentinel, so
 * this list cannot quietly fall behind the thing it is testing — which is the
 * failure mode a hand-kept list of examples always has.
 */
const SENTINELS: readonly Sentinel[] = [
  { id: "pem-private-key", family: "pem-private-key", text: PEM, value: PEM_BODY },
  { id: "tailscale-auth-key", family: "tailscale-key", text: FIXTURE_TS_KEY, value: FIXTURE_TS_KEY },
  {
    id: "tailscale-oauth-secret",
    family: "tailscale-key",
    text: "tskey-client-FIXTURE-OAUTH",
    value: "tskey-client-FIXTURE-OAUTH",
  },
  { id: "aws-access-key-id", family: "aws-access-key-id", text: AWS_KEY_ID, value: AWS_KEY_ID },
  {
    id: "aws-secret-access-key",
    family: "aws-secret-access-key",
    text: `aws_secret_access_key = ${AWS_SECRET}`,
    value: AWS_SECRET,
  },
  {
    id: "anthropic-key",
    family: "anthropic-key",
    text: "sk-ant-FIXTUREANTHROPICKEY",
    value: "sk-ant-FIXTUREANTHROPICKEY",
  },
  {
    id: "openrouter-key",
    family: "openrouter-key",
    text: "sk-or-v1-FIXTUREOPENROUTERKEY",
    value: "sk-or-v1-FIXTUREOPENROUTERKEY",
  },
  {
    id: "stripe-key",
    family: "stripe-key",
    text: "sk_live_FIXTURESTRIPE0000",
    value: "sk_live_FIXTURESTRIPE0000",
  },
  {
    id: "openai-key",
    family: "openai-key",
    text: "sk-proj-FIXTUREOPENAIKEY",
    value: "sk-proj-FIXTUREOPENAIKEY",
  },
  // The two `sk-`-shaped values the fixture fleet itself holds (§8.3): a
  // provider profile's credential and the fleet's shared slot. Neither is an
  // OpenAI key; both are caught by the `sk-` family, which is the point of
  // planting them rather than inventing a third shape.
  { id: "profile-key", family: "openai-key", text: FIXTURE_PROFILE_KEY, value: FIXTURE_PROFILE_KEY },
  {
    id: "shared-nous-key",
    family: "openai-key",
    text: FIXTURE_SHARED_NOUS_KEY,
    value: FIXTURE_SHARED_NOUS_KEY,
  },
  {
    id: "github-token",
    family: "github-token",
    text: "ghp_FIXTUREGITHUBTOKEN0000",
    value: "ghp_FIXTUREGITHUBTOKEN0000",
  },
  {
    id: "slack-token",
    family: "slack-token",
    text: "xoxb-FIXTURESLACKTOKEN",
    value: "xoxb-FIXTURESLACKTOKEN",
  },
  {
    id: "google-api-key",
    family: "google-api-key",
    text: "AIzaFIXTUREFIXTUREFIXTUREFIXTUREFIX",
    value: "AIzaFIXTUREFIXTUREFIXTUREFIXTUREFIX",
  },
  {
    id: "npm-token",
    family: "npm-token",
    text: "npm_FIXTUREFIXTUREFIXTURE",
    value: "npm_FIXTUREFIXTUREFIXTURE",
  },
  {
    id: "sendgrid-key",
    family: "sendgrid-key",
    text: "SG.FIXTUREFIXTU.FIXTUREFIXTU",
    value: "SG.FIXTUREFIXTU.FIXTUREFIXTU",
  },
  { id: "jwt", family: "jwt", text: JWT, value: JWT },
  {
    id: "bearer-token",
    family: "bearer-token",
    text: "Bearer FIXTURE-BEARER-TOKEN",
    value: "FIXTURE-BEARER-TOKEN",
  },
  {
    id: "assignment-double-quoted",
    family: "assignment-double-quoted",
    text: '{"api_key": "FIXTURE-DOUBLE-VALUE"}',
    value: "FIXTURE-DOUBLE-VALUE",
  },
  {
    id: "assignment-single-quoted",
    family: "assignment-single-quoted",
    text: "password='FIXTURE-SINGLE-VALUE'",
    value: "FIXTURE-SINGLE-VALUE",
  },
  {
    id: "assignment-bare",
    family: "assignment-bare",
    text: "HERMES_PASSWORD=FIXTURE-BARE-VALUE",
    value: "FIXTURE-BARE-VALUE",
  },
  /**
   * The Bitwarden Secrets Manager access token. hermetic pushes one to every
   * box, so an agent printing it is an ordinary event rather than an exotic
   * one, and this repository already treats the value as a secret elsewhere
   * (`FIXTURE_BWS_TOKEN`, grepped for by `secrets-leak.test.ts`).
   *
   * It had no `SECRET_PATTERNS` family when this test was written, and the
   * test was committed red to say so: a bare paste reached the SSE bytes. The
   * family exists now and the two shapes below assert both halves of it.
   */
  {
    id: "bitwarden-token",
    family: "bitwarden-token",
    text: FIXTURE_BWS_TOKEN,
    value: FIXTURE_BWS_TOKEN,
  },
];

/**
 * The same token in the shape an `env` dump produces, kept separate from the
 * bare paste above because the two reach the masker by different routes: this
 * one matches the assignment family on the key name alone and would still be
 * caught if the vendor pattern were deleted, while the bare paste has nothing
 * but its own prefix to recognise it by. Asserted separately so a failure says
 * which of the two broke.
 */
const BWS_NAMED = `BWS_ACCESS_TOKEN=${FIXTURE_BWS_TOKEN}`;

/** The planted form of a sentinel. Throws rather than planting `undefined`. */
function s(id: string): string {
  return sentinel(id).text;
}

/** The substring that must not survive. */
function v(id: string): string {
  return sentinel(id).value;
}

function sentinel(id: string): Sentinel {
  const found = SENTINELS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no sentinel named ${id}`);
  return found;
}

/* ── the transcript ───────────────────────────────────────────────────────── */

const AT = "2026-09-17T09:00:00.000Z";
const SESSION = "ses-redaction";

/**
 * One instance's roster, with a secret in every free-text field a bot can
 * influence.
 *
 * A roster looks like metadata and is not. Hermes takes a bot's title and
 * description from its profile, which is a file on the box that the agent
 * itself can write; a section is an operator's label; a room name comes from
 * whoever opened the room. None of those is a block, so `redactBlock`'s
 * exhaustive switch never sees them — they are covered only by the structural
 * walk `chat.ts` runs over the whole `Swarm`, and this fixture is what proves
 * that walk is still there.
 */
function poisonedSwarm(instance: string): Swarm {
  return {
    instance,
    reachable: true,
    unreachable_reason: null,
    bots: [
      {
        instance,
        name: "default",
        title: `Bot Chat ${s("shared-nous-key")}`,
        description: `notes: ${s("assignment-bare")}`,
        is_default: true,
        model: "claude-sonnet-4-6",
        section: `Clients ${s("slack-token")}`,
        avatar_seed: `fxtr0001/${instance}/default`,
        last_message_at: AT,
        unread: 0,
        needs_action: false,
        muted: false,
        warm: true,
      },
    ],
    rooms: [
      {
        id: "room-1",
        name: `standup ${s("github-token")}`,
        instance,
        members: [{ instance, bot: "default" }],
        round: null,
        needs_action: false,
      },
    ],
    warm_slots: { used: 1, total: 3 },
    sections: [`Clients ${s("tailscale-oauth-secret")}`],
  };
}

/**
 * A conversation list whose title is a paste.
 *
 * This is the case §9.2 calls out by name. Hermes titles a session from the
 * user's first message, so the very first thing an operator does with a key
 * they are debugging — paste it and ask about it — makes that key the session's
 * display name, which then sits in the rail of every portal window open on the
 * fleet, without anybody opening the conversation.
 */
function poisonedSessions(instance: string): Session[] {
  return [
    {
      id: SESSION,
      instance,
      bot: "default",
      kind: "canonical",
      origin: "portal",
      origin_detail: `pasted from ${s("assignment-single-quoted")}`,
      title: `why does ${s("tailscale-auth-key")} not work`,
      last_message_at: AT,
      unread: 0,
      turn_count: 2,
    },
  ];
}

/**
 * The transcript, one block kind at a time.
 *
 * Every kind in `CHAT_BLOCK_KINDS` is represented, because `redactBlock` is an
 * exhaustive switch and a kind that was handled there but dropped by whatever
 * rebuilds the message on the way out would be invisible to a test that only
 * ever sends `text`. The nesting in the `tool` and `unknown` blocks is
 * deliberate: an object holding an array holding an object, which is the shape
 * a real tool result has and the shape a field-by-field redactor misses.
 */
function poisonedHistory(instance: string): ChatMessage[] {
  return [
    {
      id: "msg-1",
      session: SESSION,
      role: "user",
      author: null,
      at: AT,
      blocks: [
        {
          kind: "text",
          markdown: [
            `here is the key that fails: ${s("anthropic-key")}`,
            // Planted bare, with nothing naming it, which is how a paste
            // actually arrives.
            `and the vault token too: ${FIXTURE_BWS_TOKEN}`,
          ].join("\n"),
        },
      ],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "msg-2",
      session: SESSION,
      role: "bot",
      author: { instance, bot: "default" },
      at: AT,
      blocks: [
        {
          kind: "reasoning",
          text: `the config says ${s("assignment-double-quoted")}`,
          duration_ms: 12,
          tokens: 9,
        },
        {
          kind: "tool",
          name: "shell",
          server: null,
          // An array inside an object inside an object: three levels down, in a
          // field typed `unknown`, which is as far out of reach of a schema
          // walk as anything in this repository gets.
          args: {
            command: "env",
            env: {
              vars: [
                { name: "AWS_ACCESS_KEY_ID", line: s("aws-access-key-id") },
                { name: "BWS_ACCESS_TOKEN", line: BWS_NAMED },
                { name: "STRIPE_KEY", line: s("stripe-key") },
              ],
            },
            // A credential under a structured key rather than inside a string:
            // the shape an MCP tool call has when the model passes a profile's
            // key straight through.
            api_key: s("profile-key"),
          },
          result: {
            stdout: `${s("aws-secret-access-key")}\n`,
            files: [{ path: "id_rsa", contents: s("pem-private-key") }],
            logs: [s("npm-token"), s("sendgrid-key")],
          },
          status: "ok",
          exit_code: 0,
          duration_ms: 40,
          render: "terminal",
        },
        {
          kind: "attachment",
          name: `creds-${s("tailscale-oauth-secret")}.txt`,
          mime: "text/plain",
          bytes: 128,
          // A signed URL the box minted: the credential is in the query string,
          // which is why `href` is walked and not only `name`.
          href: `https://box.example.ts.net/files/1?sig=${s("jwt")}`,
        },
        {
          kind: "approval",
          tool: "shell",
          summary: "run a command that needs a token",
          detail: `curl -H "Authorization: ${s("bearer-token")}" https://api.example.com`,
          expires_at: null,
        },
        {
          kind: "question",
          prompt: `which credential should I use, ${s("google-api-key")}?`,
          choices: [s("assignment-bare"), "neither"],
        },
        {
          kind: "sources",
          items: [
            {
              title: "runbook: rotating the keys",
              href: `https://example.com/doc?key=${s("openrouter-key")}`,
              snippet: `it says ${s("openai-key")}`,
            },
          ],
        },
        { kind: "hermetic", card: "agent", ref: instance },
        {
          kind: "unknown",
          name: "hermes.some_future_tool",
          // The bypass §9.2 exists to prevent, in its own fixture: a block kind
          // no renderer has ever heard of, carrying secrets three levels down
          // in a payload nothing in this repository models.
          payload: {
            upstream: {
              frames: [{ blob: s("openrouter-key") }, { blob: s("tailscale-auth-key") }],
            },
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20, cost_usd: 0.01, model: "claude-sonnet-4-6" },
      // A failure message quotes the request that failed, headers included.
      error: `upstream refused: ${s("assignment-single-quoted")}`,
      incomplete: null,
    },
    {
      // A background-process notice: the command line, its output, a DM reply
      // and a subagent's summary are all the box's words, and `raw` is the whole
      // notice again. Every one of them has to be masked, not just `raw`.
      id: "msg-3",
      session: SESSION,
      role: "system",
      author: null,
      at: AT,
      blocks: [
        {
          kind: "process_event",
          event: "completion",
          outcome: "failed",
          process_id: "proc_0123456789ab",
          status: "exited",
          exit_code: 1,
          signal: null,
          command: `curl -H "Authorization: ${s("bearer-token")}" https://api.example.com`,
          output_tail: `401 for ${s("anthropic-key")}`,
          output_lines: 1,
          duration_s: null,
          message: `retrying with ${s("openai-key")}`,
          watch: { pattern: s("stripe-key"), suppressed: 0 },
          delegation: {
            id: "deleg_1",
            batch: false,
            status: "failed",
            total: 1,
            succeeded: 0,
            api_calls: 1,
            tasks: [
              {
                index: 1,
                goal: `rotate ${s("npm-token")}`,
                status: "failed",
                ok: false,
                summary: `tried ${s("sendgrid-key")}`,
                duration_s: 1,
                api_calls: 1,
              },
            ],
            error: `refused ${s("google-api-key")}`,
          },
          dm: {
            to_profile: "lead-qa",
            reply: `the key is ${s("openrouter-key")}`,
            warnings: [`⚠ scanner saw ${s("jwt")}`],
          },
          raw: `[IMPORTANT: Background process proc_0123456789ab exited (exit code 1).\nCommand: env\nOutput:\n${s("aws-secret-access-key")}]`,
        },
      ],
      usage: null,
      error: null,
      incomplete: null,
    },
  ];
}

/**
 * One live turn.
 *
 * The delta echoes whatever was sent, so the test can prove the round trip: a
 * key typed into the composer comes back down the same socket, and the copy
 * coming back is the one that reaches the DOM.
 */
function poisonedFrames(echo: string): ChatFrame[] {
  return [
    { type: "delta", seq: 0, message: "msg-3", text: `you said: ${echo}` },
    {
      type: "block",
      seq: 1,
      message: "msg-3",
      block: {
        kind: "unknown",
        name: "hermes.some_future_tool",
        payload: { rows: [{ secret: s("anthropic-key") }, { secret: FIXTURE_BWS_TOKEN }] },
      },
    },
    { type: "error", code: "CHAT_UNREACHABLE", message: `gateway said ${s("bearer-token")}` },
  ];
}

/** What the operator types into the composer, secrets and all. */
const COMPOSED = `check ${s("openai-key")} and ${FIXTURE_BWS_TOKEN}`;

/* ── the fake box ─────────────────────────────────────────────────────────── */

/**
 * The whole of the other side. No socket, no `fetch`, no DNS: the Phase 5
 * contract makes `HermesChatClient` the seam precisely so a test can put a
 * transcript on the far end of it and still exercise every line above it.
 */
function fakeBox(over: Partial<HermesChatClient> = {}): HermesChatClient {
  return {
    token: (box) => Promise.resolve(`token-${box.instance}`),
    swarm: (box) => Promise.resolve(poisonedSwarm(box.instance)),
    sessions: (box) => Promise.resolve(poisonedSessions(box.instance)),
    history: (box) => Promise.resolve(poisonedHistory(box.instance)),
    send: (_box, _bot, text) =>
      (async function* () {
        for (const frame of poisonedFrames(text)) yield frame;
      })(),
    abort: () => Promise.resolve(),
    ...over,
  };
}

/* ── the harness ──────────────────────────────────────────────────────────── */

const backend = seedFixtureFleet(new MemoryBackend());
const agents = await backend.store.agents.scan();
const seeded = await backend.store.fleet.get();
if (seeded === null) throw new Error("the fixture seed writes a fleet item");
/** Narrowed once, because `ChatDeps.guardFleet` promises a fleet and not a maybe. */
const fleetItem = seeded;

function agentNamed(name: string): Agent {
  const found = agents.find((agent) => agent.name === name);
  if (found === undefined) throw new Error(`the fixture has no agent ${name}`);
  return found;
}

const INSTANCE = "atlas";
const BOT = "default";
const homes: string[] = [];
const owners: ChatOwner[] = [];
const registries: Array<{ closeAll: () => void }> = [];

/**
 * §4.7: every fleet-scoped mutation names the fleet it means, and `chat.send`
 * is one. Over HTTP this rode in the request body; over the bridge it is a
 * field of the params object, which is the same envelope with no URL around it.
 */
const TARGET = {
  account_id: FIXTURE_CONFIG.account_id,
  region: FIXTURE_CONFIG.region,
  fleet_id: FIXTURE_CONFIG.fleet_id,
};

/** No test may leave a chat owner or a stream reading, whatever it asserted or threw. */
afterEach(async () => {
  for (const registry of registries.splice(0)) registry.closeAll();
  for (const owner of owners.splice(0)) await owner.stop();
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/**
 * The real handlers, over the real chat surface, over a faked box.
 *
 * The `Hermetic` the app is handed is the fixture one with its `chat` property
 * replaced: everything the handler does — validation, the §4.7 guard, the
 * frames it names and pushes — is the shipping code, and only the far end of
 * the adapter is a double. Each harness mints its own `HERMETIC_HOME`, for the
 * reason `app.test.ts` gives: fixture mode keeps no AWS state but it does write
 * a real `hermetic-fixture.db`, and a suite must not read whatever a dev
 * session left in the operator's own.
 */
async function harness(client: HermesChatClient = fakeBox()) {
  const home = mkdtempSync(join(tmpdir(), "hermetic-chat-redaction-"));
  homes.push(home);
  const base = await openHermetic({ fixture: true, home });
  const instanceListening = new MemoryInstanceListeningStore();
  for (const agent of agents) instanceListening.set(fleetItem.fleet_id, agent.name, true);
  const hermetic: Hermetic = {
    ...base,
    chat: createChat({
      // Chat reads neither the config nor the stack; the guard is in the deps
      // to prove it ran, which is what §4.2 is for.
      guardFleet: () =>
        Promise.resolve({ config: FIXTURE_CONFIG, fleet: fleetItem, stack: {} as StackInfo }),
      getAgent: (name: string) => Promise.resolve(agentNamed(name)),
      listAgents: () => Promise.resolve(agents),
      hermes: client,
      instanceListening,
    }),
  };
  const log = memoryLog();
  const state = new AppState({
    fixture: true,
    home,
    reopen: fixedInstance(hermetic),
    hermetic,
    target: { ...TARGET },
  });
  const chatOwner = createChatOwner({ hermetic: () => state.hermetic, log });
  owners.push(chatOwner);
  const streams = createStreamRegistry();
  registries.push(streams);
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => null,
    chatOwner,
    fixture: true,
    opts: { fixture: true, log },
    log,
    streams,
  };
  return { ctx, log };
}

/**
 * One request, as the page would see it: the answer serialized, plus every
 * frame a streaming handler pushed, also serialized.
 *
 * A streaming handler answers `{ stream_id }` immediately and pushes for as
 * long as the turn runs, so the frames are drained until the stream's own
 * `done` settles — the registry's promise, not a timeout, so a turn that keeps
 * talking cannot leave its last frames ungrepped.
 */
async function answerBytes(
  ctx: HandlerContext,
  name: string,
  params: Record<string, unknown> = {},
): Promise<string> {
  const frames: StreamFrame[] = [];
  const answer = await dispatch(ctx, name, params, (frame) => {
    // A keepalive is traffic, not a frame — the same reading SSE gave its
    // `: keepalive` comment.
    if (frame.event !== KEEPALIVE_EVENT) frames.push(frame);
  });
  const stream_id = (answer as { stream_id?: string }).stream_id;
  if (stream_id !== undefined) await ctx.streams.get(stream_id)?.done;
  return [JSON.stringify(answer), ...frames.map((frame) => JSON.stringify(frame))].join("\n");
}

/**
 * Everything the chat requests hand the page, concatenated — plus what the app
 * wrote to its own log while answering them.
 *
 * Serialized and never read field by field, which is the point of the whole
 * file: a secret that survived in a field nobody thought to check is still in
 * the string being grepped.
 */
async function wireBytes(client: HermesChatClient = fakeBox()): Promise<string> {
  const { ctx, log } = await harness(client);
  const bodies = [
    await answerBytes(ctx, "chat.swarms", {}),
    await answerBytes(ctx, "chat.swarms", { instance: INSTANCE }),
    await answerBytes(ctx, "chat.sessions", { instance: INSTANCE, bot: BOT }),
    await answerBytes(ctx, "chat.history", { instance: INSTANCE, bot: BOT }),
    await answerBytes(ctx, "chat.send", {
      instance: INSTANCE,
      bot: BOT,
      message: COMPOSED,
      session: SESSION,
      target: { ...TARGET },
    }),
    // `chat.turn`, the second transport of the same turn (`handlers/chat.ts`).
    // It was the `EventSource` route and is now a request like any other, but
    // it still validates a params object the page built rather than one the
    // guard rewrote, so it is still worth grepping separately.
    await answerBytes(ctx, "chat.turn", {
      instance: INSTANCE,
      bot: BOT,
      message: COMPOSED,
      session: SESSION,
    }),
  ];
  return [...bodies, ...log.lines].join("\n");
}

/** The same fixtures, unredacted, as one string — the positive control. */
function rawBytes(): string {
  return JSON.stringify([
    poisonedSwarm(INSTANCE),
    poisonedSessions(INSTANCE),
    poisonedHistory(INSTANCE),
    poisonedFrames(COMPOSED),
  ]);
}

/* ── the tests ────────────────────────────────────────────────────────────── */

describe("chat redaction, from the box to the wire", () => {
  /**
   * Coverage, both ways round. A `SECRET_PATTERNS` entry with no sentinel is a
   * pattern this file does not actually exercise, and a sentinel naming a
   * family that no longer exists is a stale fixture — either one turns the rest
   * of this file into a test of something narrower than it claims to be.
   */
  test("every secret pattern has a sentinel", () => {
    const families = new Set(SENTINELS.map((planted) => planted.family));
    for (const { name } of SECRET_PATTERNS) {
      expect({ pattern: name, covered: families.has(name) }).toEqual({
        pattern: name,
        covered: true,
      });
    }
    const known = new Set(SECRET_PATTERNS.map((pattern) => pattern.name));
    for (const planted of SENTINELS) {
      expect({ id: planted.id, family: planted.family, known: known.has(planted.family) }).toEqual({
        id: planted.id,
        family: planted.family,
        known: true,
      });
    }
  });

  /**
   * The positive control. Without it the absence greps below would pass against
   * an empty transcript, and this file would report that nothing leaks — which
   * would be true, and would mean nothing.
   */
  test("the fixtures really do carry every sentinel", () => {
    const raw = rawBytes();
    for (const planted of SENTINELS) {
      expect({ id: planted.id, present: raw.includes(planted.value) }).toEqual({
        id: planted.id,
        present: true,
      });
    }
    expect(raw).toInclude(FIXTURE_BWS_TOKEN);
  });

  /**
   * The assertion the whole file is for: the transcript goes in carrying a
   * secret of every recognised family and the bytes come out carrying none of
   * them.
   *
   * The failure names the sentinel, because "a secret leaked" is not an
   * actionable report and "the `aws-secret-access-key` sentinel leaked" is.
   */
  test("no sentinel survives to the wire", async () => {
    const bytes = await wireBytes();
    for (const planted of SENTINELS) {
      expect({ id: planted.id, leaked: bytes.includes(planted.value) }).toEqual({
        id: planted.id,
        leaked: false,
      });
    }
  });

  /**
   * The other half of the same claim. Redaction that ate the transcript would
   * also pass the test above, so the bytes have to show the mask *and* the
   * context it was cut out of: a `Bearer` header still says `Bearer`, an AWS
   * credentials line still names the key it hid, and the prose around a masked
   * paste is still readable.
   */
  test("what is left is masked, not deleted", async () => {
    const bytes = await wireBytes();
    expect(bytes).toInclude(REDACTED);
    expect(bytes).toInclude(`Bearer ${REDACTED}`);
    expect(bytes).toInclude(`aws_secret_access_key = ${REDACTED}`);
    // The session title survives as a title; only the key inside it is gone.
    expect(bytes).toInclude(`why does ${REDACTED} not work`);
    // And the transcript is still a transcript: block kinds, tool names and the
    // surrounding prose are all still there to read.
    expect(bytes).toInclude("hermes.some_future_tool");
    expect(bytes).toInclude("here is the key that fails");
  });

  /**
   * §9.2's named failure mode, on its own, because it is the one a
   * renderer-side implementation gets wrong: a block kind no head has ever
   * heard of, whose `payload` is `unknown` in the schema and therefore reaches
   * the wire without a single field of it having been modelled.
   *
   * Asserted against the turn's stream frames rather than the history answer
   * because the live stream is where an unrecognised block first appears —
   * upstream starts emitting one on a `hermes_ref` bump, and the first person
   * to see it is whoever has a turn in flight.
   */
  test("an unknown block's payload is redacted in the stream", async () => {
    const { ctx } = await harness(
      fakeBox({
        send: () =>
          (async function* () {
            yield {
              type: "block",
              seq: 0,
              message: "msg-9",
              block: {
                kind: "unknown",
                name: "hermes.tool_nobody_has_heard_of",
                payload: { a: [{ b: { c: s("anthropic-key") } }] },
              },
            } as const;
          })(),
      }),
    );
    const bytes = await answerBytes(ctx, "chat.send", {
      instance: INSTANCE,
      bot: BOT,
      message: "hello",
      target: { ...TARGET },
    });
    // The frame is still named by the block's own `type`, so a reader listens
    // for `block` rather than parsing every push to find out what it got.
    expect(bytes).toInclude('"event":"block"');
    // The block still arrives, under its own name, with its shape intact: a
    // version bump may never blank a transcript (`schema/chat.ts`).
    expect(bytes).toInclude("hermes.tool_nobody_has_heard_of");
    expect(bytes).not.toInclude(v("anthropic-key"));
    expect(bytes).toInclude(REDACTED);
  });

  /**
   * A box that cannot be reached is still a box that can leak: the reason it
   * gives is an upstream error string, and upstream error strings quote the
   * request that failed. `chat.swarms` composes that sentence itself rather
   * than passing a `Swarm` through, so it is the one path where redaction is a
   * separate call — and therefore the one most likely to lose it.
   */
  test("an unreachable box's reason is redacted too", async () => {
    const { ctx, log } = await harness(
      fakeBox({ swarm: () => Promise.reject(new Error(`dial failed: ${s("bearer-token")}`)) }),
    );
    const answer = await answerBytes(ctx, "chat.swarms", { instance: INSTANCE });
    const bytes = [answer, ...log.lines].join("\n");
    expect(bytes).toInclude("dial failed");
    expect(bytes).not.toInclude(v("bearer-token"));
    expect(bytes).toInclude(REDACTED);
  });

  /**
   * The Bitwarden token as an `env` dump shows it. This is the shape the
   * assignment patterns exist for, and it holds: the value is masked because
   * the name beside it says what it is.
   */
  test("a named bitwarden token is masked", async () => {
    const bytes = await wireBytes();
    expect(bytes).toInclude(`BWS_ACCESS_TOKEN=${REDACTED}`);
  });

  /**
   * The same token pasted bare into a prompt, which is how it arrives when
   * somebody asks the agent why it does not work — the scenario
   * `chat-redact.ts`'s own header opens with.
   *
   * `FIXTURE_BWS_TOKEN` is a secret this repository defines and greps for
   * (`memory-fixture.ts`, `secrets-leak.test.ts`), and no `SECRET_PATTERNS`
   * family claims it: every pattern recognises a value either by a vendor
   * prefix or by the name assigned to it, and a bare paste has neither. So the
   * value reaches the wire — in the user's own message text, in the block frame
   * that echoes it, and in the delta that streams it back.
   */
  test("a bare bitwarden token does not reach the wire", async () => {
    const bytes = await wireBytes();
    expect(bytes).not.toInclude(FIXTURE_BWS_TOKEN);
  });
});
