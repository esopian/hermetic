/**
 * The nightly self-update (§4.4). It is the only thing on the box that installs
 * code, so the tests are mostly about the two ways it can refuse: an unverified
 * binary, and a restart it was not asked for.
 */
import { describe, expect, test } from "bun:test";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { FLEET_MANIFEST_KEY } from "@hermetic/core/schema";
import { makeAws } from "../src/aws.ts";
import { FLEET_CACHE_PATH, parseFleetManifest } from "../src/fleet.ts";
import { HERMETICD_PATH, STAGES_DIR } from "../src/stages.ts";
import {
  BOOT_ID_PATH,
  HERMETICD_PREV_PATH,
  HERMETICD_STAGED_PATH,
  MIN_FREE_SPACE_FACTOR,
  MAX_SWAP_BOOTS,
  NIGHTLY_UTC_HOUR,
  SWAP_SETTLE_MS,
  UPDATE_INTENT_PATH,
  UPDATE_STATE_PATH,
  markSwapSettled,
  msUntilNightly,
  nightlyMinuteFor,
  parseInstallIntent,
  parseUpdateState,
  settleAfterUptime,
  settleSwap,
  stagesUpToDate,
  update,
} from "../src/update/index.ts";
import { INSTALL_LOCK_PATH } from "../src/install-lock.ts";
import { run } from "../src/main.ts";
import { USER_DATA_JSON_PATH } from "../src/userdata.ts";
import { FakeHost } from "./fake-host.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_BUCKET,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  TEST_STAGE_BODIES,
  makeFleetManifest,
  releaseFileAt,
  sha256Of,
} from "./fixtures.ts";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const BINARY = "ELF-hermeticd";

interface RigOptions {
  /** The release the fleet manifest points at. */
  version?: string;
  stages?: Readonly<Record<string, string>>;
  corrupt?: Readonly<Record<string, string>>;
  /** The bytes the manifest carries a digest for. */
  binary?: string;
  /** The bytes S3 actually serves for the binary, if not `binary`. */
  serveBinary?: string;
  /** The bytes already installed at /usr/local/bin/hermeticd, if not `BINARY`. */
  installed?: string | null;
}

