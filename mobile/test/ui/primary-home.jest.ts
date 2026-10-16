/**
 * `primaryHomeRows`: home's layout built around the primary instance, against
 * `homeRows`' own answer for the cases it leaves alone.
 */
import { homeRows } from "../../src/client/home-rows.ts";
import { primaryHomeRows } from "../../src/bots/primary-home.ts";
import { bot, swarm } from "../helpers/fixtures.ts";

const SWARMS = [
  swarm("atlas", [bot({ name: "ops", is_default: true })]),
  swarm("corvid", [
    bot({ name: "pilot", is_default: true }),
    bot({ name: "wren", last_message_at: "2026-10-13T09:00:00.000Z" }),
    bot({ name: "finch" }),
  ]),
  swarm("heron", [bot({ name: "egret", is_default: true })], { reachable: false }),
];
const input = (over: Partial<Parameters<typeof homeRows>[0]> = {}) => ({
  swarms: SWARMS,
  listening: ["atlas", "corvid", "heron"],
  pinned: [],
  ...over,
});
const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key);

test("no primary, or one not listened to: homeRows unchanged", () => {
  expect(primaryHomeRows(input(), null)).toEqual(homeRows(input()));
  const unlistened = input({ listening: ["atlas", "heron"] });
  expect(primaryHomeRows(unlistened, "corvid")).toEqual(homeRows(unlistened));
});

test("the hero is every bot of the primary, its default first", () => {
  const layout = primaryHomeRows(input(), "corvid");
  expect(layout.heroPinned).toBe(false);
  expect(keys(layout.hero)).toEqual(["corvid/pilot", "corvid/wren", "corvid/finch"]);
  // atlas's only bot was its default: it gets a section back.
  const atlas = layout.sections.find((s) => s.instance === "atlas");
  expect(keys(atlas?.rows ?? [])).toEqual(["atlas/ops"]);
  expect(layout.sections.some((s) => s.instance === "corvid")).toBe(false);
  // A down box keeps its header section.
  expect(layout.sections.find((s) => s.instance === "heron")?.reachable).toBe(false);
});

test("a down primary leaves the hero to the defaults, its section first", () => {
  const layout = primaryHomeRows(input(), "heron");
  expect(keys(layout.hero)).toEqual(keys(homeRows(input()).hero));
  expect(layout.sections[0]?.instance).toBe("heron");
});

test("pins win the hero; the primary's section still sorts first", () => {
  const layout = primaryHomeRows(input({ pinned: ["atlas/ops"] }), "corvid");
  expect(layout.heroPinned).toBe(true);
  expect(keys(layout.hero)).toEqual(["atlas/ops"]);
  expect(layout.sections[0]?.instance).toBe("corvid");
});
