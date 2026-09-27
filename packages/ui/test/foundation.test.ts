/**
 * §6.6's two pure pieces of UI logic: the phase list the update drawer seeds
 * its rail with, and which pill (if any) the env strip owes the operator.
 */
import { describe, expect, test } from "bun:test";
import { foundationPhases, phaseLabel } from "../src/lib/useOp.ts";
import {
  bedrockGrantLine,
  closeBlocked,
  continueGate,
  grantNeedsUpdate,
  hermesLine,
  hermeticdLine,
  reattach,
} from "../src/logic/foundation-logic.ts";
import type { FoundationGateStatus, HermesAdvisory } from "../src/logic/foundation-logic.ts";
import { foundationPill } from "../src/components/EnvStrip.tsx";
import type { FoundationStatus, Meta } from "../src/api/index.ts";

/**
 * The UI cannot import core (§3.1), so this list is spelled twice: here and in
 * `packages/core/src/schema/foundation.ts`'s `foundationPhases()`, which is the
 * source of truth. If core reorders or renames a phase, this fails — and the
 * drawer's rail would otherwise have shown steps the op never emits.
 */
const CORE_PHASES = ["preflight", "archive", "stack", "artifacts", "migrate", "rollout", "done"];

function status(over: Partial<FoundationStatus> = {}): FoundationStatus {
  return {
    fleet: {
      foundation_version: 1,
      template_sha256: "a".repeat(64),
      hermeticd_version: "0.4.1",
      ubuntu_release: "noble",
      ami_id: "ami-0123456789abcdef0",
    },
    available: {
      foundation_version: 1,
      template_sha256: "a".repeat(64),
      hermeticd_version: "0.4.1",
    },
    update_available: false,
    tool_outdated: false,
    in_progress: null,
    agents: [],
    ...over,
  } as FoundationStatus;
}

function meta(foundation: FoundationStatus | null): Meta {
  return {
    header: "▸ fixture",
    config: null,
    fixture: true,
    hermes_version: null,
    hermeticd_version: null,
    tailnet: null,
    last_teardown: null,
    foundation,
  };
}

describe("foundationPhases", () => {
  test("is core's list, in core's order", () => {
    expect(foundationPhases()).toEqual(CORE_PHASES);
  });

  test("every phase has a label, so no rail row falls back to its raw name", () => {
    for (const phase of foundationPhases()) {
      expect(phaseLabel(phase)).not.toBe(phase);
    }
  });

  test("a fresh array each call — the rail must not share a mutable seed", () => {
    const first = foundationPhases();
    first.push("mutated");
    expect(foundationPhases()).toEqual(CORE_PHASES);
  });
});

describe("foundationPill", () => {
  test("an up-to-date fleet gets no pill", () => {
    expect(foundationPill(meta(status()))).toBeNull();
  });

  test("no meta, and a server that reported no foundation, are both silent", () => {
    expect(foundationPill(null)).toBeNull();
    expect(foundationPill(meta(null))).toBeNull();
  });

  test("an available update names the versions in its tooltip", () => {
    const pill = foundationPill(
      meta(
        status({
          update_available: true,
          fleet: {
            foundation_version: 0,
            template_sha256: null,
            hermeticd_version: "0.4.0",
            ubuntu_release: "noble",
            ami_id: "ami-0123456789abcdef0",
          },
          available: {
            foundation_version: 1,
            template_sha256: "b".repeat(64),
            hermeticd_version: "0.4.1",
          },
        }),
      ),
    );
    expect(pill?.label).toBe("foundation update available");
    expect(pill?.title).toContain("v0 → v1");
    expect(pill?.title).toContain("0.4.0 → 0.4.1");
  });

  test("a tool behind its own fleet says so instead — that is the actionable one", () => {
    const pill = foundationPill(
      meta(
        status({
          tool_outdated: true,
          fleet: {
            foundation_version: 2,
            template_sha256: null,
            hermeticd_version: "0.5.0",
            ubuntu_release: "noble",
            ami_id: "ami-0123456789abcdef0",
          },
        }),
      ),
    );
    expect(pill?.label).toBe("hermetic build outdated");
    expect(pill?.title).toContain("upgrade hermetic");
  });
});

/**
 * §6.6's advisory Hermes line, as the Settings card renders it. The states that
 * matter are the two that look alike and are not: "checked, and up to date",
 * and "could not check". The second must never read as the first.
 */
