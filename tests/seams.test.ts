/**
 * The seams: every document the laptop *writes* and the box *reads*, asserted
 * from both ends at once.
 *
 * There are four, and each was already tested — on the writing side. Core had a
 * test that user-data carried `hostname`; hermeticd had a test that a stage
 * given `HERMETIC_HOSTNAME` used it. Nothing tested the join, so when
 * hermeticd's parse quietly dropped the field, both suites stayed green while
 * every v4 box came up wearing its v3 name. A seam is exactly where nobody's
 * unit test lives.
 *
 * The four:
 *
 *   user-data      cloud-init JSON → `parseUserData`   (`tests/user-data.test.ts`)
 *   fleet manifest `manifest.json` → `parseFleetManifest`
 *   agent config   a config bundle → `parseManifest`
 *   stage env      `stageEnv`      → `stages/*.sh`
 *
 * The shape of the assertion is the same each time: produce the document the way
 * production produces it (the real renderer, the real manifest builder) with
 * every optional branch populated, put it through the real serialisation, and
 * demand the far end still has all of it — field for field, not "it parsed".
 *
 * This file is at the root, so it may import core and agentd together — which no
 * package may do, and which is why these tests could not live in either.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createHash } from "node:crypto";

import { fleetManifestFrom, pushRelease } from "../packages/core/src/release/artifacts.ts";
import { MemoryBackend } from "../packages/core/src/backend/memory.ts";
import type { FleetManifestInput } from "../packages/core/src/release/artifacts.ts";
import type { FleetItem } from "../packages/core/src/schema/fleet.ts";
import { hermesBundleKey, isReleaseObjectKey } from "../packages/core/src/schema/fleet.ts";
import { HERMES_REPO_URL } from "../packages/core/src/release/hermes-mirror.ts";
import { Agent, PROVIDERS, PROVIDERS_LIST } from "../packages/core/src/schema/agent.ts";
import { HERMETIC_VERSION } from "../packages/core/src/version.ts";
import { HEARTBEAT_ATTRIBUTES } from "../packages/agentd/src/aws.ts";
import {
  AGENT_CAPABILITY_LIST,
  DEFAULT_PROVIDER_KEY_SLOT,
  providerKeyRefOf,
  providerKeySlot,
  requiredCapabilities,
} from "../packages/core/src/schema/manifest.ts";
import { HERMES_DASHBOARD_PORT, HERMES_PROXY_PORT } from "../packages/core/src/schema/hermes.ts";
import {
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  HERMES_LEGACY_DASHBOARD_UNIT,
} from "../packages/core/src/schema/hermes.ts";
import { renderAgentConfig } from "../packages/core/src/render/render.ts";
import type { RenderInput } from "../packages/core/src/render/render.ts";
import {
  NOVNC_WEB_ROOT,
  browserEnvPath,
  browserUnitsFor,
} from "../packages/core/src/render/render-browser.ts";
import { chromeBinaryPath } from "../packages/core/src/schema/browser.ts";

import { parseFleetManifest } from "../packages/agentd/src/fleet.ts";
import { browserUnit, cdpVersionUrl } from "../packages/agentd/src/browser-health.ts";
import {
  HERMES_REPO,
  HERMETIC_RENDERED_MARKER,
  PROVIDER_EXTRAS,
} from "../packages/agentd/src/apply/index.ts";
import { HERMETICD_CAPABILITIES, parseManifest } from "../packages/agentd/src/manifest.ts";
import { HERMES_HEALTH_URL } from "../packages/agentd/src/heartbeat.ts";
import { SECRET_SLOTS, isKnownSlot } from "../packages/agentd/src/main.ts";
import { releaseStages, stageEnv } from "../packages/agentd/src/stages.ts";
import type { StagesDeps } from "../packages/agentd/src/stages.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** JSON.stringify → JSON.parse: what actually happens to a document in S3. */
function overTheWire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

const FLEET: FleetItem = {
  fleet_id: "k7m2x9qa",
  fleet_name: "main",
  defaults: { size: "small", provider: "anthropic", volume_gib: 50, secrets: "none" },
  ubuntu_release: "noble",
  ami_id: "ami-0123456789abcdef0",
  min_hermetic_version: "0.1.0",
  foundation_version: 4,
  foundation_template_sha256: "b".repeat(64),
  tailnet: "tail0.ts.net",
  region: "us-east-1",
  bucket: "hermetic-k7m2x9qa-123456789012-us-east-1",
  stack_id: "arn:aws:cloudformation:us-east-1:123456789012:stack/hermetic-k7m2x9qa/abc",
  created_by: "arn:aws:sts::123456789012:assumed-role/Admin/session",
  created_at: "2026-09-01T00:00:00.000Z",
};

