/**
 * Hermes' browser UI, which is not even a Python artifact: a Vite bundle and an
 * Ink TUI built here from the checkout, with a Node that apt cannot supply
 * (§6.4).
 */
import type { AgentConfig } from "@hermetic/core/schema";
import { HERMES_INSTALL_DIR, HERMES_TUI_DIR, HERMES_WEB_DIST_DIR } from "@hermetic/core/shared";
import type { ExecOptions, Host } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { DATA_MOUNT } from "../disk.ts";
import { STATE_DIR } from "../fleet.ts";
import type { ApplyOptions, ApplyResult } from "./shared.ts";
import { retry } from "./shared.ts";

/**
 * Hermes ships two Node workspaces as source, and a box has to build both.
 *
 * `web/` is the Vite SPA `hermes dashboard` serves; `ui-tui/` is the Ink TUI the
 * dashboard's Chat tab spawns (`hermes_cli/web_server_chat.py:321`). Both are
 * built here, as root, at apply time — which is also why the rendered units pass
 * `--skip-build` and set `HERMES_TUI_DIR`: the unprivileged `hermes` user must
 * never run npm, and without a prebuilt TUI the launcher npm-installs at first
 * use into a root-owned tree and EACCESes (`Dockerfile:374-390`).
 */
export const HERMES_WEB_DIR = `${HERMES_INSTALL_DIR}/web`;
/**
 * What the last successful build was of. Content is `<hermes_ref> node-v<x>`,
 * plus ` pnpm-<y>` on a pnpm checkout, so a new Hermes ref, Node or pnpm re-runs
 * the build, and nothing else does.
 */
const HERMES_WEB_MARKER = `${HERMES_WEB_DIR}/.hermetic-built`;
/**
 * What Vite actually writes. Not `web/dist`: `outDir` is `../hermes_cli/web_dist`
 * (`web/vite.config.ts:103`), and upstream says so in as many words —
 * `hermes_cli/main_web_build.py:88-90`, *"Vite outputs to
 * `hermes_cli/web_dist/` (vite.config.ts outDir), NOT `web/dist/`"*. The
 * rendered unit's `HERMES_WEB_DIST` names the same directory
 * (`hermes_cli/web_server.py:58`), so nothing is inferred on either side.
 */
const HERMES_WEB_DIST_INDEX = `${HERMES_WEB_DIST_DIR}/index.html`;
/**
 * The prebuilt TUI bundle the launcher runs when `HERMES_TUI_DIR` is set:
 * `node --expose-gc $HERMES_TUI_DIR/dist/entry.js`
 * (`hermes_cli/main_tui_launch.py:552-555`, `Dockerfile:374-390`).
 */
const HERMES_TUI_ENTRY = `${HERMES_TUI_DIR}/dist/entry.js`;
/**
 * The lockfile `npm ci` requires, at the checkout *root*.
 *
 * `web/` and `ui-tui/` are workspace members of the root `package.json`
 * (`package.json:6-12`); neither has a lockfile of its own. hermetic used to
 * look for `web/package-lock.json`, never find it, and therefore install with
 * `npm install` from `cwd: web/` — which wrote a `web/package-lock.json` that
 * then flipped upstream's own `_workspace_root` verdict
 * (`hermes_cli/main_tui_launch.py:89-98`) for every later `hermes` invocation.
 * A checkout with no root lockfile is refused rather than installed loosely,
 * because that side effect is worse than a named failure.
 */
const HERMES_ROOT_LOCKFILE = `${HERMES_INSTALL_DIR}/package-lock.json`;
/**
 * The pnpm workspace layout upstream moved to in v0.23 (no root
 * `package-lock.json`). Its presence is what picks the pnpm recipe, so one
 * hermeticd builds an old checkout with npm and a new one with pnpm.
 */
const HERMES_PNPM_LOCKFILE = `${HERMES_INSTALL_DIR}/pnpm-lock.yaml`;
/**
 * The Node that builds an npm checkout (v0.21). Ubuntu's `nodejs` is 18 and its
 * `npm` is not even installed, while `web/package.json` pins vite 8, whose
 * `engines` demands `^22.22.0 || ^24.11.0 || >=26.0.0` — so apt cannot supply
 * this at any version, and the official tarball is the only source that can.
 * 24 is the LTS line those boxes were built with, and a new hermeticd reaches
 * them before their Hermes moves, so it stays exactly what it was.
 */
export const NODE_VERSION = "24.20.0";
/**
 * The Node that builds a pnpm checkout (v0.23): upstream's own pin
 * (`pm/lock.json`), and its `package.json` demands `node >=26`.
 */
