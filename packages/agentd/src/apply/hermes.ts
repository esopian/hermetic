/**
 * Hermes itself, which is not an apt package: a git checkout of the manifest's
 * ref under `/usr/local/lib`, installed editable into a venv by `uv` (§6.4),
 * plus the revision file the rendered units read and the git safe-directory
 * entry the checkout needs.
 */
import { type AgentConfig, type Provider, compareVersions } from "@hermetic/core/schema";
import {
  HERMES_BIN,
  HERMES_CLI_ENV,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  HERMES_INSTALL_DIR,
  HERMES_LEGACY_DASHBOARD_UNIT,
  HERMES_MANAGED_DIR,
  HERMES_REVISION_ENV,
  hermesTagVersion,
} from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { readApplyPending, writeApplyPending } from "../apply-pending.ts";
import {
  HERMES_REF_MARKER,
  fetchHermesBundle,
  formatRefMarker,
  parseRefMarker,
} from "../hermes-source.ts";
import { guardFirstStart, recordHomeRef } from "./hermes-home-record.ts";
import { HERMETIC_RENDERED_MARKER } from "./accounts.ts";
import { unfinishedRestores } from "./hermes-backup.ts";
import {
  HERMES_HOLD_PATH,
  type HermesInstalled,
  type SwapSteps,
  browserSession,
  readSwapGate,
  refuseStrandedRestore,
  releaseHold,
  rollBack,
  settleSwap,
  startOwedBrowsers,
  swapHermes,
  verifySwap,
} from "./hermes-upgrade.ts";
import { type Prefetched, prefetchHermes } from "./hermes-prefetch.ts";
import { APPLIED_CONFIG_PATH, MANIFEST_PATH, parseManifestJson } from "../manifest.ts";
import { copyVenvAside, restorePrevious, setAsidePrevious } from "./hermes-previous.ts";
import {
  NPM_INSTALL_ATTEMPTS,
  NPM_RETRY_MS,
  NPM_TIMEOUT_S,
  fetchPinned,
  nodeArch,
  relinkNodeForCheckout,
  removeBuildSwap,
} from "./node-web.ts";
import type { ApplyOptions, ApplyResult } from "./shared.ts";
import { UNIT_DIR, retry } from "./shared.ts";

/**
 * Where Hermes lives. Upstream's `install.sh` has an FHS branch it takes when it
 * runs as root, and this is that layout: the checkout under `/usr/local/lib`,
 * one symlink on `PATH`, uv's managed interpreters somewhere system-wide rather
 * than in root's home. hermeticd mirrors those steps itself instead of piping
 * the installer into a shell — see `ensureHermes`.
 *
 * The paths themselves live in `@hermetic/core/schema`, because the laptop
 * renders units that name them (`HERMES_WEB_DIST`, `HERMES_TUI_DIR`, the
 * `ExecStart`) and two spellings of the same directory is precisely the drift
 * the seam tests exist to catch. They are re-exported here so the box-side
 * modules that already import them from `apply.ts` keep one import site.
 */
export { HERMES_BIN, HERMES_INSTALL_DIR };
/**
 * The fallback remote, and the only github.com address a box ever contacts. Not
 * in core's schema because core's `hermes-mirror.ts` owns the laptop-side URL;
 * `tests/seams.test.ts` asserts the two agree.
 */
export const HERMES_REPO = "https://github.com/NousResearch/hermes-agent.git";
/**
 * The interpreter the checkout pins. Read from the checkout rather than fixed
 * here, because one hermeticd serves boxes on either side of upstream's move
 * from 3.11 to 3.14 (v0.21.6), and the venv has to match the tree it runs.
 */
const HERMES_PYTHON_PIN = `${HERMES_INSTALL_DIR}/.python-version`;
/** What a checkout with no `.python-version` gets: the floor of v0.21's `requires-python`. */
const LEGACY_PYTHON = "3.11";
/**
 * Upstream's install stamp, beside the code (`pm/paths.py:install_stamp_path`).
 * From v0.23 the version a checkout reports comes from it first and from git
 * second, and git cannot answer on a box: a bundle fetched into an existing
 * checkout brings no tag, so `hermes --version` says `git.<sha>`. With no stamp
 * a launch also adopts the checkout and syncs an environment of its own
 * (`hermes_cli/post_update.py`). Gitignored upstream, so a checkout never moves it.
 */
export const HERMES_INSTALL_STAMP = `${HERMES_INSTALL_DIR}/install-stamp.json`;
/** The module that reads the stamp; a checkout without it reports `pyproject.toml`'s version. */
const HERMES_STAMP_READER = `${HERMES_INSTALL_DIR}/hermes_cli/version_info.py`;
/** The venv the editable install goes into, and the `hermes` it produces. */
export const HERMES_VENV_DIR = `${HERMES_INSTALL_DIR}/venv`;
/**
 * The editable-install spec — extras included — that the venv was last built
 * with. The ref marker alone cannot answer "is the dependency set right": a
 * provider switch, or a hermeticd that installs an extra the previous one did
 * not, leaves the ref and the version exactly where they were while the venv
 * is missing a package. A box whose spec differs takes the full install path
 * again; on an unchanged ref the fetch and checkout are no-ops and the
 * `uv pip install` adds what is missing.
 */
const HERMES_EXTRAS_MARKER = `${HERMES_INSTALL_DIR}/.hermetic-extras`;
/**
 * Which Hermes units `ensureHermes` stops before it begins rewriting the venv
 * is recorded as a *restart obligation* (`apply-pending.ts`), written before
 * the first `systemctl stop` and discharged only once the units phase has
 * started them again.
 *
 * It has to survive the process because the stop and the restart are separated
 * by most of an apply. Anything that throws in between — Node, the npm
 * workspaces, an unsupported checkout, the gateway installer, a rendered file, a
 * secret that would not resolve — leaves both units down, and the *next* apply
 * finds the ref marker and the version already matching, concludes Hermes did
 * not change, and restarts nothing. The box then sits with no dashboard and no
 * gateway until an operator notices.
 *
 * The restart is deliberately *not* a `finally` around the stop. A failure
 * between the two is most likely a failure of the swap itself, and starting
 * Hermes back up on a half-installed venv is worse than leaving it down: the
 * record makes the next apply repair it, once whatever failed has been fixed.
 */
/**
 * The same treatment for the Hermes checkout, and for the same reason one level
 * up: github.com is a third party whose availability a first boot does not
 * control. On 2026-09-08 it answered `429 ... gitmon refuses to schedule us`
 * to an unauthenticated clone *and* to an authenticated `gh api` call, which is
 * a capacity refusal no credential gets past — and one of them killed the whole
 * apply, because nothing here retried. git has no equivalent of npm's own
 * `fetch-retries`, so this wrapper is the only retry the clone gets.
 */
