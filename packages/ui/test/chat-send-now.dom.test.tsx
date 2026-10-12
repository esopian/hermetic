/**
 * Getting a message past the queue, and keeping the transcript in the order
 * the box wrote it.
 *
 * Enter while the agent works still queues. ⌘Enter, and the "Send now" button
 * on a queued row, send now: steered into the running turn when the box takes
 * it, forced through by stopping the turn when it does not. The second half is
 * about order — the operator's prompt must never be drawn below the reply to
 * it, whichever path each row took to get here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import type {
  ChatHistoryResult,
  ChatMessageView,
  ChatSteerResult,
  ChatTurnHandlers,
} from "../src/api/index.ts";
import { Composer } from "../src/chat/components/Composer.tsx";
import { BotResponses, closedRequests, openQuestion } from "../src/chat/components/BotResponses.tsx";
import type { Decision } from "../src/chat/components/BotResponses.tsx";
import { insertByStamp } from "../src/chat/chat-conversation-record.ts";

afterEach(cleanup);

type SteerStatus = ChatSteerResult["status"];

function setup(
  opts: {
    steer?: SteerStatus | "throws";
    /** A responder for server requests, as `BotWorkspace` provides one. */
    respond?: (decision: Decision) => Promise<unknown>;
  } = {},
) {
  let current!: Chat;
  const turns: ChatTurnHandlers[] = [];
  const sent: string[] = [];
  const steered: string[] = [];
  let aborts = 0;
  /** Each history read waits on the next resolver pushed here, when `holdReads` is on. */
  const reads: ((messages: ChatMessageView[]) => void)[] = [];
  let holdReads = false;

  const api: ChatApi = {
    fetchSwarms: async () => ({ swarms: [] }) as never,
    fetchSessions: async () =>
      ({
        sessions: [
          { id: "S", instance: "atlas", bot: "default", origin: "portal", origin_detail: null },
        ],
      }) as never,
    fetchHistory: () =>
      holdReads
        ? new Promise<ChatHistoryResult>((resolve) =>
            reads.push((messages) =>
              resolve({ instance: "atlas", bot: "default", session: "S", messages } as never),
            ),
          )
        : Promise.resolve({ instance: "atlas", bot: "default", session: "S", messages: [] } as never),
    sendTurn: (_instance, _bot, text, handlers) => {
      sent.push(text);
      turns.push(handlers);
      return () => {};
    },
    abortTurn: async () => {
      aborts += 1;
      return { aborted: true } as never;
    },
    steerTurn: async (instance, bot, text) => {
      steered.push(text);
      if (opts.steer === "throws") throw new Error("gateway said no");
      return { instance, bot, status: opts.steer ?? "redirected" };
    },
  };

  function Harness() {
    current = useChat();
    return (
      <>
        <button type="button" onClick={() => current.select("atlas", "default", null)}>
          pick
        </button>
        <button type="button" onClick={() => current.select("atlas", "other", null)}>
          pick other
        </button>
        <Composer
          destination={{ state: "known", origin: "portal", detail: null }}
          placeholder="Message…"
          enabled
          sending={current.sending}
          onSend={current.send}
          onAbort={current.abort}
        />
      </>
    );
  }

  render(
    <ChatProvider api={api} eager={false}>
      <BotResponses.Provider value={opts.respond ?? null}>
        <Harness />
      </BotResponses.Provider>
    </ChatProvider>,
  );

  const input = () => screen.getByLabelText("Message…") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
  /** What the thread draws, in order: each message's prose, live last. */
  const drawn = () =>
    [...current.messages, ...(current.live ? [current.live] : [])].map((m) =>
      m.blocks.map((b) => (b.kind === "text" ? b.markdown : `[${b.kind}]`)).join(""),
    );
  let seq = 0;
  return {
    get current() {
      return current;
    },
    get aborts() {
      return aborts;
    },
    sent,
    steered,
    turns,
    input,
    type,
    drawn,
    holdReads: () => {
      holdReads = true;
    },
    answerRead: async (messages: ChatMessageView[]) => {
      await act(async () => {
        reads.shift()?.(messages);
      });
    },
    get pendingReads() {
      return reads.length;
    },
    open: async () => {
      fireEvent.click(screen.getByRole("button", { name: "pick" }));
      await waitFor(() => expect(current.historyRead).toBe(true));
    },
    say: (text: string) => {
      type(text);
      fireEvent.keyDown(input(), { key: "Enter" });
    },
    sayNow: (text: string) => {
      type(text);
      fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    },
    rows: () => document.querySelectorAll(".ch-queue-row"),
    /** One delta of prose into the running turn. */
    speak: async (text: string) => {
      await act(async () => {
        turns[turns.length - 1]?.onFrame({
          type: "delta",
          seq: ++seq,
          message: `atlas:turn-${turns.length}`,
          text,
        } as never);
      });
    },
    /** One block into the running turn. */
    block: async (block: Record<string, unknown>) => {
      await act(async () => {
        turns[turns.length - 1]?.onFrame({
          type: "block",
          seq: ++seq,
          message: `atlas:turn-${turns.length}`,
          block,
        } as never);
      });
    },
    end: async (ok = true) => {
      await act(async () => {
        turns[turns.length - 1]?.onEnd(ok, null);
      });
    },
  };
}