export const PNPM_NODE_VERSION = "26.12.1";
/**
 * The V8 heap ceiling for a pnpm checkout's web build. Upstream's
 * `scripts/build/web.mjs` typechecks and bundles in one process and, with no
 * cgroup memory limit to size from (a systemd unit has none), caps that heap
 * at 4096 MB, so V8 never collects on a 2 GB box and the kernel OOM-kills the
 * build. An explicit `--max-old-space-size` wins over its default; 1024 is
 * the floor upstream itself goes down to (`HERMES_WEB_BUILD_LIGHT`).
 */
export const WEB_BUILD_NODE_OPTIONS = "--max-old-space-size=1024";
/**
 * The swapfile a pnpm web build runs beside on a small box with no swap of its
 * own. Under the cap the build's peak is still the heap plus young generation
 * plus Rolldown's native memory, which on a t4g.small varied run to run from
 * ~0.95 GB to past the ~1.35 GB one process can get, so the kernel OOM-killed
 * it with Hermes and the browser stopped (qa23-a, 2026-11-17). On the data
 * volume, which is encrypted while the root disk is not: the kernel swaps out
 * tmpfs pages too, secrets included. Never in `/etc/fstab`: it lives for one
 * build. Its directory is root's, 0700, beside the agent's home, never in it.
 */
export const BUILD_SWAP_DIR = `${DATA_MOUNT}/hermetic-swap`;
export const BUILD_SWAP = `${BUILD_SWAP_DIR}/build.swap`;
const GIB = 1024 ** 3;
/** 2 GiB-class boxes and smaller; a t4g.medium and up builds as before. */
const BUILD_SWAP_BELOW_BYTES = 3 * GIB;
/** The swapfile, plus a GiB left over for the build's own output. */
const BUILD_SWAP_MIN_FREE_BYTES = 2 * GIB;
const SWAPOFF_TIMEOUT_S = "300";

/** Whether the checkout on the box is the pnpm layout, which decides Node, pnpm and the build. */
async function pnpmCheckout(host: Host): Promise<boolean> {
  return (await host.stat(HERMES_PNPM_LOCKFILE)) !== null;
}
/**
 * pnpm as upstream pins it (`pm/lock.json` at v0.23.1): `scripts/build/node-deps.mjs`
 * refuses any other version. The `@pnpm/exe` build is a single native
 * executable, so it needs no Node of its own to start.
 */
export const PNPM_VERSION = "12.15.0";
const PNPM_SHA256: Readonly<Record<"arm64" | "x64", string>> = {
  arm64: "8117d65f28e627e949d5fc65d63342266326826a56fa374317bf13fe1166a50e",
  x64: "402f7045b1e0587acb1542f18d38afbccb6babf3c7451394e6fb3d9f0160c6ca",
};
const PNPM_INSTALL_ROOT = "/usr/local/lib/pnpm";

/** The `@pnpm/exe` release file for one arch, and the digest upstream pinned for it. */
export function pnpmRelease(arch: "arm64" | "x64"): { url: string; sha256: string } {
  return {
    url: `https://registry.npmjs.org/@pnpm/exe.linux-${arch}/-/exe.linux-${arch}-${PNPM_VERSION}.tgz`,
    sha256: PNPM_SHA256[arch],
  };
}
export const NODE_INSTALL_ROOT = "/usr/local/lib/nodejs";
/**
 * `/usr/local/bin` precedes `/usr/bin` on the default PATH, so these symlinks
 * shadow apt's v18 `node` without removing it — nothing else on the box has to
 * be told which Node it is getting.
 */
const NODE_LINK_DIR = "/usr/local/bin";
const NODE_TOOLS = ["node", "npm", "npx"] as const;
/**
 * The whole apply runs under a systemd oneshot with no timeout of its own, and
 * the stage runner does not impose one either (§4.2). A network call that hangs
 * would therefore hang the boot forever, so every step that reaches out is
 * bounded here: curl by its own flags, everything else by `timeout(1)`.
 */
const NODE_UNPACK_TIMEOUT_S = "300";
export const NPM_TIMEOUT_S = "900";
/**
 * How many times the dependency install is attempted, and how long it waits in
 * between. Short: npm has already spent its own `fetch-retries` inside each
 * attempt, so what this covers is the coarser failure — a NAT gateway that went
 * away for a few seconds, or a registry that 503'd the whole request.
 */