export const GIT_CLONE_ATTEMPTS = 3;
export const GIT_RETRY_MS = 5_000;
/**
 * One fetch attempt from github.com, bounded like curl's downloads
 * (`--max-time 300`, `node-web.ts`): the fetch into an existing checkout is a
 * version swap, run with the Hermes units held.
 */
export const GIT_FETCH_TIMEOUT_S = "300";

/**
 * A network step that can run while the Hermes units are held: bounded by
 * `timeout(1)` and retried the way the npm steps are (`node-web.ts`), so a
 * stalled mirror fails the apply, and a swap rolls back, rather than hanging
 * with Hermes down and nothing reported.
 */
async function boundedStep(
  host: Host,
  argv: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> },
): Promise<void> {
  await retry(host, NPM_INSTALL_ATTEMPTS, NPM_RETRY_MS, () =>
    must(host, ["timeout", NPM_TIMEOUT_S, ...argv], opts),
  );
}

/**
 * uv puts its managed interpreters in the *user's* home by default, which for a
 * unit running as root is `/root` — a directory no other account can execute
 * out of. Upstream's FHS branch redirects both, so the venv Hermes runs from
 * does not depend on root's dotfiles surviving.
 */
export const UV_ENV = {
  UV_PYTHON_INSTALL_DIR: "/usr/local/share/uv/python",
  UV_PYTHON_BIN_DIR: "/usr/local/share/uv/bin",
} as const;

/** A clone that would otherwise block forever asking an unattended box to log in. */
export const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" } as const;

/** A 40-hex sha1 or a 64-hex sha256 object id, as `rev-parse` prints it. */
export const COMMIT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The one remote script hermeticd will pipe into a shell. It is astral's own uv
 * installer, which is what upstream's `install.sh` shells out to as well; the
 * alternative is no uv at all, since uv is not in Ubuntu's archive and the
 * editable install has no pip-only equivalent. `UV_INSTALL_DIR` keeps it out of
 * `~/.local/bin` and `INSTALLER_NO_MODIFY_PATH` keeps it out of root's rc files
 * — the two things the upstream installer does that we do not want.
 */
/**
 * How a v0.21 checkout gets uv, unchanged: a new hermeticd reaches those boxes
 * before their Hermes moves, and their toolchain must not move with it.
 *
 * The one remote script hermeticd will pipe into a shell. It is astral's own uv
 * installer, which is what upstream's `install.sh` shells out to as well; the
 * alternative is no uv at all, since uv is not in Ubuntu's archive and the
 * editable install has no pip-only equivalent. `UV_INSTALL_DIR` keeps it out of
 * `~/.local/bin` and `INSTALLER_NO_MODIFY_PATH` keeps it out of root's rc files
 * — the two things the upstream installer does that we do not want.
 */
const UV_INSTALL_SCRIPT =
  "curl -LsSf https://astral.sh/uv/install.sh | " +
  "env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh";

/**
 * uv as upstream pins it (`pm/lock.json` at v0.23.1), for a 3.14 checkout only.
 * Pinned rather than whatever astral's installer served on the day a box was
 * born: `uv sync --frozen` has to read the checkout's `uv.lock`, and a
 * September uv may not. The release tarball is verified against the digest
 * upstream pinned.
 */
export const UV_VERSION = "0.13.5";
const UV_RELEASES: Readonly<Record<"arm64" | "x64", { triple: string; sha256: string }>> = {
  arm64: {
    triple: "aarch64-unknown-linux-gnu",
    sha256: "4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403",
  },
  x64: {
    triple: "x86_64-unknown-linux-gnu",
    sha256: "f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f",
  },
};
const UV_INSTALL_ROOT = "/usr/local/lib/uv";

