/**
 * `hermes-mirror.ts`: the laptop half of §3.6's Hermes source mirror.
 *
 * No network (§11). The "upstream" is a throwaway git repository in a temp
 * directory, which `git clone --mirror` reaches over a local path exactly as it
 * would reach github.com — so the bundle these tests assert on is built by the
 * same code path production uses, and the *only* thing faked is the URL.
 *
 * The tests that are about failure inject a spawner instead, because a git that
 * cannot be reached is the case that must not throw.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERMES_MIRROR_DIR,
  ensureHermesMirror,
  fixtureHermesMirror,
  gitSpawner,
  type GitRun,
  type HermesMirrorFn,
  spawnGit,
} from "../src/release/hermes-mirror.ts";
import { HermeticError } from "../src/errors.ts";
import { hermesBundleKey, type FleetManifest, type OpEvent } from "../src/schema/index.ts";
import { readFleetManifest } from "../src/release/artifacts.ts";
import { renderAgentConfig } from "../src/render/render.ts";
import { BUILD_VERSIONS } from "../src/hermetic.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_HERMETICD_VERSION,
  MemoryBackend,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import { testHermetic } from "./helpers.ts";

const REF = "v2026.8.31";
/** A second tag, on the commit after `REF`, so "another ref" is another tag. */
const LATER_REF = "v2026.9.1";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(prefix = "hermetic-mirror-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A bucket that records what was put in it. `exists` answers from the same map. */
function fakeArtifacts() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    putObject: async (key: string, body: Uint8Array): Promise<void> => {
      objects.set(key, body);
    },
    exists: async (key: string): Promise<boolean> => objects.has(key),
  };
}

/** The real spawner, counting calls, so "no git ran at all" is assertable. */
function countingGit(): { git: GitRun; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRun = (args, opts) => {
    calls.push([...args]);
    return spawnGit(args, opts);
  };
  return { git, calls };
}

/**
 * An upstream repository with two commits, a tag on each, and a `main` that has
 * moved past both — so a bundle built from a tag can be told apart from one
 * built from the tip, and "a branch is not a tag" has a branch to be told about.
 */
function upstream(): string {
  const root = dir("hermetic-upstream-");
  const run = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-C", root, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "up",
        GIT_AUTHOR_EMAIL: "up@example.com",
        GIT_COMMITTER_NAME: "up",
        GIT_COMMITTER_EMAIL: "up@example.com",
      },
    });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  };
  run("init", "-q", "-b", "main");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "pyproject.toml"), 'version = "0.21.1"\n');
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "web", "index.html"), "<html></html>\n");
  run("add", "-A");
  run("commit", "-qm", "hermes");
  run("tag", REF);
  writeFileSync(join(root, "pyproject.toml"), 'version = "0.22.0"\n');
  run("add", "-A");
  run("commit", "-qm", "after the tag");
  run("tag", LATER_REF);
  // A commit past both tags, so `main` names something no tag does.
  writeFileSync(join(root, "pyproject.toml"), 'version = "0.23.0.dev0"\n');
  run("add", "-A");
  run("commit", "-qm", "unreleased");
  return root;
}

/** Clone a bundle that was uploaded and ask the clone what it is. */
function inspectBundle(bytes: Uint8Array): {
  describe: string;
  shallow: string;
  files: string[];
  log: string;
} {
  const root = dir("hermetic-clone-");
  const bundle = join(root, "hermes.bundle");
  writeFileSync(bundle, bytes);
  const out = join(root, "checkout");
  const run = (...args: string[]): string => {
    const proc = Bun.spawnSync(["git", ...args]);
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
  };
  run("clone", "-q", bundle, out);
  return {
    describe: run("-C", out, "describe", "--tags"),
    shallow: run("-C", out, "rev-parse", "--is-shallow-repository"),
    files: run("-C", out, "ls-files").split("\n").sort(),
    log: run("-C", out, "log", "--oneline"),
  };
}

