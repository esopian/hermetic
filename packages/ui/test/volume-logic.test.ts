import { describe, expect, test } from "bun:test";
import type { AgentView, VolumeView } from "../src/api/index.ts";
import {
  TOMBSTONE_CAP,
  boardVolumes,
  settleVolumes,
  suggestedName,
  tombstones,
  volumeLine,
  volumeOf,
} from "../src/logic/volume-logic.ts";

function volume(overrides: Partial<VolumeView> = {}): VolumeView {
  return {
    volume_id: "vol-1",
    size_gib: 100,
    state: "available",
    availability_zone: "us-west-2a",
    created_at: "2026-06-01T00:00:00.000Z",
    agent: "cinder",
    managed: true,
    role_data: true,
    group: "no_agent",
    attachments: [],
    attached: false,
    attached_to: null,
    agent_status: null,
    free_for_ms: 3 * 86_400_000,
    snapshots: 7,
    newest_snapshot_at: "2026-09-01T00:00:00.000Z",
    monthly_cost_usd: 8,
    ambiguous_with: [],
    ...overrides,
  } as VolumeView;
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "atlas",
    volume_id: "vol-1",
    volume_gib: 100,
    display_status: "ready",
    ...overrides,
  } as AgentView;
}

describe("tombstones: what a volume has to be to reach the fleet board", () => {
  test("only volumes with no agent", () => {
    const rows = [
      volume({ volume_id: "vol-loose", group: "no_agent" }),
      volume({ volume_id: "vol-att", group: "attached", attached: true }),
      volume({ volume_id: "vol-det", group: "detached" }),
      volume({ volume_id: "vol-amb", group: "ambiguous" }),
      volume({ volume_id: "vol-stray", group: "unmanaged", managed: false }),
    ];
    expect(tombstones(rows, []).map((v) => v.volume_id)).toEqual(["vol-loose"]);
  });

  test("an ambiguous volume is never a tombstone, because a tombstone names an agent", () => {
    const rows = [volume({ volume_id: "vol-amb", group: "ambiguous", ambiguous_with: ["vol-x"] })];
    expect(tombstones(rows, [])).toEqual([]);
  });

  test("drawn whenever no live agent owns it; suppressed beside its live owner's card", () => {
    const rows = [volume({ volume_id: "vol-oriole", agent: "oriole" })];
    // A legacy destroyed row is never on screen, so the volume is all there is.
    const gone = [agent({ name: "oriole", display_status: "destroyed", volume_id: "vol-oriole" })];
    expect(tombstones(rows, gone).length).toBe(1);
    // A live agent under the same name carries the volume on its own card.
    const live = [agent({ name: "oriole", display_status: "ready", volume_id: "vol-oriole" })];
    expect(tombstones(rows, live).length).toBe(0);
  });

  test("newest-free first, so the cap keeps what still matters", () => {
    const rows = [
      volume({ volume_id: "vol-old", agent: "a", free_for_ms: 90 * 86_400_000 }),
      volume({ volume_id: "vol-new", agent: "b", free_for_ms: 60_000 }),
    ];
    expect(tombstones(rows, []).map((v) => v.volume_id)).toEqual(["vol-new", "vol-old"]);
  });
});

describe("boardVolumes", () => {
  test("caps the cards and summarises the rest", () => {
    const rows = Array.from({ length: TOMBSTONE_CAP + 3 }, (_, i) =>
      volume({ volume_id: `vol-${i}`, agent: `a${i}`, free_for_ms: i * 1000, size_gib: 100 }),
    );
    const board = boardVolumes(rows, []);
    expect(board.shown.length).toBe(TOMBSTONE_CAP);
    expect(board.overflow.count).toBe(3);
    expect(board.overflow.gib).toBe(300);
  });

  test("counts what the fleet deliberately never shows, so the card can say so", () => {
    const rows = [
      volume({ volume_id: "vol-a", group: "ambiguous" }),
      volume({ volume_id: "vol-b", group: "unmanaged", managed: false }),
      volume({ volume_id: "vol-c", group: "attached", attached: true }),
    ];
    expect(boardVolumes(rows, []).hiddenElsewhere).toBe(2);
  });
});

