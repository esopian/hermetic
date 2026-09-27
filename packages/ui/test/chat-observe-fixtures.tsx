/**
 * The injected transport and the hand-built doubles behind the chat fan-in
 * suites (`chat-observe.dom.test.tsx`, `chat-observe-rail.dom.test.tsx`).
 *
 * The transport is injected (`ChatProvider`'s `api.chatStream`) rather than
 * faked a level down, for the same reason the rest of this directory injects:
 * these are tests about the store's state machine, and a fake that hands the
 * test the handlers is what makes "the frame was routed to that conversation"
 * assertable. `api/streams.ts` owns the frames, and `fleet-stream.test.ts` owns
 * the shape of a frame consumer.
 */
import { act, render, screen, waitFor } from "./dom.ts";
import { expect } from "bun:test";
import type {
  ChatConversationView,
  ChatHistoryResult,
  ChatMessageView,
  ChatObserveView,
  ChatSessionsResult,
  ChatStreamHandlers,
  ChatSwarmsResult,
  SessionView,
  SwarmView,
} from "../src/api/index.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { FAKE_TARGET } from "./fake-transport.ts";
import { setFleetTarget } from "../src/api/index.ts";

export const ATLAS: ChatConversationView = { instance: "atlas", bot: "atlas", session: null };

export function botOf(instance: string, name: string) {
  return {
    instance,
    name,
    title: name,
    description: "last thing said",
    is_default: true,
    model: null,
    section: null,
    avatar_seed: `${instance}/${name}`,
    last_message_at: "2026-09-16T11:50:00Z",
    unread: 0,
    needs_action: false,
    muted: false,
    warm: true,
  };
}

export function swarmOf(instance: string): SwarmView {
  return {
    instance,
    reachable: true,
    unreachable_reason: null,
    bots: [botOf(instance, instance)],
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
  } as unknown as SwarmView;
}

/** One box with several bots, so a badge can be raised on one nobody is reading. */
export function swarmWith(instance: string, names: readonly string[]): SwarmView {
  return {
    ...swarmOf(instance),
    bots: names.map((name, i) => ({ ...botOf(instance, name), is_default: i === 0 })),
  } as unknown as SwarmView;
}

export function sessionOf(): SessionView {
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
  } as unknown as SessionView;
}

export function messageOf(over: Record<string, unknown> = {}): ChatMessageView {
  return {
    id: "m1",
    session: "s1",
    role: "bot",
    author: null,
    at: new Date().toISOString(),
    blocks: [{ kind: "text", markdown: "the complete answer, from the box" }],
    usage: null,
    error: null,
    incomplete: null,
    ...over,
  } as unknown as ChatMessageView;
}

/** One `message` event of an observation, as the fan-in frames one. */
export function arrival(message: ChatMessageView): ChatObserveView {
  return {
    type: "message",
    instance: ATLAS.instance,
    bot: ATLAS.bot,
    session: "s1",
    message,
  } as unknown as ChatObserveView;
}

/** The same, addressed to a conversation other than the selected one. */
export function arrivalFor(
  conversation: ChatConversationView,
  message: ChatMessageView,
): ChatObserveView {
  return {
    type: "message",
    instance: conversation.instance,
    bot: conversation.bot,
    session: conversation.session,
    message,
  } as unknown as ChatObserveView;
}

/** One `snapshot` event: the transcript as the box holds it. */
export function snapshot(messages: ChatMessageView[]): ChatObserveView {
  return {
    type: "snapshot",
    instance: ATLAS.instance,
    bot: ATLAS.bot,
    session: "s1",
    messages,
    at: new Date().toISOString(),
  } as unknown as ChatObserveView;
}

export interface Harness {
  api: ChatApi;
  calls: { swarms: number; sessions: number; history: number; send: number };
  /** Every fan-in subscription opened, and how many were closed. */
  streams: ChatStreamHandlers[];
  closed: number;
  /** The roster every `fetchSwarms` answers with. */
  swarms: SwarmView[];
  /** Every targeted resume the store asked for, in order. */
  resumes: Array<{ instance: string; bot: string; session: string | null }>;
  /** What the resume route answers. A box nobody listens to answers `listening: false`. */
  resumeAnswer: { observing: boolean; listening: boolean };
  history: ChatMessageView[];
  /** The session every history read was addressed to, in order. `null` is canonical. */
  historyFor: Array<string | null>;
  /** The session every send was addressed to, in order. */
  sendFor: Array<string | null>;
  /** How many turns were stopped through the canceller `sendTurn` handed back. */
  cancelled: number;
}

