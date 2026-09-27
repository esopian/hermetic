/**
 * The chat view, driven: the persistent entry frames and the keyboard order.
 *
 * Split from `chat-view.dom.test.tsx`, which keeps the rail, banners and
 * states; the harness is shared (`chat-fixtures.tsx`). The entry shell is
 * exercised with the real store and compositor. Only its server calls are
 * substituted, so remounts and keyboard propagation are real.
 */
import { act, cleanup, fireEvent, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { useRef } from "react";
import { useFocusTrap } from "../src/lib/focus.ts";
import { harness, mount, sendable, sessionOf, swarmOf } from "./chat-fixtures.tsx";
import type { Harness } from "./chat-fixtures.tsx";
import { useEffect, useState } from "react";
import { ChatShell } from "../src/chat/components/ChatShell.tsx";
import { useChatEntry } from "../src/chat/chat-entry-state.tsx";
import { Drawer } from "../src/components/Drawer.tsx";
import { chatHash } from "../src/chat/chat-routing.ts";

afterEach(cleanup);

// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

function EntryFrames() {
  const chat = useChat();
  const entry = useChatEntry()!;
  const [full, setFull] = useState(window.location.hash.startsWith("#chat"));
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const sync = () => setFull(window.location.hash.startsWith("#chat"));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return (
    <>
      <button type="button" onClick={entry.quickJump}>
        Jump
      </button>
      <button
        type="button"
        onClick={() => entry.open({ instance: "atlas", bot: "atlas", session: "s1" }, "dock")}
      >
        Open explicit
      </button>
      <button
        type="button"
        onClick={() => entry.open({ instance: "granite", bot: "granite", session: null }, "dock")}
      >
        Other bot
      </button>
      <button type="button" onClick={() => setModal(true)}>
        Modal
      </button>
      <output data-testid="selection">{chat.selection ? chatHash(chat.selection) : "none"}</output>
      {full ? <ChatView /> : null}
      {modal ? (
        <Drawer width={500} onClose={() => setModal(false)} labelledBy="test-modal-title">
          <h2 id="test-modal-title">Underlying modal</h2>
          <input aria-label="Modal field" />
        </Drawer>
      ) : null}
    </>
  );
}
function mountEntry(h: Harness) {
  return render(
    <ChatProvider api={h.api} eager={false}>
      <ChatShell>
        <EntryFrames />
      </ChatShell>
    </ChatProvider>,
  );
}
/** A minimal `role="dialog"` on the shared focus stack, for the Escape order. */
function Trapped({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose, true);
  return (
    <div ref={ref} role="dialog" aria-label="Test dialog" tabIndex={-1}>
      <button type="button">ok</button>
    </div>
  );
}

function key(target: Element | Window, name: string, extra: Record<string, boolean> = {}) {
  fireEvent.keyDown(target, { key: name, ...extra });
}

describe("persistent entry frames", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  test("a message link focuses once and Enter queues the next draft without moving focus", async () => {
    window.history.replaceState(
      null,
      "",
      chatHash({ instance: "atlas", bot: "atlas", session: "s1" }, "m1"),
    );
    const h = harness();
    const { container } = mountEntry(h);
    const input = await sendable(container);
    const linked = container.querySelector('[data-chat-message="m1"]');
    await waitFor(() => expect(document.activeElement === linked).toBe(true));
    await userEvent.type(input, "first{Enter}next draft");
    expect(h.calls.send).toBe(1);
    expect(h.turns[0]!.message).toBe("first");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("next draft");
    await userEvent.keyboard("{Enter}");
    // Enter mid-turn queues (§9.2 one active turn, sending waits): the text
    // leaves the input for a row above the composer, nothing goes on the wire,
    // and the caret does not move.
    expect(h.calls.send).toBe(1);
    expect(input.value).toBe("");
    expect(container.querySelector(".ch-queue-row")?.textContent).toContain("next draft");
    expect(document.activeElement).toBe(input);
    await act(async () =>
      h.turns[0]!.handlers.onFrame({ type: "delta", seq: 1, message: "m2", text: "Reply" }),
    );
    expect(document.activeElement).toBe(input);
    const elsewhere = screen.getByText("Jump");
    elsewhere.focus();
    await act(async () => h.turns[0]!.handlers.onEnd(true, null));
    expect(document.activeElement).toBe(elsewhere);
    // The end of the turn drains the row as its own send — and neither the
    // completion nor the send it starts takes focus back.
    await waitFor(() => expect(h.calls.send).toBe(2));
    expect(h.turns[1]!.message).toBe("next draft");
    expect(container.querySelectorAll(".ch-queue-row")).toHaveLength(0);
    expect(document.activeElement).toBe(elsewhere);
  });

  test("lazy provider makes no roster request until quick jump opens, whose keys trap focus", async () => {
    const h = harness();
    mountEntry(h);
    expect(h.calls.swarms).toBe(0);
    key(window, "k", { ctrlKey: true });
    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    key(input, "ArrowDown");
    key(input, "Tab");
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    expect(screen.queryByRole("dialog", { name: "Quick jump" })).toBeNull();
  });

  test("nondefault bot and explicit session preserve the queue and live pipe between dock and full view", async () => {
    const h = harness();
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Open explicit"));
    await userEvent.type(await sendable(container), "first turn");
    key(await sendable(container), "Enter");
    const turn = h.turns[0]!;
    await userEvent.type(await sendable(container), "next draft");
    key(await sendable(container), "Enter");
    expect(h.calls.send).toBe(1);
    // Enter mid-turn queues (§9.2 one active turn), so the thing that has to
    // survive the dock ⇄ full-view switch is the row, not the draft.
    expect((await sendable(container)).value).toBe("");
    expect(container.querySelector(".ch-queue-row")?.textContent).toContain("next draft");
    await act(async () =>
      turn.handlers.onFrame({ type: "delta", seq: 1, message: "live-entry", text: "still streaming" }),
    );
    await userEvent.click(screen.getByLabelText("Expand chat"));
    await waitFor(() => expect(container.querySelector(".ch-dock")).toBeNull());
    expect(container.querySelector(".ch-queue-row")?.textContent).toContain("next draft");
    expect(screen.getByText("still streaming")).toBeDefined();
    expect(turn.cancelled).toBe(false);
    expect(screen.getByTestId("selection").textContent).toBe("#chat/atlas/atlas?session=s1");
    key(await sendable(container), "K", { metaKey: true, shiftKey: true });
    await waitFor(() => expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull());
    expect(container.querySelector(".ch-queue-row")?.textContent).toContain("next draft");
    key(await sendable(container), "Escape");
    await waitFor(() => expect(h.calls.abort).toBe(1));
    // Stop parks the queue rather than draining it: the row stays, unsent.
    await waitFor(() =>
      expect(container.querySelector(".ch-queue-foot")?.textContent).toContain("paused"),
    );
    expect(h.calls.send).toBe(1);
    expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull();
    // Escape with nothing running is a no-op. It used to collapse the dock,
    // which is how a key the composer advertises as `Esc stop` came to hide the
    // conversation the operator was reading.
    key(await sendable(container), "Escape");
    expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull();
    expect(h.calls.abort).toBe(1);
  });

  test("Escape with no turn keeps the conversation on screen, and App never sees it", async () => {
    const h = harness();
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Open explicit"));
    await waitFor(() => expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull());
    // `App`'s own handler closes the topmost *view* and bails on
    // `defaultPrevented`, so a consumed Escape is the whole mechanism keeping
    // the operator in chat. `fireEvent` reports the dispatch as false when the
    // event was cancelled.
    const delivered = fireEvent.keyDown(document.body, { key: "Escape" });
    expect(delivered).toBe(false);
    expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull();
    expect(h.calls.abort).toBe(0);
  });

  test("Escape with a dialog open closes the dialog and nothing else", async () => {
    const h = harness();
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Open explicit"));
    await waitFor(() => expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull());
    let closed = 0;
    render(<Trapped onClose={() => (closed += 1)} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closed).toBe(1);
    expect(h.calls.abort).toBe(0);
    expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull();
  });

  test("dock expansion followed by the dock shortcut before hashchange keeps the composer open", async () => {
    const h = harness();
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Open explicit"));
    await userEvent.type(await sendable(container), "retained draft");
    // A browser updates location immediately but queues hashchange. Keep both
    // user actions in one task so the shortcut runs before that queued event.
    act(() => {
      fireEvent.click(screen.getByLabelText("Expand chat"));
      expect(window.location.hash).toBe("#chat/atlas/atlas?session=s1");
      key(window, "K", { metaKey: true, shiftKey: true });
    });
    await waitFor(() => expect(container.querySelector(".ch-dock:not(.collapsed)")).not.toBeNull());
    expect((await sendable(container)).value).toBe("retained draft");
    expect(h.calls.send).toBe(0);
    expect(screen.getByTestId("selection").textContent).toBe("#chat/atlas/atlas?session=s1");
  });

  test("different targets switch during a turn and scoped drafts return without cancelling", async () => {
    const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")] });
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Open explicit"));
    await userEvent.type(await sendable(container), "start");
    key(await sendable(container), "Enter");
    await userEvent.type(await sendable(container), "atlas draft");
    await userEvent.click(screen.getByText("Other bot"));
    expect(screen.queryByText(/A turn is still running/)).toBeNull();
    expect(h.turns[0]!.cancelled).toBe(false);
    expect((await sendable(container)).value).toBe("");
    await userEvent.type(await sendable(container), "granite draft");
    await userEvent.click(screen.getByText("Open explicit"));
    expect((await sendable(container)).value).toBe("atlas draft");
  });

  test("deep-linked rail selections stay selected instead of replaying the old URL", async () => {
    window.history.replaceState(null, "", "/#chat/atlas/atlas?session=s1");
    const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")] });
    const { container } = mountEntry(h);
    await sendable(container);
    const granite = Array.from(container.querySelectorAll<HTMLButtonElement>(".ch-conv")).find((row) =>
      row.textContent?.includes("granite"),
    )!;
    await userEvent.click(granite);
    await waitFor(() =>
      expect(screen.getByTestId("selection").textContent).toBe("#chat/granite/granite"),
    );
    expect(window.location.hash).toBe("#chat/granite/granite");
  });

  test("quick text waits for session evidence and sends once only to a proven portal destination", async () => {
    const h = harness();
    h.sessionsMode = "hang";
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Jump"));
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "atlas hello from jump");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    key(input, "Enter");
    expect(h.calls.send).toBe(0);
    await act(async () => h.releaseSessions?.());
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(h.turns[0]!.instance).toBe("atlas");
    expect(h.turns[0]!.message).toBe("hello from jump");
    expect((await sendable(container)).value).toBe("");
  });

  test("foreign quick text remains beside its warning and Enter requires a deliberate composer send", async () => {
    const h = harness({ sessions: [sessionOf({ origin: "channel", origin_detail: "#acme-support" })] });
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Jump"));
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "atlas hello channel");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    key(input, "Enter");
    expect((await sendable(container)).value).toBe("hello channel");
    expect(container.querySelector(".ch-composer [role=note]")?.textContent).toContain("#acme-support");
    expect(h.calls.send).toBe(0);
    key(await sendable(container), "Enter");
    expect(h.calls.send).toBe(1);
  });

  test("a long quick-text draft is sent, and an unreachable composer is never bypassed", async () => {
    // The composer used to refuse anything past 6,000 characters, because the
    // turn rode in a `GET` query string. It rides in a `POST` body now, so the
    // only thing that still holds a draft back is a box this portal cannot
    // reach.
    const long = harness({ swarms: [swarmOf("atlas", { reachable: true })] });
    {
      const { unmount } = mountEntry(long);
      await userEvent.click(screen.getByText("Jump"));
      const input = screen.getByRole("combobox");
      const text = "x".repeat(20_000);
      fireEvent.change(input, { target: { value: `atlas ${text}` } });
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
      key(input, "Enter");
      await waitFor(() => expect(long.calls.send).toBe(1));
      expect(long.turns[0]?.message).toBe(text);
      unmount();
    }

    const off = harness({ swarms: [swarmOf("atlas", { reachable: false })] });
    const { container, unmount } = mountEntry(off);
    await userEvent.click(screen.getByText("Jump"));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "atlas keep this draft" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    key(input, "Enter");
    await waitFor(() =>
      expect((container.querySelector(".ch-input") as HTMLTextAreaElement)?.value).toBe(
        "keep this draft",
      ),
    );
    await act(async () => {});
    expect(off.calls.send).toBe(0);
    expect((container.querySelector(".ch-input") as HTMLTextAreaElement).value).toBe("keep this draft");
    unmount();
  });

  test("quick jump owns Escape above an existing modal and restores its focused field", async () => {
    const h = harness();
    mountEntry(h);
    await userEvent.click(screen.getByText("Modal"));
    const field = screen.getByLabelText("Modal field");
    field.focus();
    key(field, "k", { ctrlKey: true });
    const input = screen.getByRole("combobox");
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    expect(screen.getByRole("dialog", { name: "Underlying modal" })).toBeDefined();
    expect(document.activeElement).toBe(field);
  });
});

