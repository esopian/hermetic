/**
 * The pre-upgrade backup of `$HERMES_HOME` and the downgrade restore from it
 * (`apply/hermes-backup.ts`), against the fake host — plus the three host
 * primitives they add, against the real one in a temp directory.
 */
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HERMES_BACKUP_ROOT,
  backupHermesHome,
  restoreHermesHome,
  unfinishedRestores,
} from "../src/apply/hermes-backup.ts";
import { AgentdError } from "../src/errors.ts";
import { realHost } from "../src/host.ts";
import { FakeHost } from "./fake-host.ts";

const HOME = "/data/hermes/.hermes";
const FROM = "0.21.5";
const TO = "0.23.1";

const sqlite = (body: string): Uint8Array => new TextEncoder().encode(`SQLite format 3\0${body}`);
const text = (body: string): Uint8Array => new TextEncoder().encode(body);

/** A file under the home, owned by the agent account like everything Hermes writes. */
function put(host: FakeHost, rel: string, bytes: Uint8Array, mode = "0600"): void {
  host.seedBytes(`${HOME}/${rel}`, bytes, mode);
  const file = host.files.get(`${HOME}/${rel}`);
  if (file) file.ownership = "hermes:hermes";
}

/** Everything backed up, relative to the home. */
const KEPT: Record<string, Uint8Array> = {
  "state.db": sqlite("root sessions"),
  "state.db-wal": text("root wal"),
  "state.db-shm": text("root shm"),
  "memory_store.db": sqlite("holographic"),
  "memory_store.db-wal": text("holographic wal"),
  "cron/jobs.json": text('{"jobs":[]}'),
  "cron/executions.db": sqlite("executions"),
  "config.yaml": text("model: x\n"),
  "gateway_state.json": text('{"state":"running"}'),
  "memories/USER.md": text("likes tea"),
  "skills/odd/blob.bin": sqlite("a database by its header, not its name"),
  "profiles/alpha/state.db": sqlite("alpha sessions"),
  "profiles/alpha/state.db-wal": text("alpha wal"),
  "profiles/alpha/state.db-shm": text("alpha shm"),
  "profiles/alpha/profile.yaml": text("name: alpha\n"),
  "profiles/alpha/config.yaml": text("model: y\n"),
  "profiles/alpha/cron/jobs.json": text('{"jobs":[1]}'),
  "profiles/alpha/memories/MEMORY.md": text("alpha remembers"),
  "profiles/beta/kanban.db": sqlite("beta board"),
  "profiles/beta/kanban.db-journal": text("beta journal"),
};

/** Present in the home and never copied. */
const LEFT: Record<string, Uint8Array> = {
  ".env": text("OPENAI_API_KEY=FIXTURE"),
  "auth.json": text("{}"),
  "skills/foo/SKILL.md": text("# foo"),
  "cache/bws_cache.db": sqlite("cache"),
  "logs/agent.log": text("log"),
  "installs/x/lib.db": sqlite("install"),
  "lazy-packages/y.db": sqlite("lazy"),
  "profiles/alpha/cache/z.db": sqlite("profile cache"),
  "profiles/alpha/logs/errors.log": text("err"),
};

let host: FakeHost;

beforeEach(() => {
  host = new FakeHost();
  for (const [rel, bytes] of Object.entries({ ...KEPT, ...LEFT })) put(host, rel, bytes);
  put(host, "config.yaml", KEPT["config.yaml"] as Uint8Array, "0644");
  host.dirAttrs.set(HOME, { mode: "0700", ownership: "hermes:hermes" });
  host.dirAttrs.set(`${HOME}/profiles/alpha`, { mode: "0750", ownership: "hermes:hermes" });
  host.dirAttrs.set(`${HOME}/profiles/beta`, { mode: "0700", ownership: "hermes:hermes" });
  // A symlink in a covered tree is neither followed nor kept.
  host.symlink(`${HOME}/memories/shadow`, "/etc/shadow");
  host.seed("/etc/shadow", "root:FIXTURE");
});

