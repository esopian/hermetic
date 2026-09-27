/**
 * Fleet advisories as notifications (§4.9).
 *
 * The property under test everywhere below is that an advisory is a
 * *condition*, not an event. It notifies once while it holds, the next scan
 * finds the row it already wrote rather than writing a second, a scan that no
 * longer sees it sets `resolved_at`, and a later recurrence is a new row rather
 * than a revival of the closed one.
 *
 * Each of the four conditions is tested twice: once directly against
 * `observeAdvisories`, which is where the rule lives, and once through the core
 * method that already computes the condition, which is the seam that would
 * silently stop delivering if somebody moved the call.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  seedFixtureAgents,
  seedFixtureFleet,
  seedFixtureFoundation,
  seedFixtureVolumes,
} from "../src/backend/memory.ts";
import { DEFAULT_BEDROCK_MODEL_IDS } from "../src/aws/index.ts";
import {
  ADVISORY_BEDROCK_GRANT,
  ADVISORY_FOUNDATION_UPDATE,
  ADVISORY_LOOSE_VOLUME,
  ADVISORY_PREFIX,
  ADVISORY_PROFILE_REVISION,
  MemoryNotificationStore,
  bedrockGrantAdvisories,
  foundationUpdateAdvisories,
  looseVolumeAdvisories,
  notificationsList,
  observeAdvisories,
  profileRevisionAdvisories,
} from "../src/chat/notifications.ts";
import type { Advisory, NotificationDeps, NotificationStore } from "../src/chat/notifications.ts";
import { SqliteNotificationStore, migrate } from "../src/local/db/index.ts";
import type {
  AgentView,
  DisplayStatus,
  Notification,
  VolumeGroup,
  VolumeView,
} from "../src/schema/index.ts";
import type { HermeticDeps } from "../src/hermetic.ts";
import { testHermetic } from "./helpers.ts";

const FLEET = FIXTURE_CONFIG.fleet_id;

function depsFor(store: NotificationStore, fleet: string | null = FLEET): NotificationDeps {
  return { store, fleet: () => fleet };
}

/** Every advisory row this store holds, newest first, resolved ones included. */
function rows(store: NotificationStore, fleet: string | null = FLEET): Notification[] {
  return store.list({ limit: 500 }, fleet).filter((r) => r.kind === "fleet.advisory");
}

/** The keys of the rows still open, sorted so an assertion does not depend on clock ties. */
function openKeys(store: NotificationStore, family?: string): string[] {
  const prefix = family === undefined ? ADVISORY_PREFIX : `${ADVISORY_PREFIX}${family}`;
  return rows(store)
    .filter((r) => r.resolved_at == null && (r.key ?? "").startsWith(prefix))
    .map((r) => r.key as string)
    .sort();
}

function advisory(key: string, title = "held"): Advisory {
  return {
    key: `${ADVISORY_PREFIX}${key}`,
    class: "info",
    title,
    actions: [{ label: "Volumes", target: "volumes" }],
  };
}

// ── the rule itself ──────────────────────────────────────────────────────────

