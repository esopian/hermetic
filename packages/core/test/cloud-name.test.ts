/**
 * `cloudName` (§5): the one place the `<fleet id>-<agent>` spelling is decided,
 * and `legacyCloudNames` beside it, which is how a node built under an older
 * spelling is recognised rather than accused.
 *
 * What is worth pinning about `cloudName` is not the concatenation — it is the
 * *bound*. The result is a DNS label: it becomes the OS hostname, the name the
 * node asks the tailnet for, and therefore a MagicDNS label, which DNS caps at
 * 63 characters. Nothing in `cloudName` truncates, because nothing can
 * overflow: a fleet id is 8 characters, `validateName` caps an agent at 31, and
 * 8 + 1 + 31 = 40. That arithmetic is load-bearing and invisible, so it is
 * asserted — including the headroom the fleet-name spelling did not have.
 */
import { describe, expect, test } from "bun:test";
import { cloudName, legacyCloudNames } from "../src/schema/fleet.ts";
import { FleetIdSchema } from "../src/schema/common.ts";
import { isValidName } from "../src/shared/naming.ts";
import { FLEET_NAME_RE } from "../src/schema/directory.ts";

/** The DNS label limit MagicDNS enforces on a node's name. */
const DNS_LABEL_MAX = 63;

/** A well-formed fleet id — 8 lowercase Crockford base32 characters. */
const FLEET_ID = "k7m2x9qa";

describe("cloudName", () => {
  test("prefixes the agent name with the fleet's id", () => {
    expect(cloudName(FLEET_ID, "atlas")).toBe("k7m2x9qa-atlas");
    expect(cloudName("b4n8t1zc", "atlas")).toBe("b4n8t1zc-atlas");
  });

  /**
   * The id, never the alias. This is the whole point of v4: a fleet's display
   * alias can be changed (`hermetic fleet alias <fleet-id> …`) and its id
   * cannot, so stamping the label into a hostname that is fixed at boot left
   * every relabelled fleet looking like it was full of stale devices.
   */
  test("two fleets with the same agent do not collide", () => {
    expect(cloudName("k7m2x9qa", "atlas")).not.toBe(cloudName("b4n8t1zc", "atlas"));
  });

  /**
   * A caller that has not read `_fleet` yet has no id, and the boxes of a fleet
   * created before v3 really are called `atlas` — so "no fleet id" must be the
   * bare agent name rather than a leading hyphen or the string "undefined".
   */
  test("a fleet with no id leaves the agent name alone", () => {
    expect(cloudName(undefined, "atlas")).toBe("atlas");
    expect(cloudName(null, "atlas")).toBe("atlas");
    expect(cloudName("", "atlas")).toBe("atlas");
  });

  test("the longest name either side can spell fits well inside one DNS label", () => {
    const agent = "a".repeat(31);
    // The agent name is as long as its validator allows, and nothing longer is
    // admitted anywhere in hermetic.
    expect(isValidName(agent)).toBe(true);
    expect(isValidName("a".repeat(32))).toBe(false);
    // A fleet id has one length, pinned by its own schema.
    expect(FleetIdSchema.safeParse(FLEET_ID).success).toBe(true);
    expect(FLEET_ID).toHaveLength(8);

    expect(cloudName(FLEET_ID, agent)).toHaveLength(8 + 1 + 31);
    expect(cloudName(FLEET_ID, agent).length).toBeLessThanOrEqual(DNS_LABEL_MAX);
  });

  /**
   * The headroom v4 bought. A fleet *name* — now the optional display alias —
   * may be 31 characters, so the v3 spelling could reach exactly 63: legal, and
   * with nothing to spare for any suffix Tailscale might add. The id spelling
   * leaves 23 characters unused.
   */
  test("the id spelling leaves room the fleet-name spelling did not", () => {
    const longestFleetName = "f".repeat(31);
    expect(FLEET_NAME_RE.test(longestFleetName)).toBe(true);
    expect(`${longestFleetName}-${"a".repeat(31)}`).toHaveLength(DNS_LABEL_MAX);
    expect(DNS_LABEL_MAX - cloudName(FLEET_ID, "a".repeat(31)).length).toBe(23);
  });

  /** The result must itself be a legal DNS label, not merely a short one. */
  test("the result is a legal label: lowercase alphanumerics and hyphens", () => {
    expect(cloudName(FLEET_ID, "atlas-two")).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(cloudName(FLEET_ID, "a".repeat(31))).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

/**
 * Every spelling hermetic has ever handed a node, so a box that predates the
 * current rule is recognised as its own rather than reported as a device
 * squatting on a name.
 */
describe("legacyCloudNames", () => {
  test("names the v3 spelling and the pre-v3 one, newest first", () => {
    expect(legacyCloudNames("main", "atlas")).toEqual(["main-atlas", "atlas"]);
  });

  /**
   * A pre-v3 fleet has no name, so `<fleet name>-<agent>` is not a shape any of
   * its nodes could be wearing. Returning `["atlas", "atlas"]` would be
   * harmless but says something untrue about what this fleet has been called.
   */
  test("a fleet that never had a name has only the bare spelling", () => {
    expect(legacyCloudNames(undefined, "atlas")).toEqual(["atlas"]);
    expect(legacyCloudNames(null, "atlas")).toEqual(["atlas"]);
    expect(legacyCloudNames("", "atlas")).toEqual(["atlas"]);
  });

  /** The v4 name is deliberately absent: it is the canonical one, not a legacy one. */
  test("the current spelling is not in the list", () => {
    expect(legacyCloudNames("main", "atlas")).not.toContain(cloudName(FLEET_ID, "atlas"));
  });
});
