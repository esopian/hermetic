/**
 * §4.6's create presets: `presets.get` / `presets.set` over one `prefs` row,
 * the read-side healing of a row another build wrote, the strict write rules,
 * and `resolveCreatePreset` — the rule `agent create` fills its machine by.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermeticError } from "../src/errors.ts";
import { MemoryPresetStore, createPresets, resolveCreatePreset } from "../src/local/create-presets.ts";
import { SqlitePresetStore, openMemoryDb } from "../src/local/db/index.ts";
import { openHermetic } from "../src/open.ts";
import {
  BUILTIN_PRESETS,
  CREATE_PRESETS_PREF,
  PresetsSetInput,
  StoredCreatePresets,
  presetsView,
} from "../src/schema/index.ts";
import { SIZE_IDS } from "../src/shared/sizes.ts";

const RESEARCH = { id: "research", name: "research", size: "large", volume_gib: 300, root_gib: 60 };

function presets(store = new MemoryPresetStore()) {
  return { store, api: createPresets({ store }) };
}

async function refusal(p: Promise<unknown>): Promise<HermeticError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("the built-ins", () => {
  test("CPU and GPU lanes, every size a real one, and GPU presets on the gpu-* sizes", () => {
    const ids = new Set<string>(SIZE_IDS);
    for (const p of BUILTIN_PRESETS) expect(ids.has(p.size)).toBe(true);
    expect(
      BUILTIN_PRESETS.filter((p) => p.lane === "gpu").every((p) => p.size.startsWith("gpu-")),
    ).toBe(true);
    expect(BUILTIN_PRESETS.filter((p) => p.lane === "cpu").map((p) => p.name)).toEqual([
      "Micro",
      "Scratch",
      "Light",
      "Standard",
      "Heavy",
      "Big context",
      "XXL",
    ]);
  });

  test("Standard is a real bundle: medium · 100 GiB · 40 GiB", () => {
    expect(BUILTIN_PRESETS.find((p) => p.id === "standard")).toMatchObject({
      size: "medium",
      volume_gib: 100,
      root_gib: 40,
    });
  });
});

describe("presets.get", () => {
  test("no row is the built-in loadout, Light · Standard* · Heavy · GPU", async () => {
    const { api } = presets();
    const view = await api.get({});
    expect(view.source).toBe("builtin");
    expect(view.loadout).toEqual(["light", "standard", "heavy", "gpu"]);
    expect(view.default).toBe("standard");
    expect(view.presets).toHaveLength(BUILTIN_PRESETS.length);
  });

  test("an unreadable row falls back to the built-ins rather than failing", async () => {
    const store = new MemoryPresetStore();
    await store.write("{not json");
    expect((await createPresets({ store }).get({})).source).toBe("builtin");
    await store.write(JSON.stringify({ version: 99, loadout: [] }));
    expect((await createPresets({ store }).get({})).source).toBe("builtin");
  });

  test("a row another build wrote is healed on read, not refused", async () => {
    const store = new MemoryPresetStore();
    await store.write(
      JSON.stringify({
        version: 1,
        loadout: ["heavy", "gone", "heavy", "micro", "xxl"],
        default: "gone",
        custom: [],
      }),
    );
    const view = await createPresets({ store }).get({});
    // Four slots; a slot naming nothing, or a preset twice, is emptied.
    expect(view.loadout).toEqual(["heavy", null, null, "micro"]);
    // A default that is not in the loadout moves to its first filled slot.
    expect(view.default).toBe("heavy");
  });

  test("a custom preset naming an unknown size is kept, and reported unusable", async () => {
    const store = new MemoryPresetStore();
    const odd = { ...RESEARCH, id: "odd", size: "quantum-9" };
    await store.write(
      JSON.stringify({ version: 1, loadout: ["odd", null, null, null], default: "odd", custom: [odd] }),
    );
    const view = await createPresets({ store }).get({});
    expect(view.presets.find((p) => p.id === "odd")).toMatchObject({
      size: "quantum-9",
      usable: false,
      lane: "custom",
    });
    expect(view.loadout[0]).toBe("odd");
  });
});

describe("presets.set", () => {
  test("stores the document as JSON the stored schema accepts", async () => {
    const { store, api } = presets();
    const view = await api.set({ default: "heavy" });
    expect(view.source).toBe("stored");
    expect(view.default).toBe("heavy");
    const raw = JSON.parse((await store.read()) ?? "null");
    expect(StoredCreatePresets.safeParse(raw).success).toBe(true);
    expect(raw).toMatchObject({ version: 1, default: "heavy" });
  });

  test("custom presets and the loadout in one write", async () => {
    const { api } = presets();
    const view = await api.set({
      custom: [RESEARCH],
      loadout: ["research", "standard", null, "gpu"],
      default: "research",
    });
    expect(view.presets.at(-1)).toMatchObject({ id: "research", builtin: false, usable: true });
    expect(view.loadout).toEqual(["research", "standard", null, "gpu"]);
  });

  test("deleting a custom preset empties its slot, and the default moves", async () => {
    const { api } = presets();
    await api.set({
      custom: [RESEARCH],
      loadout: ["research", "standard", null, null],
      default: "research",
    });
    const view = await api.set({ custom: [] });
    expect(view.loadout).toEqual([null, "standard", null, null]);
    expect(view.default).toBe("standard");
  });

  test("reset forgets the row", async () => {
    const { store, api } = presets();
    await api.set({ default: "gpu" });
    const view = await api.set({ reset: true });
    expect(view.source).toBe("builtin");
    expect(await store.read()).toBeNull();
  });

  test("refuses a loadout naming a preset that does not exist, or one twice", async () => {
    const { api } = presets();
    expect((await refusal(api.set({ loadout: ["nope", null, null, null] }))).code).toBe("VALIDATION");
    expect((await refusal(api.set({ loadout: ["gpu", "gpu", null, null] }))).message).toContain(
      "twice",
    );
  });

  test("refuses a default outside the loadout, and no default on a filled one", async () => {
    const { api } = presets();
    expect((await refusal(api.set({ default: "micro" }))).message).toContain("not in the loadout");
    expect((await refusal(api.set({ default: null }))).message).toContain("needs a default");
    // …but an empty loadout has none.
    const empty = await api.set({ loadout: [null, null, null, null], default: null });
    expect(empty.default).toBeNull();
  });

  test("never mints an unknown size, but re-sends one it already holds", async () => {
    const store = new MemoryPresetStore();
    const odd = { ...RESEARCH, id: "odd", size: "quantum-9" };
    await store.write(
      JSON.stringify({ version: 1, loadout: [null, null, null, null], default: null, custom: [odd] }),
    );
    const api = createPresets({ store });
    await api.set({ custom: [odd], loadout: ["odd", null, null, null], default: "odd" });
    const err = await refusal(api.set({ custom: [odd, { ...RESEARCH, id: "new", size: "warp" }] }));
    expect(err.message).toContain("unknown size warp");
  });

  test("the request schema refuses a built-in id, a duplicate, and reset mixed with a patch", () => {
    expect(PresetsSetInput.safeParse({ custom: [{ ...RESEARCH, id: "heavy" }] }).success).toBe(false);
    expect(PresetsSetInput.safeParse({ custom: [RESEARCH, RESEARCH] }).success).toBe(false);
    expect(PresetsSetInput.safeParse({ reset: true, default: "gpu" }).success).toBe(false);
    expect(PresetsSetInput.safeParse({}).success).toBe(false);
    expect(PresetsSetInput.safeParse({ loadout: ["gpu"] }).success).toBe(false);
  });
});

describe("storage", () => {
  test("one prefs row, under create.presets", async () => {
    const local = openMemoryDb();
    const api = createPresets({ store: new SqlitePresetStore(local.db) });
    await api.set({ default: "light" });
    const row = local.db.query("SELECT value FROM prefs WHERE key = ?").get(CREATE_PRESETS_PREF) as {
      value: string;
    } | null;
    expect(JSON.parse(row?.value ?? "null")).toMatchObject({ default: "light" });
    expect((await api.get({})).default).toBe("light");
    await api.set({ reset: true });
    expect(local.db.query("SELECT value FROM prefs WHERE key = ?").get(CREATE_PRESETS_PREF)).toBeNull();
  });

  test("fixture mode keeps them in its own database and they survive a reopen", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-presets-"));
    const first = await openHermetic({ fixture: true, home });
    await first.presets.set({ default: "heavy" });
    const again = await openHermetic({ fixture: true, home });
    expect((await again.presets.get({})).default).toBe("heavy");
  });
});

describe("resolveCreatePreset", () => {
  const view = presetsView(null);

  test("no flags: the laptop's default preset fills all three", () => {
    expect(resolveCreatePreset(view, {})).toMatchObject({
      preset: { id: "standard" },
      machine: { size: "medium", volume_gib: 100, root_gib: 40 },
    });
  });

  test("any machine flag without --preset means no preset", () => {
    for (const flags of [
      { size: "large" },
      { instance_type: "m7g.large" },
      { volume_gib: 10 },
      { root_gib: 30 },
    ]) {
      expect(resolveCreatePreset(view, flags)).toMatchObject({ preset: null, machine: {} });
    }
  });

  test("--preset plus a flag: the flag's field is left to the flag", () => {
    expect(resolveCreatePreset(view, { preset: "heavy", root_gib: 80 }).machine).toEqual({
      size: "large",
      volume_gib: 200,
    });
    expect(resolveCreatePreset(view, { preset: "heavy", instance_type: "m7g.large" }).machine).toEqual({
      volume_gib: 200,
      root_gib: 40,
    });
  });

  test("--volume: the preset never sets the data volume", () => {
    expect(resolveCreatePreset(view, { volume_id: "vol-1" }).machine).toEqual({
      size: "medium",
      root_gib: 40,
    });
  });

  test("an unknown preset is NOT_FOUND; an unusable one is VALIDATION", () => {
    expect(() => resolveCreatePreset(view, { preset: "nope" })).toThrow(HermeticError);
    const odd = presetsView({
      loadout: ["odd", null, null, null],
      default: "odd",
      custom: [{ ...RESEARCH, id: "odd", size: "quantum-9" }],
    });
    expect(() => resolveCreatePreset(odd, { preset: "odd" })).toThrow(/does not know/);
    // As the default, it is skipped — and said so — rather than failing the create.
    expect(resolveCreatePreset(odd, {})).toMatchObject({
      preset: null,
      skipped_default: { id: "odd" },
    });
  });

  test("an empty loadout applies nothing", () => {
    const empty = presetsView({ loadout: [null, null, null, null], default: null, custom: [] });
    expect(resolveCreatePreset(empty, {})).toMatchObject({ preset: null, machine: {} });
  });
});