describe("observeAdvisories holds a condition and closes it", () => {
  test("a held condition raises exactly one row", () => {
    const store = new MemoryNotificationStore();
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    expect(rows(store)).toHaveLength(1);
    expect(rows(store)[0]?.source).toBe("fleet");
    expect(rows(store)[0]?.kind).toBe("fleet.advisory");
    expect(rows(store)[0]?.fleet_id).toBe(FLEET);
  });

  test("a second scan of the same condition does not write a second row", () => {
    const store = new MemoryNotificationStore();
    const held = [advisory("demo:one")];
    observeAdvisories(depsFor(store), "demo", held);
    const first = rows(store)[0]?.id;
    observeAdvisories(depsFor(store), "demo", held);
    observeAdvisories(depsFor(store), "demo", held);
    expect(rows(store)).toHaveLength(1);
    expect(rows(store)[0]?.id).toBe(first);
  });

  test("a scan that no longer sees the condition resolves the row", () => {
    const store = new MemoryNotificationStore();
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    observeAdvisories(depsFor(store), "demo", []);
    expect(openKeys(store)).toEqual([]);
    expect(rows(store)).toHaveLength(1);
    expect(rows(store)[0]?.resolved_at).not.toBeNull();
  });

  test("a recurrence is a new row, never a revival of the resolved one", () => {
    const store = new MemoryNotificationStore();
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    const first = rows(store)[0]?.id;
    observeAdvisories(depsFor(store), "demo", []);
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    const all = rows(store);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.resolved_at == null)).toHaveLength(1);
    expect(all.find((r) => r.resolved_at == null)?.id).not.toBe(first);
  });

  test("per-item keys: clearing one item resolves only that item's row", () => {
    const store = new MemoryNotificationStore();
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one"), advisory("demo:two")]);
    expect(openKeys(store)).toEqual([`${ADVISORY_PREFIX}demo:one`, `${ADVISORY_PREFIX}demo:two`]);
    observeAdvisories(depsFor(store), "demo", [advisory("demo:two")]);
    expect(openKeys(store)).toEqual([`${ADVISORY_PREFIX}demo:two`]);
  });

  test("a family resolves only its own keys, and never a lookalike prefix", () => {
    const store = new MemoryNotificationStore();
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    observeAdvisories(depsFor(store), "demos", [advisory("demos:one")]);
    // `demo` no longer holds anything; `demos` is a different family and must
    // survive the reconciliation, prefix or no prefix.
    observeAdvisories(depsFor(store), "demo", []);
    expect(openKeys(store)).toEqual([`${ADVISORY_PREFIX}demos:one`]);
  });

  test("the same rule holds over the SQLite store the portal and the CLI share", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new SqliteNotificationStore(db);
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    expect(rows(store)).toHaveLength(1);
    observeAdvisories(depsFor(store), "demo", []);
    expect(openKeys(store)).toEqual([]);
    observeAdvisories(depsFor(store), "demo", [advisory("demo:one")]);
    expect(openKeys(store)).toEqual([`${ADVISORY_PREFIX}demo:one`]);
    expect(rows(store)).toHaveLength(2);
    db.close();
  });

  test("an unwritable inbox never fails a scan", () => {
    const broken = {
      insert() {
        throw new Error("disk is gone");
      },
    } as unknown as NotificationStore;
    expect(() => observeAdvisories(depsFor(broken), "demo", [advisory("demo:one")])).not.toThrow();
  });
});

// ── condition 1: the foundation is behind ────────────────────────────────────

const AVAILABLE = { foundation_version: 11, template_sha256: "sha-new", hermeticd_version: "0.9.0" };
const CURRENT_BEHIND = {
  foundation_version: 10,
  template_sha256: "sha-old",
  hermeticd_version: "0.8.0",
};

describe("fleet.advisory: the foundation is behind this build", () => {
  test("the row names every comparison the flag is true for", () => {
    const [row] = foundationUpdateAdvisories({
      update_available: true,
      current: CURRENT_BEHIND,
      available: AVAILABLE,
    });
    expect(row?.key).toBe(`${ADVISORY_PREFIX}${ADVISORY_FOUNDATION_UPDATE}`);
    expect(row?.class).toBe("needs_action");
    expect(row?.detail).toContain("on v10, this build ships v11");
    expect(row?.detail).toContain("template has changed");
    expect(row?.detail).toContain("hermeticd 0.8.0 to 0.9.0");
    expect(row?.actions[0]?.target).toBe("foundation");
  });

  test("an up-to-date fleet holds nothing", () => {
    expect(
      foundationUpdateAdvisories({
        update_available: false,
        current: CURRENT_BEHIND,
        available: AVAILABLE,
      }),
    ).toEqual([]);
  });

  test("foundation.status raises it once, and a second status finds the same row", async () => {
    const backend = behindFoundation();
    const store = new MemoryNotificationStore();
    const hermetic = core(backend, store);
    await hermetic.foundation.status();
    const first = openKeys(store, ADVISORY_FOUNDATION_UPDATE);
    expect(first).toEqual([`${ADVISORY_PREFIX}${ADVISORY_FOUNDATION_UPDATE}`]);
    await hermetic.foundation.status();
    expect(rows(store).filter((r) => (r.key ?? "").includes(ADVISORY_FOUNDATION_UPDATE))).toHaveLength(
      1,
    );
  });

  test("an up-to-date fleet resolves the row the behind one raised", async () => {
    const backend = behindFoundation();
    const store = new MemoryNotificationStore();
    await core(backend, store).foundation.status();
    expect(openKeys(store, ADVISORY_FOUNDATION_UPDATE)).toHaveLength(1);

    const fresh = seedFixtureFoundation(new MemoryBackend());
    await core(fresh, store).foundation.status();
    expect(openKeys(store, ADVISORY_FOUNDATION_UPDATE)).toEqual([]);
  });
});