export const NPM_INSTALL_ATTEMPTS = 3;
export const NPM_RETRY_MS = 5_000;
/** curl's own bound, and enough retries to survive one bad mirror. */
const NODE_CURL_FLAGS = [
  "-fsSL",
  "--connect-timeout",
  "10",
  "--max-time",
  "300",
  "--retry",
  "3",
] as const;

/**
 * The Linux build of Node this box wants. Nodejs.org names exactly two arches
 * hermetic ever boots on; anything else is a manifest we cannot serve, said
 * plainly rather than by a 404 from curl.
 */
export function nodeArch(arch: string = process.arch): "arm64" | "x64" {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  throw new AgentdError(
    "UNSUPPORTED",
    `no official Node build for ${arch}; hermetic instances are arm64 or x64`,
    { arch },
  );
}

/**
 * Release files a Hermes version change downloaded and verified before it held
 * the units (`hermes-prefetch.ts`), so the held part of the swap installs them
 * without the network. On the root volume beside the install roots, so a take
 * is a rename. Every install still verifies what it takes.
 */
export const PREFETCH_DIR = `${STATE_DIR}/hermes-prefetch`;
export const prefetched = (name: string): string => `${PREFETCH_DIR}/${name}`;

/** Move the pre-fetched `name` to `path`; `false` when there is none. */
async function takePrefetched(host: Host, name: string, path: string): Promise<boolean> {
  const from = prefetched(name);
  if (from === path || (await host.stat(from)) === null) return false;
  await host.rename(from, path);
  return true;
}

/**
 * `curl -o` one release file and refuse it unless its digest is the one pinned
 * in source. Unlike Node's `SHASUMS256.txt`, the expected digest here did not
 * come from the same host as the bytes, so this one is a supply-chain check.
 */
export async function fetchPinned(
  host: Host,
  url: string,
  path: string,
  sha256: string,
): Promise<void> {
  // Keyed by digest: a pinned file's name does not always carry its version (uv's does not).
  if (!(await takePrefetched(host, sha256, path))) {
    await must(host, ["curl", ...NODE_CURL_FLAGS, "-o", path, url]);
  }
  const actual = await host.sha256File(path);
  if (actual !== sha256) {
    throw new AgentdError(
      "CHECKSUM_MISMATCH",
      `${url} does not match the digest hermetic pins for it`,
      {
        url,
        expected: sha256,
        actual,
      },
    );
  }
}

/** `/usr/local/lib/nodejs/node-v24.20.0-linux-arm64`. */
export function nodeDir(arch: "arm64" | "x64", version: string = NODE_VERSION): string {
  return `${NODE_INSTALL_ROOT}/node-v${version}-linux-${arch}`;
}

/**
 * The digest nodejs.org published for one release file. `SHASUMS256.txt` is
 * `<sha256>  <filename>` per line, one line per artifact in the release, so the
 * *name* is what selects the line — not its position, which changes release to
 * release.
 */
export function shasumFor(shasums: string, file: string): string | null {
  for (const line of shasums.split("\n")) {
    const [digest, ...rest] = line.trim().split(/\s+/);
    if (digest && rest.join(" ") === file) return digest;
  }
  return null;
}

const nodeFile = (version: string, arch: "arm64" | "x64"): string =>
  `node-v${version}-linux-${arch}.tar.xz`;
const nodeSumsName = (file: string): string => `${file}.SHASUMS256.txt`;

/**
 * Stat before exec: the real host's `exec` spawns the argv as given, and a path
 * that does not exist yet is a `posix_spawn` ENOENT thrown at us, not a non-zero
 * exit — which is exactly the state every first boot starts in.
 */
async function nodeInstalled(host: Host, nodeBin: string, version: string): Promise<boolean> {
  if ((await host.stat(nodeBin)) === null) return false;
  const reported = await host.exec([nodeBin, "--version"]);
  return reported.code === 0 && reported.stdout.trim() === `v${version}`;
}

/** The release tarball and its `SHASUMS256.txt`, at `tarball` and `sums`, verified. */
async function fetchNode(
  host: Host,
  version: string,
  file: string,
  tarball: string,
  sums: string,
): Promise<void> {
  const base = `https://nodejs.org/dist/v${version}`;
  const cached =
    (await takePrefetched(host, file, tarball)) &&
    (await takePrefetched(host, nodeSumsName(file), sums));
  if (!cached) {
    await must(host, ["curl", ...NODE_CURL_FLAGS, "-o", tarball, `${base}/${file}`]);
    await must(host, ["curl", ...NODE_CURL_FLAGS, "-o", sums, `${base}/SHASUMS256.txt`]);
  }
  const published = shasumFor((await host.readFile(sums)) ?? "", file);
  const actual = await host.sha256File(tarball);
  if (published === null || actual === null || published !== actual) {
    throw new AgentdError(
      "CHECKSUM_MISMATCH",
      `${base}/${file} does not match the digest nodejs.org published for it`,
      { file, expected: published, actual },
    );
  }
}