/** The uv release file for one arch, the digest pinned for it, and the directory it unpacks to. */
export function uvRelease(arch: "arm64" | "x64"): { url: string; sha256: string; dir: string } {
  const { triple, sha256 } = UV_RELEASES[arch];
  return {
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz`,
    sha256,
    dir: `${UV_INSTALL_ROOT}/uv-${triple}`,
  };
}

/**
 * Extras every box installs, whatever its provider.
 *
 * `messaging` is the gateway's platform adapters — Slack, Telegram, Discord —
 * which upstream's `all` deliberately leaves out. On-demand installs could
 * fetch them (`HERMES_LAZY_INSTALL_TARGET`, `render-units.ts`), but a
 * messaging platform is the one feature that has to be there *before* the
 * gateway starts: installed at build time, a token saved on the dashboard's
 * Channels page connects on the next restart, with nothing fetched from PyPI
 * at the moment an operator is waiting on it.
 */
export const BASE_EXTRAS: readonly string[] = ["all", "messaging"];

/**
 * Which upstream extra carries a provider's SDK. `all` pulls in `web`, which
 * `hermes serve` needs, but deliberately does *not* pull in provider extras.
 * The OpenAI-compatible providers need none: Hermes reaches them over the
 * base URL the rendered config names, with no extra dependency.
 */
export const PROVIDER_EXTRAS: Readonly<Record<Provider, string | null>> = {
  bedrock: "bedrock",
  anthropic: "anthropic",
  openrouter: null,
  nous: null,
  // Hermes's `openai-api` provider is part of the base install, like
  // `openrouter`; the Vercel gateway is OpenAI-compatible and reached over the
  // base URL the rendered config names. Neither needs an extra.
  openai: null,
  vercel: null,
};

function extrasFor(provider: Provider): string[] {
  const extra = PROVIDER_EXTRAS[provider];
  return extra === null ? [...BASE_EXTRAS] : [...BASE_EXTRAS, extra];
}

/** `-e "/usr/local/lib/hermes-agent[all,messaging,bedrock]"` — pip's extras syntax for a path. */
export function editableSpec(provider: Provider): string {
  return `${HERMES_INSTALL_DIR}[${extrasFor(provider).join(",")}]`;
}

/**
 * Extras a 3.14 checkout installs up front because v0.21 fetched them on first
 * use and v0.23 cannot: with `HERMES_DISABLE_LAZY_INSTALLS` every on-demand
 * install is refused (B9), so an upgraded box would lose them. Web search
 * backends, the default TTS, voice-note STT, Mistral and FAL. Each is in
 * v0.23.1's `uv.lock` with linux-aarch64 cp314 or pure wheels.
 */
const LOCKED_EXTRAS: readonly string[] = [
  "exa",
  "firecrawl",
  "parallel-web",
  "ddgs",
  "edge-tts",
  "voice",
  "mistral",
  "fal",
];

/**
 * The locked install a 3.14 checkout takes, run from the checkout. `--inexact`
 * keeps what `ensureMemoryDeps` added to the venv; never `--no-editable`, which
 * upstream's `setup.py` refuses.
 */
function syncArgv(provider: Provider): string[] {
  const extra = PROVIDER_EXTRAS[provider];
  const extras = [...BASE_EXTRAS, ...LOCKED_EXTRAS, ...(extra === null ? [] : [extra])];
  return [
    "uv",
    "sync",
    "--frozen",
    "--inexact",
    "--compile-bytecode",
    ...extras.flatMap((name) => ["--extra", name]),
  ];
}

/**
 * From 3.14 (v0.21.6 on) every core dependency is behind a `python_version`
 * marker and the graph needs the lock's `override-dependencies`, which only
 * `uv sync` honours; an editable `uv pip install` of it installs no core
 * dependency at all.
 */
export function syncsLocked(python: string): boolean {
  const [major = 0, minor = 0] = python.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 14);
}

/**
 * Whether `pyvenv.cfg` names the pinned interpreter, at the precision the pin
 * names: `version_info` (uv, virtualenv), else `version` (the stdlib `venv`).
 * A cfg naming neither cannot say, and a working venv is not wiped on a guess;
 * no cfg at all is no venv.
 */
export function venvMatches(cfg: string | null, python: string): boolean {
  if (cfg === null) return false;
  const have = /^version_info\s*=\s*(\S+)/m.exec(cfg)?.[1] ?? /^version\s*=\s*(\S+)/m.exec(cfg)?.[1];
  return have === undefined || have === python || have.startsWith(`${python}.`);
}

export async function checkoutPython(host: Host): Promise<string> {
  return pythonPin(await host.readFile(HERMES_PYTHON_PIN));
}

/** The interpreter a `.python-version` names; no file is the legacy floor. */
export function pythonPin(text: string | null): string {
  return text?.trim().split("\n")[0]?.trim() || LEGACY_PYTHON;
}

/** What the extras marker records: the install that was run, so a different one re-runs it. */
function installSpec(provider: Provider, python: string): string {
  return syncsLocked(python) ? syncArgv(provider).join(" ") : editableSpec(provider);
}

/**
 * The stamp upstream's own lanes write (`scripts/write_install_stamp.py`),
 * deterministic so an apply can compare it byte for byte. `external`, because
 * hermeticd, not Hermes, decides which version this box runs.
 */
export function installStamp(commit: string, version: string): string {
  const stamp = {
    schemaVersion: 2,
    commit,
    source: "git",
    updateMechanism: "external",
    baseVersion: version,
    displayVersion: version,
    distance: 0,
    dirty: false,
    distribution: null,
    payload: "bootstrap",
    tag: null,
    branch: null,
  };
  return JSON.stringify(stamp, null, 2) + "\n";
}

/**
 * The stamp this checkout should carry, or `null` for one that reads none.
 * Upstream ignores a stamp whose `commit` is not `HEAD`, so a stale one fails
 * safe; comparing the whole text catches that and a version change alike.
 */
async function wantedStamp(host: Host, version: string): Promise<string | null> {
  if ((await host.stat(HERMES_STAMP_READER)) === null) return null;
  const head = await must(host, ["git", "-C", HERMES_INSTALL_DIR, "rev-parse", "HEAD"]);
  return installStamp(head.stdout.trim(), version);
}

/** Whether the `uv` on `PATH` is `UV_VERSION`. */
export async function haveUvPin(host: Host): Promise<boolean> {
  // Through the shell: a missing `uv` is then a non-zero exit, not a spawn ENOENT.
  const have = await host.exec(["/bin/sh", "-c", "uv --version"]);
  return have.code === 0 && have.stdout.trim().split(/\s+/)[1] === UV_VERSION;
}

/**
 * uv for the checkout on the box: a 3.14 checkout gets `UV_VERSION`, replacing
 * anything else that answers `uv --version`; an older one keeps whatever uv it
 * has, and only a box with none runs astral's installer, as it always did.
 */
async function ensureUv(host: Host, emit: Emit, python: string): Promise<void> {
  if (!syncsLocked(python)) {
    if ((await host.exec(["/bin/sh", "-c", "command -v uv"])).code !== 0) {
      await must(host, ["/bin/sh", "-c", UV_INSTALL_SCRIPT]);
    }
    return;
  }
  if (await haveUvPin(host)) return;
  const { url, sha256, dir } = uvRelease(nodeArch());
  emit(opEvent("packages", 0.3, `installing uv ${UV_VERSION}`, host.now()));
  const tarball = `${dir}.tar.gz`;
  await host.mkdir(UV_INSTALL_ROOT, "0755");
  try {
    await fetchPinned(host, url, tarball, sha256);
    // `--no-same-owner`, as for Node: root's tar would restore the builder's uid.
    await must(host, ["tar", "--no-same-owner", "-xzf", tarball, "-C", UV_INSTALL_ROOT]);
  } finally {
    await host.remove(tarball);
  }
  for (const tool of ["uv", "uvx"]) {
    await must(host, ["ln", "-sfn", `${dir}/${tool}`, `/usr/local/bin/${tool}`]);
  }
}

/**
 * Does `hermes --version` report *exactly* the pinned version?
 *
 * `hermes --version` prints a banner — `Hermes Agent v0.21.0 (2026-08-31) ·
 * upstream deadbeef` — not a bare number, so the version has to be found inside
 * it. It used to be found with `includes`, which is the wrong question: upstream
 * tags by date, so a box reporting `2026.8.30` satisfied a manifest pinning
 * `2026.8.3`, and the cross-check that exists to stop a box shipping a version
 * nobody chose passed on the version nobody chose.
 *
 * So: a whole token, with an optional `v`, bounded by anything that could
 * continue a version — a digit, a letter, `.`, `-` or `_`. `ensureNode` asks the
 * same question the easy way (`stdout.trim() === "v" + NODE_VERSION`), because
 * nodejs.org prints the version and nothing else.
 */
export function reportsHermesVersion(stdout: string, version: string): boolean {
  const literal = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`(?<![\w.-])v?${literal}(?![\w.-])`).test(stdout);
}

/**
 * Hermes Agent is not distributed on PyPI — the only supported install is a git
 * checkout plus a `uv` editable install, which is what upstream's `install.sh`
 * does. hermeticd mirrors that script's root/FHS branch step by step rather than
 * running it: an unattended systemd bootstrap must not `curl | bash` an
 * unpinned installer as root, and the manifest, not upstream `main`, is what
 * decides which version this box runs (so `hermes update` is never used either).
 *
 * The manifest pins two things, and both are checked: `hermes_ref` is what git
 * checks out, and `hermes_version` is what the result must report. A tag that
 * reports something else fails the apply instead of quietly shipping a version
 * nobody chose.
 *
 * The *source* of the checkout is the fleet's business, not upstream's: when the
 * fleet manifest names a mirrored bundle for this ref, the tree comes out of the
 * bucket over the S3 gateway endpoint, digest-verified, with no github.com call
 * on any path. Everything after that — venv, editable install, symlink, and the
 * version cross-check — is identical either way, which is the point: hermetic
 * changed the transport, not upstream's supported install.
 *
 * Idempotent: a checkout whose recorded ref matches and whose `hermes` reports
 * the pinned version is left entirely alone — no git, no uv, no network.
 */
export async function ensureHermes(
  manifest: AgentConfig,
  opts: ApplyOptions,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const { host } = opts;
  const { hermes_ref: ref, hermes_version: version } = manifest;

  const spec = installSpec(manifest.provider, await checkoutPython(host));
  const marker = parseRefMarker(await host.readFile(HERMES_REF_MARKER));
  const haveBin = (await host.stat(HERMES_BIN)) !== null;
  // A version change, or a restore a crash left half done, is a fenced swap
  // (`hermes-upgrade.ts`); a fresh box or a same-ref reinstall is not.
  const unfinished = dry ? [] : await unfinishedRestores(host);
  let swapFrom = marker !== null && (marker.ref !== ref || unfinished.length > 0) ? marker.ref : null;
  if (!dry && swapFrom === null && marker?.ref === ref) await refuseStrandedRestore(host, ref);
  let pinned = false;
  if (swapFrom === null && marker?.ref === ref && haveBin) {
    const reported = await host.exec([HERMES_BIN, "--version"], { env: { ...HERMES_CLI_ENV } });
    pinned = reported.code === 0 && reportsHermesVersion(reported.stdout, version);
  }
  if (pinned) {
    const stamp = await wantedStamp(host, version);
    pinned = stamp === null || (await host.readFile(HERMES_INSTALL_STAMP)) === stamp;
  }
  // Before any unit stops, installed or not: a release tag is one version, and a
  // stamp-reading checkout reports whatever it is told.
  const tagged = hermesTagVersion(ref);
  if (tagged !== null && tagged !== version) {
    throw new AgentdError(
      "MANIFEST_REFUSED",
      `hermes_ref ${ref} is Hermes ${tagged}, not the ${version} this manifest pins; Hermes was left untouched`,
      { hermes_ref: ref, hermes_version: version },
    );
  }
  if (pinned) {
    if ((await host.readFile(HERMES_EXTRAS_MARKER))?.trim() === spec) {
      emit(opEvent("packages", 0.3, `hermes ${version} (${ref}) already pinned`, host.now()));
      if (!dry && opts.rollingBack !== true) await settleSwap(host, ref);
      return false;
    }
    emit(
      opEvent(
        "packages",
        0.3,
        `hermes ${version} (${ref}) is missing extras; reinstalling ${spec}`,
        host.now(),
      ),
    );
  } else {
    emit(opEvent("packages", 0.3, `installing hermes ${version} from ${ref}`, host.now()));
  }
  // The marker names the target but the checkout reports a newer Hermes: a
  // swap that died after its checkout moved, then re-pinned back. That newer
  // Hermes may have opened the stores, so this is a downgrade, not a reinstall.
  if (!dry && !pinned && swapFrom === null && marker?.ref === ref) {
    const actual = await installedHermes(host, ref);
    if (actual.version !== null && compareVersions(version, actual.version) < 0) swapFrom = ref;
  }

  if (!dry) {
    // No installed checkout: the data volume may still hold a home another
    // Hermes wrote (a recreate). Backed up, or restored, before anything here
    // runs a `hermes` against it.
    if (marker === null) await guardFirstStart(host, ref, unfinished, emit);
    // 0. Every Hermes unit runs out of the venv and the checkout this is about
    //    to rewrite. `uv pip install -e` replaces the dependency set under a
    //    live process and `git checkout` moves the source files it imports
    //    lazily, so a running Hermes can end up half on one ref and half on the
    //    other. Stop first; the units phase restarts them, because a changed
    //    Hermes puts them in `watchTriggered`.
    //
    //    `HERMES_LEGACY_DASHBOARD_UNIT` is in the list because the units phase
    //    removes it *later* in this same apply: on a box that has not yet taken
    //    the rename, the old dashboard is the one that is actually running, and
    //    leaving it up would put the live process on the wrong side of the swap
    //    for the whole of it.
    //
    //    Only units whose file is on disk. On a first apply none exists yet —
    //    the dashboard unit is written by the `files` phase, which runs later,
    //    and the gateway unit by `hermes gateway install` — and asking systemd
    //    to stop a unit it has never heard of is noise. Here the exit code is
    //    not checked: a unit that is installed and not running is exactly the
    //    state this wants, and systemd says so with a failure. A version change
    //    instead verifies, masks and backs up (`swapHermes`).
    //
    //    The legacy name is stopped only when the file is hermetic's own: a
    //    `hermes.service` somebody else wrote is not in `manifest.units`, so the
    //    units phase would never start it again, and stopping a unit hermetic
    //    does not own is not this apply's call (the same test
    //    `removeLegacyDashboardUnit` makes before deleting it).
    const stopping: string[] = [];
    for (const unit of [HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT]) {
      if ((await host.stat(`${UNIT_DIR}/${unit}`)) !== null) stopping.push(unit);
    }
    const legacy = await host.readFile(`${UNIT_DIR}/${HERMES_LEGACY_DASHBOARD_UNIT}`);
    if (legacy?.includes(HERMETIC_RENDERED_MARKER)) {
      stopping.push(HERMES_LEGACY_DASHBOARD_UNIT);
    }
    if (stopping.length > 0) {
      // Written before the first stop, not after the last: a process killed
      // between the two would otherwise have stopped a unit nothing records.
      // Added to whatever this apply already owes rather than replacing it —
      // the files phase has not run yet, but its obligation is already down.
      const owed = (await readApplyPending(host))?.units ?? [];
      await writeApplyPending(host, [...new Set([...owed, ...stopping])], manifest.config_hash);
      for (const unit of swapFrom === null ? stopping : []) {
        // `packages`, because that is the phase this is in. The units phase is
        // a long way further down and an event that claims to be from it puts
        // the stream out of order for anything reading the phases as a sequence.
        emit(opEvent("packages", 0.3, `stopping ${unit} to install hermes ${ref}`, host.now()));
        await host.exec(["systemctl", "stop", unit]);
      }
    }

    if (swapFrom === null) {
      const upstreamSha = await fetchCheckout(opts, ref, emit, () => {});
      const installed = await installCheckout(host, emit, manifest.provider, version, ref);
      await recordInstall(host, ref, upstreamSha, installed);
    } else {
      await swapHermes({
        host,
        emit,
        ref,
        version,
        fromRef: swapFrom,
        units: stopping,
        browsers: browserSession(manifest),
        unfinished,
        steps: swapSteps(opts, manifest, emit),
      });
    }
    if (opts.rollingBack !== true) await settleSwap(host, ref);
  }

  result.installed.push(`hermes-agent@${ref}`);
  result.changed.push(HERMES_BIN);
  result.contentChanged.push(HERMES_BIN);
  return true;
}

function swapSteps(opts: ApplyOptions, manifest: AgentConfig, emit: Emit): SwapSteps {
  const { host } = opts;
  let ready: Prefetched | null = null;
  return {
    prefetch: async (to) => {
      ready = await prefetchHermes(opts, to, emit);
    },
    // A pre-fetched ref is already in the repository: the held checkout needs no network.
    fetch: async (to, moving) => {
      if (ready?.ref !== to) return await fetchCheckout(opts, to, emit, moving);
      moving();
      await clearIndexLock(host, emit);
      await must(host, ["git", "-C", HERMES_INSTALL_DIR, "checkout", "--detach", ready.commit], {
        env: { ...GIT_ENV },
      });
      return ready.upstreamSha;
    },
    // shortcut: only a pre-fetched swap knows the new pin before the checkout moves, so a
    // retry after a crash before the copy rolls back by reinstalling from the package index.
    keepVenv: async (from) => {
      if (ready === null) return;
      const cfg = await host.readFile(`${HERMES_VENV_DIR}/pyvenv.cfg`);
      if (venvMatches(cfg, ready.python)) await copyVenvAside(host, from);
    },
    // The venv only when the new checkout pins another Python: the install would delete it.
    setAside: async (from) => {
      const cfg = await host.readFile(`${HERMES_VENV_DIR}/pyvenv.cfg`);
      await setAsidePrevious(host, from, !venvMatches(cfg, await checkoutPython(host)));
    },
    restorePrevious: async (from) => {
      if (!(await restorePrevious(host, from.ref))) return null;
      await relinkNodeForCheckout(host);
      // The same cross-check an install ends with; failing it reinstalls.
      const reported = await host.exec([HERMES_BIN, "--version"], { env: { ...HERMES_CLI_ENV } });
      const ok =
        reported.code === 0 &&
        (from.version === null || reportsHermesVersion(reported.stdout, from.version));
      return ok ? (await host.readFile(HERMES_EXTRAS_MARKER))?.trim() || null : null;
    },
    install: (want, rollback) =>
      installCheckout(host, emit, manifest.provider, want, manifest.hermes_ref, rollback),
    record: (to, sha, installed) => recordInstall(host, to, sha, installed),
    // With no valid stamp, the version a pre-0.23 checkout reports; a checkout that reads the
    // stamp (`HERMES_STAMP_READER`) carries upstream's `0.0.0` placeholder there, so it stays unknown.
    inspect: async (from) => {
      const got = await installedHermes(host, from);
      if (got.version !== null || (await host.stat(HERMES_STAMP_READER)) !== null) return got;
      const project = (await host.readFile(`${HERMES_INSTALL_DIR}/pyproject.toml`)) ?? "";
      const table = project.split(/^\[project\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
      return { ...got, version: /^version\s*=\s*"([^"]+)"/m.exec(table)?.[1] ?? null };
    },
    checkoutPrevious: (from) => checkoutPrevious(opts, from, emit),
  };
}

/**
 * `apply` failed while a forward swap to this manifest's ref was still
 * ungated — anywhere from the web build to the runtime gate itself. Roll the
 * swap back (`rollBack`) and re-apply the configuration the box ran before
 * it, so files and units match the restored version; with no such manifest on
 * disk (or one for another provider), start the units on the old install alone
 * and drop the applied-config record, so the next converge re-renders them.
 * Either way `rollBack` reports rolled back only once the old Hermes is up.
 * Returns when there is no such swap; otherwise throws.
 *
 * `whatever`: the recorded install comes back whatever the marker and the
 * manifest say. For a rollback a crash interrupted, and for an apply that
 * failed before `ensureHermes` ran with the units still held, its marker
 * possibly still on the old ref.
 */
export async function rollBackPendingSwap(
  manifest: AgentConfig,
  opts: ApplyOptions,
  cause: unknown,
  reapply: (previous: AgentConfig) => Promise<unknown>,
  whatever = false,
): Promise<void> {
  const { host } = opts;
  const gate = await readSwapGate(host);
  // The rollback's own re-apply: the rollback that started it settles the record.
  if (gate === null || opts.rollingBack === true) return;
  if (!whatever) {
    // A rollback this apply already ran: it reported itself.
    if (gate.rolling_back !== undefined) return;
    if (gate.to_ref !== manifest.hermes_ref) return;
    // Only a swap `ensureHermes` finished; its own failures it handles itself.
    if (parseRefMarker(await host.readFile(HERMES_REF_MARKER))?.ref !== gate.to_ref) return;
  }
  let previous: AgentConfig | null = null;
  try {
    const parsed = parseManifestJson((await host.readFile(MANIFEST_PATH)) ?? "");
    // The same provider, so the secrets this apply was handed still fit it.
    if (parsed.hermes_ref === gate.from.ref && parsed.provider === manifest.provider) previous = parsed;
  } catch {
    // No previous configuration to return to: the units start on the old install.
  }
  await rollBack(
    {
      host,
      emit: opts.emit ?? (() => {}),
      gate,
      steps: swapSteps(opts, manifest, opts.emit ?? (() => {})),
      restart: async () => {
        // hermeticd died in the build, so its own cleanup never ran: no unit starts beside the swap.
        await removeBuildSwap(host, opts.emit ?? (() => {}));
        let failed: unknown = null;
        if (previous !== null) {
          try {
            await reapply(previous);
            return;
          } catch (error) {
            // Failed before its units phase, the re-apply left the hold: the old install is back, so start it.
            failed = error;
          }
        }
        // The units run on files rendered for the new pin: the next converge
        // must not read this box as already on its config, and re-renders them.
        await host.remove(APPLIED_CONFIG_PATH);
        await releaseHold(host);
        for (const unit of gate.units) await host.exec(["systemctl", "start", unit]);
        await startOwedBrowsers(host, browserSession(manifest));
        if (failed !== null) throw failed;
      },
    },
    cause,
  );
}

/**
 * A forward swap to this manifest's ref whose new Hermes was started (installed,
 * hold released) but never gated: hermeticd died during the runtime gate. Gated
 * before anything else, so the swap is sealed, or rolled back while the state
 * written since is one restart's worth, within the first apply after it rather
 * than whenever a later apply reaches its units phase. A failure throws as
 * `rollBackPendingSwap` does.
 */
export async function gateStartedSwap(
  manifest: AgentConfig,
  opts: ApplyOptions,
  reapply: (previous: AgentConfig) => Promise<unknown>,
): Promise<void> {
  const { host } = opts;
  if (opts.dryRun === true || opts.rollingBack === true) return;
  const gate = await readSwapGate(host);
  if (gate === null || gate.rolling_back !== undefined || gate.to_ref !== manifest.hermes_ref) return;
  if ((await host.lstat(HERMES_HOLD_PATH)) !== null) return;
  if (parseRefMarker(await host.readFile(HERMES_REF_MARKER))?.ref !== gate.to_ref) return;
  try {
    await verifySwap(host, opts.emit ?? (() => {}), gate.to_ref);
  } catch (cause) {
    await rollBackPendingSwap(manifest, opts, cause, reapply);
    throw cause;
  }
}

/** The install a swap is leaving: its ref, `HEAD`, and the version a valid stamp names. */
async function installedHermes(host: Host, ref: string): Promise<HermesInstalled> {
  const head = await host.exec(["git", "-C", HERMES_INSTALL_DIR, "rev-parse", "HEAD"]);
  const commit = head.code === 0 && COMMIT_ID_RE.test(head.stdout.trim()) ? head.stdout.trim() : null;
  let version: string | null = null;
  try {
    const stamp = JSON.parse((await host.readFile(HERMES_INSTALL_STAMP)) ?? "null") as {
      commit?: unknown;
      baseVersion?: unknown;
    } | null;
    // Upstream's own rule: a stamp counts only for the commit it names.
    if (commit !== null && stamp?.commit === commit && typeof stamp.baseVersion === "string") {
      version = stamp.baseVersion;
    }
  } catch {
    // Unreadable: the version is unknown, which reads as a pre-0.22 install.
  }
  const marker = parseRefMarker(await host.readFile(HERMES_REF_MARKER));
  return { ref, commit, version, upstreamSha: marker?.ref === ref ? marker.upstreamSha : null };
}

/** Back onto the install a failed swap left, without the network when `HEAD` was known. */
async function checkoutPrevious(opts: ApplyOptions, from: HermesInstalled, emit: Emit): Promise<void> {
  if (from.commit === null) {
    await fetchCheckout(opts, from.ref, emit, () => {});
    return;
  }
  await clearIndexLock(opts.host, emit);
  await must(opts.host, ["git", "-C", HERMES_INSTALL_DIR, "checkout", "--detach", from.commit], {
    env: { ...GIT_ENV },
  });
}

/**
 * A git killed mid-checkout leaves `index.lock` behind, and every later
 * checkout refuses on it. Removed only here, with the Hermes units stopped
 * and inside the one apply hermeticd runs at a time: nothing else runs git in
 * this checkout then, so the lock cannot be a live one.
 */
async function clearIndexLock(host: Host, emit: Emit): Promise<void> {
  const lock = `${HERMES_INSTALL_DIR}/.git/index.lock`;
  if ((await host.lstat(lock)) === null) return;
  emit(opEvent("packages", 0.3, `removing a stale ${lock}`, host.now(), "warn"));
  await host.remove(lock);
}

/**
 * Steps 2 and 3 of the install: git, then the checkout at `ref`. Returns the
 * mirrored-from upstream commit when the tree came from the fleet's bundle.
 * `moving` fires just before the working tree is first changed.
 */
async function fetchCheckout(
  opts: ApplyOptions,
  ref: string,
  emit: Emit,
  moving: () => void,
): Promise<string | null> {
  const { host } = opts;
  // 2. git. The manifest lists it as a package, so a box that reaches here
  //    without it has an apt problem worth naming rather than a missing tool.
  if ((await host.exec(["/bin/sh", "-c", "command -v git"])).code !== 0) {
    throw new AgentdError(
      "COMMAND_FAILED",
      "git is not installed, so the Hermes checkout cannot be made",
      { install_dir: HERMES_INSTALL_DIR },
    );
  }

  // 3. Checkout at the pinned ref, from the fleet's own mirror when it has
  //    one. Either source takes the same two shapes: a fresh box clones, and
  //    a box already holding a checkout fetches just that ref and detaches
  //    onto it — the upgrade path, which rewrites only tracked files and so
  //    leaves `venv/` and the npm trees exactly where they are.
  const bundle = await fetchHermesBundle(
    host,
    ref,
    (message) => emit(opEvent("packages", 0.3, message, host.now(), "warn")),
    opts.getObject,
  );
  if (bundle !== null) {
    emit(opEvent("packages", 0.3, `hermes ${ref} from the fleet's mirror`, host.now()));
    // Neither retried nor bounded: the bundle is a local file, so there is no
    // flaky remote to try again and nothing that can hang. The bundle carries
    // the ref as a tag on its single commit, so a clone lands on it with no
    // `--branch` and `git describe` still answers.
    if ((await host.stat(`${HERMES_INSTALL_DIR}/.git`)) === null) {
      moving();
      await must(host, ["git", "clone", bundle.path, HERMES_INSTALL_DIR], {
        env: { ...GIT_ENV },
      });
      // A clone records where it was cloned from, and here that is a staged
      // file this function deletes a few lines below — so without this every
      // mirror-installed box has an `origin` naming a path that does not
      // exist. Upstream reads it: `hermes update --check` asks
      // `git remote get-url origin` and decides from the answer whether the
      // checkout is a fork (`hermes_cli/update_cmd_git.py:181-195`). Point it
      // at the repo the tree actually came from. Setting a URL contacts
      // nothing; the fallback clone is still the only path that reaches
      // github.com.
      await must(host, ["git", "-C", HERMES_INSTALL_DIR, "remote", "set-url", "origin", HERMES_REPO]);
    } else {
      await must(host, ["git", "-C", HERMES_INSTALL_DIR, "fetch", bundle.path, ref], {
        env: { ...GIT_ENV },
      });
      moving();
      await clearIndexLock(host, emit);
      await must(host, ["git", "-C", HERMES_INSTALL_DIR, "checkout", "--detach", "FETCH_HEAD"], {
        env: { ...GIT_ENV },
      });
    }
    // git has taken what it needs. The bundle is the size of the whole tree,
    // and a box has no reason to keep carrying it.
    await host.remove(bundle.path);
  } else {
    // Retried as one unit: what fails is the network half, and re-running the
    // fetch is what recovers it. The checkout is local and idempotent, so
    // replaying it costs nothing.
    //
    // The fetch names `HERMES_REPO` rather than `origin` because the remote a
    // checkout was cloned from is not necessarily this URL — a box installed
    // from the bundle above has an `origin` pointing at a temporary file that
    // is gone by now. The fallback must name the fallback.
    await retry(host, GIT_CLONE_ATTEMPTS, GIT_RETRY_MS, async () => {
      if ((await host.stat(`${HERMES_INSTALL_DIR}/.git`)) === null) {
        moving();
        await must(
          host,
          ["git", "clone", "--depth", "1", "--branch", ref, HERMES_REPO, HERMES_INSTALL_DIR],
          { env: { ...GIT_ENV } },
        );
        return;
      }
      await must(
        host,
        [
          "timeout",
          GIT_FETCH_TIMEOUT_S,
          "git",
          "-C",
          HERMES_INSTALL_DIR,
          "fetch",
          "--depth",
          "1",
          HERMES_REPO,
          ref,
        ],
        { env: { ...GIT_ENV } },
      );
      moving();
      await clearIndexLock(host, emit);
      await must(host, ["git", "-C", HERMES_INSTALL_DIR, "checkout", "--detach", "FETCH_HEAD"], {
        env: { ...GIT_ENV },
      });
    });
  }
  return bundle?.upstreamSha ?? null;
}

