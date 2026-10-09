/**
 * Background-process events in a thread: the pure rules (`process-events.ts`).
 *
 * Bursts, the "failures only" density, the links between a start and its
 * event, and the places an event row must not be counted as the operator.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessageView } from "../src/api/index.ts";
import { turnRows } from "../src/chat/chat-turns.ts";
import {
  backgroundProcessId,
  burstParts,
  eventAnchors,
  fmtSpan,
  highlightParts,
  isProcessEventMessage,
  lastLine,
  outputLines,
  previewText,
  processDomId,
  processStarts,
  searchableText,
  shortProcessId,
  spanMs,
  threadItems,
} from "../src/chat/process-events.ts";
import type { ThreadItem } from "../src/chat/process-events.ts";
import { PIDS, T0, at, eventMessage, eventOf, kestrelEvents } from "./process-event-fixtures.ts";

const NOW = T0 + 3_600_000;

const items = (messages: ChatMessageView[], density: "compact" | "failures" = "compact") =>
  threadItems(turnRows(messages, NOW), density);

/** Each item as a short tag, so a whole thread's shape reads as one line. */
const shape = (list: ThreadItem<ChatMessageView>[]): string[] =>
  list.map((item) =>
    item.kind === "burst"
      ? `burst(${item.entries.map((e) => e.row.message.id).join(",")})`
      : item.kind === "event"
        ? `event(${item.row.message.id})`
        : `turn(${item.row.message.id})`,
  );

describe("bursts", () => {
  test("routine events with no turn between them fold into one row; failures and DM replies do not", () => {
    expect(shape(items(kestrelEvents()))).toEqual([
      "turn(m-prompt)",
      "turn(m-starts)",
      "event(m-dm)",
      "turn(m-reply)",
      // One routine event alone keeps its own row, and the failure after it
      // breaks the run rather than joining it.
      "event(m-build)",
      "event(m-test)",
      "burst(m-b1,m-b2,m-b3,m-b4)",
      "turn(m-ack)",
      "event(m-term)",
      "event(m-deleg)",
    ]);
  });

  test("a failure between two routine events splits them into two single rows", () => {
    const list = items([
      eventMessage("a", 1),
      eventMessage("b", 2, { outcome: "failed", exit_code: 2, status: "exited" }),
      eventMessage("c", 3),
    ]);
    expect(shape(list)).toEqual(["event(a)", "event(b)", "event(c)"]);
  });

  test("a delegation result and a DM reply always get their own row", () => {
    const dm = { to_profile: "lead-qa", reply: "ok", warnings: [] };
    const list = items([
      eventMessage("a", 1),
      eventMessage("b", 2),
      eventMessage("dm", 3, { dm }),
      eventMessage("c", 4),
      eventMessage("d", 5),
      eventMessage("del", 6, {
        event: "delegation",
        delegation: { id: "deleg_1", batch: false, total: 1, succeeded: 1, tasks: [] },
      }),
    ]);
    expect(shape(list)).toEqual(["burst(a,b)", "event(dm)", "burst(c,d)", "event(del)"]);
  });

  test("a day boundary starts a new burst rather than drawing two days under one divider", () => {
    const late = new Date(T0 + 86_400_000).toISOString();
    const next = { ...eventMessage("c", 0), at: late };
    const nextToo = { ...eventMessage("d", 0), at: new Date(T0 + 86_401_000).toISOString() };
    const list = threadItems(
      turnRows([eventMessage("a", 1), eventMessage("b", 2), next, nextToo], T0 + 2 * 86_400_000),
    );
    expect(shape(list)).toEqual(["burst(a,b)", "burst(c,d)"]);
  });

  test("the summary counts each kind once, in a fixed order", () => {
    const events = [
      eventOf(),
      eventOf({ event: "watch_match", outcome: "info", watch: { pattern: "x", suppressed: 0 } }),
      eventOf(),
      eventOf({ outcome: "terminated", status: "terminated by Hermes" }),
      eventOf(),
      eventOf({ event: "mcp_reload", outcome: "info", message: "MCP servers reloaded" }),
    ];
    expect(burstParts(events).map((p) => p.text)).toEqual([
      "3 completed",
      "1 watch match",
      "1 terminated",
      "1 notice",
    ]);
    expect(shortProcessId("proc_51c0aaaaaaaa")).toBe("proc_51c0");
    expect(shortProcessId("weird-id")).toBe("weird-id");
  });
});

describe("failures only", () => {
  test("hides routine events and bursts, and keeps failures, DM replies and subagent results", () => {
    expect(shape(items(kestrelEvents(), "failures"))).toEqual([
      "turn(m-prompt)",
      "turn(m-starts)",
      "event(m-dm)",
      "turn(m-reply)",
      "event(m-test)",
      "turn(m-ack)",
      "event(m-deleg)",
    ]);
  });

  test("a hidden row's day divider moves to the next row drawn", () => {
    const list = threadItems(
      turnRows(
        [
          { ...eventMessage("old", 0), at: new Date(T0 - 86_400_000).toISOString() },
          eventMessage("a", 1),
          eventMessage("b", 2, { outcome: "failed", status: "exited", exit_code: 1 }),
        ],
        NOW,
      ),
      "failures",
    );
    expect(shape(list)).toEqual(["event(b)"]);
    expect(list[0]!.kind === "event" && list[0]!.row.divider).toBeTruthy();
  });
});

