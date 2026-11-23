/**
 * A fresh box's first Hermes start on a home the data volume carried over
 * (`apply/hermes-home-record.ts`): invariant I4, every path on which a Hermes
 * first opens a home another version wrote takes a validated backup first, and
 * a recreate back onto the older version restores it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { apply, resetAptIndexState } from "../src/apply/index.ts";
import { HERMES_BACKUP_ROOT } from "../src/apply/hermes-backup.ts";
import {
  HOME_RECORD_PATH,
  backfillHomeRecord,
  readHomeRecord,
  refOrder,
} from "../src/apply/hermes-home-record.ts";
import { HERMES_HOLD_PATH } from "../src/apply/hermes-upgrade.ts";
import { makeAws } from "../src/aws.ts";
import { AgentdError } from "../src/errors.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { run } from "../src/main.ts";
import { MANIFEST_PATH } from "../src/manifest.ts";
import { USER_DATA_JSON_PATH } from "../src/userdata.ts";
import { BoxHost } from "./fake-box.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  makeFleetManifest,
  makeManifest,
  makeUserDataJson,
} from "./fixtures.ts";
import { captureOutput } from "./quiet.ts";

const HOME = "/data/hermes/.hermes";
const DB = `${HOME}/state.db`;
const OLD = { hermes_ref: "v0.21.5", hermes_version: "0.21.5" };
const NEW = { hermes_ref: "v0.23.1", hermes_version: "0.23.1" };
const PATCH = { hermes_ref: "v0.23.2", hermes_version: "0.23.2" };
const DATED = { hermes_ref: "v2026.9.24", hermes_version: "0.21.5" };
const CLONE = /^git clone /;

function freshBox(): BoxHost {
  const box = new BoxHost();
  for (const pin of [OLD, NEW, PATCH, DATED])
    box.hermesVersionByRef.set(pin.hermes_ref, pin.hermes_version);
  box.hermesStampRefs.add(NEW.hermes_ref);
  box.hermesStampRefs.add(PATCH.hermes_ref);
  return box;
}

let host: BoxHost;
beforeEach(() => {
  resetAptIndexState();
  host = freshBox();
});

/** `agent recreate`: a new instance and root volume, the same `/data`, the clock moved on. */
function recreate(from: BoxHost): BoxHost {
  const box = freshBox();
  for (const [path, file] of from.files)
    if (path.startsWith("/data/")) box.files.set(path, { ...file });
  for (const dir of from.dirs) if (dir === "/data" || dir.startsWith("/data/")) box.dirs.add(dir);
  box.advance(from.now().getTime() - box.now().getTime() + 3_600_000);
  resetAptIndexState();
  return box;
}

const sqlite = (body: string): Uint8Array => new TextEncoder().encode(`SQLite format 3\0${body}`);
function writeState(box: BoxHost, state: string): void {
  box.seedBytes(DB, sqlite(state), "0600");
  const file = box.files.get(DB);
  if (file) file.ownership = "hermes:hermes";
  box.advance(60_000);
}
const dbBody = (box: BoxHost, path = DB): string | undefined => box.files.get(path)?.content.slice(16);
const topLevel = (box: BoxHost, prefix: string): string[] =>
  [...box.dirs]
    .filter((d) => d.startsWith(`${HERMES_BACKUP_ROOT}/${prefix}`))
    .filter((d) => d.lastIndexOf("/") === HERMES_BACKUP_ROOT.length)
    .sort();
const backups = (box: BoxHost): string[] => topLevel(box, "hermes-");

async function failure(box: BoxHost, pin: typeof OLD): Promise<AgentdError> {
  const err = await apply(makeManifest(pin), { host: box }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AgentdError);
  return err as AgentdError;
}