test("observed turn activity reaches selected and background avatar owners without using warm state", async () => {
  const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")] });
  const { container } = mount(h);
  await sendable(container);
  const owner = (selector: string, name: string) =>
    [...container.querySelectorAll(selector)].find((element) => element.textContent?.includes(name))!;
  const phase = (element: Element) =>
    element.querySelector("[data-avatar-activity]")?.getAttribute("data-avatar-activity");
  const bot = (name: string) => owner(".ch-conv", name);
  const bucket = (name: string) => owner(".ch-bucket", name);
  const header = () => container.querySelector(".ch-thead")!;
  expect(phase(bot("atlas"))).toBe("idle");
  expect(phase(bucket("atlas"))).toBe("idle");
  await userEvent.type(await sendable(container), "hello");
  await userEvent.click(screen.getByTitle(/Send/));
  expect(phase(header())).toBe("thinking");
  expect(phase(bot("atlas"))).toBe("thinking");
  expect(phase(bucket("atlas"))).toBe("thinking");
  await act(async () =>
    h.turns[0]!.handlers.onFrame({ type: "delta", seq: 1, message: "active", text: "Output" }),
  );
  expect(phase(header())).toBe("streaming");
  expect(phase(bot("atlas"))).toBe("streaming");
  expect(phase(bucket("atlas"))).toBe("streaming");
  expect(phase(container.querySelector('[data-chat-message="active"]')!)).toBe("streaming");
  await userEvent.click(bot("granite"));
  await sendable(container);
  expect(phase(header())).toBe("idle");
  expect(phase(bot("granite"))).toBe("idle");
  expect(phase(bucket("granite"))).toBe("idle");
  expect(phase(bot("atlas"))).toBe("streaming");
  await act(async () =>
    h.turns[0]!.handlers.onFrame({
      type: "block",
      seq: 2,
      message: "active",
      block: {
        kind: "activity",
        category: "generation",
        key: "reasoning",
        title: "Thinking…",
        state: "running",
      },
    }),
  );
  expect(phase(bot("atlas"))).toBe("thinking");
  expect(phase(bucket("atlas"))).toBe("thinking");
  expect(phase(header())).toBe("idle");
  await userEvent.click(bot("atlas"));
  expect(phase(header())).toBe("thinking");
  expect(phase(container.querySelector('[data-chat-message="active"]')!)).toBe("thinking");
  await act(async () =>
    h.turns[0]!.handlers.onFrame({ type: "delta", seq: 3, message: "active", text: " continued" }),
  );
  expect(phase(header())).toBe("streaming");
  expect(phase(bot("atlas"))).toBe("streaming");
  await act(async () =>
    h.turns[0]!.handlers.onFrame({ type: "done", seq: 4, message: "active", usage: null }),
  );
  expect(phase(bot("atlas"))).toBe("idle");
  expect(phase(bucket("atlas"))).toBe("idle");
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
});
