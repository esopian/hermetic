/**
 * A Hermes version change on a box that already runs one (`apply/hermes-upgrade.ts`):
 * verified stop, backup before the checkout moves, restore on a downgrade,
 * rollback when the install fails after the checkout moved, and every retry
 * after a crash reusing the first backup. Run through `apply` on the fake box.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ApplyRequest, FleetManifest } from "@hermetic/core/schema";
import { HERMES_OLD_VERSION_RUNNING, browserBuildKey, hermesBundleKey } from "@hermetic/core/schema";
import { HERMETIC_RENDERED_MARKER, apply, resetAptIndexState } from "../src/apply/index.ts";
import { APPLY_PENDING_PATH } from "../src/apply-pending.ts";
import { HERMES_INSTALL_STAMP, uvRelease } from "../src/apply/hermes.ts";
import {
  BUILD_SWAP,
  PNPM_NODE_VERSION,
  PREFETCH_DIR,
  nodeArch,
  pnpmRelease,
} from "../src/apply/node-web.ts";
import { FLEET_CACHE_PATH, STATE_DIR } from "../src/fleet.ts";
import { APPLY_LOCK_PATH } from "../src/install-lock.ts";
import { HERMES_BACKUP_ROOT } from "../src/apply/hermes-backup.ts";
import { HERMES_PREVIOUS_ROOT } from "../src/apply/hermes-previous.ts";
import {
  HERMES_GATE_POLL_MS,
  HERMES_GATE_STABLE_MS,
  HERMES_GATE_TIMEOUT_MS,
  HERMES_HOLD_PATH,
  HERMES_SWAP_PATH,
  hermesHeld,
  holdDropIn,
} from "../src/apply/hermes-upgrade.ts";
import { APPLIED_CONFIG_PATH, MANIFEST_PATH } from "../src/manifest.ts";
import { makeAws } from "../src/aws.ts";
import { HERMES_ROLLED_BACK_PATH, convergeOnce, heldResumeRequest } from "../src/converge.ts";
import { RESUME_RETRY_MS, ensureOomPolicy, oomDropIn, runConvergeLoop } from "../src/daemon.ts";
import { makeRequestGate } from "../src/request-gate.ts";
import { AgentdError } from "../src/errors.ts";
import { withUpgradeHistory } from "../src/events.ts";
import { run } from "../src/main.ts";
import { USER_DATA_JSON_PATH } from "../src/userdata.ts";
import { captureOutput } from "./quiet.ts";
import { expectNotRan, ranInOrder, unwrapped } from "./fake-host.ts";
import { BoxHost } from "./fake-box.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_BUCKET,
  TEST_CHROME_REF,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  makeFleetManifest,
  makeManifest,
  makeUserDataJson,
  sha256Of,
} from "./fixtures.ts";

const DIR = "/usr/local/lib/hermes-agent";
const VENV = `${DIR}/venv`;
const HOME = "/data/hermes/.hermes";
const DB = `${HOME}/state.db`;
const OLD = { hermes_ref: "v0.21.5", hermes_version: "0.21.5" };
const NEW = { hermes_ref: "v0.23.1", hermes_version: "0.23.1" };
const UNITS = ["hermes-dashboard.service", "hermes-gateway.service"];
const LEGACY_PIP = `uv pip install --python ${VENV}/bin/python -e ${DIR}[all,messaging,bedrock]`;
/** Anything that moves the checkout. A fetch only stores objects: the pre-fetch runs one before the hold. */
const CHECKOUT_MOVES = /^git (clone|-C \S+ checkout)/;

let host: BoxHost;

beforeEach(() => {
  host = new BoxHost();
  resetAptIndexState();
  host.hermesVersionByRef.set(OLD.hermes_ref, OLD.hermes_version);
  host.hermesVersionByRef.set(NEW.hermes_ref, NEW.hermes_version);
  host.hermesStampRefs.add(NEW.hermes_ref);
});

const sqlite = (body: string): Uint8Array => new TextEncoder().encode(`SQLite format 3\0${body}`);
const dbBody = (path = DB): string | undefined => host.files.get(path)?.content.slice(16);

/** A box running `pin` with Hermes state in its home, its units up, and the clock moved on. */
async function boxOn(pin: typeof OLD, state: string): Promise<void> {
  await apply(makeManifest(pin), { host });
  writeState(state);
}

/** What Hermes writes while it runs. */
function writeState(state: string): void {
  host.seedBytes(DB, sqlite(state), "0600");
  const file = host.files.get(DB);
  if (file) file.ownership = "hermes:hermes";
  host.advance(60_000);
}

function backups(): string[] {
  return [...host.dirs]
    .filter((d) => d.startsWith(`${HERMES_BACKUP_ROOT}/hermes-`))
    .filter((d) => d.lastIndexOf("/") === HERMES_BACKUP_ROOT.length)
    .sort();
}

function movedAside(): string[] {
  return [...host.dirs]
    .filter((d) => d.startsWith(`${HERMES_BACKUP_ROOT}/post-`))
    .filter((d) => d.lastIndexOf("/") === HERMES_BACKUP_ROOT.length)
    .sort();
}

/** Whether the Hermes units are held: their hold drop-ins honour `HERMES_HOLD_PATH` while it exists. */
const held = (): boolean => host.files.has(HERMES_HOLD_PATH);
/** Whether the checkout is on the new Hermes: a fault scripted for it spares the old one a rollback starts. */
const onNew = (): boolean => host.hermesCheckedOutRef === NEW.hermes_ref;
/** What a reboot does with an enabled unit: start it, unless its condition says not to. */
async function boot(): Promise<void> {
  for (const unit of UNITS) await host.exec(["systemctl", "start", unit]);
}

/** An apply hermeticd does not survive: whatever it threw, it is gone. */
async function crashed(pin: typeof OLD): Promise<void> {
  expect(
    await apply(makeManifest(pin), { host }).then(
      () => null,
      (e: unknown) => e,
    ),
  ).toBeInstanceOf(Error);
}

async function failure(pin: typeof OLD): Promise<AgentdError> {
  const err = await apply(makeManifest(pin), { host }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AgentdError);
  return err as AgentdError;
}

/**
 * hermeticd dying at the first command matching `pattern`: that command and
 * everything after it fails, so no catch or finally gets anything done on
 * the box (`after`: that command still runs). `revive` brings the process
 * back for the retry.
 */
function dieAt(pattern: RegExp, after = false): { revive: () => void } {
  let dead = false;
  const kill = (): Error | null => (dead ? new Error("hermeticd is dead") : null);
  host.execFaults.push((argv) => {
    if (!dead && pattern.test(unwrapped(argv).join(" "))) {
      dead = true;
      if (after) return null;
    }
    return kill();
  });
  host.writeFaults.push(kill);
  host.fsFaults.push(kill);
  return {
    revive: () => {
      dead = false;
      host.execFaults.length = 0;
      host.writeFaults.length = 0;
      host.fsFaults.length = 0;
    },
  };
}

