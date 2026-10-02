/**
 * Hermes itself, which is not an apt package: a git checkout of the manifest's
 * ref under `/usr/local/lib`, installed editable into a venv by `uv` (§6.4),
 * plus the revision file the rendered units read and the git safe-directory
 * entry the checkout needs.
 */
import type { AgentConfig, Provider } from "@hermetic/core/schema";
import {
  HERMES_BIN,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  HERMES_INSTALL_DIR,
  HERMES_LEGACY_DASHBOARD_UNIT,
  HERMES_MANAGED_DIR,
  HERMES_REVISION_ENV,
} from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { readApplyPending, writeApplyPending } from "../apply-pending.ts";
import { fetchHermesBundle, formatRefMarker, parseRefMarker } from "../hermes-source.ts";
import { HERMETIC_RENDERED_MARKER } from "./accounts.ts";
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
/** Upstream's `pyproject` is `requires-python = ">=3.11,<3.14"`; pin the floor. */
const HERMES_PYTHON = "3.11";
/** The venv the editable install goes into, and the `hermes` it produces. */
const HERMES_VENV_DIR = `${HERMES_INSTALL_DIR}/venv`;
/**
 * The ref this box last installed, recorded by hermeticd rather than read back
 * out of git. A marker beats `git rev-parse HEAD` against `<ref>^{commit}`
 * because the checkout is shallow and detached: the tag object is usually not
 * even in the clone, so the comparison that would prove the box is on the right
 * ref is the one git cannot answer offline. One file read settles it instead.
 */
const HERMES_REF_MARKER = `${HERMES_INSTALL_DIR}/.hermetic-ref`;
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
const GIT_CLONE_ATTEMPTS = 3;
const GIT_RETRY_MS = 5_000;

/**
 * uv puts its managed interpreters in the *user's* home by default, which for a
 * unit running as root is `/root` — a directory no other account can execute
 * out of. Upstream's FHS branch redirects both, so the venv Hermes runs from
 * does not depend on root's dotfiles surviving.
 */
const UV_ENV = {
  UV_PYTHON_INSTALL_DIR: "/usr/local/share/uv/python",
  UV_PYTHON_BIN_DIR: "/usr/local/share/uv/bin",
} as const;

/** A clone that would otherwise block forever asking an unattended box to log in. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" } as const;

/** A 40-hex sha1 or a 64-hex sha256 object id, as `rev-parse` prints it. */
const COMMIT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
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

/** `-e "/usr/local/lib/hermes-agent[all,messaging,bedrock]"` — pip's extras syntax for a path. */
export function editableSpec(provider: Provider): string {
  const extra = PROVIDER_EXTRAS[provider];
  const extras = extra === null ? BASE_EXTRAS : [...BASE_EXTRAS, extra];
  return `${HERMES_INSTALL_DIR}[${extras.join(",")}]`;
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

  const spec = editableSpec(manifest.provider);
  const marker = parseRefMarker(await host.readFile(HERMES_REF_MARKER));
  const haveBin = (await host.stat(HERMES_BIN)) !== null;
  let pinned = false;
  if (marker?.ref === ref && haveBin) {
    const reported = await host.exec([HERMES_BIN, "--version"]);
    pinned = reported.code === 0 && reportsHermesVersion(reported.stdout, version);
  }
  if (pinned) {
    if ((await host.readFile(HERMES_EXTRAS_MARKER))?.trim() === spec) {
      emit(opEvent("packages", 0.3, `hermes ${version} (${ref}) already pinned`, host.now()));
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

  if (!dry) {
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
    //    to stop a unit it has never heard of is noise. The exit code is not
    //    checked either: a unit that is installed and not running is exactly
    //    the state this wants, and systemd says so with a failure.
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
      for (const unit of stopping) {
        // `packages`, because that is the phase this is in. The units phase is
        // a long way further down and an event that claims to be from it puts
        // the stream out of order for anything reading the phases as a sequence.
        emit(opEvent("packages", 0.3, `stopping ${unit} to install hermes ${ref}`, host.now()));
        await host.exec(["systemctl", "stop", unit]);
      }
    }

    // 1. uv, the only thing that can do the editable install.
    if ((await host.exec(["/bin/sh", "-c", "command -v uv"])).code !== 0) {
      await must(host, ["/bin/sh", "-c", UV_INSTALL_SCRIPT]);
    }

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
          await must(
            host,
            ["git", "clone", "--depth", "1", "--branch", ref, HERMES_REPO, HERMES_INSTALL_DIR],
            { env: { ...GIT_ENV } },
          );
          return;
        }
        await must(host, ["git", "-C", HERMES_INSTALL_DIR, "fetch", "--depth", "1", HERMES_REPO, ref], {
          env: { ...GIT_ENV },
        });
        await must(host, ["git", "-C", HERMES_INSTALL_DIR, "checkout", "--detach", "FETCH_HEAD"], {
          env: { ...GIT_ENV },
        });
      });
    }

    // 4. The venv is per-checkout and survives an upgrade, so it is created
    //    once; the editable install re-runs every time, since the dependency
    //    set is part of what the new ref changed.
    if ((await host.stat(`${HERMES_VENV_DIR}/bin/python`)) === null) {
      await must(host, ["uv", "venv", "--python", HERMES_PYTHON, HERMES_VENV_DIR], {
        env: { ...UV_ENV },
      });
    }
    await must(
      host,
      ["uv", "pip", "install", "--python", `${HERMES_VENV_DIR}/bin/python`, "-e", spec],
      { env: { ...UV_ENV } },
    );

    // 5. The `PATH` entry the rendered unit's ExecStart names. `-n` so a
    //    re-link never nests a symlink inside the previous one's target.
    await must(host, ["ln", "-sfn", `${HERMES_VENV_DIR}/bin/hermes`, HERMES_BIN]);

    // 6. The cross-check the two pinned fields exist for.
    const reported = await host.exec([HERMES_BIN, "--version"]);
    if (reported.code !== 0 || !reportsHermesVersion(reported.stdout, version)) {
      throw new AgentdError(
        "MANIFEST_REFUSED",
        `hermes at ref ${ref} reports ${reported.stdout.trim() || `exit ${reported.code}`}, ` +
          `not the pinned version ${version}`,
        { ref, expected: version, install_dir: HERMES_INSTALL_DIR },
      );
    }

    // Written last, and only on success: a marker left behind by a run that
    // failed its cross-check would tell the next apply there is nothing to do.
    //
    // The second line is the upstream commit, and it exists because a bundle's
    // commit sha is hermetic's own — synthesized over the checked-out tree — so
    // `git log` on the box names a commit upstream never made. A direct clone
    // writes one line, and so did every hermeticd before this.
    await host.writeFile(HERMES_REF_MARKER, formatRefMarker(ref, bundle?.upstreamSha ?? null), "0644");
    await host.writeFile(HERMES_EXTRAS_MARKER, `${spec}\n`, "0644");
  }

  result.installed.push(`hermes-agent@${ref}`);
  result.changed.push(HERMES_BIN);
  result.contentChanged.push(HERMES_BIN);
  return true;
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
