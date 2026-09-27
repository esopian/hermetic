/**
 * The rail row a completed turn writes for itself.
 *
 * The roster read owns `preview` and `last_message_at` and runs on a two-minute
 * tick, so a reply this browser watched land used to show in the thread while
 * the row beside it went on quoting the previous one. What is asserted here is
 * the narrow local patch that closes that gap: the box's own words and the
 * box's own stamp, taken off the transcript the turn already re-read, with no
 * second roster fetch — and only for Bot Chat, because that is the conversation
 * the rail row describes (§9.2).
 */
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import { previewOf } from "../src/chat/chat-logic.ts";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import type {
  ChatHistoryResult,
  ChatMessageView,
  ChatTurnHandlers,
  SwarmView,
} from "../src/api/index.ts";

afterEach(cleanup);

const ROSTER_AT = "2026-09-19T10:00:00.000Z";
const BOX_AT = "2026-09-19T10:04:00.000Z";

function reply(id: string, session: string, text: string, at = BOX_AT): ChatMessageView {
  return {
    id,
    session,
    role: "bot",
    author: null,
    at,
    blocks: [{ kind: "text", markdown: text }],
    usage: null,
    error: null,
    incomplete: null,
  } as ChatMessageView;
}

function swarm(): SwarmView {
  return {
    instance: "atlas",
    reachable: true,
    unreachable_reason: null,
    bots: [
      {
        instance: "atlas",
        name: "default",
        title: "the default bot",
        description: null,
        preview: "the previous reply",
        is_default: true,
        section: null,
        avatar_seed: "seed",
        last_message_at: ROSTER_AT,
        unread: 0,
        needs_action: false,
        muted: false,
        warm: true,
      },
    ],
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
  } as unknown as SwarmView;
}

function setup() {
  let current!: Chat;
  const rosterReads: number[] = [];
  const transcripts = new Map<string, ChatMessageView[]>([
    ["canon", []],
    ["named", []],
  ]);
  const turns: { session?: string; handlers: ChatTurnHandlers }[] = [];
  const api: ChatApi = {
    fetchSwarms: async () => {
      rosterReads.push(Date.now());
      return { swarms: [swarm()] } as never;
    },
    fetchSessions: async () =>
      ({
        sessions: ["canon", "named"].map((id) => ({
          id,
          instance: "atlas",
          bot: "default",
          origin: "portal",
          origin_detail: null,
        })),
      }) as never,
    fetchHistory: async (_instance, _bot, opts) => {
      const session = opts?.session ?? "canon";
      return { session, messages: transcripts.get(session) ?? [] } as ChatHistoryResult;
    },
    sendTurn: (_instance, _bot, _text, handlers, opts) => {
      turns.push({ session: opts?.session, handlers });
      return () => {};
    },
    abortTurn: async () => ({ aborted: true }) as never,
  };
  function Controls() {
    current = useChat();
    return (
      <>
        <button type="button" onClick={() => current.select("atlas", "default")}>
          Canonical
        </button>
        <button type="button" onClick={() => current.select("atlas", "default", "named")}>
          Named
        </button>
        <button type="button" onClick={() => current.send("ping")}>
          Send
        </button>
      </>
    );
  }
  render(
    <ChatProvider api={api}>
      <Controls />
    </ChatProvider>,
  );
  return {
    get current() {
      return current;
    },
    get bot() {
      return current.swarms[0]!.bots[0]!;
    },
    rosterReads,
    transcripts,
    turns,
    click: (label: string) => fireEvent.click(screen.getByRole("button", { name: label })),
    open: async (label: string) => {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(current.historyRead).toBe(true));
    },
    done: async () => {
      await act(async () => {
        turns.at(-1)!.handlers.onEnd?.(true, null);
      });
    },
  };
}

test("the box's cut is mirrored, not a second one invented here", () => {
  expect(previewOf("pong")).toBe("pong");
  expect(previewOf("  ")).toBeNull();
  expect(previewOf(null)).toBeNull();
  // Sixty characters and a literal `...`, exactly as upstream truncates its own.
  expect(previewOf("x".repeat(61))).toBe(`${"x".repeat(60)}...`);
  expect(previewOf("x".repeat(60))).toBe("x".repeat(60));
  // One line, so the second one is folded in rather than cut at.
  expect(previewOf("Sure —\n\nhere it is")).toBe("Sure — here it is");
});

test("a finished Bot Chat turn moves its own rail row, with no roster read", async () => {
  const s = setup();
  await waitFor(() => expect(s.current.swarms.length).toBe(1));
  await s.open("Canonical");
  const reads = s.rosterReads.length;
  s.transcripts.set("canon", [reply("m1", "canon", "Pong, and the browser is up.")]);
  s.click("Send");
  await waitFor(() => expect(s.turns.length).toBe(1));
  await s.done();
  await waitFor(() => expect(s.bot.preview).toBe("Pong, and the browser is up."));
  // The box's stamp, never this laptop's clock.
  expect(s.bot.last_message_at).toBe(BOX_AT);
  // Reading the reply is not an unread message.
  expect(s.bot.unread).toBe(0);
  expect(s.rosterReads.length).toBe(reads);
});

test("a named-session turn leaves the canonical row's preview alone", async () => {
  const s = setup();
  await waitFor(() => expect(s.current.swarms.length).toBe(1));
  await s.open("Named");
  const reads = s.rosterReads.length;
  s.transcripts.set("named", [reply("m2", "named", "A different thread's answer.")]);
  s.click("Send");
  await waitFor(() => expect(s.turns.length).toBe(1));
  await s.done();
  await waitFor(() => expect(s.current.messages.some((m) => m.id === "m2")).toBe(true));
  expect(s.bot.preview).toBe("the previous reply");
  expect(s.bot.last_message_at).toBe(ROSTER_AT);
  expect(s.rosterReads.length).toBe(reads);
});
