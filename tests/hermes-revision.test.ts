/**
 * `HERMES_REVISION`: the one fact about the checkout that travels the other way
 * along the usual seam — the *box* writes it and a unit *core* rendered reads it.
 *
 * Every other seam in `seams.test.ts` runs laptop → box. This one runs box →
 * unit, and it is a seam for the same reason those are: the two halves are in
 * packages that may not import each other, both keep working when they
 * disagree, and the symptom of disagreement is not a crash. `render.ts` emits
 * an `EnvironmentFile=-` line; `apply.ts` writes a file at that path with one
 * assignment in it. If the prefix were dropped, a box that had not written the
 * file yet would fail to *start* Hermes at all. If the variable name drifted,
 * everything would still boot and upstream's update check would go on
 * interrogating the checkout — which is the state this whole mechanism exists
 * to end, and which reports itself to an operator as *"Couldn't reach the
 * update source"*: a network diagnosis for a local fault, and the reason this
 * is worth a test at the join rather than two tests at the ends.
 *
 * Why the value must be upstream's commit and not the checkout's: on the mirror
 * path the tree arrives as a bundle holding a synthesized root commit
 * (`hermes-mirror.ts`), so `git rev-parse HEAD` on the box names a commit
 * github.com has never heard of. Handing *that* to upstream is worse than
 * handing it nothing.
 *
 * This file is at the root, so it may import core and agentd together — which
 * no package may do, and which is why this test could not live in either.
 */
import { describe, expect, test } from "bun:test";

import { renderAgentConfig } from "../packages/core/src/render/render.ts";
import type { RenderInput } from "../packages/core/src/render/render.ts";
import {
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_DROPIN,
  HERMES_REVISION_ENV,
} from "../packages/core/src/schema/hermes.ts";
import type { FleetManifest } from "../packages/core/src/schema/fleet.ts";
import { hermesBundleKey } from "../packages/core/src/schema/fleet.ts";
import { apply } from "../packages/agentd/src/apply/index.ts";
import { FLEET_CACHE_PATH } from "../packages/agentd/src/fleet.ts";
import { BoxHost as FakeHost, fakeCommitSha } from "../packages/agentd/test/fake-box.ts";
import { makeFleetManifest, makeManifest, sha256Of } from "../packages/agentd/test/fixtures.ts";

const REF = "v2026.8.31";
/** A real-looking upstream commit: 40 hex, and not derivable from the ref. */
const UPSTREAM_SHA = "29112bef099274229cadff79cdff7bf7b99c4b77";

/**
 * `EnvironmentFile=` as systemd reads it: the path, and whether the leading `-`
 * made it optional. Parsed rather than string-matched so a line that acquired a
 * second modifier, or lost the prefix, is a failure rather than a near-miss.
 */
function environmentFiles(unit: string): Array<{ path: string; optional: boolean }> {
  return unit
    .split("\n")
    .filter((line) => line.startsWith("EnvironmentFile="))
    .map((line) => line.slice("EnvironmentFile=".length))
    .map((value) => ({ path: value.replace(/^-/, ""), optional: value.startsWith("-") }));
}

/** The assignments in an `EnvironmentFile`, as systemd would hand them to the unit. */
function environment(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0 || line.startsWith("#")) continue;
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

const rendered = renderAgentConfig({
  name: "atlas",
  size: "small",
  provider: "anthropic",
  secrets_mode: "none",
  browser: false,
  hermes_version: "0.21.0",
  hermes_ref: REF,
  chrome_ref: "153.0.8010.12",
  region: "us-east-1",
  tailnet: "tail0.ts.net",
} as unknown as RenderInput);

function renderedFile(path: string): string {
  const file = rendered.manifest.files.find((f) => f.path === path);
  if (file === undefined) throw new Error(`nothing rendered at ${path}`);
  return file.content;
}

describe("the unit side: both Hermes processes read the revision file", () => {
  /**
   * Both, not one. The dashboard is the surface an operator clicks Update on,
   * but the gateway starts Hermes too and prints the same banner, and
   * `hermesRuntimeLines` exists precisely so the two cannot end up with
   * different environments.
   */
  const units: Array<[string, string]> = [
    ["dashboard", renderedFile(`/etc/systemd/system/${HERMES_DASHBOARD_UNIT}`)],
    ["gateway drop-in", renderedFile(HERMES_GATEWAY_DROPIN)],
  ];

  for (const [label, body] of units) {
    test(`${label} names the file hermeticd writes`, () => {
      const files = environmentFiles(body);
      expect(files.map((f) => f.path)).toContain(HERMES_REVISION_ENV);
    });

    /**
     * Optional, and this is the half with teeth. Core renders these units on a
     * box that has no Hermes checkout yet, so the file cannot exist at first
     * boot; a required `EnvironmentFile` that is missing is a unit systemd
     * refuses to start, which would turn a cosmetic update-check fix into a
     * fleet that does not come up.
     */
    test(`${label} tolerates the file not being there yet`, () => {
      const entry = environmentFiles(body).find((f) => f.path === HERMES_REVISION_ENV);
      expect(entry?.optional).toBe(true);
    });
  }
});