describe("a recreate onto a newer Hermes", () => {
  test("backs the old home up before any hermes runs against it, and records the new ref", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    const box = recreate(host);
    const backedUpFirst: boolean[] = [];
    box.when(/hermes gateway install/, () => {
      backedUpFirst.push(backups(box).length === 1);
      return null;
    });

    await apply(makeManifest(NEW), { host: box });

    expect(backedUpFirst).toEqual([true]);
    const [backup] = backups(box);
    expect(backup).toStartWith(`${HERMES_BACKUP_ROOT}/hermes-v0.21.5-`);
    expect(dbBody(box, `${backup}/home/state.db`)).toBe("old sessions");
    const record = await readHomeRecord(box);
    expect(record?.ref).toBe(NEW.hermes_ref);
    expect(record?.before).toBe(backup);
  });

  test("the same version takes no backup; a fresh volume takes none and records the ref", async () => {
    await apply(makeManifest(NEW), { host });
    expect(backups(host)).toEqual([]);
    expect((await readHomeRecord(host))?.ref).toBe(NEW.hermes_ref);
    writeState(host, "sessions");

    const box = recreate(host);
    await apply(makeManifest(NEW), { host: box });

    expect(backups(box)).toEqual([]);
    expect(dbBody(box)).toBe("sessions");
  });

  test("a home with no record takes one backup labelled unrecorded, then none on a same-version recreate", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    await host.remove(HOME_RECORD_PATH);

    const box = recreate(host);
    await apply(makeManifest(NEW), { host: box });
    expect(backups(box).map((d) => d.slice(HERMES_BACKUP_ROOT.length + 1))).toEqual([
      expect.stringMatching(/^hermes-unrecorded-/),
    ]);

    const again = recreate(box);
    await apply(makeManifest(NEW), { host: again });
    expect(backups(again)).toHaveLength(1);
  });

  test("a truncated record reads as none: one backup labelled unrecorded, then the install", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    host.seed(HOME_RECORD_PATH, '{"format":1,"ref":"v0.21', "0600");

    const box = recreate(host);
    await apply(makeManifest(NEW), { host: box });

    expect(backups(box).map((d) => d.slice(HERMES_BACKUP_ROOT.length + 1))).toEqual([
      expect.stringMatching(/^hermes-unrecorded-/),
    ]);
    expect(box.hermesCheckedOutRef).toBe(NEW.hermes_ref);
    expect((await readHomeRecord(box))?.ref).toBe(NEW.hermes_ref);
  });

  test("too little space: HERMES_BACKUP_FAILED, nothing cloned, no hermes run", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    const box = recreate(host);
    if (box.filesystemResult) box.filesystemResult = { ...box.filesystemResult, available: 1 };

    const err = await failure(box, NEW);

    expect(err.code).toBe("HERMES_BACKUP_FAILED");
    expect(box.commandsMatching(CLONE)).toEqual([]);
    expect(box.commandsMatching(/hermes /)).toEqual([]);
    expect(dbBody(box)).toBe("old sessions");
  });

  test("an install that fails after the backup is retried on the same backup, never a second", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    const box = recreate(host);
    const failing = box.when(/^uv sync /, { code: 1, stderr: "resolver failed" });
    await failure(box, NEW);
    failing();
    box.advance(60_000);

    await apply(makeManifest(NEW), { host: box });

    expect(backups(box)).toHaveLength(1);
    expect((await readHomeRecord(box))?.before).toBe(backups(box)[0]);
  });

  test("after an in-place rollback the home is the old version's: a recreate on the new pin backs it up", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    const failing = host.when(/^uv sync /, { code: 1, stderr: "resolver failed" });
    expect((await failure(host, NEW)).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    failing();
    expect((await readHomeRecord(host))?.ref).toBe(OLD.hermes_ref);

    const box = recreate(host);
    await apply(makeManifest(NEW), { host: box });

    expect(backups(box)).toHaveLength(2);
  });

  test("after a sealed in-place upgrade, a same-version recreate takes no backup", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    await apply(makeManifest(NEW), { host });
    expect(backups(host)).toHaveLength(1);

    const box = recreate(host);
    await apply(makeManifest(NEW), { host: box });

    expect(backups(box)).toHaveLength(1);
  });
});

