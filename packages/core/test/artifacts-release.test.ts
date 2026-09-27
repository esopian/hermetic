/**
 * A *release* end to end on the laptop side (§1, §3.1): where the stages come
 * from, what a push puts in the bucket and in what order, and what the fleet
 * manifest says afterwards. Nothing here touches AWS — `MemoryBackend`'s
 * artifacts store is a `Map`, which is exactly enough to assert key, digest and
 * ordering.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTD_STAGES,
  STAGES_ENV,
  describeRelease,
  fleetManifestFrom,
  locateRelease,
  locateStages,
  pointFleetAt,
  pushRelease,
  readFleetManifest,
  recordHermesMirror,
  releaseDrift,
  releaseGeneration,
  readRelease,
  writeFleetManifest,
  publishRelease,
  withFleetLock,
} from "../src/release/artifacts.ts";
import { HermeticError } from "../src/errors.ts";
import { MemoryBackend, seedFixtureFoundation } from "../src/backend/memory.ts";
import {
  FIXTURE_BUILD_NUMBER,
  FIXTURE_COMMIT,
  FIXTURE_HERMETICD_SHA256,
  FIXTURE_LOCAL_BUILD,
  FIXTURE_HERMETICD_VERSION,
  FIXTURE_CHROME_REF,
  FIXTURE_STALE_SHA256,
  seedFixtureAgents,
} from "../src/backend/fixture/memory-fixture.ts";
import {
  BROWSER_FOUNDATION_VERSION,
  browserBuildKey,
  FLEET_MANIFEST_KEY,
  RELEASE_MANIFEST_NAME,
  releaseKey,
} from "../src/schema/index.ts";
import type { FleetItem } from "../src/schema/index.ts";
import { fixtureBrowserMirror } from "../src/release/browser-mirror.ts";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stagesDir(names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hermetic-stages-"));
  tmp.push(dir);
  for (const name of names) writeFileSync(join(dir, name), `#!/usr/bin/env bash\n# ${name}\n`);
  return dir;
}

function binary(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermetic-bin-"));
  tmp.push(dir);
  writeFileSync(join(dir, "hermeticd"), "ELF");
  writeFileSync(join(dir, "hermeticd.version"), "0.4.1\n");
  return dir;
}

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

describe("locating the stages", () => {
  test("HERMETIC_STAGES wins, and the names come back in run order", () => {
    const dir = stagesDir(["02-data-volume.sh", "00-preflight.sh", "01-tailscale.sh"]);
    const found = locateStages({ env: { [STAGES_ENV]: dir }, repoRoot: null });
    expect(found).toEqual({
      dir,
      source: "explicit",
      names: ["00-preflight.sh", "01-tailscale.sh", "02-data-volume.sh"],
    });
  });

  test("a stages/ directory beside the executable is the shipped-binary path", () => {
    const root = mkdtempSync(join(tmpdir(), "hermetic-dist-"));
    tmp.push(root);
    mkdirSync(join(root, "stages"));
    writeFileSync(join(root, "stages", "00-preflight.sh"), "#!/usr/bin/env bash\n");
    const found = locateStages({ env: {}, execPath: join(root, "hermetic"), repoRoot: null });
    expect(found?.source).toBe("sibling");
    expect(found?.dir).toBe(join(root, "stages"));
  });

  test("a source checkout falls back to packages/agentd/stages", () => {
    const root = mkdtempSync(join(tmpdir(), "hermetic-checkout-"));
    tmp.push(root);
    mkdirSync(join(root, AGENTD_STAGES), { recursive: true });
    writeFileSync(join(root, AGENTD_STAGES, "00-preflight.sh"), "#!/usr/bin/env bash\n");
    const found = locateStages({ env: {}, execPath: join(root, "hermetic"), repoRoot: root });
    expect(found).toMatchObject({ source: "checkout", names: ["00-preflight.sh"] });
  });

  test("nothing anywhere is null, not an error", () => {
    const empty = mkdtempSync(join(tmpdir(), "hermetic-nostages-"));
    tmp.push(empty);
    expect(locateStages({ env: {}, execPath: join(empty, "hermetic"), repoRoot: null })).toBeNull();
  });

  test("an env var pointing nowhere is an error, not a fall-through", () => {
    expect(() => locateStages({ env: { [STAGES_ENV]: "/nope/stages" }, repoRoot: null })).toThrow(
      HermeticError,
    );
  });

  test("a stage whose name is not NN-<name>.sh is refused before any upload", () => {
    const dir = stagesDir(["00-preflight.sh", "tailscale.sh"]);
    let err: unknown;
    try {
      locateStages({ env: { [STAGES_ENV]: dir }, repoRoot: null });
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("HERMETICD_UNAVAILABLE");
    expect((err as HermeticError).message).toContain("tailscale.sh");
  });

  test("two stages sharing an ordinal are refused: the run order would be a guess", () => {
    const dir = stagesDir(["01-tailscale.sh", "01-network.sh"]);
    expect(() => locateStages({ env: { [STAGES_ENV]: dir }, repoRoot: null })).toThrow(
      /duplicate stage ordinal 01/,
    );
  });

  test("locateRelease pairs the binary with the stages", async () => {
    const bin = binary();
    const dir = stagesDir(["00-preflight.sh"]);
    const release = await locateRelease({
      version: "0.4.1",
      env: { HERMETIC_HERMETICD: join(bin, "hermeticd"), [STAGES_ENV]: dir },
      repoRoot: null,
    });
    expect(release?.hermeticd.path).toBe(join(bin, "hermeticd"));
    expect(release?.stages?.names).toEqual(["00-preflight.sh"]);
  });
});

describe("pushRelease", () => {
  const files = (names: readonly string[]) =>
    readRelease({
      version: "0.5.0",
      hermeticd: { path: join(binary(), "hermeticd"), source: "explicit", version: null, build: null },
      stages: locateStages({ env: { [STAGES_ENV]: stagesDir(names) }, repoRoot: null }),
    });

  test("uploads the binary and every stage, and records key, digest and size", async () => {
    const backend = new MemoryBackend();
    const pushed = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: files(["00-preflight.sh", "01-tailscale.sh"]),
    });

    expect(pushed.version).toBe("0.5.0");
    expect(Object.keys(pushed.files).sort()).toEqual([
      "hermeticd",
      "stages/00-preflight.sh",
      "stages/01-tailscale.sh",
    ]);
    const generation = pushed.generation!;
    expect(generation).toMatch(/^[0-9a-f]{16}$/);
    expect(pushed.files["hermeticd"]).toEqual({
      key: `artifacts/0.5.0/${generation}/hermeticd`,
      sha256: digest("ELF"),
      size: 3,
    });
    expect(pushed.files["stages/01-tailscale.sh"]!.key).toBe(
      `artifacts/0.5.0/${generation}/stages/01-tailscale.sh`,
    );
    for (const file of Object.values(pushed.files)) {
      expect(backend.objects.has(file.key)).toBe(true);
    }
    // The generation's own manifest, written last, is what makes it a release.
    expect(backend.objects.has(`artifacts/0.5.0/${generation}/release.json`)).toBe(true);
  });

  /**
   * The ordering is a safety property, not a style: a reader treats a present
   * `hermeticd` as "the whole release is here", which is only true if the
   * binary is the last thing written.
   */
  test("records which build pushed it, and says nothing when the pusher cannot say", async () => {
    const backend = new MemoryBackend();
    const pushed = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: files(["00-preflight.sh"]),
      build: "fingerprint-a",
    });
    expect(pushed.build).toBe("fingerprint-a");

    const unknown = await pushRelease(new MemoryBackend().artifacts, {
      version: "0.5.0",
      files: files(["00-preflight.sh"]),
      build: null,
    });
    // Absent, not empty: `releaseDrift` reads absent as "cannot tell".
    expect(unknown.build).toBeUndefined();
    expect("build" in unknown).toBe(false);
  });

  test("the stages go up in run order, the binary next, release.json last", async () => {
    const backend = new MemoryBackend();
    const pushed = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: files(["01-tailscale.sh", "00-preflight.sh"]),
    });
    const generation = pushed.generation!;
    expect([...backend.objects.keys()]).toEqual([
      `artifacts/0.5.0/${generation}/stages/00-preflight.sh`,
      `artifacts/0.5.0/${generation}/stages/01-tailscale.sh`,
      `artifacts/0.5.0/${generation}/hermeticd`,
      `artifacts/0.5.0/${generation}/release.json`,
    ]);
  });

  test("refuses a release with no stages at all: it would boot nothing", async () => {
    const backend = new MemoryBackend();
    let err: unknown;
    try {
      await pushRelease(backend.artifacts, {
        version: "0.5.0",
        files: [
          {
            name: "hermeticd",
            bytes: new TextEncoder().encode("ELF"),
            contentType: "application/octet-stream",
          },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("HERMETICD_UNAVAILABLE");
    expect((err as HermeticError).message).toContain("boot nothing");
    expect((err as HermeticError).message).toContain(STAGES_ENV);
    expect(backend.objects.size).toBe(0);
  });

  test("refuses a bad stage name rather than uploading half a release", async () => {
    const backend = new MemoryBackend();
    let err: unknown;
    try {
      await pushRelease(backend.artifacts, {
        version: "0.5.0",
        files: [
          {
            name: "hermeticd",
            bytes: new TextEncoder().encode("ELF"),
            contentType: "application/octet-stream",
          },
          {
            name: "stages/tailscale.sh",
            bytes: new TextEncoder().encode("#!"),
            contentType: "text/x-shellscript",
          },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("HERMETICD_UNAVAILABLE");
    // Nothing was uploaded: the names are checked before the first PutObject.
    expect(backend.objects.size).toBe(0);
  });

  test("a release with no binary is refused", async () => {
    const backend = new MemoryBackend();
    await expect(pushRelease(backend.artifacts, { version: "0.5.0", files: [] })).rejects.toThrow(
      HermeticError,
    );
  });

  test("writes no pointer of its own — the manifest is a separate, later write", async () => {
    const backend = new MemoryBackend();
    await pushRelease(backend.artifacts, { version: "0.5.0", files: files(["00-preflight.sh"]) });
    expect(backend.objects.has(FLEET_MANIFEST_KEY)).toBe(false);
  });
});

describe("the fleet manifest", () => {
  function seeded() {
    const backend = seedFixtureFoundation(new MemoryBackend());
    return backend;
  }

  const release = {
    version: "0.5.0",
    files: {
      hermeticd: { key: "artifacts/0.5.0/hermeticd", sha256: digest("ELF"), size: 3 },
    },
  };

  test("its resources come from the stack outputs, plus the SSM prefix and stack id", () => {
    const backend = seeded();
    backend.stack!.outputs = {
      ...backend.stack!.outputs,
      VpcId: "vpc-123",
      SubnetIds: "subnet-a,subnet-b",
      SecurityGroupId: "sg-sealed",
      RoleArn: "arn:aws:iam::123456789012:role/hermetic-agent",
      BucketName: "hermetic-bucket",
      AgentsTable: "hermetic-fxtr0001-agents",
      EventsTable: "hermetic-fxtr0001-events",
    };

    const manifest = fleetManifestFrom({
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermeticd: release,
      updatedBy: "arn:aws:iam::123456789012:user/e",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.fleet_id).toBe(backend.fleetItem!.fleet_id);
    expect(manifest.hermeticd.version).toBe("0.5.0");
    expect(manifest.resources).toEqual({
      bucket: "hermetic-bucket",
      stack_id: backend.fleetItem!.stack_id,
      agents_table: "hermetic-fxtr0001-agents",
      events_table: "hermetic-fxtr0001-events",
      param_prefix: `/hermes/${backend.fleetItem!.fleet_id}/`,
      vpc_id: "vpc-123",
      subnet_ids: ["subnet-a", "subnet-b"],
      security_group_id: "sg-sealed",
      instance_profile_arn: `arn:aws:iam::123456789012:instance-profile/hermetic-agent`,
      role_arn: "arn:aws:iam::123456789012:role/hermetic-agent",
      // §5: published from `_fleet.network`, so the box can see its own mode.
      network: "public",
    });
  });

  /**
   * §5: the box reads its own network mode from the manifest rather than
   * calling AWS. `_fleet.network` is the source, and a fleet that has none —
   * one the v6 migration has not reached — publishes the field absent rather
   * than `public`, because a `nat` fleet described as `public` is worse than
   * one described as unknown.
   */
  test("the network mode is published from _fleet, and omitted when it has none", () => {
    const backend = seeded();
    backend.fleetItem = { ...backend.fleetItem!, network: "nat" };
    const withMode = fleetManifestFrom({
      fleet: backend.fleetItem,
      stack: backend.stack,
      hermeticd: release,
      updatedBy: "e",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    expect(withMode.resources.network).toBe("nat");

    backend.fleetItem = { ...backend.fleetItem, network: undefined };
    const without = fleetManifestFrom({
      fleet: backend.fleetItem,
      stack: backend.stack,
      hermeticd: release,
      updatedBy: "e",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    expect(without.resources.network).toBeUndefined();
    expect("network" in without.resources).toBe(false);
  });

  test("a stack with no table outputs falls back to the names its stack implies", () => {
    const backend = seeded();
    const { AgentsTable: _a, EventsTable: _e, ...rest } = backend.stack!.outputs;
    backend.stack!.outputs = rest;
    const manifest = fleetManifestFrom({
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermeticd: release,
      updatedBy: "e",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    expect(manifest.resources.agents_table).toBe("hermetic-fxtr0001-agents");
  });

  /**
   * `resources` is where the box reads its table names and its SSM prefix, and
   * every field of it comes from a stack output. A `DescribeStacks` that failed
   * or found nothing must therefore stop the write — filling the gaps with
   * blanks would overwrite a manifest that had them right, and the fleet would
   * be pointed at nothing.
   */
  test("refuses to build from a stack that could not be described", () => {
    const backend = seeded();
    let err: unknown;
    try {
      fleetManifestFrom({
        fleet: backend.fleetItem!,
        stack: null,
        hermeticd: release,
        updatedBy: "e",
        updatedAt: "2026-09-03T00:00:00.000Z",
      });
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("NOT_FOUND");
    expect((err as HermeticError).message).toContain("nothing was written");
  });

  test("refuses a stack missing an output rather than writing a blank field", () => {
    const backend = seeded();
    const { VpcId: _dropped, ...rest } = backend.stack!.outputs;
    backend.stack!.outputs = rest;
    expect(() =>
      fleetManifestFrom({
        fleet: backend.fleetItem!,
        stack: backend.stack,
        hermeticd: release,
        updatedBy: "e",
        updatedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toThrow(/vpc_id/);
  });

  test("a refused write leaves the manifest that was already there", async () => {
    const backend = seeded();
    const before = await backend.artifacts.getText(FLEET_MANIFEST_KEY);
    await expect(
      writeFleetManifest(backend.artifacts, {
        fleet: backend.fleetItem!,
        stack: null,
        hermeticd: release,
        updatedBy: "e",
        updatedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).rejects.toThrow(HermeticError);
    expect(await backend.artifacts.getText(FLEET_MANIFEST_KEY)).toBe(before);
  });

  test("is written as JSON at the root of the bucket, and reads back", async () => {
    const backend = seeded();
    const written = await writeFleetManifest(backend.artifacts, {
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermeticd: release,
      updatedBy: "e",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    expect(backend.objects.has(FLEET_MANIFEST_KEY)).toBe(true);
    expect(await readFleetManifest(backend.artifacts)).toEqual(written);
  });

  test("a bucket with no manifest reads as null, not as an error", async () => {
    expect(await readFleetManifest(new MemoryBackend().artifacts)).toBeNull();
  });

  test("a manifest that does not validate is an error: everything verifies against it", async () => {
    const backend = seeded();
    backend.objects.set(FLEET_MANIFEST_KEY, new TextEncoder().encode('{"schema_version":2}'));
    await expect(readFleetManifest(backend.artifacts)).rejects.toThrow(HermeticError);
  });
});

describe("describeRelease", () => {
  test("recomputes the digests from the objects themselves", async () => {
    const backend = new MemoryBackend();
    backend.objects.set("artifacts/0.6.0/hermeticd", new TextEncoder().encode("ELF"));
    backend.objects.set(
      "artifacts/0.6.0/stages/00-preflight.sh",
      new TextEncoder().encode("#!/usr/bin/env bash\n"),
    );

    const described = await describeRelease(backend.artifacts, "0.6.0");
    expect(described.version).toBe("0.6.0");
    expect(described.files["hermeticd"]!.sha256).toBe(digest("ELF"));
    expect(described.files["stages/00-preflight.sh"]!.size).toBe(20);
  });

  test("an interrupted push is refused: the binary never landed", async () => {
    const backend = new MemoryBackend();
    // Stages go first, so a push that dies partway leaves stages and no binary.
    let uploads = 0;
    const real = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      if (uploads++ >= 1) throw new Error("the laptop closed its lid");
      await real.call(backend.artifacts, key, body);
    };
    await expect(
      pushRelease(backend.artifacts, {
        version: "0.7.0",
        files: [
          {
            name: "hermeticd",
            bytes: new TextEncoder().encode("ELF"),
            contentType: "application/octet-stream",
          },
          {
            name: "stages/00-preflight.sh",
            bytes: new TextEncoder().encode("#!"),
            contentType: "text/x-shellscript",
          },
          {
            name: "stages/01-tailscale.sh",
            bytes: new TextEncoder().encode("#!"),
            contentType: "text/x-shellscript",
          },
        ],
      }),
    ).rejects.toThrow();
    backend.artifacts.putObject = real;

    expect(backend.objects.has("artifacts/0.7.0/hermeticd")).toBe(false);
    let code: string | null = null;
    try {
      await describeRelease(backend.artifacts, "0.7.0");
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NOT_FOUND");
  });

  test("a complete push is accepted, and its digests round-trip", async () => {
    const backend = new MemoryBackend();
    const pushed = await pushRelease(backend.artifacts, {
      version: "0.7.0",
      files: [
        {
          name: "hermeticd",
          bytes: new TextEncoder().encode("ELF"),
          contentType: "application/octet-stream",
        },
        {
          name: "stages/00-preflight.sh",
          bytes: new TextEncoder().encode("#!"),
          contentType: "text/x-shellscript",
        },
      ],
    });
    const described = await describeRelease(backend.artifacts, "0.7.0");
    // The bytes and their digests round-trip exactly…
    expect(described.version).toBe(pushed.version);
    expect(described.files).toEqual(pushed.files);
    /**
     * …and the two claims a *push* can make and a *read of the bucket* cannot
     * are absent, deliberately. `describeRelease` is how `upgrade --hermeticd
     * <ver>` points at a release some other laptop pushed: the objects do not
     * say which checkout compiled them, nor what that hermeticd implements, and
     * absent is the honest answer that every reader treats as "cannot tell".
     */
    expect(described.build).toBeUndefined();
    expect(described.capabilities).toBeUndefined();
    expect(pushed.capabilities).toContain("gateway-unit");
  });

  test("a generation marker cannot borrow another generation's objects", async () => {
    const backend = new MemoryBackend();
    const first = await pushRelease(backend.artifacts, {
      version: "0.7.0",
      files: [
        {
          name: "hermeticd",
          bytes: new TextEncoder().encode("ELF-one"),
          contentType: "application/octet-stream",
        },
        {
          name: "stages/00-preflight.sh",
          bytes: new TextEncoder().encode("#! one"),
          contentType: "text/x-shellscript",
        },
      ],
      now: "2026-09-16T00:00:00.000Z",
    });
    const second = await pushRelease(backend.artifacts, {
      version: "0.7.0",
      files: [
        {
          name: "hermeticd",
          bytes: new TextEncoder().encode("ELF-two"),
          contentType: "application/octet-stream",
        },
        {
          name: "stages/00-preflight.sh",
          bytes: new TextEncoder().encode("#! two"),
          contentType: "text/x-shellscript",
        },
      ],
      now: "2026-09-17T00:00:00.000Z",
    });

    const markerKey = releaseKey("0.7.0", RELEASE_MANIFEST_NAME, second.generation);
    const marker = JSON.parse(new TextDecoder().decode(backend.objects.get(markerKey)!));
    marker.files = first.files;
    backend.objects.set(markerKey, new TextEncoder().encode(JSON.stringify(marker)));

    const described = await describeRelease(backend.artifacts, "0.7.0");
    expect(described.generation).toBe(first.generation);
    expect(described.files).toEqual(first.files);
  });

  test("a binary with no stages beside it is refused, not blessed", async () => {
    const backend = new MemoryBackend();
    backend.objects.set("artifacts/0.8.0/hermeticd", new TextEncoder().encode("ELF"));
    let err: unknown;
    try {
      await describeRelease(backend.artifacts, "0.8.0");
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("NOT_FOUND");
    expect((err as HermeticError).message).toContain("no stages");
  });

  test("a version that is not in the bucket is NOT_FOUND", async () => {
    const backend = new MemoryBackend();
    let err: unknown;
    try {
      await describeRelease(backend.artifacts, "9.9.9");
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("NOT_FOUND");
    expect((err as HermeticError).message).toContain("artifacts push 9.9.9");
  });
});

/**
 * §3.6: same version, different bytes. The sentence appears only when the
 * comparison can mean something — which is the whole of what is asserted here,
 * because every other case has to stay silent or it becomes noise an operator
 * learns to skip.
 */
describe("releaseDrift", () => {
  const local = { version: "0.5.0", build: "bbbb" };

  test("different builds at the same version → the warning, naming the remedy", () => {
    const said = releaseDrift({ version: "0.5.0", build: "aaaa" }, local);
    expect(said).toContain("different build");
    expect(said).toContain("hermetic artifacts push");
    expect(said).toContain("hermetic agent recreate");
    expect(said).toContain("0.5.0");
  });

  test("equal builds say nothing", () => {
    expect(releaseDrift({ version: "0.5.0", build: "bbbb" }, local)).toBeNull();
  });

  test("no manifest says nothing", () => {
    expect(releaseDrift(null, local)).toBeNull();
  });

  test("either build unknown says nothing rather than guessing", () => {
    expect(releaseDrift({ version: "0.5.0" }, local)).toBeNull();
    expect(releaseDrift({ version: "0.5.0", build: null }, local)).toBeNull();
    expect(
      releaseDrift({ version: "0.5.0", build: "aaaa" }, { version: "0.5.0", build: null }),
    ).toBeNull();
  });

  test("a differing version says nothing: that is already the skew's sentence", () => {
    expect(releaseDrift({ version: "0.4.1", build: "aaaa" }, local)).toBeNull();
  });
});

/**
 * The fixture's release constants against the bytes the fixture actually
 * publishes.
 *
 * `FIXTURE_HERMETICD_SHA256` is a literal, because the *agent rows* have to
 * carry it: §6.6's rollout confirms a landing by comparing what a box reports
 * against what the manifest names, so the fixture's boxes are seeded with this
 * exact digest. Two literals that have to agree is the shape of every bug this
 * branch fixed, so they are held equal here rather than by a comment.
 */
describe("the fixture's seeded release describes the bytes it publishes", () => {
  test("FIXTURE_HERMETICD_SHA256 is the digest of the stand-in binary", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const manifest = await readFleetManifest(backend.artifacts);
    expect(manifest?.hermeticd.files["hermeticd"]?.sha256).toBe(FIXTURE_HERMETICD_SHA256);
  });

  /**
   * And the boxes agree with it — otherwise `bun run dev:fixture` would show a
   * rollout in which no agent ever lands, and the confirmed path would be
   * reachable only from a test.
   */
  test("the agents on the published release report that same digest", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    const agents = await backend.store.agents.scan();
    const current = agents.filter(
      (a) =>
        a.hermeticd_version === FIXTURE_HERMETICD_VERSION &&
        a.last_heartbeat &&
        !a.running_hermeticd_sha256,
    );
    // Every current, heartbeating box reports a digest — except the one seeded
    // to be too old to, which is its own demonstrated state.
    expect(current.map((a) => a.name)).toEqual(["lumen"]);
    const landed = agents.filter((a) => a.running_hermeticd_sha256 === FIXTURE_HERMETICD_SHA256);
    expect(landed.length).toBeGreaterThan(0);
    for (const a of landed) expect(a.hermeticd_version).toBe(FIXTURE_HERMETICD_VERSION);
  });

  /**
   * The fixture carries every state a reader can reach, which is the standing
   * rule for it: a fleet that showed only one would leave the other paths
   * visible in tests and nowhere a human looks.
   */
  test("the fixture shows a straggler, an unconfirmable box, and a pending hermes upgrade", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    const agents = await backend.store.agents.scan();
    expect(agents.some((a) => a.running_hermeticd_sha256 === FIXTURE_STALE_SHA256)).toBe(true);
    expect(agents.some((a) => a.last_heartbeat !== null && a.running_hermeticd_sha256 === null)).toBe(
      true,
    );
    expect(
      agents.some(
        (a) => a.running_hermes_version !== null && a.running_hermes_version !== a.hermes_version,
      ),
    ).toBe(true);
  });
});

/**
 * A fixture push must not destroy the fixture.
 *
 * `seedFixtureRelease` writes the stand-in binary and the seeded agent rows
 * report *its* digest, so a `releaseFiles` that republished different bytes
 * would leave every box reporting a digest the manifest no longer names — one
 * `artifacts push` in `dev:fixture` turning a fleet of landed agents into a
 * fleet of stragglers. It published `hermeticd <version>` as text until now.
 */
describe("a fixture push republishes what the fixture seeded", () => {
  test("the binary digest survives a push, so the seeded boxes stay landed", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    await publishRelease(
      { artifacts: backend.artifacts, hermeticVersion: FIXTURE_HERMETICD_VERSION, fixture: true },
      {},
      {
        fleet: backend.fleetItem!,
        stack: backend.stack,
        updatedBy: "test",
        updatedAt: new Date().toISOString(),
      },
    );
    const after = await readFleetManifest(backend.artifacts);
    expect(after?.hermeticd.files["hermeticd"]?.sha256).toBe(FIXTURE_HERMETICD_SHA256);

    const agents = await backend.store.agents.scan();
    const landed = agents.filter((a) => a.running_hermeticd_sha256 === FIXTURE_HERMETICD_SHA256);
    expect(landed.length).toBeGreaterThan(0);
  });

  /**
   * And the provenance survives too, or the update drawer goes back to the two
   * blanks the fixture was seeded to stop showing.
   */
  test("the push records a build number and a commit rather than dropping them", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    await publishRelease(
      { artifacts: backend.artifacts, hermeticVersion: FIXTURE_HERMETICD_VERSION, fixture: true },
      {},
      {
        fleet: backend.fleetItem!,
        stack: backend.stack,
        updatedBy: "test",
        updatedAt: new Date().toISOString(),
      },
    );
    const after = await readFleetManifest(backend.artifacts);
    expect(after?.hermeticd.build_number).toBe(FIXTURE_BUILD_NUMBER);
    expect(after?.hermeticd.commit).toBe(FIXTURE_COMMIT);
    expect(after?.hermeticd.build).toBe(FIXTURE_LOCAL_BUILD);
  });

  /**
   * And it lands on the generation already in the bucket rather than inventing a
   * second one. The generation is a digest of every file's name, sha256 *and*
   * content type, so the seed has to state the same content types `releaseFiles`
   * does — they drifted apart once, silently, because nothing compared them.
   */
  test("the push lands on the seeded generation rather than a second one", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    const seeded = (await readFleetManifest(backend.artifacts))!.hermeticd.generation;
    expect(seeded).toBeTruthy();
    await publishRelease(
      { artifacts: backend.artifacts, hermeticVersion: FIXTURE_HERMETICD_VERSION, fixture: true },
      {},
      {
        fleet: backend.fleetItem!,
        stack: backend.stack,
        updatedBy: "test",
        updatedAt: new Date().toISOString(),
      },
    );
    expect((await readFleetManifest(backend.artifacts))!.hermeticd.generation).toBe(seeded);
  });
});

/**
 * §4.4: acquire, then read. `withFleetLock` read `_fleet` *before* it took the
 * lock and handed that copy to the body, which is the one read the lock cannot
 * protect — a `settings.set` or a metadata write landing in the gap was invisible
 * to the manifest composed from it, and the manifest is what every box reads.
 */
describe("withFleetLock", () => {
  const OWNER = "arn:aws:iam::123456789012:user/e#run-1 artifacts.push";

  test("reads _fleet after taking the lock, not before", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const seeded = backend.fleetItem!;
    // The write that lands where the old read used to be: applied by the lock
    // take itself, which is after every chance the caller had to read early.
    const patched: FleetItem = { ...seeded, tailnet: "landed-after-the-read.ts.net" };
    const calls: string[] = [];
    let current: FleetItem | null = seeded;
    const unlocked: string[] = [];
    const store = {
      get: async (): Promise<FleetItem | null> => {
        calls.push("get");
        return current;
      },
      lockFleet: async (): Promise<boolean> => {
        calls.push("lockFleet");
        current = patched;
        return true;
      },
      unlockFleet: async (owner: string): Promise<void> => {
        unlocked.push(owner);
      },
    };

    const seen = await withFleetLock(
      store,
      { fleet: seeded, owner: OWNER, ttlMs: 30_000, now: () => backend.clock.now() },
      async (fleet) => fleet.tailnet,
    );
    expect(seen).toBe("landed-after-the-read.ts.net");
    // The only read is the one behind the shut door, and the lock went back.
    expect(calls).toEqual(["lockFleet", "get"]);
    expect(unlocked).toEqual([OWNER]);
  });

  test("a refusal with no _fleet row behind it is NOT_FOUND rather than LOCKED", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const store = {
      get: async (): Promise<FleetItem | null> => null,
      lockFleet: async (): Promise<boolean> => false,
      unlockFleet: async (): Promise<void> => undefined,
    };
    const e = await withFleetLock(
      store,
      { fleet: backend.fleetItem!, owner: OWNER, ttlMs: 30_000, now: () => backend.clock.now() },
      async () => "unreachable",
    ).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(HermeticError);
    expect((e as HermeticError).code).toBe("NOT_FOUND");
  });
});

/**
 * H13: publishing the same release version used to mutate live artifacts.
 *
 * Every file went to a key named by the version alone, so a second push of
 * `0.5.0` overwrote the first one's objects in place. The old binary was
 * already there before the push began, which meant its presence no longer
 * proved anything about the stages beside it — an interrupted republish left
 * the *new* stages sitting next to the *old* binary, under exactly the keys the
 * live fleet manifest named and any already-minted bootstrap URL pointed at.
 *
 * Releases are now immutable generations addressed by content digest, so these
 * tests are about what a failed push cannot reach.
 */
describe("an interrupted same-version republish", () => {
  const release = (stage: string, binary: string) => [
    {
      name: "hermeticd",
      bytes: new TextEncoder().encode(binary),
      contentType: "application/octet-stream",
    },
    {
      name: "stages/00-preflight.sh",
      bytes: new TextEncoder().encode(stage),
      contentType: "text/x-shellscript",
    },
  ];

  /** Push the first release of `0.5.0` and point the fleet manifest at it. */
  async function published() {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermeticd = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: release("#! one\n", "ELF-one"),
      now: "2026-09-16T00:00:00.000Z",
    });
    await writeFleetManifest(backend.artifacts, {
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermeticd,
      updatedBy: "test",
      updatedAt: "2026-09-16T00:00:00.000Z",
    });
    return { backend, hermeticd };
  }

  /** Fail the `n`th `putObject` of the next push, and every one after it. */
  function failAfter(backend: MemoryBackend, n: number): () => void {
    const real = backend.artifacts.putObject;
    let uploads = 0;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      if (uploads++ >= n) throw new Error("the laptop closed its lid");
      await real.call(backend.artifacts, key, body);
    };
    return () => {
      backend.artifacts.putObject = real;
    };
  }

  test("never yields new stages paired with an old binary", async () => {
    const { backend, hermeticd } = await published();
    const before = new Map(
      [...backend.objects].map(([k, v]) => [k, digest(new TextDecoder().decode(v))]),
    );

    // Same version, different bytes, dying after the stages and before the
    // binary — the exact window the finding describes.
    const restore = failAfter(backend, 1);
    await expect(
      pushRelease(backend.artifacts, {
        version: "0.5.0",
        files: release("#! two\n", "ELF-two"),
        now: "2026-09-16T01:00:00.000Z",
      }),
    ).rejects.toThrow();
    restore();

    // Not one object of the published release moved.
    for (const [key, sha] of before) {
      expect({ key, sha: digest(new TextDecoder().decode(backend.objects.get(key)!)) }).toEqual({
        key,
        sha,
      });
    }
    // The live manifest still names the first generation, byte for byte.
    const manifest = (await readFleetManifest(backend.artifacts))!;
    expect(manifest.hermeticd).toEqual(hermeticd);
    for (const entry of Object.values(manifest.hermeticd.files)) {
      const bytes = backend.objects.get(entry.key)!;
      expect(digest(new TextDecoder().decode(bytes))).toBe(entry.sha256);
    }
    // And the half-written generation is not a release anybody can be pointed
    // at: `describeRelease` still resolves the first one.
    const described = await describeRelease(backend.artifacts, "0.5.0");
    expect(described.generation).toBe(hermeticd.generation);
    expect(described.files["hermeticd"]!.key).toBe(manifest.hermeticd.files["hermeticd"]!.key);
  });

  test("a generation whose release.json never landed is invisible", async () => {
    const { backend, hermeticd } = await published();
    // Dies after every file of the new generation is up, one write before the
    // marker. Under the old scheme this was the complete-looking release.
    const restore = failAfter(backend, 2);
    await expect(
      pushRelease(backend.artifacts, {
        version: "0.5.0",
        files: release("#! two\n", "ELF-two"),
        now: "2026-09-16T01:00:00.000Z",
      }),
    ).rejects.toThrow();
    restore();

    const orphan = [...backend.objects.keys()].filter(
      (k) => k.startsWith("artifacts/0.5.0/") && !k.includes(hermeticd.generation!),
    );
    expect(orphan.length).toBeGreaterThan(0);
    expect(orphan.some((k) => k.endsWith("/release.json"))).toBe(false);

    const described = await describeRelease(backend.artifacts, "0.5.0");
    expect(described.generation).toBe(hermeticd.generation);
  });

  test("a republish of identical bytes is the same generation, not a second one", async () => {
    const { backend, hermeticd } = await published();
    const again = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: release("#! one\n", "ELF-one"),
      now: "2026-09-16T02:00:00.000Z",
    });
    expect(again.generation).toBe(hermeticd.generation);
    expect(again.files).toEqual(hermeticd.files);
  });

  /**
   * The marker is part of the generation, so the generation's immutability has
   * to cover it. Rewriting `release.json` on a republish of unchanged bytes
   * would move a *published* generation's `created_at`, `build` and `commit` to
   * whoever pushed last — which reorders `describeRelease`'s answer for a
   * version (it sorts on `created_at`) and relabels the provenance of bytes
   * nobody touched.
   */
  test("a no-op republish keeps the first push's provenance", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const first = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: release("#! one\n", "ELF-one"),
      build: "build-one",
      git: { build_number: 41, commit: "1".repeat(40), dirty: false },
      now: "2026-09-16T00:00:00.000Z",
    });
    const markerKey = releaseKey("0.5.0", RELEASE_MANIFEST_NAME, first.generation);
    const before = new TextDecoder().decode(backend.objects.get(markerKey)!);

    // A second laptop, a later clock, a different checkout — and the identical
    // bytes, so the same generation by construction.
    const writes: string[] = [];
    const real = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      writes.push(key);
      await real.call(backend.artifacts, key, body);
    };
    const again = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: release("#! one\n", "ELF-one"),
      build: "build-two",
      git: { build_number: 99, commit: "2".repeat(40), dirty: false },
      now: "2026-09-17T12:00:00.000Z",
    });
    backend.artifacts.putObject = real;

    expect(again.generation).toBe(first.generation);
    expect(writes).not.toContain(markerKey);
    expect(new TextDecoder().decode(backend.objects.get(markerKey)!)).toBe(before);

    const marker = JSON.parse(before);
    expect(marker.created_at).toBe("2026-09-16T00:00:00.000Z");
    expect(marker.build).toBe("build-one");
    expect(marker.build_number).toBe(41);
    expect(marker.commit).toBe("1".repeat(40));
  });

  /**
   * The control for the test above, and the half that keeps `sameMarker` from
   * being written too leniently: a marker that is *not* this generation's is
   * not provenance to protect. Each of these is a bucket somebody edited by
   * hand, and leaving one in place would leave the bucket describing a release
   * that was never pushed. It passes against the code as it stood before the
   * no-op republish existed, which is what makes it a control rather than a
   * test of that behaviour.
   */
  test("control: a marker that does not describe this generation is rewritten", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const first = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: release("#! one\n", "ELF-one"),
      now: "2026-09-16T00:00:00.000Z",
    });
    const markerKey = releaseKey("0.5.0", RELEASE_MANIFEST_NAME, first.generation);

    for (const corruption of ["{ truncated", JSON.stringify({ schema_version: 1 })]) {
      backend.objects.set(markerKey, new TextEncoder().encode(corruption));
      const again = await pushRelease(backend.artifacts, {
        version: "0.5.0",
        files: release("#! one\n", "ELF-one"),
        now: "2026-09-17T12:00:00.000Z",
      });
      expect(again.generation).toBe(first.generation);
      const marker = JSON.parse(new TextDecoder().decode(backend.objects.get(markerKey)!));
      expect(marker.created_at).toBe("2026-09-17T12:00:00.000Z");
      expect(marker.generation).toBe(first.generation);
    }
  });

  /**
   * The content type is part of the object a push writes and part of what a
   * fetch gets back, so it is part of the generation. A build that started
   * serving the stages as `application/octet-stream` would otherwise write a
   * different object to a key a published generation already names — the one
   * thing a generation exists to forbid.
   */
  test("the content type is folded into the generation", async () => {
    const bytes = new TextEncoder().encode("#! one\n");
    const shell = releaseGeneration([
      { name: "stages/00-preflight.sh", sha256: digest("#! one\n"), contentType: "text/x-shellscript" },
    ]);
    const octets = releaseGeneration([
      {
        name: "stages/00-preflight.sh",
        sha256: digest("#! one\n"),
        contentType: "application/octet-stream",
      },
    ]);
    expect(shell).not.toBe(octets);
    // Absent is its own value, and a stable one.
    const absent = releaseGeneration([{ name: "stages/00-preflight.sh", sha256: digest("#! one\n") }]);
    expect(absent).not.toBe(shell);
    expect(absent).toBe(
      releaseGeneration([{ name: "stages/00-preflight.sh", sha256: digest("#! one\n") }]),
    );

    // And it reaches the keys: the same bytes served as a different type are a
    // different generation in the bucket, not an overwrite of the first.
    const backend = new MemoryBackend();
    const one = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: [
        { name: "hermeticd", bytes, contentType: "application/octet-stream" },
        { name: "stages/00-preflight.sh", bytes, contentType: "text/x-shellscript" },
      ],
    });
    const two = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: [
        { name: "hermeticd", bytes, contentType: "application/octet-stream" },
        { name: "stages/00-preflight.sh", bytes, contentType: "application/octet-stream" },
      ],
    });
    expect(two.generation).not.toBe(one.generation);
    expect(two.files["stages/00-preflight.sh"]!.key).not.toBe(one.files["stages/00-preflight.sh"]!.key);
  });

  test("a republish of different bytes cannot reach the published generation", async () => {
    const { backend, hermeticd } = await published();
    const next = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: release("#! two\n", "ELF-two"),
      now: "2026-09-16T02:00:00.000Z",
    });
    expect(next.generation).not.toBe(hermeticd.generation);
    for (const [name, entry] of Object.entries(hermeticd.files)) {
      expect(next.files[name]!.key).not.toBe(entry.key);
      const bytes = backend.objects.get(entry.key)!;
      expect(digest(new TextDecoder().decode(bytes))).toBe(entry.sha256);
    }
    // The newer generation is what a fleet would now be pointed at.
    expect((await describeRelease(backend.artifacts, "0.5.0")).generation).toBe(next.generation);
  });

  /**
   * Step 2 of a push: the generation is confirmed present before anything is
   * allowed to name it. A `putObject` that resolved is not the same statement
   * as an object that is in the bucket, and the manifest written next is what
   * every box verifies its downloads against.
   */
  test("a push whose objects did not all land moves no pointer", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const before = await readFleetManifest(backend.artifacts);

    // A bucket that quietly swallows the binary: the put resolves, the object
    // is not there.
    const real = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      if (key.endsWith("/hermeticd")) return;
      await real.call(backend.artifacts, key, body);
    };
    let err: unknown;
    try {
      await publishRelease(
        { artifacts: backend.artifacts, hermeticVersion: "0.5.0", fixture: true },
        { version: "0.5.0" },
        {
          fleet: backend.fleetItem!,
          stack: backend.stack,
          updatedBy: "test",
          updatedAt: "2026-09-16T00:00:00.000Z",
        },
      );
    } catch (e) {
      err = e;
    }
    backend.artifacts.putObject = real;

    expect((err as HermeticError).code).toBe("HERMETICD_UNAVAILABLE");
    expect((err as HermeticError).message).toContain("incomplete");
    expect(await readFleetManifest(backend.artifacts)).toEqual(before);
  });
});

