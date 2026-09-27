/**
 * The chat view, driven (§9.2): the rail, the banners and the
 * states.
 *
 * `chat-logic.test.ts` owns the rules and `chat-blocks.dom.test.tsx` owns the
 * nine renderers; this and its two siblings own the wiring. The turn and the
 * reconnect path are in `chat-view-turn.dom.test.tsx`, the persistent entry
 * frames and their keyboard order in `chat-view-entry.dom.test.tsx`. Two of
 * the behaviours here are called out by the plan by name:
 *
 * **The origin banner fires on every foreign origin.** A reply into a `channel`
 * session leaves the tailnet and lands in somebody's Slack; the composer has to
 * say so above the input, undismissibly.
 *
 * **An unreachable box keeps its bucket, read-only.** It does not vanish, and
 * its header is not a control that pretends to open.
 *
 * The four calls are injected (`chat-fixtures.tsx`) rather than stubbed on
 * `fetch`: this is a test about the provider's state machine, and a fake that
 * records its own calls is what makes "the transcript was read again"
 * assertable.
 */
import { act, cleanup, fireEvent, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessageView, ChatSwarmsResult } from "../src/api/index.ts";
import type { Destination } from "../src/chat/chat-logic.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { ListeningProvider } from "../src/state/listening-state.tsx";
import { Thread } from "../src/chat/components/Thread.tsx";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";
import {
  botOf,
  harness,
  messageOf,
  mount,
  NOW,
  PORTAL,
  sendable,
  sessionOf,
  swarmOf,
} from "./chat-fixtures.tsx";
import type { Turn } from "./chat-fixtures.tsx";

afterEach(cleanup);

// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

/* ── off the tailnet, or just a silent box (§9.2) ────────────────────────── */