describe("a recreate back onto an older Hermes", () => {
  async function upgradedByRecreate(): Promise<BoxHost> {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    const box = recreate(host);
    await apply(makeManifest(NEW), { host: box });
    writeState(box, "written by 0.23");
    return recreate(box);
  }

  test("restores the older version's backup before its Hermes runs; the newer state is moved aside", async () => {
    const box = await upgradedByRecreate();
    const seen: Array<string | undefined> = [];
    box.when(/hermes gateway install/, () => {
      seen.push(dbBody(box));
      return null;
    });

    await apply(makeManifest(OLD), { host: box });

    expect(seen).toEqual(["old sessions"]);
    const [aside] = topLevel(box, "post-");
    expect(aside).toStartWith(`${HERMES_BACKUP_ROOT}/post-v0.23.1-`);
    expect(dbBody(box, `${aside}/home/state.db`)).toBe("written by 0.23");
    expect((await readHomeRecord(box))?.ref).toBe(OLD.hermes_ref);
  });

  test("a restore done before the install failed is not redone by the retry", async () => {
    const box = await upgradedByRecreate();
    const failing = box.when(/^uv venv /, { code: 1, stderr: "no python" });
    await failure(box, OLD);
    failing();
    box.advance(60_000);

    await apply(makeManifest(OLD), { host: box });

    expect(topLevel(box, "post-")).toHaveLength(1);
    expect(dbBody(box)).toBe("old sessions");
  });

  test("with no backup of the older version: HERMES_RESTORE_REFUSED, nothing installed, state untouched", async () => {
    await apply(makeManifest(NEW), { host });
    writeState(host, "born on 0.23");
    const box = recreate(host);

    const err = await failure(box, OLD);

    expect(err.code).toBe("HERMES_RESTORE_REFUSED");
    expect(box.commandsMatching(CLONE)).toEqual([]);
    expect(dbBody(box)).toBe("born on 0.23");
    expect(topLevel(box, "post-")).toEqual([]);
  });

  test("an unrecorded home's first-start backup is what a downgrade restores", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    await host.remove(HOME_RECORD_PATH);
    const upgraded = recreate(host);
    await apply(makeManifest(NEW), { host: upgraded });
    writeState(upgraded, "written by 0.23");
    const box = recreate(upgraded);

    await apply(makeManifest(OLD), { host: box });

    expect(dbBody(box)).toBe("old sessions");
  });

  const homeFiles = (box: BoxHost): Array<[string, string]> =>
    [...box.files].filter(([p]) => p.startsWith(`${HOME}/`)).map(([p, f]) => [p, f.content]);

  /** The first file the restore copies back fails to land: an intent, no completion. */
  async function interruptedRestore(box: BoxHost): Promise<string> {
    box.writeFaults.push((path) => (path === DB ? new Error("EIO") : null));
    const err = await failure(box, OLD);
    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(box.commandsMatching(CLONE)).toEqual([]);
    box.writeFaults.length = 0;
    box.advance(60_000);
    return err.detail["moved_aside"] as string;
  }

  test("an interrupted first-start restore is finished by a retry on the same target from the same backup", async () => {
    const box = await upgradedByRecreate();
    const aside = await interruptedRestore(box);

    await apply(makeManifest(OLD), { host: box });

    expect(dbBody(box)).toBe("old sessions");
    const asides = topLevel(box, "post-");
    expect(asides).toHaveLength(2);
    expect(asides[0]).toBe(aside);
    expect(dbBody(box, `${aside}/home/state.db`)).toBe("written by 0.23");
    expect(box.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect((await readHomeRecord(box))?.ref).toBe(OLD.hermes_ref);
  });

  test("an interrupted first-start restore refuses another target: nothing installed, home untouched, the message names its target", async () => {
    const box = await upgradedByRecreate();
    const aside = await interruptedRestore(box);
    const home = homeFiles(box);

    const err = await failure(box, PATCH);

    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(err.message).toContain(`hermes ${OLD.hermes_ref} was interrupted`);
    expect(err.message).toContain(aside);
    expect(box.commandsMatching(CLONE)).toEqual([]);
    expect(homeFiles(box)).toEqual(home);
    expect(topLevel(box, "post-")).toEqual([aside]);
  });

  test("an interrupted restore of an unrecorded home's backup is finished by a retry on the same target, and the home is then the target's", async () => {
    await apply(makeManifest(OLD), { host });
    writeState(host, "old sessions");
    await host.remove(HOME_RECORD_PATH);
    const upgraded = recreate(host);
    await apply(makeManifest(NEW), { host: upgraded });
    writeState(upgraded, "written by 0.23");
    const box = recreate(upgraded);
    const aside = await interruptedRestore(box);

    // Another target refuses, naming the one the restore was for.
    const err = await failure(box, PATCH);
    expect(err.code).toBe("HERMES_RESTORE_FAILED");
    expect(err.message).toContain(`hermes ${OLD.hermes_ref} was interrupted`);

    await apply(makeManifest(OLD), { host: box });

    expect(dbBody(box)).toBe("old sessions");
    expect(dbBody(box, `${aside}/home/state.db`)).toBe("written by 0.23");
    expect(box.hermesCheckedOutRef).toBe(OLD.hermes_ref);
    expect((await readHomeRecord(box))?.ref).toBe(OLD.hermes_ref);

    // The fallback restore reads as the target's home: a same-version recreate backs up and restores nothing.
    const again = recreate(box);
    const before = [backups(again), topLevel(again, "post-")];
    await apply(makeManifest(OLD), { host: again });
    expect([backups(again), topLevel(again, "post-")]).toEqual(before);
    expect(dbBody(again)).toBe("old sessions");
  });

  test("a patch-level step back restores nothing and backs nothing up", async () => {
    await apply(makeManifest(PATCH), { host });
    writeState(host, "0.23.2 sessions");
    const box = recreate(host);

    await apply(makeManifest(NEW), { host: box });

    expect(dbBody(box)).toBe("0.23.2 sessions");
    expect(backups(box)).toEqual([]);
    expect(topLevel(box, "post-")).toEqual([]);
  });
});