/**
 * Steps 3b to 6: stamp, uv, venv, install, link and the version cross-check,
 * each by the recipe the checkout on disk calls for. Returns the install spec
 * for the extras marker. A `null` version is an old checkout being returned
 * to whose version is unknown: no stamp is written and only the exit of
 * `hermes --version` is checked.
 */
async function installCheckout(
  host: Host,
  emit: Emit,
  provider: Provider,
  version: string | null,
  ref: string,
  rollback = false,
): Promise<string> {
  // 3b. The stamp, before anything below runs `hermes`: without it the
  //     first launch adopts the checkout (see `HERMES_INSTALL_STAMP`). A
  //     checkout that reads none drops one a newer checkout left (git keeps
  //     untracked files), which would otherwise mislead the next swap.
  if ((await host.stat(HERMES_STAMP_READER)) === null) {
    await host.remove(HERMES_INSTALL_STAMP);
  } else if (version !== null) {
    const stamp = await wantedStamp(host, version);
    if (stamp !== null) await host.writeFile(HERMES_INSTALL_STAMP, stamp, "0644");
  }

  // 3c. uv, the only thing that can do the editable install or the locked
  //     sync. After the checkout, because the checkout says which uv: git
  //     needs none, and a fresh box has no tree to ask before it clones.
  const python = await checkoutPython(host);
  await ensureUv(host, emit, python);

  // 4. The venv is per-checkout and survives an upgrade as long as its
  //    interpreter is the one the checkout pins; an upgrade across upstream's
  //    3.11 -> 3.14 move, or a rollback over it, rebuilds it. The install
  //    re-runs every time, since the dependency set is part of what the new
  //    ref changed.
  let haveVenv = (await host.stat(`${HERMES_VENV_DIR}/bin/python`)) !== null;
  const cfg = await host.readFile(`${HERMES_VENV_DIR}/pyvenv.cfg`);
  if (haveVenv && !venvMatches(cfg, python)) {
    emit(opEvent("packages", 0.3, `rebuilding ${HERMES_VENV_DIR} on python ${python}`, host.now()));
    await must(host, ["rm", "-rf", "--", HERMES_VENV_DIR]);
    haveVenv = false;
  }
  // Bounded on the 3.14 recipe and in a rollback (`boundedStep`); a 3.11
  // install outside a rollback keeps the argv old-pin boxes have always run.
  const bounded = syncsLocked(python) || rollback;
  const run = (argv: readonly string[], opts: { cwd?: string; env?: Record<string, string> }) =>
    bounded ? boundedStep(host, argv, opts) : must(host, argv, opts);
  if (!haveVenv) {
    await run(["uv", "venv", "--python", python, HERMES_VENV_DIR], { env: { ...UV_ENV } });
  }
  const installed = installSpec(provider, python);
  if (syncsLocked(python)) {
    await run(syncArgv(provider), {
      cwd: HERMES_INSTALL_DIR,
      env: { ...UV_ENV, UV_PROJECT_ENVIRONMENT: HERMES_VENV_DIR },
    });
  } else {
    await run(["uv", "pip", "install", "--python", `${HERMES_VENV_DIR}/bin/python`, "-e", installed], {
      env: { ...UV_ENV },
    });
  }

  // 5. The `PATH` entry the rendered unit's ExecStart names. `-n` so a
  //    re-link never nests a symlink inside the previous one's target.
  await must(host, ["ln", "-sfn", `${HERMES_VENV_DIR}/bin/hermes`, HERMES_BIN]);

  // 6. The cross-check the two pinned fields exist for.
  const reported = await host.exec([HERMES_BIN, "--version"], { env: { ...HERMES_CLI_ENV } });
  if (reported.code !== 0 || (version !== null && !reportsHermesVersion(reported.stdout, version))) {
    throw new AgentdError(
      "MANIFEST_REFUSED",
      `hermes at ref ${ref} reports ${reported.stdout.trim() || `exit ${reported.code}`}, ` +
        `not the pinned version ${version}`,
      { ref, expected: version, install_dir: HERMES_INSTALL_DIR },
    );
  }
  return installed;
}

