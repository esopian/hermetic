import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openLocalDb,
  SqliteChatFenceStore,
  SqliteIncarnationStore,
  SqliteInstanceListeningStore,
  SqliteLocalChatSessions,
  SqliteNotificationStore,
} from "../src/local/db/index.ts";
import { MemoryChatFenceStore } from "../src/chat/chat-fence.ts";
import type { ChatFenceStore } from "../src/chat/chat-fence.ts";
import { MemoryLocalChatSessions } from "../src/chat/chat.ts";
import type { LocalChatSessions } from "../src/chat/chat.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import type { InstanceListeningStore } from "../src/chat/instance-listening.ts";
import { MemoryNotificationStore } from "../src/chat/notifications.ts";
import type { NotificationStore } from "../src/chat/notifications.ts";
import {
  createIncarnationReconciler,
  MemoryIncarnationStore,
  type IncarnationStore,
} from "../src/local/incarnations.ts";
import { createLocalAgentPurge } from "../src/local/purge-agent.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { drain, testHermetic } from "./helpers.ts";

/**
 * §6.7: a destroy releases the name, and only the laptop that ran it purges.
 * Every other laptop must notice the release from the fleet itself — a live row
 * whose `created_at` is not the one its local state was gathered against.
 */

const F = "fleetaaa";
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T3 = "2026-03-01T00:00:00.000Z";
const RECENT = new Date().toISOString();