describe("hermesLine", () => {
  const base: HermesAdvisory = {
    pinned: "0.21.0",
    pinned_ref: "v2026.8.31",
    latest: "2026.8.31",
    update_available: false,
    checked_at: "2026-09-06T10:00:00.000Z",
    error: null,
  };
  const line = (over: Partial<HermesAdvisory> = {}) => hermesLine({ ...base, ...over });

  test("up to date: both numbers, no badge", () => {
    const l = line();
    expect(l.pinned).toBe("0.21.0 (v2026.8.31)");
    expect(l.detail).toContain("up to date");
    expect(l.alert).toBe(false);
    expect(l.hint).toBeNull();
  });

  test("an update raises the badge and names both halves of the bump", () => {
    const l = line({ latest: "2026.9.4", update_available: true });
    expect(l.alert).toBe(true);
    expect(l.detail).toContain("2026.9.4");
    // No button in the card runs it, so the card has to say what does — and
    // `--hermes` alone would not, since the ref it checks out is not a flag.
    expect(l.hint).toContain("BUILD_VERSIONS.hermes/hermes_ref");
    expect(l.hint).toContain("hermetic upgrade <name> --hermes <version>");
  });

  test("a failed check says it failed, and raises no badge", () => {
    const l = line({ latest: null, error: "timeout" });
    expect(l.detail).toContain("could not check");
    expect(l.detail).toContain("timeout");
    expect(l.alert).toBe(false);
  });

  test("a tag that could not be ordered is shown but not acted on", () => {
    const l = line({ latest: "nightly", error: "unrecognised tag" });
    expect(l.detail).toContain("nightly");
    expect(l.detail).toContain("unrecognised tag");
    expect(l.alert).toBe(false);
  });

  test("a server that reported no check at all is not rendered as clean", () => {
    for (const absent of [null, undefined]) {
      const l = hermesLine(absent);
      expect(l.detail).toContain("not checked");
      expect(l.alert).toBe(false);
    }
  });
});

/**
 * `FoundationUpdateDrawer`'s three decisions, pinned without mounting it: what a
 * stored op id means, when the drawer refuses to close, and when stage 1 may
 * advance. The drawer itself is then only wiring.
 */
describe("reattach", () => {
  test("no stored op id: start at stage 1 and fetch a plan", () => {
    expect(reattach(null)).toEqual({ stage: 1, opId: null, loadPlan: true });
  });

  test("a stored op id: jump to the progress stage and fetch no plan", () => {
    // Fetching one would ask CloudFormation for a change set against a stack
    // that is mid-update — which the server now answers 409 to anyway.
    expect(reattach("op-7")).toEqual({ stage: 3, opId: "op-7", loadPlan: false });
  });

  test("an empty string is not an op id", () => {
    expect(reattach("")).toEqual({ stage: 1, opId: null, loadPlan: true });
  });
});

describe("closeBlocked", () => {
  test("only stage 3, and only while the op runs", () => {
    expect(closeBlocked({ stage: 3, running: true })).toBe(true);
    expect(closeBlocked({ stage: 3, running: false })).toBe(false);
    expect(closeBlocked({ stage: 1, running: true })).toBe(false);
    expect(closeBlocked({ stage: 2, running: true })).toBe(false);
  });
});