const snapshot = (h: FakeHost): Map<string, string> =>
  new Map(
    [...h.files]
      .filter(([p]) => p.startsWith(`${HOME}/`))
      .map(([p, f]) => [p, `${f.mode} ${f.ownership} ${f.content}`]),
  );

const backupDirsOn = async (h: FakeHost): Promise<string[]> =>
  (await h.readdir(HERMES_BACKUP_ROOT)).filter((n) => n.startsWith("hermes-") || n.startsWith("."));

async function codeOf(work: Promise<unknown>): Promise<AgentdError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentdError);
    return error as AgentdError;
  }
  throw new Error("expected a throw");
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("backupHermesHome", () => {
  test("copies every SQLite store with its sidecars and the covered files, root-owned 0700, with a matching manifest", async () => {
    const before = snapshot(host);
    const result = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });

    expect(result.dir).toBe(`${HERMES_BACKUP_ROOT}/hermes-${FROM}-20260901T120000Z`);
    expect(result.reused).toBe(false);
    const copied = [...host.files.keys()]
      .filter((p) => p.startsWith(`${result.dir}/home/`))
      .map((p) => p.slice(`${result.dir}/home/`.length))
      .sort();
    expect(copied).toEqual(Object.keys(KEPT).sort());
    for (const [rel, bytes] of Object.entries(KEPT)) {
      expect(await host.readBytes(`${result.dir}/home/${rel}`)).toEqual(bytes);
      const copy = await host.lstat(`${result.dir}/home/${rel}`);
      expect([copy?.mode, copy?.uid, copy?.gid]).toEqual(["0600", 0, 0]);
    }

    for (const dir of [
      HERMES_BACKUP_ROOT,
      result.dir,
      [result.dir, "home", "profiles", "alpha"].join("/"),
    ]) {
      const s = await host.lstat(dir);
      expect([dir, s?.mode, s?.uid, s?.gid]).toEqual([dir, "0700", 0, 0]);
    }

    const manifest = JSON.parse((await host.readFile(`${result.dir}/manifest.json`)) as string);
    expect(manifest.from_version).toBe(FROM);
    expect(manifest.hermes_home).toBe(HOME);
    expect(manifest.databases).toEqual(
      [
        "cron/executions.db",
        "memory_store.db",
        "profiles/alpha/state.db",
        "profiles/beta/kanban.db",
        "skills/odd/blob.bin",
        "state.db",
      ].sort(),
    );
    const byPath = new Map(manifest.files.map((f: { path: string }) => [f.path, f]));
    for (const [rel, bytes] of Object.entries(KEPT)) {
      expect(byPath.get(rel)).toEqual({
        path: rel,
        size: bytes.byteLength,
        sha256: sha(bytes),
        mode: rel === "config.yaml" ? "0644" : "0600",
        uid: 1000,
        gid: 1000,
      });
    }
    expect(manifest.dirs).toContainEqual({
      path: "profiles/alpha",
      mode: "0750",
      uid: 1000,
      gid: 1000,
    });
    expect(snapshot(host)).toEqual(before);
    expect(host.rootFsCalls).not.toContain(`copyFile ${HOME}/memories/shadow`);
  });

  /**
   * The stores that must travel with `state.db` (0.23.1): the gateway's
   * `sessions/sessions.json` mirrors its routing table, `response_store.db`
   * resolves sessions through it, and the kanban and holographic memory stores
   * are user data — at the root and in every profile.
   */
  test("covers sessions/ and the stores that travel with state.db, at the root and per profile, and a restore puts them back", async () => {
    const extra: Record<string, Uint8Array> = {
      "sessions/sessions.json": text('{"agent:main:telegram:1":"s1"}'),
      "profiles/alpha/sessions/sessions.json": text('{"agent:alpha:slack:2":"s2"}'),
      "response_store.db": sqlite("responses"),
      "response_store.db-wal": text("responses wal"),
      "profiles/alpha/response_store.db": sqlite("alpha responses"),
      "kanban.db": sqlite("default board"),
      "kanban/boards/ops/kanban.db": sqlite("ops board"),
      "profiles/beta/memory_store.db": sqlite("beta holographic"),
    };
    for (const [rel, bytes] of Object.entries(extra)) put(host, rel, bytes);

    const result = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });

    for (const [rel, bytes] of Object.entries(extra)) {
      expect([rel, await host.readBytes(`${result.dir}/home/${rel}`)]).toEqual([rel, bytes]);
    }
    const manifest = JSON.parse((await host.readFile(`${result.dir}/manifest.json`)) as string);
    expect(manifest.roots).toEqual(expect.arrayContaining(["sessions", "profiles/alpha/sessions"]));
    expect(manifest.databases).toEqual(
      expect.arrayContaining([
        "response_store.db",
        "profiles/alpha/response_store.db",
        "kanban.db",
        "kanban/boards/ops/kanban.db",
        "memory_store.db",
        "profiles/beta/memory_store.db",
      ]),
    );

    // The newer gateway rewrites its routing mirror; the restore brings back the one matching state.db.
    put(host, "sessions/sessions.json", text('{"agent:main:telegram:1":"s9"}'));
    put(host, "state.db", sqlite("migrated"));
    await restoreHermesHome(host, { hermesHome: HOME, toVersion: FROM, leftVersion: TO });
    expect(await host.readBytes(`${HOME}/sessions/sessions.json`)).toEqual(
      extra["sessions/sessions.json"] as Uint8Array,
    );
    expect(await host.readBytes(`${HOME}/state.db`)).toEqual(KEPT["state.db"] as Uint8Array);
  });

  test("a copy that lands different from its source fails the backup and publishes nothing", async () => {
    const before = snapshot(host);
    host.copyCorruptions.push((from, _to, bytes) =>
      from.endsWith("/profiles/alpha/state.db") ? bytes.map((b, i) => (i === 20 ? b ^ 1 : b)) : bytes,
    );
    const error = await codeOf(backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM }));
    expect(error.code).toBe("HERMES_BACKUP_FAILED");
    expect(error.detail.reason).toBe("mismatch");
    expect(await backupDirsOn(host)).toEqual([]);
    expect(snapshot(host)).toEqual(before);
  });

  test("too little free space refuses before anything is copied", async () => {
    host.filesystemResult = { mount: "/data", size: 10_000_000, available: 1_000_000, usePct: 90 };
    const error = await codeOf(backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM }));
    expect(error.code).toBe("HERMES_BACKUP_FAILED");
    expect(error.detail.reason).toBe("no-space");
    expect(host.rootFsCalls.filter((c) => c.startsWith("copyFile"))).toEqual([]);
    expect(await backupDirsOn(host)).toEqual([]);
  });

  test("a retry reuses the first validated backup and never takes a second", async () => {
    const first = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });
    // The retry finds the source already migrated: the first copy is the one to keep.
    put(host, "state.db", sqlite("migrated to v33"));
    host.advance(60_000);
    const second = await backupHermesHome(host, {
      hermesHome: HOME,
      fromVersion: FROM,
      reuse: first.dir,
    });

    expect(second).toEqual({ ...first, reused: true });
    expect(await backupDirsOn(host)).toEqual([first.dir.slice(HERMES_BACKUP_ROOT.length + 1)]);
    expect(await host.readBytes(`${first.dir}/home/state.db`)).toEqual(KEPT["state.db"] as Uint8Array);
  });

  test("an unsealed backup the swap record does not name is never reused", async () => {
    const stale = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });
    // The old Hermes ran on after the crash that left it.
    put(host, "state.db", sqlite("written after the crash"));
    host.advance(60_000);
    const fresh = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });

    expect(fresh.reused).toBe(false);
    expect(fresh.dir).not.toBe(stale.dir);
    expect(await host.readBytes(`${fresh.dir}/home/state.db`)).toEqual(
      sqlite("written after the crash"),
    );
    // Kept, not deleted.
    expect(await host.readBytes(`${stale.dir}/home/state.db`)).toEqual(KEPT["state.db"] as Uint8Array);
  });

  test("a backup with an invalid manifest is kept untouched and a fresh one taken beside it", async () => {
    const broken = `${HERMES_BACKUP_ROOT}/hermes-${FROM}-20260801T000000Z`;
    host.seed(`${broken}/manifest.json`, "{ not json");
    host.seed(`${broken}/home/state.db`, "half");
    const tampered = `${HERMES_BACKUP_ROOT}/hermes-${FROM}-20260802T000000Z`;
    await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });
    await host.rename(`${HERMES_BACKUP_ROOT}/hermes-${FROM}-20260901T120000Z`, tampered);
    host.files.set(`${tampered}/home/state.db`, { content: "tampered", mode: "0600" });

    host.advance(60_000);
    const fresh = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });

    expect(fresh.reused).toBe(false);
    expect(fresh.dir).toBe(`${HERMES_BACKUP_ROOT}/hermes-${FROM}-20260901T120100Z`);
    expect(await host.readFile(`${broken}/manifest.json`)).toBe("{ not json");
    expect(await host.readFile(`${broken}/home/state.db`)).toBe("half");
    expect(await host.readFile(`${tampered}/home/state.db`)).toBe("tampered");
  });

  test("a crashed attempt's staging copy is removed, even one that verifies, and never published", async () => {
    const partial = `${HERMES_BACKUP_ROOT}/.staging-hermes-${FROM}-20260801T000000Z`;
    host.seed(`${partial}/home/state.db`, "partial");
    const done = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });
    expect(await host.lstat(partial)).toBeNull();

    // The rename that published it was lost to a power cut.
    const name = done.dir.slice(HERMES_BACKUP_ROOT.length + 1);
    await host.rename(done.dir, `${HERMES_BACKUP_ROOT}/.staging-${name}`);
    host.advance(60_000);
    put(host, "state.db", sqlite("written after the crash"));
    const again = await backupHermesHome(host, {
      hermesHome: HOME,
      fromVersion: FROM,
      reuse: done.dir,
    });
    expect(again.reused).toBe(false);
    expect(again.dir).not.toBe(done.dir);
    expect(await host.lstat(`${HERMES_BACKUP_ROOT}/.staging-${name}`)).toBeNull();
    expect(await host.lstat(done.dir)).toBeNull();
    expect(await backupDirsOn(host)).toEqual([again.dir.slice(HERMES_BACKUP_ROOT.length + 1)]);
    expect(await host.readBytes(`${again.dir}/home/state.db`)).toEqual(
      sqlite("written after the crash"),
    );
  });
});

