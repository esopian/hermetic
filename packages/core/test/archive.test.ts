/**
 * The recovery archive of §6.6 step 2.
 *
 * Three properties, and the third is the one that would be a security incident
 * if it broke: the archive holds everything needed to read a fleet back
 * (`archive.ts` contents), exactly one previous version is kept on both sides,
 * and it contains SSM parameter *names* and never a value (§8.3) — an archive is
 * the artifact most likely to be read later by somebody who was not there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  seedFixtureAgents,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { FLEET_MANIFEST_KEY } from "../src/schema/index.ts";
import {
  ARCHIVE_COMPLETE_KEY,
  ARCHIVE_STAGING_MARK,
  archiveDirName,
  archivePrefix,
  archiveStagingPrefix,
  createArchive,
} from "../src/agents/archive.ts";
import { HermeticError } from "../src/errors.ts";
import type { OpEvent } from "../src/schema/index.ts";
import { Database } from "bun:sqlite";
import { openLocalDb } from "../src/local/db/index.ts";

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hermetic-archive-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

function fleet(): MemoryBackend {
  return seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
}

function archiver(
  backend: MemoryBackend,
  extra: {
    archiveDir?: string;
    archiveLocalDb?: (p: string) => void;
    attemptId?: () => string;
  } = {},
) {
  return createArchive({
    backend,
    nowIso: () => backend.now().toISOString(),
    ...extra,
  });
}

const target = {
  fleetId: FIXTURE_CONFIG.fleet_id,
  version: 0,
  actor: FIXTURE_CONFIG.frozen_by,
  from: 0,
  to: 1,
};

async function run(
  gen: AsyncGenerator<OpEvent, unknown>,
): Promise<{ events: OpEvent[]; result: unknown }> {
  const events: OpEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("the remote archive", () => {
  test("holds the manifest, every config object and the fleet's state as JSON", async () => {
    const backend = fleet();
    const { result } = await run(archiver(backend).archive(target));
    const prefix = archivePrefix(0);
    const keys = (result as { keys: string[] }).keys;

    expect(keys).toContain(`${prefix}${FLEET_MANIFEST_KEY}`);
    for (const doc of [
      "fleet.json",
      "agents.json",
      "events.json",
      "ssm-paths.json",
      "s3-listing.json",
      "archived-at.json",
    ]) {
      expect(keys).toContain(`${prefix}${doc}`);
    }
    // Every config tarball, copied server-side rather than re-uploaded.
    const configs = await backend.artifacts.list("config/");
    expect(configs.length).toBeGreaterThan(0);
    for (const key of configs) expect(keys).toContain(`${prefix}${key}`);

    // The release directories are immutable per version and are NOT copied.
    expect(keys.some((k) => k.includes("/artifacts/"))).toBe(false);

    const fleetJson = JSON.parse((await backend.artifacts.getText(`${prefix}fleet.json`)) as string);
    expect(fleetJson.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    const agentsJson = JSON.parse((await backend.artifacts.getText(`${prefix}agents.json`)) as string);
    expect(agentsJson.length).toBe(backend.agents.size);
    const meta = JSON.parse((await backend.artifacts.getText(`${prefix}archived-at.json`)) as string);
    expect(meta).toMatchObject({ foundation_version: 0, fleet_id: FIXTURE_CONFIG.fleet_id });
  });

  test("records SSM parameter names and no value of any kind", async () => {
    const backend = fleet();
    // The fixture's own sentinel secrets are in the parameter store already.
    expect([...backend.params.values()].some((v) => v.includes("FIXTURE"))).toBe(true);
    await run(archiver(backend).archive(target));

    const paths = JSON.parse(
      (await backend.artifacts.getText(`${archivePrefix(0)}ssm-paths.json`)) as string,
    ) as string[];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.startsWith("/"))).toBe(true);

    // Nothing anywhere under the archive prefix may contain a stored value.
    const values = [...backend.params.values()];
    for (const key of await backend.artifacts.list("archive/")) {
      const bytes = (await backend.artifacts.getObject(key)) as Uint8Array;
      const text = new TextDecoder().decode(bytes);
      for (const secret of values) expect(text).not.toContain(secret);
      expect(text).not.toContain("FIXTURE-SECRET");
    }
  });

  test("keeps exactly one archive, and prunes the old one only once the new one is complete", async () => {
    const backend = fleet();
    await backend.artifacts.putObject("archive/foundation-v-old/fleet.json", new Uint8Array([1]));
    await backend.artifacts.putObject("archive/foundation-v-older/fleet.json", new Uint8Array([1]));

    const { result } = await run(archiver(backend).archive(target));
    expect((result as { pruned: { remote: string[] } }).pruned.remote).toEqual([
      "archive/foundation-v-old/",
      "archive/foundation-v-older/",
    ]);
    const prefixes = new Set(
      (await backend.artifacts.list("archive/")).map((k) => k.split("/").slice(0, 2).join("/")),
    );
    expect([...prefixes]).toEqual(["archive/foundation-v0"]);
    // Version-aware, because the bucket is versioned and a plain delete would
    // free nothing (§5).
    expect(backend.mutations).toContain("artifacts.purgeByPrefix");
  });

  test("writes the completion marker last, and only once", async () => {
    const backend = fleet();
    const written: string[] = [];
    const real = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      written.push(key);
      await real.call(backend.artifacts, key, body);
    };
    await run(archiver(backend).archive(target));
    expect(written.at(-1)).toBe(`${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`);
    expect(written.filter((k) => k.endsWith(ARCHIVE_COMPLETE_KEY))).toHaveLength(1);
    const marker = JSON.parse(
      (await backend.artifacts.getText(`${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`)) as string,
    );
    expect(marker).toMatchObject({ complete: true, foundation_version: 0 });
  });

  test("an abort mid-copy throws, leaves no completion marker, and keeps the old archive", async () => {
    const backend = fleet();
    await backend.artifacts.putObject("archive/foundation-v-old/fleet.json", new Uint8Array([1]));
    const controller = new AbortController();
    let copies = 0;
    const realCopy = backend.artifacts.copy;
    backend.artifacts.copy = async (from: string, to: string) => {
      if (++copies === 2) controller.abort();
      await realCopy.call(backend.artifacts, from, to);
    };

    let code: string | null = null;
    try {
      await run(archiver(backend).archive({ ...target, signal: controller.signal }));
    } catch (e) {
      code = e instanceof HermeticError ? e.code : String(e);
    }
    expect(code).toBe("ABORTED");
    // No marker: a truncated archive is recognisable as one.
    expect(await backend.artifacts.exists(`${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`)).toBe(false);
    /**
     * And — the reason the prune moved to the end — the previous archive is
     * still there. Pruning first meant an abort here left the fleet with no
     * recovery point at all, immediately before the phase that changes
     * everything.
     */
    expect(await backend.artifacts.exists("archive/foundation-v-old/fleet.json")).toBe(true);
  });

  test("re-running over the same version is idempotent", async () => {
    const backend = fleet();
    await run(archiver(backend).archive(target));
    const first = (await backend.artifacts.list("archive/")).sort();
    await run(archiver(backend).archive(target));
    expect((await backend.artifacts.list("archive/")).sort()).toEqual(first);
  });

  test("a truncated archive from a previous run is rebuilt beside it, then published", async () => {
    const backend = fleet();
    /**
     * Debris from a run that died after copying but before the marker: an agent
     * that has since been destroyed, whose config object the fresh archive will
     * not write. Left in place it would blend into the new archive and leave one
     * prefix describing two different states of the fleet. A truncated archive
     * was never a recovery point, so this run may replace it — but it is built
     * under a staging prefix and published only once its own marker is there, so
     * a wrong reading of the marker can never cost the archive.
     */
    await backend.artifacts.putObject(`${archivePrefix(0)}config/ghost/stale.tgz`, new Uint8Array([9]));
    const { events } = await run(archiver(backend, { attemptId: () => "aaaa1111" }).archive(target));

    expect(await backend.artifacts.exists(`${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`)).toBe(true);
    expect(await backend.artifacts.exists(`${archivePrefix(0)}config/ghost/stale.tgz`)).toBe(false);
    // And nothing of the staging generation survives the publish.
    expect(
      (await backend.artifacts.list("archive/")).some((k) => k.includes(ARCHIVE_STAGING_MARK)),
    ).toBe(false);
    expect(events.some((e) => e.message.includes(archiveStagingPrefix(0, "aaaa1111")))).toBe(true);
  });

  test("a complete archive is retained on a retry, not purged and rewritten", async () => {
    const backend = fleet();
    await run(archiver(backend).archive(target));
    const before = new Map<string, string>();
    for (const key of await backend.artifacts.list(archivePrefix(0))) {
      before.set(key, (await backend.artifacts.getText(key)) ?? "");
    }
    /**
     * The fleet has moved on since the first attempt — this object stands for
     * everything the half-finished update has already changed. A rewrite would
     * bake it into the snapshot the retry is supposed to be able to fall back
     * to.
     */
    await backend.artifacts.putObject("config/newly-added.tgz", new Uint8Array([7]));

    // Any write at all to the archive prefix on the second run is the bug.
    const realPut = backend.artifacts.putObject;
    const realCopy = backend.artifacts.copy;
    const realPurge = backend.artifacts.purgeByPrefix;
    const purged: string[] = [];
    backend.artifacts.putObject = async (key: string) => {
      throw new Error(`unexpected put of ${key}`);
    };
    backend.artifacts.copy = async (from: string, to: string) => {
      throw new Error(`unexpected copy of ${from} to ${to}`);
    };
    backend.artifacts.purgeByPrefix = async (prefix: string) => {
      purged.push(prefix);
      return realPurge.call(backend.artifacts, prefix);
    };

    const { events, result } = await run(archiver(backend).archive(target));
    backend.artifacts.putObject = realPut;
    backend.artifacts.copy = realCopy;
    backend.artifacts.purgeByPrefix = realPurge;

    expect((result as { retained: { remote: boolean } }).retained.remote).toBe(true);
    expect(events.some((e) => e.message.includes("already complete; retaining it"))).toBe(true);
    // No purge of any kind: there was nothing stale, and the archive itself is
    // the thing being kept.
    expect(purged).toEqual([]);
    for (const [key, text] of before) {
      expect(await backend.artifacts.getText(key)).toBe(text);
    }
    expect((await backend.artifacts.list(archivePrefix(0))).sort()).toEqual([...before.keys()].sort());
    expect(await backend.artifacts.exists(`${archivePrefix(0)}config/newly-added.tgz`)).toBe(false);
  });

  test("a retry that fails early leaves the first run's complete archive whole", async () => {
    const backend = fleet();
    await run(archiver(backend).archive(target));
    const before = (await backend.artifacts.list(archivePrefix(0))).sort();
    expect(before).toContain(`${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`);

    // The retry blows up on its first write of any kind. Under the old
    // unconditional purge the archive was already gone by this point.
    const realCopy = backend.artifacts.copy;
    backend.artifacts.copy = async () => {
      throw new Error("s3 is having a day");
    };
    let failed = false;
    try {
      await run(archiver(backend).archive(target));
    } catch {
      failed = true;
    }
    backend.artifacts.copy = realCopy;

    // It did not fail, because it did not write: the retained archive short
    // circuits the whole copy.
    expect(failed).toBe(false);
    expect((await backend.artifacts.list(archivePrefix(0))).sort()).toEqual(before);
  });

  test("a retry over a truncated archive completes and leaves no staging prefix", async () => {
    const backend = fleet();
    // A first attempt that dies mid-copy: no marker, some objects.
    const controller = new AbortController();
    let copies = 0;
    const realCopy = backend.artifacts.copy;
    backend.artifacts.copy = async (from: string, to: string) => {
      if (++copies === 2) controller.abort();
      await realCopy.call(backend.artifacts, from, to);
    };
    await expect(
      run(archiver(backend).archive({ ...target, signal: controller.signal })),
    ).rejects.toThrow();
    backend.artifacts.copy = realCopy;
    expect((await backend.artifacts.list(archivePrefix(0))).length).toBeGreaterThan(0);
    expect(await backend.artifacts.exists(`${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`)).toBe(false);

    const { result } = await run(archiver(backend, { attemptId: () => "bbbb2222" }).archive(target));
    expect((result as { retained: { remote: boolean } }).retained.remote).toBe(false);
    expect(await backend.artifacts.exists(`${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`)).toBe(true);
    const left = await backend.artifacts.list("archive/");
    expect(left.some((k) => k.includes(ARCHIVE_STAGING_MARK))).toBe(false);
    expect(left.sort()).toEqual((result as { keys: string[] }).keys.sort());
  });

  test("the previous version's prefix is pruned only after the new marker exists", async () => {
    const backend = fleet();
    await backend.artifacts.putObject("archive/foundation-v-old/complete.json", new Uint8Array([1]));
    const order: string[] = [];
    const realPut = backend.artifacts.putObject;
    const realPurge = backend.artifacts.purgeByPrefix;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      if (key.endsWith(ARCHIVE_COMPLETE_KEY)) order.push(`marker ${key}`);
      await realPut.call(backend.artifacts, key, body);
    };
    backend.artifacts.purgeByPrefix = async (prefix: string) => {
      order.push(`purge ${prefix}`);
      return realPurge.call(backend.artifacts, prefix);
    };
    await run(archiver(backend).archive(target));
    backend.artifacts.putObject = realPut;
    backend.artifacts.purgeByPrefix = realPurge;

    expect(order).toEqual([
      `marker ${archivePrefix(0)}${ARCHIVE_COMPLETE_KEY}`,
      "purge archive/foundation-v-old/",
    ]);
  });
});

