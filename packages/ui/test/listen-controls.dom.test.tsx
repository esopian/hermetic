import { act, cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import { ChatEntryContext } from "../src/chat/chat-entry-state.tsx";
import { ListeningProvider } from "../src/state/listening-state.tsx";
import type { ListeningApi } from "../src/state/listening-state.tsx";
import { ListenButton, ListeningNotice } from "../src/components/ListenButton.tsx";
import { FleetChatButton } from "../src/chat/components/FleetChatButton.tsx";

afterEach(cleanup);

function controls(api: ListeningApi) {
  const opened: string[] = [];
  let rowClicks = 0;
  render(
    <ListeningProvider api={api}>
      <ChatEntryContext.Provider
        value={{
          navigation: 0,
          drawerTarget: null,
          closeDrawer: () => {},
          quickJump: () => {},
          open: (target) => {
            opened.push(target.instance);
            return true;
          },
        }}
      >
        <ListeningNotice instances={["atlas"]} />
        <div
          role="button"
          tabIndex={0}
          aria-label="Open instance details"
          onClick={() => rowClicks++}
          onKeyDown={() => rowClicks++}
        >
          <ListenButton instance="atlas" />
          <FleetChatButton instance="atlas" />
        </div>
      </ChatEntryContext.Provider>
    </ListeningProvider>,
  );
  return { opened, rowClicks: () => rowClicks };
}

test("listening explicitly enables chat and removes the unwatched fleet notice", async () => {
  const writes: [string, boolean][] = [];
  const host = controls({
    fetchListening: async () => ({ instances: [] }),
    setInstanceListening: async (instance, listening) => {
      writes.push([instance, listening]);
      return { instances: listening ? [instance] : [] };
    },
  });
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("No instances are being watched");
  const chat = screen.getByRole("button", { name: "Chat with atlas" }) as HTMLButtonElement;
  expect(chat.disabled).toBe(true);
  fireEvent.click(chat);
  expect(host.opened).toEqual([]);

  fireEvent.click(screen.getByRole("switch", { name: "Listen to atlas" }));
  await waitFor(() => expect(chat.disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("switch", { name: "Listen to atlas" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.click(chat);
  expect(host.opened).toEqual(["atlas"]);
  fireEvent.click(screen.getByRole("switch", { name: "Listen to atlas" }));
  await screen.findByRole("alert");
  expect(chat.disabled).toBe(true);
  expect(writes).toEqual([
    ["atlas", true],
    ["atlas", false],
  ]);
  expect(host.rowClicks()).toBe(0);
});

test("unlisten disconnects chat while saving and reports a failed save", async () => {
  let rejectSave!: (reason: Error) => void;
  controls({
    fetchListening: async () => ({ instances: ["atlas"] }),
    setInstanceListening: () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
  });
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: "Listen to atlas" }).getAttribute("aria-checked")).toBe(
      "true",
    ),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Listen to atlas" }));
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: "Listen to atlas" }).getAttribute("aria-busy")).toBe(
      "true",
    ),
  );
  expect((screen.getByRole("button", { name: "Chat with atlas" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => rejectSave(new Error("Disk unavailable")));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Disk unavailable"));
  expect(screen.getByRole("switch", { name: "Listen to atlas" }).getAttribute("aria-checked")).toBe(
    "true",
  );
});

test("watching an instance outside the current fleet does not hide its empty notice", async () => {
  controls({
    fetchListening: async () => ({ instances: ["other-fleet-agent"] }),
    setInstanceListening: async () => ({ instances: [] }),
  });
  expect((await screen.findByRole("alert")).textContent).toContain("No instances are being watched");
});
