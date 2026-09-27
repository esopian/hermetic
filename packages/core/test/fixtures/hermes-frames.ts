/**
 * What a Hermes box actually said, kept as test data.
 *
 * Everything under "recorded" below is verbatim from the live probe of the
 * agent box `veronica` on 2026-09-16: one
 * `session.create`, one `prompt.submit`, and the event frames that followed a
 * single turn whose prompt was `Reply with the single word pong and call no
 * tools.` The read-only RPC results are verbatim from the same session.
 *
 * Everything under "reconstructed" is **not** verbatim, and each one says what
 * it was built from. The probe recorded the event types and their counts for
 * that turn but quoted only three frames in full, so the ordering below is a
 * reconstruction consistent with the recorded sequence numbers — `message.delta`
 * at `seq` 6 and 7, `message.complete` at `seq` 10 — and with the frame builder
 * in upstream's `tui_gateway/server.py:2520`, which is what fixes the envelope
 * shape (`{jsonrpc, method:"event", params:{type, session_id, payload, seq}}`).
 *
 * Fixture values only (§11.3). The real session token was a 43-character value
 * that was deliberately never recorded, and nothing here resembles a credential.
 */

/** The session the probe's turn ran in. Verbatim. */
export const SESSION_ID = "e2b4cc2c";

/** The on-disk id upstream returned alongside it. Verbatim. */
export const STORED_SESSION_ID = "20260916_194841_0406a3";

/**
 * A fixture stand-in for `_SESSION_TOKEN`. The real one is minted per dashboard
 * process, lives only in memory, and was held in a shell variable and never
 * printed during the probe.
 */
export const FIXTURE_SESSION_TOKEN = "FIXTURE-HERMES-SESSION-TOKEN";

/**
 * The SPA page the token is scraped out of.
 *
 * Reconstructed: the probe recorded the page as 1719 bytes of SPA HTML with
 * `<title>Hermes Agent - Dashboard</title>`, a single `src="/assets/index-…js"`
 * and four `window.__HERMES_*` globals, of which this reproduces the shape that
 * matters.
 */
export const DASHBOARD_HTML = [
  "<!doctype html><html><head><title>Hermes Agent - Dashboard</title>",
  "<script>",
  'window.__HERMES_AUTH_REQUIRED__=false;window.__HERMES_BASE_PATH__="";',
  "window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=true;",
  `window.__HERMES_SESSION_TOKEN__="${FIXTURE_SESSION_TOKEN}";`,
  "</script>",
  '</head><body><div id="root"></div>',
  '<script type="module" src="/assets/index-DP3DHjhB.js"></script></body></html>',
].join("");

/** The same page from a box in gated/OAuth mode, which injects no token at all. */
export const DASHBOARD_HTML_NO_TOKEN = DASHBOARD_HTML.replace(
  `window.__HERMES_SESSION_TOKEN__="${FIXTURE_SESSION_TOKEN}";`,
  "window.__HERMES_AUTH_REQUIRED__=true;",
);

/* ── recorded: RPC results ────────────────────────────────────────────────── */

/** Verbatim. `session.create` with empty params. */
export const SESSION_CREATE_RESULT = {
  session_id: SESSION_ID,
  stored_session_id: STORED_SESSION_ID,
  message_count: 0,
  messages: [],
  info: {
    model: "deepseek/deepseek-v4.1-flash",
    tools: {},
    skills: {},
    cwd: "/data/hermes/.hermes",
    branch: "",
    project: null,
    lazy: true,
    desktop_contract: 6,
    profile_name: "default",
  },
};

/** Verbatim. What `prompt.submit` answers the instant it is accepted. */
export const PROMPT_SUBMIT_RESULT = { status: "streaming" };

/**
 * Verbatim, from `GET /api/profiles` plus the `bot_mode_protocol` flag the
 * `profiles.list` RPC adds. The probed box was a swarm of one: `default` is
 * `$HERMES_HOME` itself and creates no `profiles/` entry.
 */
export const PROFILES_LIST_RESULT = {
  profiles: [
    {
      name: "default",
      path: "/data/hermes/.hermes",
      is_default: true,
      model: null,
      provider: null,
      has_env: false,
      skill_count: 58,
      gateway_running: true,
      description: "",
      description_auto: false,
      display_name: "",
      distribution_name: null,
      distribution_version: null,
      distribution_source: null,
      has_alias: false,
    },
  ],
  bot_mode_protocol: true,
};

