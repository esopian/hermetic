/**
 * `hermeticd bootstrap` end to end, on the box cloud-init actually hands over:
 * user-data on disk and nothing else.
 *
 * The regression this file exists for: making every subcommand require
 * `/var/lib/hermeticd/fleet.json` broke the one subcommand whose job is to
 * create it. A first boot failed before fetching anything, and systemd retried
 * it forever.
 */
import { describe, expect, test } from "bun:test";
import { FLEET_MANIFEST_KEY } from "@hermetic/core/schema";
import { makeAws } from "../src/aws.ts";
import type { CommandSink } from "../src/aws.ts";
import { BOOTSTRAP_UNIT } from "../src/bootstrap.ts";
import { FLEET_CACHE_PATH, readUsableFleetManifest } from "../src/fleet.ts";
import { INSTALL_LOCK_PATH } from "../src/install-lock.ts";
import { BOOT_ID_PATH } from "../src/update/index.ts";
import { STAGES_DIR } from "../src/stages.ts";
import {
  USER_DATA_JSON_PATH,
  bootstrapUnitActive,
  bootstrapUnitBusy,
  fatalMessage,
  log,
  maybeUpdate,
  run,
  stderrEmit,
} from "../src/index.ts";
import { AgentdError, exitCodeFor } from "../src/errors.ts";
import { opEvent } from "../src/events.ts";
import { FakeHost } from "./fake-host.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_EVENTS_TABLE,
  TEST_HOSTNAME,
  TEST_NAME,
  TEST_STAGE_BODIES,
  makeFleetManifest,
  releaseFileAt,
  makeUserDataJson,
} from "./fixtures.ts";
import { captureOutput } from "./quiet.ts";

// The commands these tests drive write their progress and log lines to the
// process's own streams; kept out of the run's output (`quiet.ts`).
captureOutput();

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
/** A tailnet-key-shaped FIXTURE sentinel — never a real credential. */
const FIXTURE_KEY = "tskey-auth-kFIXTURE-FIXTUREFIXTUREFIXTURE";

function firstBoot(options: { cache?: string; s3Fails?: boolean } = {}) {
  const host = new FakeHost();
  // Exactly what cloud-init leaves behind: the JSON blob, and nothing else.
  host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
  if (options.cache !== undefined) host.seed(FLEET_CACHE_PATH, options.cache);

  const fleet = makeFleetManifest();
  const ddb = new RecordingSink();
  const ssm = new RecordingSink();
  const s3 = new RecordingSink();
  ddb.byCommand.set("GetCommand", () => ({
    Item: { name: TEST_NAME, status: "creating", version: 1, resources: { ssm_paths: [] } },
  }));
  ddb.byCommand.set("UpdateCommand", () => ({}));
  ddb.byCommand.set("PutCommand", () => ({}));
  s3.byCommand.set("GetObjectCommand", (command) => {
    if (options.s3Fails) return new Error("AccessDenied");
    const key = String((command as { input: { Key?: string } }).input.Key);
    if (key === FLEET_MANIFEST_KEY) return { Body: enc(JSON.stringify(fleet)) };
    // Only the objects the manifest records exist; see `releaseFileAt`.
    const file = releaseFileAt(fleet, key);
    const body = file?.startsWith("stages/") === true ? TEST_STAGE_BODIES[file.slice(7)] : undefined;
    return body === undefined ? new Error(`NoSuchKey: ${key}`) : { Body: enc(body) };
  });

  const aws = makeAws({
    ddb,
    ssm,
    s3,
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });
  // IMDS is only reached for the region on a box with no cache; the fake keeps
  // the suite off the network entirely (§11.5).
  const imds = {
    userData: async () => makeUserDataJson(),
    region: async () => "us-east-1",
  };
  const deps = { s3: s3 as CommandSink, aws: () => aws, imds };
  return { host, ddb, s3, fleet, deps };
}