/**
 * Written last, and only on success: a marker left behind by a run that
 * failed its cross-check would tell the next apply there is nothing to do.
 * The ref marker goes after the extras marker because it is the commit point
 * a swap's retry reads.
 *
 * The ref marker's second line is the upstream commit, and it exists because a
 * bundle's commit sha is hermetic's own — synthesized over the checked-out
 * tree — so `git log` on the box names a commit upstream never made. A direct
 * clone writes one line, and so did every hermeticd before this.
 */
async function recordInstall(
  host: Host,
  ref: string,
  upstreamSha: string | null,
  installed: string,
): Promise<void> {
  await host.writeFile(HERMES_EXTRAS_MARKER, `${installed}\n`, "0644");
  await host.writeFile(HERMES_REF_MARKER, formatRefMarker(ref, upstreamSha), "0644");
  // On the data volume: which Hermes the home is now `ref`'s to open (`hermes-home-record.ts`).
  await recordHomeRef(host, ref);
}

/**
 * Let the `hermes` account read the checkout it runs out of.
 *
 * The install tree is root's and stays root's: §7.1 puts the agent's own
 * processes on the far side of a permission boundary from the code hermetic
 * pinned, so an agent cannot rewrite its own Hermes and quietly leave the ref
 * the manifest names. Since git 2.35.2 that ownership split also stops the
 * `hermes` user *reading* the repository at all — every command in a directory
 * owned by someone else fails with `detected dubious ownership`, before it has
 * looked at a single object.
 *
 * Which is not the boundary we wanted. Reading is how upstream answers "what am
 * I running": `hermes update --check`, the startup banner, the dashboard's
 * `GET /api/hermes/update/check`, all of them `git rev-parse` the checkout as
 * the service user, all of them get nothing, and the dashboard turns the
 * nothing into *"Couldn't reach the update source — try again later."* — a
 * network diagnosis for an entirely local fault, which is what sent an operator
 * looking at the fleet's egress.
 *
 * `safe.directory` grants exactly the half that was never meant to be denied.
 * git's own check is about ownership, not about write access: an exception here
 * lets `hermes` read the repository and changes nothing about the file modes,
 * so a write still fails, which is the boundary §7.1 actually asked for.
 *
 * `--system`, so it covers the service user, root and anyone who `sudo`s into
 * the box without a per-account `~/.gitconfig` each. `--get-all` first because
 * `--add` is not idempotent: it appends, and an apply runs on every boot.
 */