interface Stores {
  notifications: NotificationStore;
  instanceListening: InstanceListeningStore;
  localSessions: LocalChatSessions;
  chatFence: ChatFenceStore;
  incarnations: IncarnationStore;
  close(): void;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function build(kind: "memory" | "sqlite"): Stores {
  if (kind === "memory") {
    return {
      notifications: new MemoryNotificationStore(),
      instanceListening: new MemoryInstanceListeningStore(),
      localSessions: new MemoryLocalChatSessions(),
      chatFence: new MemoryChatFenceStore(),
      incarnations: new MemoryIncarnationStore(),
      close: () => {},
    };
  }
  const home = mkdtempSync(join(tmpdir(), "hermetic-incarnations-"));
  homes.push(home);
  const local = openLocalDb({ home });
  return {
    notifications: new SqliteNotificationStore(local.db),
    instanceListening: new SqliteInstanceListeningStore(local.db),
    localSessions: new SqliteLocalChatSessions(local.db),
    chatFence: new SqliteChatFenceStore(local.db),
    incarnations: new SqliteIncarnationStore(local.db),
    close: () => local.close(),
  };
}

function seed(s: Stores, name: string): void {
  s.notifications.setSeenStatus(F, name, "ready");
  s.notifications.setSeenStatus(F, `chat:${name}/bot`, "2026-01-01T00:00:00Z");
  s.instanceListening.set(F, name, true);
  s.localSessions.remember(F, { instance: name, bot: "bot", session: `sess-${name}` }, RECENT);
}

function hasState(s: Stores, name: string): boolean[] {
  return [
    s.notifications.seenStatus(F, name) !== null,
    s.notifications.seenStatus(F, `chat:${name}/bot`) !== null,
    s.instanceListening.list(F).includes(name),
    s.localSessions.mine(F, [`sess-${name}`]).size === 1,
  ];
}

/**
 * The purge `hermetic.ts` hands the reconciler: the release's, less its
 * incarnation step, so it never drops the claim the reconciler just won.
 */
function reconcilePurge(s: Stores) {
  return createLocalAgentPurge({ ...s, incarnations: undefined });
}

/** Set `name`'s record outright, whatever it held. */
function record(s: Stores, name: string, at: string): void {
  if (!s.incarnations.claim(F, name, s.incarnations.get(F, name), at)) {
    throw new Error(`could not record ${name}`);
  }
}

/**
 * The real purge, counting the names it was asked for, and holding the purge
 * of `hold` until `release()` — so a test can park one reconcile mid-scan while
 * another runs to completion.
 */
function purgeSpy(s: Stores, hold?: string) {
  const purgeLocal = reconcilePurge(s);
  const calls: string[] = [];
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  return {
    calls,
    started: started.promise,
    release: () => held.resolve(),
    purge: async (fleet: string, name: string) => {
      calls.push(name);
      if (name === hold) {
        started.resolve();
        await held.promise;
      }
      await purgeLocal(fleet, name);
    },
  };
}

function reconcilerFor(s: Stores, fleet: string | null = F) {
  return createIncarnationReconciler({
    store: s.incarnations,
    fleet: () => fleet,
    purge: reconcilePurge(s),
  });
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`reconcileIncarnations (${kind})`, () => {
    test("a different created_at for a recorded name purges, then records the new one", async () => {
      const s = build(kind);
      seed(s, "alpha");
      seed(s, "beta");
      record(s, "alpha", T1);
      record(s, "beta", T1);

      await reconcilerFor(s)(
        [
          { name: "alpha", created_at: T2 },
          { name: "beta", created_at: T1 },
        ],
        { complete: true },
      );

      expect(hasState(s, "alpha")).toEqual([false, false, false, false]);
      expect(hasState(s, "beta")).toEqual([true, true, true, true]);
      expect(s.incarnations.list(F)).toEqual(
        new Map([
          ["alpha", T2],
          ["beta", T1],
        ]),
      );
      s.close();
    });

    /**
     * Two scans in flight: the older one began before the successor existed and
     * is delivered after a newer scan recorded the successor. Its row carries
     * the predecessor's earlier `created_at`; acting on it would purge the
     * successor's freshly configured state and record the predecessor again.
     */
    test("a delayed scan carrying an older created_at neither purges nor records", async () => {
      const s = build(kind);
      record(s, "alpha", T1);
      const reconcile = reconcilerFor(s);
      await reconcile([{ name: "alpha", created_at: T2 }], { complete: true });
      // The operator sets up the successor box after the newer scan.
      seed(s, "alpha");

      await reconcile([{ name: "alpha", created_at: T1 }], { complete: true });

      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      expect(s.incarnations.list(F)).toEqual(new Map([["alpha", T2]]));
      // And the next, current poll finds nothing to do either.
      await reconcile([{ name: "alpha", created_at: T2 }], { complete: true });
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      s.close();
    });

    /**
     * `created_at` is box-writable. A far-future value, once recorded, must not
     * become a ceiling no real successor can pass.
     */
    test("a recorded created_at in the future does not shield a real successor", async () => {
      const s = build(kind);
      seed(s, "alpha");
      const forged = "3000-01-01T00:00:00.000Z";
      record(s, "alpha", forged);

      await reconcilerFor(s)([{ name: "alpha", created_at: T2 }], { complete: true });

      expect(hasState(s, "alpha")).toEqual([false, false, false, false]);
      expect(s.incarnations.list(F)).toEqual(new Map([["alpha", T2]]));
      s.close();
    });

    test("the same created_at purges nothing", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      await reconcilerFor(s)([{ name: "alpha", created_at: T1 }], { complete: false });
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      s.close();
    });

    test("first sighting adopts existing state rather than purging it (upgrade)", async () => {
      const s = build(kind);
      seed(s, "alpha");
      await reconcilerFor(s)([{ name: "alpha", created_at: T1 }], { complete: true });
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      expect(s.incarnations.list(F).get("alpha")).toBe(T1);
      s.close();
    });

    test("a recorded name absent from a complete scan is purged and forgotten", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      await reconcilerFor(s)([], { complete: true });
      expect(hasState(s, "alpha")).toEqual([false, false, false, false]);
      expect(s.incarnations.list(F).has("alpha")).toBe(false);
      s.close();
    });

    test("a recorded name whose row is unparseable is not released by the absence rule", async () => {
      const s = build(kind);
      seed(s, "alpha");
      seed(s, "beta");
      record(s, "alpha", T1);
      record(s, "beta", T1);
      const reconcile = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: reconcilePurge(s),
        unparseable: () => ["alpha"],
      });

      // alpha's row is in the table but the scan could not parse it; beta's is
      // simply gone. Neither is purged this read, and the rows that did parse
      // are still compared.
      await reconcile([{ name: "gamma", created_at: T1 }], { complete: true });

      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      expect(hasState(s, "beta")).toEqual([true, true, true, true]);
      expect([...s.incarnations.list(F)]).toEqual([
        ["alpha", T1],
        ["beta", T1],
        ["gamma", T1],
      ]);

