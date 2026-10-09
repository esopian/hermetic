/**
 * The fixture's background-process transcript: `kestrel`'s Bot Chat, where the
 * bot starts three background commands, DMs another bot, and Hermes wakes it
 * with a notice each time one finishes (§9.2).
 *
 * The event rows are not written as blocks. Each is the notice text upstream's
 * formatter would have injected (`tools/process_registry.py`
 * `format_process_notification` / `_format_async_delegation`), run through the
 * same `parseProcessNotice` the history reader uses, so the fixture shows what
 * a real box produces rather than what somebody believed the parser returns.
 *
 * Split out of `fixture-chat-catalog.ts` (AGENTS.md rule 5).
 */
import { parseProcessNotice } from "../../chat/hermes/process-notice.ts";
import { HermeticError } from "../../errors.ts";
import type { ChatBlock, ChatMessage, ProcessEventBlock } from "../../schema/index.ts";
import { at } from "./fixture-chat-roster.ts";

/** The session this transcript is. `fixture-chat-roster.ts` lists it as kestrel's Bot Chat. */
export const KESTREL_EVENTS_SESSION = "sx-kestrel-events";

const SESSION = KESTREL_EVENTS_SESSION;
const KESTREL = { instance: "kestrel", bot: "default" } as const;

/** The three background processes the bot starts in one turn, by Hermes' process id. */
const PROC = {
  dm: "proc_f9a9a12fefed",
  build: "proc_3be1c0a4d2e1",
  tests: "proc_77aa19b3c5f0",
} as const;

/** The DM delivery command line, verbatim from a real box. */
const DM_COMMAND =
  '/usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/tools/bot_mode_dm.py --run-delivery --author \'{"id":"bot:default","name":"hermes","is_bot":true}\' query-file /tmp/hermes-dm-999/dm-dw5rf82j.txt --profile-home /data/hermes/.hermes/profiles/lead-qa hermes -p lead-qa chat --in \'~\' -c \'Bot Chat\' --create-if-missing -Q';

/* ── notice text, in upstream's shapes ────────────────────────────────────── */

/** `format_process_notification`'s completion branch. */
const completion = (id: string, status: string, exit: string, command: string, output: string) =>
  `[IMPORTANT: Background process ${id} ${status} (exit code ${exit}).\nCommand: ${command}\nOutput:\n${output}]`;

const lines = (...rows: string[]): string => rows.join("\n");

/** Forty-odd lines of a build, the way a real tail reads: steps, then the bundle summary. */
const BUILD_OUTPUT = lines(
  "$ bun run typecheck && bun run bundle",
  "$ tsc -b packages/core packages/cli packages/app packages/ui",
  ...[
    "core/schema",
    "core/shared",
    "core/chat",
    "core/backend",
    "core/render",
    "cli/commands",
    "app/handlers",
    "app/rpc",
    "ui/chat",
    "ui/fleet",
    "ui/runs",
    "ui/wizard",
  ].map((pkg) => `[typecheck] ${pkg} ok`),
  "$ bun build packages/ui/src/main.tsx --outdir packages/app/views/main --minify",
  ...[
    ["main", "412.08"],
    ["chat-view", "188.41"],
    ["chat-rail", "61.77"],
    ["fleet-table", "94.12"],
    ["runs-view", "38.90"],
    ["wizard", "72.35"],
    ["inbox", "29.64"],
    ["settings", "44.18"],
    ["markdown", "121.50"],
    ["highlight", "203.93"],
    ["avatars", "12.07"],
    ["vendor-react", "142.66"],
    ["vendor-zod", "58.21"],
  ].map(([chunk, kb]) => `  views/main/${chunk}.js   ${kb} kB`),
  "  views/main/main.css   96.40 kB",
  "  views/main/chat.css   41.12 kB",
  "$ bun build packages/agentd/src/main.ts --compile --target=bun-linux-arm64",
  "  [agentd] compiled hermeticd (58.3 MB)",
  "$ bun run stages:check",
  ...["00-base", "01-tailscale", "02-data-volume", "03-hermes", "04-gateway", "05-browser"].map(
    (stage) => `  stage ${stage}.sh ok`,
  ),
  "  7 files written to packages/app/views/main",
  "Bundled 312 modules in 1.84s",
);

