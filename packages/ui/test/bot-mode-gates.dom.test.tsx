/**
 * Who the Bot Mode gates are attributed to, and what Escape costs.
 *
 * Three things here are only true at runtime, and a fixture-mode QA pass found
 * all three wrong.
 *
 * **A Hermetic gate is not a gateway limitation.** The capability probe reports
 * the hosted-room feature set a gateway advertises; `membership_edit` is false
 * because this repo has not implemented and qualified member editing. The
 * create-room dialog said so. The two surfaces an operator actually meets — the
 * members panel of an open room and its Manage room dialog — blamed "this Hermes
 * version" and "this gateway" instead, which is a claim about the box that the
 * probe contradicts. All three now render the same `GatedNote` with the same
 * sentence.
 *
 * **A declared gate that renders nowhere says nothing.**
 * `HERMETIC_GATES.cross_instance_relay` existed with no caller. The members
 * panel is the one surface that names each member's instance, so it is where
 * "can this room reach a bot on another box" is asked, and where the answer now
 * is.
 *
 * **Escape closes the panel and stops.** The side panel is a class on the
 * workspace, not a focus trap, so `hasOpenOverlay()` does not cover it and the
 * shell's own Escape handlers ran too — dismissing Members also
 * left the chat view. The handler now consumes the keystroke, and only when a
 * panel is open and no Bot Mode dialog is over it.
 *
 * What is *not* provable here: the dialog's overflow clamp. happy-dom applies
 * the cascade but does no layout, so this file can assert the rule that removes
 * the cyclic track sizing and nothing about pixels. Whether the dialog's notes
 * are actually in view is measured in headless Chrome against the fixture
 * portal (Chat → Conversations → New group room); that measurement is the real
 * proof and belongs to the browser QA pass, not to this suite.
 *
 * Room calls are stubbed at the transport (`fake-transport.ts`) and the four chat calls
 * are injected through `ChatProvider`'s `api` prop, the way the rest of this
 * suite fakes a server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "./dom.ts";
import type { ChatSwarmsResult, SwarmView } from "../src/api/index.ts";
import { HERMETIC_GATES } from "../src/chat/bot-capabilities.ts";
import { ChatProvider } from "../src/chat/chat-state.tsx";
import type { ChatApi } from "../src/chat/chat-state.tsx";
import { BotWorkspace } from "../src/chat/components/BotWorkspace.tsx";
import { resetBotCapabilityMemo } from "../src/chat/bot-capabilities.ts";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";

afterEach(cleanup);
// Same instance, different capability answers per case: drop the hook's memo.
afterEach(resetBotCapabilityMemo);
// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

const AT = "2026-09-18T12:00:00Z";
const INSTANCE = "atlas";
const ROOM = { id: "room-a", name: "Triage" };

function detailOf() {
  return {
    instance: INSTANCE,
    id: ROOM.id,
    name: ROOM.name,
    members: [{ member_id: "atlas", profile: "atlas", handle: "atlas", display_name: "Atlas" }],
    revision: 1,
    latest_seq: 0,
    created_at: AT,
    updated_at: AT,
    disbanded_at: null,
    working: false,
    blocked: false,
    pending_actions: [],
  };
}

function swarmOf(): SwarmView {
  return {
    instance: INSTANCE,
    reachable: true,
    unreachable_reason: null,
    bots: [
      {
        instance: INSTANCE,
        name: INSTANCE,
        title: INSTANCE,
        description: "the box",
        is_default: true,
        model: null,
        section: null,
        avatar_seed: `${INSTANCE}/${INSTANCE}`,
        last_message_at: AT,
        unread: 0,
        needs_action: false,
        muted: false,
        warm: true,
      },
    ],
    rooms: [
      {
        id: ROOM.id,
        name: ROOM.name,
        instance: INSTANCE,
        members: [{ instance: INSTANCE, bot: INSTANCE }],
        needs_action: false,
      },
    ],
    warm_slots: { used: 1, total: 3 },
    sections: [],
  } as unknown as SwarmView;
}

const chatApi = (swarms: SwarmView[]): ChatApi => ({
  fetchSwarms: () => Promise.resolve({ swarms } as ChatSwarmsResult),
  fetchSessions: (instance: string, bot: string) =>
    Promise.resolve({ instance, bot, sessions: [] } as never),
  fetchHistory: (instance: string, bot: string) =>
    Promise.resolve({ instance, bot, session: null, messages: [] } as never),
  sendTurn: () => () => {},
  abortTurn: () => Promise.resolve({} as never),
});

/**
 * Mounts the workspace over a fake gateway. The wait for the canonical thread is
 * load-bearing: the workspace drops the open room whenever the bot selection
 * changes, and the provider selects a bot of its own accord as the roster
 * arrives, so a room opened before then would be closed again by that selection.
 */