describe("restoreHermesHome", () => {
  /** Back up, then let "the new version" run: rewrite, add, and re-own state. */
  async function upgraded(): Promise<string> {
    const { dir } = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });
    put(host, "state.db", sqlite("schema 33"));
    put(host, "memory_store.db-shm", text("post-upgrade shm"));
    put(host, "profiles/alpha/state.db-wal", text("post-upgrade alpha wal"));
    put(host, "projects.db", sqlite("new store"));
    put(host, "cron/new.json", text("{}"));
    put(host, "profiles/gamma/config.yaml", text("model: z\n"));
    host.files.set(`${HOME}/config.yaml`, {
      content: "rewritten",
      mode: "0666",
      ownership: "root:root",
    });
    await host.remove(`${HOME}/profiles/beta`);
    host.advance(3_600_000);
    return dir;
  }

  test("moves the current state aside, restores bytes, modes and ownership, and verifies", async () => {
    const backup = await upgraded();
    const result = await restoreHermesHome(host, {
      hermesHome: HOME,
      toVersion: FROM,
      leftVersion: TO,
    });

    const post = `${HERMES_BACKUP_ROOT}/post-${TO}-20260901T130000Z`;
    expect(result).toEqual({ backup, movedAside: post, files: Object.keys(KEPT).length });
    for (const [rel, bytes] of Object.entries(KEPT)) {
      expect(await host.readBytes(`${HOME}/${rel}`)).toEqual(bytes);
      const s = await host.lstat(`${HOME}/${rel}`);
      expect([rel, s?.mode, s?.uid, s?.gid]).toEqual([
        rel,
        rel === "config.yaml" ? "0644" : "0600",
        1000,
        1000,
      ]);
    }
    expect(await host.lstat(`${HOME}/profiles/beta`)).toMatchObject({ mode: "0700", uid: 1000 });

    // Everything the new version wrote is beside the backup, not destroyed.
    for (const rel of [
      "state.db",
      "memory_store.db-shm",
      "profiles/alpha/state.db-wal",
      "projects.db",
      "cron/new.json",
      "config.yaml",
    ]) {
      expect(await host.lstat(`${post}/home/${rel}`)).not.toBeNull();
    }
    expect(await host.readBytes(`${post}/home/state.db`)).toEqual(sqlite("schema 33"));
    for (const rel of ["memory_store.db-shm", "projects.db", "cron/new.json"]) {
      expect(await host.lstat(`${HOME}/${rel}`)).toBeNull();
    }
    expect(await host.readFile(`${HOME}/profiles/alpha/state.db-wal`)).toBe("alpha wal");
    // Not covered by the backup and not a database: left where it was.
    expect(await host.readFile(`${HOME}/profiles/gamma/config.yaml`)).toBe("model: z\n");
    expect(await host.readFile(`${HOME}/.env`)).toBe("OPENAI_API_KEY=FIXTURE");
    expect(await host.lstat(post)).toMatchObject({ mode: "0700", uid: 0 });
    expect(JSON.parse((await host.readFile(`${post}/restore.json`)) as string)).toMatchObject({
      restored_from: backup,
    });
  });

  test("an upgrade after a finished rollback takes a fresh backup instead of reusing the restored one", async () => {
    const restored = await upgraded();
    await restoreHermesHome(host, { hermesHome: HOME, toVersion: FROM, leftVersion: TO });
    host.advance(60_000);
    const next = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM, reuse: restored });
    expect(next.reused).toBe(false);
    expect(next.dir).not.toBe(restored);
  });

  test("with no backup for the target version, refuses and moves nothing", async () => {
    await backupHermesHome(host, { hermesHome: HOME, fromVersion: "0.20.0" });
    const before = snapshot(host);
    const error = await codeOf(
      restoreHermesHome(host, { hermesHome: HOME, toVersion: FROM, leftVersion: TO }),
    );
    expect(error.code).toBe("HERMES_RESTORE_REFUSED");
    expect(error.detail.reason).toBe("no-backup");
    expect(snapshot(host)).toEqual(before);
    expect((await host.readdir(HERMES_BACKUP_ROOT)).filter((n) => n.startsWith("post-"))).toEqual([]);
  });

  test("a backup that no longer verifies is not restored", async () => {
    const backup = await upgraded();
    host.files.set(`${backup}/home/state.db`, { content: "bit rot", mode: "0600" });
    const before = snapshot(host);
    const error = await codeOf(
      restoreHermesHome(host, { hermesHome: HOME, toVersion: FROM, leftVersion: TO }),
    );
    expect(error.code).toBe("HERMES_RESTORE_REFUSED");
    expect(snapshot(host)).toEqual(before);
  });

  test("a newest backup that no longer verifies is refused, never passed over for an older one", async () => {
    const older = await upgraded();
    const newest = await backupHermesHome(host, { hermesHome: HOME, fromVersion: FROM });
    expect(newest.dir).not.toBe(older);
    host.files.set(`${newest.dir}/home/state.db`, { content: "bit rot", mode: "0600" });
    const before = snapshot(host);
    const error = await codeOf(
      restoreHermesHome(host, { hermesHome: HOME, toVersion: FROM, leftVersion: TO }),
    );
    expect(error.code).toBe("HERMES_RESTORE_REFUSED");
    expect(error.detail.reason).toBe("no-backup");
    expect(error.detail.path).toBe(newest.dir);
    expect(error.message).toContain(newest.dir);
    expect(snapshot(host)).toEqual(before);
    expect(await host.readBytes(`${HOME}/state.db`)).toEqual(sqlite("schema 33"));
    expect((await host.readdir(HERMES_BACKUP_ROOT)).filter((n) => n.startsWith("post-"))).toEqual([]);
  });

  test("a completion hides exactly the unfinished restores it lists, whatever their names", async () => {
    const backup = await upgraded();
    const intent = (left: string): string =>
      `${JSON.stringify({ restored_from: backup, to_version: FROM, left_version: left })}\n`;
    // A crashed restore named after the one that finishes it: the clock stepped back.
    const crashed = `${HERMES_BACKUP_ROOT}/post-${TO}-20260901T140000Z`;
    host.seed(`${crashed}/restore-intent.json`, intent(TO));
    // Its supersede mark is lost: only the completion record's list hides it.
    host.writeFaults.push((path) => (path === `${crashed}/restore.json` ? new Error("EIO") : null));
    const { movedAside } = await restoreHermesHome(host, {
      hermesHome: HOME,
      toVersion: FROM,
      leftVersion: TO,
    });
    expect(movedAside).toBe(`${HERMES_BACKUP_ROOT}/post-${TO}-20260901T130000Z`);
    // Crashed later, named earlier than the completion, and listed by none.
    const unlisted = `${HERMES_BACKUP_ROOT}/post-${TO}-20260901T120000Z`;
    host.seed(`${unlisted}/restore-intent.json`, intent(TO));

    expect(await unfinishedRestores(host)).toEqual([
      { dir: unlisted, backup, toVersion: FROM, leftVersion: TO },
    ]);
  });

  test("a failure after the move names where the moved state is", async () => {
    await upgraded();
    host.writeFaults.push((path) => (path === `${HOME}/memories/USER.md` ? new Error("EIO") : null));
    const error = await codeOf(
      restoreHermesHome(host, { hermesHome: HOME, toVersion: FROM, leftVersion: TO }),
    );
    const post = `${HERMES_BACKUP_ROOT}/post-${TO}-20260901T130000Z`;
    expect(error.code).toBe("HERMES_RESTORE_FAILED");
    expect(error.detail.moved_aside).toBe(post);
    expect(error.message).toContain(post);
    expect(await host.readBytes(`${post}/home/state.db`)).toEqual(sqlite("schema 33"));
    expect(await host.readFile(`${post}/restore.json`)).toBeNull();
  });
});