function rig(options: RigOptions = {}) {
  const host = new FakeHost();
  const ddb = new RecordingSink();
  const ssm = new RecordingSink();
  const s3 = new RecordingSink();
  const bodies = options.stages ?? TEST_STAGE_BODIES;
  const released = options.binary ?? BINARY;
  const fleet = makeFleetManifest({
    ...(options.version ? { version: options.version } : {}),
    stages: bodies,
    binary: released,
    ...(options.corrupt ? { corrupt: options.corrupt } : {}),
  });
  // What the box is already running. `null` is a box with no binary on disk at
  // all, which the update must treat as stale rather than as "fine".
  const installed = options.installed === undefined ? BINARY : options.installed;
  if (installed !== null) host.seed(HERMETICD_PATH, installed, "0755");

  ddb.byCommand.set("PutCommand", () => ({}));
  ddb.byCommand.set("UpdateCommand", () => ({}));
  s3.byCommand.set("GetObjectCommand", (command) => {
    const key = String((command as { input: { Key?: string } }).input.Key);
    if (key === FLEET_MANIFEST_KEY) return { Body: enc(JSON.stringify(fleet)) };
    // Only the objects the manifest records exist; see `releaseFileAt`.
    const file = releaseFileAt(fleet, key);
    if (file === "hermeticd") return { Body: enc(options.serveBinary ?? released) };
    const body = file?.startsWith("stages/") === true ? bodies[file.slice(7)] : undefined;
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

  const deps = { host, aws, name: TEST_NAME, bucket: TEST_BUCKET, hermeticdVersion: "0.1.0" };
  return { host, ddb, s3, aws, fleet, deps, bodies };
}

/** The stages an up-to-date box already has installed. */
function seedStages(host: FakeHost, bodies: Readonly<Record<string, string>>): void {
  for (const [file, body] of Object.entries(bodies)) host.seed(`${STAGES_DIR}/${file}`, body);
}

function keysFetched(s3: RecordingSink): string[] {
  return s3.calls.map((c) => String((c as { input: { Key?: string } }).input.Key));
}

describe("hermeticd update (§4.4)", () => {
  test("a fleet on the running release is a no-op, and refreshes the cache", async () => {
    const { host, s3, deps, bodies, fleet } = rig();
    seedStages(host, bodies);

    const result = await update(deps);

    expect(result).toMatchObject({ upToDate: true, binaryChanged: false, restarted: false });
    // Only the manifest was fetched: no binary, no stages.
    expect(keysFetched(s3)).toEqual([FLEET_MANIFEST_KEY]);
    expect(host.restarted).toEqual([]);
    // The cache is the document every other subcommand reads (§4.2 step 2).
    expect(parseFleetManifest(host.files.get(FLEET_CACHE_PATH)?.content ?? "")).toEqual(fleet);
    expect(host.files.get(FLEET_CACHE_PATH)?.mode).toBe("0644");
  });

  test("a new release is verified, swapped atomically, and restarted last", async () => {
    const { host, ddb, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);

    const result = await update(deps);

    expect(result).toMatchObject({
      running: "0.1.0",
      target: "0.2.0",
      binaryChanged: true,
      restarted: true,
    });
    expect(host.files.get(HERMETICD_PATH)?.mode).toBe("0755");
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
    // Written beside the target and renamed over it; no half-written binary.
    expect(host.files.has(`${HERMETICD_PATH}.new`)).toBe(false);
    expect(host.restarted).toEqual(["hermeticd.service"]);
    // The restart is the last thing that happens, so the event is already written.
    const event = ddb.commandCalls(PutCommand).at(-1)?.input.Item as { action: string; detail: string };
    expect(event).toMatchObject({ action: "update", detail: "hermeticd 0.1.0 → 0.2.0" });
  });

  /**
   * The label is for reporting; the digest is what decides. A box whose binary
   * is already the right bytes must not update because the manifest calls the
   * release something else — that is the loop that would have every box in the
   * fleet downloading and restarting every night, forever.
   */
  test("the same bytes under a new version label is NOT an update", async () => {
    const { host, s3, deps, bodies } = rig({ version: "9.9.9" });
    seedStages(host, bodies);

    const result = await update(deps);

    expect(result).toMatchObject({ upToDate: true, binaryChanged: false, restarted: false });
    expect(result.target).toBe("9.9.9");
    expect(keysFetched(s3)).toEqual([FLEET_MANIFEST_KEY]);
    expect(host.restarted).toEqual([]);
  });

  test("different bytes under the SAME version label IS an update", async () => {
    const { host, deps, bodies } = rig({ binary: "ELF-rebuilt", installed: "ELF-old" });
    seedStages(host, bodies);

    const result = await update(deps);

    expect(result).toMatchObject({ binaryChanged: true, restarted: true });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-rebuilt");
  });

  test("a box with no binary on disk is stale, not up to date", async () => {
    const { host, deps, bodies } = rig({ installed: null });
    seedStages(host, bodies);

    const result = await update(deps);

    expect(result).toMatchObject({ installedSha256: null, binaryChanged: true });
  });

  test("a tampered binary is never installed", async () => {
    const { host, deps, bodies } = rig({
      version: "0.2.0",
      binary: "ELF-hermeticd-0.2.0",
      serveBinary: "not-the-binary",
    });
    seedStages(host, bodies);

    await expect(update(deps)).rejects.toThrow(/digest mismatch/);
    await expect(update(deps)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    // The old binary is untouched.
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual([]);
  });

  /**
   * Binary first, then stages: a box that fails the download must not be left
   * carrying the new release's stages under the old binary.
   */
  test("a failed binary download leaves the OLD stages in place", async () => {
    const moved = { ...TEST_STAGE_BODIES, "01-tailscale.sh": "#!/usr/bin/env bash\necho new\n" };
    const { host, deps } = rig({
      version: "0.2.0",
      binary: "ELF-hermeticd-0.2.0",
      serveBinary: "not-the-binary",
      stages: moved,
    });
    seedStages(host, TEST_STAGE_BODIES);

    await expect(update(deps)).rejects.toThrow(/digest mismatch/);

    expect(host.files.get(`${STAGES_DIR}/01-tailscale.sh`)?.content).toBe(
      TEST_STAGE_BODIES["01-tailscale.sh"],
    );
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
  });

  test("a release naming no digest for the binary is refused, not trusted", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0" });
    seedStages(host, bodies);
    // A manifest that points at 0.2.0 but lists only stages: there is no digest
    // to compare the installed binary against, so "up to date" is unknowable.
    const fleet = makeFleetManifest({ version: "0.2.0", stages: bodies, binary: null });
    deps.aws.getFleetManifest = async () => fleet;

    await expect(update(deps)).rejects.toThrow(/lists no digest/);
    expect(host.restarted).toEqual([]);
  });

  test("a stage-only change refreshes the stages and does NOT restart", async () => {
    const moved = { ...TEST_STAGE_BODIES, "01-tailscale.sh": "#!/usr/bin/env bash\necho new\n" };
    const { host, ddb, deps } = rig({ stages: moved });
    // The box still has the previous bodies installed.
    seedStages(host, TEST_STAGE_BODIES);

    const result = await update(deps);

    expect(result).toMatchObject({
      upToDate: false,
      binaryChanged: false,
      stagesChanged: true,
      restarted: false,
    });
    expect(host.files.get(`${STAGES_DIR}/01-tailscale.sh`)?.content).toBe(moved["01-tailscale.sh"]);
    // The stages are read at the next boot; interrupting the heartbeat to pick
    // them up would cost more than it buys.
    expect(host.restarted).toEqual([]);
    const event = ddb.commandCalls(PutCommand).at(-1)?.input.Item as { detail: string };
    expect(event.detail).toBe("stages refreshed for hermeticd 0.1.0");
  });

  test("--check reports what would change and changes nothing at all", async () => {
    const { host, s3, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);

    const result = await update(deps, { check: true });

    expect(result).toMatchObject({ upToDate: false, binaryChanged: true, restarted: false });
    expect(keysFetched(s3)).toEqual([FLEET_MANIFEST_KEY]);
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual([]);
    // Not even the cache: a box asked what it *would* do must not come back
    // having quietly adopted a new manifest.
    expect(host.files.has(FLEET_CACHE_PATH)).toBe(false);
  });

  test("stagesUpToDate is byte-exact: a missing or edited file is not up to date", async () => {
    const { host, fleet, bodies } = rig();
    expect(await stagesUpToDate(host, fleet)).toBe(false);

    seedStages(host, bodies);
    expect(await stagesUpToDate(host, fleet)).toBe(true);

    host.seed(`${STAGES_DIR}/01-tailscale.sh`, "#!/usr/bin/env bash\n# edited by hand\n");
    expect(await stagesUpToDate(host, fleet)).toBe(false);
    expect(sha256Of("x")).toHaveLength(64);
  });

  /**
   * A single fixed minute would have every box in the fleet fetching the same
   * object in the same second, and on a release night downloading the same
   * binary and restarting together.
   */
  test("the nightly slot is this agent's own minute of 03:00 UTC", () => {
    const minute = nightlyMinuteFor(TEST_NAME);
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThan(60);
    // Deterministic: an operator can work out when a given agent will move.
    expect(nightlyMinuteFor(TEST_NAME)).toBe(minute);

    const before = msUntilNightly(new Date("2026-09-01T01:00:00.000Z"), TEST_NAME);
    expect(before).toBe(((NIGHTLY_UTC_HOUR - 1) * 60 + minute) * 60_000);
    const after = msUntilNightly(new Date("2026-09-01T04:00:00.000Z"), TEST_NAME);
    expect(after).toBe((23 * 60 + minute) * 60_000);
  });

  test("different agents get different minutes, spread across the hour", () => {
    const names = Array.from({ length: 60 }, (_, i) => `agent-${i}`);
    const minutes = names.map(nightlyMinuteFor);
    expect(new Set(minutes).size).toBeGreaterThan(20);
    expect(Math.max(...minutes)).toBeLessThan(60);
    expect(Math.min(...minutes)).toBeGreaterThanOrEqual(0);
  });
});

/**
 * The half of the self-update that has nothing to do with fetching: what the
 * box believes about itself between swapping a binary and running it.
 *
 * `systemctl restart` is the last line of the update and the one nothing runs
 * after — so it is also the one whose failure nobody sees. The new bytes are on
 * disk, so the digest comparison every later tick makes says "up to date" while
 * the process answering the heartbeat is still the old release. These tests are
 * that gap, from every end (§6.5).
 */
describe("a binary swap and the restart that has to follow it (§6.5)", () => {
  const stateOf = (host: FakeHost) =>
    parseUpdateState(host.files.get(UPDATE_STATE_PATH)?.content ?? "");

  /**
   * `serve`'s own dependencies, refusing offline. Nothing in this suite may
   * reach 169.254.169.254, and a `serve` whose boot fails is exactly what these
   * two tests are about.
   */
  const NO_IMDS = {
    userData: async () => {
      throw new Error("no instance metadata service on this box");
    },
    region: async () => {
      throw new Error("no instance metadata service on this box");
    },
  };

  /** The service's own update tick — the only one whose restarts count. */
  const service = <T extends object>(deps: T, pid: number) => ({ ...deps, pid, asService: true });

  /** A `systemctl restart` that fails the first `failures` times it is asked. */
  function flakyRestart(host: FakeHost, failures: number): () => number {
    let asked = 0;
    host.handlers.push((argv) => {
      if (argv[0] !== "systemctl" || argv[1] !== "restart") return null;
      asked += 1;
      return asked <= failures
        ? { code: 1, stdout: "", stderr: "Failed to restart hermeticd.service: unit is masked" }
        : { code: 0, stdout: "", stderr: "" };
    });
    return () => asked;
  }

  test("the swap is recorded before the restart, and the manifest is NOT adopted", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(BOOT_ID_PATH, "6f3b2c1a-0000-4000-8000-000000000001\n");

    const result = await update(service(deps, 4242));

    expect(result).toMatchObject({ restarted: true, restartPending: false, rolledBack: false });
    expect(stateOf(host).swap).toMatchObject({
      target: "0.2.0",
      swapped_by_pid: 4242,
      boot_id: "6f3b2c1a-0000-4000-8000-000000000001",
      boots: 0,
    });
    expect(stateOf(host).swap?.previous_sha256).toBe(sha256Of(BINARY));
    // Adopting the manifest is the *new* binary's first act. Writing it here
    // would have this box claiming a release it has not started running.
    expect(host.files.has(FLEET_CACHE_PATH)).toBe(false);
  });

  /**
   * `/usr/local/bin/hermeticd` is the `ExecStart` of both units, so it may
   * never be missing — `Restart=always` restarts a process, it does not
   * recreate a file. The backup is therefore a hard link and the swap is one
   * rename, not a rename away and a rename back with a gap in between.
   */
  describe("the path is never empty", () => {
    /**
     * A plain `hermeticd.new` left behind by a failed update is an executable
     * sitting in `/usr/local/bin` that tab-completes beside the real one — and
     * the release it holds is by definition one this box could not verify or
     * could not run.
     */
    test("the staged binary is a dot file, not a second executable on PATH", () => {
      expect(HERMETICD_STAGED_PATH).toBe("/usr/local/bin/.hermeticd.new");
      expect(HERMETICD_PATH).toBe("/usr/local/bin/hermeticd");
    });

    test("the backup is a link and the swap is a single rename over it", async () => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);

      await update(service(deps, 1));

      const ops = host.fsOps.filter((op) => op.includes("/usr/local/bin/"));
      expect(ops).toEqual([
        `remove ${HERMETICD_STAGED_PATH}`,
        `remove ${HERMETICD_PREV_PATH}`,
        `link ${HERMETICD_PATH} -> ${HERMETICD_PREV_PATH}`,
        `rename ${HERMETICD_STAGED_PATH} -> ${HERMETICD_PATH}`,
        // The staged name is cleaned up on every path, including the happy one.
        `remove ${HERMETICD_STAGED_PATH}`,
      ]);
      // Nothing ever renames the live path away from under the units.
      expect(ops.some((op) => op.startsWith(`rename ${HERMETICD_PATH} ->`))).toBe(false);
      expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
      expect(host.files.get(HERMETICD_PREV_PATH)?.content).toBe(BINARY);
    });

    test.each([
      ["link", `link ${HERMETICD_PATH} -> ${HERMETICD_PREV_PATH}`],
      ["rename", `rename ${HERMETICD_STAGED_PATH} -> ${HERMETICD_PATH}`],
    ])("a failure at the %s still leaves a whole binary at the path", async (_step, failing) => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      host.fsFaults.push((op, path, to) =>
        `${op} ${path} -> ${to}` === failing
          ? Object.assign(new Error(`EIO: ${op} failed`), { code: "EIO" })
          : null,
      );

      await expect(update(service(deps, 1))).rejects.toThrow(/EIO/);

      // The old release is still there, entire, and systemd can still start it.
      expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
      expect(stateOf(host).swap).toBeNull();
      expect(host.restarted).toEqual([]);
      // And no executable is left lying about in /usr/local/bin.
      expect(host.files.has(HERMETICD_STAGED_PATH)).toBe(false);
    });

    /**
     * `link(2)` is `EPERM` on overlayfs and on anything mounted `nolink`.
     * Treating that as fatal would refuse every update forever on a box where
     * everything else works, so the backup falls back to a copy — slower, and
     * with exactly the same property: the live path is untouched by either.
     */
    test("a filesystem that refuses hard links gets a copy instead", async () => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      host.fsFaults.push((op) =>
        op === "link"
          ? Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
          : null,
      );

      const result = await update(service(deps, 1));

      expect(result.binaryChanged).toBe(true);
      expect(host.files.get(HERMETICD_PREV_PATH)?.content).toBe(BINARY);
      expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
    });

    test("a link failure that is not about hard links is still a failure", async () => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      host.fsFaults.push((op) =>
        op === "link" ? Object.assign(new Error("EIO: I/O error"), { code: "EIO" }) : null,
      );

      await expect(update(service(deps, 1))).rejects.toThrow(/EIO/);
      expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    });
  });

  /**
   * A digest proves the bytes arrived intact. It says nothing about whether
   * they can be executed: a linux-amd64 build on an arm64 box matches perfectly
   * and cannot run at all, and a box that swaps one in never reaches any of the
   * machinery below — it dies before `serve` starts, every time, forever.
   */
  describe("a release that cannot run is never sworn in", () => {
    test("the staged binary is run before anything is moved", async () => {
      const { host, ddb, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      host.handlers.push((argv) =>
        argv[0] === HERMETICD_STAGED_PATH
          ? { code: 126, stdout: "", stderr: "cannot execute binary file: Exec format error" }
          : null,
      );

      const result = await update(service(deps, 1));

      expect(result).toMatchObject({ blocked: true, binaryChanged: false, restarted: false });
      expect(result.blockedReason).toContain("will not run on this box");
      // Nothing was linked, nothing renamed, nothing left staged.
      expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
      expect(host.files.has(HERMETICD_PREV_PATH)).toBe(false);
      expect(host.files.has(HERMETICD_STAGED_PATH)).toBe(false);
      // (Only the binary's own path: the installation lock is a link too.)
      expect(host.fsOps.some((op) => op.startsWith(`link ${HERMETICD_PATH}`))).toBe(false);
      // Recorded, so the next tick does not download and refuse it all over again.
      expect(stateOf(host).failed_sha256).toBe(sha256Of("ELF-hermeticd-0.2.0"));
      const event = ddb.commandCalls(PutCommand).at(-1)?.input.Item as { action: string };
      expect(event.action).toBe("update-failed");
    });

    test("the smoke test is the release's own `version`, which needs nothing", async () => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);

      await update(service(deps, 1));

      expect(host.commands).toContain(`${HERMETICD_STAGED_PATH} version`);
    });
  });

  test("a volume with no room for the swap refuses before it downloads", async () => {
    const { host, s3, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    const size = "ELF-hermeticd-0.2.0".length;
    // Room for two copies where three are needed.
    host.statfsResult = {
      blockSize: 1,
      blocks: 1_000_000,
      available: size * (MIN_FREE_SPACE_FACTOR - 1),
    };

    const result = await update(service(deps, 1));

    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toContain("free on the volume");
    expect(keysFetched(s3)).toEqual([FLEET_MANIFEST_KEY]);
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
  });

  test("a symlink at the binary path is refused, not quietly replaced", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.symlinks.add(HERMETICD_PATH);

    const result = await update(service(deps, 1));

    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toContain("symlink");
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
  });

  test("a restart that fails is retried on the next tick, and never reported up to date", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    const asked = flakyRestart(host, 1);
    // The same process throughout: systemd never replaced it.
    const swapper = service(deps, 4242);

    await expect(update(swapper)).rejects.toThrow(/systemctl exited 1/);
    expect(asked()).toBe(1);
    // The new bytes are in place, which is exactly what used to make the next
    // tick say "up to date" forever.
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");

    const second = await update(swapper);

    expect(second).toMatchObject({ upToDate: false, restartPending: true, restarted: true });
    expect(asked()).toBe(2);
  });

  /**
   * `--check` runs from a shell, so its own pid is never the marker's. Asking
   * systemd which process *is* the service is the only way the CLI can report
   * the state it was run to report.
   */
  test("--check reports a pending restart from a different process entirely", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    const asked = flakyRestart(host, 1);
    await expect(update(service(deps, 4242))).rejects.toThrow(/systemctl exited 1/);
    // systemd still has 4242 as the service; this process is 777.
    host.handlers.push((argv) =>
      argv[1] === "show" && argv.includes("MainPID") ? { code: 0, stdout: "4242\n", stderr: "" } : null,
    );

    const checked = await update({ ...deps, pid: 777 }, { check: true });

    expect(checked).toMatchObject({ upToDate: false, restartPending: true, restarted: false });
    expect(asked()).toBe(1);
    expect(stateOf(host).swap).toMatchObject({ boots: 0, seen_by_pid: null });
  });

  /**
   * `MainPID=0` is systemd saying the unit is not running at all. With a swap
   * outstanding that is the same answer as "the restart never took", and the
   * worst version of it — nothing is running the new binary and nothing is
   * going to notice on its own.
   */
  test("--check on a service systemd has given up on reports restart pending", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 4242));
    host.handlers.push((argv) =>
      argv[1] === "show" && argv.includes("MainPID") ? { code: 0, stdout: "0\n", stderr: "" } : null,
    );

    const checked = await update({ ...deps, pid: 777 }, { check: true });

    expect(checked.restartPending).toBe(true);
  });

  test("--check prints the digest it compares and why nothing will happen", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.symlinks.add(HERMETICD_PATH);
    await update(service(deps, 1));
    host.symlinks.delete(HERMETICD_PATH);

    const checked = await update({ ...deps, pid: 777 }, { check: true });

    expect(checked.targetSha256).toBe(sha256Of("ELF-hermeticd-0.2.0"));
    expect(checked.installedSha256).toBe(sha256Of(BINARY));
    expect(checked.blocked).toBe(true);
    expect(checked.blockedReason).toContain("rolled back from it");
  });

  test("a swap made in a previous boot is never mistaken for one this process made", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(BOOT_ID_PATH, "aaaaaaaa-0000-4000-8000-000000000001\n");
    await update(service(deps, 4242));

    // The box rebooted and the kernel handed the same pid back out.
    host.seed(BOOT_ID_PATH, "bbbbbbbb-0000-4000-8000-000000000002\n");

    const outcome = await settleSwap({ host, pid: 4242, asService: true });
    expect(outcome).not.toBe("restart-pending");
  });

  /**
   * Settling is not a clock reading. A binary that takes twenty-five seconds to
   * die — IMDS, STS and Tailscale timeouts, then an exception — would cross any
   * wall-clock window on its third incarnation and have a release that never
   * once stayed up declared good. It takes evidence instead: a heartbeat that
   * landed, or this process's own uptime.
   */
  describe("settling takes evidence, not elapsed time", () => {
    test("the first heartbeat write that lands settles the swap", async () => {
      const { host, ddb, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      await update(service(deps, 4242));
      expect(host.files.has(HERMETICD_PREV_PATH)).toBe(true);

      // What `serve` calls from `onFirstWrite`.
      expect(await markSwapSettled({ host })).toBe("settled");

      expect(stateOf(host).swap).toBeNull();
      // The backup goes with it: one generation back is a rollback target, two
      // is 100 MB of a root volume nobody will boot.
      expect(host.files.has(HERMETICD_PREV_PATH)).toBe(false);
      // The event is queued locally and written by the next tick with a client.
      await update(service(deps, 9999));
      const event = ddb.commandCalls(PutCommand).at(-1)?.input.Item as { detail: string };
      expect(event.detail).toContain("is up and settled");
    });

    test("…and failing that, this process staying up for the settle window", async () => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      await update(service(deps, 4242));

      expect(await settleAfterUptime({ host }, SWAP_SETTLE_MS)).toBe("settled");

      expect(host.sleeps).toContain(SWAP_SETTLE_MS);
      expect(stateOf(host).swap).toBeNull();
    });

    /**
     * The regression: three instances, each alive for longer than the settle
     * window's worth of wall-clock, none of which ever heartbeats. Elapsed time
     * used to declare this healthy on the third one.
     */
    test("a slow crasher is rolled back however long each instance takes to die", async () => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      await update(service(deps, 1));
      host.restarted.length = 0;

      let outcome: string = "none";
      for (let pid = 2; pid <= MAX_SWAP_BOOTS + 2; pid += 1) {
        // Each incarnation lives well past the old wall-clock window, and dies
        // without ever writing a heartbeat.
        host.advance(SWAP_SETTLE_MS * 2);
        outcome = await settleSwap({ host, pid, asService: true });
      }

      expect(outcome).toBe("rolled-back");
      expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
      expect(host.restarted).toEqual(["hermeticd.service"]);
    });

    /**
     * …and the property that motivated the window in the first place: ordinary
     * restarts of a *good* release must never accumulate. They cannot, because
     * a good release settles the marker within seconds, so a reboot three weeks
     * later finds nothing to count.
     */
    test("a reboot long after a good swap has nothing to count", async () => {
      const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
      seedStages(host, bodies);
      await update(service(deps, 1));
      await markSwapSettled({ host });

      host.advance(21 * 24 * 60 * 60_000);
      for (const pid of [2, 3, 4, 5, 6]) {
        expect(await settleSwap({ host, pid, asService: true })).toBe("none");
      }

      expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
      expect(stateOf(host).failed_sha256).toBeNull();
    });
  });

  /**
   * `hermeticd apply` from a stage and a hand-run `hermeticd update` are
   * separate processes by design. Counting them as restarts of the service
   * would roll back a healthy release on a box doing nothing but booting.
   */
  test("only the service's own restarts count as boots", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));

    for (const pid of [2, 3, 4, 5, 6, 7]) {
      expect(await settleSwap({ host, pid })).toBe("watching");
    }

    expect(stateOf(host).swap?.boots).toBe(0);
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
  });

  test("a swap that crash-loops puts the previous binary back", async () => {
    const { host, ddb, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));
    host.restarted.length = 0;

    let result = await update(service(deps, 2));
    for (let boot = 3; boot <= MAX_SWAP_BOOTS + 2; boot += 1) {
      expect(result.rolledBack).toBe(false);
      result = await update(service(deps, boot));
    }

    expect(result).toMatchObject({ rolledBack: true, upToDate: false, restarted: true });
    // The release that would not run is gone; the one that did is back.
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.files.has(HERMETICD_PREV_PATH)).toBe(false);
    expect(stateOf(host).swap).toBeNull();
    expect(host.restarted).toEqual(["hermeticd.service"]);
    // The event is queued locally — the rollback runs where there may be no AWS
    // client — and written by the next tick that has one.
    expect(stateOf(host).pending_events[0]).toMatchObject({ action: "update-failed" });
    await update(service(deps, 99));
    const event = ddb
      .commandCalls(PutCommand)
      .find((c) => (c.input.Item as { action?: string }).action === "update-failed");
    expect((event!.input.Item as { detail: string }).detail).toContain("rolled back");
    expect(stateOf(host).pending_events).toEqual([]);
  });

  /**
   * The loop a rollback creates if nothing remembers it: the manifest still
   * names the release, so the binary reads as stale again on the very next tick
   * and the whole thing repeats — every night, or every minute while a rollout
   * request is pending.
   */
  test("a rolled-back release is refused, not reinstalled, until the fleet moves on", async () => {
    const { host, s3, ddb, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));
    let result = await update(service(deps, 2));
    for (let boot = 3; boot <= MAX_SWAP_BOOTS + 2; boot += 1) {
      result = await update(service(deps, boot));
    }
    expect(result.rolledBack).toBe(true);
    const fetchesBefore = keysFetched(s3).length;
    host.restarted.length = 0;

    const next = await update(service(deps, 50));
    const later = await update(service(deps, 50));

    expect(next).toMatchObject({ blocked: true, binaryChanged: false, restarted: false });
    expect(later.blocked).toBe(true);
    expect(next.blockedReason).toContain("refusing to install");
    // Nothing was downloaded but the manifest itself, and nothing restarted.
    expect(
      keysFetched(s3)
        .slice(fetchesBefore)
        .every((k) => k === FLEET_MANIFEST_KEY),
    ).toBe(true);
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual([]);
    // Said once in the event log, not once per tick.
    const refusals = ddb
      .commandCalls(PutCommand)
      .filter((c) => String((c.input.Item as { detail?: string }).detail).includes("refusing"));
    expect(refusals).toHaveLength(1);
  });

  test("…and a release with a different digest installs normally", async () => {
    const { host, deps, bodies, fleet } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));
    for (let boot = 2; boot <= MAX_SWAP_BOOTS + 2; boot += 1) await update(service(deps, boot));
    expect(stateOf(host).failed_sha256).not.toBeNull();

    // 0.3.0: a different binary, which is what a fix looks like from the box.
    const fixed = makeFleetManifest({
      version: "0.3.0",
      stages: bodies,
      binary: "ELF-hermeticd-0.3.0",
    });
    deps.aws.getFleetManifest = async () => fixed;
    deps.aws.getObjectBytes = async () => new TextEncoder().encode("ELF-hermeticd-0.3.0");
    expect(fleet.hermeticd.version).toBe("0.2.0");

    const result = await update(service(deps, 60));

    expect(result).toMatchObject({ blocked: false, binaryChanged: true, restarted: true });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.3.0");
    expect(stateOf(host).failed_sha256).toBeNull();
  });

  /**
   * The refusal is sticky on purpose, but plenty of the reasons a release
   * crash-loops are environmental — a full disk, a tailnet that was down, a
   * secret that had not been pushed. `--force` is the operator saying they
   * fixed it, and it is the only thing on the box that clears that memory.
   */
  test("--force retries a refused release", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.symlinks.add(HERMETICD_PATH);
    expect((await update(service(deps, 1))).blocked).toBe(true);
    host.symlinks.delete(HERMETICD_PATH);
    // Without it, the refusal stands however fixed the box now is.
    expect((await update(service(deps, 2))).blocked).toBe(true);

    const forced = await update(service(deps, 3), { force: true });

    expect(forced).toMatchObject({ blocked: false, binaryChanged: true, restarted: true });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
  });

  test("--force also forgets a swap that never restarted", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    flakyRestart(host, 1);
    await expect(update(service(deps, 4242))).rejects.toThrow(/systemctl exited 1/);

    const forced = await update(service(deps, 4242), { force: true });

    expect(forced.restartPending).toBe(false);
    expect(stateOf(host).swap).toBeNull();
  });

  /**
   * One failure is weather. The same failure twice is a box that is stuck, and
   * stuck has no other symptom: the version quietly stops moving while the
   * agent goes on heartbeating `ready`.
   */
  test("the same install error twice tells the fleet once", async () => {
    const { host, ddb, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    deps.aws.getObjectBytes = async () => {
      throw new Error("ThrottlingException: rate exceeded");
    };

    await expect(update(service(deps, 1))).rejects.toThrow(/Throttling/);
    const afterOne = ddb.commandCalls(PutCommand).length;
    await expect(update(service(deps, 1))).rejects.toThrow(/Throttling/);
    await expect(update(service(deps, 1))).rejects.toThrow(/Throttling/);

    const events = ddb
      .commandCalls(PutCommand)
      .slice(afterOne)
      .map((c) => String((c.input.Item as { detail?: string }).detail));
    expect(events.filter((d) => d.includes("failed twice with the same error"))).toHaveLength(1);
  });

  test("a backup that is not the binary the swap saved is never booted into", async () => {
    const { host, ddb, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));
    // Something else wrote over the backup between the swap and the rollback.
    host.seed(HERMETICD_PREV_PATH, "ELF-somebody-elses-binary", "0755");
    host.restarted.length = 0;

    let result = await update(service(deps, 2));
    for (let boot = 3; boot <= MAX_SWAP_BOOTS + 2; boot += 1) {
      result = await update(service(deps, boot));
    }

    expect(result.rolledBack).toBe(false);
    // Booting a box into bytes nobody vouched for is worse than leaving it on a
    // release systemd at least keeps restarting.
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
    expect(host.restarted).toEqual([]);
    expect(stateOf(host).swap).toBeNull();
    // Still recorded as failed, so nothing reinstalls it in a loop.
    expect(stateOf(host).failed_target).toBe("0.2.0");
    const said = ddb
      .commandCalls(PutCommand)
      .map((c) => String((c.input.Item as { detail?: string }).detail));
    expect(said.some((d) => d.includes("no usable"))).toBe(true);
  });

  /**
   * The decision has to be reachable by a binary that dies in `bootContext`,
   * `serveRpc`, or anything else `serve` needs — those are exactly the failures
   * a rollback is for, and none of them ever reached an update loop that ran
   * after them. So it takes a `Host` and nothing else: no client, no manifest,
   * no network.
   */
  test("the whole decision runs on local files alone", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));
    host.restarted.length = 0;
    const said: string[] = [];

    let outcome = "none";
    for (let boot = 2; boot <= MAX_SWAP_BOOTS + 2; boot += 1) {
      outcome = await settleSwap({ host, pid: boot, asService: true, log: (m) => said.push(m) });
    }

    expect(outcome).toBe("rolled-back");
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual(["hermeticd.service"]);
    expect(said.at(-1)).toContain("rolled back");
  });

  test("`serve` settles the swap before it touches anything that can fail", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));
    for (let boot = 2; boot <= MAX_SWAP_BOOTS + 1; boot += 1) {
      await settleSwap({ host, pid: boot, asService: true });
    }
    host.restarted.length = 0;
    // No user-data, no IMDS, no credentials: `serve`'s own boot fails hard,
    // which is precisely the shape of failure a rollback exists for.
    host.files.delete(USER_DATA_JSON_PATH);

    await expect(run(["serve"], host, { imds: NO_IMDS })).rejects.toThrow(/metadata/);

    // …and the rollback happened anyway, on the way in.
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual(["hermeticd.service"]);
  });

  /**
   * …and the other half of that: settling is best effort. A root volume that
   * cannot be written must cost an unsettled marker, never the service. With
   * `Restart=always` a `serve` that rejected here would spin forever without
   * ever heartbeating, which is the worst state this box has.
   */
  test("a state write that fails does not stop `serve` starting", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 1));
    host.writeFile = async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    host.files.delete(USER_DATA_JSON_PATH);

    const failure = await run(["serve"], host, { imds: NO_IMDS }).catch((e: unknown) => e);

    // It got past the swap check and failed where `serve` actually starts —
    // never inside `settleSwap`, whose write is the thing that was broken.
    expect(String(failure)).toContain("metadata");
    expect(String(failure)).not.toContain("ENOSPC");
  });

  test("state written by another build, or truncated, is ignored rather than fatal", () => {
    expect(parseUpdateState("{ not json").swap).toBeNull();
    expect(parseUpdateState('{"swap":{"target":"0.2.0"}}').swap).toBeNull();
    expect(
      parseUpdateState(
        JSON.stringify({
          swap: { target: "0.2.0", sha256: "aa", swapped_at: "x", swapped_by_pid: 7, boots: 0 },
        }),
      ).swap,
    ).toMatchObject({ previous_sha256: null, boot_id: null, seen_by_pid: null, boots: 0 });
  });

  test("an over-long pending-event queue keeps the newest, not the oldest", () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      action: "update",
      detail: `event ${i}`,
      at: "2026-09-01T00:00:00.000Z",
    }));
    const kept = parseUpdateState(JSON.stringify({ pending_events: events })).pending_events;
    // Dropping the newest would quietly discard the rollback that just happened.
    expect(kept.at(-1)?.detail).toBe("event 39");
  });
});