// ── condition 2: a model the stack does not grant ────────────────────────────

describe("fleet.advisory: a Bedrock model the fleet's stack does not grant", () => {
  test("one row per model, keyed on the model id", () => {
    const held = bedrockGrantAdvisories(["zai.glm-4.7-flash", "anthropic.claude-x-v1:0"]);
    expect(held.map((a) => a.key)).toEqual([
      `${ADVISORY_PREFIX}${ADVISORY_BEDROCK_GRANT}:zai.glm-4.7-flash`,
      `${ADVISORY_PREFIX}${ADVISORY_BEDROCK_GRANT}:anthropic.claude-x-v1:0`,
    ]);
    expect(held[0]?.class).toBe("needs_action");
    expect(held[0]?.actions[0]?.target).toBe("foundation");
  });

  test("foundation.status raises one row per ungranted model and does not duplicate", async () => {
    const backend = grantingNothing();
    const store = new MemoryNotificationStore();
    const hermetic = core(backend, store);
    await hermetic.foundation.status();
    const raised = openKeys(store, ADVISORY_BEDROCK_GRANT);
    expect(raised.length).toBe(DEFAULT_BEDROCK_MODEL_IDS.length);
    await hermetic.foundation.status();
    expect(openKeys(store, ADVISORY_BEDROCK_GRANT)).toEqual(raised);
  });

  test("granting one model resolves only that model's row", async () => {
    const backend = grantingNothing();
    const store = new MemoryNotificationStore();
    await core(backend, store).foundation.status();
    const before = openKeys(store, ADVISORY_BEDROCK_GRANT);
    const granted = DEFAULT_BEDROCK_MODEL_IDS[0] as string;

    backend.fleetItem = { ...backend.fleetItem!, bedrock_model_ids: [granted] };
    await core(backend, store).foundation.status();
    const after = openKeys(store, ADVISORY_BEDROCK_GRANT);
    expect(after).toHaveLength(before.length - 1);
    expect(after).not.toContain(`${ADVISORY_PREFIX}${ADVISORY_BEDROCK_GRANT}:${granted}`);
  });

  test("a fleet that records no grant is never reported as clean", async () => {
    const backend = grantingNothing();
    const store = new MemoryNotificationStore();
    await core(backend, store).foundation.status();
    expect(openKeys(store, ADVISORY_BEDROCK_GRANT).length).toBeGreaterThan(0);

    // `bedrock_model_ids` absent means *not compared*, which must not resolve.
    const { bedrock_model_ids: _gone, ...rest } = backend.fleetItem!;
    backend.fleetItem = rest;
    await core(backend, store).foundation.status();
    expect(openKeys(store, ADVISORY_BEDROCK_GRANT).length).toBeGreaterThan(0);
  });
});

// ── condition 3: a volume nobody is reading ──────────────────────────────────