      // Once the row parses again it is the same incarnation, not a first sighting.
      await reconcilerFor(s)(
        [
          { name: "alpha", created_at: T1 },
          { name: "gamma", created_at: T1 },
        ],
        { complete: true },
      );
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      expect(hasState(s, "beta")).toEqual([false, false, false, false]);
      s.close();
    });

    test("an unparseable row still lets a changed created_at purge; a failing probe counts as incomplete", async () => {
      const s = build(kind);
      seed(s, "alpha");
      seed(s, "beta");
      record(s, "alpha", T1);
      record(s, "beta", T1);
      await createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: reconcilePurge(s),
        unparseable: () => {
          throw new Error("probe broke");
        },
      })([{ name: "alpha", created_at: T2 }], { complete: true });
      expect(hasState(s, "alpha")).toEqual([false, false, false, false]);
      expect(hasState(s, "beta")).toEqual([true, true, true, true]);
      s.close();
    });

    test("a concurrent scan clearing unparseable during a purge await does not release the name", async () => {
      const s = build(kind);
      seed(s, "alpha");
      seed(s, "beta");
      record(s, "alpha", T1);
      record(s, "beta", T1);
      record(s, "gamma", T1);
      let skipped = ["beta"];
      const purgeLocal = reconcilePurge(s);
      const reconcile = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: async (fleet, name) => {
          await purgeLocal(fleet, name);
          // Another scan lands while this one is still purging gamma's old box.
          skipped = [];
        },
        unparseable: () => skipped,
      });

      // gamma re-taken (purge await), beta's row unparseable in THIS read.
      await reconcile(
        [
          { name: "alpha", created_at: T1 },
          { name: "gamma", created_at: T2 },
        ],
        { complete: true },
      );

      expect(hasState(s, "beta")).toEqual([true, true, true, true]);
      expect(s.incarnations.list(F).get("beta")).toBe(T1);
      s.close();
    });

    test("a single-row read never treats an unlisted name as released", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      await reconcilerFor(s)([{ name: "beta", created_at: T1 }], { complete: false });
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      s.close();
    });

    test("a legacy destroyed row counts as absent", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      await reconcilerFor(s)([{ name: "alpha", created_at: T1, status: "destroyed" }], {
        complete: true,
      });
      expect(hasState(s, "alpha")).toEqual([false, false, false, false]);
      s.close();
    });

    test("no frozen fleet, no reconciliation; a failing purge still records", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      await reconcilerFor(s, null)([{ name: "alpha", created_at: T2 }], { complete: true });
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);

      const failing = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: async () => {
          throw new Error("purge broke");
        },
      });
      await failing([{ name: "alpha", created_at: T2 }], { complete: true });
      expect(s.incarnations.list(F).get("alpha")).toBe(T2);
      s.close();
    });

    test("claim and forgetIf write only over the value the caller read", () => {
      const s = build(kind);
      const store = s.incarnations;
      expect(store.claim(F, "alpha", undefined, T1)).toBe(true);
      expect(store.claim(F, "alpha", undefined, T2)).toBe(false);
      expect(store.claim(F, "alpha", T2, T3)).toBe(false);
      expect(store.get(F, "alpha")).toBe(T1);
      expect(store.claim(F, "alpha", T1, T2)).toBe(true);
      expect(store.get(F, "alpha")).toBe(T2);
      expect(store.forgetIf(F, "alpha", T1)).toBe(false);
      expect(store.get(F, "alpha")).toBe(T2);
      expect(store.forgetIf(F, "alpha", T2)).toBe(true);
      expect(store.get(F, "alpha")).toBeUndefined();
      expect(store.forgetIf(F, "alpha", T2)).toBe(false);
      s.close();
    });

    /**
     * Two reconciles overlapping on one store (two reads in one process, or the
     * CLI and the app on one file). Both read alpha's record as T1. The older
     * scan sees the predecessor (T2) and parks on an earlier row's purge; the
     * newer one sees the successor (T3), records it, and the operator sets the
     * successor up. When the older scan resumes, its decision about alpha rests
     * on a record that has moved on: it must neither purge the successor's
     * state nor move the record back to T2.
     */
    test("an older scan finishing last neither purges the successor nor records the predecessor", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      record(s, "beta", T1);
      const older = purgeSpy(s, "beta");
      const newer = purgeSpy(s);
      const reconcileOlder = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: older.purge,
      });
      const reconcileNewer = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: newer.purge,
      });

      const olderDone = reconcileOlder(
        [
          { name: "beta", created_at: T2 },
          { name: "alpha", created_at: T2 },
        ],
        { complete: false },
      );
      await older.started;
      await reconcileNewer([{ name: "alpha", created_at: T3 }], { complete: false });
      expect(s.incarnations.get(F, "alpha")).toBe(T3);
      seed(s, "alpha");
      older.release();
      await olderDone;

      expect(older.calls).toEqual(["beta"]);
      expect(newer.calls).toEqual(["alpha"]);
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      expect(s.incarnations.get(F, "alpha")).toBe(T3);
      expect(s.incarnations.get(F, "beta")).toBe(T2);
      s.close();
    });

    /**
     * The other order: both scans read alpha's record as T1 and park on an
     * earlier row; the older one resumes first and claims the predecessor, so
     * the newer one, deciding from the stale T1, loses its claim. It must
     * re-read and still record the successor, not leave the record on T2.
     */
    test("a newer scan that loses its claim to an older one still records itself", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      record(s, "beta", T1);
      record(s, "gamma", T1);
      const older = purgeSpy(s, "beta");
      const newer = purgeSpy(s, "gamma");
      const olderDone = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: older.purge,
      })(
        [
          { name: "beta", created_at: T2 },
          { name: "alpha", created_at: T2 },
        ],
        { complete: false },
      );
      await older.started;
      const newerDone = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: newer.purge,
      })(
        [
          { name: "gamma", created_at: T2 },
          { name: "alpha", created_at: T3 },
        ],
        { complete: false },
      );
      await newer.started;
      older.release();
      await olderDone;
      expect(s.incarnations.get(F, "alpha")).toBe(T2);
      newer.release();
      await newerDone;

      expect(s.incarnations.get(F, "alpha")).toBe(T3);
      expect(older.calls).toEqual(["beta", "alpha"]);
      expect(newer.calls).toEqual(["gamma", "alpha"]);
      s.close();
    });

    /**
     * A complete scan that no longer sees alpha (released) parks on an earlier
     * purge; meanwhile a newer read finds alpha re-taken and records the
     * successor. The absence the older scan saw is out of date: it must not
     * forget the successor's record or purge its state.
     */
    test("an absence from an older complete scan does not release a successor recorded meanwhile", async () => {
      const s = build(kind);
      seed(s, "alpha");
      record(s, "alpha", T1);
      record(s, "beta", T1);
      const older = purgeSpy(s, "beta");
      const newer = purgeSpy(s);
      const olderDone = createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: older.purge,
      })([{ name: "beta", created_at: T2 }], { complete: true });
      await older.started;
      await createIncarnationReconciler({
        store: s.incarnations,
        fleet: () => F,
        purge: newer.purge,
      })([{ name: "alpha", created_at: T3 }], { complete: false });
      seed(s, "alpha");
      older.release();
      await olderDone;

      expect(older.calls).toEqual(["beta"]);
      expect(hasState(s, "alpha")).toEqual([true, true, true, true]);
      expect(s.incarnations.get(F, "alpha")).toBe(T3);
      s.close();
    });

    test("the release's own purge forgets the record, so the next agent is a first sighting", async () => {
      const s = build(kind);
      record(s, "alpha", T1);
      await createLocalAgentPurge(s)(F, "alpha");
      expect(s.incarnations.list(F).has("alpha")).toBe(false);
      s.close();
    });
  });
}