describe("the record", () => {
  test("serve's backfill names the installed ref on a settled box, and waits out a held one", async () => {
    await apply(makeManifest(OLD), { host });
    await host.remove(HOME_RECORD_PATH);
    host.seed(HERMES_HOLD_PATH, host.now().toISOString(), "0600");
    expect(await backfillHomeRecord(host)).toBe(false);
    await host.remove(HERMES_HOLD_PATH);

    expect(await backfillHomeRecord(host)).toBe(true);
    expect((await readHomeRecord(host))?.ref).toBe(OLD.hermes_ref);
    expect(await backfillHomeRecord(host)).toBe(false);
  });

  test("refOrder: SemVer by version, date tags by date and before any SemVer tag, else unknown", () => {
    expect(refOrder("v0.21.5", "v0.23.1")).toBe(-1);
    expect(refOrder("v0.23.2", "v0.23.1")).toBe(1);
    expect(refOrder("v2026.9.24", "v0.21.6")).toBe(-1);
    expect(refOrder("v0.21.6", "v2026.9.24")).toBe(1);
    expect(refOrder("v2026.9.14", "v2026.9.24")).toBe(-1);
    expect(refOrder("main", "v0.23.1")).toBeNull();
  });
});

describe("a stage's hermeticd apply (agent recreate)", () => {
  captureOutput();

  test("records the first start's backup in agent history before the stage ends", async () => {
    await apply(makeManifest(DATED), { host });
    writeState(host, "old sessions");
    const box = recreate(host);
    const config = { ...makeManifest(NEW), config_hash: "c0nfn3w2" };
    const ddb = new RecordingSink();
    ddb.byCommand.set("GetCommand", () => ({ Item: { name: TEST_NAME, status: "ready", version: 3 } }));
    ddb.byCommand.set("PutCommand", () => ({}));
    ddb.byCommand.set("UpdateCommand", () => ({}));
    const aws = makeAws({
      ddb,
      ssm: new RecordingSink(),
      s3: new RecordingSink(),
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => box.now(),
    });
    box.seed(USER_DATA_JSON_PATH, makeUserDataJson());
    box.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
    box.seed(MANIFEST_PATH, JSON.stringify(config));

    await run(["apply"], box, { aws: () => aws });

    const upgrades = ddb.calls
      .map((c) => (c as { input?: { Item?: { action?: string; detail?: string } } }).input?.Item)
      .filter((item) => item?.action === "upgrade")
      .map((item) => item?.detail ?? "");
    expect(upgrades.some((d) => d.includes("before the first start of v0.23.1"))).toBe(true);
  });
});

describe("seams with the laptop's v0.21.5 render (S1)", () => {
  test("a fresh box installs v2026.9.24 by the legacy recipe, and a re-apply reinstalls nothing", async () => {
    await apply(makeManifest(DATED), { host });
    expect(host.commandsMatching(/^uv sync /)).toEqual([]);
    expect(host.commandsMatching(/^uv pip install /)).toHaveLength(1);
    host.commands.length = 0;

    await apply(makeManifest(DATED), { host });

    expect(host.commandsMatching(/^git (clone|-C \S+ (fetch|checkout))|^uv /)).toEqual([]);
    expect(backups(host)).toEqual([]);
  });
});
