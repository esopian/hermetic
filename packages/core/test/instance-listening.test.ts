import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openLocalDb,
  SqliteInstanceListeningStore,
  SqliteNotificationStore,
} from "../src/local/db/index.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { MemoryNotificationStore, createNotifications } from "../src/chat/notifications.ts";
import type { NotificationStore } from "../src/chat/notifications.ts";
import { INSTANCE_NOTIFICATION_SOURCES, NOTIFICATION_SOURCES } from "../src/schema/index.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function local() {
  const home = mkdtempSync(join(tmpdir(), "hermetic-listening-"));
  homes.push(home);
  return { home, local: openLocalDb({ home }) };
}

test("listening persists after reopening SQLite and stays isolated by fleet", () => {
  const { home, local: first } = local();
  const store = new SqliteInstanceListeningStore(first.db);
  expect(store.list("fleet-a")).toEqual([]);
  store.set("fleet-a", "atlas", true);
  store.set("fleet-b", "ember", true);
  store.set("fleet-a", "atlas", true);
  first.close();
  const second = openLocalDb({ home });
  const reopened = new SqliteInstanceListeningStore(second.db);
  expect(reopened.list("fleet-a")).toEqual(["atlas"]);
  expect(reopened.list("fleet-b")).toEqual(["ember"]);
  reopened.set("fleet-a", "atlas", false);
  expect(reopened.list("fleet-a")).toEqual([]);
  expect(reopened.list("fleet-b")).toEqual(["ember"]);
  second.close();
});

test("the listening rule names only real notification sources", () => {
  for (const source of INSTANCE_NOTIFICATION_SOURCES) {
    expect(NOTIFICATION_SOURCES as readonly string[]).toContain(source);
  }
});

for (const kind of ["memory", "sqlite"] as const) {
  describe(`${kind} notification listening filter`, () => {
    test("filters old instance alerts before limiting and keeps list and counts coherent", async () => {
      const db = kind === "sqlite" ? local().local : null;
      const store: NotificationStore = db
        ? new SqliteNotificationStore(db.db)
        : new MemoryNotificationStore();
      const listening = new MemoryInstanceListeningStore();
      const api = createNotifications({
        store,
        fleet: () => "fleet-a",
        instances: () => listening.list("fleet-a"),
      });
      const at = new Date().toISOString();
      store.insert({
        source: "fleet",
        kind: "fleet.advisory",
        class: "needs_action",
        title: "Fleet advisory",
        fleet: "fleet-a",
        at: new Date(Date.parse(at) - 1000).toISOString(),
      });
      store.insert({
        source: "chat",
        kind: "chat.message",
        class: "needs_action",
        title: "Atlas spoke",
        agent: "atlas",
        fleet: "fleet-a",
        at,
      });
      store.insert({
        source: "agent",
        kind: "agent.health",
        class: "bad",
        title: "Ember alert",
        agent: "ember",
        fleet: "fleet-a",
        at,
      });
      store.insert({
        source: "chat",
        kind: "chat.message",
        class: "needs_action",
        title: "Other fleet",
        agent: "atlas",
        fleet: "fleet-b",
        at,
      });
      const empty = await api.list({ limit: 1 });
      expect(empty.notifications.map((row) => row.title)).toEqual(["Fleet advisory"]);
      expect(empty.unread).toBe(1);
      expect(empty.needs_action).toBe(1);
      listening.set("fleet-a", "atlas", true);
      const watched = await api.list({ limit: 100 });
      expect(watched.notifications.map((row) => row.title).sort()).toEqual([
        "Atlas spoke",
        "Fleet advisory",
      ]);
      expect(watched.unread).toBe(2);
      expect(watched.needs_action).toBe(2);
      listening.set("fleet-a", "atlas", false);
      expect((await api.list({})).unread).toBe(1);
      db?.close();
    });

    /**
     * B10: listening scopes *instance* notifications (§4.6). An op this laptop
     * ran, or a fleet advisory, stays visible even when it names an agent
     * nobody listens to — including one the op itself destroyed.
     */
    test("operation and fleet rows naming an unlistened agent stay visible", async () => {
      const db = kind === "sqlite" ? local().local : null;
      const store: NotificationStore = db
        ? new SqliteNotificationStore(db.db)
        : new MemoryNotificationStore();
      const api = createNotifications({ store, fleet: () => "fleet-a", instances: () => [] });
      const at = new Date().toISOString();
      store.insert({
        source: "operation",
        kind: "operation.done",
        class: "ok",
        title: "brown-wolf apply finished",
        agent: "brown-wolf",
        fleet: "fleet-a",
        at,
      });
      store.insert({
        source: "fleet",
        kind: "fleet.advisory",
        class: "warn",
        title: "kestrel is behind",
        agent: "kestrel",
        fleet: "fleet-a",
        at,
      });
      store.insert({
        source: "agent",
        kind: "agent.health",
        class: "bad",
        title: "Ember alert",
        agent: "ember",
        fleet: "fleet-a",
        at,
      });
      const result = await api.list({ limit: 100 });
      expect(result.notifications.map((row) => row.title).sort()).toEqual([
        "brown-wolf apply finished",
        "kestrel is behind",
      ]);
      expect(result.unread).toBe(2);
      db?.close();
    });
  });
}

test("the SDK persists preferences across reopen and isolates fixture fleets", async () => {
  const { openHermetic } = await import("../src/open.ts");
  const home = mkdtempSync(join(tmpdir(), "hermetic-listening-sdk-"));
  homes.push(home);
  const first = await openHermetic({ fixture: true, home });
  expect(await first.chat.listening()).toEqual({ instances: [] });
  expect(await first.chat.swarms({})).toEqual({ swarms: [] });
  await first.chat.listen({ instance: "atlas", listening: true });
  const reopened = await openHermetic({ fixture: true, home });
  expect(await reopened.chat.listening()).toEqual({ instances: ["atlas"] });
  const other = await openHermetic({ fixture: true, home, fleet: "staging" });
  expect(await other.chat.listening()).toEqual({ instances: [] });
  expect(await other.chat.swarms({})).toEqual({ swarms: [] });
  await reopened.chat.listen({ instance: "atlas", listening: false });
  expect(await first.chat.listening()).toEqual({ instances: [] });
});