/** Verbatim. No rooms on the probed box. */
export const GROUPS_LIST_RESULT = { rooms: [], next_offset: null };

/** Verbatim. No live bot processes on the probed box. */
export const AGENTS_LIST_RESULT = { processes: [] };

/** Verbatim. No stored sessions on the probed box. */
export const SESSION_LIST_RESULT = { sessions: [] };

/* ── recorded: the three event frames quoted in full ──────────────────────── */

/** Verbatim, including whitespace, as the probe captured it off the wire. */
export const RECORDED_MESSAGE_DELTA_1 =
  '{"jsonrpc": "2.0", "method": "event", "params": {"type": "message.delta", "session_id": "e2b4cc2c", "payload": {"text": "p"}, "seq": 6}}';

/** Verbatim. */
export const RECORDED_MESSAGE_DELTA_2 =
  '{"jsonrpc": "2.0", "method": "event", "params": {"type": "message.delta", "session_id": "e2b4cc2c", "payload": {"text": "ong"}, "seq": 7}}';

/** Verbatim, including the whole usage object upstream ships on completion. */
export const RECORDED_MESSAGE_COMPLETE =
  '{"jsonrpc": "2.0", "method": "event", "params": {"type": "message.complete", "session_id": "e2b4cc2c", "payload": {"text": "pong", "usage": {"model": "deepseek/deepseek-v4.1-flash", "input": 13300, "output": 4, "reasoning": 0, "prompt": 13780, "completion": 4, "total": 13784, "calls": 1, "context_used": 13780, "context_max": 1000000, "context_percent": 1, "compressions": 0, "cache_hit_pct": 3, "avg_latency_s": 1.8, "avg_tps": 2.2, "active_subagents": 0}, "status": "complete"}, "seq": 10}}';

/* ── reconstructed: the rest of that turn ─────────────────────────────────── */

/** The envelope, exactly as `tui_gateway/server.py:2520` builds it. */
export function eventFrame(type: string, seq: number, payload: unknown, session = SESSION_ID): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: session, payload, seq },
  });
}

/**
 * The turn the probe recorded, in full.
 *
 * The three quoted frames are spliced in at their recorded sequence numbers;
 * the other fifteen are reconstructed from the recorded type histogram —
 * `gateway.ready 1 · session.info 2 · message.start 1 · thinking.delta 3 ·
 * message.delta 2 · reasoning.available 1 · message.complete 1 ·
 * session.title 2 · sessions.changed 5` — placed in the only order consistent
 * with the recorded sequence numbers. `thinking.delta`'s payload is verbatim
 * from upstream's callback (`{"text": text}`); `reasoning.available`'s payload
 * shape was never observed, so it is modelled here as a bare availability
 * signal carrying nothing.
 */
export const RECORDED_TURN: readonly string[] = [
  eventFrame("gateway.ready", 1, {}),
  eventFrame("session.info", 2, {
    model: "deepseek/deepseek-v4.1-flash",
    provider: "ai-gateway",
    reasoning_effort: "medium",
    approval_mode: "smart",
    tools: {},
  }),
  eventFrame("thinking.delta", 3, { text: "The user wants " }),
  eventFrame("thinking.delta", 4, { text: "one word and no tools." }),
  eventFrame("message.start", 5, {}),
  RECORDED_MESSAGE_DELTA_1,
  RECORDED_MESSAGE_DELTA_2,
  eventFrame("thinking.delta", 8, { text: " Done." }),
  eventFrame("reasoning.available", 9, {}),
  RECORDED_MESSAGE_COMPLETE,
  eventFrame("session.info", 11, { model: "deepseek/deepseek-v4.1-flash" }),
  eventFrame("session.title", 12, { title: "pong" }),
  eventFrame("session.title", 13, { title: "A one-word reply" }),
  eventFrame("sessions.changed", 14, {}),
  eventFrame("sessions.changed", 15, {}),
  eventFrame("sessions.changed", 16, {}),
  eventFrame("sessions.changed", 17, {}),
  eventFrame("sessions.changed", 18, {}),
];