describe("telling a dead laptop from a dead box", () => {
  const silent = () =>
    swarmOf("atlas", { reachable: false, bots: [], unreachable_reason: "CHAT_UNREACHABLE: no route" });

  test("every box silent plus a broken local tailscale is `no route to the tailnet`", async () => {
    const h = harness({ swarms: [silent()] });
    h.localTailscale = { ok: false, detail: "tailscale is installed but stopped; run `tailscale up`" };
    mount(h);
    // The pane names the fix, in `doctor`'s own words, because that is the only
    // part of it the operator does not already know.
    await waitFor(() => expect(screen.getByText(/Can't reach the agents/)).toBeDefined());
    expect(screen.getByText(/run `tailscale up`/)).toBeDefined();
    expect(h.doctorCalls).toBe(1);
  });

  test("every box silent with a healthy local tailscale is not blamed on the laptop", async () => {
    // Thirteen stopped boxes look identical from here. Saying "no route to the
    // tailnet" would send the operator to fix a machine that is fine.
    const h = harness({ swarms: [silent()] });
    h.localTailscale = { ok: true, detail: "tailscale: acme.ts.net, HTTPS certificates on" };
    mount(h);
    await waitFor(() => expect(h.doctorCalls).toBe(1));
    await waitFor(() => expect(screen.queryByText(/Can't reach the agents/)).toBeNull());
  });

  test("a `doctor` that could not run leaves the question open rather than guessing", async () => {
    const h = harness({ swarms: [silent()] });
    h.localTailscale = null;
    mount(h);
    await waitFor(() => expect(h.doctorCalls).toBe(1));
    await waitFor(() => expect(screen.queryByText(/Can't reach the agents/)).toBeNull());
  });

  test("a switched-off fleet is reported as switched off, not as an empty one", async () => {
    // "No box in this fleet has a bot to talk to yet" describes a fleet that
    // was never set up. This one is set up and not running, and the fleet view
    // is where that is answered.
    const h = harness({ swarms: [silent()] });
    h.localTailscale = { ok: true, detail: "tailscale: acme.ts.net, HTTPS certificates on" };
    mount(h);
    await waitFor(() => expect(screen.getByText(/No box answered/)).toBeDefined());
    expect(screen.queryByText(/has a bot to talk to yet/)).toBeNull();
  });

  test("a laptop that drops off the tailnet mid-session is still diagnosed", async () => {
    /**
     * The roster is what `fleetUnreachable` is derived from, so a view that
     * read it once on mount can never notice the tailnet going away underneath
     * it: the operator gets a reconnect loop and a raw error instead of the
     * pane that names the fix. This drives the re-read directly; in the portal
     * a timer does it (`ROSTER_INTERVAL_MS`), and a reconnect that gives up
     * does it immediately.
     */
    const h = harness({ swarms: [swarmOf("atlas")] });
    h.localTailscale = { ok: false, detail: "tailscale is installed but stopped; run `tailscale up`" };
    // A holder rather than a bare `let`, so the compiler does not narrow a
    // variable only ever assigned from inside a component it cannot see called.
    const held: { store: Chat | null } = { store: null };
    function Probe() {
      held.store = useChat();
      return null;
    }
    render(
      <ChatProvider api={h.api}>
        <Probe />
        <ChatView />
      </ChatProvider>,
    );
    // Settled, not merely mounted: a transcript read still in flight leaves the
    // thread drawing an empty pane, and an assertion taken there is about the
    // test's own timing rather than about the diagnosis.
    await waitFor(() => expect(held.store?.historyRead).toBe(true));
    expect(h.doctorCalls).toBe(0);
    expect(screen.queryByText(/Can't reach the agents/)).toBeNull();

    // The tailnet goes away. The browser's hop to the portal is loopback and
    // keeps working, so this is exactly what the next roster read looks like.
    h.swarms = [silent()];
    await act(async () => {
      await (held.store as Chat).refreshSwarms();
    });
    await waitFor(() => expect(screen.getByText(/run `tailscale up`/)).toBeDefined());
    expect(h.doctorCalls).toBe(1);
  });

  test("a second outage asks again rather than trusting the first answer", async () => {
    const h = harness({ swarms: [silent()] });
    h.localTailscale = { ok: true, detail: "tailscale: acme.ts.net, HTTPS certificates on" };
    // A holder rather than a bare `let`, so the compiler does not narrow a
    // variable only ever assigned from inside a component it cannot see called.
    const held: { store: Chat | null } = { store: null };
    function Probe() {
      held.store = useChat();
      return null;
    }
    render(
      <ChatProvider api={h.api}>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(h.doctorCalls).toBe(1));

    // A box comes back, which is what ends an outage.
    h.swarms = [swarmOf("atlas")];
    await act(async () => {
      await (held.store as Chat).refreshSwarms();
    });
    await waitFor(() => expect(held.store?.fleetUnreachable).toBe(false));

    // And goes again. The old answer is not reused.
    h.swarms = [silent()];
    await act(async () => {
      await (held.store as Chat).refreshSwarms();
    });
    await waitFor(() => expect(h.doctorCalls).toBe(2));
  });

  test("a fleet that answered is never asked about the laptop at all", async () => {
    const h = harness({ swarms: [swarmOf("atlas")] });
    mount(h);
    await waitFor(() => expect(h.calls.history).toBeGreaterThan(0));
    expect(h.doctorCalls).toBe(0);
  });
});

/* ── what the inbox is told (§4.9) ────────────────────────────────────────── */

describe("the thread on screen is reported to the inbox", () => {
  /** An inbox with nothing in it and no roster tick; this is about one field. */
  const notifyApi: NotifyApi = {
    fetchNotifications: () =>
      Promise.resolve({ notifications: [], unread: 0, needs_action: 0, mutes: [] } as never),
    ackNotification: () => Promise.resolve({ acked: 0 } as never),
    muteNotification: () => Promise.resolve({ mutes: [] } as never),
  };

  function Probe() {
    const notify = useNotify();
    return (
      <output data-testid="watching">
        {notify.watching
          ? `${notify.watching.instance}/${notify.watching.bot}:${notify.watching.focused}`
          : "none"}
      </output>
    );
  }

  test("the selected thread reaches the inbox, and a window nobody is looking at is not watching", async () => {
    const h = harness({ swarms: [swarmOf("atlas")] });
    // Said outright rather than inherited from whatever the harness's document
    // happens to report: "nobody is looking" is the window not having focus,
    // and the assertion below is about that fact rather than about happy-dom's
    // idea of one.
    const hadFocus = document.hasFocus;
    document.hasFocus = () => false;
    try {
      render(
        <NotifyProvider api={notifyApi}>
          <Probe />
          <ChatProvider api={h.api}>
            <ChatView />
          </ChatProvider>
        </NotifyProvider>,
      );
      // The rail lands the operator on a bot, and that choice is what the toast
      // gate reads. `focused` is false because nobody is looking — which is the
      // rule, not an artefact: a chat view nobody is looking at suppresses
      // nothing.
      await waitFor(() => expect(screen.getByTestId("watching").textContent).toBe("atlas/atlas:false"));
    } finally {
      document.hasFocus = hadFocus;
    }
  });

  test("unmounting the chat view clears it, so every toast comes back", async () => {
    const h = harness({ swarms: [swarmOf("atlas")] });
    function Shell({ open }: { open: boolean }) {
      return (
        <NotifyProvider api={notifyApi}>
          <Probe />
          <ChatProvider api={h.api}>{open ? <ChatView /> : null}</ChatProvider>
        </NotifyProvider>
      );
    }
    const { rerender } = render(<Shell open />);
    await waitFor(() => expect(screen.getByTestId("watching").textContent).not.toBe("none"));
    rerender(<Shell open={false} />);
    await waitFor(() => expect(screen.getByTestId("watching").textContent).toBe("none"));
  });
});

/* ── the rail ────────────────────────────────────────────────────────────── */

describe("the rail", () => {
  test("draws one bucket per instance and lands the operator on a bot", async () => {
    const h = harness({ swarms: [swarmOf("atlas"), swarmOf("corvid")] });
    const { container } = mount(h);
    await waitFor(() => expect(container.querySelectorAll(".ch-bucket").length).toBe(2));
    // The first selection is made for the operator: the rail's order already
    // puts the bot that wants attention first.
    await waitFor(() => expect(h.calls.history).toBeGreaterThan(0));
    expect(container.querySelector(".ch-conv[aria-current]")).not.toBeNull();
  });

  test("an unreachable box keeps its bucket, striped, read-only, with its reason on it", async () => {
    const h = harness({
      swarms: [
        swarmOf("atlas"),
        swarmOf("ember", { reachable: false, unreachable_reason: "off the tailnet", bots: [] }),
      ],
    });
    const { container } = mount(h);
    const offline = await waitFor(() => {
      const node = container.querySelector(".ch-bucket.offline");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(offline.textContent).toContain("off the tailnet");
    expect(offline.textContent).toContain("last known");
    // Read-only: a header that pretends to open is worse than a label.
    expect(offline.tagName.toLowerCase()).toBe("div");
  });

  test("the `needs you` filter narrows the roster and keeps the offline box", async () => {
    const h = harness({
      swarms: [
        swarmOf("atlas"),
        swarmOf("corvid", { bots: [botOf("corvid", "corvid", { needs_action: true })] }),
        swarmOf("ember", { reachable: false, bots: [] }),
      ],
    });
    const { container } = mount(h);
    await waitFor(() => expect(container.querySelectorAll(".ch-bucket").length).toBe(3));
    await userEvent.click(screen.getByRole("button", { name: "Needs you" }));
    const buckets = [...container.querySelectorAll(".ch-bucket")].map((b) => b.textContent ?? "");
    expect(buckets.some((t) => t.includes("corvid"))).toBe(true);
    expect(buckets.some((t) => t.includes("ember"))).toBe(true);
    expect(buckets.some((t) => t.includes("atlas"))).toBe(false);
  });

  test("the scope switcher drops the buckets and promotes the box's own sections", async () => {
    const h = harness({
      swarms: [
        swarmOf("atlas", {
          sections: ["Clients"],
          bots: [botOf("atlas", "atlas"), botOf("atlas", "acme", { section: "Clients" })],
        }),
        swarmOf("corvid"),
      ],
    });
    const { container } = mount(h);
    await waitFor(() => expect(container.querySelectorAll(".ch-bucket").length).toBe(2));
    await userEvent.click(container.querySelector("button.ch-scope") as HTMLElement);
    expect(container.querySelectorAll(".ch-bucket")).toHaveLength(0);
    expect(container.querySelector(".ch-section")?.textContent).toContain("Clients");
  });
});

/* ── the origin banner ───────────────────────────────────────────────────── */

describe("the destination banner", () => {
  test("a portal session says nothing above the input", async () => {
    const h = harness();
    const { container } = mount(h);
    await waitFor(() => expect(h.calls.sessions).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector(".ch-composer")).not.toBeNull());
    expect(container.querySelector(".ch-composer .ch-band")).toBeNull();
  });

  test("a channel session restates the destination, above the input, undismissibly", async () => {
    const h = harness({
      sessions: [sessionOf({ origin: "channel", origin_detail: "#acme-support" })],
    });
    const { container } = mount(h);
    // Waiting for the band to *exist* is not enough: the composer draws one
    // while the session read is still in flight ("reading which conversation
    // this is"), so a bare existence check can win the race against the read it
    // is waiting for. Wait for the band this test is about.
    const band = await waitFor(() => {
      const node = container.querySelector(".ch-composer .ch-band");
      expect(node?.textContent ?? "").toContain("leaves the tailnet");
      return node as HTMLElement;
    });
    expect(band.textContent).toContain("#acme-support");
    // Undismissible by construction: there is no control in it to dismiss with.
    expect(within(band).queryAllByRole("button")).toHaveLength(0);
  });

  test("a peer session says the reply answers a robot", async () => {
    const h = harness({ sessions: [sessionOf({ origin: "peer", origin_detail: "granite@atlas" })] });
    const { container } = mount(h);
    await waitFor(() =>
      expect(container.querySelector(".ch-composer .ch-band")?.textContent).toContain("robot"),
    );
  });
});

describe("the banner during and after a failed session read", () => {
  test("the composer is not sendable while the session read is still open", async () => {
    // Asserted *against the pending promise*, which is the window the defect
    // lived in: `session` is null, and a bare `origin ?? \"portal\"` rendered no
    // band over an enabled composer. Every other banner test waits for the read
    // to land and so cannot see this.
    const h = harness({ sessions: [sessionOf({ origin: "channel", origin_detail: "#acme-support" })] });
    h.sessionsMode = "hang";
    const { container } = mount(h);
    await waitFor(() => expect(container.querySelector(".ch-input")).not.toBeNull());

    const input = container.querySelector(".ch-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    await userEvent.type(input, "draft while loading{Enter}");
    expect(input.value).toBe("draft while loading");
    expect((screen.getByTitle(/Send/) as HTMLButtonElement).disabled).toBe(true);
    expect(h.calls.send).toBe(0);
    // And it does not claim to be a portal session while it does not know.
    expect(container.querySelector(".ch-composer .ch-band")).not.toBeNull();
    expect(container.querySelector(".ch-origin.portal")).toBeNull();

    await act(async () => {
      h.releaseSessions?.();
    });
    await waitFor(() =>
      expect(container.querySelector(".ch-composer .ch-band")?.textContent).toContain(
        "leaves the tailnet",
      ),
    );
    expect((container.querySelector(".ch-input") as HTMLTextAreaElement).disabled).toBe(false);
  });

  test("a rejected session read does not leave the thread presenting as portal", async () => {
    // The old code swallowed the rejection into `setSessions([])`, which made
    // the `portal` fallback permanent for the thread — a foreign destination
    // silently presenting as local, for as long as the tab stayed open.
    const h = harness();
    h.sessionsMode = "reject";
    const { container } = mount(h);
    await waitFor(() => expect(container.querySelector(".ch-composer .ch-band.bad")).not.toBeNull());
    expect(container.querySelector(".ch-origin.portal")).toBeNull();
    expect((container.querySelector(".ch-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect(container.querySelector(".ch-composer .ch-band")?.textContent).toContain(
      "could not read where a reply would go",
    );
  });
});

/* ── stopping a turn ─────────────────────────────────────────────────────── */

test("stop does not report itself as a dropped box", async () => {
  // Core's generator returning closes the SSE response without a `done`, which
  // is byte-for-byte what a box going away looks like — so an intentional stop
  // used to raise "Reconnecting…" and lock the composer.
  const h = harness();
  const { container } = mount(h);
  await userEvent.type(await sendable(container), "hello");
  await userEvent.click(screen.getByTitle(/Send/));

  await userEvent.click(screen.getByRole("button", { name: /Stop turn/ }));
  expect(h.calls.abort).toBe(1);
  expect((h.turns[0] as Turn).cancelled).toBe(true);
  await waitFor(() => expect(screen.queryByText(/Reconnecting/)).toBeNull());
  expect((container.querySelector(".ch-input") as HTMLTextAreaElement).disabled).toBe(false);
});

test("abort carries the durable session and keeps ownership until its independent response arrives", async () => {
  const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")] });
  let release: (() => void) | null = null;
  const addresses: unknown[] = [];
  h.api.abortTurn = (instance, bot, session) => {
    h.calls.abort++;
    addresses.push({ instance, bot, session });
    return new Promise((resolve) => {
      release = () => resolve({ instance, bot, aborted: true } as never);
    });
  };
  const { container } = mount(h);
  await userEvent.type(await sendable(container), "first");
  await userEvent.click(screen.getByTitle(/Send/));
  await userEvent.click(screen.getByRole("button", { name: /Stop turn/ }));
  expect(addresses).toEqual([{ instance: "atlas", bot: "atlas", session: "s1" }]);
  expect(h.turns[0]!.cancelled).toBe(false);
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  await userEvent.type(await sendable(container), "next draft");
  fireEvent.keyDown(await sendable(container), { key: "Enter" });
  // The abort has not answered, so the turn is still in flight and Enter
  // queues (§9.2 one active turn, sending waits) instead of sending.
  expect(h.calls.send).toBe(1);
  expect((await sendable(container)).value).toBe("");
  expect(container.querySelector(".ch-queue-row")?.textContent).toContain("next draft");
  const granite = Array.from(container.querySelectorAll<HTMLButtonElement>(".ch-conv")).find((row) =>
    row.textContent?.includes("granite"),
  )!;
  await userEvent.click(granite);
  expect(granite.getAttribute("aria-current")).toBe("true");
  await userEvent.type(await sendable(container), "parallel granite");
  fireEvent.keyDown(await sendable(container), { key: "Enter" });
  expect(h.calls.send).toBe(2);
  await act(async () => release?.());
  expect(h.turns[0]!.cancelled).toBe(true);
  expect(h.turns[1]!.cancelled).toBe(false);
  const atlas = Array.from(container.querySelectorAll<HTMLButtonElement>(".ch-conv")).find((row) =>
    row.textContent?.includes("atlas"),
  )!;
  await userEvent.click(atlas);
  // The queue is per conversation, so atlas's backlog came back with it; Stop
  // parked it, and a deliberate send is what releases it.
  expect(container.querySelector(".ch-queue-row")?.textContent).toContain("next draft");
  await userEvent.type(await sendable(container), "back on atlas");
  fireEvent.keyDown(await sendable(container), { key: "Enter" });
  expect(h.calls.send).toBe(3);
});

/* ── the thread states ──────────────────────────────────────────────────────── */

describe("the roster's first read", () => {
  test("a listened instance shows a loading state, not `Choose a bot`, until the roster answers", async () => {
    const h = harness({ swarms: [] });
    const held: (() => void)[] = [];
    h.api.fetchSwarms = () =>
      new Promise<ChatSwarmsResult>((resolve) => {
        held.push(() => resolve({ swarms: h.swarms } as ChatSwarmsResult));
      });
    render(
      <ListeningProvider
        api={{
          fetchListening: async () => ({ instances: ["atlas"] }),
          setInstanceListening: async () => ({ instances: ["atlas"] }),
        }}
      >
        <ChatProvider api={h.api}>
          <ChatView />
        </ChatProvider>
      </ListeningProvider>,
    );
    await waitFor(() => expect(screen.getByText("Loading bots…")).toBeDefined());
    expect(screen.queryByText("Choose a bot")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to fleet" })).toBeNull();
    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    await waitFor(() => expect(screen.getByText("Choose a bot")).toBeDefined());
    expect(screen.queryByText("Loading bots…")).toBeNull();
    expect(screen.getByRole("button", { name: "Go to fleet" })).toBeDefined();
  });
});

describe("the states", () => {
  const base = {
    fleetId: "fxtr0001",
    instance: "atlas",
    bot: "atlas",
    agent: null,
    session: null,
    destination: PORTAL,
    messages: [],
    live: null,
    sending: false,
    historyError: null,
    now: NOW,
    onSend: () => {},
    onAbort: () => {},
  };

  test("an empty thread invites a first message rather than showing a blank log", () => {
    const { container } = render(<Thread {...base} state="empty" />);
    expect(container.querySelector(".ch-empty")).not.toBeNull();
    expect(screen.getByText("Nothing said yet")).toBeDefined();
    expect((container.querySelector(".ch-input") as HTMLTextAreaElement).disabled).toBe(false);
  });

  test("a stopped agent is read-only, and the composer says why", () => {
    const { container } = render(<Thread {...base} state="stopped" />);
    expect(container.querySelector(".ch-band.warn")?.textContent).toContain("is stopped");
    const input = container.querySelector(".ch-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toContain("start it");
  });

  test("a box still bootstrapping accepts a message, because it is queued", () => {
    const { container } = render(<Thread {...base} state="bootstrapping" />);
    expect(screen.getByText("Not listening yet")).toBeDefined();
    expect((container.querySelector(".ch-input") as HTMLTextAreaElement).disabled).toBe(false);
  });

  test("no tailnet says what still works, which is almost everything", () => {
    const { container } = render(<Thread {...base} state="no_tailnet" />);
    expect(container.querySelector(".ch-band.bad")?.textContent).toContain("No route to the tailnet");
    expect(screen.getByText("Can't reach the agents")).toBeDefined();
    expect(container.textContent).toContain("go through AWS");
  });

  test("a dropped stream says the transcript is being re-read", () => {
    const { container } = render(<Thread {...base} state="dropped" />);
    expect(container.querySelector(".ch-band")?.textContent).toContain("Reconnecting");
    expect((container.querySelector(".ch-input") as HTMLTextAreaElement).disabled).toBe(true);
  });

  test("a destroyed agent is terminal, and says the volume outlived it", () => {
    const { container } = render(<Thread {...base} state="destroyed" />);
    expect(container.querySelector(".ch-band.acc")?.textContent).toContain("is gone");
    expect((container.querySelector(".ch-input") as HTMLTextAreaElement).placeholder).toContain(
      "read-only",
    );
  });

  test("fixture mode says the transcripts are canned", () => {
    render(<Thread {...base} state="ready" fixture />);
    expect(screen.getByText("canned")).toBeDefined();
  });

  test("a transcript that would not read reports the failure instead of an empty log", () => {
    const { container } = render(<Thread {...base} state="ready" historyError="the box refused" />);
    expect(container.querySelector(".ch-band.bad")?.textContent).toContain("the box refused");
  });

  // Desktop's `user-message-text.tsx:8-15` deliberately runs operator text
  // through only backtick code spans and fenced blocks, never its full
  // markdown/KaTeX pipeline — so `$x = 1$` and `***bold italic***`, typed by a
  // person, show as the characters typed rather than a formula or styled
  // emphasis. Bot/assistant text is untouched: same source string, full
  // pipeline, still styled.
  test("operator text skips markdown/KaTeX; bot text keeps the full pipeline", () => {
    const raw = "$x = 1$ and ***bold italic*** and `code`";
    const messages: ChatMessageView[] = [
      messageOf({ id: "u1", role: "user", blocks: [{ kind: "text", markdown: raw }] }),
      messageOf({ id: "b1", role: "bot", blocks: [{ kind: "text", markdown: raw }] }),
    ];
    const { container } = render(<Thread {...base} state="ready" messages={messages} />);

    const articles = container.querySelectorAll("article.ch-msg");
    const userArticle = [...articles].find((a) => a.classList.contains("me"))!;
    const botArticle = [...articles].find((a) => !a.classList.contains("me"))!;

    expect(userArticle.textContent).toContain("$x = 1$");
    expect(userArticle.textContent).toContain("***bold italic***");
    expect(userArticle.querySelector("em")).toBeNull();
    expect(userArticle.querySelector("strong")).toBeNull();
    expect(userArticle.querySelector(".ch-math")).toBeNull();
    expect(userArticle.querySelector("code")?.textContent).toBe("code");

    expect(botArticle.querySelector("em")).not.toBeNull();
    expect(botArticle.querySelector("strong")).not.toBeNull();
    expect(botArticle.querySelector(".ch-math.rendered")).not.toBeNull();
    expect(botArticle.querySelector("code")?.textContent).toBe("code");
  });
});

/* ── the origin badge in the thread header ───────────────────────────────── */

/**
 * The badge next to the bot's name is the banner's claim in four characters.
 * Upstream Hermes stamps every websocket client `source: "tui"`, so the portal
 * creating the canonical Bot Chat reads back as `cli`; on a session where
 * nothing has been said that names a client which does not exist. The banner
 * was already silenced for it; the badge is silenced by the same predicate
 * (`hasKnownOrigin`).
 */
describe("the origin badge", () => {
  const CLI: Destination = { state: "known", origin: "cli", detail: null };
  const base = {
    fleetId: "fxtr0001",
    instance: "atlas",
    bot: "atlas",
    agent: null,
    destination: CLI,
    live: null,
    sending: false,
    historyError: null,
    now: NOW,
    onSend: () => {},
    onAbort: () => {},
  };

  test("an empty canonical session shows no origin chip in the header", () => {
    const { container } = render(
      <Thread {...base} state="empty" session={sessionOf({ origin: "cli" })} messages={[]} />,
    );
    expect(container.querySelector(".ch-thead .ch-origin")).toBeNull();
    // And the composer says nothing either — one predicate, both surfaces.
    expect(container.querySelector(".ch-composer .ch-band")).toBeNull();
    // The rest of the sub-line is still there; only the chip and its separator go.
    expect(container.querySelector(".ch-thead-sub")?.textContent).toContain("Bot Chat");
  });

  test("the same session with a message in it keeps the chip", () => {
    const { container } = render(
      <Thread
        {...base}
        state="ready"
        session={sessionOf({ origin: "cli" })}
        messages={[messageOf()]}
      />,
    );
    expect(container.querySelector(".ch-thead .ch-origin.cli")).not.toBeNull();
    expect(container.querySelector(".ch-composer .ch-band")?.textContent).toContain("another client");
  });

  test("an empty session that is not the canonical one keeps the chip", () => {
    const { container } = render(
      <Thread
        {...base}
        state="empty"
        session={sessionOf({ origin: "cli", kind: "thread" })}
        messages={[]}
      />,
    );
    expect(container.querySelector(".ch-thead .ch-origin.cli")).not.toBeNull();
  });
});