/** `vol-fixture00000000012` (destroyed row) and `vol-fixture0000000dorado` (no row). */
const LOOSE = [
  `${ADVISORY_PREFIX}${ADVISORY_LOOSE_VOLUME}:vol-fixture00000000012`,
  `${ADVISORY_PREFIX}${ADVISORY_LOOSE_VOLUME}:vol-fixture0000000dorado`,
].sort();

describe("fleet.advisory: a volume that is free and that no live row names", () => {
  test("only group no_agent holds; an owned detached volume does not", () => {
    const held = looseVolumeAdvisories([
      volumeView("vol-a", "no_agent", { free_for_ms: 3 * 86_400_000 }),
      volumeView("vol-b", "detached", {}),
      volumeView("vol-c", "attached", { free_for_ms: null }),
    ]);
    expect(held.map((a) => a.ref)).toEqual(["vol-a"]);
    expect(held[0]?.class).toBe("info");
    expect(held[0]?.detail).toBe("500 GiB in us-west-2a - free for 3d - $40.00/mo");
    expect(held[0]?.actions[0]?.target).toBe("volumes");
  });

  test("volumes.list raises one row per loose volume and does not duplicate", async () => {
    const backend = seedFixtureVolumes(seedFixtureFleet(new MemoryBackend()));
    const store = new MemoryNotificationStore();
    const hermetic = core(backend, store);
    await hermetic.volumes.list({});
    expect(openKeys(store, ADVISORY_LOOSE_VOLUME)).toEqual(LOOSE);
    await hermetic.volumes.list({});
    expect(rows(store).filter((r) => (r.key ?? "").includes(ADVISORY_LOOSE_VOLUME))).toHaveLength(2);
  });

  test("deleting one loose volume resolves its row and leaves the other asking", async () => {
    const backend = seedFixtureVolumes(seedFixtureFleet(new MemoryBackend()));
    const store = new MemoryNotificationStore();
    const hermetic = core(backend, store);
    await hermetic.volumes.list({});
    await hermetic.volumes.delete({ volume_id: "vol-fixture0000000dorado", yes: true });
    await hermetic.volumes.list({});
    expect(openKeys(store, ADVISORY_LOOSE_VOLUME)).toEqual([
      `${ADVISORY_PREFIX}${ADVISORY_LOOSE_VOLUME}:vol-fixture00000000012`,
    ]);
  });

  test("--unattached narrows what is shown, never what is reconciled", async () => {
    const backend = seedFixtureVolumes(seedFixtureFleet(new MemoryBackend()));
    const store = new MemoryNotificationStore();
    const hermetic = core(backend, store);
    await hermetic.volumes.list({});
    await hermetic.volumes.list({ unattached: true });
    expect(openKeys(store, ADVISORY_LOOSE_VOLUME)).toEqual(LOOSE);
  });
});

// ── condition 4: a profile that has moved past the agent pinned to it ────────

const ATLAS_KEY = `${ADVISORY_PREFIX}${ADVISORY_PROFILE_REVISION}:atlas`;