describe("the box side: hermeticd writes what the unit expects", () => {
  /** An apply against the fleet's mirror, which is the path that needs this most. */
  async function applyFromMirror(): Promise<FakeHost> {
    const host = new FakeHost();
    const bytes = FakeHost.bundleBytes(REF);
    host.s3Objects.set(hermesBundleKey(REF), bytes);
    const base = makeFleetManifest();
    const fleet: FleetManifest = {
      ...base,
      hermes: {
        ...base.hermes,
        [REF]: {
          key: hermesBundleKey(REF),
          sha256: sha256Of(bytes),
          size: bytes.length,
          upstream_sha: UPSTREAM_SHA,
        },
      },
    };
    host.seed(FLEET_CACHE_PATH, JSON.stringify(fleet));
    await apply(makeManifest({ hermes_ref: REF }), { host, getObject: host.getObject });
    return host;
  }

  test("the file parses as one assignment, under the name upstream reads", async () => {
    const host = await applyFromMirror();
    const body = host.files.get(HERMES_REVISION_ENV)?.content;
    expect(body).toBeDefined();
    // `HERMES_REVISION` is upstream's own spelling (`hermes_cli/banner.py`,
    // `check_for_updates`), and nothing else belongs in this file: it is
    // sourced into the environment of a process hermetic does not own.
    expect(environment(body ?? "")).toEqual({ HERMES_REVISION: UPSTREAM_SHA });
  });

  /**
   * The point of the whole exercise. A bundle checkout's `HEAD` is hermetic's
   * synthesized commit; upstream's compare API 404s on it and the check answers
   * "could not run" — the same nothing it answered before, reached by a longer
   * road. The manifest's `upstream_sha` is the only sha here that exists on
   * github.com.
   */
  test("the value is upstream's commit, not the bundle's synthesized one", async () => {
    const host = await applyFromMirror();
    const body = host.files.get(HERMES_REVISION_ENV)?.content ?? "";
    expect(environment(body)["HERMES_REVISION"]).toBe(UPSTREAM_SHA);
    expect(body).not.toContain(fakeCommitSha(REF));
  });

  /**
   * The fallback clone is `--depth 1` straight from github.com, so there the
   * checkout's own `HEAD` *is* upstream's commit and the manifest has nothing
   * to add. Both paths have to produce a usable answer or the mechanism is only
   * half a mechanism.
   */
  test("a box on the direct-clone fallback publishes its own HEAD", async () => {
    const host = new FakeHost();
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
    await apply(makeManifest({ hermes_ref: REF }), { host, getObject: host.getObject });

    const body = host.files.get(HERMES_REVISION_ENV)?.content ?? "";
    expect(environment(body)).toEqual({ HERMES_REVISION: fakeCommitSha(REF) });
  });

  /**
   * git refuses to look at a repository owned by someone else, and the units
   * run as `hermes` while the checkout stays root's (§7.1). Without the
   * exception every read upstream makes of its own checkout fails — which is
   * the *other* half of the same operator-facing symptom, and the half that
   * `HERMES_REVISION` does not cover because `hermes update --check` and the
   * CLI banner still go through the working tree.
   */
  test("the checkout is readable by the account the units run as", async () => {
    const host = await applyFromMirror();
    expect(host.gitSystemConfig.get("safe.directory")).toEqual(["/usr/local/lib/hermes-agent"]);
  });

  test("a second apply adds no second copy of the exception", async () => {
    const host = await applyFromMirror();
    await apply(makeManifest({ hermes_ref: REF }), { host, getObject: host.getObject });
    expect(host.gitSystemConfig.get("safe.directory")).toEqual(["/usr/local/lib/hermes-agent"]);
  });

  /**
   * A plan has to name every path the real run then changes — the rule
   * `apply.test.ts` states for apt keyrings, and the one place this file's
   * writer can quietly break it. A dry run happens *before* `ensureHermes` has
   * moved the ref marker, so the revision it can read is the outgoing one; a
   * planner that compared only what it could see would report "unchanged" for a
   * file the real run is about to rewrite, on exactly the applies that matter
   * most — the ones that move Hermes.
   */
  test("a plan for a ref change names the revision file the real run rewrites", async () => {
    const host = new FakeHost();
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
    await apply(makeManifest({ hermes_ref: REF }), { host, getObject: host.getObject });

    const next = { hermes_ref: "v2026.9.14", hermes_version: "0.21.3" };
    host.hermesVersionByRef.set(next.hermes_ref, next.hermes_version);

    const plan = await apply(makeManifest(next), { host, getObject: host.getObject, dryRun: true });
    const real = await apply(makeManifest(next), { host, getObject: host.getObject });

    expect(plan.changed).toContain(HERMES_REVISION_ENV);
    expect(real.changed).toContain(HERMES_REVISION_ENV);
    // …and the value really did move, which is what made it a change.
    expect(environment(host.files.get(HERMES_REVISION_ENV)?.content ?? "")).toEqual({
      HERMES_REVISION: fakeCommitSha(next.hermes_ref),
    });
  });
});