export async function ensureGitSafeDirectory(host: Host, emit: Emit, dry: boolean): Promise<void> {
  if (dry) return;
  const existing = await host.exec(["git", "config", "--system", "--get-all", "safe.directory"]);
  /**
   * Exit 1 is "the key is not set", which is the first-boot case and not a
   * failure. Any other non-zero is git being unable to answer, and adding on
   * top of an answer we do not have is how the list grows without bound — so
   * this skips, and says so. Skipping silently would reproduce, exactly, the
   * symptom the exception exists to remove: a box whose Hermes cannot read its
   * own checkout, reporting it as a network problem.
   */
  if (existing.code !== 0 && existing.code !== 1) {
    emit(
      opEvent(
        "packages",
        0.32,
        `could not read git's system config (exit ${existing.code}), so ${HERMES_INSTALL_DIR} ` +
          "was not marked safe.directory; hermes will not be able to read its own checkout",
        host.now(),
        "warn",
      ),
    );
    return;
  }
  if (existing.stdout.split("\n").some((line) => line.trim() === HERMES_INSTALL_DIR)) return;
  await must(host, ["git", "config", "--system", "--add", "safe.directory", HERMES_INSTALL_DIR]);
}

/**
 * Tell Hermes which upstream commit it is running, in the one file both its
 * units read (`HERMES_REVISION_ENV`).
 *
 * The value comes from the ref marker `ensureHermes` has just written, because
 * that is where the fact already lives and re-deriving it would give two
 * answers that could disagree. Its second line is the mirrored-from commit; a
 * box on the direct-clone fallback has no second line and does not need one —
 * there the checkout is upstream's own history, so `HEAD` *is* the answer and
 * git can be asked for it.
 *
 * Best-effort throughout. Every branch that fails leaves the file absent, the
 * unit's `EnvironmentFile=-` tolerates that, and the update check degrades to
 * the checkout-interrogating path it was already on. Nothing about whether this
 * box is healthy turns on it, so nothing here throws.
 *
 * Returns whether the file moved, which the units phase turns into a restart:
 * an `EnvironmentFile` is read at start, and this one is not in
 * `manifest.files`, so the `restart_units` route that covers the rendered files
 * cannot see it — the same gap `hermesChanged` exists to close.
 */