describe("a first boot (§4.2)", () => {
  test("reaches the stage runner with only user-data on disk", async () => {
    const { host, deps } = firstBoot();

    expect(await run(["bootstrap"], host, deps)).toBe(0);

    // It fetched the manifest, cached it, and ran every stage.
    expect(host.files.has(FLEET_CACHE_PATH)).toBe(true);
    expect(host.streamed).toEqual(Object.keys(TEST_STAGE_BODIES).map((f) => `bash ${STAGES_DIR}/${f}`));
  });

  /**
   * The whole path the tailnet name travels: cloud-init's JSON on disk →
   * `parseUserData` → `runStages`' environment → `01-tailscale.sh`'s
   * `--hostname`. It is asserted end to end because every link was right on its
   * own while the chain was broken in the middle — the parse dropped the field,
   * so a v4 box asked the tailnet for its v3 name and nothing anywhere failed.
   */
  test("the hostname in user-data is the name the stages are given", async () => {
    const { host, deps } = firstBoot();

    expect(await run(["bootstrap"], host, deps)).toBe(0);

    expect(host.streamedEnv[0]?.["HERMETIC_HOSTNAME"]).toBe(TEST_HOSTNAME);
    // …and it is not the agent name, which is what the fallback would give.
    expect(TEST_HOSTNAME).not.toBe(TEST_NAME);
    expect(host.streamedEnv[0]?.["HERMETIC_NAME"]).toBe(TEST_NAME);
  });

  /**
   * A truncated cache (a box that lost power mid-update) must not be fatal:
   * `update` is the thing that would rewrite it, and `serve` has to start.
   */
  test("a corrupt cache is treated as absent, not as a reason to die", async () => {
    const { host, deps } = firstBoot({ cache: "{ this is not json" });

    expect(await run(["bootstrap"], host, deps)).toBe(0);
    expect(host.files.get(FLEET_CACHE_PATH)?.content).toContain('"schema_version"');
  });

  test("readUsableFleetManifest warns and returns null rather than throwing", async () => {
    const host = new FakeHost();
    host.seed(FLEET_CACHE_PATH, '{"schema_version":1}');
    const warnings: string[] = [];

    expect(await readUsableFleetManifest(host, (m) => warnings.push(m))).toBeNull();
    expect(warnings[0]).toContain(FLEET_CACHE_PATH);
    // …and the strict reader still throws, for callers that want that.
    await expect(
      (async () => (await import("../src/fleet.ts")).readCachedFleetManifest(host))(),
    ).rejects.toThrow(/does not validate/);
  });

  /**
   * The Hermes mirror block is additive (§1): this hermeticd has to read a
   * manifest written before it existed *and* one written by a laptop that
   * mirrors, because a fleet is upgraded one side at a time.
   */
  test("parseFleetManifest accepts a manifest with and without the hermes mirror", async () => {
    const { parseFleetManifest } = await import("../src/fleet.ts");
    const fleet = makeFleetManifest();
    expect(parseFleetManifest(JSON.stringify(fleet)).hermes).toBeUndefined();

    const mirrored = {
      ...fleet,
      hermes: {
        "v2026.8.31": {
          key: "hermes/v2026.8.31.bundle",
          sha256: "d".repeat(64),
          size: 1024,
          upstream_sha: "576efebfd41f459334b9cb55d9f11f1da3be5cfe",
        },
      },
    };
    const parsed = parseFleetManifest(JSON.stringify(mirrored));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.hermes?.["v2026.8.31"]?.key).toBe("hermes/v2026.8.31.bundle");
  });

  test("no manifest and no cache says so, rather than failing obscurely", async () => {
    const { host, deps } = firstBoot({ s3Fails: true });
    await expect(run(["bootstrap"], host, deps)).rejects.toThrow(
      /could not read s3:\/\/.*\/manifest\.json and there is no cache/,
    );
  });

  test("a cache is used when the fetch fails, so S3 being down is not a dead box", async () => {
    const fleet = makeFleetManifest();
    const { host, deps } = firstBoot({ cache: JSON.stringify(fleet), s3Fails: true });
    // The stages cannot be fetched either, so the boot fails — but on the stage
    // download, having got that far, rather than on the manifest.
    await expect(run(["bootstrap"], host, deps)).rejects.toThrow(/AccessDenied/);
  });

  test("the subcommands that run after a boot still require the cache", async () => {
    const { host, deps } = firstBoot();
    await expect(run(["heartbeat", "--once"], host, deps)).rejects.toThrow(/no fleet manifest cache/);
  });
});