const INPUT: FleetManifestInput = {
  fleet: FLEET,
  hermeticd: {
    version: "0.5.0",
    /**
     * The field this test exists for. It was produced by `pushRelease`, was
     * *not* declared on the schema, and so was stripped on the way to the
     * bucket — leaving `releaseDrift` (which reads it to warn that the fleet's
     * bytes are older than this checkout) permanently unable to fire.
     */
    build: "c".repeat(64),
    files: {
      hermeticd: { key: "artifacts/0.5.0/hermeticd", sha256: "d".repeat(64), size: 100 },
      "stages/00-preflight.sh": {
        key: "artifacts/0.5.0/stages/00-preflight.sh",
        sha256: "e".repeat(64),
        size: 10,
      },
    },
  },
  stack: {
    stack_id: FLEET.stack_id,
    stack_name: "hermetic-k7m2x9qa",
    status: "CREATE_COMPLETE",
    tags: { "hermetic:fleet": "k7m2x9qa" },
    outputs: {
      BucketName: FLEET.bucket,
      AgentsTable: "hermetic-k7m2x9qa-agents",
      EventsTable: "hermetic-k7m2x9qa-events",
      VpcId: "vpc-0123456789abcdef0",
      SubnetIds: "subnet-1,subnet-2",
      SecurityGroupId: "sg-0123456789abcdef0",
      InstanceProfileArn: "arn:aws:iam::123456789012:instance-profile/hermetic",
      RoleArn: "arn:aws:iam::123456789012:role/hermetic",
    },
    parameters: { FleetId: "k7m2x9qa", Network: "public" },
  },
  foundation: {
    version: 4,
    template_sha256: "b".repeat(64),
    applied_at: "2026-09-02T00:00:00.000Z",
    applied_by: "arn:aws:sts::123456789012:assumed-role/Admin/session",
  },
  /**
   * Two refs, because a fleet mid-`upgrade --hermes` is on two at once (§6.5)
   * and the box has to be able to read the one *it* is pinned to, not merely
   * the newest.
   */
  hermes: {
    "v2026.8.31": {
      key: "hermes/v2026.8.31.bundle",
      sha256: "1".repeat(64),
      size: 4_194_304,
      upstream_sha: "2".repeat(40),
    },
    "v2026.9.4": {
      key: "hermes/v2026.9.4.bundle",
      sha256: "3".repeat(64),
      size: 4_194_500,
      upstream_sha: "4".repeat(40),
    },
  },
  updatedAt: "2026-09-02T00:00:00.000Z",
  updatedBy: "arn:aws:sts::123456789012:assumed-role/Admin/session",
};

describe("seam: the fleet manifest core writes is the one hermeticd reads", () => {
  /**
   * `hermetic_version` against what the schema says it is: "The laptop build
   * that wrote this file, for support questions."
   *
   * It held the wrong number for as long as it existed. Every one of the five
   * manifest writers threaded `BUILD_VERSIONS.hermeticd` into it, so the field
   * whose entire purpose is telling two tool checkouts apart could only ever
   * carry the release version — identical across every checkout that pushed it.
   * Nothing read it, so nothing complained.
   *
   * A seam test rather than a unit one because this field is parsed at boot by
   * every already-deployed hermeticd (`FleetManifest` requires it), so what goes
   * in it is a contract with the fleet, not an implementation detail.
   */
  test("hermetic_version is the tool build, not the hermeticd release", () => {
    const written = fleetManifestFrom(INPUT);
    expect(written.hermetic_version).toBe(HERMETIC_VERSION);
    // The two are different numbers in this repo, which is exactly why the
    // conflation was invisible: one field, two plausible values.
    expect(written.hermetic_version).not.toBe(written.hermeticd.version);
    expect(written.hermeticd.version).toBe(INPUT.hermeticd.version);
  });

  test("every field survives the round trip to the box", () => {
    const written = fleetManifestFrom(INPUT);
    const read = parseFleetManifest(JSON.stringify(written));
    expect(read).toEqual(written);
  });

  /**
   * Named rather than covered by the deep-equal above, because this is the one
   * that was actually lost, and a deep-equal passes just as happily when both
   * sides agree on having dropped it.
   */
  test("the build fingerprint reaches the box", () => {
    const read = parseFleetManifest(JSON.stringify(fleetManifestFrom(INPUT)));
    expect(read.hermeticd.build).toBe(INPUT.hermeticd.build);
    expect(read.foundation?.version).toBe(4);
    expect(read.name).toBe("main");
    expect(read.fleet_id).toBe("k7m2x9qa");
  });

  /**
   * §3.6: the box installs Hermes from the bundle this block names, verified
   * against this digest. A key or a digest lost on the way would not fail here
   * — it would fail as a `CHECKSUM_MISMATCH` on a first boot, or as a silent
   * fall back to cloning github.com, which is the outage this exists to fix.
   */
  test("the hermes mirror reaches the box, every ref of it", () => {
    const read = parseFleetManifest(JSON.stringify(fleetManifestFrom(INPUT)));
    expect(Object.keys(read.hermes ?? {})).toEqual(["v2026.8.31", "v2026.9.4"]);
    for (const [ref, entry] of Object.entries(read.hermes ?? {})) {
      expect(entry).toEqual(INPUT.hermes![ref]!);
      expect(entry.key).toBe(hermesBundleKey(ref));
    }
  });

  /**
   * The laptop mirrors one repository and the box falls back to another would
   * be invisible until the fallback ran — which is exactly when nobody is
   * watching. One constant each, held equal here.
   */
  test("the repository the laptop mirrors is the one the box would clone", () => {
    expect(HERMES_REPO_URL).toBe(HERMES_REPO);
  });

  /**
   * The box reads its table names and its SSM prefix out of this document. A
   * resources block that lost a key would not fail here — it would fail eight
   * minutes into a first boot, as a DynamoDB call against `undefined`.
   */
  test("the resources block the box boots from is complete", () => {
    const read = parseFleetManifest(JSON.stringify(fleetManifestFrom(INPUT)));
    for (const [key, value] of Object.entries(read.resources)) {
      expect({ key, empty: Array.isArray(value) ? value.length === 0 : value === "" }).toEqual({
        key,
        empty: false,
      });
    }
  });
});