export async function ensureHermesRevision(
  host: Host,
  result: ApplyResult,
  hermesInstalls: boolean,
  dry: boolean,
): Promise<boolean> {
  const marker = parseRefMarker(await host.readFile(HERMES_REF_MARKER));
  let sha = marker?.upstreamSha ?? null;
  if (marker !== null && sha === null) {
    /**
     * No second line means the direct-clone fallback, where `HEAD` is
     * upstream's own commit — *unless* the marker was written by a hermeticd
     * old enough to predate the second line, which on a bundle install would
     * make `HEAD` the synthesized commit this whole file exists to keep out of
     * upstream's hands. Shallowness is what separates them and cannot be
     * forged by either: the fallback is `clone --depth 1`, and a bundle clone
     * is never shallow. A checkout that answers neither keeps whatever the
     * last apply wrote, which is better than a confident wrong sha.
     */
    const shallow = await host.exec([
      "git",
      "-C",
      HERMES_INSTALL_DIR,
      "rev-parse",
      "--is-shallow-repository",
    ]);
    if (shallow.code === 0 && shallow.stdout.trim() === "true") {
      const head = await host.exec(["git", "-C", HERMES_INSTALL_DIR, "rev-parse", "HEAD"]);
      sha = head.code === 0 ? head.stdout.trim() : null;
    }
  }
  // Same shape `hermes-mirror.ts` accepts from `rev-parse`: sha1, or sha256 for
  // a repository upstream has not converted but might. A marker line that is
  // neither is not a commit id, and `HERMES_REVISION` would be compared against
  // upstream `main` as though it were one.
  const content = sha !== null && COMMIT_ID_RE.test(sha) ? `HERMES_REVISION=${sha}\n` : null;
  const current = await host.readFile(HERMES_REVISION_ENV);

  /**
   * A dry run is a plan made *before* `ensureHermes` has done anything, and the
   * plan still has to name every path the real run then changes. Two ways it
   * could not see one, and `hermesInstalls` is the second and sharper of them:
   *
   *   - **no checkout yet** — neither the marker nor git can say what the
   *     revision will be, so `content` is `null`.
   *   - **the ref is about to move** — the marker is still the *outgoing*
   *     install's, so the revision this function can read agrees with the file
   *     on disk and nothing looks like it is changing. It is: the real run
   *     rewrites the marker first and this file lands on the new commit. This
   *     is the case that matters most, because it is every apply that moves
   *     Hermes.
   *
   * In both, unprovable means "will change". A plan that overstates is one an
   * operator can check; one that stayed silent about a file it went on to write
   * is not.
   */
  if (dry) {
    if (hermesInstalls || content === null || current !== content) {
      result.changed.push(HERMES_REVISION_ENV);
    }
    return false;
  }

  if (content === null || current === content) return false;

  /**
   * `mkdir` first, and not because it is tidy: this runs in the packages phase,
   * and everything else that writes under `HERMES_MANAGED_DIR` is a rendered
   * file written two phases later through `apply`'s `write`, which makes the
   * directory itself. On a box that has applied before, `/etc/hermes` is
   * already there and the omission is invisible; on a *fresh* one this is the
   * first write into it and the staged sibling has nowhere to land. That is
   * the whole of the ENOENT that failed `04-apply` on a new box while every
   * box created before this function existed kept applying cleanly.
   */
  try {
    await host.mkdir(HERMES_MANAGED_DIR, "0755");
    await host.writeFile(HERMES_REVISION_ENV, content, "0644");
  } catch {
    /**
     * Best-effort, as the whole function is: `EnvironmentFile=-` tolerates the
     * file's absence and the update check falls back to interrogating the
     * checkout. Bootstrap failing over a file that is allowed to be missing is
     * the strictly worse outcome, so the write is the one thing here that may
     * fail without taking the apply with it.
     */
    return false;
  }
  result.changed.push(HERMES_REVISION_ENV);
  result.contentChanged.push(HERMES_REVISION_ENV);
  return true;
}
