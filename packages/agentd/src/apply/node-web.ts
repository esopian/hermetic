/**
 * Hermes' browser UI, which is not even a Python artifact: a Vite bundle and an
 * Ink TUI built here from the checkout, with a Node that apt cannot supply
 * (§6.4).
 */
import type { AgentConfig } from "@hermetic/core/schema";
import { HERMES_INSTALL_DIR, HERMES_TUI_DIR, HERMES_WEB_DIST_DIR } from "@hermetic/core/shared";
import type { ExecOptions } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
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
 * so a new Hermes ref *or* a new Node re-runs the build, and nothing else does.
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
 * The Node that builds it. Ubuntu's `nodejs` is 18 and its `npm` is not even
 * installed, while `web/package.json` pins vite 8, whose `engines` demands
 * `^22.22.0 || ^24.11.0 || >=26.0.0` — so apt cannot supply this at any
 * version, and the official tarball is the only source that can. 24 is the
 * current LTS line; upstream's own Dockerfile is on 26, which we do not follow
 * because a fleet is not the place to run a Node that is still Current.
 */
export const NODE_VERSION = "24.20.0";
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
const NPM_TIMEOUT_S = "900";
/**
 * How many times the dependency install is attempted, and how long it waits in
 * between. Short: npm has already spent its own `fetch-retries` inside each
 * attempt, so what this covers is the coarser failure — a NAT gateway that went
 * away for a few seconds, or a registry that 503'd the whole request.
 */
const NPM_INSTALL_ATTEMPTS = 3;
const NPM_RETRY_MS = 5_000;
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
  const dir = nodeDir(arch);
  const nodeBin = `${dir}/bin/node`;

  // Stat before exec: the real host's `exec` spawns the argv as given, and a
  // path that does not exist yet is a `posix_spawn` ENOENT thrown at us, not a
  // non-zero exit — which is exactly the state every first boot starts in.
  const present = (await host.stat(nodeBin)) !== null;
  const reported = present ? await host.exec([nodeBin, "--version"]) : null;
  if (reported !== null && reported.code === 0 && reported.stdout.trim() === `v${NODE_VERSION}`) {
    emit(opEvent("packages", 0.35, `node ${NODE_VERSION} already installed`, host.now()));
    return false;
  }

  emit(opEvent("packages", 0.35, `installing node ${NODE_VERSION} (${arch})`, host.now()));
  // Recorded before the work, so a plan and the run it predicts name the same
  // paths — a dry run that reported fewer would be a plan nobody could check.
  result.installed.push(`node@${NODE_VERSION}`);
  for (const tool of NODE_TOOLS) result.changed.push(`${NODE_LINK_DIR}/${tool}`);
  if (dry) return true;

  const file = `node-v${NODE_VERSION}-linux-${arch}.tar.xz`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const tarball = `${NODE_INSTALL_ROOT}/${file}`;
  const sums = `${NODE_INSTALL_ROOT}/SHASUMS256.txt`;

  await host.mkdir(NODE_INSTALL_ROOT, "0755");
  try {
    await must(host, ["curl", ...NODE_CURL_FLAGS, "-o", tarball, `${base}/${file}`]);
    await must(host, ["curl", ...NODE_CURL_FLAGS, "-o", sums, `${base}/SHASUMS256.txt`]);

    const published = shasumFor((await host.readFile(sums)) ?? "", file);
    const actual = await host.sha256File(tarball);
    if (published === null || actual === null || published !== actual) {
      throw new AgentdError(
        "CHECKSUM_MISMATCH",
        `${base}/${file} does not match the digest nodejs.org published for it`,
        { file, expected: published, actual },
      );
    }

    await must(host, [
      "timeout",
      NODE_UNPACK_TIMEOUT_S,
      "tar",
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

  // `-n` so re-linking never nests a symlink inside the previous one's target,
  // the same reason `ensureHermes` uses it for `hermes`.
  for (const tool of NODE_TOOLS) {
    await must(host, ["ln", "-sfn", `${dir}/bin/${tool}`, `${NODE_LINK_DIR}/${tool}`]);
  }

  return true;
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
  const want = `${manifest.hermes_ref} node-v${NODE_VERSION}`;

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

  emit(opEvent("packages", 0.4, "installing the hermes node workspaces (npm ci)", host.now()));
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
  const workspaces = ["--workspace", "web", ...(haveTui ? ["--workspace", "ui-tui"] : [])];
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