function row(id: string, role: "user" | "bot", text: string, at: string): ChatMessageView {
  return {
    id,
    session: "S",
    role,
    author: null,
    at,
    blocks: [{ kind: "text", markdown: text }],
    usage: null,
    error: null,
    incomplete: null,
  } as unknown as ChatMessageView;
}

describe("send now", () => {
  test("⌘Enter while a turn runs steers the message into it, between the reply's two parts", async () => {
    const h = setup();
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.speak("working on it");

    h.sayNow("use the other branch");
    await waitFor(() => expect(h.steered).toEqual(["use the other branch"]));
    // Steered, not queued and not a second turn.
    await waitFor(() => expect(h.drawn()).toContain("use the other branch"));
    expect(h.rows()).toHaveLength(0);
    expect(h.sent).toEqual(["first"]);

    await h.speak("switching branches");
    expect(h.drawn()).toEqual(["first", "working on it", "use the other branch", "switching branches"]);
  });

  test("Enter while a turn runs still queues", async () => {
    const h = setup();
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    h.say("second");
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    expect(h.steered).toEqual([]);
  });

  test("⌘Enter with nothing running is an ordinary send", async () => {
    const h = setup();
    await h.open();
    h.sayNow("hello");
    await waitFor(() => expect(h.sent).toEqual(["hello"]));
    expect(h.steered).toEqual([]);
  });

  test("Send now on a queued row steers it and takes the row away", async () => {
    const h = setup();
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    h.say("nudge");
    await waitFor(() => expect(h.rows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Send queued message now" }));
    await waitFor(() => expect(h.steered).toEqual(["nudge"]));
    await waitFor(() => expect(h.rows()).toHaveLength(0));
    expect(h.drawn()).toContain("nudge");
    expect(h.aborts).toBe(0);
  });

  test("a box that will not take a steer gets the turn stopped and the message sent next", async () => {
    const h = setup({ steer: "rejected" });
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    h.say("later");
    h.say("urgent");
    await waitFor(() => expect(h.rows()).toHaveLength(2));

    fireEvent.click(screen.getAllByRole("button", { name: "Send queued message now" })[1]!);
    await waitFor(() => expect(h.aborts).toBe(1));
    // Forced to the head, so it is what goes out when the stop lands — and the
    // stop did not park the rest of the queue behind it.
    await waitFor(() => expect(h.sent).toEqual(["first", "urgent"]));
    // The row leaves once the turn it started is seen to start.
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    await h.end();
    await waitFor(() => expect(h.sent).toEqual(["first", "urgent", "later"]));
  });

  test("a steer that fails outright is forced through the same way", async () => {
    const h = setup({ steer: "throws" });
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    h.sayNow("stop and do this");
    await waitFor(() => expect(h.sent).toEqual(["first", "stop and do this"]));
    expect(h.aborts).toBe(1);
    await waitFor(() => expect(h.rows()).toHaveLength(0));
  });
});

describe("transcript order", () => {
  test("a queued send keeps the previous reply on screen, above its prompt", async () => {
    const h = setup();
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    h.say("second");
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    await h.speak("answer one");

    // The end of the turn asks for a re-read, and the queue sends "second"
    // before that read answers — which cancels it.
    h.holdReads();
    await h.end();
    await waitFor(() => expect(h.sent).toEqual(["first", "second"]));
    expect(h.drawn()).toEqual(["first", "answer one", "second"]);

    // The cancelled read answering late changes nothing.
    await h.answerRead([]);
    expect(h.drawn()).toEqual(["first", "answer one", "second"]);

    // And the new turn's reply streams below its own prompt.
    await h.speak("answer two");
    expect(h.drawn()).toEqual(["first", "answer one", "second", "answer two"]);
  });

  test("a row is placed at the box's stamp, not appended where it arrived", () => {
    const prompt = row("S:99", "user", "done", "2026-10-12T06:43:07Z");
    const reply = [
      row("S:100", "bot", "checking", "2026-10-12T06:43:10Z"),
      row("S:114", "bot", "still not logged in", "2026-10-12T06:44:22Z"),
    ];
    const text = (ms: ChatMessageView[]) =>
      ms.map((m) => (m.blocks[0]?.kind === "text" ? m.blocks[0].markdown : ""));
    // The prompt's echo arriving after its reply goes back above it.
    expect(text(insertByStamp(reply, [prompt]))).toEqual(["done", "checking", "still not logged in"]);
    // Equal stamps keep arrival order, and a later row is still appended.
    const later = row("S:115", "user", "why", "2026-10-12T06:44:23Z");
    const twin = row("S:116", "bot", "twin", "2026-10-12T06:44:23Z");
    expect(text(insertByStamp([prompt, ...reply, later], [twin]))).toEqual([
      "done",
      "checking",
      "still not logged in",
      "why",
      "twin",
    ]);
    // An unreadable stamp stays where it arrived.
    const odd = row("S:x", "bot", "odd", "not a time");
    expect(text(insertByStamp([prompt, ...reply], [odd])).at(-1)).toBe("odd");
  });
});

describe("writing while a clarify waits", () => {
  const question = { kind: "question", request_id: "q1", prompt: "Which branch?", choices: ["main"] };

  /** A responder that records each decision and whether a steer had already gone out. */
  function responder(h: () => { steered: string[] }) {
    const log: { decision: Decision; steeredFirst: boolean }[] = [];
    const respond = async (decision: Decision) => {
      log.push({ decision, steeredFirst: h().steered.length > 0 });
      return { status: "ok" };
    };
    return { log, respond };
  }

  test("⌘Enter skips the open question first, then steers", async () => {
    let handle!: ReturnType<typeof setup>;
    const r = responder(() => handle);
    handle = setup({ respond: r.respond });
    const h = handle;
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);

    h.sayNow("never mind, use main");
    await waitFor(() => expect(h.steered).toEqual(["never mind, use main"]));
    expect(r.log).toEqual([
      { decision: { request_id: "q1", kind: "question", skip: true }, steeredFirst: false },
    ]);
  });

  test("Enter skips it and queues, so the queue is not stuck behind the question", async () => {
    let handle!: ReturnType<typeof setup>;
    const r = responder(() => handle);
    handle = setup({ respond: r.respond });
    const h = handle;
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);

    h.say("later");
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    expect(r.log.map((e) => e.decision)).toEqual([{ request_id: "q1", kind: "question", skip: true }]);
    expect(h.steered).toEqual([]);
  });

  /** A responder held until released, as a slow tailnet would hold it. */
  function held(outcome: "ok" | "throws" = "ok") {
    let release = (): void => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let calls = 0;
    const respond = async () => {
      calls += 1;
      await gate;
      if (outcome === "throws") throw new Error("tailnet unreachable");
      return { status: "ok" };
    };
    return {
      respond,
      release: () => act(async () => release()),
      get calls() {
        return calls;
      },
    };
  }

  test("the card closes once the box acknowledges the skip, and not before", async () => {
    const r = held();
    const h = setup({ respond: r.respond });
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);
    expect(h.current.activity).toBe("idle");

    h.sayNow("never mind, use main");
    await waitFor(() => expect(r.calls).toBe(1));
    // While the call is in flight the card is still the box's to close, and the
    // steer waits on it.
    expect(closedRequests(h.current.live?.blocks ?? []).has("q1")).toBe(false);
    expect(openQuestion(h.current.live)).toBe("q1");
    expect(h.steered).toEqual([]);
    await r.release();
    await waitFor(() => expect(h.steered).toEqual(["never mind, use main"]));
    // The close is the same finished notice a gateway `request.cancel` lands as.
    // The steer closed the reply off above the prompt, so the card's part is
    // a transcript row now, and the notice went with it.
    const notice = [...h.current.messages, ...(h.current.live ? [h.current.live] : [])]
      .flatMap((m) => m.blocks)
      .find((block) => block.kind === "activity" && block.key === "request:q1");
    expect(notice).toMatchObject({
      kind: "activity",
      category: "notice",
      state: "done",
      request_id: "q1",
      title: "Question skipped",
    });
    expect(h.current.openRequest()).toBe(null);
  });

  test("a skip that fails leaves the card answerable, and the message still goes out", async () => {
    const r = held("throws");
    const h = setup({ respond: r.respond });
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);

    h.say("later");
    await waitFor(() => expect(r.calls).toBe(1));
    await r.release();
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    // Nothing closed the card: the box never let go of the request.
    const all = [...h.current.messages, ...(h.current.live ? [h.current.live] : [])];
    expect(all.some((m) => closedRequests(m.blocks).has("q1"))).toBe(false);
    expect(h.current.openRequest()).toBe("q1");
  });

  test("a message typed in one conversation is not sent into another chosen during the skip", async () => {
    const r = held();
    const h = setup({ respond: r.respond });
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);

    h.sayNow("for atlas only");
    await waitFor(() => expect(r.calls).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "pick other" }));
    await waitFor(() => expect(h.current.selection?.bot).toBe("other"));
    await r.release();
    // Neither steered, sent nor queued — here or there.
    expect(h.steered).toEqual([]);
    expect(h.sent).toEqual(["first"]);
    expect(h.rows()).toHaveLength(0);
    expect(h.current.draft).toBe("");
    // The words wait in the first conversation's draft, and its card is closed.
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    await waitFor(() => expect(h.current.selection?.bot).toBe("default"));
    expect(h.current.draft).toBe("for atlas only");
    expect(h.input().value).toBe("for atlas only");
    expect(h.current.openRequest()).toBe(null);
  });

  test("a question in a part of the reply a steer closed off is still skipped", async () => {
    let handle!: ReturnType<typeof setup>;
    const r = responder(() => handle);
    handle = setup({ respond: r.respond });
    const h = handle;
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);
    // A steer that reached the box without passing through this composer —
    // the store's own call — closes the reply off with the card in it.
    await act(async () => {
      h.current.sendNow("aside");
    });
    await waitFor(() => expect(h.steered).toEqual(["aside"]));
    expect(h.current.live).toBe(null);
    const part = () => h.current.messages.find((m) => m.blocks.some((b) => b.kind === "question"));
    expect(part()).toBeDefined();

    h.say("later");
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    expect(r.log.map((e) => e.decision)).toEqual([{ request_id: "q1", kind: "question", skip: true }]);
    // Settled where the card is: in the closed-off part.
    expect(closedRequests(part()!.blocks).has("q1")).toBe(true);
  });

  test("an expired skip still lets the message through", async () => {
    const h = setup({ respond: async () => ({ status: "expired" }) });
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);
    h.sayNow("go on");
    await waitFor(() => expect(h.steered).toEqual(["go on"]));
  });

  test("a question the box already closed is not skipped", async () => {
    let handle!: ReturnType<typeof setup>;
    const r = responder(() => handle);
    handle = setup({ respond: r.respond });
    const h = handle;
    await h.open();
    h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    await h.block(question);
    await h.block({
      kind: "activity",
      category: "notice",
      key: "request:q1",
      request_id: "q1",
      state: "done",
      title: "Request withdrawn",
    });

    h.sayNow("carry on");
    await waitFor(() => expect(h.steered).toEqual(["carry on"]));
    expect(r.log).toEqual([]);
  });
});