describe("the real host's copy primitives", () => {
  const real = realHost();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hermeticd-backup-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("copyFile copies bytes to a new 0600 file and refuses symlinks and existing targets", async () => {
    await writeFile(join(dir, "a.db"), sqlite("x".repeat(3 << 20)), { mode: 0o644 });
    await real.copyFile(join(dir, "a.db"), join(dir, "b.db"));
    expect(await readFile(join(dir, "b.db"))).toEqual(await readFile(join(dir, "a.db")));
    expect((await lstat(join(dir, "b.db"))).mode & 0o777).toBe(0o600);

    await expect(real.copyFile(join(dir, "a.db"), join(dir, "b.db"))).rejects.toThrow(/EEXIST/);
    await symlink(join(dir, "a.db"), join(dir, "link"));
    await expect(real.copyFile(join(dir, "link"), join(dir, "c.db"))).rejects.toThrow();
    await expect(real.copyFile(join(dir, "a.db"), join(dir, "link"))).rejects.toThrow();
    expect(await real.lstat(join(dir, "c.db"))).toBeNull();
  });

  test("readPrefix reads the header without following a symlink; lstat reports owner and kind", async () => {
    await writeFile(join(dir, "a.db"), sqlite("body"));
    expect(new TextDecoder().decode((await real.readPrefix(join(dir, "a.db"), 16)) ?? undefined)).toBe(
      "SQLite format 3\0",
    );
    expect(await real.readPrefix(join(dir, "missing"), 16)).toBeNull();
    await symlink(join(dir, "a.db"), join(dir, "link"));
    await expect(real.readPrefix(join(dir, "link"), 16)).rejects.toThrow();

    const s = await real.lstat(join(dir, "a.db"));
    expect(s).toMatchObject({ isFile: true, isDirectory: false, isSymlink: false });
    expect(s?.uid).toBe(process.getuid?.() ?? -1);
    expect((await real.lstat(join(dir, "link")))?.isFile).toBe(false);
    await real.chown(join(dir, "a.db"), s?.uid ?? 0, s?.gid ?? 0);
  });
});