describe("responding to", () => {
  test("the bot turn right after an event names it; a turn after a turn does not", () => {
    const list = items(kestrelEvents());
    const reply = list.find((i) => i.kind === "turn" && i.row.message.id === "m-reply");
    const ack = list.find((i) => i.kind === "turn" && i.row.message.id === "m-ack");
    const starts = list.find((i) => i.kind === "turn" && i.row.message.id === "m-starts");
    expect(reply?.kind === "turn" && reply.inReply).toBe("lead-qa's DM reply");
    expect(ack?.kind === "turn" && ack.inReply).toBe("4 events");
    expect(starts?.kind === "turn" && starts.inReply).toBeNull();
  });

  test("an operator turn after an event is never marked as responding", () => {
    const prompt = { ...kestrelEvents()[0]!, id: "p2", at: at(1) } as ChatMessageView;
    const list = items([
      eventMessage("a", 0, { outcome: "failed", status: "exited", exit_code: 1 }),
      prompt,
    ]);
    expect(list[1]!.kind === "turn" && list[1]!.inReply).toBeNull();
  });
});

describe("links between a start and its event", () => {
  test("a background terminal call names its process, from an object or a JSON string", () => {
    const tool = (args: unknown, result: unknown) => ({ kind: "tool", name: "terminal", args, result });
    expect(backgroundProcessId(tool({ background: true }, { session_id: "proc_a" }))).toBe("proc_a");
    expect(backgroundProcessId(tool({ background: true }, '{"session_id":"proc_b"}'))).toBe("proc_b");
    expect(backgroundProcessId(tool('{"background":true}', { session_id: "proc_c" }))).toBe("proc_c");
    // Foreground, redacted, unparseable, another tool: none of them is a start.
    expect(backgroundProcessId(tool({ background: false }, { session_id: "proc_d" }))).toBeNull();
    expect(backgroundProcessId(tool({ background: true }, "[redacted]"))).toBeNull();
    expect(backgroundProcessId(tool({ background: true }, "{not json"))).toBeNull();
    expect(
      backgroundProcessId({
        kind: "tool",
        name: "shell",
        args: { background: true },
        result: { session_id: "x" },
      }),
    ).toBeNull();
  });

  test("starts are stamped with their own row; anchors land on each process's last drawn event", () => {
    const messages = kestrelEvents();
    const starts = processStarts(messages);
    expect([...starts.keys()]).toEqual([PIDS.dm, PIDS.build, PIDS.test]);
    expect(starts.get(PIDS.build)?.at).toBe(at(7));

    const watched = [
      eventMessage("w1", 1, { event: "watch_match", outcome: "info", process_id: "proc_w" }),
      eventMessage("m", 2, { outcome: "failed", status: "exited", exit_code: 1, process_id: "proc_w" }),
    ];
    expect(eventAnchors(items(watched)).get("proc_w")).toBe("m");
    // A hidden row is not a place to land.
    expect(eventAnchors(items(messages, "failures")).has(PIDS.build)).toBe(false);
    expect(eventAnchors(items(messages, "failures")).get(PIDS.test)).toBe("m-test");
  });

  test("a duration is the difference of two readable stamps, never a guess", () => {
    expect(spanMs(at(7), at(257))).toBe(250_000);
    expect(spanMs(undefined, at(1))).toBeNull();
    expect(spanMs("not a date", at(1))).toBeNull();
    expect(spanMs(at(10), at(1))).toBeNull();
    expect(fmtSpan(42_000)).toBe("42s");
    expect(fmtSpan(250_000)).toBe("4m 10s");
    expect(fmtSpan(3_720_000)).toBe("1h 02m");
    expect(processDomId("event", "proc_a/b")).toBe("ch-ev-proc_a_b");
  });
});

describe("output", () => {
  test("trailing blank lines are dropped and the last line is the last with anything on it", () => {
    const lines = outputLines("a\nb\n 1 fail \n\n");
    expect(lines).toEqual(["a", "b", " 1 fail "]);
    expect(lastLine(lines)).toBe("1 fail");
    expect(outputLines(null)).toEqual([]);
  });

  test("the watch pattern is matched literally, so a pattern that is not a valid regex still marks", () => {
    expect(highlightParts("x ERROR y ERROR", "ERROR")).toEqual([
      { text: "x ", hit: false },
      { text: "ERROR", hit: true },
      { text: " y ", hit: false },
      { text: "ERROR", hit: true },
    ]);
    expect(highlightParts("fail (code", "(code")).toEqual([
      { text: "fail ", hit: false },
      { text: "(code", hit: true },
    ]);
    expect(highlightParts("nothing", "zzz")).toEqual([{ text: "nothing", hit: false }]);
    expect(highlightParts("plain", null)).toEqual([{ text: "plain", hit: false }]);
  });
});

describe("never the operator", () => {
  test("quick jump does not search an event as a message somebody wrote", () => {
    const event = eventMessage("e", 1, { command: "bun run build", message: "bun" });
    expect(isProcessEventMessage(event)).toBe(true);
    expect(searchableText(event)).toBe("");
    expect(searchableText(kestrelEvents()[0]!)).toContain("lead-qa");
  });

  test("a rail preview of an event is the event's sentence, not blank and not prose", () => {
    const failed = eventMessage("e", 1, {
      outcome: "failed",
      status: "exited",
      exit_code: 1,
      command: "bun test packages/ui",
    });
    expect(previewText(failed)).toBe("■ bun test packages/ui exited 1");
    const dm = kestrelEvents().find((m) => m.id === "m-dm")!;
    expect(previewText(dm)).toStartWith("↩ lead-qa: ");
  });
});