/**
 * The laptop's half of the manifest key check (§3.6). `FleetManifestFile.key`
 * is a non-empty string to the schema and an *instruction* to everything that
 * reads it — hermeticd fetches it and runs it as a bootstrap stage, and
 * `create` presigns it into a booting instance's user-data as a one-hour bearer
 * credential. `tests/seams.test.ts` holds this rule equal to the one the box
 * applies; this is that the laptop applies it at all, and where.
 */
describe("a fleet manifest whose keys leave the release it names", () => {
  async function published() {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermeticd = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: [
        {
          name: "hermeticd",
          bytes: new TextEncoder().encode("ELF-one"),
          contentType: "application/octet-stream",
        },
        {
          name: "stages/00-preflight.sh",
          bytes: new TextEncoder().encode("#! one\n"),
          contentType: "text/x-shellscript",
        },
      ],
      now: "2026-09-16T00:00:00.000Z",
    });
    await writeFleetManifest(backend.artifacts, {
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermeticd,
      updatedBy: "test",
      updatedAt: "2026-09-16T00:00:00.000Z",
    });
    return { backend, hermeticd };
  }

  /** The manifest as a hand-edited bucket sees it: JSON, not a parsed `FleetManifest`. */
  type RawManifest = {
    hermeticd: { generation?: string; files: Record<string, { key: string }> };
    hermes?: Record<string, unknown>;
  };

  /** Rewrite the published manifest through `edit`, as a hand-edited bucket would. */
  async function tamper(backend: MemoryBackend, edit: (manifest: RawManifest) => void) {
    const text = (await backend.artifacts.getText(FLEET_MANIFEST_KEY))!;
    const manifest = JSON.parse(text) as RawManifest;
    edit(manifest);
    backend.objects.set(
      FLEET_MANIFEST_KEY,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );
  }

  const withKey = (name: string, key: string) => (manifest: RawManifest) => {
    manifest.hermeticd.files[name]!.key = key;
  };

  /**
   * The control for every refusal below: it passes with no key check at all, and
   * exists to catch the opposite failure — a rule so tight that the manifest a
   * push just wrote is refused by the next command to read it.
   */
  test("control: is read back unchanged while its keys stay inside the release", async () => {
    const { backend, hermeticd } = await published();
    expect((await readFleetManifest(backend.artifacts))!.hermeticd).toEqual(hermeticd);
  });

  test("is refused before a writer can publish it", async () => {
    const { backend, hermeticd } = await published();
    const before = await backend.artifacts.getText(FLEET_MANIFEST_KEY);
    const bad = {
      ...hermeticd,
      files: {
        ...hermeticd.files,
        hermeticd: {
          ...hermeticd.files["hermeticd"]!,
          key: "config/research-1/bundle.tar.gz",
        },
      },
    };

    const err = await writeFleetManifest(backend.artifacts, {
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermeticd: bad,
      updatedBy: "test",
      updatedAt: "2026-09-17T00:00:00.000Z",
    }).catch((e) => e);
    expect((err as HermeticError).code).toBe("MANIFEST_REFUSED");
    expect(await backend.artifacts.getText(FLEET_MANIFEST_KEY)).toBe(before);
  });

  test("is refused when a key names another namespace in the bucket", async () => {
    const { backend } = await published();
    await tamper(backend, withKey("stages/00-preflight.sh", "config/research-1/bundle.tar.gz"));
    const err = await readFleetManifest(backend.artifacts).catch((e) => e);
    expect(err).toBeInstanceOf(HermeticError);
    expect((err as HermeticError).code).toBe("MANIFEST_REFUSED");
    expect((err as HermeticError).message).toContain("config/research-1/bundle.tar.gz");
  });

  test("is refused when a key names another release of the same bucket", async () => {
    const { backend } = await published();
    await tamper(backend, withKey("hermeticd", "artifacts/0.1.0/deadbeefdeadbeef/hermeticd"));
    const err = await readFleetManifest(backend.artifacts).catch((e) => e);
    expect((err as HermeticError).code).toBe("MANIFEST_REFUSED");
    expect((err as HermeticError).details).toMatchObject({
      version: "0.5.0",
      file: "hermeticd",
    });
  });

  test("is refused when a key climbs out of the release with ..", async () => {
    const { backend } = await published();
    await tamper(backend, withKey("hermeticd", "artifacts/0.5.0/../../config/x/bundle.tar.gz"));
    const err = await readFleetManifest(backend.artifacts).catch((e) => e);
    expect((err as HermeticError).code).toBe("MANIFEST_REFUSED");
  });

  /**
   * The generation is the level that matters now that one version holds more
   * than one release. A manifest claiming generation B while handing the box
   * generation A's binary describes two releases exactly as a version mismatch
   * does — and it is the easier of the two to write, since every key is still
   * under the version the manifest names and every digest still names a real
   * object in the bucket.
   */
  test("is refused when a key names another generation of the release", async () => {
    const { backend, hermeticd } = await published();
    const other = "0".repeat(16);
    expect(other).not.toBe(hermeticd.generation);
    await tamper(backend, withKey("hermeticd", releaseKey("0.5.0", "hermeticd", other)));
    const err = await readFleetManifest(backend.artifacts).catch((e) => e);
    expect((err as HermeticError).code).toBe("MANIFEST_REFUSED");
    expect((err as HermeticError).details).toMatchObject({
      version: "0.5.0",
      generation: hermeticd.generation,
      file: "hermeticd",
    });
  });

  /**
   * The control for that one: the flat pre-generation layout is still in every
   * bucket an older hermetic ever pushed to, and is still a release a fleet may
   * be pointed at. A manifest that records no generation is held to the version
   * alone, or pinning the generation would refuse every one of those buckets.
   */
  test("control: accepts the flat keys of a manifest that records no generation", async () => {
    const { backend } = await published();
    await tamper(backend, (manifest) => {
      delete manifest.hermeticd.generation;
      manifest.hermeticd.files["hermeticd"]!.key = "artifacts/0.5.0/hermeticd";
      manifest.hermeticd.files["stages/00-preflight.sh"]!.key =
        "artifacts/0.5.0/stages/00-preflight.sh";
    });
    const manifest = await readFleetManifest(backend.artifacts);
    expect(manifest!.hermeticd.generation).toBeUndefined();
    expect(manifest!.hermeticd.files["hermeticd"]!.key).toBe("artifacts/0.5.0/hermeticd");
  });

  /**
   * Both halves of the `hermes` exemption, because either one alone is passed by
   * a rule that is simply wrong in the other direction. The mirror lives at
   * `hermes/<ref>.bundle` by design (§3.6) — a different namespace with a
   * different reader — so holding the *block* to the release prefix would refuse
   * every fleet that has a mirror. But the box can read that prefix, which is
   * exactly why a bundle key recorded as a *release file* is refused: it would
   * have hermeticd fetch a Hermes bundle and run it as a bootstrap stage.
   */
  test("exempts the hermes block and still refuses a hermes key as a release file", async () => {
    const { backend } = await published();
    const block = {
      "v2026.9.14": {
        key: "hermes/v2026.9.14.bundle",
        sha256: digest("bundle"),
        size: 6,
        upstream_sha: "3".repeat(40),
      },
    };
    await tamper(backend, (manifest) => {
      manifest.hermes = block;
    });
    expect((await readFleetManifest(backend.artifacts))!.hermes).toEqual(block);

    await tamper(backend, withKey("stages/00-preflight.sh", "hermes/v2026.9.14.bundle"));
    const err = await readFleetManifest(backend.artifacts).catch((e) => e);
    expect((err as HermeticError).code).toBe("MANIFEST_REFUSED");
    expect((err as HermeticError).message).toContain("hermes/v2026.9.14.bundle");
  });

  /**
   * The remedy the refusal names has to work on the manifest being refused.
   * `artifacts push` and `upgrade --hermeticd` replace the `hermeticd` block
   * outright, so they repair such a manifest — but only if they can still read
   * the two blocks beside it. Reading the refusal as "no manifest" published a
   * mirror block of nothing, and a fleet whose agents sit on two Hermes refs
   * (§6.5) lost the ref `mirrorHermes` had not just rebuilt.
   */
  const mirror = {
    "v2026.9.14": {
      key: "hermes/v2026.9.14.bundle",
      sha256: digest("bundle"),
      size: 6,
      upstream_sha: "3".repeat(40),
    },
  };

  async function refusedWithMirror() {
    const { backend, hermeticd } = await published();
    await tamper(backend, (manifest) => {
      manifest.hermes = mirror;
    });
    await tamper(backend, withKey("hermeticd", "config/research-1/bundle.tar.gz"));
    return { backend, hermeticd };
  }

  test("a writer that replaces the release block repairs it, mirror and all", async () => {
    const { backend, hermeticd } = await refusedWithMirror();
    await pointFleetAt(backend.artifacts, backend.store.fleet, {
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermeticd,
      owner: "test",
      ttlMs: 60_000,
      now: () => backend.now(),
      updatedBy: "test",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
    const repaired = (await readFleetManifest(backend.artifacts))!;
    expect(repaired.hermeticd).toEqual(hermeticd);
    expect(repaired.hermes).toEqual(mirror);
  });

  test("a writer that copies the release block forward refuses with it", async () => {
    const { backend } = await refusedWithMirror();
    const err = await recordHermesMirror(backend.artifacts, backend.store.fleet, {
      fleet: backend.fleetItem!,
      stack: backend.stack,
      hermes: mirror,
      owner: "test",
      ttlMs: 60_000,
      now: () => backend.now(),
      updatedBy: "test",
      updatedAt: "2026-09-17T00:00:00.000Z",
    }).catch((e) => e);
    // Not `false`: that is the answer for a fleet with no manifest at all, and
    // would send the operator looking for a fleet that is right there.
    expect(err).toBeInstanceOf(HermeticError);
    expect((err as HermeticError).code).toBe("MANIFEST_REFUSED");
  });
});

