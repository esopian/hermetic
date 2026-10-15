/**
 * Composer attachments across the entry frames (attachments plan §8.1): with
 * two dock panes on two agents, a file dragged over a pane names that pane's
 * agent and a drop lands in that pane's conversation only; and a staged chip
 * belongs to the conversation, so it survives Expand chat and the send from
 * the full view carries its id.
 *
 * Same shell as `chat-view-entry.dom.test.tsx` — the real store, compositor and
 * dock — with the server calls and the files bridge substituted
 * (`chat-fixtures.tsx`). Assertions compare strings and booleans, never DOM
 * nodes, so a failure prints a diff rather than the page.
 */
import { cleanup, fireEvent, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect, useState } from "react";
import { ChatProvider } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { ChatShell } from "../src/chat/components/ChatShell.tsx";
import { useChatEntry } from "../src/chat/chat-entry-state.tsx";
import { fakeFiles, harness, sendable, sessionOf, stubUploadFetch, swarmOf } from "./chat-fixtures.tsx";
import type { Harness } from "./chat-fixtures.tsx";

let restoreFetch: () => void = () => undefined;
beforeEach(() => {
  restoreFetch = stubUploadFetch();
});
afterEach(() => {
  restoreFetch();
  cleanup();
});

function EntryFrames() {
  const entry = useChatEntry()!;
  const [full, setFull] = useState(window.location.hash.startsWith("#chat"));
  useEffect(() => {
    const sync = () => setFull(window.location.hash.startsWith("#chat"));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => entry.open({ instance: "atlas", bot: "atlas", session: "s1" }, "dock")}
      >
        Open explicit
      </button>
      {full ? <ChatView /> : null}
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

/** A Finder drag: `types` names files, and the `File`s ride along. */
function files(list: File[]) {
  return { dataTransfer: { types: ["Files"], files: list, dropEffect: "none" } };
}

function drop(target: Element, list: File[]): void {
  fireEvent.dragEnter(target, files(list));
  fireEvent.dragOver(target, files(list));
  fireEvent.drop(target, files(list));
}

/** The chip names in a pane's tray, in order. */
function chips(root: Element): string[] {
  return [...root.querySelectorAll(".ch-tray .ch-file b")].map((b) => b.textContent ?? "");
}

const overlay = (root: Element) => root.querySelector(".ch-drop")?.textContent ?? "";

describe("attachments in the entry frames", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  test("each dock pane is its own drop target, named for its agent", async () => {
    const fake = fakeFiles();
    const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")], files: fake.api });
    h.sessions["granite/granite"] = [sessionOf({ id: "g1", instance: "granite", bot: "granite" })];
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Open explicit"));
    await sendable(container);
    await userEvent.click(screen.getByRole("button", { name: "+ Panel" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Open in new panel" })).getByRole("button", {
        name: /granite/i,
      }),
    );
    const pane = (agent: string) => {
      const found = [...container.querySelectorAll<HTMLElement>(".ch-dock-pane")].find((p) =>
        (p.getAttribute("aria-label") ?? "").includes(agent),
      );
      if (!found) throw new Error(`no dock pane for ${agent}`);
      return found;
    };
    await waitFor(() => expect(container.querySelectorAll(".ch-dock-pane").length).toBe(2));
    await waitFor(() => {
      expect(pane("atlas").querySelector(".ch-thread") !== null).toBe(true);
      expect(pane("granite").querySelector(".ch-thread") !== null).toBe(true);
    });
    const thread = (agent: string) => pane(agent).querySelector(".ch-thread")!;

    // Dragging over a pane names that pane's agent, and only that pane shows it.
    fireEvent.dragEnter(thread("granite"), files([]));
    expect(overlay(thread("granite"))).toContain("→ granite");
    expect(overlay(thread("atlas"))).toBe("");
    fireEvent.dragLeave(thread("granite"), files([]));
    expect(overlay(thread("granite"))).toBe("");
    fireEvent.dragEnter(thread("atlas"), files([]));
    expect(overlay(thread("atlas"))).toContain("→ atlas");
    expect(overlay(thread("granite"))).toBe("");
    fireEvent.dragLeave(thread("atlas"), files([]));

    // A drop lands on the pane it was made on, and the box it is staged on is that pane's.
    drop(thread("granite"), [new File(["g"], "granite-notes.txt", { type: "text/plain" })]);
    await waitFor(() => expect(pane("granite").querySelector(".ch-file.staged") !== null).toBe(true));
    expect(chips(pane("granite"))).toEqual(["granite-notes.txt"]);
    expect(chips(pane("atlas"))).toEqual([]);
    expect(fake.stages.map((s) => s.instance)).toEqual(["granite"]);

    drop(thread("atlas"), [new File(["a"], "atlas-log.txt", { type: "text/plain" })]);
    await waitFor(() => expect(pane("atlas").querySelector(".ch-file.staged") !== null).toBe(true));
    expect(chips(pane("atlas"))).toEqual(["atlas-log.txt"]);
    expect(chips(pane("granite"))).toEqual(["granite-notes.txt"]);
    expect(fake.stages.map((s) => s.instance)).toEqual(["granite", "atlas"]);
    expect(h.calls.send).toBe(0);
  });

  test("a staged chip survives Expand chat, and the full view's send carries it", async () => {
    const fake = fakeFiles();
    const h = harness({ files: fake.api });
    const { container } = mountEntry(h);
    await userEvent.click(screen.getByText("Open explicit"));
    await sendable(container);
    const dockThread = container.querySelector(".ch-dock .ch-thread")!;
    drop(dockThread, [new File(["r"], "report.md", { type: "text/markdown" })]);
    await waitFor(() => expect(container.querySelector(".ch-file.staged") !== null).toBe(true));
    expect(fake.stages).toHaveLength(1);
    const staged = fake.stages[0]!.file_id;

    await userEvent.click(screen.getByLabelText("Expand chat"));
    await waitFor(() => expect(container.querySelector(".ch-dock") === null).toBe(true));
    const input = await sendable(container);
    expect(chips(container)).toEqual(["report.md"]);
    expect(container.querySelector(".ch-file.staged") !== null).toBe(true);

    await userEvent.type(input, "read this{Enter}");
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(h.turns[0]!.message).toBe("read this");
    expect(h.turns[0]!.attachments).toEqual([staged]);
    // Nothing was staged twice: the full view sent the dock's chip.
    expect(fake.stages).toHaveLength(1);
    expect(chips(container)).toEqual([]);
  });
});