/**
 * An install is four writes and a restart, and until 2026-09-16 only the last
 * two of them were written down. A crash in the middle — a stage that would not
 * download is enough — left the *new* binary at `/usr/local/bin/hermeticd`, the
 * *old* process running it, and nothing on disk that said so: the next tick
 * hashed the path, found exactly the release the manifest named, and reported
 * the box up to date. Forever, silently, on a box nobody was watching.
 *
 * The intent record closes it. These tests crash the install at each of its
 * steps and assert the next tick finishes the job (§6.5).
 */
describe("an install that does not finish is finished by the next one (§6.5)", () => {
  const stateOf = (host: FakeHost) =>
    parseUpdateState(host.files.get(UPDATE_STATE_PATH)?.content ?? "");
  const intentOf = (host: FakeHost) =>
    parseInstallIntent(host.files.get(UPDATE_INTENT_PATH)?.content ?? "");
  const service = <T extends object>(deps: T, pid: number) => ({ ...deps, pid, asService: true });

  /** A release where both halves move: a new binary and a changed stage. */
  const MOVED_STAGES = {
    ...TEST_STAGE_BODIES,
    "01-tailscale.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho new\n",
  };
  const newRelease = () =>
    rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0", stages: MOVED_STAGES });

  /** Make the *next* write to a path matching `pattern` throw, once. */
  function crashOnceWriting(host: FakeHost, pattern: RegExp): void {
    let thrown = false;
    host.writeFaults.push((path) => {
      if (thrown || !pattern.test(path)) return null;
      thrown = true;
      return new Error("EIO: the box lost power mid-install");
    });
  }

  test("a crash while installing stages still restarts, on the next tick", async () => {
    const { host, deps } = newRelease();
    seedStages(host, TEST_STAGE_BODIES);
    // The stage installer stages its files under a dot directory before it
    // renames them into place; killing the first of those writes is a crash
    // after the binary swap and before anything else was recorded.
    crashOnceWriting(host, /^\/opt\/hermetic\/stages\/\./);

    await expect(update(service(deps, 11))).rejects.toThrow(/EIO/);

    // The gap, exactly as it used to be: new bytes at the path, old process.
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
    expect(host.restarted).toEqual([]);
    expect(stateOf(host).swap).toBeNull();
    // …and now there is something on disk that says so.
    expect(intentOf(host)).toMatchObject({
      target: "0.2.0",
      sha256: sha256Of("ELF-hermeticd-0.2.0"),
      previous_sha256: sha256Of(BINARY),
      restart_owed: true,
    });
    expect(intentOf(host)?.stages).toEqual(Object.keys(MOVED_STAGES).sort());

    const result = await update(service(deps, 12));

    expect(result).toMatchObject({ upToDate: false, restarted: true, stagesChanged: true });
    expect(host.restarted).toEqual(["hermeticd.service"]);
    expect(host.files.get(`${STAGES_DIR}/01-tailscale.sh`)?.content).toBe(
      MOVED_STAGES["01-tailscale.sh"],
    );
    // The swap marker took over, carrying the rollback target the intent kept.
    expect(stateOf(host).swap).toMatchObject({
      target: "0.2.0",
      swapped_by_pid: 12,
      previous_sha256: sha256Of(BINARY),
    });
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  test("a crash before the binary swap completes it from the intent", async () => {
    const { host, deps } = newRelease();
    seedStages(host, TEST_STAGE_BODIES);
    host.fsFaults.push((op, path, to) =>
      `${op} ${path} -> ${to}` === `rename ${HERMETICD_STAGED_PATH} -> ${HERMETICD_PATH}`
        ? Object.assign(new Error("EIO: rename failed"), { code: "EIO" })
        : null,
    );

    await expect(update(service(deps, 21))).rejects.toThrow(/EIO/);

    // The old binary is whole and running, and the intent says what was meant.
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(intentOf(host)).toMatchObject({ target: "0.2.0", restart_owed: true });
    host.fsFaults.length = 0;

    const result = await update(service(deps, 22));

    expect(result).toMatchObject({ binaryChanged: true, restarted: true });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
    expect(host.files.get(HERMETICD_PREV_PATH)?.content).toBe(BINARY);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  /**
   * The case a digest comparison can never reach on its own: the bytes are
   * already right, so `binaryStale` is false and every branch below it says
   * "up to date" — while the process answering the heartbeat is the release
   * before. Only the intent knows, and it outranks the digest.
   */
  test("the restart happens even when the installed digest already matches", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    // As a crash between the swap and the marker would have left it.
    host.seed(HERMETICD_PATH, "ELF-hermeticd-0.2.0", "0755");
    host.seed(
      UPDATE_INTENT_PATH,
      JSON.stringify({
        target: "0.2.0",
        sha256: sha256Of("ELF-hermeticd-0.2.0"),
        previous_sha256: sha256Of(BINARY),
        stages: Object.keys(bodies),
        restart_owed: true,
        started_at: "2026-09-16T03:11:00.000Z",
        started_by_pid: 31,
        boot_id: null,
      }),
    );

    const result = await update(service(deps, 32));

    expect(result).toMatchObject({ upToDate: false, restarted: true });
    expect(host.restarted).toEqual(["hermeticd.service"]);
    expect(stateOf(host).swap?.previous_sha256).toBe(sha256Of(BINARY));
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  test("a reboot discharges an intent whose swapped binary is now running", async () => {
    const oldBoot = "6f3b2c1a-0000-4000-8000-000000000001";
    const newBoot = "6f3b2c1a-0000-4000-8000-000000000002";
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(HERMETICD_PATH, "ELF-hermeticd-0.2.0", "0755");
    host.seed(BOOT_ID_PATH, `${newBoot}\n`);
    host.seed(
      UPDATE_INTENT_PATH,
      JSON.stringify({
        target: "0.2.0",
        sha256: sha256Of("ELF-hermeticd-0.2.0"),
        previous_sha256: sha256Of(BINARY),
        stages: Object.keys(bodies),
        restart_owed: true,
        started_at: "2026-09-16T03:11:00.000Z",
        started_by_pid: 31,
        boot_id: oldBoot,
      }),
    );

    const result = await update(service(deps, 32));

    expect(result).toMatchObject({ upToDate: true, restarted: false, restartPending: false });
    expect(host.restarted).toEqual([]);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  test("--check recognises a reboot without clearing the discharged intent", async () => {
    const oldBoot = "6f3b2c1a-0000-4000-8000-000000000001";
    const newBoot = "6f3b2c1a-0000-4000-8000-000000000002";
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(HERMETICD_PATH, "ELF-hermeticd-0.2.0", "0755");
    host.seed(BOOT_ID_PATH, `${newBoot}\n`);
    host.seed(
      UPDATE_INTENT_PATH,
      JSON.stringify({
        target: "0.2.0",
        sha256: sha256Of("ELF-hermeticd-0.2.0"),
        previous_sha256: sha256Of(BINARY),
        stages: Object.keys(bodies),
        restart_owed: true,
        started_at: "2026-09-16T03:11:00.000Z",
        started_by_pid: 31,
        boot_id: oldBoot,
      }),
    );

    const result = await update({ ...deps, pid: 32 }, { check: true });

    expect(result).toMatchObject({ upToDate: true, restarted: false, restartPending: false });
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(true);
  });

  test("a reboot before the swap still finishes the install", async () => {
    const oldBoot = "6f3b2c1a-0000-4000-8000-000000000001";
    const newBoot = "6f3b2c1a-0000-4000-8000-000000000002";
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(BOOT_ID_PATH, `${newBoot}\n`);
    host.seed(
      UPDATE_INTENT_PATH,
      JSON.stringify({
        target: "0.2.0",
        sha256: sha256Of("ELF-hermeticd-0.2.0"),
        previous_sha256: sha256Of(BINARY),
        stages: Object.keys(bodies),
        restart_owed: true,
        started_at: "2026-09-16T03:11:00.000Z",
        started_by_pid: 31,
        boot_id: oldBoot,
      }),
    );

    const result = await update(service(deps, 32));

    expect(result).toMatchObject({ binaryChanged: true, restarted: true });
    expect(host.restarted).toEqual(["hermeticd.service"]);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  /**
   * The other direction, and the reason the intent is cleared the instant the
   * marker is written: two records both claiming the restart would have the
   * process that came up from it restart again, count itself as another failed
   * boot, and walk a perfectly good release into the crash-loop rollback.
   */
  test("an intent the swap marker already covers is dropped, not acted on", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    await update(service(deps, 41));
    // As a crash between the marker write and the intent clear would leave it.
    host.seed(
      UPDATE_INTENT_PATH,
      JSON.stringify({
        target: "0.2.0",
        sha256: sha256Of("ELF-hermeticd-0.2.0"),
        previous_sha256: sha256Of(BINARY),
        stages: Object.keys(bodies),
        restart_owed: true,
        started_at: "2026-09-16T03:11:00.000Z",
        started_by_pid: 41,
        boot_id: null,
      }),
    );
    host.restarted.length = 0;

    const result = await update(service(deps, 42));

    // The marker is settling on its own schedule; nothing restarts twice.
    expect(result.restarted).toBe(false);
    expect(host.restarted).toEqual([]);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  test("an intent for a release the fleet has moved on from is dropped", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(
      UPDATE_INTENT_PATH,
      JSON.stringify({
        target: "0.1.9",
        sha256: sha256Of("ELF-hermeticd-0.1.9"),
        previous_sha256: sha256Of(BINARY),
        stages: Object.keys(bodies),
        restart_owed: true,
        started_at: "2026-09-16T03:11:00.000Z",
        started_by_pid: 51,
        boot_id: null,
      }),
    );

    const result = await update(service(deps, 52));

    // The install it owed is discharged by the one the manifest now names.
    expect(result).toMatchObject({ target: "0.2.0", binaryChanged: true, restarted: true });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  test("a stage-only refresh records an intent that owes no restart", async () => {
    const { host, deps } = rig({ stages: MOVED_STAGES });
    seedStages(host, TEST_STAGE_BODIES);
    crashOnceWriting(host, /^\/opt\/hermetic\/stages\/\./);

    await expect(update(deps)).rejects.toThrow(/EIO/);

    expect(intentOf(host)).toMatchObject({ sha256: null, restart_owed: false });

    const result = await update(deps);

    expect(result).toMatchObject({ stagesChanged: true, restarted: false });
    expect(host.restarted).toEqual([]);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  test("`--check` reports an install that still owes a restart, and clears nothing", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(HERMETICD_PATH, "ELF-hermeticd-0.2.0", "0755");
    host.seed(
      UPDATE_INTENT_PATH,
      JSON.stringify({
        target: "0.2.0",
        sha256: sha256Of("ELF-hermeticd-0.2.0"),
        previous_sha256: sha256Of(BINARY),
        stages: Object.keys(bodies),
        restart_owed: true,
        started_at: "2026-09-16T03:11:00.000Z",
        started_by_pid: 61,
        boot_id: null,
      }),
    );

    const result = await update(deps, { check: true });

    expect(result).toMatchObject({ upToDate: false, restartPending: true, restarted: false });
    expect(host.restarted).toEqual([]);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(true);
  });

  /**
   * The order is the whole design: everything that can refuse happens before
   * the intent, and everything after it is recoverable *because* of it.
   */
  test("validate, then intent, then swap, then stages, then marker, then restart", async () => {
    const { host, deps } = newRelease();
    seedStages(host, TEST_STAGE_BODIES);
    const trace: string[] = [];
    host.writeFaults.push((path) => {
      trace.push(`write ${path}`);
      return null;
    });
    host.fsFaults.push((op, path, to) => {
      trace.push(to === undefined ? `${op} ${path}` : `${op} ${path} -> ${to}`);
      return null;
    });
    host.handlers.push((argv) => {
      if (argv[0] === "systemctl" && argv[1] === "restart") trace.push("restart");
      if (argv[0] === HERMETICD_STAGED_PATH) trace.push("smoke test");
      return null;
    });

    await update(service(deps, 71));

    const at = (needle: string) => trace.findIndex((line) => line.includes(needle));
    expect(at("smoke test")).toBeGreaterThanOrEqual(0);
    expect(at("smoke test")).toBeLessThan(at(UPDATE_INTENT_PATH));
    expect(at(UPDATE_INTENT_PATH)).toBeLessThan(at(`rename ${HERMETICD_STAGED_PATH}`));
    expect(at(`rename ${HERMETICD_STAGED_PATH}`)).toBeLessThan(at(`write ${STAGES_DIR}/.`));
    expect(at(`write ${STAGES_DIR}/.`)).toBeLessThan(at(`write ${UPDATE_STATE_PATH}`));
    expect(at(`write ${UPDATE_STATE_PATH}`)).toBeLessThan(at(`remove ${UPDATE_INTENT_PATH}`));
    expect(at(`remove ${UPDATE_INTENT_PATH}`)).toBeLessThan(at("restart"));
  });

  /**
   * Validation is the *whole* release, not just the half that is hard to undo.
   * A stage the bucket will not serve now refuses before the binary moves,
   * where it used to refuse after — from inside the window above.
   */
  test("a stage that will not download stops the install before the swap", async () => {
    const { host, deps } = rig({
      version: "0.2.0",
      binary: "ELF-hermeticd-0.2.0",
      stages: MOVED_STAGES,
      corrupt: { "stages/01-tailscale.sh": sha256Of("not the bytes the bucket serves") },
    });
    seedStages(host, TEST_STAGE_BODIES);

    await expect(update(service(deps, 81))).rejects.toThrow(/does not match the fleet manifest/);

    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
    expect(host.restarted).toEqual([]);
  });
});

/**
 * The updater's side of the lock. Its first line of defence is the systemd
 * query in `maybeUpdate`, which covers the service's own update loop; this
 * covers everything else that can call `update` — `hermeticd update` from an
 * SSH session, an `apply` stage, a rollout request — none of which asks systemd
 * anything (§6.5).
 */
describe("an update refuses to install alongside the bootstrap runner (§6.5)", () => {
  const BOOT = "6f3b2c1a-0000-4000-8000-000000000001";

  test("a live bootstrap lock blocks the install and changes nothing", async () => {
    const { host, s3, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(BOOT_ID_PATH, `${BOOT}\n`);
    host.livePids.add(4242);
    host.seed(
      INSTALL_LOCK_PATH,
      JSON.stringify({ holder: "bootstrap", pid: 4242, boot_id: BOOT, taken_at: "2026-09-16T03:00Z" }),
    );

    const result = await update({ ...deps, pid: 99, asService: true });

    expect(result).toMatchObject({ blocked: true, binaryChanged: false, restarted: false });
    expect(result.blockedReason).toContain("another installer (bootstrap, pid 4242)");
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual([]);
    // Nothing was downloaded but the manifest itself.
    expect(keysFetched(s3)).toEqual([FLEET_MANIFEST_KEY]);
  });

  test("a lock left by a process that is gone does not block anything", async () => {
    const { host, deps, bodies } = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0" });
    seedStages(host, bodies);
    host.seed(BOOT_ID_PATH, `${BOOT}\n`);
    host.seed(
      INSTALL_LOCK_PATH,
      JSON.stringify({ holder: "update", pid: 4242, boot_id: BOOT, taken_at: "2026-09-16T03:00:00Z" }),
    );

    const result = await update({ ...deps, pid: 99, asService: true });

    expect(result).toMatchObject({ binaryChanged: true, restarted: true });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
  });
});

/**
 * The obligation an interrupted install leaves behind, followed past the first
 * tick that tries to discharge it (§6.5).
 *
 * The describe above proves the intent is written and that the next run reads
 * it. These are the runs after that one: a tick that cannot install because
 * another installer holds the lock, a second crash in the same place, and a
 * resume whose own restart fails. None of them may end with the box quietly
 * running the release before the one on disk.
 */
describe("an interrupted install keeps its obligation until it is discharged (§6.5)", () => {
  const BOOT = "6f3b2c1a-0000-4000-8000-000000000002";
  const stateOf = (host: FakeHost) =>
    parseUpdateState(host.files.get(UPDATE_STATE_PATH)?.content ?? "");
  const intentOf = (host: FakeHost) =>
    parseInstallIntent(host.files.get(UPDATE_INTENT_PATH)?.content ?? "");
  const service = <T extends object>(deps: T, pid: number) => ({ ...deps, pid, asService: true });

  /** A release where both halves move, so a crash can land between them. */
  const MOVED_STAGES = {
    ...TEST_STAGE_BODIES,
    "01-tailscale.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho new\n",
  };

  /** Make the next `count` writes to a path matching `pattern` throw. */
  function crashWriting(host: FakeHost, pattern: RegExp, count: number): void {
    let thrown = 0;
    host.writeFaults.push((path) => {
      if (thrown >= count || !pattern.test(path)) return null;
      thrown += 1;
      return new Error("EIO: the box lost power mid-install");
    });
  }

  /**
   * An install interrupted after the binary swap and before anything else was
   * recorded — the state the intent exists to describe.
   */
  async function interrupted(pid: number) {
    const rigged = rig({ version: "0.2.0", binary: "ELF-hermeticd-0.2.0", stages: MOVED_STAGES });
    seedStages(rigged.host, TEST_STAGE_BODIES);
    crashWriting(rigged.host, /^\/opt\/hermetic\/stages\/\./, 1);

    await expect(update(service(rigged.deps, pid))).rejects.toThrow(/EIO/);
    expect(rigged.host.files.get(HERMETICD_PATH)?.content).toBe("ELF-hermeticd-0.2.0");
    expect(rigged.host.restarted).toEqual([]);
    expect(intentOf(rigged.host)?.restart_owed).toBe(true);
    return rigged;
  }

  test("a tick blocked by the bootstrap runner keeps the intent and says so", async () => {
    const { host, deps } = await interrupted(11);
    // The box rebooted into the bootstrap runner, which now holds the lock:
    // the resume cannot install, and must not clear what it could not finish.
    host.seed(BOOT_ID_PATH, `${BOOT}\n`);
    host.livePids.add(4242);
    host.seed(
      INSTALL_LOCK_PATH,
      JSON.stringify({ holder: "bootstrap", pid: 4242, boot_id: BOOT, taken_at: "2026-09-16T03:00Z" }),
    );

    const blocked = await update(service(deps, 12));

    expect(blocked).toMatchObject({ blocked: true, restartPending: true, restarted: false });
    expect(host.restarted).toEqual([]);
    expect(intentOf(host)?.restart_owed).toBe(true);

    // The runner finishes; the next tick is the one that owed the restart.
    host.livePids.delete(4242);
    const finished = await update(service(deps, 13));

    expect(finished).toMatchObject({ upToDate: false, restarted: true, stagesChanged: true });
    expect(host.restarted).toEqual(["hermeticd.service"]);
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  test("`--check` after the crash reports the pending restart and clears nothing", async () => {
    const { host, deps } = await interrupted(21);

    const checked = await update({ ...deps, pid: 777 }, { check: true });

    expect(checked).toMatchObject({ restartPending: true, restarted: false, upToDate: false });
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(true);
  });

  test("a second crash in the same place leaves the same obligation, not a weaker one", async () => {
    const { host, deps } = await interrupted(31);
    const first = intentOf(host);
    crashWriting(host, /^\/opt\/hermetic\/stages\/\./, 1);

    await expect(update(service(deps, 32))).rejects.toThrow(/EIO/);

    // Rewritten by the resume, and saying exactly what it said before: same
    // target, same rollback point, same restart owed.
    expect(intentOf(host)).toMatchObject({
      target: "0.2.0",
      sha256: first?.sha256 ?? "",
      previous_sha256: sha256Of(BINARY),
      restart_owed: true,
    });
    expect(host.restarted).toEqual([]);

    const third = await update(service(deps, 33));

    expect(third).toMatchObject({ restarted: true, stagesChanged: true });
    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
  });

  /**
   * The hand-off at the end of a resume: the swap marker is written and the
   * intent cleared in the same breath, *before* the restart, so a restart that
   * fails is the marker's to retry. Two records both owing one restart is the
   * case that walks a healthy release into the crash-loop rollback, so the
   * intent going away here is the point, not an omission.
   */
  test("a resume whose restart fails hands the obligation to the swap marker", async () => {
    const { host, deps } = await interrupted(41);
    let asked = 0;
    host.handlers.push((argv) => {
      if (argv[0] !== "systemctl" || argv[1] !== "restart") return null;
      asked += 1;
      return asked === 1
        ? { code: 1, stdout: "", stderr: "Failed to restart hermeticd.service: unit is masked" }
        : { code: 0, stdout: "", stderr: "" };
    });

    await expect(update(service(deps, 42))).rejects.toThrow(/systemctl exited 1/);

    expect(host.files.has(UPDATE_INTENT_PATH)).toBe(false);
    expect(stateOf(host).swap).toMatchObject({
      target: "0.2.0",
      swapped_by_pid: 42,
      previous_sha256: sha256Of(BINARY),
    });

    const retried = await update(service(deps, 42));

    // Asked twice, and the second one took: the handler above answers
    // `systemctl` itself, so the restart is counted here rather than by the
    // fake's own bookkeeping.
    expect(retried).toMatchObject({ restartPending: true, restarted: true });
    expect(asked).toBe(2);
  });
});