describe("fleet.advisory: an agent on an older provider profile revision", () => {
  test("agents.list raises it for the agent whose profile moved", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const store = new MemoryNotificationStore();
    await core(backend, store).agents.list();
    expect(openKeys(store, ADVISORY_PROFILE_REVISION)).toContain(ATLAS_KEY);
    const row = rows(store).find((r) => r.key === ATLAS_KEY);
    expect(row?.class).toBe("info");
    expect(row?.agent).toBe("atlas");
    expect(row?.detail).toContain("r2");
    expect(row?.actions[0]?.target).toBe("agent");
  });

  test("a second scan finds the row it already wrote", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const store = new MemoryNotificationStore();
    const hermetic = core(backend, store);
    await hermetic.agents.list();
    const before = rows(store).length;
    await hermetic.agents.list();
    await hermetic.agents.list();
    expect(rows(store)).toHaveLength(before);
  });

  test("rolling the agent forward resolves its row, and falling behind again is a new row", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const store = new MemoryNotificationStore();
    await core(backend, store).agents.list();
    const first = rows(store).find((r) => r.key === ATLAS_KEY)?.id;
    expect(first).toBeDefined();

    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, profile_revision: 2 });
    await core(backend, store).agents.list();
    expect(openKeys(store, ADVISORY_PROFILE_REVISION)).not.toContain(ATLAS_KEY);

    backend.agents.set("atlas", { ...atlas, profile_revision: 1 });
    await core(backend, store).agents.list();
    const open = rows(store).filter((r) => r.key === ATLAS_KEY && r.resolved_at == null);
    expect(open).toHaveLength(1);
    expect(open[0]?.id).not.toBe(first);
  });

  test("a filtered scan does not resolve the agents it did not look at", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const store = new MemoryNotificationStore();
    const hermetic = core(backend, store);
    await hermetic.agents.list();
    const before = openKeys(store, ADVISORY_PROFILE_REVISION);
    await hermetic.agents.list({ status: "stopped" });
    expect(openKeys(store, ADVISORY_PROFILE_REVISION)).toEqual(before);
  });

  test("a destroyed row is nobody's rollout", () => {
    const held = profileRevisionAdvisories([
      agentView("gone", "destroyed"),
      agentView("live", "ready"),
    ]);
    expect(held.map((a) => a.agent)).toEqual(["live"]);
  });
});

// ── shared scaffolding ───────────────────────────────────────────────────────

const FAST: NonNullable<HermeticDeps["foundation"]> = { changeSetPollMs: 0, heartbeatMs: 60_000 };

function core(backend: MemoryBackend, notifications: NotificationStore) {
  return testHermetic({ backend, config: FIXTURE_CONFIG, notifications, foundation: FAST });
}

/** A fleet as it stood before this build: an older contract and an older hermeticd. */
function behindFoundation(): MemoryBackend {
  const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
  const { foundation_version: _v, foundation_template_sha256: _s, ...rest } = backend.fleetItem!;
  backend.fleetItem = { ...rest, min_hermetic_version: "0.4.0" };
  return backend;
}

/**
 * The fields `looseVolumeAdvisories` reads, and only those. Built through a
 * cast rather than a whole `VolumeView` because the builder is deliberately
 * narrow and a full literal would assert about twenty fields it never looks at.
 */
function volumeView(volume_id: string, group: VolumeGroup, over: Partial<VolumeView> = {}): VolumeView {
  return {
    volume_id,
    group,
    size_gib: volume_id === "vol-a" ? 500 : 100,
    availability_zone: "us-west-2a",
    free_for_ms: 0,
    monthly_cost_usd: volume_id === "vol-a" ? 40 : 8,
    ...over,
  } as VolumeView;
}

/** Likewise: the three fields `profileRevisionAdvisories` decides on. */
function agentView(name: string, display_status: DisplayStatus): AgentView {
  return { name, display_status, update_available: true } as AgentView;
}

/** A fleet whose recorded grant is empty, so every default model reads as stale. */
function grantingNothing(): MemoryBackend {
  const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
  backend.fleetItem = { ...backend.fleetItem!, bedrock_model_ids: [] };
  return backend;
}

// ── what the reconciliation reads, and what the badge counts ─────────────────

/**
 * Both stores, because the fixture portal runs on one and every real laptop on
 * the other, and a rule that held over only one of them would be a bug nobody
 * saw until it was in front of an operator.
 */
const STORES: Array<[string, () => NotificationStore]> = [
  ["memory", () => new MemoryNotificationStore()],
  [
    "sqlite",
    () => {
      const db = new Database(":memory:");
      migrate(db);
      return new SqliteNotificationStore(db);
    },
  ],
];

const LOOSE_FAMILY = `${ADVISORY_PREFIX}${ADVISORY_LOOSE_VOLUME}`;