describe("ensureHermesMirror", () => {
  test("mirrors a ref into the bucket as a clonable, non-shallow bundle", async () => {
    const artifacts = fakeArtifacts();
    const mirrorDir = join(dir(), "mirror");
    const result = await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: REF, repoUrl: upstream() },
    );

    expect(result.status).toBe("pushed");
    expect(result.warning).toBeUndefined();
    const entry = result.block?.[REF];
    expect(entry?.key).toBe(hermesBundleKey(REF));
    expect(entry?.upstream_sha).toMatch(/^[0-9a-f]{40}$/);

    const bytes = artifacts.objects.get(hermesBundleKey(REF));
    expect(bytes).toBeDefined();
    expect(entry?.size).toBe(bytes!.byteLength);
    expect(entry?.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes!).digest("hex"));

    /**
     * The point of synthesizing rather than bundling a shallow clone: the clone
     * has a history it can walk, so `git describe` — which upstream's own
     * pinned-install and rollback instructions rely on — answers the tag.
     */
    const clone = inspectBundle(bytes!);
    expect(clone.describe).toBe(REF);
    expect(clone.shallow).toBe("false");
    expect(clone.log.split("\n")).toHaveLength(1);
    expect(clone.log).toContain(`hermes-agent ${REF} (mirrored from ${entry?.upstream_sha})`);
    // The tree at the *tag*, not at the tip, and no `.git` of upstream's in it.
    expect(clone.files).toEqual(["pyproject.toml", "web/index.html"]);
  });

  test("the mirrored tree is the ref's, byte for byte", async () => {
    const artifacts = fakeArtifacts();
    await ensureHermesMirror(
      { artifacts, mirrorDir: join(dir(), "mirror"), git: spawnGit },
      { ref: REF, repoUrl: upstream() },
    );
    const root = dir("hermetic-clone-");
    const bundle = join(root, "b");
    writeFileSync(bundle, artifacts.objects.get(hermesBundleKey(REF))!);
    Bun.spawnSync(["git", "clone", "-q", bundle, join(root, "c")]);
    expect(await Bun.file(join(root, "c", "pyproject.toml")).text()).toBe('version = "0.21.1"\n');
  });

  test("a second call with the bundle already there runs no git at all", async () => {
    const artifacts = fakeArtifacts();
    const mirrorDir = join(dir(), "mirror");
    const first = await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: REF, repoUrl: upstream() },
    );

    const second = countingGit();
    const again = await ensureHermesMirror(
      { artifacts, mirrorDir, git: second.git },
      { ref: REF, repoUrl: "http://127.0.0.1:1/never-reached.git", existing: first.block },
    );
    expect(again.status).toBe("present");
    expect(again.block).toEqual(first.block);
    expect(second.calls).toEqual([]);
  });

  /** The manifest may name a ref whose object somebody deleted; that is a re-push. */
  test("a recorded ref whose object is gone is mirrored again", async () => {
    const artifacts = fakeArtifacts();
    const mirrorDir = join(dir(), "mirror");
    const repoUrl = upstream();
    const first = await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: REF, repoUrl },
    );
    artifacts.objects.delete(hermesBundleKey(REF));

    const again = await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: REF, repoUrl, existing: first.block },
    );
    expect(again.status).toBe("pushed");
    expect(artifacts.objects.has(hermesBundleKey(REF))).toBe(true);
  });

  test("a second ref is added beside the first, not instead of it", async () => {
    const artifacts = fakeArtifacts();
    const mirrorDir = join(dir(), "mirror");
    const repoUrl = upstream();
    const first = await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: REF, repoUrl },
    );
    // A later tag, so the second ref is genuinely a different object.
    const second = await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: LATER_REF, repoUrl, existing: first.block },
    );
    expect(second.status).toBe("pushed");
    expect(Object.keys(second.block ?? {}).sort()).toEqual([REF, LATER_REF].sort());
    expect(second.block?.[REF]).toEqual(first.block![REF]!);
  });

  test("the bare mirror is reused on the next ref rather than re-cloned", async () => {
    const artifacts = fakeArtifacts();
    const mirrorDir = join(dir(), "mirror");
    const repoUrl = upstream();
    await ensureHermesMirror({ artifacts, mirrorDir, git: spawnGit }, { ref: REF, repoUrl });
    expect(existsSync(join(mirrorDir, HERMES_MIRROR_DIR))).toBe(true);

    const second = countingGit();
    await ensureHermesMirror({ artifacts, mirrorDir, git: second.git }, { ref: LATER_REF, repoUrl });
    expect(second.calls.some((c) => c.includes("clone"))).toBe(false);
    expect(second.calls.some((c) => c.includes("fetch"))).toBe(true);
  });

  /**
   * The soft failure the whole design rests on: a laptop that cannot reach
   * GitHub must leave the manifest exactly as it was, so the box keeps its
   * documented fallback, rather than making `agent create` impossible.
   */
  test("a git that cannot run warns, changes nothing, and does not throw", async () => {
    const artifacts = fakeArtifacts();
    const existing: FleetManifest["hermes"] = {
      "v2026.1.1": {
        key: hermesBundleKey("v2026.1.1"),
        sha256: "a".repeat(64),
        size: 10,
        upstream_sha: "b".repeat(40),
      },
    };
    const result = await ensureHermesMirror(
      {
        artifacts,
        mirrorDir: join(dir(), "mirror"),
        git: async () => {
          throw new Error("spawn git ENOENT");
        },
      },
      { ref: REF, repoUrl: "https://github.com/NousResearch/hermes-agent.git", existing },
    );
    expect(result.status).toBe("skipped");
    expect(result.warning).toContain("ENOENT");
    expect(result.warning).toContain("clone it from");
    expect(result.block).toEqual(existing);
    expect(artifacts.objects.size).toBe(0);
  });

  test("a git that fails the clone is the same soft failure, quoting git", async () => {
    const artifacts = fakeArtifacts();
    const result = await ensureHermesMirror(
      {
        artifacts,
        mirrorDir: join(dir(), "mirror"),
        git: async () => ({ code: 128, stdout: "", stderr: "fatal: the remote end hung up\n" }),
      },
      { ref: REF },
    );
    expect(result.status).toBe("skipped");
    expect(result.warning).toContain("the remote end hung up");
    expect(result.block).toBeUndefined();
    expect(artifacts.objects.size).toBe(0);
  });

  test("an upload that fails leaves the manifest block alone", async () => {
    const artifacts = fakeArtifacts();
    const result = await ensureHermesMirror(
      {
        artifacts: {
          exists: artifacts.exists,
          putObject: async () => {
            throw new Error("AccessDenied");
          },
        },
        mirrorDir: join(dir(), "mirror"),
        git: spawnGit,
      },
      { ref: REF, repoUrl: upstream() },
    );
    expect(result.status).toBe("skipped");
    expect(result.warning).toContain("AccessDenied");
    expect(result.block).toBeUndefined();
  });

  /** A ref no retry would fix is a programmer error, and says so (rule 1). */
  test("a ref that is not a ref is refused before anything runs", async () => {
    const artifacts = fakeArtifacts();
    const { git, calls } = countingGit();
    for (const ref of ["release/2026", "../../etc/passwd", "v1 v2", "--upload-pack=x", ""]) {
      await expect(
        ensureHermesMirror({ artifacts, mirrorDir: join(dir(), "mirror"), git }, { ref }),
      ).rejects.toThrow(HermeticError);
    }
    expect(calls).toEqual([]);
    expect(artifacts.objects.size).toBe(0);
  });

  test("a ref the repository does not have is a soft failure too", async () => {
    const artifacts = fakeArtifacts();
    const result = await ensureHermesMirror(
      { artifacts, mirrorDir: join(dir(), "mirror"), git: spawnGit },
      { ref: "v1999.1.1", repoUrl: upstream() },
    );
    expect(result.status).toBe("skipped");
    expect(result.warning).toContain("v1999.1.1");
    expect(artifacts.objects.size).toBe(0);
  });

  /**
   * The probe that decides whether there is anything to do is an S3 call, and
   * an S3 call can throw: expired credentials, a bucket policy, a 503. A throw
   * escaping this function takes `artifacts push`, `init` and `upgrade` with
   * it — over a question whose only purpose is to skip work.
   */
  test("an `exists` that throws is a warning, not an escaped exception", async () => {
    const existing: FleetManifest["hermes"] = {
      [REF]: {
        key: hermesBundleKey(REF),
        sha256: "c".repeat(64),
        size: 11,
        upstream_sha: "d".repeat(40),
      },
    };
    const { git, calls } = countingGit();
    const result = await ensureHermesMirror(
      {
        artifacts: {
          putObject: async () => {},
          exists: async () => {
            throw new Error("ExpiredToken: the security token included in the request is expired");
          },
        },
        mirrorDir: join(dir(), "mirror"),
        git,
      },
      { ref: REF, existing },
    );
    expect(result.status).toBe("skipped");
    expect(result.warning).toContain("ExpiredToken");
    expect(result.block).toEqual(existing);
    expect(calls).toEqual([]);
  });

  /**
   * A moving ref would be mirrored once and pinned forever: idempotence here is
   * "the manifest names it and the object is there", which never asks upstream
   * anything again. `isHermesRef` cannot see the difference, so the check is
   * against `refs/tags/` after the fetch.
   */
  test("a branch is refused — softly — even though it is a valid ref name", async () => {
    const artifacts = fakeArtifacts();
    const result = await ensureHermesMirror(
      { artifacts, mirrorDir: join(dir(), "mirror"), git: spawnGit },
      { ref: "main", repoUrl: upstream() },
    );
    expect(result.status).toBe("skipped");
    expect(result.warning).toContain("main is not a tag");
    expect(result.warning).toContain("mirrors tags only");
    expect(result.block).toBeUndefined();
    expect(artifacts.objects.size).toBe(0);
  });

  /**
   * A staging directory is removed when the clone settles — and a laptop that
   * was closed, or a `git` this module killed on the mirror timeout, never
   * settles. Each one holds a partial copy of a repository that ships a web app.
   */
  test("stale `.clone-*` staging directories are swept on the next run", async () => {
    const artifacts = fakeArtifacts();
    const mirrorDir = join(dir(), "mirror");
    mkdirSync(join(mirrorDir, ".clone-abandoned"), { recursive: true });
    writeFileSync(join(mirrorDir, ".clone-abandoned", "half-a-repo"), "x");

    await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: REF, repoUrl: upstream() },
    );
    expect(existsSync(join(mirrorDir, ".clone-abandoned"))).toBe(false);
    expect(existsSync(join(mirrorDir, HERMES_MIRROR_DIR))).toBe(true);
  });

  test("it leaves no temp directory behind", async () => {
    const artifacts = fakeArtifacts();
    const home = dir();
    const mirrorDir = join(home, "mirror");
    await ensureHermesMirror(
      { artifacts, mirrorDir, git: spawnGit },
      { ref: REF, repoUrl: upstream() },
    );
    // Only the bare mirror itself, no `.clone-` staging directory.
    const left = [...new Bun.Glob("*").scanSync({ cwd: mirrorDir, onlyFiles: false })];
    expect(left).toEqual([HERMES_MIRROR_DIR]);
  });
});

