/**
 * The task list end to end in fixture mode: the canned history and the
 * `E2E_TODO` prompts reach the phone's conversation store with their `todos`
 * intact, so the strip, the sheet and home's tags read the desktop's lists.
 */
import { latestTodoList, todoFraction } from "@hermetic/core/shared";
import { createHermeticClient } from "../../src/client/client.ts";
import { fixtureKit } from "../../src/fixture/index.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";

const NOW = "2026-10-13T10:00:00.000Z";

async function client() {
  const k = fixtureKit("1", () => NOW);
  if (!k) throw new Error("fixture kit not built with the flag set");
  const read = readPairingLink(k.link);
  if (!read.ok) throw new Error(read.error.title);
  const fleet = new FleetStore({
    secure: memoryKv(),
    viewCache: memoryFile(),
    fetch: k.fetch,
    now: () => NOW,
  });
  await fleet.pair(read.link);
  await fleet.setPrimary("kestrel");
  await fleet.setListening("corvid", true);
  return createHermeticClient({
    fleet,
    inbox: new InboxStore(memoryFile(), () => NOW),
    fetch: k.fetch,
    openSocket: () => {
      throw new Error("no socket in fixture mode");
    },
    chat: k.chat,
  });
}

const until = async (ok: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("corvid's Bot Chat reads back its paused list, 2 of 5", async () => {
  const c = await client();
  try {
    const target = { instance: "corvid", bot: "default", session: null };
    c.chat.open(target);
    await until(() => c.chat.view(target).history === "ready");
    const found = latestTodoList(c.chat.view(target).messages);
    expect(found?.snapshot.revision).toBe(3);
    expect(found && todoFraction(found.snapshot)).toEqual({ done: 2, total: 5 });
  } finally {
    c.dispose();
  }
});

test("E2E_TODO plans and advances a list; E2E_TODO_DONE finishes the same one", async () => {
  const c = await client();
  try {
    const target = { instance: "kestrel", bot: "default", session: null };
    c.chat.open(target);
    await until(() => c.chat.view(target).history === "ready");
    const settled = () => !c.chat.view(target).sending && !c.chat.view(target).live;
    const list = () => {
      const v = c.chat.view(target);
      return latestTodoList(v.live ? [...v.messages, v.live] : v.messages)?.snapshot ?? null;
    };
    c.chat.send(target, "Change the snapshot policy E2E_TODO");
    await until(() => list() !== null && !settled());
    await until(settled);
    const planned = list();
    expect(planned?.todos.some((t) => t.status === "pending")).toBe(true);
    c.chat.send(target, "Wrap it up E2E_TODO_DONE");
    await until(settled);
    await until(() => (list()?.revision ?? 0) > (planned?.revision ?? 0));
    const done = list();
    expect(done?.todos.every((t) => t.status === "done" || t.status === "cancelled")).toBe(true);
    expect(done?.todos.map((t) => t.id)).toEqual(planned?.todos.map((t) => t.id));
  } finally {
    c.dispose();
  }
}, 20_000);
