/**
 * `hermetic bots ls` and the four `hermetic chat` commands (§9).
 *
 * Two halves, for the same reason `inbox.test.ts` has two: the rendering is a
 * pure function of what core returned, so the thing an operator actually reads
 * is asserted without a fleet, a box or a spawned process — and the addressing
 * is a pure function of what they typed, which is the part with a real
 * opportunity to be wrong (`atlas` and `atlas/default` must be the same bot,
 * and `atlas/` must not be a bot called nothing).
 *
 * The end of the file spawns the real CLI against the fixture, which has no
 * boxes. That is deliberately the case worth spawning: it proves the command
 * reaches core, renders an unreachable box as a reason rather than an empty
 * table, and — the part a script depends on — does not exit 0 after printing a
 * failure.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, ChatFrame, ChatMessage, ChatObserveEvent, Session, Swarm } from "@hermetic/core";
import {
  blockLines,
  botRow,
  frameText,
  messageLines,
  observeText,
  parseBotRef,
  sessionRow,
  swarmHeading,
} from "../src/commands/chat.ts";
import { cliBinary } from "./cli-binary.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const AT = "2026-09-17T09:00:00.000Z";

function bot(over: Partial<Bot> = {}): Bot {
  return {
    instance: "atlas",
    name: "default",
    title: "Bot Chat",
    description: null,
    is_default: true,
    model: "claude-sonnet-4-6",
    section: null,
    avatar_seed: "fxtr0001/atlas/default",
    last_message_at: AT,
    unread: 0,
    needs_action: false,
    muted: false,
    warm: true,
    ...over,
  };
}

function swarm(over: Partial<Swarm> = {}): Swarm {
  return {
    instance: "atlas",
    reachable: true,
    unreachable_reason: null,
    bots: [bot()],
    rooms: [],
    warm_slots: { used: 2, total: 3 },
    sections: [],
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "ses-1",
    instance: "atlas",
    bot: "default",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Bot Chat",
    last_message_at: AT,
    unread: 0,
    turn_count: 3,
    ...over,
  };
}

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    session: "ses-1",
    role: "bot",
    author: null,
    at: AT,
    blocks: [],
    usage: null,
    error: null,
    incomplete: null,
    ...over,
  };
}

describe.concurrent("addressing", () => {
  test("a bare instance is that box's default bot", () => {
    // Every box runs a swarm of one today, and `default` is the profile that
    // *is* `$HERMES_HOME` — so this is the spelling an operator types.
    expect(parseBotRef("atlas")).toEqual({ instance: "atlas", bot: "default" });
  });

  test("an explicit bot is taken as written", () => {
    expect(parseBotRef("atlas/researcher")).toEqual({ instance: "atlas", bot: "researcher" });
  });

  test("a trailing slash is an empty bot, and stays empty for the schema to refuse", () => {
    // Not silently repaired to `default`: `atlas/` is a typo, and a head that
    // guessed would send a turn to a bot the operator did not name.
    expect(parseBotRef("atlas/")).toEqual({ instance: "atlas", bot: "" });
  });

  test("only the first slash splits, so a bot name keeps the rest of itself", () => {
    expect(parseBotRef("atlas/a/b")).toEqual({ instance: "atlas", bot: "a/b" });
  });
});

describe.concurrent("the roster", () => {
  test("the heading counts warm slots, which is the number that predicts a dead click", () => {
    expect(swarmHeading(swarm())).toBe("atlas: 1 bots, 2/3 warm slots");
  });

  test("an unreachable box says why instead of being left out", () => {
    const heading = swarmHeading(
      swarm({ reachable: false, unreachable_reason: "CHAT_UNREACHABLE: no answer" }),
    );
    expect(heading).toBe("atlas: unreachable — CHAT_UNREACHABLE: no answer");
  });

  test("a bot's row is its absolute address, its model and whether it wants attention", () => {
    expect(botRow(bot({ unread: 4, needs_action: true }), NOW)).toEqual([
      "default@atlas",
      "claude-sonnet-4-6",
      "!4",
      "3h",
      "-",
    ]);
  });

  test("a quiet bot shows neither a mark nor a count", () => {
    expect(botRow(bot(), NOW)[2]).toBe(" -");
  });
});

describe.concurrent("the session list", () => {
  test("a portal session is its own origin and nothing more", () => {
    expect(sessionRow(session(), NOW)[2]).toBe("portal");
  });

  test("a foreign origin carries the detail that says where a reply would land", () => {
    // `#acme-support` is the part that says this reply leaves the tailnet.
    const row = sessionRow(session({ origin: "channel", origin_detail: "#acme-support" }), NOW);
    expect(row[2]).toBe("channel:#acme-support");
  });
});

describe.concurrent("the transcript", () => {
  test("every block kind renders as something", () => {
    // The `unknown` case is the contract, not a fallback: upstream emits tools
    // this repo has never heard of, and a version bump must never blank a
    // transcript.
    expect(blockLines({ kind: "text", markdown: "one\ntwo" })).toEqual(["one", "two"]);
    expect(
      blockLines({
        kind: "activity",
        category: "history",
        key: "history",
        title: "Loading conversation",
        state: "running",
        detail: "Please wait",
      }),
    ).toEqual(["[running] Loading conversation — Please wait"]);
    expect(blockLines({ kind: "reasoning", text: "…", duration_ms: 4000, tokens: null })).toEqual([
      "(thought for 4s)",
    ]);
    expect(
      blockLines({
        kind: "tool",
        name: "bash",
        server: null,
        args: {},
        result: null,
        status: "ok",
        exit_code: 0,
        duration_ms: null,
        render: null,
      }),
    ).toEqual(["$ bash -> ok (exit 0)"]);
    expect(blockLines({ kind: "unknown", name: "some.new.tool", payload: { a: 1 } })).toEqual([
      '[some.new.tool] {"a":1}',
    ]);
  });

  test("a message is who said it, then its blocks indented under it", () => {
    expect(messageLines(message({ blocks: [{ kind: "text", markdown: "hi" }] }), NOW)).toEqual([
      "3h ago  bot",
      "  hi",
    ]);
  });

  test("a message from another bot names it, because in a room the speaker is not the session's", () => {
    const from = message({ author: { instance: "granite", bot: "ops-writer" } });
    expect(messageLines(from, NOW)[0]).toBe("3h ago  bot ops-writer@granite");
  });

  test("a turn that stopped early says so, and an error is printed under it", () => {
    const broken = message({ incomplete: true, error: "the model refused" });
    const lines = messageLines(broken, NOW);
    expect(lines[0]).toContain("(incomplete)");
    expect(lines[1]).toBe("  ! the model refused");
  });
});

describe.concurrent("the live turn", () => {
  test("a delta is an append with no newline of its own", () => {
    // It is the middle of a sentence; a line break here would print the reply
    // one token per line.
    expect(frameText({ type: "delta", seq: 1, message: "m", text: "hel" })).toBe("hel");
  });

  test("a reconnect status is one line, on a line of its own, and its replacement follows it", () => {
    const status = (
      state: "running" | "done" | "warning",
      title: string,
      detail: string | null,
    ): ChatFrame => ({
      type: "block",
      seq: 4,
      message: "m",
      block: {
        kind: "activity",
        category: "connection",
        key: "connection:reconnect",
        role: "status",
        state,
        title,
        detail,
        request_id: null,
      },
    });
    // The drop happens mid-sentence, so the status opens its own line rather
    // than being spliced into the half-written reply.
    expect(frameText(status("running", "Reconnecting…", "attempt 1 of 5"), true)).toBe(
      "\n[running] Reconnecting… — attempt 1 of 5\n",
    );
    // A terminal cannot replace a line, so the later snapshot on the same key
    // prints under it — one line, not a second copy of the paragraph.
    expect(frameText(status("done", "Reconnected", null))).toBe("[done] Reconnected\n");
  });

  test("a done frame ends the line, and an error frame prints nothing here", () => {
    expect(frameText({ type: "done", seq: 2, message: "m", usage: null, incomplete: null })).toBe("\n");
    // The error is raised as an exit status instead, so a script sees it.
    expect(frameText({ type: "error", code: "CHAT_UNREACHABLE", message: "no answer" })).toBe("");
  });
});

describe.concurrent("watching a conversation", () => {
  const snapshot = (over: Partial<Extract<ChatObserveEvent, { type: "snapshot" }>> = {}) =>
    ({
      type: "snapshot",
      instance: "atlas",
      bot: "default",
      session: "s1",
      messages: [],
      at: AT,
      ...over,
    }) satisfies ChatObserveEvent;

  test("the watch's own opening snapshot is one line, not a transcript", () => {
    const opened = snapshot({ messages: [message({ id: "m1" }), message({ id: "m2" })] });
    expect(observeText(opened, NOW, true)).toBe("watching default@atlas (s1) — 2 messages\n");
  });

  test("a session rollover mid-watch renders the new session's rows, not just a header", () => {
    // Core sends a `snapshot` again here — not because the watch is opening,
    // but because the canonical session rolled over — and nothing earlier
    // announced what this one holds, so it has to carry more than a count.
    const rollover = snapshot({
      session: "s2",
      messages: [
        message({ id: "m1", blocks: [{ kind: "text", markdown: "hi" }] }),
        message({ id: "m2", blocks: [{ kind: "text", markdown: "again" }] }),
      ],
    });
    const text = observeText(rollover, NOW, false);
    expect(text.startsWith("watching default@atlas (s2) — 2 messages\n")).toBe(true);
    // Reuses the same per-message renderer a `message` event and `chat log`
    // both use, rather than a second one.
    const expectedRows = rollover.messages.map((m) => `${messageLines(m, NOW).join("\n")}\n`).join("");
    expect(text).toBe(`watching default@atlas (s2) — 2 messages\n${expectedRows}`);
  });

  test("a rollover snapshot with no rows yet still falls back to the header", () => {
    const rollover = snapshot({ session: "s2", messages: [] });
    expect(observeText(rollover, NOW, false)).toBe("watching default@atlas (s2) — 0 messages\n");
  });

  test("a rollover onto a real transcript renders only the newest rows, not all of it", () => {
    // A rollover snapshot's window is `OBSERVE_WINDOW` (200, core) wide, sized
    // for a cursor rather than a terminal — this proves the CLI does not
    // print all of it, the exact dump the opening case above already refuses.
    const all = Array.from({ length: 15 }, (_, i) =>
      message({ id: `m${i}`, blocks: [{ kind: "text", markdown: `msg ${i}` }] }),
    );
    const rollover = snapshot({ session: "s2", messages: all });
    const text = observeText(rollover, NOW, false);
    // The true count is kept in the header, and the header says it was capped.
    expect(text.startsWith("watching default@atlas (s2) — 15 messages, last 10 shown\n")).toBe(true);
    const shown = all.slice(-10);
    const expectedRows = shown.map((m) => `${messageLines(m, NOW).join("\n")}\n`).join("");
    expect(text.endsWith(expectedRows)).toBe(true);
    // Nothing from the oldest, dropped rows leaked in.
    expect(text).not.toContain("msg 0\n");
    expect(text).not.toContain("msg 4\n");
    expect(text).toContain("msg 5\n");
    expect(text).toContain("msg 14\n");
  });
});

/**
 * The fixture fleet's boxes are canned (`backend/fixture-chat.ts`), so these
 * prove the plumbing without a network: the command reaches core, core reaches
 * the fixture chat client, and what comes back is rendered rather than thrown at
 * the operator. Both endings are covered, because both are rendered by different
 * code — `atlas` answers, and `heron`, whose bootstrap stopped on a failed
 * stage, never started a gateway.
 */
