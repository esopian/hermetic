/**
 * One hermeticd, both Hermes pins. The install recipe is chosen from the
 * checkout on the box, never from a new agent-row field: a v0.21 checkout
 * (`.python-version` 3.11, `package-lock.json`) takes the editable pip install
 * and npm, a v0.23 one (3.14, `pnpm-lock.yaml`, an install-stamp reader) takes
 * `uv sync --frozen`, the stamp and pnpm. Both directions of the move are
 * here, because a new hermeticd reaches every box before its Hermes moves.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { hermesBundleKey } from "@hermetic/core/schema";
import type { FleetManifest } from "@hermetic/core/schema";
import { hermesConfigGetArgv } from "@hermetic/core/shared";
import {
  NODE_VERSION,
  apply,
  nodeArch,
  reportsHermesVersion,
  resetAptIndexState,
} from "../src/apply/index.ts";
import {
  HERMES_INSTALL_STAMP,
  UV_VERSION,
  installStamp,
  uvRelease,
  venvMatches,
} from "../src/apply/hermes.ts";
import {
  BUILD_SWAP,
  BUILD_SWAP_DIR,
  PNPM_NODE_VERSION,
  PNPM_VERSION,
  WEB_BUILD_NODE_OPTIONS,
  nodeDir,
  pnpmRelease,
  prefetched,
} from "../src/apply/node-web.ts";
import { HERMES_PREVIOUS_ROOT } from "../src/apply/hermes-previous.ts";
import { AgentdError } from "../src/errors.ts";
import type { Emit } from "../src/events.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { HERMES_BUNDLE_PATH } from "../src/hermes-source.ts";
import { expectNotRan, ranInOrder } from "./fake-host.ts";
import { ASTRAL_UV_VERSION, BoxHost, fakeCommitSha } from "./fake-box.ts";
import { makeFleetManifest, makeManifest, sha256Of } from "./fixtures.ts";

const DIR = "/usr/local/lib/hermes-agent";
const VENV = `${DIR}/venv`;
const OLD = { hermes_ref: "v0.21.5", hermes_version: "0.21.5" };
const NEW = { hermes_ref: "v0.23.1", hermes_version: "0.23.1" };
const SYNC_BASE =
  "uv sync --frozen --inexact --compile-bytecode --extra all --extra messaging " +
  "--extra exa --extra firecrawl --extra parallel-web --extra ddgs --extra edge-tts " +
  "--extra voice --extra mistral --extra fal";
const SYNC = `${SYNC_BASE} --extra bedrock`;
/** The 3.14 recipe's network steps run under `timeout(1)`, like the npm steps. */
const BOUNDED = "timeout 900 ";
/** uv run against the Hermes venv, as opposed to the agent's own (`runuser … uv venv --no-config`). */
const HERMES_UV = /^uv (venv|pip|sync) (?!--no-config)/;
const LEGACY_PIP = `uv pip install --python ${VENV}/bin/python -e ${DIR}[all,messaging,bedrock]`;

let host: BoxHost;

beforeEach(() => {
  host = new BoxHost();
  resetAptIndexState();
  host.hermesVersionByRef.set(OLD.hermes_ref, OLD.hermes_version);
  host.hermesVersionByRef.set(NEW.hermes_ref, NEW.hermes_version);
  host.hermesStampRefs.add(NEW.hermes_ref);
});

const version = async (): Promise<string> =>
  (await host.exec(["/usr/local/bin/hermes", "--version"])).stdout;

