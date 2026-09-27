/**
 * The hand-built doubles behind the chat view suites.
 *
 * `chat-view.dom.test.tsx`, `chat-view-turn.dom.test.tsx` and
 * `chat-view-entry.dom.test.tsx` all drive `ChatView` through the same injected
 * `ChatApi` (`ChatProvider`'s `api` prop) rather than a faked transport: these
 * are tests about the provider's state machine, and a fake that records its own
 * calls is what makes "the transcript was read again" assertable. The harness
 * lives here so the three files measure the same store the same way.
 */
import { render, waitFor } from "./dom.ts";
import { expect } from "bun:test";
import type {
  ChatHistoryResult,
  ChatMessageView,
  ChatSessionsResult,
  ChatSwarmsResult,
  ChatTurnHandlers,
  SessionView,
  SwarmView,
} from "../src/api/index.ts";
import type { Destination } from "../src/chat/chat-logic.ts";
import { ChatProvider } from "../src/chat/chat-state.tsx";
import type { ChatApi } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { FAKE_TARGET } from "./fake-transport.ts";
import { setFleetTarget } from "../src/api/index.ts";

export const NOW = new Date("2026-09-16T12:00:00Z").getTime();

/** A destination that is known and local, for the panes that are not about one. */
export const PORTAL: Destination = { state: "known", origin: "portal", detail: null };

export function botOf(instance: string, name: string, over: Record<string, unknown> = {}) {
  return {
    instance,
    name,
    // The schema's `title` is the *display name*, and the rail draws it; the
    // fixture's default bot is named `default` and titled after its box. The
    // preview line is the description, which is the only prose the roster read
    // carries.
    title: name,
    description: "last thing said",
    is_default: name === instance,
    model: null,
    section: null,
    avatar_seed: `${instance}/${name}`,
    last_message_at: "2026-09-16T11:50:00Z",
    unread: 0,
    needs_action: false,
    muted: false,
    warm: true,
    ...over,
  };
}

export function swarmOf(instance: string, over: Record<string, unknown> = {}): SwarmView {
  return {
    instance,
    reachable: true,
    unreachable_reason: null,
    bots: [botOf(instance, instance)],
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
    ...over,
  } as unknown as SwarmView;
}

export function sessionOf(over: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    instance: "atlas",
    bot: "atlas",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Bot Chat",
    last_message_at: "2026-09-16T11:50:00Z",
    unread: 0,
    turn_count: 3,
    ...over,
  } as unknown as SessionView;
}

export function messageOf(over: Record<string, unknown> = {}): ChatMessageView {
  return {
    id: "m1",
    session: "s1",
    role: "bot",
    author: null,
    at: "2026-09-16T11:50:00Z",
    blocks: [{ kind: "text", markdown: "the complete answer, from the box" }],
    usage: null,
    error: null,
    incomplete: null,
    ...over,
  } as unknown as ChatMessageView;
}

export interface Turn {
  instance: string;
  bot: string;
  message: string;
  session: string | undefined;
  handlers: ChatTurnHandlers;
  cancelled: boolean;
}

export interface Harness {
  api: ChatApi;
  calls: { swarms: number; sessions: number; history: number; send: number; abort: number };
  /** Every turn opened, in order, so a test can drive one and assert on another. */
  turns: Turn[];
  /** The most recent turn's handlers, for the common case. */
  turn: ChatTurnHandlers | null;
  /** What the roster read answers with; mutable, so an outage can start mid-test. */
  swarms: SwarmView[];
  /** What `fetchHistory` answers with, per `instance/bot`, and the default. */
  history: Record<string, ChatMessageView[]>;
  defaultHistory: ChatMessageView[];
  /** Per-`instance/bot` session lists. */
  sessions: Record<string, SessionView[]>;
  defaultSessions: SessionView[];
  /** Set to hold the session read open, or to fail it. */
  sessionsMode: "resolve" | "hang" | "reject";
  /** Set to hold the *transcript* read open, for the reconnect race below. */
  historyMode: "resolve" | "hang";
  /** Resolves every held transcript read with what `defaultHistory` says now. */
  releaseHistory: (() => void) | null;
  /** How many times `doctor` was asked, and what it answers about this laptop. */
  doctorCalls: number;
  localTailscale: { ok: boolean; detail: string } | null;
  /** Resolves the held session read, if one is being held. */
  releaseSessions: (() => void) | null;
}

