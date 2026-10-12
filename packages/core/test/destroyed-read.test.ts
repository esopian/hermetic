import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { Agent, AgentTombstone } from "../src/schema/index.ts";
import { testHermetic } from "./helpers.ts";

/**
 * §6.7's audit read, `agents.destroyed`, and the two reads the release of a
 * name changed beside it: `agents.list` no longer shows a destroyed agent at
 * all, and `agents.history` can be windowed to one incarnation of a reused
 * name.
 */
function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

function tombstone(
  name: string,
  destroyedAt: string,
  over: Partial<AgentTombstone> = {},
): AgentTombstone {
  return {
    name,
    fleet_id: FIXTURE_CONFIG.fleet_id,
    created_at: "2026-07-01T00:00:00.000Z",
    created_by: "tester",
    destroyed_at: destroyedAt,
    destroyed_by: "tester",
    size: "small",
    region: FIXTURE_CONFIG.region,
    provider: "bedrock",
    profile_id: null,
    instance_id: null,
    volume_id: null,
    volume_kept: false,
    hermes_version: "0.14.2",
    legacy: false,
    ...over,
  };
}

/**
 * A pre-tombstone `destroyed` row, the shape an older build left behind: one
 * of the seeded rows, moved to `destroyed` in place.
 */
function legacyRow(backend: MemoryBackend, name: string, volumeId: string | null): Agent {
  const live = backend.agents.get("juniper")!;
  const row: Agent = {
    ...structuredClone(live),
    name,
    status: "destroyed",
    instance_id: null,
    volume_id: volumeId,
    updated_at: "2026-09-10T00:00:00.000Z",
  };
  backend.agents.set(name, row);
  return row;
}

