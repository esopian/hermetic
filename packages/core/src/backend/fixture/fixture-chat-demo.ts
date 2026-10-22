/**
 * Three fixture turns for block kinds no other trigger produces live, raised
 * by a substring of the prompt the way the request and error scripts are:
 *
 * - `E2E_MARKDOWN` — one reply in rich markdown: headings, emphasis, a list, a
 *   link, a table, a fenced block, a quote and an image. The image names a
 *   canned file on the box (`/files/<id>/content`), so a head that loads box
 *   files shows the picture and any other draws its alt text.
 * - `E2E_PROCESS_EVENT` — a background `terminal` call and the completion
 *   notice Hermes wakes the bot with, parsed by the same `parseProcessNotice`
 *   the history reader runs (`fixture-chat-process-events.ts` seeds a whole
 *   transcript of these; this is one, live).
 * - `E2E_DM` — a Bot Mode `message_agent` call to a teammate and upstream's
 *   `queued` acknowledgement (`fixture-chat-dms.ts` has the seeded exchange).
 *
 * Each is a whole turn materialised up front, like `turn` in
 * `fixture-chat.ts`, and none of them parks.
 */
import { parseProcessNotice } from "../../chat/hermes/process-notice.ts";
import type { ChatBlock, ChatFrame } from "../../schema/index.ts";
import { FIXTURE_CHAT_FILES } from "./fixture-chat-files.ts";
import { usage } from "./fixture-chat-usage.ts";

export const FIXTURE_MARKDOWN_TRIGGER = "E2E_MARKDOWN";
export const FIXTURE_PROCESS_EVENT_TRIGGER = "E2E_PROCESS_EVENT";
export const FIXTURE_DM_TRIGGER = "E2E_DM";

type SequencedFrame = Extract<ChatFrame, { seq: number }>;

/** The rich reply. Each paragraph is one line, as a model writes it. */
export const FIXTURE_MARKDOWN_REPLY = [
  "## Queue depth on granite",
  "",
  "The data volume is **throughput-bound**, not CPU-bound — see the *gp3* [volume types page](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html).",
  "",
  "- the write queue never drops below `4`",
  "- CPU stays under 40% for the whole hour",
  "- nothing in the agent log since the last restart",
  "",
  "| metric | value |",
  "| --- | ---: |",
  "| aqu-sz | 4.02 |",
  "| %util | 99.60 |",
  "",
  "```bash",
  "aws ec2 modify-volume --volume-id vol-fixture00000000012 --throughput 500",
  "```",
  "",
  `![Queue depth over the last hour](/files/${FIXTURE_CHAT_FILES.queueDepth.id}/content)`,
  "",
  "> Nothing in the account was changed.",
].join("\n");

const BUILD_PROC = "proc_5d2e8b1c0a47";
const BUILD_COMMAND = "bun run build && bun test";

/** `format_process_notification`'s completion branch, as upstream writes it. */
const COMPLETION =
  `[IMPORTANT: Background process ${BUILD_PROC} completed normally (exit code 0).\n` +
  `Command: ${BUILD_COMMAND}\n` +
  "Output:\n" +
  "$ bun run build\n" +
  "bundled 214 modules in 1.8s\n" +
  "$ bun test\n" +
  " 1312 pass\n" +
  " 0 fail\n" +
  "Ran 1312 tests across 188 files. [21.40s]]";

/** The teammate the `E2E_DM` turn messages, and its handle. */
const DM_TARGET = "scribe";

/** A turn's frames from seq 1: a string streams as a text block, a block lands whole, then `done`. */
export function* frames(
  message: string,
  blocks: readonly (ChatBlock | string)[],
): Generator<SequencedFrame> {
  let seq = 0;
  for (const piece of blocks) {
    if (typeof piece === "string") {
      yield { type: "block", seq: ++seq, message, block: { kind: "text", markdown: "" } };
      for (let i = 0; i < piece.length; i += 24)
        yield { type: "delta", seq: ++seq, message, text: piece.slice(i, i + 24) };
    } else {
      yield { type: "block", seq: ++seq, message, block: piece };
    }
  }
  yield {
    type: "done",
    seq: ++seq,
    message,
    usage: usage(4_210, 318, 0.0071, "claude-sonnet-5"),
    incomplete: null,
  };
}

function markdownTurn(message: string): SequencedFrame[] {
  return [...frames(message, [FIXTURE_MARKDOWN_REPLY])];
}

function processEventTurn(message: string): SequencedFrame[] {
  const started: ChatBlock = {
    kind: "tool",
    tool_id: "tl-fixture-background",
    name: "terminal",
    server: null,
    args: { command: BUILD_COMMAND, background: true },
    result: JSON.stringify({ output: "Background process started", session_id: BUILD_PROC }),
    status: "ok",
    exit_code: 0,
    duration_ms: 140,
    render: "terminal",
  };
  const event = parseProcessNotice(COMPLETION);
  return [
    ...frames(message, [
      "Started the build and the tests in the background; I will say when they finish.",
      started,
      ...(event ? [event] : []),
      "The build finished cleanly and all 1312 tests pass.",
    ]),
  ];
}

function dmTurn(message: string): SequencedFrame[] {
  const args = { target: DM_TARGET, message: "Can you add the granite fix to tonight's change log?" };
  const call = (status: "running" | "ok", result: unknown): ChatBlock => ({
    kind: "tool",
    tool_id: "tl-fixture-dm",
    name: "message_agent",
    server: null,
    args,
    result,
    status,
    exit_code: null,
    duration_ms: status === "ok" ? 204 : null,
    render: "message_agent",
  });
  return [
    ...frames(message, [
      `Asking @${DM_TARGET} to log the change.`,
      call("running", null),
      call("ok", {
        status: "queued",
        delivery_id: "dm-fixture01",
        to: `@${DM_TARGET}`,
        reply_delivery: "notification",
        detail: `Message queued for @${DM_TARGET}.`,
        process_id: "proc_fixturedm01",
      }),
      "Done — the reply will come back as a notification.",
    ]),
  ];
}

/** The demo turn `prompt` asks for, or null when it names none of the three triggers. */
export function fixtureDemoTurn(prompt: string): ((message: string) => SequencedFrame[]) | null {
  if (prompt.includes(FIXTURE_MARKDOWN_TRIGGER)) return markdownTurn;
  if (prompt.includes(FIXTURE_PROCESS_EVENT_TRIGGER)) return processEventTurn;
  if (prompt.includes(FIXTURE_DM_TRIGGER)) return dmTurn;
  return null;
}