async function mount(): Promise<FakeServer> {
  const server = fakeServer({
    "rooms.get": () => detailOf(),
    "rooms.history": (call: TransportCall) => {
      const body = call.params as { since_seq: number };
      return { events: [], cursor: body.since_seq, has_more: false };
    },
  });
  render(
    <ChatProvider api={chatApi([swarmOf()])}>
      <BotWorkspace withContext={false} />
    </ChatProvider>,
  );
  await screen.findByText(/Canonical Bot Chat/);
  return server;
}

/** Opens the room from the rail and waits for its pane to accept a message. */
async function openRoom(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(ROOM.name) }));
  await screen.findByLabelText("Message the room");
}

function workspace(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".bm-workspace");
  if (!found) throw new Error("the workspace did not render");
  return found;
}

/** The room's members panel, which is also where the room's gates are stated. */
function membersPanel(): HTMLElement {
  const found = document.querySelector<HTMLElement>("aside.bm-jobs");
  if (!found) throw new Error("the members panel did not render");
  return found;
}

/** Which side panel the workspace is showing, read the way the CSS reads it. */
function shownPanel(): string | null {
  return (
    Array.from(workspace().classList)
      .find((name) => name.startsWith("bm-show-"))
      ?.slice("bm-show-".length) ?? null
  );
}

/**
 * Presses Escape the way the browser delivers it and reports whether the shell
 * would still have seen it. The listener is on `window` in the bubble phase —
 * exactly where `App` installs its own — so "never called" is the same fact as
 * "the shell's Escape handler did not run".
 */
function pressEscape(): { reachedShell: boolean } {
  let reachedShell = false;
  const spy = () => {
    reachedShell = true;
  };
  window.addEventListener("keydown", spy);
  try {
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
  } finally {
    window.removeEventListener("keydown", spy);
  }
  return { reachedShell };
}