export function harness(over: { swarms?: SwarmView[]; sessions?: SessionView[] } = {}): Harness {
  /**
   * The fleet target, per harness rather than once per process.
   *
   * `api.ts`'s `target()` refuses every call until one is known, and these
   * suites hand `ChatProvider` a fake `ChatApi` rather than standing up a
   * `fakeServer()`, so nothing else sets one for them. It used to be a
   * module-scope call, which `bun test` runs exactly once — the moment this
   * module is first evaluated — while `api-narrow.test.ts` and
   * `flows/bridge.ts` both put the target back to null when they are done.
   * Whichever landed last owned the target for every file after it, and which
   * one that is is filesystem readdir order: green on a laptop, twenty-eight
   * tests red on Linux. Every test here builds a harness, so setting it here
   * is per test and cannot be outlived by a neighbour.
   */
  setFleetTarget(FAKE_TARGET);
  const h: Harness = {
    calls: { swarms: 0, sessions: 0, history: 0, send: 0, abort: 0 },
    swarms: over.swarms ?? [swarmOf("atlas")],
    turns: [],
    turn: null,
    history: {},
    defaultHistory: [messageOf()],
    sessions: {},
    defaultSessions: over.sessions ?? [sessionOf()],
    sessionsMode: "resolve",
    releaseSessions: null,
    historyMode: "resolve",
    releaseHistory: null,
    doctorCalls: 0,
    localTailscale: { ok: true, detail: "tailscale: acme.ts.net, HTTPS certificates on" },
    api: {} as ChatApi,
  };
  const key = (instance: string, bot: string) => `${instance}/${bot}`;
  h.api = {
    fetchSwarms: () => {
      h.calls.swarms++;
      return Promise.resolve({ swarms: h.swarms } as ChatSwarmsResult);
    },
    getDoctor: () => {
      h.doctorCalls++;
      if (h.localTailscale === null) return Promise.reject(new Error("doctor could not run"));
      return Promise.resolve({ local_tailscale: h.localTailscale } as never);
    },
    fetchSessions: (instance: string, bot: string) => {
      h.calls.sessions++;
      const answer = {
        instance,
        bot,
        sessions: h.sessions[key(instance, bot)] ?? h.defaultSessions,
      } as unknown as ChatSessionsResult;
      if (h.sessionsMode === "reject") return Promise.reject(new Error("the box refused the roster"));
      if (h.sessionsMode === "hang") {
        return new Promise<ChatSessionsResult>((resolve) => {
          h.releaseSessions = () => resolve(answer);
        });
      }
      return Promise.resolve(answer);
    },
    fetchHistory: (instance: string, bot: string) => {
      h.calls.history++;
      const answer = (): ChatHistoryResult =>
        ({
          instance,
          bot,
          session: (h.sessions[key(instance, bot)] ?? h.defaultSessions)[0]?.id ?? null,
          messages: h.history[key(instance, bot)] ?? h.defaultHistory,
        }) as unknown as ChatHistoryResult;
      if (h.historyMode === "hang") {
        return new Promise<ChatHistoryResult>((resolve) => {
          h.releaseHistory = () => resolve(answer());
        });
      }
      return Promise.resolve(answer());
    },
    sendTurn: (
      instance: string,
      bot: string,
      message: string,
      handlers: ChatTurnHandlers,
      opts: { session?: string } = {},
    ) => {
      h.calls.send++;
      const turn: Turn = {
        instance,
        bot,
        message,
        session: opts.session,
        handlers,
        cancelled: false,
      };
      h.turns.push(turn);
      h.turn = handlers;
      return () => {
        turn.cancelled = true;
      };
    },
    abortTurn: (instance: string, bot: string) => {
      h.calls.abort++;
      return Promise.resolve({ instance, bot, aborted: true } as never);
    },
  };
  return h;
}

/**
 * The composer, once it will actually accept a message.
 *
 * Waiting for the element is no longer enough: the composer is held until the
 * thread has *read* where a reply would go, which is the whole of the
 * destination gate. A test that typed into it the moment it existed would be
 * testing the window the gate exists to close.
 */
export async function sendable(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    const input = container.querySelector(".ch-input") as HTMLTextAreaElement | null;
    expect(input).not.toBeNull();
    expect((input as HTMLTextAreaElement).disabled).toBe(false);
    expect((input as HTMLTextAreaElement).placeholder).not.toBe("reading which conversation this is…");
    return input as HTMLTextAreaElement;
  });
}

export function mount(h: Harness) {
  return render(
    <ChatProvider api={h.api}>
      <ChatView />
    </ChatProvider>,
  );
}