/**
 * Two laptops on one fleet: A runs the destroy, B only lists. B's local state
 * for the old box must not survive into the new one.
 */
describe("another laptop's release reaches this laptop's local state", () => {
  function laptop(backend: MemoryBackend) {
    const instanceListening = new MemoryInstanceListeningStore();
    const notifications = new MemoryNotificationStore();
    const incarnations = new MemoryIncarnationStore();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      instanceListening,
      notifications,
      incarnations,
    });
    return { hermetic, instanceListening, notifications, incarnations };
  }
  const fleet = FIXTURE_CONFIG.fleet_id;

  async function setUp() {
    const backend = seedFixtureFleet(new MemoryBackend());
    const a = laptop(backend);
    const b = laptop(backend);
    await b.hermetic.agents.list();
    for (const name of ["ember", "atlas"]) {
      b.instanceListening.set(fleet, name, true);
      b.notifications.setSeenStatus(fleet, `chat:${name}/bot`, "x");
    }
    const old = await backend.store.agents.get("ember");
    if (!old) throw new Error("fixture has no ember");
    // A name's `created_at` only moves forward, and the reconciler relies on
    // it: a successor is a later instant than the box it replaced.
    const later = (ms: number) => new Date(Date.parse(old.created_at) + ms).toISOString();
    return { backend, a, b, old, successor: later(1000), third: later(2000) };
  }

  test("the name re-taken with a new created_at: B purges on its next list", async () => {
    const { backend, a, b, old, successor } = await setUp();
    await drain(a.hermetic.agents.destroy({ name: "ember", yes: true }));
    await backend.store.agents.putIfAbsent({ ...old, created_at: successor, version: 1 });

    await b.hermetic.agents.list();

    expect(b.instanceListening.list(fleet)).toEqual(["atlas"]);
    expect(b.notifications.seenStatus(fleet, "chat:ember/bot")).toBeNull();
    expect(b.notifications.seenStatus(fleet, "chat:atlas/bot")).toBe("x");
    // Recorded by the same list that purged: the reconciler's purge must not
    // forget the claim it just won (`hermetic.ts` builds it without the store).
    expect(b.incarnations.get(fleet, "ember")).toBe(successor);

    // The operator sets up the successor; the next list leaves it alone.
    b.instanceListening.set(fleet, "ember", true);
    await b.hermetic.agents.list();
    expect(b.instanceListening.list(fleet)).toEqual(["atlas", "ember"]);
    expect(b.incarnations.get(fleet, "ember")).toBe(successor);
  });

  test("the name released and not re-taken: B purges on its next list", async () => {
    const { a, b } = await setUp();
    await drain(a.hermetic.agents.destroy({ name: "ember", yes: true }));
    await b.hermetic.agents.list();
    expect(b.instanceListening.list(fleet)).toEqual(["atlas"]);
    expect(b.incarnations.list(fleet).has("ember")).toBe(false);
  });

  test("a chat roster read reconciles too, without a list first", async () => {
    const { backend, a, b, old, successor, third } = await setUp();
    await drain(a.hermetic.agents.destroy({ name: "ember", yes: true }));
    await backend.store.agents.putIfAbsent({ ...old, created_at: successor, version: 1 });

    // Both doors chat reads rows through: one instance (`getAgent`), and all
    // of them (the scan).
    await b.hermetic.chat.swarms({ instance: "ember" });
    expect(b.instanceListening.list(fleet)).toEqual(["atlas"]);
    expect(b.notifications.seenStatus(fleet, "chat:ember/bot")).toBeNull();

    b.instanceListening.set(fleet, "ember", true);
    await backend.store.agents.delete("ember");
    await backend.store.agents.putIfAbsent({ ...old, created_at: third, version: 1 });
    await b.hermetic.chat.swarms({});
    expect(b.instanceListening.list(fleet)).toEqual(["atlas"]);
  });

  test("a row the scan cannot parse is not a released name: B keeps its state", async () => {
    const { backend, b } = await setUp();
    backend.unparseableRows = ["ember"];
    await b.hermetic.agents.list();
    await b.hermetic.chat.swarms({});
    expect(b.instanceListening.list(fleet)).toEqual(["atlas", "ember"]);
    expect(b.notifications.seenStatus(fleet, "chat:ember/bot")).toBe("x");
    expect(b.incarnations.list(fleet).has("ember")).toBe(true);

    backend.unparseableRows = [];
    await b.hermetic.agents.list();
    expect(b.instanceListening.list(fleet)).toEqual(["atlas", "ember"]);
  });

  test("the same incarnation, listed again: B keeps everything", async () => {
    const { b } = await setUp();
    await b.hermetic.agents.list();
    expect(b.instanceListening.list(fleet)).toEqual(["atlas", "ember"]);
    expect(b.notifications.seenStatus(fleet, "chat:ember/bot")).toBe("x");
  });
});