describe("continueGate", () => {
  const gate = (
    over: Partial<Parameters<typeof continueGate>[0]> = {},
    foundation: FoundationGateStatus | null = {
      update_available: true,
      tool_outdated: false,
      in_progress: null,
      stale_bedrock_grants: [],
    },
  ) => continueGate({ planLoading: false, planError: null, hasPlan: true, foundation, ...over });

  test("a read plan against an out-of-date fleet may continue", () => {
    expect(gate()).toEqual({ allowed: true, reason: null });
  });

  test("no plan yet, or a plan that failed to read, may not", () => {
    expect(gate({ planLoading: true }).allowed).toBe(false);
    expect(gate({ planError: "boom" }).allowed).toBe(false);
    expect(gate({ hasPlan: false }).allowed).toBe(false);
  });

  test("an update already running is refused, and says who holds it", () => {
    const g = gate(
      {},
      {
        update_available: true,
        tool_outdated: false,
        in_progress: { owner: "evan", expires: "2026-09-04T17:00:00.000Z" },
      },
    );
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain("evan");
  });

  test("an up-to-date fleet is refused — this is the gate the pill bypasses", () => {
    // The EnvStrip pill opens this drawer directly, so the Settings button's
    // own `disabled` is not the only thing standing between a stale snapshot
    // and a pointless update.
    const g = gate(
      {},
      {
        update_available: false,
        tool_outdated: false,
        in_progress: null,
        // Compared, nothing stale: the *other* reason to update is absent too.
        stale_bedrock_grants: [],
      },
    );
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain("up to date");
  });

  test("a current foundation with a stale Bedrock grant may continue", () => {
    // §8.3: the grant is a second, independent reason to run an update, and
    // this gate has to agree with the button that opened the drawer — a
    // Settings page that says "stale" over an action this refuses is worse
    // than either half on its own.
    const g = gate(
      {},
      {
        update_available: false,
        tool_outdated: false,
        in_progress: null,
        stale_bedrock_grants: ["zai.glm-4.7-flash"],
      },
    );
    expect(g).toEqual({ allowed: true, reason: null });
  });

  test("a grant nothing recorded may continue too — the update is what records it", () => {
    const g = gate({}, { update_available: false, tool_outdated: false, in_progress: null });
    expect(g).toEqual({ allowed: true, reason: null });
  });

  test("a stale grant does not override the two refusals that are about the tool", () => {
    const stale = ["zai.glm-4.7-flash"];
    expect(
      gate(
        {},
        {
          update_available: false,
          tool_outdated: true,
          in_progress: null,
          stale_bedrock_grants: stale,
        },
      ).allowed,
    ).toBe(false);
    expect(
      gate(
        {},
        {
          update_available: false,
          tool_outdated: false,
          in_progress: { owner: "evan", expires: "2026-09-04T17:00:00.000Z" },
          stale_bedrock_grants: stale,
        },
      ).allowed,
    ).toBe(false);
  });

  test("a tool behind its own fleet is refused: the update would throw FOUNDATION_NEWER", () => {
    const g = gate({}, { update_available: false, tool_outdated: true, in_progress: null });
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain("upgrade hermetic");
  });

  test("a status the server could not read does not block a plan that succeeded", () => {
    // Core's own preflight is the real gate; a broken courtesy read must not
    // become a broken update.
    expect(gate({}, null)).toEqual({ allowed: true, reason: null });
  });
});

/**
 * §8.3's three states, worded the way `hermetic foundation status` words them
 * (`bedrockGrantLine` in `packages/cli/src/commands/foundation.ts`). The UI may
 * not import the CLI, so this is the test that keeps the copy honest: an absent
 * field is a grant nothing recorded, and rendering it as `current` would report
 * an unchecked policy as a checked one.
 */
describe("bedrockGrantLine", () => {
  test("an empty list is the comparison having been made and found clean", () => {
    expect(bedrockGrantLine([])).toEqual({ text: "current", warn: false });
    expect(grantNeedsUpdate([])).toBe(false);
  });

  test("a non-empty list names every model the role may not invoke", () => {
    const line = bedrockGrantLine(["zai.glm-4.7-flash", "anthropic.claude-sonnet-5"]);
    expect(line.warn).toBe(true);
    expect(line.text).toBe(
      "stale: zai.glm-4.7-flash, anthropic.claude-sonnet-5 — run a foundation update",
    );
    expect(grantNeedsUpdate(["zai.glm-4.7-flash"])).toBe(true);
  });

  test('an absent field is "not recorded", never "current"', () => {
    expect(bedrockGrantLine(undefined)).toEqual({
      text: "not recorded — run a foundation update",
      warn: true,
    });
    expect(grantNeedsUpdate(undefined)).toBe(true);
  });
});