describe("agents.destroyed", () => {
  test("lists the fixture's tombstone, and nothing the dashboard shows", async () => {
    const { hermetic } = seeded();
    const rows = await hermetic.agents.destroyed({});
    expect(rows.map((t) => t.name)).toEqual(["oriole"]);
    expect(rows[0]!.legacy).toBe(false);
    expect(rows[0]!.volume_kept).toBe(true);
    expect(rows[0]!.volume_id).toBe("vol-fixture00000000012");
  });

  test("merges tombstones newest first, then applies the name filter and limit", async () => {
    const { backend, hermetic } = seeded();
    await backend.store.events.appendTombstone(tombstone("wren", "2026-09-20T00:00:00.000Z"));
    await backend.store.events.appendTombstone(tombstone("wren", "2026-08-01T00:00:00.000Z"));
    await backend.store.events.appendTombstone(tombstone("pike", "2026-09-25T00:00:00.000Z"));

    const all = await hermetic.agents.destroyed({});
    const stamps = all.map((t) => t.destroyed_at);
    expect(stamps).toEqual([...stamps].sort().reverse());
    expect(all.map((t) => t.name)).toContain("oriole");

    const wren = await hermetic.agents.destroyed({ name: "wren" });
    expect(wren.map((t) => t.destroyed_at)).toEqual([
      "2026-09-20T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);

    const one = await hermetic.agents.destroyed({ limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.destroyed_at).toBe(stamps[0]!);
  });

  /**
   * The store itself, beneath `agents.destroyed`'s own merge and sort: the
   * range key orders the partition by name, so an unfiltered read that
   * limited before sorting would return the alphabetically last names.
   */
  test("the store's unfiltered read sorts across names before it limits", async () => {
    const backend = new MemoryBackend();
    await backend.store.events.appendTombstone(tombstone("zephyr", "2026-09-01T00:00:00.000Z"));
    await backend.store.events.appendTombstone(tombstone("atlas", "2026-09-04T00:00:00.000Z"));
    await backend.store.events.appendTombstone(tombstone("ember", "2026-09-05T00:00:00.000Z"));
    const rows = await backend.store.events.queryTombstones({ limit: 2 });
    expect(rows.map((t) => t.name)).toEqual(["ember", "atlas"]);
  });

  test("a name does not see the tombstones of a longer name it prefixes", async () => {
    const backend = new MemoryBackend();
    await backend.store.events.appendTombstone(tombstone("abc", "2026-09-03T00:00:00.000Z"));
    await backend.store.events.appendTombstone(tombstone("ab", "2026-09-02T00:00:00.000Z"));
    const ab = await backend.store.events.queryTombstones({ name: "ab" });
    expect(ab.map((t) => t.name)).toEqual(["ab"]);
  });

  test("synthesises a legacy destroyed row as a tombstone with legacy: true", async () => {
    const { backend, hermetic } = seeded();
    legacyRow(backend, "cinder", "vol-legacy");
    backend.events.push({
      name: "cinder",
      timestamp: "2026-09-09T12:00:00.000Z",
      actor: "arn:aws:iam::123456789012:user/old-laptop",
      action: "destroy",
      from_status: "destroying",
      to_status: "destroyed",
      detail: "destroy complete; data volume kept",
    });

    const [cinder] = await hermetic.agents.destroyed({ name: "cinder" });
    expect(cinder).toMatchObject({
      name: "cinder",
      legacy: true,
      destroyed_at: "2026-09-09T12:00:00.000Z",
      destroyed_by: "arn:aws:iam::123456789012:user/old-laptop",
      volume_id: "vol-legacy",
      volume_kept: true,
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
  });

  test("a legacy row with no destroy event falls back on updated_at and an unknown actor", async () => {
    const { backend, hermetic } = seeded();
    legacyRow(backend, "cinder", null);
    const [cinder] = await hermetic.agents.destroyed({ name: "cinder" });
    expect(cinder).toMatchObject({
      legacy: true,
      destroyed_at: "2026-09-10T00:00:00.000Z",
      destroyed_by: "unknown",
      volume_kept: false,
    });
  });

  test("a legacy row sorts among tombstones by its destroy time", async () => {
    const { backend, hermetic } = seeded();
    legacyRow(backend, "cinder", null);
    await backend.store.events.appendTombstone(tombstone("wren", "2026-09-20T00:00:00.000Z"));
    const names = (await hermetic.agents.destroyed({})).map((t) => t.name);
    expect(names.indexOf("wren")).toBeLessThan(names.indexOf("cinder"));
  });
});

describe("agents.list hides destroyed agents", () => {
  test("a legacy destroyed row is not in the list, but get still answers for it", async () => {
    const { backend, hermetic } = seeded();
    legacyRow(backend, "cinder", null);
    const names = (await hermetic.agents.list()).map((a) => a.name);
    expect(names).not.toContain("cinder");
    expect(names).not.toContain("oriole");
    expect((await hermetic.agents.get("cinder")).display_status).toBe("destroyed");
  });
});

describe("agents.history windows", () => {
  test("since and until are inclusive, and limit applies after the window", async () => {
    const { backend, hermetic } = seeded();
    for (const ts of [
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
    ]) {
      backend.events.push({ name: "wren", timestamp: ts, actor: "tester", action: "note" });
    }
    const window = await hermetic.agents.history({
      name: "wren",
      since: "2026-09-02T00:00:00.000Z",
      until: "2026-09-03T00:00:00.000Z",
    });
    expect(window.map((e) => e.timestamp)).toEqual([
      "2026-09-03T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
    ]);

    const older = await hermetic.agents.history({
      name: "wren",
      until: "2026-09-02T00:00:00.000Z",
      limit: 1,
    });
    expect(older.map((e) => e.timestamp)).toEqual(["2026-09-02T00:00:00.000Z"]);
  });

  test("the fixture tombstone's bounds read back oriole's whole life", async () => {
    const { hermetic } = seeded();
    const [oriole] = await hermetic.agents.destroyed({ name: "oriole" });
    const life = await hermetic.agents.history({
      name: "oriole",
      since: oriole!.created_at,
      until: oriole!.destroyed_at,
    });
    expect(life.map((e) => e.action)).toEqual([
      "release",
      "destroy",
      "ready",
      "stage",
      "bootstrap",
      "create",
    ]);
  });

  test("_fleet is still admitted", async () => {
    const { hermetic } = seeded();
    expect(
      await hermetic.agents.history({ name: "_fleet", since: "2026-01-01T00:00:00.000Z" }),
    ).toBeArray();
  });
});