/**
 * §7.3's browser block. It is written by the mirror step and read by nobody in
 * `artifacts.ts`, which is exactly the shape of thing a later rewrite drops on
 * the floor — and dropping it leaves every `--browser` agent with no build to
 * install, with no error anywhere on the laptop.
 */
describe("the browser block in the fleet manifest", () => {
  const target = (backend: MemoryBackend) => ({
    fleet: backend.fleetItem!,
    stack: backend.stack,
    updatedBy: "test",
    updatedAt: new Date().toISOString(),
  });

  test("a push records what the mirror step returned", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const ref = "154.0.1.2";
    await publishRelease(
      {
        artifacts: backend.artifacts,
        hermeticVersion: FIXTURE_HERMETICD_VERSION,
        fixture: true,
        mirrorBrowser: (existing) =>
          fixtureBrowserMirror(backend.artifacts, { chrome_ref: ref, existing }),
      },
      {},
      target(backend),
    );
    const after = await readFleetManifest(backend.artifacts);
    expect(after?.browser?.[ref]?.key).toBe(browserBuildKey(ref));
    expect(after?.browser?.[ref]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(after?.browser?.[ref]?.url).toContain(ref);
  });

  test("a push with no mirror step carries the published block over untouched", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const before = await readFleetManifest(backend.artifacts);
    // The fixture's `main` is on the current foundation, so it is seeded with a
    // mirrored build; a push that rebuilt the manifest without it would delete
    // the browser as a side effect of shipping a hermeticd.
    expect(before?.browser?.[FIXTURE_CHROME_REF]).toBeDefined();

    await publishRelease(
      { artifacts: backend.artifacts, hermeticVersion: FIXTURE_HERMETICD_VERSION, fixture: true },
      {},
      target(backend),
    );
    const after = await readFleetManifest(backend.artifacts);
    expect(after?.browser).toEqual(before?.browser);
  });

  test("a mirror that could not run is reported and changes nothing", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const result = await publishRelease(
      {
        artifacts: backend.artifacts,
        hermeticVersion: FIXTURE_HERMETICD_VERSION,
        fixture: true,
        mirrorBrowser: async (existing) => ({
          block: existing,
          status: "skipped",
          chrome_ref: FIXTURE_CHROME_REF,
          downloaded: false,
          warning: "cdn.playwright.dev is unreachable",
        }),
      },
      {},
      target(backend),
    );
    expect(result.browser_warning).toContain("unreachable");
    const after = await readFleetManifest(backend.artifacts);
    expect(after?.browser?.[FIXTURE_CHROME_REF]).toBeDefined();
  });

  test("a fleet below the browser gate is seeded with no browser at all", async () => {
    // A fleet below `BROWSER_FOUNDATION_VERSION` has a role that could not read
    // `browser/*` — a manifest naming a build there would describe a state no
    // real fleet can be in. The version is stated rather than borrowed from
    // `staging`, whose "one behind" stopped meaning "below the gate" when
    // `FOUNDATION_VERSION` moved past it for an unrelated reason.
    const backend = seedFixtureFoundation(new MemoryBackend(), {
      fleet: "staging",
      foundationVersion: BROWSER_FOUNDATION_VERSION - 1,
    });
    const manifest = await readFleetManifest(backend.artifacts);
    expect(manifest?.browser).toBeUndefined();
  });
});