for (const [label, make] of STORES) {
  describe(`open advisory keys over the ${label} store`, () => {
    /**
     * The bound the reconciliation used to have. It read a window of the newest
     * rows, so a condition an ordinary week of op outcomes had pushed out of
     * that window could never be closed again.
     */
    test("a condition buried under five hundred newer rows still resolves", () => {
      const store = make();
      const key = `${LOOSE_FAMILY}:vol-buried`;
      observeAdvisories(depsFor(store), ADVISORY_LOOSE_VOLUME, [
        advisory(`${ADVISORY_LOOSE_VOLUME}:vol-buried`),
      ]);
      const base = Date.now();
      for (let i = 0; i < 501; i += 1) {
        store.insert({
          source: "operation",
          kind: "operation.done",
          class: "ok",
          title: `noise ${i}`,
          fleet: FLEET,
          at: new Date(base + (i + 1) * 1000).toISOString(),
        });
      }
      expect(store.openKeys(LOOSE_FAMILY, FLEET)).toEqual([key]);

      observeAdvisories(depsFor(store), ADVISORY_LOOSE_VOLUME, []);
      expect(store.openKeys(LOOSE_FAMILY, FLEET)).toEqual([]);
      // Read past the window the reconciliation used to be bounded by, which
      // is the only way to see the row this test buried.
      const row = store.list({ limit: 5000 }, FLEET).find((r) => r.key === key);
      expect(row?.resolved_at ?? null).not.toBeNull();
    });

    /**
     * `_` is a SQL `LIKE` wildcard and every family name has one in it, so the
     * escaping is the only thing between `loose_volume` and somebody else's row.
     */
    test("a lookalike family is never owned", () => {
      const store = make();
      observeAdvisories(depsFor(store), ADVISORY_LOOSE_VOLUME, [
        advisory(`${ADVISORY_LOOSE_VOLUME}:vol-a`),
      ]);
      observeAdvisories(depsFor(store), `${ADVISORY_LOOSE_VOLUME}s`, [
        advisory(`${ADVISORY_LOOSE_VOLUME}s:vol-b`),
      ]);
      store.insert({
        source: "fleet",
        kind: "fleet.advisory",
        class: "info",
        title: "a key an unescaped underscore would match",
        fleet: FLEET,
        key: `${ADVISORY_PREFIX}looseXvolume:vol-c`,
      });

      expect(store.openKeys(LOOSE_FAMILY, FLEET)).toEqual([`${LOOSE_FAMILY}:vol-a`]);
      // …and the family's own reconciliation closes its row and only its row.
      observeAdvisories(depsFor(store), ADVISORY_LOOSE_VOLUME, []);
      expect(openKeys(store).sort()).toEqual(
        [`${ADVISORY_PREFIX}looseXvolume:vol-c`, `${LOOSE_FAMILY}s:vol-b`].sort(),
      );
    });

    /**
     * The badge is about what still holds. A resolved advisory stays in the
     * inbox — the operator may never have read it, and the history of a
     * condition that came and went is worth keeping — but it stops asking.
     */
    test("a resolved row is still listed and counted in neither total", () => {
      const store = make();
      const key = `${ADVISORY_PREFIX}${ADVISORY_FOUNDATION_UPDATE}`;
      const held: Advisory = {
        key,
        class: "needs_action",
        title: "Foundation update available",
        actions: [{ label: "Review", target: "foundation" }],
      };
      observeAdvisories(depsFor(store), ADVISORY_FOUNDATION_UPDATE, [held]);
      expect(store.counts(FLEET)).toEqual({ unread: 1, needs_action: 1 });

      observeAdvisories(depsFor(store), ADVISORY_FOUNDATION_UPDATE, []);
      const result = notificationsList(depsFor(store));
      expect(result.unread).toBe(0);
      expect(result.needs_action).toBe(0);
      const row = result.notifications.find((r) => r.key === key);
      expect(row).toBeDefined();
      // §4.9: `resolved_at` is the world's acknowledgement and `read_at` is
      // the operator's. Resolving must not quietly perform the other one.
      expect(row?.resolved_at ?? null).not.toBeNull();
      expect(row?.read_at ?? null).toBeNull();
    });
  });
}