describe.concurrent("against the fixture, whose boxes are canned", () => {
  const HOME = mkdtempSync(join(tmpdir(), "hermetic-cli-chat-"));

  async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn([await cliBinary(), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  beforeAll(async () => {
    expect((await run("chat", "listen", "atlas")).code).toBe(0);
    expect((await run("chat", "listen", "heron")).code).toBe(0);
  });

  test("bots ls reports a box that answered, with its roster", async () => {
    const { code, stdout } = await run("bots", "ls", "--instance", "atlas", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      swarms: Array<{ instance: string; reachable: boolean; bots: unknown[] }>;
    };
    expect(result.swarms).toHaveLength(1);
    expect(result.swarms[0]).toMatchObject({ instance: "atlas", reachable: true });
    expect(result.swarms[0]?.bots.length).toBeGreaterThan(1);
  });

  test("bots ls reports a box that did not answer as unreachable", async () => {
    const { code, stdout } = await run("bots", "ls", "--instance", "heron", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      swarms: Array<{ instance: string; reachable: boolean; unreachable_reason: string | null }>;
    };
    expect(result.swarms[0]).toMatchObject({ instance: "heron", reachable: false });
    expect(result.swarms[0]?.unreachable_reason).toBeTruthy();
  });

  test("a turn streams NDJSON frames and ends on done", async () => {
    const { code, stdout } = await run("chat", "atlas", "hello", "--json");
    expect(code).toBe(0);
    // NDJSON: one `ChatFrame` per line (§6).
    const frames = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("a turn that cannot happen exits non-zero after printing the frame", async () => {
    const { code, stdout } = await run("chat", "heron", "hello", "--json");
    expect(code).not.toBe(0);
    // The first line is the failure rather than a half-written reply.
    const first = JSON.parse(stdout.split("\n")[0] ?? "{}") as { type: string; code: string };
    expect(first.type).toBe("error");
    expect(first.code).toBe("CHAT_UNREACHABLE");
  });
});