/**
 * The release seam: the keys `pushRelease` writes, recorded in the manifest,
 * are the keys hermeticd fetches — and nothing else is.
 *
 * It is a seam and not a unit test on either side because the defect it exists
 * for lived precisely in the join. Core wrote a release to
 * `artifacts/<version>/…` and the box *rebuilt* that path from the version
 * label instead of reading the manifest. Both halves were self-consistent and
 * both suites were green; the agreement was a coincidence that held only while
 * a version named exactly one set of bytes. The moment releases became
 * immutable generations, a box that rebuilt the key fetched a path the fleet
 * was no longer pointing at, and checked what it found against a digest
 * recorded for some other push.
 */
describe("seam: the release keys core publishes are the ones hermeticd fetches", () => {
  const files = (stages: readonly string[], binary: string) => [
    {
      name: "hermeticd",
      bytes: new TextEncoder().encode(binary),
      contentType: "application/octet-stream",
    },
    ...stages.map((name) => ({
      name: `stages/${name}`,
      bytes: new TextEncoder().encode(`#!/usr/bin/env bash\n# ${name}\n`),
      contentType: "text/x-shellscript",
    })),
  ];

  async function published(binary = "ELF"): Promise<{
    backend: MemoryBackend;
    manifest: ReturnType<typeof parseFleetManifest>;
  }> {
    const backend = new MemoryBackend();
    const hermeticd = await pushRelease(backend.artifacts, {
      version: "0.5.0",
      files: files(["00-preflight.sh", "01-tailscale.sh"], binary),
      now: "2026-09-16T00:00:00.000Z",
    });
    const manifest = parseFleetManifest(JSON.stringify(fleetManifestFrom({ ...INPUT, hermeticd })));
    return { backend, manifest };
  }

  test("every stage key the box resolves is an object the push wrote", async () => {
    const { backend, manifest } = await published();
    for (const stage of releaseStages(manifest)) {
      expect(manifest.hermeticd.files[`stages/${stage.file}`]!.key).toBe(stage.key);
      expect(backend.objects.has(stage.key)).toBe(true);
      // And the bytes at that key really are the ones the digest names.
      const bytes = backend.objects.get(stage.key)!;
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(stage.sha256);
    }
  });

  /**
   * The keys carry the generation, so the path a box would have rebuilt from
   * the version label is not an object at all. Asserted as *absent* rather than
   * merely different: "the box looks somewhere else now" is the whole fix.
   */
  test("the flat per-version path a rebuilt key would name holds nothing", async () => {
    const { backend, manifest } = await published();
    expect(manifest.hermeticd.generation).toMatch(/^[0-9a-f]{16}$/);
    expect(backend.objects.has("artifacts/0.5.0/hermeticd")).toBe(false);
    expect(backend.objects.has("artifacts/0.5.0/stages/00-preflight.sh")).toBe(false);
    for (const key of Object.values(manifest.hermeticd.files).map((f) => f.key)) {
      expect(key.startsWith(`artifacts/0.5.0/${manifest.hermeticd.generation}/`)).toBe(true);
    }
  });

  /**
   * A consumer resolves only what the manifest records. The box has
   * `GetObject` on `config/*` and `hermes/*` as well, so a manifest naming one
   * of those for a stage would have hermeticd run somebody's config tarball as
   * root — `isReleaseObjectKey` is core's rule and the box applies core's rule,
   * rather than a second spelling of it.
   */
  test("a manifest naming a key outside the release prefix is refused, not fetched", async () => {
    const { manifest } = await published();
    const tampered = {
      ...manifest,
      hermeticd: {
        ...manifest.hermeticd,
        files: {
          ...manifest.hermeticd.files,
          "stages/00-preflight.sh": {
            ...manifest.hermeticd.files["stages/00-preflight.sh"]!,
            key: "config/research-1/abc.tgz",
          },
        },
      },
    };
    expect(isReleaseObjectKey("config/research-1/abc.tgz", "0.5.0")).toBe(false);
    expect(() => releaseStages(tampered)).toThrow(/not an object of that release/);
  });

  /**
   * The same rule, one turn tighter: a key that *is* a release object, but of
   * another release. Scoping to the version the manifest claims is what stops a
   * manifest saying "the fleet is on 0.5.0" while handing the box 0.1.0's
   * stages — two releases described at once, and the box running neither of
   * them knowingly.
   */
  test("a manifest naming another release's objects is refused, not fetched", async () => {
    const { manifest } = await published();
    const stolen = "artifacts/0.1.0/deadbeefdeadbeef/stages/00-preflight.sh";
    const tampered = {
      ...manifest,
      hermeticd: {
        ...manifest.hermeticd,
        files: {
          ...manifest.hermeticd.files,
          "stages/00-preflight.sh": {
            ...manifest.hermeticd.files["stages/00-preflight.sh"]!,
            key: stolen,
          },
        },
      },
    };
    expect(isReleaseObjectKey(stolen, "0.1.0")).toBe(true);
    expect(isReleaseObjectKey(stolen, "0.5.0")).toBe(false);
    expect(() => releaseStages(tampered)).toThrow(/not an object of that release/);
  });

  /**
   * Two pushes of one version are two generations, and the first one's objects
   * are never written to again — which is what lets a manifest, and a bootstrap
   * URL presigned from it, keep meaning what it meant.
   */
  test("a same-version republish with different bytes lands beside the first", async () => {
    const first = await published("ELF-one");
    const second = await pushRelease(first.backend.artifacts, {
      version: "0.5.0",
      files: files(["00-preflight.sh", "01-tailscale.sh"], "ELF-two"),
      now: "2026-09-16T01:00:00.000Z",
    });
    expect(second.generation).not.toBe(first.manifest.hermeticd.generation);
    for (const [name, entry] of Object.entries(first.manifest.hermeticd.files)) {
      expect(second.files[name]!.key).not.toBe(entry.key);
      const bytes = first.backend.objects.get(entry.key)!;
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
  });
});

/** The pinned Chrome for Testing build a browser agent runs (`BUILD_VERSIONS`). */
const CHROME_REF = "153.0.8010.12";

describe("seam: the agent config core renders is the one hermeticd applies", () => {
  /**
   * The *real* renderer, not a hand-built stand-in. A literal here would be a
   * fifth copy of the shape and would drift the same way everything else in this
   * file drifted; what matters is that the document `agents.create` actually
   * uploads is one hermeticd accepts whole.
   */
  const rendered = renderAgentConfig({
    name: "atlas",
    size: "small",
    provider: "anthropic",
    secrets_mode: "none",
    hermes_version: "0.21.1",
    hermes_ref: "v2026.8.31",
    chrome_ref: CHROME_REF,
    region: "us-east-1",
    tailnet: "tail0.ts.net",
    hermes: { model: "claude-sonnet-5" },
  } as unknown as RenderInput);

  test("every field survives the round trip to the box", () => {
    const read = parseManifest(overTheWire(rendered.manifest));
    expect(read).toEqual(rendered.manifest);
  });

  /**
   * A rendered document with a browser, secrets and Hermes settings exercises
   * every optional branch of the shape; empty arrays where the schema allows
   * them would make the deep-equal above pass on a manifest that says nothing.
   */
  test("the document is not vacuously small", () => {
    const read = parseManifest(overTheWire(rendered.manifest));
    expect(read.files.length).toBeGreaterThan(3);
    expect(read.units.length).toBeGreaterThan(0);
    expect(read.tailscale_serve.routes.length).toBeGreaterThan(0);
  });

  /**
   * `restart_units` is the newest field on a rendered file and the one with the
   * quietest failure: a box that dropped it would apply the file and never
   * restart the unit that reads it, so the config is on disk and not in effect.
   */
  /**
   * The rule that keeps a release honest: whatever this checkout's renderer asks
   * of a box, this checkout's hermeticd must be able to do. A commit that starts
   * requiring `gateway-unit` and forgets to implement it would ship a config no
   * box can apply — the failure is then not a bug on either side, but a gap
   * between them, which is the kind this file exists to catch.
   */
  test("hermeticd implements every capability the renderer asks for", () => {
    const asked = requiredCapabilities(rendered.manifest);
    expect(asked.length).toBeGreaterThan(0);
    const unimplemented = asked.filter((c) => !HERMETICD_CAPABILITIES.has(c));
    expect(unimplemented).toEqual([]);
    // …and the document actually carries them, rather than deriving them twice.
    expect([...(rendered.manifest.requires ?? [])].sort()).toEqual([...asked].sort());
  });

  /**
   * Every capability hermeticd claims must be one core has a name for. A box
   * advertising a capability the vocabulary does not contain can never be asked
   * for it, which makes the claim a lie an operator could rely on.
   */
  test("hermeticd claims no capability core has never heard of", () => {
    const known = new Set(AGENT_CAPABILITY_LIST);
    expect([...HERMETICD_CAPABILITIES].filter((c) => !known.has(c))).toEqual([]);
  });

  /**
   * The approvals mode is the one Hermes setting the manifest carries, and it is
   * there purely so `verify-hermes` has an expectation to check (`hermes-check.ts`).
   * A box that read it back as `undefined` would skip the check silently — the
   * agent's approvals gate could then sit anywhere and nothing would say so.
   */
  test("the approvals mode core states survives the round trip", () => {
    const read = parseManifest(overTheWire(rendered.manifest));
    expect(read.approvals_mode).toBe(rendered.manifest.approvals_mode);
    // And it is stated, not merely equal by both ends being absent.
    expect(read.approvals_mode).toBe("off");
  });

  test("a rendered file keeps the units it says it feeds", () => {
    const read = parseManifest(overTheWire(rendered.manifest));
    const withUnits = read.files.filter((f) => (f.restart_units?.length ?? 0) > 0);
    expect(withUnits.length).toBeGreaterThan(0);
    for (const file of withUnits) {
      const source = rendered.manifest.files.find((f) => f.path === file.path);
      expect({ path: file.path, units: file.restart_units }).toEqual({
        path: file.path,
        units: source?.restart_units,
      });
    }
  });
});

/**
 * §8.3's newest seam, and the one with the quietest failure mode.
 *
 * A provider profile's key is snapshotted into an instance slot named for the
 * profile and the revision it was bound at (`provider-key-<profile_id>-r<N>`),
 * and the *only* thing that
 * tells the box to read that slot rather than the fixed `provider-key` it has
 * always read is one optional field on the rendered manifest. If core emitted a
 * spelling hermeticd's slot guard rejected, or hermeticd fell back to the old
 * slot without saying so, a rotated key would land in SSM, every laptop-side
 * reading would report it as applied, and the box would go on serving with the
 * previous credential — successfully, which is what makes it quiet.
 *
 * So both ends are asserted from one place: the string core writes, the string
 * hermeticd resolves, the slot names hermeticd will accept at all, and the
 * capability that stops an older box being handed a document it would
 * misinterpret.
 */
describe("seam: the provider-key slot core names is the one hermeticd reads", () => {
  /** Two real-shaped profile ids, both at revision 1 — the collision that was. */
  const PROFILE_A = "ant00001";
  const PROFILE_B = "rtr00002";

  const render = (provider_key_ref?: string) =>
    renderAgentConfig({
      name: "atlas",
      size: "small",
      provider: "anthropic",
      secrets_mode: "none",
      hermes_version: "0.21.1",
      hermes_ref: "v2026.8.31",
      chrome_ref: CHROME_REF,
      region: "us-east-1",
      tailnet: "tail0.ts.net",
      ...(provider_key_ref === undefined ? {} : { provider_key_ref }),
    } as unknown as RenderInput);

  const legacy = render(undefined);

  test("a revision slot survives the wire, and the box resolves the same string", () => {
    const rendered = render(providerKeySlot(PROFILE_A, 3));
    expect(rendered.manifest.provider_key_ref).toBe("provider-key-ant00001-r3");

    const read = parseManifest(overTheWire(rendered.manifest));
    expect(read.provider_key_ref).toBe("provider-key-ant00001-r3");
    // The box's own resolution, not the field: this is the string that becomes
    // an SSM path, and hermeticd's slot guard has to admit it.
    expect(providerKeyRefOf(read)).toBe("provider-key-ant00001-r3");
    expect(isKnownSlot(providerKeyRefOf(read))).toBe(true);
  });

  /**
   * A document naming any other slot asks for the capability, and this
   * checkout's hermeticd claims it — the release rule the whole capability
   * vocabulary exists for, applied to the field that needs it most.
   */
  test("a revision slot asks for the capability, and hermeticd advertises it", () => {
    const rendered = render(providerKeySlot(PROFILE_A, 2));
    expect(requiredCapabilities(rendered.manifest)).toContain("provider-key-ref");
    expect([...(rendered.manifest.requires ?? [])]).toContain("provider-key-ref");
    expect(HERMETICD_CAPABILITIES.has("provider-key-ref")).toBe(true);
    expect(AGENT_CAPABILITY_LIST).toContain("provider-key-ref");
  });

  /**
   * Absent means `provider-key`, on both ends. Every manifest written before
   * profiles says nothing, and every box that has not been re-applied since
   * still holds one — so "says nothing" has to mean the old slot rather than no
   * slot, or a legacy agent's key would stop being materialised.
   */
  test("absent means `provider-key` at both ends, and asks for nothing", () => {
    expect(legacy.manifest.provider_key_ref).toBeUndefined();
    const read = parseManifest(overTheWire(legacy.manifest));
    expect(providerKeyRefOf(read)).toBe(DEFAULT_PROVIDER_KEY_SLOT);
    expect(isKnownSlot(DEFAULT_PROVIDER_KEY_SLOT)).toBe(true);
    // An older box, which has never heard of the field, is asked for nothing.
    expect(requiredCapabilities(legacy.manifest)).not.toContain("provider-key-ref");
  });

  /**
   * The decision the field's doc comment records: it is **omitted** when it is
   * the slot every hermeticd already reads. Emitting `provider-key` on every
   * document would have re-hashed every agent config in every fleet on the day
   * it landed, reporting fleet-wide drift for a statement rather than a change.
   */
  test("stating the legacy slot explicitly renders the same document, hash included", () => {
    const explicit = render(DEFAULT_PROVIDER_KEY_SLOT);
    expect(explicit.manifest.provider_key_ref).toBeUndefined();
    expect(explicit.manifest.config_hash).toBe(legacy.manifest.config_hash);
  });

  /**
   * And the other half of that decision: the field *is* in `config_hash`, which
   * is what makes a key rotation something a rollout can carry. A rotation
   * changes nothing else about the document, so a hash that did not move would
   * be a change no converge could deliver.
   */
  test("moving the slot moves the hash, which is how a rotation reaches a box", () => {
    const r2 = render(providerKeySlot(PROFILE_A, 2)).manifest.config_hash;
    const r3 = render(providerKeySlot(PROFILE_A, 3)).manifest.config_hash;
    expect(r2).not.toBe(legacy.manifest.config_hash);
    expect(r3).not.toBe(r2);
  });

  /**
   * The profile is in the slot name, not only the revision — the seam's other
   * collision, and the one a revision-only name got wrong. Every profile's
   * revisions start at 1, so two profiles at r1 would otherwise name one slot:
   * an agent bound to A r1 and staged onto B r1 would have its staged key
   * written into the slot its running configuration reads, which is the single
   * thing the snapshot scheme exists to prevent. Two slots, two hashes.
   */
  test("two profiles at the same revision are two slots, and two documents", () => {
    expect(providerKeySlot(PROFILE_A, 1)).not.toBe(providerKeySlot(PROFILE_B, 1));
    expect(isKnownSlot(providerKeySlot(PROFILE_B, 1))).toBe(true);
    expect(render(providerKeySlot(PROFILE_A, 1)).manifest.config_hash).not.toBe(
      render(providerKeySlot(PROFILE_B, 1)).manifest.config_hash,
    );
  });

  /**
   * A manifest is a document, not an authorisation. The string becomes an SSM
   * path on the box, so anything that is not a provider-key slot is refused by
   * both ends rather than trusted — core declines to emit it, hermeticd's
   * resolver falls back, and its slot guard says no.
   */
  test("a value that is not a provider-key slot is trusted by neither end", () => {
    const hostile = "../../../hermetic/fxtr0001/secrets/profile-ant00001";
    expect(render(hostile).manifest.provider_key_ref).toBeUndefined();
    expect(providerKeyRefOf({ provider_key_ref: hostile })).toBe(DEFAULT_PROVIDER_KEY_SLOT);
    expect(isKnownSlot(hostile)).toBe(false);
    // A revision is a positive integer: `r0` and `r01` are not slots either.
    expect(isKnownSlot(`provider-key-${PROFILE_A}-r0`)).toBe(false);
    expect(isKnownSlot(`provider-key-${PROFILE_A}-r01`)).toBe(false);
    // And the profile id is the 8 characters `ProfileId` mints, not anything:
    // the revision-only spelling this slot used to have is not a slot at all.
    expect(isKnownSlot("provider-key-r1")).toBe(false);
    expect(isKnownSlot("provider-key-../../fleet-r1")).toBe(false);
  });

  /**
   * The base slot is one string, not two. hermeticd's fixed list and core's
   * constant have to agree, or `hermeticd stage secret --slot provider-key`
   * would name a slot no manifest ever points at.
   */
  test("the legacy slot hermeticd stages by hand is the one core falls back to", () => {
    expect([...SECRET_SLOTS]).toContain(DEFAULT_PROVIDER_KEY_SLOT);
    for (const slot of SECRET_SLOTS) expect(isKnownSlot(slot)).toBe(true);
  });
});

/**
 * Every provider, through the same seam. The document one provider renders is
 * the one the box applies, and the rendered file's whole job is to name the
 * provider Hermes knows it by and the environment variable its key arrives in —
 * two strings that live in core's `PROVIDERS` and are read on the box by
 * `hermeticd`'s own copy of that table.
 *
 * One case per provider rather than one for `anthropic`, because the two ways
 * this can be wrong are per-provider: a declared endpoint where a built-in was
 * meant (the Nous trap), and a key variable hermeticd does not materialise.
 */
describe("seam: every provider renders a document the box can apply", () => {
  for (const provider of PROVIDERS_LIST) {
    const rendered = renderAgentConfig({
      name: "atlas",
      size: "small",
      provider,
      secrets_mode: "none",
      hermes_version: "0.21.1",
      hermes_ref: "v2026.8.31",
      chrome_ref: CHROME_REF,
      region: "us-east-1",
      tailnet: "tail0.ts.net",
    } as unknown as RenderInput);

    test(`${provider}: the manifest survives the round trip`, () => {
      expect(parseManifest(overTheWire(rendered.manifest))).toEqual(rendered.manifest);
    });

    test(`${provider}: hermeticd implements every capability the document asks for`, () => {
      const unimplemented = requiredCapabilities(rendered.manifest).filter(
        (c) => !HERMETICD_CAPABILITIES.has(c),
      );
      expect(unimplemented).toEqual([]);
    });

    test(`${provider}: the rendered config names the provider Hermes knows`, () => {
      const spec = PROVIDERS[provider];
      const yaml =
        rendered.manifest.files.find((f) => f.path === "/etc/hermes/config.yaml")?.content ?? "";
      expect(yaml).toContain(`provider: "${spec.hermes_provider}"`);
      // A declared endpoint only where the catalog says one is needed; every
      // other provider is a Hermes built-in and must not be shadowed by one.
      expect(yaml.includes("providers:")).toBe(spec.hermes_provider_entry);
      if (spec.hermes_provider_entry) {
        expect(yaml).toContain(`key_env: "${String(spec.env)}"`);
      }
    });

    /**
     * `PROVIDER_EXTRAS` in `apply.ts` is hermeticd's own per-provider table —
     * which pip extra the Hermes venv is installed with. A provider missing
     * from it is a box that installs the wrong venv, and a `role` provider
     * whose extra were null would install a Hermes that cannot reach Bedrock.
     */
    test(`${provider}: hermeticd knows which Hermes extra to install for it`, () => {
      expect(Object.keys(PROVIDER_EXTRAS)).toContain(provider);
      if (PROVIDERS[provider].auth === "role") {
        expect(PROVIDER_EXTRAS[provider]).not.toBeNull();
      }
    });
  }
});

/**
 * The two loopback ports are one contract with five spellings across two
 * packages: the dashboard binds one, nginx listens on the other and proxies to
 * the first, Serve is pointed at nginx, and hermeticd probes the dashboard. Each
 * pair only works when both halves agree, and until they were hoisted into
 * `schema/hermes.ts` nothing checked that they did — moving a port was a
 * cross-package edit with no test between the two sides.
 */
describe("seam: the ports the box listens on are one contract", () => {
  const rendered = renderAgentConfig({
    name: "atlas",
    size: "small",
    provider: "anthropic",
    secrets_mode: "none",
    hermes_version: "0.21.1",
    hermes_ref: "v2026.8.31",
    chrome_ref: CHROME_REF,
    region: "us-east-1",
    tailnet: "tail0.ts.net",
  } as unknown as RenderInput);

  const fileAt = (path: string) => rendered.manifest.files.find((f) => f.path === path)?.content ?? "";

  test("nginx proxies to the port the dashboard unit binds", () => {
    const unit = fileAt("/etc/systemd/system/hermes-dashboard.service");
    const nginx = fileAt("/etc/nginx/nginx.conf");
    expect(unit).toContain(`--port ${String(HERMES_DASHBOARD_PORT)}`);
    expect(nginx).toContain(`proxy_pass http://127.0.0.1:${String(HERMES_DASHBOARD_PORT)};`);
    // …and rewrites both headers to that same port, which is what keeps Hermes
    // in local mode rather than answering `Invalid Host header`.
    expect(nginx).toContain(`proxy_set_header Host 127.0.0.1:${String(HERMES_DASHBOARD_PORT)};`);
    expect(nginx).toContain(
      `proxy_set_header Origin http://127.0.0.1:${String(HERMES_DASHBOARD_PORT)};`,
    );
  });

  test("Serve is pointed at the port nginx listens on", () => {
    const nginx = fileAt("/etc/nginx/nginx.conf");
    expect(nginx).toContain(`listen 127.0.0.1:${String(HERMES_PROXY_PORT)};`);
    const root = rendered.manifest.tailscale_serve.routes.find((r) => r.path === "/");
    expect(root?.target).toBe(`http://127.0.0.1:${String(HERMES_PROXY_PORT)}`);
  });

  /**
   * The box's own health probe. It checks the dashboard directly rather than
   * through the proxy, so it must use the dashboard's port — a probe pointed at
   * nginx would report the proxy healthy and say nothing about Hermes.
   */
  test("hermeticd probes the dashboard on the port the dashboard binds", () => {
    expect(HERMES_HEALTH_URL).toBe(`http://127.0.0.1:${String(HERMES_DASHBOARD_PORT)}/api/health`);
  });

  test("the two ports are not the same port", () => {
    expect(HERMES_DASHBOARD_PORT).not.toBe(HERMES_PROXY_PORT);
  });
});

/**
 * The dashboard unit's name is written down in four places that have to agree:
 * core renders the file, hermeticd's manifest enables it, `06-verify.sh` waits
 * for it by name in a shell script no test executes, and the apply that
 * installs it removes the file hermetic used to render under the *old* name —
 * which it will only do when the content identifies that file as hermetic's.
 *
 * The removal is the half with teeth. A marker string that stopped matching
 * would turn "remove the superseded unit" into a silent no-op, and the failure
 * is a box quietly running two dashboards against one `$HERMES_HOME`, which is
 * exactly the state the removal exists to prevent.
 */
describe("seam: the dashboard unit is named once", () => {
  const rendered = renderAgentConfig({
    name: "atlas",
    size: "small",
    provider: "anthropic",
    secrets_mode: "none",
    hermes_version: "0.21.1",
    hermes_ref: "v2026.8.31",
    chrome_ref: CHROME_REF,
    region: "us-east-1",
    tailnet: "tail0.ts.net",
  } as unknown as RenderInput);

  test("core renders the unit at the name the manifest enables", () => {
    const path = `/etc/systemd/system/${HERMES_DASHBOARD_UNIT}`;
    expect(rendered.manifest.files.map((f) => f.path)).toContain(path);
    expect(rendered.manifest.units).toContain(HERMES_DASHBOARD_UNIT);
  });

  test("the rendered unit carries the marker hermeticd requires before removing one", () => {
    const unit = rendered.manifest.files.find(
      (f) => f.path === `/etc/systemd/system/${HERMES_DASHBOARD_UNIT}`,
    );
    expect(unit?.content).toContain(HERMETIC_RENDERED_MARKER);
  });

  test("the name hermeticd removes is not the name it installs", () => {
    expect(HERMES_LEGACY_DASHBOARD_UNIT).not.toBe(HERMES_DASHBOARD_UNIT);
    expect(rendered.manifest.units).not.toContain(HERMES_LEGACY_DASHBOARD_UNIT);
  });

  /**
   * `06-verify.sh` is shell: it is shellchecked and never executed by the
   * suite, so the unit names in it are only as correct as this assertion.
   */
  test("the last stage waits on the units the manifest names", () => {
    const verify = readFileSync(join(ROOT, "packages/agentd/stages/06-verify.sh"), "utf8");
    const waited = /for unit in ([^;]+); do/.exec(verify)?.[1]?.trim().split(/\s+/) ?? [];
    expect(waited).toEqual([HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT]);
  });
});

describe("seam: the stage environment the runner sets is the one the stages read", () => {
  const STAGES_DIR = join(ROOT, "packages/agentd/stages");

  const DEPS = {
    name: "atlas",
    hostname: "k7m2x9qa-atlas",
    region: "us-east-1",
    bucket: "hermetic-k7m2x9qa-123456789012-us-east-1",
    paramPrefix: "/hermes/k7m2x9qa/atlas/",
  } as unknown as StagesDeps;

  /** Every `HERMETIC_*` a shipped stage actually reads. */
  function referenced(): Set<string> {
    const names = new Set<string>();
    for (const file of readdirSync(STAGES_DIR).filter((f) => f.endsWith(".sh"))) {
      const body = readFileSync(join(STAGES_DIR, file), "utf8");
      for (const m of body.matchAll(/HERMETIC_[A-Z0-9_]+/g)) names.add(m[0]);
    }
    return names;
  }

  /**
   * The direction that bites: a stage reading a variable the runner does not
   * set gets the empty string under `set -u`… or worse, a silent fallback. This
   * is how `01-tailscale.sh` would have failed loudly rather than quietly if
   * `HERMETIC_HOSTNAME` had never been passed at all — instead of falling back
   * to `$HERMETIC_NAME`, which is exactly what it is written to do.
   */
  test("every HERMETIC_* a stage reads is one the runner sets", () => {
    const provided = new Set(Object.keys(stageEnv(DEPS, "01-tailscale")));
    // `HERMETICD` is the binary path, also part of the contract.
    provided.add("HERMETICD");
    const missing = [...referenced()].filter((name) => !provided.has(name)).sort();
    expect(missing).toEqual([]);
  });

  test("the runner's own contract is not vacuous", () => {
    const env = stageEnv(DEPS, "01-tailscale");
    expect(env["HERMETIC_HOSTNAME"]).toBe("k7m2x9qa-atlas");
    expect(env["HERMETIC_NAME"]).toBe("atlas");
    expect(referenced().size).toBeGreaterThan(3);
  });

  /**
   * And the fallback itself, which is what a pre-v3 box depends on: no hostname
   * means the agent name, not an empty string that would name a node "".
   */
  test("a box with no hostname is named for its agent", () => {
    const { hostname: _omitted, ...older } = DEPS as unknown as Record<string, unknown>;
    const env = stageEnv(older as unknown as StagesDeps, "01-tailscale");
    expect(env["HERMETIC_HOSTNAME"]).toBe("atlas");
  });
});

/**
 * The heartbeat's attribute names against the row they are written to.
 *
 * This is the seam the file exists for, in its purest form: `packages/agentd`
 * names DynamoDB attributes as bare strings in an `UpdateExpression`, and
 * `packages/core` describes the same row as a Zod schema. Nothing connects the
 * two at compile time, and a mismatch is silent in the worst way — the update
 * succeeds, a brand-new attribute appears on the item, the schema keeps parsing
 * because the real field is merely absent, and that field stops moving forever.
 *
 * No package may import both sides, so the check lives here.
 */
describe("the heartbeat writes attributes the agent row declares", () => {
  const rowKeys = new Set(Object.keys(Agent.shape));

  test("every attribute the heartbeat sets is a field of Agent", () => {
    const unknown = Object.entries(HEARTBEAT_ATTRIBUTES)
      .filter(([, attribute]) => !rowKeys.has(attribute))
      .map(([placeholder, attribute]) => `${placeholder} → ${attribute}`)
      .sort();
    expect(unknown).toEqual([]);
  });

  test("the two fields the box alone writes are both on the row", () => {
    // Named explicitly rather than left to the sweep above: these are the only
    // two facts the fleet has that a box reports about *itself* rather than
    // being told, and each one exists because the laptop-written field beside it
    // could not answer the question (`applied_config_hash` vs `config_hash`,
    // `running_hermeticd_sha256` vs `hermeticd_version`).
    expect(rowKeys.has("applied_config_hash")).toBe(true);
    expect(rowKeys.has("running_hermeticd_sha256")).toBe(true);
  });

  test("the table is not vacuous", () => {
    expect(Object.keys(HEARTBEAT_ATTRIBUTES).length).toBeGreaterThan(5);
    for (const placeholder of Object.keys(HEARTBEAT_ATTRIBUTES)) {
      expect(placeholder.startsWith("#")).toBe(true);
    }
  });
});

/**
 * The browser stack: what the laptop renders is what the box watches.
 *
 * Two files spell the same unit name. `render-browser.ts` names
 * `hermetic-browser@<name>.service` (and its four supporting units) when it
 * builds a `browser: true` agent's manifest; `browser-health.ts`'s `browserUnit`
 * spells the same name by hand, because agentd may import only
 * `@hermetic/core/schema` and the render layer is off limits to it. Nothing
 * type-checks the two spellings against each other, and a drift would not fail
 * loudly — `GET /healthz` would just ask systemd about a unit that was never
 * installed and report the browser down forever. The CDP port, the env file's
 * `CDP_PORT` and the Serve route's target are the same shape of seam: one
 * number chosen once by `browserIdentities`, written in three places, read
 * apart.
 */
describe("seam: the browser stack: what the laptop renders is what the box watches", () => {
  const rendered = renderAgentConfig({
    name: "atlas",
    size: "small",
    provider: "anthropic",
    secrets_mode: "none",
    hermes_version: "0.21.1",
    hermes_ref: "v2026.8.31",
    chrome_ref: CHROME_REF,
    region: "us-east-1",
    tailnet: "tail0.ts.net",
  } as unknown as RenderInput);

  const manifest = rendered.manifest;
  const identities = manifest.browsers ?? [];

  const fileAt = (path: string) => manifest.files.find((f) => f.path === path)?.content ?? "";

  test("the manifest actually carries a browser identity", () => {
    expect(identities.length).toBeGreaterThan(0);
  });

  test("every identity's unit is the one hermeticd's browserUnit names", () => {
    for (const identity of identities) {
      expect(manifest.units).toContain(browserUnit(identity.name));
      // …and it is exactly one of the five units the render layer installs for
      // that identity, in the order the box brings them up.
      expect(browserUnitsFor(identity)).toContain(browserUnit(identity.name));
    }
  });

  test("the Chrome unit's ExecStart names the path agentd's unzip verifies", () => {
    const unit = fileAt("/etc/systemd/system/hermetic-browser@.service");
    const path = chromeBinaryPath(manifest.chrome_ref ?? "");
    expect(manifest.chrome_ref).toBeDefined();
    expect(unit).toContain(`ExecStart=${path} `);
  });

  test("each identity's env file carries the CDP port the box's healthz probe dials", () => {
    for (const identity of identities) {
      const env = fileAt(browserEnvPath(identity.name));
      expect(env).toContain(`CDP_PORT=${String(identity.cdp_port)}`);
      // The port the env file names is the same port `cdpVersionUrl` dials —
      // read out of the identity, never out of the rendered text, which is the
      // side agentd never sees.
      expect(cdpVersionUrl(identity)).toBe(
        `http://127.0.0.1:${String(identity.cdp_port)}/json/version`,
      );

      const unit = fileAt("/etc/systemd/system/hermetic-browser@.service");
      expect(unit).toContain("--remote-debugging-port=${CDP_PORT}");
    }
  });

  test("the novnc redirect's path= is the default identity's serve path, minus its leading slash", () => {
    const index = fileAt(`${NOVNC_WEB_ROOT}/index.html`);
    const identity = identities.find((b) => b.name === "default");
    expect(identity).toBeDefined();
    const wsPath = `${identity?.serve_path.replace(/^\//, "")}/websockify`;
    expect(index).toContain(`path=${wsPath}`);
  });

  test("the Serve route for the identity's path targets its own websockify port", () => {
    for (const identity of identities) {
      const route = manifest.tailscale_serve.routes.find((r) => r.path === identity.serve_path);
      expect(route?.target).toBe(`http://127.0.0.1:${String(identity.ws_port)}`);
    }
  });
});