describe("a Hermetic gate is attributed to Hermetic wherever it is met", () => {
  let server: FakeServer | null = null;
  afterEach(() => {
    server?.restore();
    server = null;
  });

  test("the members panel credits Hermetic, not the Hermes version on the box", async () => {
    server = await mount();
    await openRoom();
    const said = membersPanel().textContent ?? "";
    expect(membersPanel().querySelectorAll("p.bm-gated").length).toBeGreaterThan(0);
    expect(said).toContain("Gated in Hermetic");
    expect(said).toContain(HERMETIC_GATES.membership_edit);
    // The probe reports what the gateway advertises; the withholding is ours.
    expect(said).not.toMatch(/Hermes version/i);
    expect(said).not.toMatch(/gateway/i);
    // The parts worth keeping are still there.
    expect(said).toContain(`Hosted on ${INSTANCE}`);
    expect(said).toContain("Discussion continues with this browser closed");
  });

  test("the Manage room dialog credits Hermetic, not the gateway", async () => {
    server = await mount();
    await openRoom();
    fireEvent.click(screen.getByRole("button", { name: "Manage room" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage room" });
    const said = dialog.textContent ?? "";
    expect(dialog.querySelectorAll("p.bm-gated").length).toBeGreaterThan(0);
    expect(said).toContain("Gated in Hermetic");
    expect(said).toContain(HERMETIC_GATES.membership_edit);
    expect(said).not.toMatch(/gateway/i);
    expect(said).not.toMatch(/Hermes version/i);
    // The advice that survives the re-attribution.
    expect(said).toContain("create another room; this history is preserved");
  });

  test("the two room surfaces say the membership gate in the create dialog's words", async () => {
    server = await mount();
    await openRoom();
    const panelNotes = [...membersPanel().querySelectorAll<HTMLElement>("p.bm-gated")].map(
      (node) => node.textContent ?? "",
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage room" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage room" });
    const dialogNotes = [...dialog.querySelectorAll<HTMLElement>("p.bm-gated")].map(
      (node) => node.textContent ?? "",
    );
    // `GatedNote` owns the prefix and `HERMETIC_GATES` owns the sentence, so
    // this is the same markup and the same string the create dialog renders —
    // whose own copy is pinned by `bot-capabilities.dom.test.tsx`.
    const membership = `Gated in Hermetic \u00b7 ${HERMETIC_GATES.membership_edit}`;
    expect(panelNotes).toContain(membership);
    expect(dialogNotes).toContain(membership);
    for (const note of [...panelNotes, ...dialogNotes]) {
      expect(note.startsWith("Gated in Hermetic \u00b7 ")).toBe(true);
    }
  });

  test("the cross-instance relay gate is on screen, not merely declared", async () => {
    server = await mount();
    await openRoom();
    // The members panel is the one surface that names every member's instance.
    expect(membersPanel().textContent ?? "").toContain(HERMETIC_GATES.cross_instance_relay);
  });
});

describe("Escape closes the open side panel and goes no further", () => {
  let server: FakeServer | null = null;
  afterEach(() => {
    server?.restore();
    server = null;
  });

  test("an open panel closes and the keystroke does not reach the shell", async () => {
    server = await mount();
    await openRoom();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(shownPanel()).toBe("jobs");
    const { reachedShell } = pressEscape();
    // `fireEvent` dispatches inside `act`, so the close has already rendered.
    expect(shownPanel()).toBe(null);
    // The shell's handler is what navigated off `#chat` behind the panel.
    expect(reachedShell).toBe(false);
  });

  test("Escape with no panel open is left to the shell", async () => {
    server = await mount();
    await openRoom();
    expect(shownPanel()).toBe(null);
    expect(pressEscape().reachedShell).toBe(true);
  });

  test("a Bot Mode dialog over a panel keeps Escape for itself", async () => {
    server = await mount();
    await openRoom();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage room" }));
    await screen.findByRole("dialog", { name: "Manage room" });
    pressEscape();
    // The dialog closes on its own window listener; the panel underneath stays.
    // Asserted as a boolean: a failed `toBe(null)` on a live node serialises the
    // whole subtree, which is megabytes of output for one wrong answer.
    expect(screen.queryByRole("dialog", { name: "Manage room" }) === null).toBe(true);
    expect(shownPanel()).toBe("jobs");
  });
});

describe("the Bot Mode dialog can be clamped to the viewport", () => {
  /**
   * The overlay's column, as the cascade resolves it. An implicit `auto` track
   * is sized from its item's max-content contribution, so the 520px dialog made
   * the track 520px and its own `max-width: 100%` resolved against that same
   * 520px — a clamp that could never bite. happy-dom does no layout, so this
   * asserts the declaration that breaks the cycle; the geometry it produces is
   * measured in a browser (see this file's header).
   */
  test("the overlay sizes its column from the container, not from the dialog", async () => {
    const css = await Bun.file(
      new URL("../src/chat/styles/bot-mode.css", import.meta.url).pathname,
    ).text();
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      render(
        <div className="bm-overlay">
          <section className="bm-dialog">clamped</section>
        </div>,
      );
      const overlay = document.querySelector<HTMLElement>(".bm-overlay");
      const dialog = document.querySelector<HTMLElement>(".bm-dialog");
      if (!overlay || !dialog) throw new Error("the overlay did not render");
      // `auto`/`max-content` is the cyclic sizing; anything bounded by the
      // container is not.
      expect(getComputedStyle(overlay).gridTemplateColumns).toBe("minmax(0, 1fr)");
      // Which is what makes the dialog's own clamp mean something.
      expect(getComputedStyle(dialog).maxWidth).toBe("100%");
    } finally {
      style.remove();
    }
  });
});