/**
 * Install the pinned Node under `/usr/local/lib/nodejs` and put it on PATH.
 *
 * Idempotent on the version the installed binary reports, not on the directory
 * existing: a half-unpacked tarball from a box that lost power mid-apply must
 * not read as "installed".
 *
 * The tarball is verified against the release's own `SHASUMS256.txt` before it
 * is unpacked. That is not a supply-chain proof — the sums come from the same
 * host as the bytes — but it is the check that catches the failure this
 * actually has: a truncated download over a flaky NAT gateway, unpacked into
 * `/usr/local` as root.
 */
export async function ensureNode(
  opts: ApplyOptions,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const { host } = opts;
  const arch = nodeArch();
  // From the checkout `ensureHermes` left, so an npm checkout keeps its Node.
  const version = (await pnpmCheckout(host)) ? PNPM_NODE_VERSION : NODE_VERSION;
  const dir = nodeDir(arch, version);
  const nodeBin = `${dir}/bin/node`;

  if (await nodeInstalled(host, nodeBin, version)) {
    emit(opEvent("packages", 0.35, `node ${version} already installed`, host.now()));
    if (!dry) await relinkNode(host, arch, version);
    return false;
  }

  emit(opEvent("packages", 0.35, `installing node ${version} (${arch})`, host.now()));
  // Recorded before the work, so a plan and the run it predicts name the same
  // paths — a dry run that reported fewer would be a plan nobody could check.
  result.installed.push(`node@${version}`);
  for (const tool of NODE_TOOLS) result.changed.push(`${NODE_LINK_DIR}/${tool}`);
  if (dry) return true;

  const file = nodeFile(version, arch);
  const tarball = `${NODE_INSTALL_ROOT}/${file}`;
  const sums = `${NODE_INSTALL_ROOT}/SHASUMS256.txt`;

  await host.mkdir(NODE_INSTALL_ROOT, "0755");
  try {
    await fetchNode(host, version, file, tarball, sums);

    // `--no-same-owner` because nodejs.org's tarball records its builder's
    // uid/gid (1001), and root's `tar` restores archived owners by default — so
    // without it Node's `bin/` and global `node_modules` belong to whichever
    // account the box later hands uid 1001, not to root.
    await must(host, [
      "timeout",
      NODE_UNPACK_TIMEOUT_S,
      "tar",
      "--no-same-owner",
      "-xJf",
      tarball,
      "-C",
      NODE_INSTALL_ROOT,
    ]);
  } finally {
    // Neither file is wanted after this point, and a half-written tarball left
    // behind is one the next apply would have to distrust all over again.
    await host.remove(tarball);
    await host.remove(sums);
  }

  await linkNode(host, dir);
  return true;
}

// `-n` so re-linking never nests a symlink inside the previous one's target,
// the same reason `ensureHermes` uses it for `hermes`.
async function linkNode(host: Host, dir: string): Promise<void> {
  for (const tool of NODE_TOOLS) {
    await must(host, ["ln", "-sfn", `${dir}/bin/${tool}`, `${NODE_LINK_DIR}/${tool}`]);
  }
}

/**
 * With both Nodes on the box, a swap between checkout layouts (or its
 * rollback) can leave the links on the other one: check them, relink when
 * wrong. A box with one Node runs no command here.
 */
async function relinkNode(host: Host, arch: "arm64" | "x64", version: string): Promise<void> {
  const other = version === NODE_VERSION ? PNPM_NODE_VERSION : NODE_VERSION;
  if ((await host.stat(`${nodeDir(arch, other)}/bin/node`)) === null) return;
  if (await nodeInstalled(host, `${NODE_LINK_DIR}/node`, version)) return;
  await linkNode(host, nodeDir(arch, version));
}

/** A rollback's relink, with no download: the Node the restored checkout's layout uses, when installed. */
export async function relinkNodeForCheckout(host: Host): Promise<void> {
  const arch = nodeArch();
  const version = (await pnpmCheckout(host)) ? PNPM_NODE_VERSION : NODE_VERSION;
  if (await nodeInstalled(host, `${nodeDir(arch, version)}/bin/node`, version)) {
    await relinkNode(host, arch, version);
  }
}

