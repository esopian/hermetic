/**
 * A hand-built transcript shaped like the fixture's `sx-kestrel-events`
 * session: one prompt, a bot turn that starts three background processes, then
 * the events they and others produced — a DM reply, a clean build, a failed
 * test run, a burst of routine events, a termination and a subagent batch.
 *
 * The unit and component suites use this rather than the fixture backend so
 * each rule is tested against a shape the test states out loud; the flow test
 * (`flows/process-events.flow.test.tsx`) reads the real seeded session.
 */
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import type { ProcessEventView } from "../src/chat/process-events.ts";

export const T0 = Date.parse("2026-09-29T00:21:02Z");
export const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

export function eventOf(over: Partial<ProcessEventView> = {}): ProcessEventView {
  return {
    kind: "process_event",
    event: "completion",
    outcome: "ok",
    process_id: "proc_000000000000",
    status: "completed normally",
    exit_code: 0,
    command: "true",
    raw: "[IMPORTANT: Background process completed normally (exit code 0).]",
    ...over,
  } as ProcessEventView;
}

export function eventMessage(
  id: string,
  seconds: number,
  over: Partial<ProcessEventView> = {},
): ChatMessageView {
  return {
    id,
    session: "sx-kestrel-events",
    role: "system",
    author: null,
    at: at(seconds),
    blocks: [eventOf(over) as ChatBlockView],
  } as ChatMessageView;
}

function startBlock(n: number, pid: string, command: string): ChatBlockView {
  return {
    kind: "tool",
    tool_id: `call-${n}`,
    name: "terminal",
    status: "ok",
    args: { command, background: true, notify_on_complete: true },
    result: {
      output: "Background process started",
      session_id: pid,
      pid: 4000 + n,
      exit_code: 0,
      error: null,
    },
    render: "terminal",
  } as ChatBlockView;
}

export const PIDS = {
  dm: "proc_f9a9a12fefed",
  build: "proc_3be1c0a4d2e1",
  test: "proc_77aa19b3c5f0",
} as const;

const DM_COMMAND =
  "/usr/local/lib/hermes-agent/venv/bin/python /opt/hermes/skills/bot_mode_dm.py --run-delivery query-file /tmp/dm.txt hermes -p lead-qa chat -c 'Bot Chat' -Q";

const buildOutput = [
  ...Array.from({ length: 41 }, (_, i) => `step ${i + 1}`),
  "Bundled 312 modules in 1.84s",
].join("\n");

const testOutput = [
  ...Array.from({ length: 10 }, (_, i) => `(pass) case ${i + 1}`),
  "(fail) ChatView › process events › collapses a burst",
  " 611 pass",
  " 1 fail",
].join("\n");

/** The whole transcript, in arrival order. */
export function kestrelEvents(): ChatMessageView[] {
  return [
    {
      id: "m-prompt",
      session: "sx-kestrel-events",
      role: "user",
      at: at(0),
      blocks: [
        { kind: "text", markdown: "Ask lead-qa to double-check, then run the build and tests." },
      ],
    } as ChatMessageView,
    {
      id: "m-starts",
      session: "sx-kestrel-events",
      role: "bot",
      at: at(7),
      blocks: [
        startBlock(1, PIDS.dm, DM_COMMAND),
        startBlock(2, PIDS.build, "bun run build"),
        startBlock(3, PIDS.test, "bun test packages/ui"),
        {
          kind: "text",
          markdown: "Asked lead-qa, and started the build and UI tests in the background.",
        },
      ],
    } as ChatMessageView,
    eventMessage("m-dm", 212, {
      process_id: PIDS.dm,
      command: DM_COMMAND,
      output_tail: " ⚠ tirith scanner unavailable\nChecked it: the chrome binary hashes match.",
      output_lines: 2,
      dm: {
        to_profile: "lead-qa",
        reply: "Checked it: the **chrome** binary hashes match.",
        warnings: ["⚠ tirith scanner unavailable"],
      },
      raw: "[IMPORTANT: Background process proc_f9a9a12fefed completed normally (exit code 0).]",
    }),
    {
      id: "m-reply",
      session: "sx-kestrel-events",
      role: "bot",
      at: at(219),
      blocks: [{ kind: "text", markdown: "lead-qa confirms it. Build and tests are still running." }],
    } as ChatMessageView,
    eventMessage("m-build", 257, {
      process_id: PIDS.build,
      command: "bun run build",
      output_tail: buildOutput,
      output_lines: 42,
    }),
    eventMessage("m-test", 298, {
      outcome: "failed",
      process_id: PIDS.test,
      status: "exited",
      exit_code: 1,
      command: "bun test packages/ui",
      output_tail: testOutput,
      output_lines: 13,
    }),
    eventMessage("m-b1", 302, { process_id: "proc_51c0aaaaaaaa", command: "git fetch --prune origin" }),
    eventMessage("m-b2", 303, {
      process_id: "proc_51c1aaaaaaaa",
      command: "du -sh /data/hermes/artifacts",
    }),
    eventMessage("m-b3", 309, { process_id: "proc_51c2aaaaaaaa", command: "docker image prune -f" }),
    eventMessage("m-b4", 338, {
      event: "watch_match",
      outcome: "info",
      process_id: "proc_0d4eaaaaaaaa",
      status: null,
      exit_code: null,
      command: "tail -F /var/log/hermes/gateway.log",
      output_tail: "2026-09-29 00:26:40 ERROR gateway: slack socket closed (1006)",
      output_lines: 1,
      watch: { pattern: "ERROR", suppressed: 2 },
    }),
    {
      id: "m-ack",
      session: "sx-kestrel-events",
      role: "bot",
      at: at(345),
      blocks: [{ kind: "text", markdown: "The UI tests failed; looking now." }],
    } as ChatMessageView,
    eventMessage("m-term", 370, {
      outcome: "terminated",
      process_id: "proc_8080aaaaaaaa",
      status: "terminated by Hermes",
      exit_code: -15,
      signal: "SIGTERM",
      command: "python -m http.server 8080",
    }),
    eventMessage("m-deleg", 448, {
      event: "delegation",
      outcome: "ok",
      process_id: null,
      status: null,
      exit_code: null,
      command: null,
      duration_s: 374,
      delegation: {
        id: "deleg_8e21",
        batch: true,
        status: null,
        total: 3,
        succeeded: 3,
        api_calls: 41,
        tasks: [
          {
            index: 1,
            goal: "Audit chat-soft.css for radius leaks",
            status: "completed",
            ok: true,
            summary: "none",
          },
          {
            index: 2,
            goal: "Find every user-role renderer",
            status: "completed",
            ok: true,
            summary: "three",
          },
          {
            index: 3,
            goal: "Draft parser cases",
            status: "completed",
            ok: true,
            summary: "eleven shapes",
          },
        ],
        error: null,
      },
    }),
  ];
}