describe("before the checkout moves", () => {
  test("stop fails (unit stays active) -> HERMES_UNITS_ACTIVE, no checkout change, units restarted", async () => {
    await boxOn(OLD, "old sessions");
    host.stuckUnits.add("hermes-gateway.service");
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UNITS_ACTIVE");
    expect(err.detail["units"]).toEqual([{ unit: "hermes-gateway.service", state: "active" }]);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect(backups()).toEqual([]);
    // Both were running before, so both are started again, the hold lifted first.
    expect(host.commandsMatching(/^systemctl start /)).toEqual(
      UNITS.map((u) => `systemctl start ${u}`),
    );
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(host.skippedStarts).toEqual([]);
    expect(held()).toBe(false);
  });

  /**
   * Canary qa23-up, 2026-11-17: a laptop re-rendered a row put back on 0.21.5
   * with this build's ref, and the box swapped to v0.23.1 labelled 0.21.5 —
   * the stamp it wrote made `hermes --version` agree. A release tag is one version.
   */
  test("a release tag naming another version is refused before anything stops", async () => {
    const LEGACY = { hermes_ref: "v2026.9.24", hermes_version: "0.21.5" };
    host.hermesVersionByRef.set(LEGACY.hermes_ref, LEGACY.hermes_version);
    await boxOn(LEGACY, "old sessions");
    host.commands.length = 0;

    const err = await failure({ hermes_ref: NEW.hermes_ref, hermes_version: LEGACY.hermes_version });

    expect(err.code).toBe("MANIFEST_REFUSED");
    expect(host.commandsMatching(/^git |^systemctl (stop|mask) /)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(LEGACY.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${LEGACY.hermes_ref}\n`);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(backups()).toEqual([]);
    expect(dbBody()).toBe("old sessions");
    expect(held()).toBe(false);
  });

  test("a box already mixed (v0.23.1 stamped 0.21.5) is refused, not read as pinned", async () => {
    const MIXED = { hermes_ref: NEW.hermes_ref, hermes_version: "0.21.5" };
    await boxOn(NEW, "new sessions");
    // What the earlier hermeticd wrote for the mixed manifest: the new checkout, stamped old.
    const stamp = host.files.get(HERMES_INSTALL_STAMP)!;
    const old = { ...JSON.parse(stamp.content), baseVersion: "0.21.5", displayVersion: "0.21.5" };
    host.files.set(HERMES_INSTALL_STAMP, { ...stamp, content: `${JSON.stringify(old, null, 2)}\n` });
    host.commands.length = 0;

    const err = await failure(MIXED);

    expect(err.code).toBe("MANIFEST_REFUSED");
    expect(
      host.commandsMatching(/^git (clone|-C \S+ (checkout|fetch))|^systemctl (stop|mask) /),
    ).toEqual([]);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("backup invalid -> no checkout change", async () => {
    await boxOn(OLD, "old sessions");
    // The copy lands different from its source, so it never validates.
    host.copyCorruptions.push((_from, to, bytes) =>
      to.includes("/.staging-") ? new TextEncoder().encode("torn") : bytes,
    );
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_BACKUP_FAILED");
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(backups()).toEqual([]);
    expect(dbBody()).toBe("old sessions");
    expect(host.commandsMatching(/^systemctl start /)).toEqual(
      UNITS.map((u) => `systemctl start ${u}`),
    );
    expect(held()).toBe(false);
  });

  test("a failure just after the gate record is written drops it with the old Hermes restarted", async () => {
    await boxOn(OLD, "old sessions");
    const emit = (e: { message: string }): void => {
      if (e.message.startsWith("backed up hermes")) throw new Error("emit failed");
    };

    const err = await apply(makeManifest(NEW), { host, emit }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    // Left, the next apply would reuse a backup the restarted old Hermes has written past.
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(backups().every((b) => host.files.has(`${b}/sealed.json`))).toBe(true);
    expect(held()).toBe(false);
  });
});

describe("forward", () => {
  test("forward upgrade takes the backup before the checkout moves", async () => {
    await boxOn(OLD, "old sessions");
    const atCheckout: string[][] = [];
    host.when(/checkout --detach /, () => {
      atCheckout.push(backups());
      return null;
    });
    host.commands.length = 0;

    await apply(makeManifest(NEW), { host });

    expect(atCheckout).toHaveLength(1);
    expect(atCheckout[0]).toHaveLength(1);
    const [backup] = backups();
    expect(backup).toStartWith(`${HERMES_BACKUP_ROOT}/hermes-v0.21.5-`);
    expect(dbBody(`${backup}/home/state.db`)).toBe("old sessions");
    expect(
      ranInOrder(host, [
        // The pre-fetch, while Hermes still runs, then the hold.
        /^git -C \S+ fetch /,
        "systemctl daemon-reload",
        "systemctl stop hermes-dashboard.service",
        "systemctl is-active hermes-gateway.service",
        `git -C ${DIR} rev-parse HEAD`,
        /^git -C \S+ checkout --detach [0-9a-f]{40}$/,
        "systemctl restart hermes-dashboard.service",
        // The runtime gate: the gateway steady and the dashboard on the new version.
        /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway.service$/,
        /^curl -fsS --max-time 3 http:\/\/127\.0\.0\.1:\d+\/api\/health$/,
      ]),
    ).toBe(true);
    // The swap settled: the backup stays restorable but is never reused.
    expect(host.files.has(`${backup}/sealed.json`)).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(held()).toBe(false);
  });

  test("retry reuses the first backup", async () => {
    await boxOn(OLD, "old sessions");
    // After the backup, at the checkout's first move.
    const crash = dieAt(/^git -C \S+ checkout /);
    await crashed(NEW);
    crash.revive();
    const first = backups();
    expect(first).toHaveLength(1);
    host.advance(3_600_000);

    await apply(makeManifest(NEW), { host });

    expect(backups()).toEqual(first);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
  });

  test("crash after checkout, retry completes with the first backup", async () => {
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^uv sync /);
    await crashed(NEW);
    crash.revive();
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    // Left as a dead process leaves it: held, so even a reboot does not start
    // Hermes on the half-installed checkout.
    expect(held()).toBe(true);
    await boot();
    expect(host.skippedStarts).toEqual(UNITS);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);
    const first = backups();
    host.advance(3_600_000);

    await apply(makeManifest(NEW), { host });

    expect(backups()).toEqual(first);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${NEW.hermes_ref}\n`);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("post-swap gate fails -> state restored, old checkout reinstalled, units on old version, HERMES_UPGRADE_ROLLED_BACK", async () => {
    await boxOn(OLD, "old sessions");
    // The new install fails after the checkout moved, having touched the state.
    host.when(/^uv sync /, () => {
      writeState("migrated by 0.23");
      return { code: 1, stderr: "resolver failed" };
    });
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect((err.detail["cause"] as { code: string }).code).toBe("COMMAND_FAILED");
    const [backup] = backups();
    expect(err.detail["backup"]).toBe(backup);
    const [aside] = movedAside();
    expect(err.detail["moved_aside"]).toBe(aside);
    // The state is the backup's; what was found is moved aside, not deleted.
    expect(dbBody()).toBe("old sessions");
    expect(dbBody(`${aside}/home/state.db`)).toBe("migrated by 0.23");
    // The old checkout and its set-aside venv, back without the network or a reinstall.
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(
      ranInOrder(host, [
        /^uv sync /,
        /^git -C \S+ checkout --detach [0-9a-f]{40}$/,
        "/usr/local/bin/hermes --version",
        "systemctl start hermes-dashboard.service",
      ]),
    ).toBe(true);
    const rollback = host.commands.slice(host.commands.findLastIndex((c) => /^uv sync /.test(c)));
    expect(rollback.filter((c) => /^uv (venv|pip install) /.test(c))).toEqual([]);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
    expect(host.files.has(HERMES_INSTALL_STAMP)).toBe(false);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });
});

describe("downgrade", () => {
  test("downgrade with backup restores before the old Hermes runs", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    const seen: Array<string | undefined> = [];
    host.when(/^\/usr\/local\/bin\/hermes --version/, () => {
      if (host.hermesCheckedOutRef === OLD.hermes_ref) seen.push(dbBody());
      return null;
    });
    host.commands.length = 0;

    await apply(makeManifest(OLD), { host });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((body) => body === "old sessions")).toBe(true);
    const [aside] = movedAside();
    expect(aside).toStartWith(`${HERMES_BACKUP_ROOT}/post-v0.23.1-`);
    expect(dbBody(`${aside}/home/state.db`)).toBe("written by 0.23");
    expect(host.commandsMatching(/^git -C \S+ fetch /)).toHaveLength(1);
    // The 0.23 stamp git left behind is gone from the 0.21 checkout.
    expect(host.files.has(HERMES_INSTALL_STAMP)).toBe(false);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("downgrade without backup -> refused, nothing changed", async () => {
    await boxOn(NEW, "born on 0.23");
    host.commands.length = 0;

    const err = await failure(OLD);

    expect(err.code).toBe("HERMES_RESTORE_REFUSED");
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(dbBody()).toBe("born on 0.23");
    expect(movedAside()).toEqual([]);
    expect(host.commandsMatching(/^systemctl start /)).toEqual(
      UNITS.map((u) => `systemctl start ${u}`),
    );
    expect(held()).toBe(false);
  });

  /** A restore stopped after its move-aside leaves an intent and no completion, crash or not. */
  test("a restore that stopped midway is finished by the retry from the same backup", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    // The first file the restore copies back fails to land.
    host.writeFaults.push((path) => (path === DB ? new Error("EIO") : null));
    const err = await failure(OLD);
    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(err.detail["moved_aside"]).toStartWith(`${HERMES_BACKUP_ROOT}/post-v0.23.1-`);
    // State half moved: nothing may start on it.
    expect(host.commandsMatching(/^systemctl start /)).toEqual([]);
    host.writeFaults.length = 0;
    host.advance(60_000);

    await apply(makeManifest(OLD), { host });

    expect(dbBody()).toBe("old sessions");
    const asides = movedAside();
    expect(asides).toHaveLength(2);
    // The first holds the 0.23 state it moved; it is marked superseded, never deleted.
    expect(dbBody(`${asides[0]}/home/state.db`)).toBe("written by 0.23");
    expect(host.files.get(`${asides[0]}/restore.json`)?.content).toContain(asides[1] as string);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
  });

  /**
   * A crashed restore, then the retry that finished it, with the first one's
   * supersede mark lost (a crash after the retry's completion record, or the
   * best-effort write failing), and the downgrade's gate passed since.
   */
  async function finishedRestoreWithLostMark(): Promise<string[]> {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    host.writeFaults.push((path) => (path === DB ? new Error("EIO") : null));
    expect((await failure(OLD)).code).toBe("HERMES_RESTORE_FAILED");
    host.writeFaults.length = 0;
    host.advance(60_000);
    await apply(makeManifest(OLD), { host });
    const asides = movedAside();
    expect(asides).toHaveLength(2);
    host.files.delete(`${asides[0]}/restore.json`);
    writeState("written by 0.21 since");
    return asides;
  }

  test("a crashed restore, a finished one whose supersede mark was lost, then the same ref with a new config: no restore, state untouched", async () => {
    const asides = await finishedRestoreWithLostMark();
    host.commands.length = 0;

    await apply({ ...makeManifest(OLD), config_hash: "c0nfn3w4" }, { host });

    expect(dbBody()).toBe("written by 0.21 since");
    expect(movedAside()).toEqual(asides);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(held()).toBe(false);
  });

  test("a crashed restore, a finished one whose supersede mark was lost, then an upgrade: a forward swap from the current state", async () => {
    const asides = await finishedRestoreWithLostMark();
    const THIRD = { hermes_ref: "v0.24.0", hermes_version: "0.24.0" };
    host.hermesVersionByRef.set(THIRD.hermes_ref, THIRD.hermes_version);
    host.hermesStampRefs.add(THIRD.hermes_ref);
    const before = backups();

    await apply(makeManifest(THIRD), { host });

    expect(dbBody()).toBe("written by 0.21 since");
    expect(movedAside()).toEqual(asides);
    const taken = backups().filter((b) => !before.includes(b));
    expect(taken).toHaveLength(1);
    expect(dbBody(`${taken[0]}/home/state.db`)).toBe("written by 0.21 since");
    expect(host.hermesCheckedOutRef).toBe(THIRD.hermes_ref);
    expect(held()).toBe(false);
  });

  test("a downgrade whose restore finished and whose install failed, then the newer pin again: refused, never started on the older state", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    const failing = host.when(/^uv (sync|pip install) /, () =>
      onNew() ? null : { code: 1, stderr: "resolver failed" },
    );
    expect((await failure(OLD)).code).toBe("HERMES_RESTORE_FAILED");
    failing();
    expect(dbBody()).toBe("old sessions");
    host.advance(60_000);
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(err.detail["restored_for"]).toBe(OLD.hermes_ref);
    expect(host.commandsMatching(/^systemctl start /)).toEqual([]);
    expect(held()).toBe(true);
    expect(dbBody()).toBe("old sessions");
    expect(dbBody(`${movedAside()[0]}/home/state.db`)).toBe("written by 0.23");
  });

  /** A downgrade to OLD whose restore stopped midway, then NEW pinned again. */
  async function restoreStoppedThenNewPinned(): Promise<AgentdError> {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    host.writeFaults.push((path) => (path === DB ? new Error("EIO") : null));
    expect((await failure(OLD)).code).toBe("HERMES_RESTORE_FAILED");
    host.writeFaults.length = 0;
    host.advance(60_000);
    host.commands.length = 0;
    return await failure(NEW);
  }

  test("a restore that stopped midway, then the newer pin again: the restore is finished, the newer Hermes refused on it, held, and refused again on the next apply", async () => {
    const err = await restoreStoppedThenNewPinned();

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(err.detail["restored_for"]).toBe(OLD.hermes_ref);
    // Whole again, as the backup had it; the 0.23 state is whole where the first attempt moved it.
    expect(dbBody()).toBe("old sessions");
    const asides = movedAside();
    expect(asides).toHaveLength(2);
    expect(err.detail["moved_aside"]).toBe(asides[0]);
    expect(dbBody(`${asides[0]}/home/state.db`)).toBe("written by 0.23");
    expect(host.commandsMatching(/^systemctl start /)).toEqual([]);
    expect(held()).toBe(true);
    await boot();
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);

    host.commands.length = 0;
    const again = await failure(NEW);
    expect(again.code).toBe("HERMES_RESTORE_FAILED");
    expect(again.detail["restored_for"]).toBe(OLD.hermes_ref);
    expect(host.commandsMatching(/^systemctl start /)).toEqual([]);
    expect(held()).toBe(true);
    expect(dbBody()).toBe("old sessions");
  });

  test("a restore that stopped midway, refused under the newer pin, then the older pin: the downgrade finishes on the restored state and is gated", async () => {
    await restoreStoppedThenNewPinned();
    host.commands.length = 0;

    await apply(makeManifest(OLD), { host });

    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(dbBody()).toBe("old sessions");
    // Nothing restored a third time.
    expect(movedAside()).toHaveLength(2);
    expect(host.commandsMatching(/api\/health/).length).toBeGreaterThan(0);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });

  describe("within one major.minor", () => {
    const PATCH = { hermes_ref: "v0.23.2", hermes_version: "0.23.2" };
    beforeEach(() => {
      host.hermesVersionByRef.set(PATCH.hermes_ref, PATCH.hermes_version);
      host.hermesStampRefs.add(PATCH.hermes_ref);
    });

    test("a patch-level downgrade after the gate passed moves the checkout and restores nothing", async () => {
      await boxOn(NEW, "sessions on 0.23.1");
      await apply(makeManifest(PATCH), { host });
      expect(backups()).toHaveLength(1);
      writeState("written by 0.23.2");

      await apply(makeManifest(NEW), { host });

      expect(dbBody()).toBe("written by 0.23.2");
      expect(movedAside()).toEqual([]);
      expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
      expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.23.1");
      expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
      expect(held()).toBe(false);
    });

    test("a patch-level upgrade still takes a backup, and its automatic rollback restores it", async () => {
      await boxOn(NEW, "sessions on 0.23.1");
      host.when(/^uv sync /, () => {
        // Only the new install fails: the rollback reinstalls 0.23.1 with the same recipe.
        if (host.hermesCheckedOutRef !== PATCH.hermes_ref) return null;
        writeState("touched by 0.23.2");
        return { code: 1, stderr: "resolver failed" };
      });

      const err = await failure(PATCH);
      expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
      const [backup] = backups();
      expect(backup).toStartWith(`${HERMES_BACKUP_ROOT}/hermes-v0.23.1-`);
      expect(dbBody()).toBe("sessions on 0.23.1");
      expect(dbBody(`${movedAside()[0]}/home/state.db`)).toBe("touched by 0.23.2");
      expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    });
  });
});

describe("a stale git index lock", () => {
  test("left by a git killed mid-checkout is removed before the checkout moves", async () => {
    await boxOn(OLD, "old sessions");
    const lock = `${DIR}/.git/index.lock`;
    host.seed(lock, "");
    host.when(/ checkout --detach /, () =>
      host.files.has(lock)
        ? { code: 128, stderr: `fatal: Unable to create '${lock}': File exists.` }
        : null,
    );

    await apply(makeManifest(NEW), { host });

    expect(host.files.has(lock)).toBe(false);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
  });
});

describe("no version change", () => {
  test("old-pin reapply under the new hermeticd: missing venv repaired with the legacy recipe, no backup taken", async () => {
    await boxOn(OLD, "old sessions");
    for (const path of [...host.files.keys()]) if (path.startsWith(`${VENV}/`)) host.files.delete(path);
    await host.remove(`${DIR}/.hermetic-extras`);
    host.commands.length = 0;

    await apply(makeManifest(OLD), { host });

    expect(host.commandsMatching(/^uv (venv|pip|sync) (?!--no-config)/)).toEqual([
      `uv venv --python 3.11 ${VENV}`,
      LEGACY_PIP,
    ]);
    expectNotRan(host, /^systemctl (mask|is-active hermes)/);
    // The worker scopes are stopped only inside a swap.
    expectNotRan(host, /^systemctl --user /);
    expect(backups()).toEqual([]);
    expect(host.files.has(HERMES_INSTALL_STAMP)).toBe(false);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
  });

  test("same-ref reapply takes no backup, holds nothing and runs no gate", async () => {
    await boxOn(NEW, "sessions");
    host.commands.length = 0;
    await apply(makeManifest(NEW), { host });
    // …and a same-ref reinstall (an extras change) neither.
    await host.remove(`${DIR}/.hermetic-extras`);
    await apply(makeManifest(NEW), { host });

    expect(host.commandsMatching(/^uv sync /)).toHaveLength(1);
    expect(host.files.has(holdDropIn("hermes-gateway.service"))).toBe(false);
    expectNotRan(host, /api\/health|^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway/);
    expect(backups()).toEqual([]);
    expect(dbBody()).toBe("sessions");
  });
});