describe("hermeticdLine", () => {
  const base = {
    published_version: "0.5.0",
    published_build: "a".repeat(64),
    local_version: "0.5.0",
    local_build: "a".repeat(64),
    drift: null as string | null,
  };

  /**
   * The bug this whole line was rewritten for. An operator changed the hermeticd
   * binary, opened the drawer, and read `hermeticd 0.5.0 → 0.5.0`. The push was
   * fine; the line simply could not say so, because both sides of it are
   * `BUILD_VERSIONS.hermeticd` — a constant that only moves when someone edits
   * it by hand.
   */
  test("a changed build at the same version is finally visible", () => {
    const line = hermeticdLine(
      { ...base, local_build: "b".repeat(64), drift: "…" },
      {
        from: null,
        to: null,
      },
    );
    // The versions are the same hand-maintained constant on both sides, read
    // from the two places an operator expects: the S3 manifest, and what this
    // build would push. What differs — and what the line now shows — is the
    // build fingerprint beside each.
    expect(line.from).toBe("0.5.0");
    expect(line.to).toBe("0.5.0");
    expect(line.fromBuild).toBe("a".repeat(8));
    expect(line.toBuild).toBe("b".repeat(8));
    expect(line.fromBuild).not.toBe(line.toBuild);
    expect(line.warn).toBe(true);
    expect(line.note).toContain("binary changed");
  });

  /**
   * Two builds that agree render two identical fingerprints and no note. The
   * operator can see the comparison was made, rather than inferring it from
   * silence.
   */
  test("a match shows the same fingerprint on both sides", () => {
    const line = hermeticdLine(base, { from: null, to: null });
    expect(line.fromBuild).toBe("a".repeat(8));
    expect(line.toBuild).toBe("a".repeat(8));
    expect(line.note).toBeNull();
  });

  /**
   * A side that stamped no build shows no fingerprint — never a placeholder
   * that could be mistaken for one.
   */
  test("an unstamped side shows no fingerprint at all", () => {
    const line = hermeticdLine({ ...base, local_build: null }, { from: null, to: null });
    expect(line.fromBuild).toBe("a".repeat(8));
    expect(line.toBuild).toBeNull();
  });

  test("a genuine match says nothing", () => {
    const line = hermeticdLine(base, { from: null, to: null });
    expect(line.note).toBeNull();
    expect(line.warn).toBe(false);
  });

  /**
   * "Cannot tell" is said out loud rather than rendered as agreement — which is
   * exactly the mistake the bare version pair was making.
   */
  test("an unstamped build admits it cannot tell", () => {
    const line = hermeticdLine({ ...base, local_build: null }, { from: null, to: null });
    expect(line.warn).toBe(false);
    expect(line.note).toContain("cannot tell");
  });

  test("a fleet with no published release says so", () => {
    const line = hermeticdLine(
      { ...base, published_version: null, published_build: null },
      { from: null, to: null },
    );
    expect(line.note).toContain("no published release");
  });

  /**
   * A plan served by an older hermetic carries no `release` block. The line
   * falls back to the two versions and says it cannot tell — it does not go
   * quiet, because quiet is what a match looks like.
   */
  test("without a release block it says the server cannot tell", () => {
    const line = hermeticdLine(null, { from: "0.4.0", to: "0.5.0" });
    expect(line.from).toBe("0.4.0");
    expect(line.to).toBe("0.5.0");
    expect(line.note).toContain("cannot tell");
    expect(line.warn).toBe(false);
  });

  /**
   * The window that made this a parameter: the summary line renders the instant
   * the drawer opens, while the plan is still being fetched. `release` is null
   * then for a reason that has nothing to do with the fleet — and a bare line in
   * that window is indistinguishable from the old, uninformative one.
   */
  test("while the plan is still loading it says so rather than going quiet", () => {
    const line = hermeticdLine(null, { from: "0.5.0", to: "0.5.0" }, "loading");
    expect(line.note).toBe("· checking…");
    expect(line.warn).toBe(false);
  });

  test("a plan that failed to load says the check did not happen", () => {
    const line = hermeticdLine(null, { from: "0.5.0", to: "0.5.0" }, "error");
    expect(line.note).toContain("could not check");
    expect(line.warn).toBe(false);
  });

  /**
   * Only a real, completed comparison is silent. This is the one case where the
   * absence of a note is itself the answer.
   */
  test("silence is reserved for a confirmed match", () => {
    const line = hermeticdLine(
      {
        published_version: "0.5.0",
        published_build: "a".repeat(64),
        local_version: "0.5.0",
        local_build: "a".repeat(64),
        drift: null,
      },
      { from: null, to: null },
      "ready",
    );
    expect(line.note).toBeNull();
  });
});