/**
 * A tool call, reconstructed from `_on_tool_start` / `_on_tool_complete` in
 * `tui_gateway/server.py:7895`. No tool was called during the probe — the one
 * permitted turn asked for none — so the payload keys below come from that
 * source read and not from the wire.
 *
 * The tool is deliberately one this repo has never heard of: `render` must come
 * back null and the block must still carry its name, its arguments and its
 * result, because a `hermes_ref` bump that adds fifty tools must not blank a
 * transcript (§9.2).
 */
export const UNKNOWN_TOOL_START = eventFrame("tool.start", 3, {
  tool_id: "tc_FIXTURE_1",
  name: "frobnicate_widget",
  context: "frobnicate_widget(target=fixture)",
  args: { target: "fixture", depth: 2 },
});

export const UNKNOWN_TOOL_COMPLETE = eventFrame("tool.complete", 4, {
  tool_id: "tc_FIXTURE_1",
  name: "frobnicate_widget",
  args: { target: "fixture", depth: 2 },
  result: "widget frobnicated",
  duration_ms: 812,
});

/**
 * An event type from a Hermes newer than this build — the case §9.2 names
 * explicitly. Nothing recognises it, and it must survive whole.
 */
export const UNKNOWN_EVENT = eventFrame("vault.entry.revealed", 5, {
  entry: "fixture-entry",
  detail: { nested: ["a", "b"] },
});

/**
 * Garbage on the wire, in the three shapes that actually happen: a truncated
 * document, a frame carrying two documents in one, and a blank keepalive line.
 * None of them may end a turn.
 */
export const TRUNCATED_FRAME = '{"jsonrpc": "2.0", "method": "event", "params": {"type": "mes';
export const BLANK_FRAME = "\n   \n";
export const DOUBLE_FRAME = `${eventFrame("message.start", 5, {})}\n${RECORDED_MESSAGE_DELTA_1}`;

/* ── the first turn run against a live 0.21.3 box ──────────────────────────── */

/**
 * The turn that found three bugs no test could have (2026-09-17).
 *
 * Provenance, precisely, because it is not the same as the probe's above. What
 * was captured is the adapter's **output** — the `ChatFrame`s that reached the
 * wire — not the JSON-RPC the box sent. The upstream events below are the
 * reconstruction that produces those frames, and the reconstruction is tight
 * rather than plausible: every observed output frame pins the event that caused
 * it and the `seq` it carried.
 *
 * | Observed output | The event it pins |
 * |---|---|
 * | two frames at `seq: 0` | the adapter's own `chat.status` pair |
 * | `{"kind":"text","markdown":""}` at `seq: 2` | `message.start` at 2, opening a block nothing ever filled |
 * | `{"kind":"reasoning","text":"(⊙_⊙) analyzing..."}` at `seq: 6` | `thinking.delta` before 6, flushed by the event at 6 |
 * | `{"kind":"text","markdown":""}` then `{"type":"delta","text":"pong"}`, both `seq: 6` | `message.delta` at 6 |
 * | `{"kind":"reasoning","text":"pong"}` at `seq: 8` | `reasoning.available` at 8, carrying the *answer* as its `text` |
 * | `{"type":"done","seq":10}` | `message.complete` at 10 |
 *
 * Two things here are the point of keeping it.
 *
 * **The sequence numbers have gaps and repeats.** 0, 0, 2, 6, 6, 6, 8, 10 — the
 * probe's reconstruction above increments one per frame and real traffic does
 * not, and that difference hid a bug downstream where a consumer dropped any
 * frame whose `seq` did not strictly increase. A fixture that is tidier than
 * the wire is a fixture that certifies the wrong thing.
 *
 * **`reasoning.available` carries the message text.** §8.2 recorded that this
 * payload's shape had never been observed. It has now, and what it holds is the
 * answer, not the thinking.
 *
 * The one part not pinned by the capture is the usage object on
 * `message.complete`: the live run's numbers were not recorded, so the probe's
 * are reused. Nothing asserts on them here.
 */
export const LIVE_TURN: readonly string[] = [
  eventFrame("gateway.ready", 1, {}),
  eventFrame("message.start", 2, {}),
  eventFrame("thinking.delta", 3, { text: "(⊙_⊙) " }),
  eventFrame("thinking.delta", 4, { text: "analyzing..." }),
  eventFrame("message.delta", 6, { text: "pong" }),
  eventFrame("reasoning.available", 8, { text: "pong" }),
  eventFrame("message.complete", 10, {
    text: "pong",
    usage: {
      model: "deepseek/deepseek-v4.1-flash",
      input: 13300,
      output: 4,
      reasoning: 0,
      total: 13784,
    },
    status: "complete",
  }),
];