describe("volumeLine: what an agent card says about its own volume", () => {
  test("nothing at all when the row names no volume", () => {
    expect(volumeLine(agent({ volume_id: null }), null)).toBeNull();
  });

  test("no state claimed before the inventory has been read", () => {
    // The row records an id, not whether anything is attached to it; claiming
    // `attached` on the strength of the row alone would be a guess.
    expect(volumeLine(agent(), null)).toEqual({
      label: "vol-1 · 100 GiB",
      state: "",
      color: "var(--fg3)",
      id: "vol-1",
      note: "100 GiB",
    });
  });

  /**
   * The card shows about half of a real 21-character EBS id, and the half it
   * shows is the half every volume in the account shares — so `label` is a
   * label and `id` is the value the tooltip and the clipboard need.
   */
  test("the whole id survives the elision the label makes", () => {
    const long = "vol-0a1b2c3d4e5f67890";
    const line = volumeLine(agent({ volume_id: long }), volume({ volume_id: long, attached: true }));
    expect(line?.label).toContain("…");
    expect(line?.label).not.toContain(long);
    expect(line?.id).toBe(long);
    expect(line?.note).toBe("100 GiB · attached");
  });

  test("attached and detached read differently, and detached is loud", () => {
    expect(volumeLine(agent(), volume({ attached: true }))?.state).toBe("attached");
    const loose = volumeLine(agent(), volume({ attached: false }));
    expect(loose?.state).toBe("detached");
    expect(loose?.color).toBe("var(--warn)");
  });
});

describe("volumeOf", () => {
  test("matches the row's volume id", () => {
    const rows = [volume({ volume_id: "vol-1" }), volume({ volume_id: "vol-2" })];
    expect(volumeOf(agent({ volume_id: "vol-2" }), rows)?.volume_id).toBe("vol-2");
    expect(volumeOf(agent({ volume_id: "vol-9" }), rows)).toBeNull();
  });
});

describe("suggestedName", () => {
  test("the tag itself when it is free", () => {
    expect(suggestedName("cinder", new Set())).toBe("cinder");
  });

  test("the next free variant when it is not — a destroyed row keeps its name (§4.3)", () => {
    expect(suggestedName("cinder", new Set(["cinder"]))).toBe("cinder-2");
    expect(suggestedName("cinder", new Set(["cinder", "cinder-2"]))).toBe("cinder-3");
  });

  test("an untagged volume suggests nothing", () => {
    expect(suggestedName(null, new Set())).toBe("");
  });
});

describe("settleVolumes", () => {
  const row = (name: string, display_status: AgentView["display_status"]) => ({ name, display_status });

  test("the first read primes and is no change", () => {
    const { next, changed } = settleVolumes(null, [row("atlas", "ready"), row("heron", "error")]);
    expect(changed).toBe(false);
    expect([...next]).toEqual([
      ["atlas", "up"],
      ["heron", "error"],
    ]);
  });

  test("a destroy coming to rest is a change; the mid-flight rows before it are not", () => {
    let s = settleVolumes(null, [row("brown-wolf", "ready")]).next;
    const going = settleVolumes(s, [row("brown-wolf", "destroying")]);
    expect(going.changed).toBe(false);
    s = going.next;
    expect(settleVolumes(s, [row("brown-wolf", "destroyed")]).changed).toBe(true);
  });

  test("a destroy that deleted the row is a change: the name leaves the fleet", () => {
    let s = settleVolumes(null, [row("brown-wolf", "ready"), row("atlas", "ready")]).next;
    s = settleVolumes(s, [row("brown-wolf", "destroying"), row("atlas", "ready")]).next;
    const gone = settleVolumes(s, [row("atlas", "ready")]);
    expect(gone.changed).toBe(true);
    expect([...gone.next.keys()]).toEqual(["atlas"]);
    // Once forgotten, the absence is not a change a second time.
    expect(settleVolumes(gone.next, [row("atlas", "ready")]).changed).toBe(false);
  });

  test("a new agent reaching ready is a change", () => {
    const s = settleVolumes(null, [row("atlas", "ready")]).next;
    const creating = settleVolumes(s, [row("atlas", "ready"), row("cinder-2", "creating")]);
    expect(creating.changed).toBe(false);
    const up = settleVolumes(creating.next, [row("atlas", "ready"), row("cinder-2", "ready")]);
    expect(up.changed).toBe(true);
  });

  test("heartbeat flaps move no volume", () => {
    const s = settleVolumes(null, [row("atlas", "ready")]).next;
    expect(settleVolumes(s, [row("atlas", "degraded")]).changed).toBe(false);
    expect(settleVolumes(s, [row("atlas", "unreachable")]).changed).toBe(false);
  });
});