/** A UI test run with one failure, ending on bun's own summary lines. */
const TEST_OUTPUT = lines(
  "bun test v1.3.10",
  "",
  "packages/ui/test/chat/chat-view.test.tsx:",
  ...[
    "renders a user turn",
    "renders a bot turn with tools",
    "pins the scroll while streaming",
    "process events › renders a completion row",
    "process events › renders a failure expanded",
    "process events › renders a DM reply as the other bot",
    "process events › folds a watch match",
  ].map((name, i) => `(pass) ChatView › ${name} [${(1.2 + i * 0.7).toFixed(2)}ms]`),
  "(fail) ChatView › process events › collapses a burst [12.40ms]",
  "",
  "packages/ui/test/chat/chat-rail.test.tsx:",
  ...[
    "lists bots by section",
    "shows the preview of the canonical session",
    "never labels an event as You",
    "marks an unreachable box offline",
    "sorts by last message",
  ].map((name, i) => `(pass) ChatRail › ${name} [${(0.9 + i * 0.4).toFixed(2)}ms]`),
  "",
  "packages/ui/test/flows/chat.flow.test.tsx:",
  ...[
    "opens kestrel's Bot Chat",
    "sends and streams a reply",
    "reconciles an observed message",
    "shows the redaction mask",
    "filters to failures only",
  ].map((name, i) => `(pass) chat flow › ${name} [${(22.5 + i * 3.1).toFixed(2)}ms]`),
  "",
  "# Unhandled failure in: ChatView › process events › collapses a burst",
  "",
  "      expect(rows).toHaveLength(3);",
  "      error: expect(received).toBe(expected)",
  "",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 3",
  "Received: 4",
  "",
  "      at <anonymous> (packages/ui/test/chat/chat-view.test.tsx:412:22)",
  "",
  "611 pass",
  "1 fail",
);

const NOTICES = {
  dm: completion(
    PROC.dm,
    "completed normally",
    "0",
    DM_COMMAND,
    lines(
      " ⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only",
      'Checked its "byte-identical" claim since it was new evidence. Holds where it matters: the `chrome` binary hashes match exactly (839efe5f...), so the store build is the /opt/hermetic build.',
    ),
  ),
  build: completion(PROC.build, "completed normally", "0", "bun run build", `${BUILD_OUTPUT}\n`),
  tests: completion(PROC.tests, "exited", "1", "bun test packages/ui", `${TEST_OUTPUT}\n`),
  fetch: completion(
    "proc_1c0ffee2a9d4",
    "completed normally",
    "0",
    "git fetch --prune origin",
    lines(
      "From github.com:fixture/hermetic",
      " - [deleted]         (none)     -> origin/claude/chat-soft-radius",
      "   a14d439..06dda5d  master     -> origin/master",
    ),
  ),
  du: completion(
    "proc_5a7de0b1c3f2",
    "completed normally",
    "0",
    "du -sh /data/hermes/artifacts",
    "1.9G\t/data/hermes/artifacts",
  ),
  prune: completion(
    "proc_9e4b2d6f0a81",
    "completed normally",
    "0",
    "docker image prune -f",
    lines(
      "Deleted Images:",
      "deleted: sha256:4f1e0c2b9a7d",
      "deleted: sha256:b83a51c06e2f",
      "",
      "Total reclaimed space: 412.3MB",
    ),
  ),
  watch: lines(
    '[IMPORTANT: Background process proc_c4a1e7f3b920 matched watch pattern "ERROR".',
    "Command: tail -F /var/log/hermes/gateway.log",
    "Matched output:",
    "2026-09-29 00:26:40 ERROR gateway: slack socket closed (1006), reconnecting in 5s",
    "(2 earlier matches were suppressed by rate limit)]",
  ),
  server: completion(
    "proc_2d8f6b4e1a07",
    "terminated by Hermes",
    "-15, SIGTERM",
    "python -m http.server 8080",
    lines(
      "Serving HTTP on 0.0.0.0 port 8080 (http://0.0.0.0:8080/) ...",
      '127.0.0.1 - - [29/Sep/2026 00:25:12] "GET /report.html HTTP/1.1" 200 -',
    ),
  ),
  delegation: lines(
    "[ASYNC DELEGATION BATCH COMPLETE — deleg_8e21c4f7a0b3]",
    "A background fan-out of 3 subagent(s) you dispatched earlier has finished. All ran in parallel and waited on each other; their consolidated results are below. You may have moved on since dispatching — act on these or re-dispatch if things have changed.",
    "",
    "Dispatched: 2026-09-29 00:21:40 (6m ago)",
    "Toolsets: terminal, file",
    "Role: leaf   Model: claude-sonnet-5   Total duration: 381.4s",
    "",
    "--- ✓ TASK 1/3: Audit chat-soft.css for radius leaks  (status=completed, api_calls=6, 142.8s) ---",
    "Two leaks: .ch-event-row and .ch-burst both hardcode 6px instead of var(--radius-sm). Nothing else in the file bypasses the token.",
    "",
    "--- ✓ TASK 2/3: Find every user-role renderer  (status=completed, api_calls=9, 381.4s) ---",
    'Three: MessageRow (chat-view.tsx), RailPreview (chat-rail.tsx) and the inbox title builder (inbox.tsx). All three read role === "user" as "You".',
    "",
    "--- ✓ TASK 3/3: Draft parser cases  (status=completed, api_calls=4, 97.0s) ---",
    "Drafted 19 cases: one per formatter branch, three negatives, and the DM example.",
  ),
} as const;