describe("the local archive", () => {
  test("writes the same JSON plus the database, and prunes older directories", async () => {
    const backend = fleet();
    const home = tempHome();
    const root = join(home, "archive");
    const previous = `foundation-v-old-${FIXTURE_CONFIG.fleet_id}`;
    mkdirSync(join(root, previous), { recursive: true });

    const copied: string[] = [];
    const { events, result } = await run(
      archiver(backend, {
        archiveDir: root,
        archiveLocalDb: (path) => {
          copied.push(path);
          mkdirSync(join(path, ".."), { recursive: true });
          Bun.write(path, "sqlite-bytes");
        },
      }).archive(target),
    );

    const dir = join(root, archiveDirName(0, FIXTURE_CONFIG.fleet_id));
    expect((result as { localDir: string | null }).localDir).toBe(dir);
    expect((result as { pruned: { local: string[] } }).pruned.local).toEqual([previous]);
    expect(existsSync(join(root, previous))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([
      "agents.json",
      "archived-at.json",
      ARCHIVE_COMPLETE_KEY,
      "events.json",
      "fleet.json",
      "hermetic.db",
      "s3-listing.json",
      "ssm-paths.json",
    ]);
    expect(copied).toEqual([join(dir, "hermetic.db")]);
    expect(JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8")).fleet_id).toBe(
      FIXTURE_CONFIG.fleet_id,
    );
    expect(events.some((e) => e.message.includes("wrote the local archive"))).toBe(true);
  });

  test("the database it writes is a real, openable copy (VACUUM INTO, not a file copy)", async () => {
    const backend = fleet();
    const home = tempHome();
    const local = openLocalDb({ home });
    // Something in the run log, so an empty copy would be indistinguishable
    // from a good one.
    local.db.run(`INSERT INTO prefs (key, value) VALUES ('archive-probe', 'yes')`);

    const { result } = await run(
      archiver(backend, {
        archiveDir: join(home, "archive"),
        archiveLocalDb: (path) => local.archiveTo(path),
      }).archive(target),
    );
    local.close();

    const copy = new Database(join((result as { localDir: string }).localDir, "hermetic.db"), {
      readonly: true,
    });
    expect(
      (
        copy.query(`SELECT value FROM prefs WHERE key = 'archive-probe'`).get() as {
          value: string;
        }
      ).value,
    ).toBe("yes");
    copy.close();
  });

  test("prunes only this fleet's own archive directories", async () => {
    const backend = fleet();
    const root = join(tempHome(), "archive");
    mkdirSync(join(root, `foundation-v-old-${FIXTURE_CONFIG.fleet_id}`), { recursive: true });
    // A second fleet this laptop has been pointed at (`init --reset`). Its only
    // local recovery point must not be a casualty of updating this one.
    mkdirSync(join(root, "foundation-v0-otherfle"), { recursive: true });

    const { result } = await run(
      archiver(backend, { archiveDir: root, archiveLocalDb: () => {} }).archive(target),
    );
    expect((result as { pruned: { local: string[] } }).pruned.local).toEqual([
      `foundation-v-old-${FIXTURE_CONFIG.fleet_id}`,
    ]);
    expect(existsSync(join(root, "foundation-v0-otherfle"))).toBe(true);
  });

  test("a complete local archive is retained on a retry, database and all", async () => {
    const backend = fleet();
    const root = join(tempHome(), "archive");
    const dir = join(root, archiveDirName(0, FIXTURE_CONFIG.fleet_id));
    let copies = 0;
    const local = () =>
      archiver(backend, {
        archiveDir: root,
        archiveLocalDb: (path) => {
          copies += 1;
          writeFileSync(path, `sqlite-bytes-${copies}`);
        },
      });

    await run(local().archive(target));
    expect(copies).toBe(1);
    const first = readFileSync(join(dir, "fleet.json"), "utf8");

    // The retry finds the marker and leaves every byte where it is — including
    // the database copy, which is the expensive half.
    const { events, result } = await run(local().archive(target));
    expect(copies).toBe(1);
    expect((result as { retained: { local: boolean } }).retained.local).toBe(true);
    expect(events.some((e) => e.message.includes("already complete; retaining it"))).toBe(true);
    expect(readFileSync(join(dir, "fleet.json"), "utf8")).toBe(first);
    expect(readFileSync(join(dir, "hermetic.db"), "utf8")).toBe("sqlite-bytes-1");
  });

  test("a truncated local archive is rebuilt in a staging directory and renamed in", async () => {
    const backend = fleet();
    const root = join(tempHome(), "archive");
    const dir = join(root, archiveDirName(0, FIXTURE_CONFIG.fleet_id));
    // Debris from a run that died before the marker, including a file this run
    // will not write.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ghost.json"), "{}");
    // And an abandoned staging directory of this fleet, which is not another
    // fleet's and must not outlive the publish.
    const abandoned = `${archiveDirName(0, FIXTURE_CONFIG.fleet_id)}${ARCHIVE_STAGING_MARK}dead0000`;
    mkdirSync(join(root, abandoned), { recursive: true });

    const { result } = await run(
      archiver(backend, {
        archiveDir: root,
        archiveLocalDb: (path) => writeFileSync(path, "sqlite-bytes"),
        attemptId: () => "cccc3333",
      }).archive(target),
    );

    expect((result as { retained: { local: boolean } }).retained.local).toBe(false);
    expect(existsSync(join(dir, ARCHIVE_COMPLETE_KEY))).toBe(true);
    expect(existsSync(join(dir, "ghost.json"))).toBe(false);
    expect(readdirSync(root).filter((e) => e.includes(ARCHIVE_STAGING_MARK))).toEqual([]);
    expect((result as { pruned: { local: string[] } }).pruned.local).toEqual([abandoned]);
  });

  test("is skipped, with an event, when there is no home to write into", async () => {
    const backend = fleet();
    const { events, result } = await run(archiver(backend).archive(target));
    expect((result as { localDir: string | null }).localDir).toBeNull();
    expect(events.some((e) => e.message === "fixture: local archive skipped")).toBe(true);
  });

  test("a failed database copy warns rather than stopping the update", async () => {
    const backend = fleet();
    const root = join(tempHome(), "archive");
    const { events, result } = await run(
      archiver(backend, {
        archiveDir: root,
        archiveLocalDb: () => {
          throw new Error("disk full");
        },
      }).archive(target),
    );
    const warned = events.find((e) => e.level === "warn");
    expect(warned?.message).toContain("disk full");
    // The remote half still happened, which is the half that matters.
    expect((result as { keys: string[] }).keys.length).toBeGreaterThan(0);
  });
});
