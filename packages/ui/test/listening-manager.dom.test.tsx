import {
  act,
  cleanup,
  fireEvent,
  flipPageHidden,
  render,
  screen,
  setPageHidden,
  waitFor,
} from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import type { AgentView } from "../src/api/index.ts";
import { ListeningProvider } from "../src/state/listening-state.tsx";
import type { ListeningApi } from "../src/state/listening-state.tsx";
import { ListeningManager } from "../src/components/ListeningManager.tsx";

/**
 * Two thresholds a run can never sit between. Real time on a loaded CI box
 * stretches a 5 ms wait into tens of milliseconds, so a test that wanted the
 * flaps to finish inside a 150 ms floor was betting on the runner's mood.
 * `NEVER_MS` suppresses every return; `ALWAYS_MS` lets every return through.
 */
const NEVER_MS = 600_000;
const ALWAYS_MS = 1;

// A visible page, back for the next file: the reset is each suite's own (`setup.ts`).
afterEach(() => {
  setPageHidden(false);
  cleanup();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const agents = ["atlas", "corvid"].map(
  (name) => ({ name, status: "ready", display_status: "ready" }) as AgentView,
);
function manager(api: ListeningApi) {
  let closed = 0;
  render(
    <ListeningProvider api={api}>
      <ListeningManager agents={agents} onClose={() => closed++} />
    </ListeningProvider>,
  );
  return () => closed;
}

test("cancel discards the manager draft without connecting any instances", async () => {
  const writes: string[] = [];
  const closed = manager({
    fetchListening: async () => ({ instances: ["atlas"] }),
    setInstanceListening: async (instance) => {
      writes.push(instance);
      return { instances: [instance] };
    },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("checkbox", { name: "Listen to atlas" }) as HTMLInputElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Listen to corvid" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(writes).toEqual([]);
  expect(closed()).toBe(1);
});

test("apply writes only changed instances and keeps unrelated preferences", async () => {
  const instances = new Set(["atlas", "other-instance"]);
  const writes: [string, boolean][] = [];
  const closed = manager({
    fetchListening: async () => ({ instances: [...instances] }),
    setInstanceListening: async (instance, on) => {
      writes.push([instance, on]);
      on ? instances.add(instance) : instances.delete(instance);
      return { instances: [...instances] };
    },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("checkbox", { name: "Listen to atlas" }) as HTMLInputElement).checked,
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Listen to corvid" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply · 2 instances" }));
  await waitFor(() => expect(closed()).toBe(1));
  expect(writes).toEqual([["corvid", true]]);
  expect([...instances]).toEqual(["atlas", "other-instance", "corvid"]);
});

test("partial save failures keep the draft open and retry only unsaved changes", async () => {
  const instances = new Set<string>();
  const writes: string[] = [];
  let fail = true;
  const closed = manager({
    fetchListening: async () => ({ instances: [] }),
    setInstanceListening: async (instance, on) => {
      writes.push(instance);
      if (instance === "corvid" && fail) throw new Error("Disk unavailable");
      on ? instances.add(instance) : instances.delete(instance);
      return { instances: [...instances] };
    },
  });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Select all" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply · 2 instances" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Disk unavailable");
  expect(closed()).toBe(0);
  expect((screen.getByRole("checkbox", { name: "Listen to corvid" }) as HTMLInputElement).checked).toBe(
    true,
  );
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Apply · 2 instances" }));
  await waitFor(() => expect(closed()).toBe(1));
  expect(writes).toEqual(["atlas", "corvid", "corvid"]);
  expect([...instances]).toEqual(["atlas", "corvid"]);
});

function flapper(returnReadMinAgeMs: number) {
  let reads = 0;
  render(
    <ListeningProvider
      returnReadMinAgeMs={returnReadMinAgeMs}
      api={{
        fetchListening: async () => {
          reads++;
          return { instances: ["atlas"] };
        },
        setInstanceListening: async () => ({ instances: ["atlas"] }),
      }}
    >
      <ListeningManager agents={agents} onClose={() => {}} />
    </ListeningProvider>,
  );
  return () => reads;
}

const flip = async (next: boolean, ms: number) => {
  // `flipPageHidden` dispatches a raw `visibilitychange` event straight at
  // `document`, outside anything React-aware. When the transition wakes
  // `onReturnVisible`'s listener, it fires `refresh()`, whose `setInstances`/
  // `setError`/`setLoading` land once `fetchListening` resolves — a real state
  // update, just one the test has to own wrapping rather than one `fireEvent`
  // (which only instruments element dispatch, not `document`) catches for it.
  await act(async () => {
    flipPageHidden(next);
    await wait(ms);
  });
};

test("a flapping page reads the listening set once, at mount", async () => {
  // The floor is out of reach, so every read past the mount's is a read
  // `onReturnVisible` was supposed to suppress — a regression that read on
  // every `visibilitychange` would add up to 10, however slow the box is.
  const reads = flapper(NEVER_MS);
  await waitFor(() => expect(reads()).toBe(1));
  for (let i = 0; i < 10; i++) {
    await flip(true, 5);
    await flip(false, 5);
  }
  expect(reads()).toBe(1);
}, 20_000);

test("a return reads the listening set once the mount's read is stale", async () => {
  const reads = flapper(ALWAYS_MS);
  await waitFor(() => expect(reads()).toBe(1));
  await flip(true, 20);
  await flip(false, 0);
  await waitFor(() => expect(reads()).toBe(2));
}, 20_000);