describe("journald never sees a secret (§8.3)", () => {
  function captureStderr(fn: () => void): string {
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      captured += chunk;
      return true;
    };
    try {
      fn();
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    return captured;
  }

  test("an error carrying a key reaches stderr redacted, in every path", () => {
    const message = `tailscale up exited 1: invalid key ${FIXTURE_KEY}`;
    const out = captureStderr(() => {
      stderrEmit(opEvent("tailscale", 0.5, message, new Date("2026-09-01T12:00:00.000Z")));
      log(message);
      process.stderr.write(fatalMessage(new Error(message)));
    });

    expect(out).not.toContain(FIXTURE_KEY);
    expect(out.match(/«redacted»/g)).toHaveLength(3);
    // The rest of the line survives — a redaction that ate the message would
    // be no more useful than the leak.
    expect(out).toContain("tailscale up exited 1");
  });
});

/**
 * Two installers, one `/opt/hermetic/stages` (§4.2, §6.5). The updater's half
 * of the answer is this probe, and the probe is only worth anything if it
 * errs towards "busy": a deferred update costs a minute, and an update that
 * goes ahead while a stage is running costs the boot.
 */
describe("one installer at a time (§4.2)", () => {
  /** What `maybeUpdate` needs, minus the part every case here sets. */
  const updateDeps = (host: FakeHost, deps: ReturnType<typeof firstBoot>["deps"]) => ({
    host,
    aws: deps.aws(),
    name: TEST_NAME,
    bucket: "hermetic-fleet-123456789012",
    hermeticdVersion: "0.1.0",
  });

  test("the start-up update defers while the bootstrap unit is still running", async () => {
    const { host, s3, deps } = firstBoot();
    host.unitStates.set(BOOTSTRAP_UNIT, "active");

    expect(await bootstrapUnitActive(host)).toBe(true);
    const result = await maybeUpdate(host, updateDeps(host, deps));

    expect(result).toBeNull();
    // Not one object was fetched: the boot owns /opt/hermetic/stages right now.
    expect(s3.calls).toEqual([]);
  });

  /**
   * The bug this probe replaced. `hermeticd-bootstrap.service` is
   * `Type=oneshot`, so systemd reports it `activating` for the whole of its
   * `ExecStart` — every stage, minutes of it — and `active` only for the
   * instant before it finishes. `systemctl is-active --quiet` exits non-zero
   * for `activating`, so the old probe read "not busy" for the entire window it
   * existed to cover, and the updater installed stages under a running stage.
   */
  test("`activating` — a oneshot unit mid-ExecStart — is busy, not idle", async () => {
    const { host, s3, deps } = firstBoot();
    host.unitStates.set(BOOTSTRAP_UNIT, "activating");

    expect(await bootstrapUnitBusy(host)).toMatchObject({ busy: true });
    expect((await bootstrapUnitBusy(host)).detail).toContain("activating");
    expect(await maybeUpdate(host, updateDeps(host, deps))).toBeNull();
    expect(s3.calls).toEqual([]);
  });

  test.each(["reloading", "deactivating"])("`%s` is busy too", async (state) => {
    const { host, s3, deps } = firstBoot();
    host.unitStates.set(BOOTSTRAP_UNIT, state);

    expect(await maybeUpdate(host, updateDeps(host, deps))).toBeNull();
    expect(s3.calls).toEqual([]);
  });

  test.each([
    ["systemctl exits non-zero", { code: 1, stdout: "", stderr: "Failed to get properties" }],
    ["systemctl says nothing at all", { code: 0, stdout: "", stderr: "" }],
    ["systemctl answers something else", { code: 0, stdout: "ActiveState=who-knows\n", stderr: "" }],
  ])("a probe that cannot be read is busy: %s", async (_why, reply) => {
    const { host, s3, deps } = firstBoot();
    host.handlers.push((argv) => (argv[1] === "show" ? reply : null));

    expect(await bootstrapUnitActive(host)).toBe(true);
    expect(await maybeUpdate(host, updateDeps(host, deps))).toBeNull();
    expect(s3.calls).toEqual([]);
  });

  test("a probe that throws is busy: there is no answer to read", async () => {
    const { host, s3, deps } = firstBoot();
    host.handlers.push((argv) => {
      if (argv[1] !== "show") return null;
      throw new Error("ENOENT: systemctl");
    });

    expect(await bootstrapUnitActive(host)).toBe(true);
    expect(await maybeUpdate(host, updateDeps(host, deps))).toBeNull();
    expect(s3.calls).toEqual([]);
  });

  test.each(["inactive", "failed"])("and runs once the unit is %s", async (state) => {
    const { host, s3, deps } = firstBoot();
    host.unitStates.set(BOOTSTRAP_UNIT, state);

    expect(await bootstrapUnitActive(host)).toBe(false);
    await maybeUpdate(host, updateDeps(host, deps)).catch(() => null);

    expect(s3.calls.length).toBeGreaterThan(0);
  });
});