/** The block for a notice, failing loudly if the parser stops recognising it. */
function event(text: string): ProcessEventBlock {
  const block = parseProcessNotice(text);
  if (!block)
    throw new HermeticError("CHAT_PROTOCOL", `fixture notice no longer parses: ${text.slice(0, 60)}`);
  return block;
}

/** A system row carrying one parsed notice, the shape `mapHistory` gives one. */
function eventRow(n: number, time: string, notice: string): ChatMessage {
  return {
    id: `mx-kestrel-events-${n}`,
    session: SESSION,
    role: "system",
    author: null,
    at: at(time),
    blocks: [event(notice)],
    usage: null,
    error: null,
    incomplete: null,
  };
}

/** Upstream's `terminal` tool, started with `background: true` (`tools/terminal_tool.py`). */
function backgroundTool(n: number, command: string, sessionId: string, pid: number): ChatBlock {
  return {
    kind: "tool",
    tool_id: `tl-fixture-${String(n).padStart(4, "0")}`,
    name: "terminal",
    server: null,
    args: { command, background: true, notify_on_complete: true },
    result: {
      output: "Background process started",
      session_id: sessionId,
      pid,
      exit_code: 0,
      error: null,
    },
    status: "ok",
    exit_code: 0,
    duration_ms: 41,
    render: "terminal",
  };
}

const text = (markdown: string): ChatBlock => ({ kind: "text", markdown });

/**
 * The transcript, in the order a box would have written it: the operator's
 * request, the turn that starts three background commands, then the notices
 * as each finishes — interleaved with the bot's reply to the DM, and ending on
 * a burst of four with no turn between them.
 */
export const KESTREL_EVENTS_TRANSCRIPT: readonly ChatMessage[] = [
  {
    id: "mx-kestrel-events-1",
    session: SESSION,
    role: "user",
    author: null,
    at: at("00:21:04"),
    blocks: [
      text(
        "lead-qa said the Playwright store build is byte-identical to /opt/hermetic. Get them to double-check it, then run the build and tests again.",
      ),
    ],
    usage: null,
    error: null,
    incomplete: null,
  },
  {
    id: "mx-kestrel-events-2",
    session: SESSION,
    role: "bot",
    author: KESTREL,
    at: at("00:21:31"),
    blocks: [
      backgroundTool(14, DM_COMMAND, PROC.dm, 48_211),
      backgroundTool(15, "bun run build", PROC.build, 48_236),
      backgroundTool(16, "bun test packages/ui", PROC.tests, 48_249),
      text(
        "Asked lead-qa to check the byte-identical claim, and started the build and UI tests in the background. I'll post the results as they come in.",
      ),
    ],
    usage: { input_tokens: 9_840, output_tokens: 312, cost_usd: 0.0081, model: "claude-sonnet-5" },
    error: null,
    incomplete: null,
  },
  eventRow(3, "00:22:18", NOTICES.dm),
  {
    id: "mx-kestrel-events-4",
    session: SESSION,
    role: "bot",
    author: KESTREL,
    at: at("00:22:40"),
    blocks: [
      text(
        "lead-qa confirms it: the chrome binary is identical. Only two package manifests differ, and neither is used at runtime. Nothing to correct in the wiki. Build and tests are still running.",
      ),
    ],
    usage: { input_tokens: 10_420, output_tokens: 58, cost_usd: 0.0034, model: "claude-sonnet-5" },
    error: null,
    incomplete: null,
  },
  eventRow(5, "00:23:52", NOTICES.build),
  eventRow(6, "00:24:30", NOTICES.tests),
  eventRow(7, "00:26:36", NOTICES.fetch),
  eventRow(8, "00:26:38", NOTICES.du),
  eventRow(9, "00:26:40", NOTICES.prune),
  eventRow(10, "00:26:41", NOTICES.watch),
  eventRow(11, "00:27:10", NOTICES.server),
  eventRow(12, "00:28:02", NOTICES.delegation),
];
