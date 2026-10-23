/**
 * The task list's marks: phone-local, one file per fleet in the desktop's
 * document shape, a mark never moving back, bounded to the most recent 200,
 * and a mark made before the file was read kept on top of what it held.
 */
import { createTaskMarks, TASK_VIEW_LIMIT } from "../../src/client/task-marks.ts";
import { memoryFile } from "../../src/fleet/store.ts";
import { flush } from "../helpers/fakes.ts";

function marks(seed: Record<string, string | null> = {}) {
  const files = new Map<string, ReturnType<typeof memoryFile>>();
  const store = createTaskMarks((fleetId) => {
    const file = memoryFile(seed[fleetId] ?? null);
    files.set(fleetId, file);
    return file;
  });
  return { store, files };
}

test("reads the desktop's document, per fleet", async () => {
  const { store } = marks({
    fxtr0001: JSON.stringify([["kestrel/default/s1", { seen: 3, hidden: 2 }]]),
  });
  expect(store.views("fxtr0001")).toEqual({});
  await flush();
  expect(store.views("fxtr0001")).toEqual({
    "kestrel/default/s1": { seen: 3, cleared: undefined, hidden: 2 },
  });
  expect(store.views("sg7k2m4p")).toEqual({});
});

test("a mark only rises, is written back, and notifies once per move", async () => {
  const { store, files } = marks();
  const heard = jest.fn();
  store.subscribe(heard);
  store.views("f1");
  await flush();
  store.mark("f1", "a/b/s", { seen: 4 });
  store.mark("f1", "a/b/s", { seen: 2 });
  store.mark("f1", "a/b/s", { seen: 4 });
  await flush();
  expect(heard).toHaveBeenCalledTimes(1);
  expect(store.views("f1")["a/b/s"]).toEqual({ seen: 4 });
  expect(JSON.parse(files.get("f1")?.text() ?? "null")).toEqual([["a/b/s", { seen: 4 }]]);
});

test("a mark made before the read is merged over what the file held", async () => {
  const { store, files } = marks({ f1: JSON.stringify([["x/y/s", { hidden: 1 }]]) });
  store.mark("f1", "a/b/s", { cleared: 2 });
  await flush();
  await flush();
  expect(Object.keys(store.views("f1"))).toEqual(["x/y/s", "a/b/s"]);
  expect(JSON.parse(files.get("f1")?.text() ?? "null")).toHaveLength(2);
});

test("keeps the most recently marked conversations", async () => {
  const { store } = marks();
  store.views("f1");
  await flush();
  for (let i = 0; i <= TASK_VIEW_LIMIT; i++) store.mark("f1", `i/b/${i}`, { seen: 1 });
  const keys = Object.keys(store.views("f1"));
  expect(keys).toHaveLength(TASK_VIEW_LIMIT);
  expect(keys[0]).toBe("i/b/1");
});

test("a file that cannot be read or written leaves the marks in memory", async () => {
  const store = createTaskMarks(() => ({
    read: async () => {
      throw new Error("no file");
    },
    write: async () => {
      throw new Error("no file");
    },
  }));
  store.mark("f1", "a/b/s", { hidden: 3 });
  await flush();
  expect(store.views("f1")["a/b/s"]).toEqual({ hidden: 3 });
});