/**
 * The bootstrap runner's side of the same lock (§6.5). systemd answers the
 * updater's question; nothing answers the runner's, because `hermeticd.service`
 * is `active` whether its update loop is installing or idle.
 */
describe("the stage runner holds the installation lock (§6.5)", () => {
  const BOOT = "6f3b2c1a-0000-4000-8000-000000000001";

  test("it is held while the stages run and released when they are done", async () => {
    const { host, deps } = firstBoot();
    const heldDuringStages: boolean[] = [];
    host.streamHandlers.push(() => {
      heldDuringStages.push(host.files.has(INSTALL_LOCK_PATH));
      return { code: 0 };
    });

    expect(await run(["bootstrap"], host, deps)).toBe(0);

    expect(heldDuringStages).toHaveLength(Object.keys(TEST_STAGE_BODIES).length);
    expect(heldDuringStages.every((held) => held)).toBe(true);
    expect(host.files.has(INSTALL_LOCK_PATH)).toBe(false);
  });

  test("a live updater's lock makes the boot wait, then fail rather than race", async () => {
    const { host, deps } = firstBoot();
    host.seed(BOOT_ID_PATH, `${BOOT}\n`);
    host.livePids.add(4242);
    host.seed(
      INSTALL_LOCK_PATH,
      JSON.stringify({ holder: "update", pid: 4242, boot_id: BOOT, taken_at: "2026-09-16T03:00:00Z" }),
    );

    // It fails the unit rather than installing alongside the updater, so
    // systemd's `Restart=on-failure` tries the boot again a minute later —
    // which is the recovery, since the updater will be finished by then.
    await expect(run(["bootstrap"], host, deps)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(exitCodeFor(new AgentdError("CONFLICT", "held"))).not.toBe(0);
    expect(host.streamed).toEqual([]);
  });

  test("a lock left by a process that is gone does not delay the boot", async () => {
    const { host, deps } = firstBoot();
    host.seed(BOOT_ID_PATH, `${BOOT}\n`);
    host.seed(
      INSTALL_LOCK_PATH,
      JSON.stringify({ holder: "update", pid: 4242, boot_id: BOOT, taken_at: "2026-09-16T03:00:00Z" }),
    );

    expect(await run(["bootstrap"], host, deps)).toBe(0);
    expect(host.streamed.length).toBeGreaterThan(0);
  });
});