/**
 * Build Hermes' two Node workspaces from the checkout `ensureHermes` just left.
 *
 * `hermes serve` is the *headless* backend — it 404s the browser with a message
 * saying so. The browser UI is `hermes dashboard`, which serves the Vite bundle
 * at `hermes_cli/web_dist`; its Chat tab then spawns the Ink TUI, which without
 * a prebuilt `ui-tui/dist/entry.js` npm-installs at first use as the `hermes`
 * user into a root-owned tree and EACCESes (`Dockerfile:374-390`). Neither is
 * shipped built. So three npm commands as root produce both, and the rendered
 * units run `--skip-build` with `HERMES_WEB_DIST` and `HERMES_TUI_DIR` pointing
 * at the results — the service user never needs npm, a network, or write access
 * to the checkout.
 *
 * `CI=1` keeps npm's progress bars and update notices out of the journal, and
 * an explicit PATH puts our own Node in front of apt's v18.
 *
 * The install is retried, and told to retry inside itself, because
 * registry.npmjs.org is one more network dependency a first boot has no control
 * over — and unlike the Node tarball there is no digest to make a partial
 * download loud.
 */
export async function ensureWebUi(
  manifest: AgentConfig,
  opts: ApplyOptions,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const { host } = opts;
  // A swapfile a killed hermeticd left behind goes on the next apply, whether
  // or not that apply builds anything (a rollback restores a built checkout).
  if (!dry) await removeBuildSwap(host, emit);
  // Only a real run can look: a dry run's plan predates the checkout.
  const pnpm = !dry && (await pnpmCheckout(host));
  const want = pnpm
    ? `${manifest.hermes_ref} node-v${PNPM_NODE_VERSION} pnpm-${PNPM_VERSION}`
    : `${manifest.hermes_ref} node-v${NODE_VERSION}`;

  // A ref whose checkout has no `web/` at all — an older Hermes, or a fork that
  // never carried the Vite app. There is nothing here to build, and pretending
  // otherwise costs the box its boot: `npm ci` in a directory that does not
  // exist fails the same way three times over and parks apply in `error`. No
  // marker either, because a later ref that *does* ship `web/` must build.
  //
  // Only on a real run: a dry run is a plan made *before* `ensureHermes` has
  // cloned anything, so an absent `web/` there says nothing about the ref.
  if (!dry && (await host.stat(HERMES_WEB_DIR)) === null) {
    emit(opEvent("packages", 0.45, "no web/ in this hermes ref; nothing to build", host.now()));
    return false;
  }

  // `ui-tui/` is named only when the checkout carries it: naming a workspace
  // npm cannot find fails the whole install, and upstream's own installer
  // guards the same way (`scripts/install.sh:2660-2670`).
  const haveTui = !dry && (await host.stat(HERMES_TUI_DIR)) !== null;

  // Three questions, because all three answers have to hold for the build to be
  // skippable: the marker says this ref and this Node, Vite's bundle is where
  // the unit's `HERMES_WEB_DIST` points, and — when the ref ships one — the
  // TUI's prebuilt entry is where `HERMES_TUI_DIR` points. The marker alone
  // would let a half-built checkout claim it was done.
  const built = (await host.readFile(HERMES_WEB_MARKER))?.trim() ?? null;
  const haveWebDist = (await host.stat(HERMES_WEB_DIST_INDEX)) !== null;
  const haveTuiEntry = !haveTui || (await host.stat(HERMES_TUI_ENTRY)) !== null;
  if (built === want && haveWebDist && haveTuiEntry) {
    emit(opEvent("packages", 0.45, "the hermes web ui and tui are already built", host.now()));
    return false;
  }

  emit(
    opEvent(
      "packages",
      0.4,
      `installing the hermes node workspaces (${pnpm ? "pnpm" : "npm ci"})`,
      host.now(),
    ),
  );
  if (dry) {
    result.changed.push(HERMES_WEB_MARKER);
    return true;
  }

  /**
   * From the checkout root, which is where upstream installs from
   * (`hermes_cli/main_web_build.py:432-459`, `scripts/install.sh:2688-2702`)
   * and the only cwd from which the root `.npmrc` is npm's local prefix. That
   * file carries `engine-strict=true`, `min-release-age=14` and the
   * `min-release-age-exclude` list, none of which applied while hermetic
   * installed from `web/` — so a Node/npm pair upstream rejects now fails
   * loudly here instead of resolving a tree upstream never tested. `ensureNode`
   * pins 24.20.0, which satisfies the floors `install.sh:941-946` states.
   */
  const npm: ExecOptions = {
    cwd: HERMES_INSTALL_DIR,
    env: {
      PATH: `${NODE_LINK_DIR}:/usr/bin:/bin`,
      CI: "1",
      // npm's own retry loop, which recovers from a flaky registry inside a
      // single attempt and so costs nothing when the network is fine. The
      // maxtimeout is capped so a retry cannot outlive `NPM_TIMEOUT_S`.
      npm_config_fetch_retries: "5",
      npm_config_fetch_retry_maxtimeout: "60000",
    },
  };

  // npm's flat `node_modules` is not a tree pnpm will adopt (it asks before
  // removing one, and a box has no one to answer), and the reverse leaves pnpm's
  // symlinked store under npm. The marker says which manager built last.
  if (built !== null && built.includes(" pnpm-") !== pnpm) {
    for (const dir of [HERMES_INSTALL_DIR, HERMES_WEB_DIR, HERMES_TUI_DIR]) {
      await must(host, ["rm", "-rf", "--", `${dir}/node_modules`]);
    }
  }

  const workspaces = ["--workspace", "web", ...(haveTui ? ["--workspace", "ui-tui"] : [])];
  if (pnpm) {
    await ensurePnpm(host, result, emit);
    // Upstream's own dependency step (`Dockerfile:330`): it checks the pnpm
    // pin against the checkout's `pm/lock.json` and installs the lockfile frozen.
    await retry(host, NPM_INSTALL_ATTEMPTS, NPM_RETRY_MS, () =>
      must(
        host,
        [
          "timeout",
          NPM_TIMEOUT_S,
          "node",
          "scripts/build/node-deps.mjs",
          "--source",
          HERMES_INSTALL_DIR,
          ...workspaces,
        ],
        npm,
      ),
    );
    emit(opEvent("packages", 0.45, "building the hermes web ui (pnpm)", host.now()));
    await withBuildSwap(host, emit, () =>
      must(host, ["timeout", NPM_TIMEOUT_S, "pnpm", "--filter", "web", "run", "build"], {
        ...npm,
        env: { ...npm.env, NODE_OPTIONS: WEB_BUILD_NODE_OPTIONS },
      }),
    );
    if (haveTui) {
      emit(opEvent("packages", 0.48, "building the hermes tui (pnpm)", host.now()));
      await must(
        host,
        ["timeout", NPM_TIMEOUT_S, "pnpm", "--filter", "hermes-tui", "run", "build"],
        npm,
      );
    }
    await host.writeFile(HERMES_WEB_MARKER, want + "\n", "0644");
    result.changed.push(HERMES_WEB_MARKER);
    return true;
  }

  if ((await host.stat(HERMES_ROOT_LOCKFILE)) === null) {
    throw new AgentdError(
      "UNSUPPORTED",
      `no ${HERMES_ROOT_LOCKFILE}: this Hermes checkout is not the npm workspace layout ` +
        `hermetic installs from, and \`npm install\` would write a lockfile into a tree ` +
        `hermetic does not own`,
      { install_dir: HERMES_INSTALL_DIR },
    );
  }

  // One install for both workspaces plus the root's own devDependencies (the
  // shared ESLint flat config each workspace imports). It must be one command:
  // `npm ci` wipes `node_modules` before reifying the tree it was asked for, so
  // a second, narrower install would prune what the first one just put there
  // (`hermes_cli/main_web_build.py:447-455`).
  /**
   * One install argv, built twice: once for `ci` and once for the fallback.
   *
   * `--include=dev` is forced, exactly as upstream forces it
   * (`hermes_cli/main_web_build.py:319-322,335`): an inherited `NODE_ENV=production`
   * — or an `omit=dev` from anywhere npm reads config — silently skips the build
   * toolchain, and `npm run build` then dies with `tsc: not found`. That is not
   * hypothetical here: `host.exec` merges `process.env` into the environment it
   * gives a child, so whatever cloud-init and systemd left in hermeticd's own
   * environment reaches npm. The flag makes the install say what it needs
   * instead of inheriting an answer.
   */
  const npmInstallArgv = (verb: readonly string[]): string[] => [
    "timeout",
    NPM_TIMEOUT_S,
    "npm",
    ...verb,
    ...workspaces,
    "--include-workspace-root",
    "--include=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];

  try {
    await retry(host, NPM_INSTALL_ATTEMPTS, NPM_RETRY_MS, () =>
      must(host, npmInstallArgv(["ci"]), npm),
    );
  } catch {
    /**
     * `npm ci` refuses outright when `package-lock.json` and `package.json`
     * disagree, and a ref whose lockfile drifted is a ref that would never
     * build — so upstream falls back to `npm install --no-save`
     * (`_run_npm_install_deterministic`, `hermes_cli/main_web_build.py:313-345`)
     * and hermetic follows it, for the same reason: a box that will not build a
     * UI over a lockfile it cannot fix is a box that does not come up.
     *
     * `--no-save` is what makes the fallback safe in the layout hermetic
     * installs. It writes no lockfile at all, so the `web/package-lock.json`
     * that would flip upstream's `_workspace_root` verdict
     * (`hermes_cli/main_tui_launch.py:89-98`) is never created, and the
     * committed root lockfile is not rewritten either — the concern that makes
     * a *missing* root lockfile a refusal above simply does not arise here.
     *
     * Once, not three times. The retry loop above has already spent its
     * attempts on the failure waiting helps with — a flaky registry — and an
     * out-of-sync lockfile does not get better by being asked again.
     */
    emit(
      opEvent(
        "packages",
        0.42,
        "npm ci did not succeed; falling back to npm install --no-save, as upstream does",
        host.now(),
        "warn",
      ),
    );
    await must(host, npmInstallArgv(["install", "--no-save"]), npm);
  }
  emit(opEvent("packages", 0.45, "building the hermes web ui (npm run build)", host.now()));
  // Not retried: a build that failed is a build that will fail again, and the
  // attempt costs minutes rather than seconds.
  await must(host, ["timeout", NPM_TIMEOUT_S, "npm", "run", "build", "--workspace", "web"], npm);
  if (haveTui) {
    emit(opEvent("packages", 0.48, "building the hermes tui (npm run build)", host.now()));
    await must(host, ["timeout", NPM_TIMEOUT_S, "npm", "run", "build", "--workspace", "ui-tui"], npm);
  }

  // Written last: a marker from a run whose build failed would tell the next
  // apply there is a `dist` to serve when there is not.
  await host.writeFile(HERMES_WEB_MARKER, want + "\n", "0644");
  result.changed.push(HERMES_WEB_MARKER);
  return true;
}

/** The swap areas `/proc/swaps` lists: the first field of each line after the header. */
async function activeSwaps(host: Host): Promise<string[]> {
  const lines = ((await host.readFile("/proc/swaps")) ?? "").split("\n").slice(1);
  return lines.map((l) => l.trim().split(/\s+/)[0] ?? "").filter((name) => name !== "");
}

/**
 * Run `build` with `BUILD_SWAP` enabled when the box is small and has no swap,
 * and remove it after, whatever the build did, so a rollback starts without
 * it. Best effort both ways: a swap that cannot be added or removed is a
 * warning, never the apply's failure.
 */
async function withBuildSwap<T>(host: Host, emit: Emit, build: () => Promise<T>): Promise<T> {
  const mem = await host.memory();
  if (mem === null || mem.total >= BUILD_SWAP_BELOW_BYTES || (await activeSwaps(host)).length > 0) {
    return build();
  }
  const warn = (message: string): void => emit(opEvent("packages", 0.45, message, host.now(), "warn"));
  const fs = await host.filesystem(DATA_MOUNT);
  if (fs === null) {
    warn("could not measure free space on the data volume for temporary swap; building without it");
    return build();
  }
  if (fs.mount !== DATA_MOUNT) {
    warn(
      `${DATA_MOUNT} is not mounted, and temporary swap would land on the unencrypted root disk; building without it`,
    );
    return build();
  }
  if (fs.available < BUILD_SWAP_MIN_FREE_BYTES) {
    warn("too little free space on the data volume for temporary swap; building without it");
    return build();
  }
  emit(
    opEvent("packages", 0.45, "adding 1 GiB of temporary swap for the hermes web build", host.now()),
  );
  try {
    const found = await host.lstat(BUILD_SWAP_DIR);
    if (found !== null && (found.isSymlink || !found.isDirectory)) {
      throw new Error(`${BUILD_SWAP_DIR} is not a directory`);
    }
    await host.mkdir(BUILD_SWAP_DIR, "0700");
    await host.chown(BUILD_SWAP_DIR, 0, 0);
    await host.chmod(BUILD_SWAP_DIR, "0700");
    await must(host, ["fallocate", "-l", "1G", BUILD_SWAP]);
    await must(host, ["chmod", "600", BUILD_SWAP]);
    await must(host, ["mkswap", BUILD_SWAP]);
    await must(host, ["swapon", BUILD_SWAP]);
  } catch (e) {
    warn(`could not add temporary swap (${errorMessage(e)}); building without it`);
  }
  try {
    return await build();
  } finally {
    await removeBuildSwap(host, emit);
  }
}

/**
 * Disable and delete `BUILD_SWAP` if it is there. The file is deleted only
 * once `swapoff` succeeded: an active swapfile unlinked stays in use under a
 * name `/proc/swaps` no longer matches, and would never be cleaned up. A
 * `swapoff` that fails (its pages cannot all come back) leaves both for the
 * next apply; nothing re-enables the file at boot.
 */
export async function removeBuildSwap(host: Host, emit: Emit): Promise<void> {
  const active = (await activeSwaps(host)).includes(BUILD_SWAP);
  if (!active && (await host.stat(BUILD_SWAP)) === null) return;
  try {
    if (active) await must(host, ["timeout", SWAPOFF_TIMEOUT_S, "swapoff", BUILD_SWAP]);
    await host.remove(BUILD_SWAP);
    emit(opEvent("packages", 0.45, "removed the temporary swap", host.now()));
  } catch (e) {
    emit(
      opEvent(
        "packages",
        0.45,
        `could not remove the temporary swap at ${BUILD_SWAP} (${errorMessage(e)}); the next apply retries`,
        host.now(),
        "warn",
      ),
    );
  }
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Install the pinned pnpm and link it onto PATH. Idempotent on the version the
 * installed executable reports, as `ensureNode` is. The `@pnpm/exe` tarball
 * holds `package/pnpm` beside its `package.json`, which is where `node-deps.mjs`
 * reads the version from (through the symlink), so both are kept together.
 */
async function ensurePnpm(host: Host, result: ApplyResult, emit: Emit): Promise<void> {
  const arch = nodeArch();
  const dir = pnpmDir(arch);
  const bin = `${dir}/pnpm`;
  if (await pnpmInstalled(host, bin)) return;

  emit(opEvent("packages", 0.4, `installing pnpm ${PNPM_VERSION} (${arch})`, host.now()));
  const { url, sha256 } = pnpmRelease(arch);
  const tarball = `${PNPM_INSTALL_ROOT}/pnpm-${PNPM_VERSION}-linux-${arch}.tgz`;
  await host.mkdir(PNPM_INSTALL_ROOT, "0755");
  await host.mkdir(dir, "0755");
  try {
    await fetchPinned(host, url, tarball, sha256);
    await must(host, [
      "timeout",
      NODE_UNPACK_TIMEOUT_S,
      "tar",
      "--no-same-owner",
      "-xzf",
      tarball,
      "-C",
      dir,
      "--strip-components=1",
    ]);
  } finally {
    await host.remove(tarball);
  }
  await must(host, ["ln", "-sfn", bin, `${NODE_LINK_DIR}/pnpm`]);
  result.installed.push(`pnpm@${PNPM_VERSION}`);
  result.changed.push(`${NODE_LINK_DIR}/pnpm`);
}

async function pnpmInstalled(host: Host, bin: string): Promise<boolean> {
  const reported = (await host.stat(bin)) !== null ? await host.exec([bin, "--version"]) : null;
  return reported?.code === 0 && reported.stdout.trim() === PNPM_VERSION;
}

const pnpmDir = (arch: "arm64" | "x64"): string =>
  `${PNPM_INSTALL_ROOT}/pnpm-${PNPM_VERSION}-linux-${arch}`;

/**
 * Download and verify, into `PREFETCH_DIR`, the Node and pnpm a checkout of
 * this layout will install, skipping what is already installed. Installs and
 * relinks nothing: the running Hermes and an old-pin reapply keep their tools.
 */
export async function prefetchNodeTools(host: Host, pnpm: boolean): Promise<void> {
  const arch = nodeArch();
  const version = pnpm ? PNPM_NODE_VERSION : NODE_VERSION;
  if (!(await nodeInstalled(host, `${nodeDir(arch, version)}/bin/node`, version))) {
    const file = nodeFile(version, arch);
    await fetchNode(host, version, file, prefetched(file), prefetched(nodeSumsName(file)));
  }
  if (pnpm && !(await pnpmInstalled(host, `${pnpmDir(arch)}/pnpm`))) {
    const { url, sha256 } = pnpmRelease(arch);
    await fetchPinned(host, url, prefetched(sha256), sha256);
  }
}