export function harness(): Harness {
  // The fleet target, per harness rather than once per process — see the same
  // call in `chat-fixtures.tsx` for why a module-scope one does not survive a
  // full run.
  setFleetTarget(FAKE_TARGET);
  const h: Harness = {
    calls: { swarms: 0, sessions: 0, history: 0, send: 0 },
    streams: [],
    closed: 0,
    swarms: [swarmOf("atlas")],
    resumes: [],
    resumeAnswer: { observing: true, listening: true },
    history: [messageOf()],
    historyFor: [],
    sendFor: [],
    cancelled: 0,
    api: {} as ChatApi,
  };
  h.api = {
    fetchSwarms: () => {
      h.calls.swarms++;
      return Promise.resolve({ swarms: h.swarms } as ChatSwarmsResult);
    },
    fetchSessions: (instance: string, bot: string) => {
      h.calls.sessions++;
      return Promise.resolve({
        instance,
        bot,
        sessions: [sessionOf()],
      } as unknown as ChatSessionsResult);
    },
    fetchHistory: (instance: string, bot: string, input: { session?: string } = {}) => {
      h.calls.history++;
      h.historyFor.push(input.session ?? null);
      return Promise.resolve({
        instance,
        bot,
        // The box answers from the session it was asked for. A read addressed
        // to a session the box then does not name is a different bug.
        session: input.session ?? "s1",
        messages: h.history,
      } as unknown as ChatHistoryResult);
    },
    sendTurn: (
      _instance: string,
      _bot: string,
      _message: string,
      _handlers: unknown,
      opts: { session?: string } = {},
    ) => {
      h.calls.send++;
      h.sendFor.push(opts.session ?? null);
      // A turn whose stream never answers: the acceptance criterion is about
      // what happens to the transcript while one is outstanding.
      return () => {
        h.cancelled++;
      };
    },
    abortTurn: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, aborted: true } as never),
    chatStream: (handlers: ChatStreamHandlers) => {
      h.streams.push(handlers);
      return () => {
        h.closed++;
      };
    },
    resumeObservation: (instance: string, bot: string, session?: string | null) => {
      h.resumes.push({ instance, bot, session: session ?? null });
      return Promise.resolve({
        instance,
        bot,
        session: session ?? null,
        observing: h.resumeAnswer.observing,
        restarted: true,
        listening: h.resumeAnswer.listening,
      } as never);
    },
  };
  return h;
}

/** The store, for the assertions that are about state rather than about pixels. */
export function probe(): { held: { store: Chat | null }; Probe: () => null } {
  const held: { store: Chat | null } = { store: null };
  function Probe() {
    held.store = useChat();
    return null;
  }
  return { held, Probe };
}

export async function mount(h: Harness) {
  const { held, Probe } = probe();
  const view = render(
    <ChatProvider api={h.api}>
      <Probe />
      <ChatView />
    </ChatProvider>,
  );
  // Settled, not merely mounted: an assertion taken while the first transcript
  // read is in flight is about this test's timing rather than about the stream.
  await waitFor(() => expect(held.store?.historyRead).toBe(true));
  return { ...view, held };
}

/** Push one frame at the conversation, the way the fan-in delivers one. */
export async function deliver(h: Harness, event: ChatObserveView, conversation = ATLAS) {
  await act(async () => {
    h.streams[0]?.onFrame(conversation, event);
  });
}

/**
 * Hold every history read open, so a test can answer two of them out of order.
 *
 * `readHistory`'s winner/loser merge and the copy a rollover takes are both
 * about a read that has not answered yet, and neither state is reachable
 * without one. The wrapper replaces the method on the same `api` object the
 * provider already holds, so it can be installed after mounting.
 */
export function holdHistory(h: Harness) {
  const base = h.api.fetchHistory;
  let waiting: Array<() => void> = [];
  let through = false;
  h.api.fetchHistory = (instance, bot, input = {}, signal) => {
    if (through) return base(instance, bot, input, signal);
    return new Promise<ChatHistoryResult>((resolve) => {
      waiting.push(() => resolve(base(instance, bot, input, signal)));
    });
  };
  return {
    /** How many reads are held, in the order they were issued. */
    waiting: () => waiting.length,
    /** Answer the `index`th held read and leave the rest holding. */
    release: async (index: number) => {
      const [answer] = waiting.splice(index, 1);
      await act(async () => {
        answer?.();
      });
    },
    /** Answer everything held, and stop holding. Call inside `act`. */
    open: () => {
      through = true;
      const all = waiting;
      waiting = [];
      for (const answer of all) answer();
    },
  };
}

/**
 * Mount into the state `readHistory`'s merge (`chat-conversations.ts:398-409`)
 * leaves behind: every alias, the canonical one included, answering with the
 * record an explicit select created, whose own `target.session` is `s1`.
 */
export function mountHeld(h: Harness) {
  const { held, Probe } = probe();
  const view = render(
    <ChatProvider api={h.api}>
      <Probe />
      <ChatView />
    </ChatProvider>,
  );
  return { ...view, held };
}

export async function mountPinnedToSession(h: Harness, gate: ReturnType<typeof holdHistory>) {
  const { held } = mountHeld(h);
  // The canonical read is in flight when the operator picks `s1` by hand.
  await waitFor(() => expect(gate.waiting()).toBe(1));
  await act(async () => {
    held.store?.select("atlas", "atlas", "s1");
  });
  await waitFor(() => expect(gate.waiting()).toBe(2));
  // The explicit read answers first, so it is the one already holding a
  // transcript when the canonical read lands on the same session and has to
  // decide which of the two records that session's key means.
  await gate.release(1);
  await gate.release(0);
  await waitFor(() => expect(h.calls.history).toBe(2));
  await act(async () => {
    gate.open();
  });
  return { held };
}

/** How many rendered nodes carry this text. `0` is a real answer, not a failure. */
export function shown(text: RegExp): number {
  return screen.queryAllByText(text).length;
}