describe("the python recipe follows the checkout", () => {
  test("a 3.11 checkout still runs the legacy recipe, and gets no stamp", async () => {
    await apply(makeManifest(OLD), { host });

    expect(host.commandsMatching(HERMES_UV)).toEqual([`uv venv --python 3.11 ${VENV}`, LEGACY_PIP]);
    expect(host.files.has(HERMES_INSTALL_STAMP)).toBe(false);
    expect(host.files.get(`${DIR}/.hermetic-extras`)?.content).toBe(`${DIR}[all,messaging,bedrock]\n`);
  });

  test("a 3.14 checkout runs uv sync --frozen from the checkout into the venv", async () => {
    const seen: Array<{ cwd?: string; env?: Record<string, string> }> = [];
    host.when(/^uv sync /, (_argv, opts) => {
      seen.push({ cwd: opts?.cwd, env: opts?.env });
      return null;
    });

    await apply(makeManifest(NEW), { host });

    expect(host.commandsMatching(HERMES_UV)).toEqual([
      `${BOUNDED}uv venv --python 3.14 ${VENV}`,
      `${BOUNDED}${SYNC}`,
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe(DIR);
    expect(seen[0]?.env?.["UV_PROJECT_ENVIRONMENT"]).toBe(VENV);
    expect(seen[0]?.env?.["UV_PYTHON_INSTALL_DIR"]).toBe("/usr/local/share/uv/python");
    expectNotRan(host, /--no-editable/);
    expect(host.files.get(`${DIR}/.hermetic-extras`)?.content).toBe(`${SYNC}\n`);
  });

  /** What v0.21 lazy-installed is installed up front; the provider extra stays per provider. */
  test("the 3.14 sync carries the formerly lazy extras, and only the provider's own extra", async () => {
    await apply(makeManifest({ ...NEW, provider: "anthropic" }), { host, providerKey: "FIXTURE" });
    expect(host.commandsMatching(/^uv sync /)).toEqual([`${BOUNDED}${SYNC_BASE} --extra anthropic`]);

    host.commands.length = 0;
    await apply(makeManifest({ ...NEW, provider: "openrouter" }), { host, providerKey: "FIXTURE" });
    expect(host.commandsMatching(/^uv sync /)).toEqual([`${BOUNDED}${SYNC_BASE}`]);
  });

  test("the legacy install for each provider is byte-for-byte what it was", async () => {
    await apply(makeManifest({ ...OLD, provider: "anthropic" }), { host, providerKey: "FIXTURE" });
    expect(host.commandsMatching(HERMES_UV)).toEqual([
      `uv venv --python 3.11 ${VENV}`,
      `uv pip install --python ${VENV}/bin/python -e ${DIR}[all,messaging,anthropic]`,
    ]);

    host.commands.length = 0;
    await apply(makeManifest({ ...OLD, provider: "openrouter" }), { host, providerKey: "FIXTURE" });
    expect(host.commandsMatching(HERMES_UV)).toEqual([
      `uv pip install --python ${VENV}/bin/python -e ${DIR}[all,messaging]`,
    ]);
  });

  test("a 3.14 checkout that is already pinned and stamped is left alone", async () => {
    await apply(makeManifest(NEW), { host });

    host.commands.length = 0;
    const result = await apply(makeManifest(NEW), { host });

    expectNotRan(
      host,
      /^uv |^git -C \S+ (fetch|checkout)|^rm -rf -- \/usr\/local\/lib\/hermes-agent\/venv/,
    );
    expect(result.installed).toEqual([]);
  });

  test("a seeded 3.11 venv under a 3.14 checkout is moved aside and rebuilt", async () => {
    await apply(makeManifest(OLD), { host });
    expect(host.files.get(`${VENV}/pyvenv.cfg`)?.content).toContain("version_info = 3.11.");

    host.commands.length = 0;
    await apply(makeManifest(NEW), { host });

    // Set aside for a rollback rather than deleted; the swap passing its gate drops it.
    expect(host.fsOps).toContain(`rename ${VENV} -> ${HERMES_PREVIOUS_ROOT}/${OLD.hermes_ref}/venv`);
    expect(ranInOrder(host, [/^git -C \S+ checkout /, `uv venv --python 3.14 ${VENV}`, SYNC])).toBe(
      true,
    );
    expect(host.files.get(`${VENV}/pyvenv.cfg`)?.content).toContain("version_info = 3.14.");
    expectNotRan(host, /^uv pip install/);
    expect(await version()).toContain("v0.23.1");
  });

  test("a rollback to a 3.11 checkout rebuilds the venv and takes the legacy recipe again", async () => {
    // Up from v0.21.5 first: a downgrade needs the backup that move takes.
    await apply(makeManifest(OLD), { host });
    await apply(makeManifest(NEW), { host });

    host.commands.length = 0;
    await apply(makeManifest(OLD), { host });

    expect(host.commandsMatching(new RegExp(`^rm -rf -- ${VENV}$|${HERMES_UV.source}`))).toEqual([
      `rm -rf -- ${VENV}`,
      `uv venv --python 3.11 ${VENV}`,
      LEGACY_PIP,
    ]);
    expect(await version()).toContain("v0.21.5");
  });
});

describe("the gateway unit's name (v0.23 reads the account from passwd)", () => {
  const BARE = "/etc/systemd/system/hermes-gateway.service";

  /**
   * What qa23-new hit: root runs the installer, v0.23 takes root's passwd home
   * whatever `HOME` says, and wrote `hermes-gateway-c5b5bead.service`.
   */
  test("a v0.23 install names the bare unit, as the hermes account's sudo would", async () => {
    await apply(makeManifest(NEW), { host });

    expect(host.files.has(BARE)).toBe(true);
    expect(host.gatewayInstalls).toHaveLength(1);
    expect(host.gatewayInstalls[0]?.env["SUDO_USER"]).toBe("hermes");
  });

  test("a v0.21.5 install runs with exactly the env it always had", async () => {
    await apply(makeManifest(OLD), { host });

    expect(host.files.has(BARE)).toBe(true);
    expect(host.gatewayInstalls.map((i) => i.env)).toEqual([
      {
        HERMES_HOME: "/data/hermes/.hermes",
        HOME: "/data/hermes",
        HERMES_DISABLE_LAZY_INSTALLS: "1",
      },
    ]);
  });
});

describe("the install stamp (v0.23)", () => {
  test("is written before any hermes runs, gateway install included, and that runs without lazy installs", async () => {
    const atHermes: Array<string | undefined> = [];
    const gatewayEnv: Array<Record<string, string> | undefined> = [];
    host.when(/^\/usr\/local\/bin\/hermes /, () => {
      atHermes.push(host.files.get(HERMES_INSTALL_STAMP)?.content);
      return null;
    });
    host.when(/hermes gateway install/, (_argv, opts) => {
      atHermes.push(host.files.get(HERMES_INSTALL_STAMP)?.content);
      gatewayEnv.push(opts?.env);
      return null;
    });

    await apply(makeManifest(NEW), { host });

    const stamp = installStamp(fakeCommitSha(NEW.hermes_ref), NEW.hermes_version);
    expect(atHermes.length).toBeGreaterThan(1);
    expect(atHermes.every((seen) => seen === stamp)).toBe(true);
    expect(gatewayEnv).toHaveLength(1);
    expect(gatewayEnv[0]?.["HERMES_DISABLE_LAZY_INSTALLS"]).toBe("1");
    expect(host.files.get(HERMES_INSTALL_STAMP)?.mode).toBe("0644");
    expect(JSON.parse(stamp)).toEqual({
      schemaVersion: 2,
      commit: fakeCommitSha(NEW.hermes_ref),
      source: "git",
      updateMechanism: "external",
      baseVersion: "0.23.1",
      displayVersion: "0.23.1",
      distance: 0,
      dirty: false,
      distribution: null,
      payload: "bootstrap",
      tag: null,
      branch: null,
    });
  });

  /**
   * The version check alone would call this box pinned, and its next launch
   * would adopt the checkout (B4). So the stamp is part of "already pinned".
   */
  test("a retained tag: a fresh clone reports its version without the stamp, and the apply still restores it", async () => {
    await apply(makeManifest(NEW), { host });
    await host.remove(HERMES_INSTALL_STAMP);
    expect(reportsHermesVersion(await version(), "0.23.1")).toBe(true);

    await apply(makeManifest(NEW), { host });
    expect(host.files.get(HERMES_INSTALL_STAMP)?.content).toBe(
      installStamp(fakeCommitSha(NEW.hermes_ref), NEW.hermes_version),
    );
  });

  test("no tag: an in-place upgrade without the stamp would report git.<sha>, so the stamp is what passes it", async () => {
    await apply(makeManifest(OLD), { host });
    await apply(makeManifest(NEW), { host });
    expect(reportsHermesVersion(await version(), "0.23.1")).toBe(true);

    await host.remove(HERMES_INSTALL_STAMP);
    const reported = await version();
    expect(reported).toContain(`vgit.${fakeCommitSha(NEW.hermes_ref).slice(0, 7)}`);
    expect(reportsHermesVersion(reported, "0.23.1")).toBe(false);
  });

  test("a stale stamp is ignored by hermes and rewritten by the next apply", async () => {
    await apply(makeManifest(OLD), { host });
    await apply(makeManifest(NEW), { host });
    const stale = installStamp(fakeCommitSha(OLD.hermes_ref), NEW.hermes_version);
    await host.writeFile(HERMES_INSTALL_STAMP, stale, "0644");
    expect(await version()).toContain("vgit.");

    host.commands.length = 0;
    await apply(makeManifest(NEW), { host });

    expect(host.files.get(HERMES_INSTALL_STAMP)?.content).toBe(
      installStamp(fakeCommitSha(NEW.hermes_ref), NEW.hermes_version),
    );
    expect(reportsHermesVersion(await version(), "0.23.1")).toBe(true);
  });

  test("hermeticd's own config reads run hermes without lazy installs too", () => {
    expect(hermesConfigGetArgv("model.default")).toContain("HERMES_DISABLE_LAZY_INSTALLS=1");
  });

  test("an upgrade from the fleet's mirror passes its cross-check on the stamp", async () => {
    const seedMirror = (ref: string): void => {
      const bytes = BoxHost.bundleBytes(ref);
      host.s3Objects.set(hermesBundleKey(ref), bytes);
      const base = makeFleetManifest();
      const fleet: FleetManifest = {
        ...base,
        hermes: {
          ...base.hermes,
          [ref]: {
            key: hermesBundleKey(ref),
            sha256: sha256Of(bytes),
            size: bytes.length,
            upstream_sha: fakeCommitSha(`upstream:${ref}`),
          },
        },
      };
      host.seed(FLEET_CACHE_PATH, JSON.stringify(fleet));
    };
    seedMirror(OLD.hermes_ref);
    await apply(makeManifest(OLD), { host, getObject: host.getObject });
    seedMirror(NEW.hermes_ref);

    host.commands.length = 0;
    await apply(makeManifest(NEW), { host, getObject: host.getObject });

    expect(host.commandsMatching(/^git -C \S+ fetch /)).toEqual([
      `git -C ${DIR} fetch ${HERMES_BUNDLE_PATH} v0.23.1`,
    ]);
    expect(host.files.get(`${DIR}/.hermetic-ref`)?.content).toStartWith("v0.23.1\n");
    // The fetch brought no tag, so the stamp is all that names the version.
    await host.remove(HERMES_INSTALL_STAMP);
    expect(reportsHermesVersion(await version(), "0.23.1")).toBe(false);
  });
});

describe("the web build follows the checkout's lockfile", () => {
  const PNPM = pnpmRelease(nodeArch());
  const PNPM_DIR = `/usr/local/lib/pnpm/pnpm-${PNPM_VERSION}-linux-${nodeArch()}`;
  const MARKER = `${DIR}/web/.hermetic-built`;

  test("an npm checkout keeps node 24.20.0 and a pnpm checkout gets upstream's 26.12.1", async () => {
    expect((await apply(makeManifest(OLD), { host })).installed).toContain("node@24.20.0");
    expect(host.files.get("/usr/local/bin/node")?.content).toBe("v24.20.0\n");

    const result = await apply(makeManifest(NEW), { host });
    expect(result.installed).toContain("node@26.12.1");
    expect(host.files.get("/usr/local/bin/node")?.content).toBe("v26.12.1\n");
  });

  test("a pnpm checkout installs the pinned pnpm, runs node-deps, and builds with pnpm", async () => {
    const result = await apply(makeManifest(NEW), { host });

    expect(
      ranInOrder(host, [
        `curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 -o ${PNPM_DIR}.tgz ${PNPM.url}`,
        `tar --no-same-owner -xzf ${PNPM_DIR}.tgz -C ${PNPM_DIR} --strip-components=1`,
        `ln -sfn ${PNPM_DIR}/pnpm /usr/local/bin/pnpm`,
      ]),
    ).toBe(true);
    expect(host.commandsMatching(/node-deps|^timeout \d+ pnpm /)).toEqual([
      `timeout 900 node scripts/build/node-deps.mjs --source ${DIR} --workspace web --workspace ui-tui`,
      "timeout 900 pnpm --filter web run build",
      "timeout 900 pnpm --filter hermes-tui run build",
    ]);
    expect(host.pnpmRuns.map((r) => r.cwd)).toEqual([DIR, DIR, DIR]);
    expect(host.pnpmRuns[0]?.env["PATH"]).toStartWith("/usr/local/bin:");
    expect(host.npmRuns).toEqual([]);
    expect(host.files.has(`${PNPM_DIR}.tgz`)).toBe(false);
    expect(host.files.has(`${DIR}/hermes_cli/web_dist/index.html`)).toBe(true);
    expect(host.files.has(`${DIR}/ui-tui/dist/entry.js`)).toBe(true);
    expect(host.files.get(MARKER)?.content).toBe(
      `v0.23.1 node-v${PNPM_NODE_VERSION} pnpm-${PNPM_VERSION}\n`,
    );
    expect(result.installed).toContain(`pnpm@${PNPM_VERSION}`);
  });

  test("a second apply of a pnpm checkout fetches and builds nothing", async () => {
    await apply(makeManifest(NEW), { host });

    host.commands.length = 0;
    host.pnpmRuns.length = 0;
    await apply(makeManifest(NEW), { host });

    expect(host.pnpmRuns).toEqual([]);
    expectNotRan(host, /registry\.npmjs\.org/);
  });

  test("an npm checkout stays on npm and never fetches pnpm", async () => {
    await apply(makeManifest(OLD), { host });

    expect(host.npmRuns.length).toBeGreaterThan(0);
    expect(host.pnpmRuns).toEqual([]);
    expectNotRan(host, /registry\.npmjs\.org/);
    expect(host.files.get(MARKER)?.content).toBe(`v0.21.5 node-v${NODE_VERSION}\n`);
  });

  test("npm's node_modules are removed before pnpm installs over them, and pnpm's on the way back", async () => {
    await apply(makeManifest(OLD), { host });
    expect(host.files.has(`${DIR}/node_modules/.package-lock.json`)).toBe(true);

    host.commands.length = 0;
    const npmTreeAtInstall: boolean[] = [];
    host.when(/node-deps\.mjs/, () => {
      npmTreeAtInstall.push(host.files.has(`${DIR}/node_modules/.package-lock.json`));
      return null;
    });
    await apply(makeManifest(NEW), { host });
    // Forward, npm's tree is moved aside for a rollback rather than deleted.
    expect(host.fsOps).toContain(
      `rename ${DIR}/node_modules -> ${HERMES_PREVIOUS_ROOT}/${OLD.hermes_ref}/node_modules`,
    );
    expect(npmTreeAtInstall).toEqual([false]);

    host.commands.length = 0;
    await apply(makeManifest(OLD), { host });
    expect(ranInOrder(host, [`rm -rf -- ${DIR}/node_modules`, /^timeout 900 npm ci /])).toBe(true);
  });

  test("a pnpm release whose digest is not the pinned one is refused, and nothing is linked", async () => {
    host.curlBodies.set(PNPM.url, "a truncated download\n");
    const err = (await apply(makeManifest(NEW), { host }).catch((e: unknown) => e)) as AgentdError;
    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    expect(host.files.has("/usr/local/bin/pnpm")).toBe(false);
    expect(host.files.has(`${PNPM_DIR}.tgz`)).toBe(false);
  });

  describe("on a t4g.small (1834 MB, no swap)", () => {
    const webBuild = () =>
      host.pnpmRuns.filter((r) => r.argv.join(" ").includes("--filter web run build"));
    const WEB_BUILD = /^timeout 900 pnpm --filter web run build$/;
    const SWAP_COMMAND =
      /^(fallocate|mkswap|swapon|timeout \d+ swapoff) |^chmod 600 \/data\/hermetic-swap\/build\.swap$/;
    const SWAP_ADD = [
      `fallocate -l 1G ${BUILD_SWAP}`,
      `chmod 600 ${BUILD_SWAP}`,
      `mkswap ${BUILD_SWAP}`,
      `swapon ${BUILD_SWAP}`,
    ];
    const SWAP_OFF = [`timeout 300 swapoff ${BUILD_SWAP}`];
    const expectNoBuildSwap = (): void => {
      expect(host.files.has(BUILD_SWAP)).toBe(false);
      expect(host.files.get("/proc/swaps")?.content ?? "").not.toContain(BUILD_SWAP);
    };

    beforeEach(() => {
      host.memoryMb = 1834;
    });

    test("a fresh pnpm install caps the web build's V8 heap and builds beside temporary swap", async () => {
      await apply(makeManifest(NEW), { host });

      expect(webBuild().map((r) => r.env["NODE_OPTIONS"])).toEqual([WEB_BUILD_NODE_OPTIONS]);
      expect(host.files.get(MARKER)?.content).toBe(
        `v0.23.1 node-v${PNPM_NODE_VERSION} pnpm-${PNPM_VERSION}\n`,
      );
      expect(host.commandsMatching(SWAP_COMMAND)).toEqual(SWAP_ADD.concat(SWAP_OFF));
      expect(ranInOrder(host, [...SWAP_ADD, WEB_BUILD, ...SWAP_OFF])).toBe(true);
      expectNoBuildSwap();
      // On the encrypted data volume, in root's own directory: `hermes` can neither write nor plant a link there.
      expect(BUILD_SWAP).toBe("/data/hermetic-swap/build.swap");
      expect(host.dirAttrs.get(BUILD_SWAP_DIR)).toEqual({ mode: "0700", ownership: "root:root" });
    });

    test("an in-place upgrade from the npm pin builds under the cap and swap, and the npm recipe is unchanged", async () => {
      await apply(makeManifest(OLD), { host });
      expect(host.commandsMatching(/^timeout \d+ npm /)).toEqual([
        "timeout 900 npm ci --workspace web --workspace ui-tui --include-workspace-root --include=dev --no-audit --no-fund --loglevel=error",
        "timeout 900 npm run build --workspace web",
        "timeout 900 npm run build --workspace ui-tui",
      ]);
      expect(host.npmRuns.every((r) => r.env["NODE_OPTIONS"] === undefined)).toBe(true);
      expectNotRan(host, SWAP_COMMAND);

      host.commands.length = 0;
      await apply(makeManifest(NEW), { host });
      expect(webBuild().map((r) => r.env["NODE_OPTIONS"])).toEqual([WEB_BUILD_NODE_OPTIONS]);
      expect(host.files.get(MARKER)?.content).toStartWith("v0.23.1 ");
      // Only the web build: node-deps and the esbuild TUI build keep their defaults.
      expect(host.pnpmRuns.filter((r) => r.env["NODE_OPTIONS"] !== undefined)).toHaveLength(1);
      expect(ranInOrder(host, [...SWAP_ADD, WEB_BUILD, ...SWAP_OFF])).toBe(true);
      expectNoBuildSwap();

      // Swap aside, the upgrade ran exactly what it runs on a box with room to spare.
      const big = new BoxHost();
      big.hermesVersionByRef.set(OLD.hermes_ref, OLD.hermes_version);
      big.hermesVersionByRef.set(NEW.hermes_ref, NEW.hermes_version);
      big.hermesStampRefs.add(NEW.hermes_ref);
      await apply(makeManifest(OLD), { host: big });
      big.commands.length = 0;
      await apply(makeManifest(NEW), { host: big });
      expect(host.commands.filter((c) => !SWAP_COMMAND.test(c))).toEqual(big.commands);
    });

    test("swap that cannot be enabled is a warning, and the build still runs", async () => {
      host.when(/^swapon /, { code: 255, stderr: "swapon failed: Invalid argument" });
      const warnings: string[] = [];
      const emit: Emit = (e) => {
        if (e.level === "warn") warnings.push(e.message);
      };

      const err = await apply(makeManifest(NEW), { host, emit }).catch((e: unknown) => e);

      // The fake's worst-case build does not fit without swap: the point is that it was tried.
      expect(err).toBeInstanceOf(AgentdError);
      expect(webBuild()).toHaveLength(1);
      expect(warnings.some((w) => w.startsWith("could not add temporary swap"))).toBe(true);
      expectNotRan(host, /^timeout \d+ swapoff /);
      expectNoBuildSwap();
    });

    test("too little free space on the data volume skips the swap with a warning", async () => {
      host.filesystemResult = { mount: "/", size: 8 * 1024 ** 3, available: 1024 ** 3, usePct: 88 };
      const warnings: string[] = [];
      const emit: Emit = (e) => {
        if (e.level === "warn") warnings.push(e.message);
      };

      await apply(makeManifest(NEW), { host, emit }).catch(() => undefined);

      expect(webBuild()).toHaveLength(1);
      expectNotRan(host, SWAP_COMMAND);
      expect(warnings.some((w) => w.startsWith("too little free space on the data volume"))).toBe(true);
    });

    test("a /data that is not mounted skips the swap with a warning, never the root disk", async () => {
      host.dataMounted = false;
      const warnings: string[] = [];
      const emit: Emit = (e) => {
        if (e.level === "warn") warnings.push(e.message);
      };

      await apply(makeManifest(NEW), { host, emit }).catch(() => undefined);

      expect(webBuild()).toHaveLength(1);
      expectNotRan(host, SWAP_COMMAND);
      expect(host.dirs.has(BUILD_SWAP_DIR)).toBe(false);
      expect(warnings.some((w) => w.startsWith("/data is not mounted"))).toBe(true);
    });

    test("free space that cannot be measured skips the swap with its own warning", async () => {
      host.filesystemResult = null;
      const warnings: string[] = [];
      const emit: Emit = (e) => {
        if (e.level === "warn") warnings.push(e.message);
      };

      await apply(makeManifest(NEW), { host, emit }).catch(() => undefined);

      expect(webBuild()).toHaveLength(1);
      expectNotRan(host, SWAP_COMMAND);
      expect(
        warnings.some((w) => w.startsWith("could not measure free space on the data volume")),
      ).toBe(true);
      expect(warnings.some((w) => w.startsWith("too little free space"))).toBe(false);
    });

    test("an upgrade whose build is killed anyway removes the swap before it rolls back", async () => {
      await apply(makeManifest(OLD), { host });
      host.when(WEB_BUILD, { code: 137, stderr: "Killed" });
      host.commands.length = 0;

      const err = (await apply(makeManifest(NEW), { host }).catch((e: unknown) => e)) as AgentdError;

      expect(err.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
      const at = host.commands.findIndex((c) => WEB_BUILD.test(c));
      expect(host.commands.slice(at - SWAP_ADD.length, at + 2)).toEqual([
        ...SWAP_ADD,
        host.commands[at] as string,
        ...SWAP_OFF,
      ]);
      expect(host.hermesCheckedOutRef).toBe(OLD.hermes_ref);
      expectNoBuildSwap();
    });

    test("a 4 GiB box runs no swap command", async () => {
      host.memoryMb = 4096;
      await apply(makeManifest(NEW), { host });
      expectNotRan(host, SWAP_COMMAND);
      expect(webBuild()).toHaveLength(1);
    });

    test("a box with swap of its own runs no swap command", async () => {
      host.seed("/proc/swaps", "Filename Type Size Used Priority\n/swapfile file 2097148 0 -2\n");
      await apply(makeManifest(NEW), { host });
      expectNotRan(host, SWAP_COMMAND);
      expect(webBuild()).toHaveLength(1);
    });
  });
});

describe("uv follows the checkout", () => {
  const UV = uvRelease(nodeArch());
  const UV_CURL = `curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 -o ${UV.dir}.tar.gz ${UV.url}`;

  test("a 3.14 checkout installs the pinned uv once, after the checkout, verified and linked", async () => {
    await apply(makeManifest(NEW), { host });

    expect(
      ranInOrder(host, [
        /^git clone /,
        "/bin/sh -c uv --version",
        UV_CURL,
        `ln -sfn ${UV.dir}/uv /usr/local/bin/uv`,
        `ln -sfn ${UV.dir}/uvx /usr/local/bin/uvx`,
        /^uv venv --python 3.14 /,
      ]),
    ).toBe(true);
    expectNotRan(host, /astral\.sh/);
    expect(host.files.get("/usr/local/bin/uv")?.content).toBe(`uv ${UV_VERSION}\n`);
    expect(host.files.has(`${UV.dir}.tar.gz`)).toBe(false);

    host.commands.length = 0;
    await host.remove(`${DIR}/.hermetic-ref`); // force the install path again
    await apply(makeManifest(NEW), { host });
    expectNotRan(host, /astral-sh\/uv/);
  });

  /** A box born under astral's unpinned installer carries whatever uv was current that day (G2). */
  test("an upgrade to a 3.14 checkout replaces astral's uv with the pinned one", async () => {
    await apply(makeManifest(OLD), { host });
    expect((await host.exec(["/bin/sh", "-c", "uv --version"])).stdout).toBe(
      `uv ${ASTRAL_UV_VERSION}\n`,
    );

    await apply(makeManifest(NEW), { host });
    // A version change: downloaded before the hold, installed from there while held.
    expect(host.commandsMatching(/astral-sh\/uv/)).toEqual([
      `curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 -o ${prefetched(UV.sha256)} ${UV.url}`,
    ]);
    expect((await host.exec(["/bin/sh", "-c", "uv --version"])).stdout).toBe(`uv ${UV_VERSION}\n`);
  });

  test("a box whose uv already reports the pinned version never fetches it", async () => {
    host.uvVersion = UV_VERSION;
    await apply(makeManifest(NEW), { host });
    expectNotRan(host, /astral-sh\/uv|astral\.sh/);
  });

  test("a uv release whose digest is not the pinned one is refused, and nothing is linked", async () => {
    host.curlBodies.set(UV.url, "a truncated download\n");
    const err = (await apply(makeManifest(NEW), { host }).catch((e: unknown) => e)) as AgentdError;
    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    expectNotRan(host, /^tar .*uv-/);
    expect(host.files.has("/usr/local/bin/uv")).toBe(false);
    expect(host.files.has(`${UV.dir}.tar.gz`)).toBe(false);
  });
});

/**
 * hermeticd's auto-update puts this binary on every live v0.21.5 box before
 * anyone upgrades it. The box is seeded as the previous hermeticd left it, not
 * built by this one, so nothing this hermeticd would have done differently can
 * hide in the setup.
 */
describe("a v0.21.5 box under the new hermeticd", () => {
  const NODE_DIR = nodeDir(nodeArch(), "24.20.0");
  const WEB_MARKER = `${DIR}/web/.hermetic-built`;
  const TOOLCHAIN =
    /astral|uv-[a-z0-9_]+-unknown|^uv venv --python|^rm -rf -- \S+\/(venv|node_modules)$|nodejs\.org|^tar .*node-v|-o \S+\/usr\/local\/bin\/(node|npm|npx|uv|pnpm)$|^ln -sfn \S+ \/usr\/local\/bin\/(node|npm|npx|uv|uvx|pnpm)$|npm (ci|install|run)|pnpm|node-deps/;

  beforeEach(() => {
    // The checkout, as `git clone --depth 1 --branch v0.21.5` left it.
    host.hermesCheckedOutRef = OLD.hermes_ref;
    host.hermesInstalledVersion = OLD.hermes_version;
    host.seed(`${DIR}/.git/HEAD`, `ref: ${OLD.hermes_ref}\n`);
    host.seed(`${DIR}/.python-version`, "3.11\n");
    host.seed(`${DIR}/pyproject.toml`, '[project]\nversion = "0.21.5"\n');
    host.seed(`${DIR}/package.json`, '{"workspaces":["ui-tui","web"]}\n');
    host.seed(`${DIR}/package-lock.json`, '{"lockfileVersion":3}\n');
    host.seed(`${DIR}/web/package.json`, '{"name":"web"}\n');
    host.seed(`${DIR}/ui-tui/package.json`, '{"name":"hermes-tui"}\n');
    // The venv uv built on 3.11, and the install's markers.
    host.seed(`${VENV}/bin/python`, "#!/bin/sh\n", "0755");
    host.seed(`${VENV}/pyvenv.cfg`, "implementation = CPython\nversion_info = 3.11.13\n");
    host.seed(`${VENV}/bin/hermes`, "#!/bin/sh\n", "0755");
    host.seed("/usr/local/bin/hermes", "#!/bin/sh\n", "0755");
    host.seed(`${DIR}/.hermetic-ref`, `${OLD.hermes_ref}\n`);
    host.seed(`${DIR}/.hermetic-extras`, `${DIR}[all,messaging,bedrock]\n`);
    // astral's uv, Node 24 linked onto PATH, and the npm-built UI.
    host.uvVersion = ASTRAL_UV_VERSION;
    for (const tool of ["node", "npm", "npx"]) {
      host.seed(`${NODE_DIR}/bin/${tool}`, "v24.20.0\n", "0755");
      host.seed(`/usr/local/bin/${tool}`, "v24.20.0\n", "0755");
    }
    host.seed(`${DIR}/node_modules/.package-lock.json`, "{}\n");
    host.seed(`${DIR}/hermes_cli/web_dist/index.html`, "<!doctype html>\n");
    host.seed(`${DIR}/ui-tui/dist/entry.js`, "#!/usr/bin/env node\n");
    host.seed(WEB_MARKER, "v0.21.5 node-v24.20.0\n");
  });

  test("a converge reapply changes no part of the toolchain and rebuilds nothing", async () => {
    const result = await apply(makeManifest(OLD), { host });

    expect(host.commandsMatching(TOOLCHAIN)).toEqual([]);
    expect(host.commandsMatching(HERMES_UV)).toEqual([]);
    expectNotRan(host, /^\/bin\/sh -c uv --version/);
    expect(result.installed.filter((p) => /^(node|pnpm|hermes-agent)@/.test(p))).toEqual([]);
    expect(host.files.get(WEB_MARKER)?.content).toBe("v0.21.5 node-v24.20.0\n");
    expect(host.files.get("/usr/local/bin/node")?.content).toBe("v24.20.0\n");
    expect(host.files.has(HERMES_INSTALL_STAMP)).toBe(false);
  });

  /**
   * A no-op converge proves little (plan 5.4 step 2): a pinned box skips the
   * dependency work. With the extras marker gone the Hermes install really
   * runs, and it must be the old recipe on the old toolchain.
   */
  test("a real reinstall runs the old recipe on the old toolchain, and still rebuilds nothing", async () => {
    await host.remove(`${DIR}/.hermetic-extras`);

    await apply(makeManifest(OLD), { host });

    expect(host.commandsMatching(HERMES_UV)).toEqual([LEGACY_PIP]);
    expect(host.commandsMatching(TOOLCHAIN)).toEqual([]);
    expect(host.commandsMatching(/^\/bin\/sh -c (command -v uv|uv --version)$/)).toEqual([
      "/bin/sh -c command -v uv",
    ]);
    expect(host.files.get(`${VENV}/pyvenv.cfg`)?.content).toContain("version_info = 3.11.13");
    expect(host.files.get(WEB_MARKER)?.content).toBe("v0.21.5 node-v24.20.0\n");
    expect(host.files.get("/usr/local/bin/node")?.content).toBe("v24.20.0\n");
    expect(host.files.has(HERMES_INSTALL_STAMP)).toBe(false);
    expect(reportsHermesVersion(await version(), "0.21.5")).toBe(true);
  });
  /** A venv whose `pyvenv.cfg` predates `version_info` is still the box's working install. */
  test("a pyvenv.cfg with no version_info keeps the venv: the reinstall runs into it, nothing is wiped", async () => {
    host.seed(`${VENV}/pyvenv.cfg`, "home = /usr/bin\ninclude-system-site-packages = false\n");
    await host.remove(`${DIR}/.hermetic-extras`);

    await apply(makeManifest(OLD), { host });

    expectNotRan(host, /^rm -rf -- \S+\/venv$/);
    expect(host.commandsMatching(HERMES_UV)).toEqual([LEGACY_PIP]);
    expect(reportsHermesVersion(await version(), "0.21.5")).toBe(true);
  });
});

describe("venvMatches", () => {
  test("reads version_info, else the stdlib venv's version; a cfg naming neither keeps the venv, no cfg is no venv", () => {
    expect(venvMatches("version_info = 3.11.13\n", "3.11")).toBe(true);
    expect(venvMatches("version_info = 3.11.13\n", "3.14")).toBe(false);
    expect(venvMatches("home = /usr/bin\nversion = 3.11.4\n", "3.11")).toBe(true);
    expect(venvMatches("home = /usr/bin\nversion = 3.11.4\n", "3.14")).toBe(false);
    expect(venvMatches("home = /usr/bin\n", "3.14")).toBe(true);
    expect(venvMatches(null, "3.11")).toBe(false);
  });
});