/** What the live turn's genuine thinking said, before anything echoed the answer over it. */
export const LIVE_REASONING = "(⊙_⊙) analyzing...";

/**
 * A hand-built session list that spells the timestamp three different ways.
 *
 * **Not a recording, and not a claim about what a box sends** — see
 * `LIVE_SESSION_LIST` below for that. This one exists to exercise the reader's
 * tolerance: `mapSessions` accepts `last_message_at`, `last_active`,
 * `updated_at`, `started_at` and `mtime`, as a string or as a number, and this
 * fixture spells a different one on each row so that no single spelling carries
 * the whole suite. It also names a profile on some rows and not others, which a
 * real `session.list` never does.
 *
 * It earned that description the hard way. It was originally written as if it
 * *were* a recording, and every spelling in it was wrong: a real row carries
 * `started_at`, a float of Unix seconds, and nothing else resembling a time. The
 * tests that used it passed while the mapper returned null for every real row.
 * Assertions about what a box actually says belong on the capture, not here.
 */
export const SESSION_LIST_POPULATED = {
  sessions: [
    {
      session_id: STORED_SESSION_ID,
      profile: "default",
      title: "A one-word reply",
      message_count: 2,
      updated_at: "2026-09-16T19:48:41.000Z",
    },
    {
      id: "20260917_101500_aa11bb",
      bot: "granite",
      title: "Reviewing the rollout",
      message_count: 8,
      last_message_at: "2026-09-17T10:15:00.000Z",
    },
    {
      id: "20260917_090000_cc22dd",
      bot: "granite",
      title: "An older thread",
      message_count: 3,
      last_message_at: "2026-09-17T09:00:00.000Z",
    },
    {
      // No profile named, and an epoch-seconds `mtime`. A real list names no
      // profile on *any* row; this one keeps a mixture on purpose.
      session_id: "20260917_110000_ee33ff",
      title: "Unattributed",
      message_count: 1,
      mtime: 1789642800,
    },
  ],
};

/* ── the roster, captured verbatim off a live box ──────────────────────────── */

/**
 * `session.list`, `profiles.list`, `agents.list` and `groups.list` as
 * `silent-crane` (Hermes 0.21.3) answered them on 2026-09-17, on a box with two
 * real turns and a browser session behind it.
 *
 * Kept as the capture file rather than transcribed into TypeScript, so it can be
 * diffed byte-for-byte against the probe that produced it. Everything below is a
 * named view onto it and invents nothing.
 *
 * This file exists because the previous fixture did invent something. It spelled
 * a session's timestamp `updated_at` / `last_message_at` / `mtime` — three
 * plausible names, none of them the one a box sends — and the tests that used it
 * passed against a mapper that returned null for every real row. A fixture
 * written from imagination certifies the imagination.
 */
import capture from "./probe-session-list.json";

/**
 * A real session row: `id`, `title`, `preview`, `started_at` (a **float of Unix
 * seconds**), `message_count`, `source`. Note what is *not* here — no profile,
 * no bot, no `updated_at`, no `last_message_at`. A session list cannot attribute
 * itself to a bot, which is why the roster watermark comes from `profiles.list`.
 */
export const LIVE_SESSION_LIST: unknown = capture.id1.result;

/**
 * A real profile row, carrying `last_session.last_active` — "when did this bot
 * last speak", already attributed, in the call the bot list needs anyway.
 */
export const LIVE_PROFILES_LIST: unknown = capture.id2.result;

/** `{"processes": []}` — the key is present and the box simply has none live. */
export const LIVE_AGENTS_LIST: unknown = capture.id3.result;

/** `{"rooms": [], "next_offset": null}` — no rooms, and no further pages. */
export const LIVE_GROUPS_LIST: unknown = capture.id4.result;

/** `last_session.last_active` from the capture, as an ISO instant. */
export const LIVE_BOT_WATERMARK = "2026-09-17T16:41:53.067Z";

/** The newest `started_at` in the captured session list, as an ISO instant. */
export const LIVE_NEWEST_SESSION_START = "2026-09-17T16:41:50.443Z";