/**
 * The timeout, with its limits shrunk from fifteen minutes to a fraction of a
 * second. Local `git` only — no network, no clone (§11).
 */
describe("gitSpawner", () => {
  /**
   * A `!`-alias is how a local `git` is made to behave like the real hazard:
   * `git` execs a shell, the shell ignores `SIGTERM`, and `sleep` inherits the
   * pipes this spawner is reading. Killing `git` therefore does *not* close
   * `stdout`/`stderr`, so waiting on the reads would hang past the timeout that
   * just fired. The deadline has to be raced against them, not merely armed.
   */
  const STUBBORN = ["-c", "alias.sleepy=!trap '' TERM; sleep 60", "sleepy"];

  test("a git that ignores SIGTERM is killed, and the call still answers", async () => {
    const repo = dir("hermetic-stubborn-");
    Bun.spawnSync(["git", "-C", repo, "init", "-q"]);
    const started = Date.now();
    await expect(gitSpawner({ timeoutMs: 150, graceMs: 150 })(STUBBORN, { cwd: repo })).rejects.toThrow(
      /did not finish within 150 ms and was killed/,
    );
    // The point of the whole arrangement: it answered in well under `sleep 60`.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a git that finishes on its own is not killed and reports normally", async () => {
    const repo = dir("hermetic-prompt-");
    Bun.spawnSync(["git", "-C", repo, "init", "-q"]);
    const result = await gitSpawner({ timeoutMs: 30_000, graceMs: 150 })(
      ["-C", repo, "rev-parse", "--is-bare-repository"],
      {},
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("false");
  });
});

describe("fixtureHermesMirror", () => {
  test("puts a stand-in bundle in the fixture bucket and never spawns git", async () => {
    const artifacts = fakeArtifacts();
    const first = await fixtureHermesMirror(artifacts, { ref: REF, existing: undefined });
    expect(first.status).toBe("pushed");
    expect(artifacts.objects.has(hermesBundleKey(REF))).toBe(true);
    expect(first.block?.[REF]?.upstream_sha).toMatch(/^[0-9a-f]{40}$/);

    const again = await fixtureHermesMirror(artifacts, { ref: REF, existing: first.block });
    expect(again.status).toBe("present");
    expect(again.block).toEqual(first.block);
  });
});

/**
 * The wiring, over the in-memory backend: which callers mirror, and — the part
 * that is easy to get wrong — that every *other* writer of the fleet manifest
 * carries the block through instead of rebuilding a manifest without it.
 */
describe("the mirror block in the fleet manifest", () => {
  const MIRRORED: NonNullable<FleetManifest["hermes"]> = {
    [BUILD_VERSIONS.hermes_ref]: {
      key: hermesBundleKey(BUILD_VERSIONS.hermes_ref),
      sha256: "e".repeat(64),
      size: 2048,
      upstream_sha: "f".repeat(40),
    },
  };

  /** A mirror that pushed once and is idempotent after, counting its calls. */
  function stubMirror(): { fn: HermesMirrorFn; refs: string[] } {
    const refs: string[] = [];
    const fn: HermesMirrorFn = async ({ ref, existing }) => {
      refs.push(ref);
      if (existing?.[ref]) return { block: existing, status: "present" };
      return { block: { ...(existing ?? {}), ...MIRRORED }, status: "pushed" };
    };
    return { fn, refs };
  }

  function seeded(hermesMirror: HermesMirrorFn) {
    const backend = seedFixtureFleet(new MemoryBackend());
    return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG, hermesMirror }) };
  }

  test("`artifacts push` mirrors this build's ref and records it", async () => {
    const mirror = stubMirror();
    const { backend, hermetic } = seeded(mirror.fn);
    const pushed = await hermetic.artifacts.push({ version: "0.5.0" });

    expect(mirror.refs).toEqual([BUILD_VERSIONS.hermes_ref]);
    expect(pushed.mirror_warning).toBeUndefined();
    const manifest = (await readFleetManifest(backend.artifacts))!;
    expect(manifest.hermes).toEqual(MIRRORED);
  });

  /**
   * The regression this pair exists for: `upgrade --hermeticd` rebuilds the
   * manifest around a release pointer, and a rebuild that dropped the mirror
   * would send every box in the fleet back to cloning github.com.
   */
  test("`upgrade --hermeticd` moves the pointer and keeps the mirror", async () => {
    const mirror = stubMirror();
    const { backend, hermetic } = seeded(mirror.fn);
    await hermetic.artifacts.push({ version: "0.5.0" });
    expect((await readFleetManifest(backend.artifacts))!.hermes).toEqual(MIRRORED);

    for await (const _ of hermetic.upgrade({ all: true, hermeticd: FIXTURE_HERMETICD_VERSION }));
    const manifest = (await readFleetManifest(backend.artifacts))!;
    expect(manifest.hermeticd.version).toBe(FIXTURE_HERMETICD_VERSION);
    expect(manifest.hermes).toEqual(MIRRORED);
  });

  test("`foundation update` republishes the release and keeps the mirror", async () => {
    const mirror = stubMirror();
    const { backend, hermetic } = seeded(mirror.fn);
    await hermetic.artifacts.push({ version: "0.5.0" });

    for await (const _ of hermetic.foundation.update({ yes: true }));
    expect((await readFleetManifest(backend.artifacts))!.hermes).toEqual(MIRRORED);
  });

  test("`upgrade --hermes` mirrors before it rewrites an agent manifest", async () => {
    const mirror = stubMirror();
    const { backend, hermetic } = seeded(mirror.fn);
    // A manifest to add the block to: nothing to record onto without one.
    await hermetic.artifacts.push({ version: "0.5.0" });
    backend.objects.delete(hermesBundleKey(BUILD_VERSIONS.hermes_ref));
    await backend.artifacts.putObject(
      "manifest.json",
      new TextEncoder().encode(
        JSON.stringify({ ...(await readFleetManifest(backend.artifacts))!, hermes: undefined }),
      ),
    );

    const events: string[] = [];
    for await (const e of hermetic.upgrade({ name: "atlas", hermes: "0.16.0" })) {
      events.push(e.message);
    }
    expect(mirror.refs).toContain(BUILD_VERSIONS.hermes_ref);
    expect((await readFleetManifest(backend.artifacts))!.hermes).toEqual(MIRRORED);
    expect(events.some((m) => m.includes("mirrored hermes"))).toBe(true);
  });

  test("a soft mirror failure is said out loud and changes nothing", async () => {
    const failing: HermesMirrorFn = async ({ existing }) => ({
      block: existing,
      status: "skipped",
      warning: "could not mirror Hermes: the remote end hung up",
    });
    const { backend, hermetic } = seeded(failing);

    const pushed = await hermetic.artifacts.push({ version: "0.5.0" });
    expect(pushed.key).toBe(`artifacts/0.5.0/${pushed.generation}/hermeticd`);
    expect(pushed.mirror_warning).toContain("the remote end hung up");
    expect((await readFleetManifest(backend.artifacts))!.hermes).toBeUndefined();

    const events: OpEvent[] = [];
    for await (const e of hermetic.upgrade({ name: "atlas", hermes: "0.16.0" })) events.push(e);
    expect(events.some((e) => e.level === "warn" && e.message.includes("hung up"))).toBe(true);
    // And the upgrade itself still happened: the mirror is not a gate.
    expect((await backend.store.agents.get("atlas"))!.hermes_version).toBe("0.16.0");
  });
});