describe("the runtime gate", () => {
  const SHOW_GATEWAY = /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/;
  const gatewayAs = (states: () => string): void => {
    host.when(SHOW_GATEWAY, () => (onNew() ? { stdout: states() } : null));
  };
  /** The new Hermes migrates the stores as it starts. */
  const migratesOnStart = (): void => {
    host.when(/^systemctl restart hermes-gateway\.service$/, () => {
      if (host.hermesCheckedOutRef === NEW.hermes_ref) writeState("migrated by 0.23");
      return null;
    });
  };

  test("gateway never becomes active after a swap -> rolled back to the old ref, pre-upgrade state restored, units up on the old version", async () => {
    await boxOn(OLD, "old sessions");
    // What a converge leaves: the configuration this box last applied, whose
    // dashboard unit is told apart from the new one's.
    const previous = makeManifest(OLD);
    const files = previous.files.map((f) =>
      f.path.endsWith("/hermes-dashboard.service")
        ? { ...f, content: `${f.content}# pinned 0.21.5\n` }
        : f,
    );
    host.seed(MANIFEST_PATH, JSON.stringify({ ...previous, files }));
    migratesOnStart();
    gatewayAs(() => "ActiveState=activating\nSubState=start\nNRestarts=0\n");
    const started = host.now().getTime();

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect((err.detail["cause"] as { detail: { reason: string } }).detail.reason).toBe("timeout");
    expect(host.now().getTime() - started).toBeGreaterThanOrEqual(HERMES_GATE_TIMEOUT_MS);
    expect(dbBody()).toBe("old sessions");
    const [aside] = movedAside();
    expect(dbBody(`${aside}/home/state.db`)).toBe("migrated by 0.23");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    // The old configuration re-applied, so the units match the version they run.
    expect(host.files.get("/etc/systemd/system/hermes-dashboard.service")?.content).toContain(
      "pinned 0.21.5",
    );
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
  });

  test("slow-but-healthy start within budget -> no rollback, backup sealed after", async () => {
    await boxOn(OLD, "old sessions");
    let polls = 0;
    const sealedDuringGate: boolean[] = [];
    gatewayAs(() => {
      polls += 1;
      sealedDuringGate.push(backups().some((b) => host.files.has(`${b}/sealed.json`)));
      // Two minutes of migration before the gateway settles.
      return polls <= 24
        ? "ActiveState=activating\nSubState=start\nNRestarts=0\n"
        : "ActiveState=active\nSubState=running\nNRestarts=0\n";
    });
    const started = host.now().getTime();

    await apply(makeManifest(NEW), { host });

    expect(host.now().getTime() - started).toBeGreaterThanOrEqual(120_000 + HERMES_GATE_STABLE_MS);
    expect(host.now().getTime() - started).toBeLessThan(HERMES_GATE_TIMEOUT_MS);
    expect(movedAside()).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(sealedDuringGate.length).toBeGreaterThan(24);
    expect(sealedDuringGate.every((sealed) => !sealed)).toBe(true);
    const [backup] = backups();
    expect(host.files.has(`${backup}/sealed.json`)).toBe(true);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
  });

  /** The swap's milestones, as `agent history` records them (`withUpgradeHistory`). */
  async function historyOf(pin: typeof OLD): Promise<{ details: string[]; error: unknown }> {
    const details: string[] = [];
    const record = (_action: string, detail: string): Promise<void> => {
      details.push(detail);
      return Promise.resolve();
    };
    const error = await apply(makeManifest(pin), {
      host,
      emit: withUpgradeHistory(() => {}, record),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    // The records are queued behind each other; let the queue drain.
    await Bun.sleep(0);
    return { details, error };
  }

  test("a passing upgrade records hold, backup, gate and seal in order, with the backup path readable", async () => {
    await boxOn(OLD, "old sessions");

    const { details, error } = await historyOf(NEW);

    expect(error).toBeNull();
    const [backup] = backups();
    expect(backup).toMatch(/\/hermes-v0\.21\.5-\d{8}T\d{6}Z$/);
    expect(details).toEqual([
      `held ${UNITS.join(", ")} to move hermes from ${OLD.hermes_ref} to ${NEW.hermes_ref}`,
      expect.stringMatching(
        new RegExp(`^backed up hermes ${OLD.hermes_ref}: \\d+ file\\(s\\) in ${backup}$`),
      ),
      `runtime gate started for hermes ${NEW.hermes_version}`,
      `runtime gate passed: hermes ${NEW.hermes_version} is up`,
      `sealed the hermes backup ${backup}`,
    ]);
  });

  test("a gate failure records gate failed, then rolled back, with the backup path", async () => {
    await boxOn(OLD, "old sessions");
    gatewayAs(() => "ActiveState=failed\nSubState=failed\nNRestarts=0\n");

    const { details, error } = await historyOf(NEW);

    expect((error as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    const [backup] = backups();
    const failed = details.findIndex((d) =>
      d.startsWith(`runtime gate failed for hermes ${NEW.hermes_version}: `),
    );
    const rolled = details.findIndex((d) => d.startsWith(`rolled back to hermes ${OLD.hermes_ref}: `));
    expect(failed).toBeGreaterThan(-1);
    expect(details[failed]).toContain("(failed)");
    expect(rolled).toBeGreaterThan(failed);
    expect(details[rolled]).toContain(`state restored from ${backup}`);
    expect(details.some((d) => d.startsWith("sealed"))).toBe(false);
  });

  test("restart count climbing -> early rollback", async () => {
    await boxOn(OLD, "old sessions");
    let restarts = 0;
    gatewayAs(() => `ActiveState=activating\nSubState=auto-restart\nNRestarts=${restarts++}\n`);
    const started = host.now().getTime();

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect((err.detail["cause"] as { detail: { reason: string } }).detail.reason).toBe("crash-loop");
    expect(host.now().getTime() - started).toBeLessThan(60_000);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    // No previous configuration on disk: the units start on the old install alone.
    expect(host.commandsMatching(/^systemctl start hermes-gateway\.service$/)).toHaveLength(1);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("a failure after the checkout moved but before the gate (the web build) is rolled back too", async () => {
    await boxOn(OLD, "old sessions");
    host.when(/node-deps\.mjs/, { code: 1, stderr: "ERR_PNPM_FETCH_503" });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(dbBody()).toBe("old sessions");
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("same-ref reapply -> no gate", async () => {
    await boxOn(NEW, "sessions");
    host.commands.length = 0;
    await apply(makeManifest(NEW), { host });
    expectNotRan(host, SHOW_GATEWAY);
    expectNotRan(host, /api\/health/);
  });

  test("fresh box -> no gate", async () => {
    await apply(makeManifest(NEW), { host });
    expectNotRan(host, SHOW_GATEWAY);
    expectNotRan(host, /api\/health/);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
  });
});

describe("re-pinned after a crash", () => {
  /** A forward swap that died after its checkout and stamp moved, and a 0.23 that then ran. */
  async function crashedForwardThenRan(): Promise<void> {
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^uv sync /);
    await crashed(NEW);
    crash.revive();
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    writeState("migrated by a 0.23 that ran");
  }

  test("the marker names the old ref but the checkout is 0.23: a downgrade that restores", async () => {
    await crashedForwardThenRan();

    await apply(makeManifest(OLD), { host });

    expect(dbBody()).toBe("old sessions");
    const [aside] = movedAside();
    expect(aside).toStartWith(`${HERMES_BACKUP_ROOT}/post-0.23.1-`);
    expect(dbBody(`${aside}/home/state.db`)).toBe("migrated by a 0.23 that ran");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
  });

  test("…and refuses, changing nothing, when there is no backup to restore", async () => {
    await crashedForwardThenRan();
    await host.remove(HERMES_BACKUP_ROOT);

    const err = await failure(OLD);

    // The checkout is already past its marker: not "the old version still runs".
    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(dbBody()).toBe("migrated by a 0.23 that ran");
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(movedAside()).toEqual([]);
  });
});

/**
 * A crash or power cut mid-swap, then `hermeticd serve` starting again. The
 * converge loop is handed `heldResumeRequest` before its first wait, so the
 * box re-applies whatever its row names even when no `apply_request` arrives
 * and even when the row names the config it last recorded as applied.
 */
describe("daemon start after a crash mid-swap", () => {
  const OLD_CONFIG = { ...makeManifest(OLD), config_hash: "c0nf0ld1" };
  const NEW_CONFIG = { ...makeManifest(NEW), config_hash: "c0nfn3w2" };

  /** The fleet as the row and the bucket describe it now. */
  function fleet(rowConfig: typeof OLD_CONFIG, applyRequest?: ApplyRequest) {
    const ddb = new RecordingSink();
    ddb.byCommand.set("GetCommand", () => ({
      Item: {
        name: TEST_NAME,
        status: "ready",
        version: 3,
        resources: { config_key: `config/${TEST_NAME}/${rowConfig.config_hash}.tgz`, ssm_paths: [] },
        ...(applyRequest ? { apply_request: applyRequest } : {}),
      },
    }));
    ddb.byCommand.set("UpdateCommand", () => ({}));
    ddb.byCommand.set("PutCommand", () => ({}));
    const s3 = new RecordingSink();
    s3.byCommand.set("GetObjectCommand", () => ({
      Body: new TextEncoder().encode(JSON.stringify({ manifest: rowConfig })),
    }));
    const aws = makeAws({
      ddb,
      ssm: new RecordingSink(),
      s3,
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => host.now(),
    });
    return {
      host,
      aws,
      name: TEST_NAME,
      bucket: TEST_BUCKET,
      paramPrefix: `/hermes/fxtr0001/${TEST_NAME}/`,
    };
  }

  /** `serve` coming up: whatever converge its start owes, no heartbeat, and stop at the first wait. */
  async function daemonStart(
    rowConfig: typeof OLD_CONFIG,
    opts: {
      /** The row's `apply_request`. */
      row?: ApplyRequest;
      /** Handed over before the loop starts, as the first heartbeat after a restart does. */
      deliver?: boolean;
      failures?: Array<{ request_id: string; code: string }>;
    } = {},
  ): Promise<string[]> {
    const deps = fleet(rowConfig, opts.row);
    const failures = opts.failures ?? [];
    const control = new AbortController();
    const events: string[] = [];
    const gate = makeRequestGate<ApplyRequest>();
    if (opts.deliver && opts.row) gate.onRequest(opts.row);
    await runConvergeLoop({
      host,
      gate: { ...gate, wait: async () => control.abort() },
      signal: control.signal,
      run: (request) => convergeOnce(deps, request, async () => false),
      resume: () => heldResumeRequest(host),
      record: async (_action, detail) => {
        events.push(detail);
      },
      reportFailure: async (request, code) => {
        failures.push({ request_id: request.id, code });
      },
      log: () => {},
    });
    return events;
  }

  const laptop = (id: string, config = NEW_CONFIG): ApplyRequest => ({
    id,
    config_hash: config.config_hash,
    issued_at: host.now().toISOString(),
    issued_by: "test laptop",
  });

  test("nothing held: start owes nothing", async () => {
    await apply(OLD_CONFIG, { host });
    expect(await heldResumeRequest(host)).toBeNull();
  });

  test("hold and swap record present, the row still on the new config -> the swap resumes, is gated, and the hold is released", async () => {
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    const crash = dieAt(/^uv sync /);
    await expect(apply(NEW_CONFIG, { host })).rejects.toThrow();
    crash.revive();
    expect(held()).toBe(true);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(true);

    const events = await daemonStart(NEW_CONFIG);

    expect(events).toEqual([`converged to config ${NEW_CONFIG.config_hash}`]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.commandsMatching(/api\/health/).length).toBeGreaterThan(0);
    expect(held()).toBe(false);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(backups().every((b) => host.files.has(`${b}/sealed.json`))).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("serve's start sets OOMPolicy=continue on hermeticd and its bootstrap unit with drop-ins, reloaded once", async () => {
    expect(await ensureOomPolicy(host)).toBe(true);
    expect(await ensureOomPolicy(host)).toBe(false);
    for (const unit of ["hermeticd.service", "hermeticd-bootstrap.service"]) {
      expect(host.files.get(oomDropIn(unit))?.content).toContain("[Service]\nOOMPolicy=continue\n");
    }
    expect(host.commandsMatching(/^systemctl daemon-reload$/)).toHaveLength(1);
  });

  /**
   * What systemd's default `OOMPolicy=stop` does (qa23-rb, 2026-11-16): the
   * kernel OOM-kills the web build's node, and systemd stops all of
   * `hermeticd.service` with it, so hermeticd never sees exit 137. It restarts,
   * resumes the held swap, rebuilds and is killed again. One resume, then the
   * next start rolls back without building. Killed in the web build (after the
   * ref marker moved) and in the venv install (before it: the record is rewritten).
   */
  for (const [where, step] of [
    ["web build", /^pnpm --filter web run build$/],
    ["venv install", /^uv sync /],
  ] as const) {
    test(`hermeticd killed with every ${where} while held -> one resume, then rolled back with no rebuild: old version up, hold and record gone, reported`, async () => {
      await convergeOnce(fleet(OLD_CONFIG), laptop("laptop-0", OLD_CONFIG), async () => false);
      writeState("old sessions");
      const oom = (): { revive: () => void } => dieAt(step);
      const first = laptop("laptop-1");
      let kill = oom();
      await expect(convergeOnce(fleet(NEW_CONFIG, first), first, async () => false)).rejects.toThrow();
      const failures: Array<{ request_id: string; code: string }> = [];
      const builds: boolean[] = [];
      for (let start = 0; start < 3 && (await hermesHeld(host)); start += 1) {
        kill.revive();
        // The killed process's apply lock: the restarted hermeticd (another pid) finds it stale.
        host.files.delete(APPLY_LOCK_PATH);
        kill = oom();
        const before = host.commandsMatching(step).length;
        await daemonStart(NEW_CONFIG, { row: first, failures }).catch(() => undefined);
        // Reached at all: the fake's dead process goes on issuing (failing) commands.
        builds.push(host.commandsMatching(step).length > before);
      }
      kill.revive();

      expect(builds).toEqual([true, false]);
      // The first start's report is the fake's dead process still reporting; a real one cannot.
      expect(failures.map((f) => f.code)).toEqual(["INTERNAL", "HERMES_UPGRADE_ROLLED_BACK"]);
      expect(failures[1]?.request_id).toStartWith("resume-held-swap-");
      expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
      expect(dbBody()).toBe("old sessions");
      expect(held()).toBe(false);
      expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
      expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
      expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    });
  }

  test("the request is gone (row back on the old config, already recorded as applied) -> restored onto the old version, hold released", async () => {
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    // The new Hermes starts and migrates; the box dies during the gate.
    host.when(/^systemctl restart hermes-gateway\.service$/, () => {
      if (host.hermesCheckedOutRef === NEW.hermes_ref) writeState("migrated by 0.23");
      return null;
    });
    const crash = dieAt(/^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway/);
    await expect(apply(NEW_CONFIG, { host })).rejects.toThrow();
    crash.revive();
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(true);

    const events = await daemonStart(OLD_CONFIG);

    expect(events).toEqual([`converged to config ${OLD_CONFIG.config_hash}`]);
    // Old Hermes never sees the migrated stores: they are moved aside first.
    expect(dbBody()).toBe("old sessions");
    expect(dbBody(`${movedAside()[0]}/home/state.db`)).toBe("migrated by 0.23");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(held()).toBe(false);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("a rolled-back config is not swapped again by the box itself; a new laptop request applies it", async () => {
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    const first = laptop("laptop-1");
    const failing = host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });
    const err = await convergeOnce(fleet(NEW_CONFIG, first), first, async () => false).catch(
      (e: unknown) => e,
    );
    expect((err as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    failing();
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    const taken = backups();
    host.commands.length = 0;

    // hermeticd restarts and the heartbeat hands over the row's request again.
    const failures: Array<{ request_id: string; code: string }> = [];
    const events = await daemonStart(NEW_CONFIG, { row: first, deliver: true, failures });

    expect(events).toHaveLength(1);
    expect(events[0]).toContain(`converge to config ${NEW_CONFIG.config_hash} failed`);
    expect(failures).toEqual([{ request_id: "laptop-1", code: "HERMES_UPGRADE_ROLLED_BACK" }]);
    expectNotRan(host, CHECKOUT_MOVES);
    expectNotRan(host, /^systemctl stop /);
    expect(backups()).toEqual(taken);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);

    // The operator asks again.
    const second = laptop("laptop-2");
    const out = await convergeOnce(fleet(NEW_CONFIG, second), second, async () => false);

    expect(out.kind).toBe("applied");
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.files.has(HERMES_ROLLED_BACK_PATH)).toBe(false);
  });

  /**
   * hermeticd dies while its rollback waits for the old Hermes, which is back on
   * disk. `previous`: the new Hermes's web build fails, and the old configuration
   * is on disk, so the rollback re-applies it; otherwise its install fails.
   */
  async function diesRestartingOld(previous: boolean): Promise<void> {
    if (previous) {
      await convergeOnce(fleet(OLD_CONFIG), laptop("laptop-0", OLD_CONFIG), async () => false);
    } else {
      await apply(OLD_CONFIG, { host });
    }
    writeState("old sessions");
    const first = laptop("laptop-1");
    const failing = previous
      ? host.when(/node-deps\.mjs/, () => (onNew() ? { code: 1, stderr: "ERR_PNPM_FETCH_503" } : null))
      : host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });
    // The checkout, state and markers are back on 0.21; hermeticd dies waiting for it to come up.
    const death = dieAt(/api\/health/);
    await expect(convergeOnce(fleet(NEW_CONFIG, first), first, async () => false)).rejects.toThrow();
    death.revive();
    failing();
    // The dead process's apply lock: a restarted hermeticd (another pid) finds it stale.
    host.files.delete(APPLY_LOCK_PATH);
    expect(host.files.has(HERMES_ROLLED_BACK_PATH)).toBe(false);
    let swapped = false;
    host.when(/^uv sync /, () => {
      if (onNew()) swapped = true;
      return null;
    });

    // hermeticd restarts: its own resume, then the heartbeat hands over the row's request again.
    const failures: Array<{ request_id: string; code: string }> = [];
    await daemonStart(NEW_CONFIG, { row: first, deliver: true, failures });
    await daemonStart(NEW_CONFIG, { row: first, deliver: true, failures });

    expect(swapped).toBe(false);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(failures).toContainEqual({ request_id: "laptop-1", code: "HERMES_UPGRADE_ROLLED_BACK" });
    expect(failures.every((f) => f.code === "HERMES_UPGRADE_ROLLED_BACK")).toBe(true);
    expect(dbBody()).toBe("old sessions");
    expect(await hermesHeld(host)).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  }

  test("a crash while the rollback restarts the old Hermes: the restart finishes the rollback, reports it, and never swaps again", async () => {
    await diesRestartingOld(false);
  });

  test("…and the same when the rollback was re-applying the old configuration", async () => {
    await diesRestartingOld(true);
  });

  test("a rollback whose old Hermes never came up: re-pinning the old config restarts and gates it, never reads as current", async () => {
    await convergeOnce(fleet(OLD_CONFIG), laptop("laptop-0", OLD_CONFIG), async () => false);
    writeState("old sessions");
    host.when(/node-deps\.mjs/, () => (onNew() ? { code: 1, stderr: "ERR_PNPM_FETCH_503" } : null));
    // The old gateway, re-applied by the rollback, crashes after systemd accepted its start.
    const fixed = host.when(
      /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/,
      () => (onNew() ? null : { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=1\n" }),
    );
    const first = laptop("laptop-1");
    const err = await convergeOnce(fleet(NEW_CONFIG, first), first, async () => false).catch(
      (e: unknown) => e,
    );
    expect((err as AgentdError).code).toBe("HERMES_ROLLBACK_FAILED");
    expect((err as AgentdError).detail["old_install_restored"]).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.has(APPLIED_CONFIG_PATH)).toBe(false);

    // The operator pins the old config again: applied, its units restarted and gated.
    host.commands.length = 0;
    const second = laptop("laptop-2", OLD_CONFIG);
    const gated = await convergeOnce(fleet(OLD_CONFIG, second), second, async () => false).catch(
      (e: unknown) => e,
    );
    expect((gated as AgentdError).code).toBe("HERMES_RESTORE_FAILED");
    expect(host.commandsMatching(/^systemctl restart hermes-gateway\.service$/).length).toBe(1);
    expect(host.commandsMatching(/api\/health|systemctl show -p ActiveState/).length).toBeGreaterThan(
      0,
    );
    expect(held()).toBe(true);

    // The same request again is refused, not current.
    const again = await convergeOnce(fleet(OLD_CONFIG, second), second, async () => false).catch(
      (e: unknown) => e,
    );
    expect((again as AgentdError).code).toBe("HERMES_RESTORE_FAILED");

    // Fixed on the box, the next request gates it up.
    fixed();
    const third = laptop("laptop-3", OLD_CONFIG);
    host.advance(1_000);
    expect(
      await convergeOnce(
        fleet(OLD_CONFIG, third),
        { ...third, issued_at: host.now().toISOString() },
        async () => false,
      ),
    ).toMatchObject({
      kind: "applied",
    });
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });

  test("a resume that rolls back is not followed by the row's own request swapping again", async () => {
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    const crash = dieAt(/^uv sync /);
    await expect(apply(NEW_CONFIG, { host })).rejects.toThrow();
    crash.revive();
    host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });

    // `serve` starts: the self-issued resume rolls the swap back, before any
    // heartbeat has handed over the laptop's request still on the row.
    const row = laptop("laptop-1");
    const failures: Array<{ request_id: string; code: string }> = [];
    await daemonStart(NEW_CONFIG, { row, failures });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.request_id).toStartWith("resume-held-swap-");
    expect(failures[0]?.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(held()).toBe(false);
    host.commands.length = 0;

    // That request arrives with the first heartbeat.
    const err = await convergeOnce(fleet(NEW_CONFIG, row), row, async () => false).catch(
      (e: unknown) => e,
    );

    expect((err as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expectNotRan(host, CHECKOUT_MOVES);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("a downgrade whose gate a crash cut, then a third ref rolled back: the box rests, and no re-ask swaps again", async () => {
    const THIRD = { hermes_ref: "v0.24.0", hermes_version: "0.24.0" };
    host.hermesVersionByRef.set(THIRD.hermes_ref, THIRD.hermes_version);
    host.hermesStampRefs.add(THIRD.hermes_ref);
    const THIRD_CONFIG = { ...makeManifest(THIRD), config_hash: "c0nf3rd3" };
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    await apply(NEW_CONFIG, { host });
    writeState("written by 0.23");
    // The downgrade restores, installs and starts the old Hermes; the box dies in its gate.
    const death = dieAt(/api\/health/);
    await expect(apply(OLD_CONFIG, { host })).rejects.toThrow();
    death.revive();
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);

    const req = laptop("laptop-3", THIRD_CONFIG);
    host.when(/^uv sync /, () =>
      host.hermesCheckedOutRef === THIRD.hermes_ref ? { code: 1, stderr: "resolver failed" } : null,
    );
    const err = await convergeOnce(fleet(THIRD_CONFIG, req), req, async () => false).catch(
      (e: unknown) => e,
    );
    expect((err as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(await hermesHeld(host)).toBe(false);
    const taken = backups();
    const aside = movedAside();
    host.commands.length = 0;

    const failures: Array<{ request_id: string; code: string }> = [];
    for (let tick = 0; tick < 3; tick++) {
      host.advance(RESUME_RETRY_MS);
      await daemonStart(THIRD_CONFIG, { row: req, failures });
    }
    expect(failures).toEqual([]);
    expectNotRan(host, CHECKOUT_MOVES);
    expectNotRan(host, /^systemctl stop /);
    expect(backups()).toEqual(taken);
    expect(movedAside()).toEqual(aside);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("a rollback the box cannot record (disk full) is still reported as rolled back, with a warning", async () => {
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });
    host.writeFaults.push((path) =>
      path === HERMES_ROLLED_BACK_PATH ? new Error("ENOSPC: no space left on device") : null,
    );
    const events: Array<{ message: string; level?: string }> = [];
    const request = laptop("laptop-1");

    const err = await convergeOnce(
      { ...fleet(NEW_CONFIG, request), emit: (e) => events.push(e) },
      request,
      async () => false,
    ).catch((e: unknown) => e);

    expect((err as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(events.some((e) => e.level === "warn" && e.message.includes("not recorded"))).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
  });

  describe("a stage's `hermeticd apply` (agent rerun)", () => {
    captureOutput();

    test("a rollback there is recorded too, so the row's request does not swap again", async () => {
      await apply(OLD_CONFIG, { host });
      writeState("old sessions");
      const row = laptop("laptop-1");
      const deps = fleet(NEW_CONFIG, row);
      host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
      host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
      host.seed(MANIFEST_PATH, JSON.stringify(NEW_CONFIG));
      const failing = host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });

      const stage = await run(["apply"], host, { aws: () => deps.aws }).catch((e: unknown) => e);
      expect((stage as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
      failing();
      expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
      host.commands.length = 0;

      const err = await convergeOnce(deps, row, async () => false).catch((e: unknown) => e);

      expect((err as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
      expectNotRan(host, CHECKOUT_MOVES);
    });

    test("never runs beside the daemon's converge: one holds the apply lock, the other waits or defers", async () => {
      await apply(OLD_CONFIG, { host });
      const deps = fleet(NEW_CONFIG);
      host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
      host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
      host.seed(MANIFEST_PATH, JSON.stringify(NEW_CONFIG));
      // The daemon (another live process) is mid-converge.
      host.livePids.add(4242);
      const converging = {
        holder: "apply",
        pid: 4242,
        boot_id: null,
        taken_at: host.now().toISOString(),
      };
      host.seed(APPLY_LOCK_PATH, JSON.stringify(converging));
      host.commands.length = 0;

      const stage = await run(["apply"], host, { aws: () => deps.aws }).catch((e: unknown) => e);

      expect((stage as AgentdError).code).toBe("CONFLICT");
      expectNotRan(host, /^systemctl (stop|start|restart) /);
      expectNotRan(host, CHECKOUT_MOVES);

      // And the other way round: a stage's apply holds it, so the converge defers.
      host.seed(APPLY_LOCK_PATH, JSON.stringify({ ...converging, pid: 4343 }));
      host.livePids.add(4343);
      host.livePids.delete(4242);
      expect(await convergeOnce(deps, laptop("laptop-1"), async () => false)).toMatchObject({
        kind: "deferred",
      });
      expectNotRan(host, CHECKOUT_MOVES);

      host.livePids.delete(4343);
      expect(await convergeOnce(deps, laptop("laptop-1"), async () => false)).toMatchObject({
        kind: "applied",
      });
      expect(host.files.has(APPLY_LOCK_PATH)).toBe(false);
    });
  });

  /** A forward swap whose apply died during the gate: the new Hermes up, its gate record pending. */
  async function diedDuringGate(): Promise<void> {
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    const crash = dieAt(/^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway/);
    await expect(apply(NEW_CONFIG, { host })).rejects.toThrow();
    crash.revive();
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  }

  test("the resume apply gates the started swap first and seals it, though a later step fails; never rolled back", async () => {
    await diedDuringGate();
    writeState("migrated by 0.23");
    // The accounts step, between the Hermes build and the units phase.
    const accounts = host.when(/^groupadd /, { code: 10, stderr: "cannot lock /etc/group" });
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).not.toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(err.code).not.toBe("HERMES_ROLLBACK_FAILED");
    // Gated before the failing step, so nothing is left ungated for a later apply.
    const gated = host.commands.findIndex((c) => /api\/health/.test(c));
    expect(gated).toBeGreaterThanOrEqual(0);
    expect(gated).toBeLessThan(host.commands.findIndex((c) => /groupadd /.test(c)));
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(backups().length).toBeGreaterThan(0);
    expect(backups().every((b) => host.files.has(`${b}/sealed.json`))).toBe(true);
    expect(movedAside()).toEqual([]);
    expect(dbBody()).toBe("migrated by 0.23");
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);

    // The retry applies forward, with no swap left to gate.
    accounts();
    await apply(NEW_CONFIG, { host });
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
  });

  test("an unrelated failure before the new Hermes was ever started rolls back", async () => {
    await apply(OLD_CONFIG, { host });
    writeState("old sessions");
    host.when(/^groupadd /, { code: 10, stderr: "cannot lock /etc/group" });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(dbBody()).toBe("old sessions");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(held()).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("a gate failure in the resume apply still rolls back", async () => {
    await diedDuringGate();
    writeState("migrated by 0.23");
    host.when(/^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway/, () =>
      onNew() ? { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=0\n" } : null,
    );

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(dbBody()).toBe("old sessions");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
  });

  test("a gate failing after the restart rolls back in the first apply, ahead of a later step's failure, under the laptop's request", async () => {
    await diedDuringGate();
    writeState("migrated by 0.23");
    host.when(/^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway/, () =>
      onNew() ? { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=0\n" } : null,
    );
    // Without the gate first, this failure would end the apply with the swap still ungated.
    host.when(/^groupadd /, { code: 10, stderr: "cannot lock /etc/group" });
    const row = laptop("laptop-1");
    const failures: Array<{ request_id: string; code: string }> = [];

    await daemonStart(NEW_CONFIG, { row, deliver: true, failures });

    expect(failures).toEqual([{ request_id: "laptop-1", code: "HERMES_UPGRADE_ROLLED_BACK" }]);
    expect(dbBody()).toBe("old sessions");
    expect(movedAside()).toHaveLength(1);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });
});

/** `timeout(1)` exits 124 when it kills the command it bounds. */
describe("network steps bounded while Hermes is held", () => {
  const TIMED_OUT = { code: 124, stderr: "" };

  test("a forward-swap uv sync that times out ends rolled back with units up on the old version", async () => {
    await boxOn(OLD, "old sessions");
    host.when(/^uv sync /, TIMED_OUT);
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect((err.detail["cause"] as { code: string }).code).toBe("COMMAND_FAILED");
    // Three bounded attempts, as the npm steps get.
    expect(host.commandsMatching(/^uv sync /)).toHaveLength(3);
    expect(host.commandsMatching(/^uv sync /).every((c) => c.startsWith("timeout 900 uv sync "))).toBe(
      true,
    );
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
    // The rollback puts back the set-aside venv: no install at all.
    expect(host.commandsMatching(/^uv pip install /)).toEqual([]);
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("a rollback install that times out is HERMES_ROLLBACK_FAILED, with the units held", async () => {
    await boxOn(OLD, "old sessions");
    // With the set-aside install gone, the rollback falls back to reinstalling.
    host.when(/^uv sync /, () => {
      for (const p of [...host.files.keys()])
        if (p.startsWith(`${HERMES_PREVIOUS_ROOT}/`)) host.files.delete(p);
      for (const d of [...host.dirs]) if (d.startsWith(HERMES_PREVIOUS_ROOT)) host.dirs.delete(d);
      return TIMED_OUT;
    });
    host.when(/^uv pip install /, TIMED_OUT);
    host.commands.length = 0;

    const err = await failure(NEW);

    // The fallback reinstall is bounded, attempt by attempt.
    expect(host.commandsMatching(/^uv pip install /)).toEqual(
      Array(3).fill(`timeout 900 ${LEGACY_PIP}`),
    );
    expect(err.code).toBe("HERMES_ROLLBACK_FAILED");
    expect(err.detail["old_install_restored"]).toBe(false);
    expect(dbBody()).toBe("old sessions");
    expect(held()).toBe(true);
  });
});

/**
 * A forward swap fetches the ref and downloads the toolchain its checkout needs
 * while Hermes still runs (design 5.7), so the held part needs no download, and
 * a failure there leaves the box exactly as it was.
 */
describe("pre-fetch before the hold", () => {
  /** A command that reaches the network for a file or for git objects. */
  const DOWNLOAD = /(^|\s)(curl -fsSL|git -C \S+ fetch|git clone)\s|^s3:GetObject /;
  const arch = nodeArch();
  const NODE_TARBALL = `https://nodejs.org/dist/v${PNPM_NODE_VERSION}/node-v${PNPM_NODE_VERSION}-linux-${arch}.tar.xz`;

  /** The fleet mirrors `ref`; `digest` overrides the recorded sha256. */
  function seedMirror(ref: string, digest?: string): void {
    const bytes = BoxHost.bundleBytes(ref);
    host.s3Objects.set(hermesBundleKey(ref), bytes);
    const base = makeFleetManifest();
    const entry = {
      key: hermesBundleKey(ref),
      sha256: digest ?? sha256Of(bytes),
      size: bytes.length,
      upstream_sha: "9f1c0a4e2b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
    };
    const fleet: FleetManifest = { ...base, hermes: { ...base.hermes, [ref]: entry } };
    host.seed(FLEET_CACHE_PATH, JSON.stringify(fleet));
  }

  test("forward swap downloads everything before the hold and nothing while held", async () => {
    await boxOn(OLD, "old sessions");
    seedMirror(NEW.hermes_ref);
    host.commands.length = 0;

    await apply(makeManifest(NEW), { host, getObject: host.getObject });

    const commands = host.commands;
    const hold = commands.indexOf("systemctl daemon-reload");
    const restart = commands.indexOf("systemctl restart hermes-dashboard.service");
    expect(hold).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(hold);
    const before = commands.slice(0, hold);
    // The bundle, the uv, Node and pnpm the 0.23 checkout needs, all while 0.21.5 ran.
    expect(before.filter((c) => DOWNLOAD.test(c))).toEqual([
      `s3:GetObject ${TEST_BUCKET} hermes/${NEW.hermes_ref}.bundle`,
      `git -C ${DIR} fetch /var/lib/hermeticd/hermes.bundle ${NEW.hermes_ref}`,
      expect.stringContaining(uvRelease(arch).url),
      expect.stringContaining(NODE_TARBALL),
      expect.stringContaining(`v${PNPM_NODE_VERSION}/SHASUMS256.txt`),
      expect.stringContaining(pnpmRelease(arch).url),
    ]);
    expect(before.filter((c) => /^systemctl stop /.test(c))).toEqual([]);
    expect(commands.slice(hold, restart).filter((c) => DOWNLOAD.test(c))).toEqual([]);
    // Installed from what was fetched: the 0.23 toolchain is on the box, the cache consumed.
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.files.get("/usr/local/bin/uv")?.content).toBeDefined();
    expect(
      host.files.has(`/usr/local/lib/nodejs/node-v${PNPM_NODE_VERSION}-linux-${arch}/bin/node`),
    ).toBe(true);
    expect([...host.files.keys()].filter((p) => p.startsWith(`${PREFETCH_DIR}/`))).toEqual([]);
    expect(held()).toBe(false);
  });

  const failures: Array<[string, () => void, string]> = [
    [
      "the github fetch fails",
      () => host.when(/git -C \S+ fetch /, { code: 128, stderr: "fatal: unable to access" }),
      "COMMAND_FAILED",
    ],
    [
      "the bundle does not match its digest",
      () => seedMirror(NEW.hermes_ref, "0".repeat(64)),
      "CHECKSUM_MISMATCH",
    ],
    [
      "the uv tarball does not match its pinned digest",
      () => host.curlBodies.set(uvRelease(arch).url, "tampered"),
      "CHECKSUM_MISMATCH",
    ],
    [
      "the Node tarball does not match its published digest",
      () => host.curlBodies.set(NODE_TARBALL, "tampered"),
      "CHECKSUM_MISMATCH",
    ],
  ];

  for (const [what, arrange, cause] of failures) {
    test(`${what} -> HERMES_SWAP_ABORTED: no hold, no unit stopped, checkout unmoved`, async () => {
      await boxOn(OLD, "old sessions");
      arrange();
      host.commands.length = 0;

      const err = await apply(makeManifest(NEW), { host, getObject: host.getObject }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(AgentdError);
      const failure = err as AgentdError;
      expect(failure.code).toBe("HERMES_SWAP_ABORTED");
      expect(HERMES_OLD_VERSION_RUNNING).toContain(failure.code);
      expect((failure.detail["cause"] as { code: string }).code).toBe(cause);
      expect(host.files.has(holdDropIn("hermes-gateway.service"))).toBe(false);
      expect(host.files.has(holdDropIn("hermes-dashboard.service"))).toBe(false);
      expect(held()).toBe(false);
      expect(host.commandsMatching(/^systemctl (stop|start|daemon-reload)/)).toEqual([]);
      expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
      expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
      expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
      expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
      expect(backups()).toEqual([]);
      expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
      expect(dbBody()).toBe("old sessions");
      expect([...host.files.keys()].filter((p) => p.startsWith(`${PREFETCH_DIR}/`))).toEqual([]);
    });
  }
});

describe("which backup a retry may reuse", () => {
  test("crash after the backup, before its swap record; the old Hermes runs on -> the retry takes a fresh backup, and a rollback restores it", async () => {
    await boxOn(OLD, "old sessions");
    // The backup is published; the record naming it is never written.
    host.writeFaults.push((path) =>
      path === HERMES_SWAP_PATH ? new Error("hermeticd is dead") : null,
    );
    await crashed(NEW);
    host.writeFaults.length = 0;
    const [stale] = backups();
    expect(stale).toBeDefined();
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    // The old Hermes runs again and writes past that copy.
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    writeState("written by 0.21 after the crash");
    host.when(/^uv sync /, () => {
      writeState("migrated by 0.23");
      return { code: 1, stderr: "resolver failed" };
    });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(err.detail["backup"]).not.toBe(stale);
    expect(backups()).toHaveLength(2);
    expect(dbBody(`${err.detail["backup"] as string}/home/state.db`)).toBe(
      "written by 0.21 after the crash",
    );
    expect(dbBody()).toBe("written by 0.21 after the crash");
  });

  test("the record names a backup that no longer verifies -> a fresh one, and the install to return to is still the recorded one", async () => {
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^uv sync /);
    await crashed(NEW);
    crash.revive();
    // The checkout moved before the crash: HEAD is the new commit now.
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    const [first] = backups();
    host.files.set(`${first}/home/state.db`, { content: "torn", mode: "0600" });
    host.advance(60_000);
    host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(err.detail["backup"]).not.toBe(first);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
    expect(dbBody()).toBe("old sessions");
  });
});

describe("a downgrade retried after its restore finished", () => {
  test("restores nothing a second time", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    // The restore completes; hermeticd dies at the old ref's fetch.
    const crash = dieAt(/^git -C \S+ fetch /);
    await crashed(OLD);
    crash.revive();
    expect(movedAside()).toHaveLength(1);
    expect(held()).toBe(true);
    host.advance(60_000);

    await apply(makeManifest(OLD), { host });

    const asides = movedAside();
    expect(asides).toHaveLength(1);
    expect(dbBody(`${asides[0]}/home/state.db`)).toBe("written by 0.23");
    expect(dbBody()).toBe("old sessions");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });
});

describe("rollback without the network", () => {
  /** Anything that reaches the network: downloads, git fetches, package installs and builds. */
  const NETWORK =
    /^(timeout \d+ )?(curl -fsSL|git -C \S+ fetch|git clone|uv (sync|venv|pip install)|npm |pnpm |node scripts\/build\/node-deps)|^s3:GetObject /;
  const arch = nodeArch();

  test("network dead from the first forward failure through the rollback -> rolled back on the old install, no network command issued", async () => {
    await boxOn(OLD, "old sessions");
    host.seed(MANIFEST_PATH, JSON.stringify(makeManifest(OLD)));
    let deadFrom = -1;
    host.when(NETWORK, () => {
      // The forward swap's pnpm install is the first thing the outage hits.
      if (deadFrom === -1 && !/node-deps/.test(host.commands.at(-1) ?? "")) return null;
      if (deadFrom === -1) deadFrom = host.commands.length - 1;
      return { code: 6, stderr: "Could not resolve host" };
    });

    const err = await failure(NEW);

    expect(deadFrom).toBeGreaterThan(-1);
    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    // The forward step's own retries fail on the dead network; then the rollback issues none.
    const rollback = host.commands.findLastIndex((c) => /node-deps/.test(c)) + 1;
    expect(rollback).toBeGreaterThan(deadFrom);
    expect(
      host.commands.slice(rollback).filter((c) => /^systemctl stop /.test(c)).length,
    ).toBeGreaterThan(0);
    expect(
      host.commands.slice(deadFrom + 1).filter((c) => NETWORK.test(c) && !/node-deps/.test(c)),
    ).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
    expect(host.files.has(HERMES_INSTALL_STAMP)).toBe(false);
    // The old web build and the Node it was built with, back in place.
    expect(host.files.get(`${DIR}/web/.hermetic-built`)?.content).toStartWith(`${OLD.hermes_ref} `);
    expect(host.files.has(`${DIR}/hermes_cli/web_dist/index.html`)).toBe(true);
    expect(host.files.has(`${DIR}/node_modules/.package-lock.json`)).toBe(true);
    expect(host.files.has(`${DIR}/node_modules/.modules.yaml`)).toBe(false);
    expect(host.files.get("/usr/local/bin/node")?.content.trim()).toBe(`v24.20.0`);
    expect(
      host.files.has(`/usr/local/lib/nodejs/node-v${PNPM_NODE_VERSION}-linux-${arch}/bin/node`),
    ).toBe(true);
    expect(dbBody()).toBe("old sessions");
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
    // Settled: the set-aside copy is gone.
    expect([...host.dirs].filter((d) => d.startsWith(HERMES_PREVIOUS_ROOT))).toEqual([]);
  });

  test("a swap that passes its gate drops the set-aside install", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    expect([...host.files.keys()].filter((p) => p.startsWith(`${HERMES_PREVIOUS_ROOT}/`))).toEqual([]);
    expect(host.files.has(`${DIR}/venv/bin/python`)).toBe(true);
  });
});

describe("rollback with no previous configuration to re-apply", () => {
  const SHOW_GATEWAY = /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/;
  let restarts = 0;
  beforeEach(() => {
    restarts = 0;
  });
  /** The new Hermes crash-loops at the gate; no manifest of the old configuration is on disk. */
  const crashLoops = (): void => {
    host.when(SHOW_GATEWAY, () =>
      onNew()
        ? { stdout: `ActiveState=activating\nSubState=auto-restart\nNRestarts=${restarts++}\n` }
        : null,
    );
  };

  test("units checked active after their start, and the applied record dropped so the next converge re-renders", async () => {
    await boxOn(OLD, "old sessions");
    host.seed(APPLIED_CONFIG_PATH, `${JSON.stringify({ config_hash: "c0nf0ld1" })}\n`);
    crashLoops();
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.files.has(APPLIED_CONFIG_PATH)).toBe(false);
    expect(
      ranInOrder(host, [
        "systemctl start hermes-gateway.service",
        "systemctl is-active hermes-gateway.service",
      ]),
    ).toBe(true);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("a unit that does not come back up -> HERMES_ROLLBACK_FAILED, never rolled back", async () => {
    await boxOn(OLD, "old sessions");
    crashLoops();
    host.when(/^systemctl start hermes-gateway\.service$/, { code: 1, stderr: "start failed" });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_ROLLBACK_FAILED");
    expect(err.detail["old_install_restored"]).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);
  });
});

describe("a Hermes process outside the units", () => {
  test("holding files under the home open after the stop -> HERMES_UNITS_ACTIVE, nothing backed up, checkout unmoved, units restarted", async () => {
    await boxOn(OLD, "old sessions");
    // An operator's `hermes chat` as the account, with the stores open.
    host.when(/^find \/proc /, { stdout: `/proc/4242/fd/7 ${DB}\n/proc/4242/fd/8 ${DB}-wal\n` });
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UNITS_ACTIVE");
    expect(HERMES_OLD_VERSION_RUNNING).toContain(err.code);
    expect(err.detail["processes"]).toEqual([
      { pid: 4242, path: DB },
      { pid: 4242, path: `${DB}-wal` },
    ]);
    expect(ranInOrder(host, [/^systemctl stop hermes-gateway\.service$/, /^find \/proc /])).toBe(true);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(backups()).toEqual([]);
    expect(host.commandsMatching(/^systemctl start /)).toEqual(
      UNITS.map((u) => `systemctl start ${u}`),
    );
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  const SCOPE_STOP = /^systemctl --user -M hermes@ stop hermes-worker-\*\.scope$/;
  /** A cron job the gateway ran in a user scope: the units' stop leaves it, and it holds the stores. */
  function workerScope(): void {
    host.userScopes.add("hermes-worker-cron-a1b2.scope");
    host.when(/^find \/proc /, () =>
      host.userScopes.size > 0 ? { stdout: `/proc/5151/fd/3 ${DB}\n` } : null,
    );
  }

  test("a worker in a user scope is stopped after the units, before the open-file scan; the swap goes on", async () => {
    await boxOn(OLD, "old sessions");
    workerScope();
    host.commands.length = 0;

    await apply(makeManifest(NEW), { host });

    expect(host.userScopes.size).toBe(0);
    expect(
      ranInOrder(host, [/^systemctl stop hermes-gateway\.service$/, SCOPE_STOP, /^find \/proc /]),
    ).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(held()).toBe(false);
  });

  test("the worker scopes' stop failing -> HERMES_UNITS_ACTIVE, checkout unmoved, units restarted; no user manager is no scopes", async () => {
    await boxOn(OLD, "old sessions");
    const fault = host.when(/--user -M hermes@ stop /, { code: 1, stderr: "Job canceled" });
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UNITS_ACTIVE");
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);

    fault();
    // No user manager: nothing to ask, whatever a stop would have said.
    host.downUnits.add("user@1000.service");
    host.commands.length = 0;
    await apply(makeManifest(NEW), { host });
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.commandsMatching(/^systemctl is-active user@1000\.service$/).length).toBeGreaterThan(0);
    expect(host.commandsMatching(SCOPE_STOP)).toEqual([]);
  });

  test("a user manager that runs and cannot be reached is a stray holder, whatever its error says", async () => {
    await boxOn(OLD, "old sessions");
    host.when(/--user -M hermes@ stop /, {
      code: 1,
      stderr: "Failed to connect to bus: Connection refused",
    });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UNITS_ACTIVE");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });

  test("hermeticd's own log follower under the home is no stray: the swap goes on; a stranger's open log still stops it", async () => {
    await boxOn(OLD, "old sessions");
    // `hermetic logs --file errors --follow`: a `tail -F` hermeticd spawned, under a shell it spawned.
    host.when(/^find \/proc /, { stdout: `/proc/7001/fd/3 ${HOME}/logs/errors.log\n` });
    host.when(/^ps -e -o pid=,ppid=$/, {
      stdout: `  1     0\n 7000 ${process.pid}\n 7001  7000\n 8000     1\n`,
    });

    await apply(makeManifest(NEW), { host });
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);

    host.when(/^find \/proc /, { stdout: `/proc/8000/fd/3 ${HOME}/logs/errors.log\n` });
    const err = await failure(OLD);
    expect(err.code).toBe("HERMES_UNITS_ACTIVE");
    expect(err.detail["processes"]).toEqual([{ pid: 8000, path: `${HOME}/logs/errors.log` }]);
  });

  test("a rollback stops the new Hermes's worker scopes before it restores; a failing stop there is HERMES_ROLLBACK_FAILED, held", async () => {
    await boxOn(OLD, "old sessions");
    host.when(/^uv sync /, () => {
      if (!onNew()) return null;
      workerScope();
      return { code: 1, stderr: "resolver failed" };
    });
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.userScopes.size).toBe(0);
    expect(ranInOrder(host, [/^uv sync /, SCOPE_STOP, /^find \/proc /])).toBe(true);

    host.when(/^uv sync /, () => (onNew() ? { code: 1, stderr: "resolver failed" } : null));
    host.when(/--user -M hermes@ stop /, () => (onNew() ? { code: 1, stderr: "Job canceled" } : null));
    const second = await failure(NEW);
    expect(second.code).toBe("HERMES_ROLLBACK_FAILED");
    expect(held()).toBe(true);
  });
});

describe("the gate's stability window", () => {
  test("a window that opens just inside the budget runs to its end instead of timing out", async () => {
    await boxOn(OLD, "old sessions");
    let first: number | null = null;
    host.when(/^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/, () => {
      const now = host.now().getTime();
      first ??= now;
      // Active from one poll before the budget runs out.
      return {
        stdout:
          now - first < HERMES_GATE_TIMEOUT_MS - HERMES_GATE_POLL_MS
            ? "ActiveState=activating\nSubState=start\nNRestarts=0\n"
            : "ActiveState=active\nSubState=running\nNRestarts=0\n",
      };
    });

    await apply(makeManifest(NEW), { host });

    expect(host.now().getTime() - (first ?? 0)).toBeGreaterThan(HERMES_GATE_TIMEOUT_MS);
    expect(movedAside()).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
  });
});

describe("a downgrade that fails after it started", () => {
  const PATCH = { hermes_ref: "v0.23.2", hermes_version: "0.23.2" };
  beforeEach(() => {
    host.hermesVersionByRef.set(PATCH.hermes_ref, PATCH.hermes_version);
    host.hermesStampRefs.add(PATCH.hermes_ref);
  });

  test("install fails after the restore -> HERMES_RESTORE_FAILED, held, and the retry restores nothing a second time", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    const stop = host.when(/^uv pip install /, { code: 1, stderr: "Could not resolve host" });

    const err = await failure(OLD);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(err.detail["moved_aside"]).toBe(movedAside()[0]);
    expect(held()).toBe(true);
    await boot();
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);

    stop();
    await apply(makeManifest(OLD), { host });
    expect(movedAside()).toHaveLength(1);
    expect(dbBody()).toBe("old sessions");
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("install fails after the restore, then a third ref pinned: refused before any unit stops, held, the restored state and the newer state's moved-aside copy untouched", async () => {
    const THIRD = { hermes_ref: "v0.22.0", hermes_version: "0.22.0" };
    host.hermesVersionByRef.set(THIRD.hermes_ref, THIRD.hermes_version);
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    const stop = host.when(/^uv pip install /, { code: 1, stderr: "Could not resolve host" });
    expect((await failure(OLD)).code).toBe("HERMES_RESTORE_FAILED");
    stop();
    // The marker still names 0.23; the checkout and the state are 0.21's.
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${NEW.hermes_ref}\n`);
    host.advance(60_000);
    host.commands.length = 0;

    const err = await failure(THIRD);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(err.detail["restored_for"]).toBe(OLD.hermes_ref);
    expect(host.commandsMatching(/^systemctl (stop|start) /)).toEqual([]);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(held()).toBe(true);
    expect(dbBody()).toBe("old sessions");
    expect(movedAside()).toHaveLength(1);
    expect(dbBody(`${movedAside()[0]}/home/state.db`)).toBe("written by 0.23");
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
  });

  test("a patch-level downgrade whose install fails after the checkout moved -> HERMES_RESTORE_FAILED, held so a reboot starts nothing; the retry finishes it", async () => {
    await boxOn(NEW, "sessions on 0.23.1");
    await apply(makeManifest(PATCH), { host });
    const stop = host.when(/^uv sync /, { code: 1, stderr: "Could not resolve host" });

    const err = await failure(NEW);

    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    // The venv is half rebuilt: the hold stays until an apply finishes the install.
    expect(held()).toBe(true);
    await boot();
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);

    stop();
    await apply(makeManifest(NEW), { host });
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.23.1");
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });

  test("a patch-level downgrade whose fetch fails before the checkout moves -> HERMES_SWAP_ABORTED, units up, nothing held, and the retry says the same", async () => {
    await boxOn(NEW, "sessions on 0.23.1");
    await apply(makeManifest(PATCH), { host });
    host.when(/^timeout \S+ git -C \S+ fetch /, { code: 1, stderr: "Could not resolve host" });

    for (let attempt = 0; attempt < 2; attempt++) {
      host.commands.length = 0;
      const err = await failure(NEW);

      expect(err.code).toBe("HERMES_SWAP_ABORTED");
      expect(HERMES_OLD_VERSION_RUNNING).toContain(err.code);
      expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
      expect(host.hermesCheckedOutRef).toBe(PATCH.hermes_ref);
      expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
      // No record left to make the daemon re-ask the swap every few minutes.
      expect(await hermesHeld(host)).toBe(false);
      expect(await heldResumeRequest(host)).toBeNull();
    }
  });

  const SHOW_GATEWAY = /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/;
  /** The gateway crashes after systemd accepted its start, once the checkout is on `ref`. */
  const crashesOn = (ref: string): (() => void) =>
    host.when(SHOW_GATEWAY, () =>
      host.hermesCheckedOutRef === ref
        ? { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=1\n" }
        : null,
    );

  test("a restored downgrade whose Hermes crashes after its start -> HERMES_RESTORE_FAILED, held down, never re-upgraded; the retry gates it", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    const fixed = crashesOn(OLD.hermes_ref);

    const err = await failure(OLD);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(dbBody()).toBe("old sessions");
    expect(held()).toBe(true);
    expect(await hermesHeld(host)).toBe(true);
    await boot();
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);

    fixed();
    await apply(makeManifest(OLD), { host });
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });

  test("a restored downgrade whose gate failed, then the newer ref pinned again -> HERMES_RESTORE_FAILED before anything moves, held", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    const fixed = crashesOn(OLD.hermes_ref);
    expect((await failure(OLD)).code).toBe("HERMES_RESTORE_FAILED");
    fixed();
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(String(err.message)).toContain(`${HERMES_BACKUP_ROOT}/post-*`);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(dbBody()).toBe("old sessions");
    expect(dbBody(`${movedAside()[0]}/home/state.db`)).toBe("written by 0.23");
    expect(held()).toBe(true);
    await boot();
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);

    // The older ref pinned again: its gate runs as it would have.
    await apply(makeManifest(OLD), { host });
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });

  test("a patch-level downgrade whose Hermes crashes after its start -> HERMES_RESTORE_FAILED, held down, never re-upgraded", async () => {
    await boxOn(NEW, "sessions on 0.23.1");
    await apply(makeManifest(PATCH), { host });
    crashesOn(NEW.hermes_ref);

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(held()).toBe(true);
    await boot();
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);
  });

  test("crash after the restore, before the checkout: the retry's stray holder is HERMES_RESTORE_FAILED, held, the newer Hermes never started on the restored state", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    // hermeticd dies the moment the restore is recorded complete.
    let dead = false;
    const kill = (): Error | null => (dead ? new Error("hermeticd is dead") : null);
    host.writeFaults.push((path) => {
      const was = kill();
      if (path.endsWith("/restore.json")) dead = true;
      return was;
    });
    host.execFaults.push(kill);
    host.fsFaults.push(kill);
    await crashed(OLD);
    host.writeFaults.length = 0;
    host.execFaults.length = 0;
    host.fsFaults.length = 0;
    expect(dead).toBe(true);
    expect(dbBody()).toBe("old sessions");
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);

    const stray = host.when(/^find \/proc /, { stdout: `/proc/4242/fd/7 ${DB}\n` });
    const err = await failure(OLD);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);
    expect(held()).toBe(true);
    expect(dbBody()).toBe("old sessions");

    stray();
    await apply(makeManifest(OLD), { host });
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(movedAside()).toHaveLength(1);
    expect(dbBody()).toBe("old sessions");
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });

  test("a downgrade whose gate a crash cut, its Hermes up: a move elsewhere refused before anything moved is the old version running, not held", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    const death = dieAt(/api\/health/);
    await crashed(OLD);
    death.revive();
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(true);

    const stray = host.when(/^find \/proc /, { stdout: `/proc/4242/fd/7 ${DB}\n` });
    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UNITS_ACTIVE");
    expect(HERMES_OLD_VERSION_RUNNING).toContain(err.code);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);

    // Back on the downgrade's own ref, its gate runs as it would have.
    stray();
    await apply(makeManifest(OLD), { host });
    expect(await hermesHeld(host)).toBe(false);
  });

  test("a patch-level downgrade that crashed after its checkout moved is finished by the retry, never reported as the old version", async () => {
    await boxOn(NEW, "sessions on 0.23.1");
    await apply(makeManifest(PATCH), { host });
    // Dead the moment the checkout moved: the install never stamped it.
    const death = dieAt(/checkout --detach /, true);
    await crashed(NEW);
    death.revive();
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(await hermesHeld(host)).toBe(true);

    await apply(makeManifest(NEW), { host });

    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.23.1");
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${NEW.hermes_ref}\n`);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });
});

describe("a same-Python version change", () => {
  const PATCH = { hermes_ref: "v0.23.2", hermes_version: "0.23.2" };
  const NETWORK =
    /^(timeout \d+ )?(curl -fsSL|git -C \S+ fetch|git clone|uv (sync|venv|pip install)|npm |pnpm |node scripts\/build\/node-deps)|^s3:GetObject /;
  beforeEach(() => {
    host.hermesVersionByRef.set(PATCH.hermes_ref, PATCH.hermes_version);
    host.hermesStampRefs.add(PATCH.hermes_ref);
  });

  test("network dies at uv sync -> the venv copied before the move comes back, no network command, rolled back on the old version", async () => {
    await boxOn(NEW, "sessions on 0.23.1");
    host.commands.length = 0;
    const duringRollback: string[] = [];
    host.when(NETWORK, () => {
      const cmd = host.commands.at(-1) ?? "";
      if (host.hermesCheckedOutRef === PATCH.hermes_ref && /uv sync /.test(cmd)) {
        return { code: 2, stderr: "Could not resolve host" };
      }
      if (
        host.hermesCheckedOutRef === NEW.hermes_ref &&
        host.commandsMatching(/^uv sync /).length > 0
      ) {
        duringRollback.push(cmd);
        return { code: 6, stderr: "Could not resolve host" };
      }
      return null;
    });

    const err = await failure(PATCH);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(duringRollback).toEqual([]);
    expect(ranInOrder(host, [`cp -a -- ${VENV} `, CHECKOUT_MOVES])).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.23.1");
    expect(dbBody()).toBe("sessions on 0.23.1");
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(host.runningUnits.has("hermes-dashboard.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("no room on the root volume for the copy -> HERMES_SWAP_ABORTED before the checkout moves, units restarted", async () => {
    await boxOn(NEW, "sessions on 0.23.1");
    host.filesystemByPath.set(STATE_DIR, {
      mount: "/",
      size: 8_000_000_000,
      available: 1_000,
      usePct: 99,
    });
    host.commands.length = 0;

    const err = await failure(PATCH);

    expect(err.code).toBe("HERMES_SWAP_ABORTED");
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.commandsMatching(/^cp -a /)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("a change of Python copies nothing: the venv is moved aside as before", async () => {
    await boxOn(OLD, "old sessions");
    host.commands.length = 0;
    await apply(makeManifest(NEW), { host });
    expect(host.commandsMatching(/^(cp -a|du -sk) /)).toEqual([]);
  });
});

/**
 * What a box reports when the old version is not what runs: an old-version
 * code (`HERMES_OLD_VERSION_RUNNING`) only once the old install is verifiably
 * up on the old checkout.
 */
describe("the old version is reported running only when it is", () => {
  const FETCH_FAILS = { code: 128, stderr: "fatal: unable to access" };

  test("a crashed swap's retry whose fetch fails is rolled back, not reported as the old version still running while held", async () => {
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^uv sync /);
    await crashed(NEW);
    crash.revive();
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    host.when(/git -C \S+ fetch /, FETCH_FAILS);

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect(dbBody()).toBe("old sessions");
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("crash after the swap record, before the checkout moved: the retry's failed fetch restarts the old install too", async () => {
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^git -C \S+ checkout /);
    await crashed(NEW);
    crash.revive();
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(true);
    expect(held()).toBe(true);
    host.when(/git -C \S+ fetch /, FETCH_FAILS);

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("a stray holder on a crashed swap's retry -> HERMES_ROLLBACK_FAILED, units still held so a reboot starts nothing", async () => {
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^uv sync /);
    await crashed(NEW);
    crash.revive();
    host.when(/^find \/proc /, { stdout: `/proc/4242/fd/7 ${DB}\n` });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_ROLLBACK_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(held()).toBe(true);
    host.skippedStarts.length = 0;
    await boot();
    expect(host.skippedStarts).toEqual(UNITS);
  });

  test("a stray holder with an interrupted restore behind the apply -> HERMES_RESTORE_FAILED, held", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    host.writeFaults.push((path) => (path === DB ? new Error("EIO") : null));
    expect((await failure(OLD)).code).toBe("HERMES_RESTORE_FAILED");
    host.writeFaults.length = 0;
    host.when(/^find \/proc /, { stdout: `/proc/4242/fd/7 ${DB}\n` });

    const err = await failure(OLD);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect((err.detail["cause"] as { code: string }).code).toBe("HERMES_UNITS_ACTIVE");
    expect(held()).toBe(true);
  });

  test("backup refused and the old units do not start again -> HERMES_ROLLBACK_FAILED naming the restart", async () => {
    await boxOn(OLD, "old sessions");
    host.copyCorruptions.push((_from, to, bytes) =>
      to.includes("/.staging-") ? new TextEncoder().encode("torn") : bytes,
    );
    host.when(/^systemctl start hermes-gateway\.service$/, { code: 1, stderr: "start failed" });

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_ROLLBACK_FAILED");
    expect((err.detail["cause"] as { code: string }).code).toBe("HERMES_BACKUP_FAILED");
    expect(String(err.detail["reason"])).toContain("restart");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(false);
  });

  test("an installed version that cannot be read -> HERMES_SWAP_ABORTED before the hold; no backup, no move", async () => {
    await boxOn(OLD, "old sessions");
    await apply(makeManifest(NEW), { host });
    writeState("written by 0.23");
    // No stamp, and 0.23's pyproject says 0.0.0: read as a version, a downgrade would pass for an upgrade.
    host.files.delete(HERMES_INSTALL_STAMP);
    const taken = backups();
    host.commands.length = 0;

    const err = await failure(OLD);

    expect(err.code).toBe("HERMES_SWAP_ABORTED");
    expect(err.detail["reason"]).toBe("unknown installed version");
    expect(host.commandsMatching(/^systemctl (stop|start)/)).toEqual([]);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(backups()).toEqual(taken);
    expect(dbBody()).toBe("written by 0.23");
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  test("re-pinned to a third ref after a crashed swap: its rollback returns to the recorded install, not the crashed target", async () => {
    const THIRD = { hermes_ref: "v0.23.2", hermes_version: "0.23.2" };
    host.hermesVersionByRef.set(THIRD.hermes_ref, THIRD.hermes_version);
    host.hermesStampRefs.add(THIRD.hermes_ref);
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^uv sync /);
    await crashed(NEW);
    crash.revive();
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });

    const err = await failure(THIRD);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(err.detail["from_ref"]).toBe(OLD.hermes_ref);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect((await host.exec(["/usr/local/bin/hermes", "--version"])).stdout).toContain("v0.21.5");
    expect(dbBody()).toBe("old sessions");
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });
});

describe("after the new Hermes started", () => {
  const SHOW_GATEWAY = /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/;
  const FAILED = { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=0\n" };

  test("an unrelated failure after this apply started it -> gated and settled, the original error reported; a later apply rolls nothing back", async () => {
    await boxOn(OLD, "old sessions");
    // The restart record's next write, once the new gateway has been started, hits a full disk.
    let armed = false;
    host.when(/^systemctl restart hermes-gateway\.service$/, () => {
      armed = host.hermesCheckedOutRef === NEW.hermes_ref;
      return null;
    });
    const trip = (path: string): Error | null => {
      if (!armed || path !== APPLY_PENDING_PATH) return null;
      armed = false;
      return new Error("ENOSPC: no space left on device");
    };
    host.writeFaults.push(trip);
    host.fsFaults.push((_op, path) => trip(path));

    const err = await apply(makeManifest(NEW), { host }).catch((e: unknown) => e);

    expect((err as Error).message).toContain("ENOSPC");
    expect(host.commandsMatching(/api\/health/).length).toBeGreaterThan(0);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(backups().every((b) => host.files.has(`${b}/sealed.json`))).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(movedAside()).toEqual([]);

    // Days on, the gateway down for a moment during a same-ref apply.
    host.writeFaults.length = 0;
    host.fsFaults.length = 0;
    writeState("days of 0.23 sessions");
    host.when(SHOW_GATEWAY, FAILED);
    await apply(makeManifest(NEW), { host });
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(movedAside()).toEqual([]);
    expect(dbBody()).toBe("days of 0.23 sessions");
  });

  test("…and when that gate fails, the swap is rolled back", async () => {
    await boxOn(OLD, "old sessions");
    let armed = false;
    host.when(/^systemctl restart hermes-gateway\.service$/, () => {
      armed = host.hermesCheckedOutRef === NEW.hermes_ref;
      return null;
    });
    host.fsFaults.push((_op, path) => {
      if (!armed || path !== APPLY_PENDING_PATH) return null;
      armed = false;
      return new Error("ENOSPC: no space left on device");
    });
    host.when(SHOW_GATEWAY, () => (onNew() ? FAILED : null));

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(dbBody()).toBe("old sessions");
  });

  test("the old configuration's re-apply fails after its units are up -> HERMES_UPGRADE_ROLLED_BACK with that failure in detail", async () => {
    await boxOn(OLD, "old sessions");
    host.seed(MANIFEST_PATH, JSON.stringify(makeManifest(OLD)));
    let gated = false;
    host.when(SHOW_GATEWAY, () => {
      if (!onNew()) return null;
      gated = true;
      return FAILED;
    });
    // A post-step of the old configuration, which runs after its units phase.
    host.when(/nft -f /, () => (gated ? { code: 1, stderr: "nft: busy" } : null));

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect((err.detail["after"] as { code: string }).code).toBe("COMMAND_FAILED");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(dbBody()).toBe("old sessions");
  });

  test("the old configuration's re-apply fails before its units phase -> the old install is started anyway, HERMES_UPGRADE_ROLLED_BACK", async () => {
    await boxOn(OLD, "old sessions");
    host.seed(MANIFEST_PATH, JSON.stringify(makeManifest(OLD)));
    let gated = false;
    host.when(SHOW_GATEWAY, () => {
      if (!onNew()) return null;
      gated = true;
      return FAILED;
    });
    // The re-apply's packages phase, long before its units phase releases the hold.
    let tripped = false;
    host.execFaults.push((argv) => {
      if (!gated || tripped || host.hermesCheckedOutRef !== OLD.hermes_ref) return null;
      if (unwrapped(argv)[0] !== "dpkg-query") return null;
      tripped = true;
      return new Error("dpkg: status database locked");
    });

    const err = await failure(NEW);

    expect(tripped).toBe(true);
    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect((err.detail["after"] as { message: string }).message).toContain("dpkg");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
    expect(host.files.has(APPLIED_CONFIG_PATH)).toBe(false);
    expect(dbBody()).toBe("old sessions");
  });
});

describe("a rollback hermeticd does not survive", () => {
  const SHOW_GATEWAY = /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/;
  type Step = { exec: string } | { op: string; path: string; to?: string | undefined };

  /**
   * The new Hermes migrates the stores and fails its gate; hermeticd dies at
   * the first step of the rollback `at` matches (`after`: that step still
   * happens). Revived, the gate would pass: only the rollback record stops a
   * resume from starting the new Hermes on the state put back for the old one.
   */
  async function rollbackDiesAt(at: (step: Step) => boolean, after = false): Promise<void> {
    await boxOn(OLD, "old sessions");
    host.when(/^systemctl restart hermes-gateway\.service$/, () => {
      if (onNew()) writeState("migrated by 0.23");
      return null;
    });
    let rollingBack = false;
    const failing = host.when(SHOW_GATEWAY, () => {
      if (!onNew() || rollingBack) return null;
      rollingBack = true;
      return { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=0\n" };
    });
    let dead = false;
    const kill = (step: Step): Error | null => {
      if (!dead && rollingBack && at(step)) {
        dead = true;
        if (after) return null;
      }
      return dead ? new Error("hermeticd is dead") : null;
    };
    host.execFaults.push((argv) => kill({ exec: unwrapped(argv).join(" ") }));
    host.writeFaults.push((path) => kill({ op: "write", path }));
    host.fsFaults.push((op, path, to) => kill({ op, path, to }));
    await crashed(NEW);
    expect(dead).toBe(true);
    host.execFaults.length = 0;
    host.writeFaults.length = 0;
    host.fsFaults.length = 0;
    failing();
  }

  /** The resume: rolled back, the new Hermes never started, every moved-aside state reported. */
  async function resumeRollsBack(): Promise<AgentdError> {
    let startedNew = false;
    host.when(/^systemctl (re)?start hermes-/, () => {
      if (onNew()) startedNew = true;
      return null;
    });
    const err = await failure(NEW);
    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect((err.detail["cause"] as { code: string }).code).toBe("COMMAND_FAILED");
    expect(startedNew).toBe(false);
    expect(dbBody()).toBe("old sessions");
    const reported = [
      err.detail["moved_aside"],
      ...((err.detail["earlier_moved_aside"] as string[] | undefined) ?? []),
    ];
    const migrated = movedAside().filter((d) => dbBody(`${d}/home/state.db`) === "migrated by 0.23");
    expect(migrated).toHaveLength(1);
    expect(reported).toContain(migrated[0]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(held()).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    return err;
  }

  test("killed before the restore -> the resume restores and rolls back", async () => {
    await rollbackDiesAt((s) => "exec" in s && /^systemctl stop /.test(s.exec));
    expect(dbBody()).toBe("migrated by 0.23");
    await resumeRollsBack();
  });

  test("killed mid-restore -> the resume finishes it and rolls back, reporting both moved-aside states", async () => {
    // The state is moved aside; nothing is copied back yet.
    await rollbackDiesAt((s) => "op" in s && s.op === "rename" && /\/post-/.test(s.to ?? ""), true);
    expect(dbBody()).toBeUndefined();
    const err = await resumeRollsBack();
    expect(err.detail["earlier_moved_aside"]).toHaveLength(1);
  });

  test("killed after the restore, before the checkout -> the resume restores nothing again", async () => {
    await rollbackDiesAt((s) => "exec" in s && /checkout --detach /.test(s.exec));
    expect(dbBody()).toBe("old sessions");
    const asideBefore = movedAside();
    await resumeRollsBack();
    expect(movedAside()).toEqual(asideBefore);
  });

  test("killed after the checkout, before the markers -> the resume records the old install", async () => {
    await rollbackDiesAt((s) => "exec" in s && /checkout --detach /.test(s.exec), true);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${NEW.hermes_ref}\n`);
    await resumeRollsBack();
  });

  test("killed before the restore, then the old ref pinned again -> the rollback finishes and the old config applies, not reported rolled back", async () => {
    await rollbackDiesAt((s) => "exec" in s && /^systemctl stop /.test(s.exec));

    await apply(makeManifest(OLD), { host });

    expect(dbBody()).toBe("old sessions");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(held()).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });
});

describe("a crashed swap's resume that fails before reaching Hermes", () => {
  test("the marker still on the old ref -> rolled back to the recorded install without the network, not left held", async () => {
    await boxOn(OLD, "old sessions");
    const crash = dieAt(/^uv sync /);
    await crashed(NEW);
    crash.revive();
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect(held()).toBe(true);
    // apt, before `ensureHermes`.
    host.when(/^dpkg-query /, { code: 1, stdout: "" });
    host.when(/apt-get /, { code: 100, stderr: "E: Could not get lock /var/lib/dpkg/lock-frontend" });
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith(`${OLD.hermes_ref}\n`);
    expect(dbBody()).toBe("old sessions");
    expect(host.commandsMatching(/uv (venv|pip install|sync) /)).toEqual([]);
    expect(host.files.has(HERMES_SWAP_PATH)).toBe(false);
    expect(held()).toBe(false);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
  });
});

describe("the old Hermes seen up, not one is-active sample", () => {
  const SHOW_GATEWAY = /^systemctl show -p ActiveState,SubState,NRestarts hermes-gateway\.service$/;
  /** `Restart=always`: `is-active` still reads active between crashes, only the restart count climbs. */
  const oldCrashLoops = (): void => {
    let restarts = 0;
    host.when(SHOW_GATEWAY, () =>
      onNew()
        ? { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=0\n" }
        : { stdout: `ActiveState=active\nSubState=running\nNRestarts=${restarts++}\n` },
    );
  };

  test("the rolled-back old gateway crash-loops after its start -> HERMES_ROLLBACK_FAILED, never rolled back", async () => {
    await boxOn(OLD, "old sessions");
    oldCrashLoops();

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_ROLLBACK_FAILED");
    expect(err.detail["old_install_restored"]).toBe(true);
    expect((err.detail["rollback"] as { detail: { reason: string } }).detail.reason).toBe("crash-loop");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
  });

  test("a pre-move abort whose old Hermes never came up: re-pinning the old config restarts and gates it", async () => {
    await boxOn(OLD, "old sessions");
    host.copyCorruptions.push((_from, to, bytes) =>
      to.includes("/.staging-") ? new TextEncoder().encode("torn") : bytes,
    );
    let restarts = 0;
    const fixed = host.when(SHOW_GATEWAY, () =>
      onNew() ? null : { stdout: `ActiveState=active\nSubState=running\nNRestarts=${restarts++}\n` },
    );
    expect((await failure(NEW)).code).toBe("HERMES_ROLLBACK_FAILED");
    host.copyCorruptions.length = 0;
    host.commands.length = 0;

    const err = await failure(OLD);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(host.commandsMatching(/^systemctl restart hermes-gateway\.service$/).length).toBe(1);
    expect(held()).toBe(true);

    fixed();
    await apply(makeManifest(OLD), { host });
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(await hermesHeld(host)).toBe(false);
  });

  test("the old Hermes up, its backups not sealed (a full /data) -> HERMES_UPGRADE_ROLLED_BACK with a warning, no operator hold", async () => {
    await boxOn(OLD, "old sessions");
    host.when(/^uv sync /, () => (onNew() ? { code: 1, stderr: "resolver failed" } : null));
    host.writeFaults.push((path) =>
      path.endsWith("/sealed.json") ? new Error("ENOSPC: no space left on device") : null,
    );
    const warnings: string[] = [];

    const err = (await apply(makeManifest(NEW), {
      host,
      emit: (e) => {
        if (e.level === "warn") warnings.push(e.message);
      },
    }).catch((e: unknown) => e)) as AgentdError;
    expect(err).toBeInstanceOf(AgentdError);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(String((err.detail["unsettled"] as { message: string }).message)).toContain("ENOSPC");
    expect(warnings.some((m) => m.includes("not tidied") && m.includes("ENOSPC"))).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(held()).toBe(false);
  });

  /** A rollback whose old Hermes crash-looped until systemd gave up, then NEW asked again with its fetch failing before the hold. */
  async function rollbackFailedThenNewFetchFails(oldStillLoops: boolean): Promise<AgentdError> {
    await boxOn(OLD, "old sessions");
    let oldLoops = true;
    let restarts = 0;
    host.when(SHOW_GATEWAY, () =>
      onNew()
        ? { stdout: "ActiveState=failed\nSubState=failed\nNRestarts=0\n" }
        : oldLoops
          ? { stdout: `ActiveState=active\nSubState=running\nNRestarts=${restarts++}\n` }
          : null,
    );
    expect((await failure(NEW)).code).toBe("HERMES_ROLLBACK_FAILED");
    oldLoops = oldStillLoops;
    for (const unit of UNITS) {
      host.runningUnits.delete(unit);
      host.downUnits.add(unit);
    }
    host.when(/git -C \S+ fetch /, { code: 128, stderr: "fatal: unable to access" });
    host.commands.length = 0;
    const err = await failure(NEW);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
    expect(host.commandsMatching(/^systemctl start /)).toEqual(
      UNITS.map((u) => `systemctl start ${u}`),
    );
    return err;
  }

  test("after a failed rollback, a re-asked upgrade failing before the hold starts the downed old units and, while they still crash-loop, never reports the old version running", async () => {
    const err = await rollbackFailedThenNewFetchFails(true);

    expect(err.code).toBe("HERMES_ROLLBACK_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
  });

  test("after a failed rollback, a re-asked upgrade failing before the hold brings the old units up again, and only then reports the old version running", async () => {
    const err = await rollbackFailedThenNewFetchFails(false);

    expect(err.code).toBe("HERMES_SWAP_ABORTED");
    expect(HERMES_OLD_VERSION_RUNNING).toContain(err.code);
    expect(host.runningUnits.has("hermes-gateway.service")).toBe(true);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
  });

  test("a pre-move abort whose restarted gateway crash-loops -> HERMES_ROLLBACK_FAILED, not the old version reported running", async () => {
    await boxOn(OLD, "old sessions");
    host.copyCorruptions.push((_from, to, bytes) =>
      to.includes("/.staging-") ? new TextEncoder().encode("torn") : bytes,
    );
    oldCrashLoops();
    host.commands.length = 0;

    const err = await failure(NEW);

    expect(err.code).toBe("HERMES_ROLLBACK_FAILED");
    expect((err.detail["cause"] as { code: string }).code).toBe("HERMES_BACKUP_FAILED");
    expect(HERMES_OLD_VERSION_RUNNING).not.toContain(err.code);
    expect(host.commandsMatching(CHECKOUT_MOVES)).toEqual([]);
  });
});

/**
 * The live failure (t4g.small, 1834 MB, no swap): the held web build ran beside
 * the headed Chrome the browser session keeps up, thrashed, and was OOM-killed.
 * A fresh create builds before any browser unit exists, so it never saw this.
 */
describe("the browser session while held, on a t4g.small", () => {
  const SESSION = [
    "xvfb@default.service",
    "hermetic-wm@default.service",
    "x11vnc@default.service",
    "novnc@default.service",
    "hermetic-browser@default.service",
  ];
  const WEB_BUILD = /^pnpm --filter web run build$/;
  const ZIP = "PK chrome-for-testing\n";
  const browserBox = (pin: typeof OLD) =>
    makeManifest({
      ...pin,
      browser: true,
      packages: ["curl", "git", "jq", "nftables", "unzip"],
      units: ["hermeticd.service", ...SESSION, ...UNITS],
    });
  const run = (pin: typeof OLD) => apply(browserBox(pin), { host, getObject: host.getObject });
  const fails = async (pin: typeof OLD): Promise<AgentdError> => {
    const err = await run(pin).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    return err as AgentdError;
  };
  /** The session units up when the web build runs, one list per build. */
  let atBuild: string[][] = [];
  const up = (): string[] => SESSION.filter((u) => host.runningUnits.has(u));
  /** Whether `BUILD_SWAP` is still on disk or still listed as active. */
  const buildSwapLeft = (): boolean =>
    host.files.has(BUILD_SWAP) || (host.files.get("/proc/swaps")?.content ?? "").includes(BUILD_SWAP);
  /** Session units the apply-pending record still owes a restart: a later apply would bounce Chrome. */
  const owedSession = (): string[] => {
    const raw = host.files.get(APPLY_PENDING_PATH)?.content;
    const units = raw === undefined ? [] : (JSON.parse(raw) as { units: string[] }).units;
    return SESSION.filter((u) => units.includes(u));
  };

  beforeEach(async () => {
    host.s3Objects.set(browserBuildKey(TEST_CHROME_REF), new TextEncoder().encode(ZIP));
    host.seed(
      FLEET_CACHE_PATH,
      JSON.stringify(makeFleetManifest({ browser: { [TEST_CHROME_REF]: ZIP } })),
    );
    for (const template of ["xvfb", "hermetic-wm", "x11vnc", "novnc", "hermetic-browser"]) {
      host.seed(
        `/etc/systemd/system/${template}@.service`,
        `# ${HERMETIC_RENDERED_MARKER}. Final file, no templating.\n[Unit]\n`,
      );
    }
    await run(OLD);
    writeState("old sessions");
    expect(up()).toEqual(SESSION);
    host.memoryMb = 1834;
    atBuild = [];
    host.when(WEB_BUILD, () => {
      atBuild.push(up());
      return null;
    });
    host.commands.length = 0;
  });

  test("a passing swap builds with the session stopped and starts it again", async () => {
    await run(NEW);

    expect(atBuild).toEqual([[]]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(up()).toEqual(SESSION);
    expect(ranInOrder(host, [WEB_BUILD, "systemctl restart hermetic-browser@default.service"])).toBe(
      true,
    );
    expect(host.files.has(APPLY_PENDING_PATH)).toBe(false);
    expect(
      ranInOrder(host, [`swapon ${BUILD_SWAP}`, WEB_BUILD, `timeout 300 swapoff ${BUILD_SWAP}`]),
    ).toBe(true);
    expect(buildSwapLeft()).toBe(false);
  });

  test("a web build killed while held (exit 137) rolls back with the session running again", async () => {
    // The old configuration's re-apply, as on a box a converge brought here.
    host.seed(MANIFEST_PATH, JSON.stringify(browserBox(OLD)));
    host.when(WEB_BUILD, () => {
      atBuild.push(up());
      return { code: 137, stderr: "Killed" };
    });

    const err = await fails(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(atBuild).toEqual([[]]);
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(up()).toEqual(SESSION);
    expect(held()).toBe(false);
  });

  test("…and the same with no previous configuration to re-apply", async () => {
    host.when(WEB_BUILD, () => {
      atBuild.push(up());
      return { code: 137, stderr: "Killed" };
    });

    const err = await fails(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(atBuild).toEqual([[]]);
    expect(up()).toEqual(SESSION);
  });

  test("hermeticd dying in the held build: the resumed swap builds without the session and starts it after", async () => {
    const crash = dieAt(WEB_BUILD);
    expect(await run(NEW).catch((e: unknown) => e)).toBeInstanceOf(Error);
    crash.revive();
    expect(up()).toEqual([]);

    await run(NEW);

    expect(atBuild).toEqual([[]]);
    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(up()).toEqual(SESSION);
  });

  test("an abort before the checkout moved (backup invalid) starts the session again", async () => {
    host.copyCorruptions.push((_from, to, bytes) =>
      to.includes("/.staging-") ? new TextEncoder().encode("torn") : bytes,
    );

    const err = await fails(NEW);

    expect(err.code).toBe("HERMES_BACKUP_FAILED");
    expect(host.commandsMatching(/^systemctl stop hermetic-browser@default\.service$/)).toHaveLength(1);
    expect(up()).toEqual(SESSION);
    expect(owedSession()).toEqual([]);
    expect(held()).toBe(false);
  });

  test("an install failing after the checkout moved rolls back inside the swap with Hermes and the session running", async () => {
    host.when(/^uv sync /, () => (onNew() ? { code: 1, stderr: "resolver failed" } : null));

    const err = await fails(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(UNITS.filter((u) => host.runningUnits.has(u))).toEqual(UNITS);
    expect(up()).toEqual(SESSION);
    expect(owedSession()).toEqual([]);
    expect(held()).toBe(false);
  });

  test("a swapfile left active by hermeticd dying in the build is gone after the next apply", async () => {
    const crash = dieAt(WEB_BUILD);
    expect(await run(NEW).catch((e: unknown) => e)).toBeInstanceOf(Error);
    crash.revive();
    expect(buildSwapLeft()).toBe(true);

    await run(NEW);

    expect(host.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect(buildSwapLeft()).toBe(false);
    expect(host.commandsMatching(/^fallocate /)).toHaveLength(2);
  });

  test("hermeticd dying in the held build twice: the next apply rolls back with the session running", async () => {
    for (let i = 0; i < 2; i++) {
      const crash = dieAt(WEB_BUILD);
      expect(await run(NEW).catch((e: unknown) => e)).toBeInstanceOf(Error);
      crash.revive();
    }
    expect(up()).toEqual([]);

    expect(buildSwapLeft()).toBe(true);

    const err = await fails(NEW);

    expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect(up()).toEqual(SESSION);
    // The rollback itself clears the swap before it starts the units, and later applies keep it gone.
    expect(buildSwapLeft()).toBe(false);
    await run(OLD);
    expect(buildSwapLeft()).toBe(false);
  });

  test("a same-ref reapply stops nothing of the session", async () => {
    await run(OLD);

    expectNotRan(host, /^systemctl (stop|restart) (xvfb|hermetic-wm|x11vnc|novnc|hermetic-browser)@/);
    expect(up()).toEqual(SESSION);
  });
});