describe("hermeticdLine with build numbers", () => {
  const r = (over: Record<string, unknown> = {}) => ({
    published_version: "0.5.0",
    published_build: "a".repeat(64),
    local_version: "0.5.0",
    local_build: "b".repeat(64),
    published_build_number: 35,
    local_build_number: 36,
    published_commit: "aaa1111",
    local_commit: "bbb2222",
    drift: "…" as string | null,
    ...over,
  });

  /**
   * What the whole numbering exists for. `a1b2c3d4 → e5f6a7b8` can only say the
   * two differ; `build 35 → build 36` says which is newer, and therefore
   * whether the operator is about to publish their work or overwrite somebody
   * else's with something older.
   */
  test("the number is preferred over the digest, because it orders", () => {
    const line = hermeticdLine(r(), { from: null, to: null });
    expect(line.fromBuild).toBe("build 35");
    expect(line.toBuild).toBe("build 36");
    expect(line.note).toContain("binary changed");
    expect(line.warn).toBe(true);
  });

  /**
   * The case a digest comparison cannot reach at all, and the reason this is a
   * warning: pushing would move the fleet *backwards* onto older code, with an
   * identical version string on both sides of the arrow saying nothing.
   */
  test("a checkout behind the fleet is warned about, not just noted", () => {
    const line = hermeticdLine(r({ published_build_number: 36, local_build_number: 35 }), {
      from: null,
      to: null,
    });
    expect(line.warn).toBe(true);
    expect(line.note).toContain("behind the fleet");
    expect(line.note).toContain("pull");
  });

  /**
   * Commits that touch nothing hermeticd ships move the number and not the
   * binary. Said out loud, or a moving number reads as pending work.
   */
  test("newer commits that change no binary say exactly that", () => {
    const line = hermeticdLine(r({ local_build: "a".repeat(64), drift: null }), {
      from: null,
      to: null,
    });
    expect(line.warn).toBe(false);
    expect(line.note).toBe("· newer commit, same binary");
  });

  test("the same commit and the same binary is silent", () => {
    const line = hermeticdLine(
      r({ local_build_number: 35, local_build: "a".repeat(64), drift: null }),
      { from: null, to: null },
    );
    expect(line.fromBuild).toBe("build 35");
    expect(line.toBuild).toBe("build 35");
    expect(line.note).toBeNull();
  });

  /**
   * Only reachable through `HERMETIC_ALLOW_DIRTY`, and worth naming precisely
   * because it is the state that flag warns it creates: a release nobody can
   * rebuild from the commit it claims.
   */
  test("the same commit with different bytes names the dirty push", () => {
    const line = hermeticdLine(r({ local_build_number: 35, local_commit: "aaa1111" }), {
      from: null,
      to: null,
    });
    expect(line.warn).toBe(true);
    expect(line.note).toContain("dirty tree");
  });

  /**
   * `rev-list --count` is equal for two *sibling* branches one commit off the
   * same base, so an equal number is not the same commit. Blaming a colleague
   * for a dirty push because their branch happens to be the same depth as yours
   * is a false accusation, and the commit sha is what rules it out.
   */
  test("equal depth on different commits is not a dirty push", () => {
    const line = hermeticdLine(r({ local_build_number: 35 }), { from: null, to: null });
    expect(line.note).not.toContain("dirty tree");
    expect(line.note).toContain("same depth");
  });

  /**
   * The case that would have fired on the very next merge: the manifest names
   * `0.5.0` and this checkout ships `0.5.1`, so `releaseDrift` returns null —
   * *because the versions differ*, not because the builds agree — and the line
   * used to print "same binary" about a binary the version is compiled into.
   */
  test("a version bump is not evidence the binary is unchanged", () => {
    const line = hermeticdLine(r({ published_version: "0.5.0", local_version: "0.5.1", drift: null }), {
      from: null,
      to: null,
    });
    expect(line.note).not.toContain("same binary");
    expect(line.note).toContain("cannot tell");
  });

  /** Nor is an unstamped side. Same rule, different way of not knowing. */
  test("an unstamped build is not evidence either", () => {
    const line = hermeticdLine(r({ local_build: null, drift: null }), { from: null, to: null });
    expect(line.note).not.toContain("same binary");
    expect(line.note).toContain("cannot tell");
  });

  /**
   * A release with no number — pushed from a built binary, a tarball, a shallow
   * clone — still gets the digest it always had. The number is an improvement,
   * not a precondition.
   */
  test("without numbers it falls back to the fingerprints", () => {
    const line = hermeticdLine(r({ published_build_number: null, local_build_number: null }), {
      from: null,
      to: null,
    });
    expect(line.fromBuild).toBe("a".repeat(8));
    expect(line.toBuild).toBe("b".repeat(8));
  });
});