/**
 * §6.6's prune, for bundles. Same rule as the release prune beside it — the
 * keep set is read before the push, so a ref the fleet moved to mid-update is
 * not deleted out from under the boxes now fetching it.
 */
describe("foundation update prunes stale hermes bundles", () => {
  const STALE = "v2026.1.1";

  test("keeps this build's ref, deletes the rest, and rewrites the block", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      hermesMirror: async ({ ref, existing }) => ({
        block: { ...(existing ?? {}), ...current(ref) },
        status: "pushed",
      }),
    });
    await hermetic.artifacts.push({ version: "0.5.0" });

    // Two bundles in the bucket, as a fleet that has been through a ref bump
    // has: the current one, and an older one still named by the manifest.
    await backend.artifacts.putObject(
      hermesBundleKey(BUILD_VERSIONS.hermes_ref),
      new TextEncoder().encode("current bundle"),
    );
    await backend.artifacts.putObject(hermesBundleKey(STALE), new TextEncoder().encode("old bundle"));
    const before = (await readFleetManifest(backend.artifacts))!;
    await backend.artifacts.putObject(
      "manifest.json",
      new TextEncoder().encode(
        JSON.stringify({
          ...before,
          hermes: {
            ...before.hermes,
            [STALE]: {
              key: hermesBundleKey(STALE),
              sha256: "9".repeat(64),
              size: 10,
              upstream_sha: "8".repeat(40),
            },
          },
        }),
      ),
    );

    const messages: string[] = [];
    for await (const e of hermetic.foundation.update({ yes: true })) messages.push(e.message);

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(Object.keys(after.hermes ?? {})).toEqual([BUILD_VERSIONS.hermes_ref]);
    expect(backend.objects.has(hermesBundleKey(STALE))).toBe(false);
    expect(backend.objects.has(hermesBundleKey(BUILD_VERSIONS.hermes_ref))).toBe(true);
    expect(messages.some((m) => m.includes(`pruned the mirrored hermes ${STALE}`))).toBe(true);
  });

  /**
   * The keep set is not `deps.hermesRef` alone. A config uploaded by an older
   * laptop pins an older `hermes_ref` until something re-renders it, and it is
   * the object the box downloads and installs from — so an update run from a
   * newer checkout would otherwise delete the bundle a live agent needs, and
   * the damage would surface as a boot that cannot fetch its Hermes.
   */
  test("a ref a live agent's uploaded config pins is kept", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      hermesMirror: async ({ ref, existing }) => ({
        block: { ...(existing ?? {}), ...current(ref) },
        status: "pushed",
      }),
    });
    await hermetic.artifacts.push({ version: "0.5.0" });

    // Two live agents, each with the config object its row names: one on this
    // build's ref, one still on an older one.
    const [atlas, other] = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
    await uploadConfig(backend, atlas!.name, BUILD_VERSIONS.hermes_ref);
    await uploadConfig(backend, other!.name, PINNED);
    for (const ref of [STALE, PINNED]) {
      await backend.artifacts.putObject(
        hermesBundleKey(ref),
        new TextEncoder().encode(`bundle for ${ref}`),
      );
    }
    await nameInManifest(backend, [STALE, PINNED]);

    for await (const _ of hermetic.foundation.update({ yes: true }));

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(Object.keys(after.hermes ?? {}).sort()).toEqual([BUILD_VERSIONS.hermes_ref, PINNED].sort());
    expect(backend.objects.has(hermesBundleKey(PINNED))).toBe(true);
    expect(backend.objects.has(hermesBundleKey(STALE))).toBe(false);
  });

  /**
   * Conservative on a read that failed: an object that *cannot be read* is no
   * evidence that nothing pins its ref, so nothing is pruned at all.
   */
  test("a configuration that cannot be read prunes nothing, and says so", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const live = (await backend.store.agents.scan()).find((a) => a.status !== "destroyed")!;
    const configKey = live.resources.config_key!;
    const artifacts = {
      ...backend.artifacts,
      getObject: async (key: string): Promise<Uint8Array | null> => {
        if (key === configKey) throw new Error("AccessDenied");
        return backend.artifacts.getObject(key);
      },
    };
    const hermetic = testHermetic({
      backend: { ...backend, artifacts },
      config: FIXTURE_CONFIG,
      hermesMirror: async ({ ref, existing }) => ({
        block: { ...(existing ?? {}), ...current(ref) },
        status: "pushed",
      }),
    });
    await hermetic.artifacts.push({ version: "0.5.0" });
    await backend.artifacts.putObject(hermesBundleKey(STALE), new TextEncoder().encode("old bundle"));
    await nameInManifest(backend, [STALE]);

    const messages: string[] = [];
    for await (const e of hermetic.foundation.update({ yes: true })) messages.push(e.message);

    expect(backend.objects.has(hermesBundleKey(STALE))).toBe(true);
    expect(Object.keys((await readFleetManifest(backend.artifacts))!.hermes ?? {})).toContain(STALE);
    expect(messages.some((m) => m.includes("AccessDenied") && m.includes("leaving every"))).toBe(true);
  });

  /**
   * `foundation update` rewrites the manifest, so it is a writer of the mirror
   * block whether it wants to be or not. Before it mirrored, a fleet last
   * pushed from a laptop on a different ref came out of an update with an empty
   * block and no event: its bundles pruned as stale, this build's never
   * uploaded, every box quietly back to cloning github.com.
   */
  test("it mirrors this build's ref before pruning, rather than emptying the block", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const refs: string[] = [];
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      hermesMirror: async ({ ref, existing }) => {
        refs.push(ref);
        return { block: { ...(existing ?? {}), ...current(ref) }, status: "pushed" };
      },
    });
    await hermetic.artifacts.push({ version: "0.5.0" });
    // A fleet whose manifest names only some *other* laptop's ref.
    await nameInManifest(backend, [STALE], { drop: [BUILD_VERSIONS.hermes_ref] });

    refs.length = 0;
    for await (const _ of hermetic.foundation.update({ yes: true }));

    expect(refs).toEqual([BUILD_VERSIONS.hermes_ref]);
    expect(Object.keys((await readFleetManifest(backend.artifacts))!.hermes ?? {})).toEqual([
      BUILD_VERSIONS.hermes_ref,
    ]);
  });

  test("an empty mirror block after the prune is said out loud", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      hermesMirror: async ({ existing }) => ({
        block: existing,
        status: "skipped",
        warning: "could not mirror Hermes: the remote end hung up",
      }),
    });
    await hermetic.artifacts.push({ version: "0.5.0" });
    await nameInManifest(backend, [STALE], { drop: [BUILD_VERSIONS.hermes_ref] });

    const messages: string[] = [];
    for await (const e of hermetic.foundation.update({ yes: true })) messages.push(e.message);

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(Object.keys(after.hermes ?? {})).toEqual([]);
    expect(messages.some((m) => m.includes("the remote end hung up"))).toBe(true);
    expect(messages.some((m) => m.includes("names no mirrored hermes"))).toBe(true);
  });

  /** A ref an older laptop pinned, which this build's keep set would not name. */
  const PINNED = "v2026.5.5";

  function current(ref: string): NonNullable<FleetManifest["hermes"]> {
    return {
      [ref]: {
        key: hermesBundleKey(ref),
        sha256: "7".repeat(64),
        size: 20,
        upstream_sha: "6".repeat(40),
      },
    };
  }

  /** The config object the agent's row already names, rendered at `hermesRef`. */
  async function uploadConfig(backend: MemoryBackend, name: string, hermesRef: string): Promise<void> {
    const agent = (await backend.store.agents.get(name))!;
    const rendered = renderAgentConfig({
      name,
      size: agent.size,
      provider: agent.provider,
      secrets_mode: agent.secrets_mode,
      hermes_version: agent.hermes_version,
      hermes_ref: hermesRef,
      chrome_ref: BUILD_VERSIONS.chrome_ref,
      region: agent.region,
      tailnet: "example.ts.net",
    });
    await backend.artifacts.putObject(agent.resources.config_key!, rendered.tarball);
  }

  /** Add bundle entries to the published manifest, optionally dropping others. */
  async function nameInManifest(
    backend: MemoryBackend,
    refs: readonly string[],
    opts: { drop?: readonly string[] } = {},
  ): Promise<void> {
    const before = (await readFleetManifest(backend.artifacts))!;
    const hermes = { ...(before.hermes ?? {}) };
    for (const ref of opts.drop ?? []) delete hermes[ref];
    for (const ref of refs) Object.assign(hermes, current(ref));
    await backend.artifacts.putObject(
      "manifest.json",
      new TextEncoder().encode(JSON.stringify({ ...before, hermes })),
    );
  }
});
