/**
 * `hermeticd apply` — §6.4. Four primitives and nothing else:
 *
 *   packages  apt (plus the manifest's own sources), skipping what dpkg has;
 *             Hermes from a git checkout of the manifest's ref, `uv` editable
 *   files     write only when the SHA-256 differs; honour the rendered mode
 *   units     daemon-reload, enable the listed units, restart ONLY the units
 *             whose own file changed
 *   commands  the manifest's short list of idempotent post-steps
 *
 * Templating is deliberately not among them: hermetic renders final files on the
 * laptop (`packages/core/src/render.ts`), so the box never sees a variable.
 *
 * Every side effect goes through `Host`, which is why the whole of this file is
 * testable without root, systemd or a network (§11.5).
 */
import type { AgentConfig, RenderedFile } from "@hermetic/core/schema";
import { HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT, PROVIDERS } from "@hermetic/core/shared";
import { ensureChromeBuild, pruneSupersededBuilds } from "../browser-source.ts";
import { ensureBrowserProfileRoot } from "../account-dirs.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import { opEvent } from "../events.ts";
import {
  clearApplyPending,
  dropApplyPendingUnit,
  plannedRestarts,
  readApplyPending,
  writeApplyPending,
} from "../apply-pending.ts";
import { recordAppliedConfig } from "../manifest.ts";
import type { ApplyOptions, ApplyResult } from "./shared.ts";
import { UNIT_DIR, sha256 } from "./shared.ts";
import {
  SUDOERS_DIR,
  ensureKeyring,
  installPackages,
  missingPackages,
  sourceListContent,
  sourceListPath,
  writeSudoers,
} from "./apt.ts";
import {
  HERMES_USER,
  ensureAccounts,
  ensureGatewayUnit,
  ensureHermesHomeOwnership,
  ensureOwnership,
  removeLegacyBrowserUnits,
  removeLegacyDashboardUnit,
  requireKnownUnit,
} from "./accounts.ts";
import { ensureAgentVenv } from "./agent-python.ts";
import { ensureGitSafeDirectory, ensureHermes, ensureHermesRevision } from "./hermes.ts";
import { ensureNode, ensureWebUi } from "./node-web.ts";
import { SECRETS_ENV_PATH, materialiseSecrets } from "./secrets.ts";

/**
 * The phases live in their own modules; everything callers and tests reached
 * through `apply.ts` is re-exported here so the import site does not move.
 */
export type { ApplyOptions, ApplyResult } from "./shared.ts";
export { sha256 } from "./shared.ts";
export { APT_OPTIONS, parseDpkgQuery, resetAptIndexState } from "./apt.ts";
export {
  DOCKER_GROUP,
  HERMES_USER,
  HERMETIC_RENDERED_MARKER,
  LEGACY_BROWSER_UNITS,
  asHermes,
  BROWSER_PROFILE_ROOT,
  ensureAccounts,
  ensureBrowserProfileRoot,
  ensureGatewayUnit,
  ensureOwnership,
  installAccountDir,
  ownershipOf,
  removeLegacyBrowserUnits,
  removeLegacyDashboardUnit,
} from "./accounts.ts";
export {
  HERMES_BIN,
  HERMES_INSTALL_DIR,
  HERMES_REPO,
  PROVIDER_EXTRAS,
  reportsHermesVersion,
} from "./hermes.ts";
export {
  HERMES_WEB_DIR,
  NODE_INSTALL_ROOT,
  NODE_VERSION,
  nodeArch,
  nodeDir,
  shasumFor,
} from "./node-web.ts";
export { SECRETS_ENV_DIR, SECRETS_ENV_PATH, envLine, materialiseSecrets } from "./secrets.ts";

export async function apply(manifest: AgentConfig, opts: ApplyOptions): Promise<ApplyResult> {
  const { host } = opts;
  const emit = opts.emit ?? (() => {});
  const dry = opts.dryRun === true;
  const result: ApplyResult = {
    changed: [],
    contentChanged: [],
    modeCorrected: [],
    ownershipCorrected: [],
    restarted: [],
    installed: [],
    enabled: [],
    commands: [],
  };
  const at = () => host.now();

  const write = async (
    path: string,
    content: string,
    mode: string,
  ): Promise<"content" | "mode" | null> => {
    const existing = await host.readFile(path);
    const stat = await host.stat(path);
    const contentDiffers = existing === null || sha256(existing) !== sha256(content);
    const modeDiffers = stat !== null && stat.mode !== mode;
    if (!contentDiffers && !modeDiffers) return null;
    if (!dry) {
      const slash = path.lastIndexOf("/");
      if (slash > 0) await host.mkdir(path.slice(0, slash));
      if (contentDiffers) {
        if (path.startsWith(SUDOERS_DIR)) await writeSudoers(host, path, content, mode);
        else await host.writeFile(path, content, mode);
      } else await host.chmod(path, mode);
    }
    result.changed.push(path);
    if (contentDiffers) result.contentChanged.push(path);
    else result.modeCorrected.push(path);
    return contentDiffers ? "content" : "mode";
  };

  // ─── 0. the restart obligation, before anything is touched ─────────────────
  /**
   * Intent before mutation (`apply-pending.ts`): what a previous apply owed and
   * never paid, plus what this one's file writes are about to oblige it to
   * restart, written down while both are still only predictions.
   *
   * The leftover is carried rather than acted on here. Draining it at the top
   * would start Hermes on whatever a failed swap left in the venv; the units
   * phase is where a restart belongs, so the record is read now and paid there
   * — including when this apply's own diff turns out to be empty, which is
   * exactly the shape of the crash that made the record necessary.
   */
  const owedBefore = (await readApplyPending(host))?.units ?? [];
  if (!dry) {
    const planned = await plannedRestarts(host, manifest, UNIT_DIR);
    await writeApplyPending(host, [...new Set([...owedBefore, ...planned])], manifest.config_hash);
  }

  // ─── 1. apt sources declared by the manifest ───────────────────────────────
  emit(opEvent("packages", 0.05, "checking apt sources", at()));
  let sourcesChanged = false;
  for (const source of manifest.apt_sources) {
    let keyring: string | null = null;
    if (source.key_url) {
      const key = await ensureKeyring(host, source.name, source.key_url, dry);
      keyring = key.path;
      if (key.changed) {
        result.changed.push(key.path);
        sourcesChanged = true;
      }
    }
    const listed = await write(
      sourceListPath(source.name),
      sourceListContent(source.uri, keyring),
      "0644",
    );
    if (listed !== null) sourcesChanged = true;
  }

  // ─── 2. packages ───────────────────────────────────────────────────────────
  const missing = manifest.packages.length === 0 ? [] : await missingPackages(host, manifest.packages);

  if (missing.length > 0) {
    emit(opEvent("packages", 0.15, `installing ${missing.length} package(s)`, at()));
    if (!dry) await installPackages(host, missing, sourcesChanged);
    result.installed.push(...missing);
  } else {
    emit(opEvent("packages", 0.15, "all packages already installed", at()));
  }

  /**
   * The pinned Chrome, out of the fleet's own mirror (§7.3).
   *
   * Here and not earlier because `unzip` is one of the manifest's packages, and
   * here and not later because the units phase starts
   * `hermetic-browser@<name>.service`, whose `ExecStart` is the binary this
   * unpacks. A `browser: false` agent does nothing at all.
   */
  const chrome = await ensureChromeBuild(host, manifest, emit, {
    ...(opts.getObject ? { getObject: opts.getObject } : {}),
    ...(dry ? { dryRun: true } : {}),
  });
  if (chrome?.installed) result.installed.push(`chrome@${chrome.ref}`);

  // Hermes is not an apt package: a venv pinned to the manifest's version (§6.4).
  const hermesChanged = await ensureHermes(manifest, opts, result, emit, dry);
  // Both outside `ensureHermes` on purpose: it returns early for a checkout
  // already on the pinned ref, and every box installed before these two lines
  // existed is exactly that case.
  await ensureGitSafeDirectory(host, emit, dry);
  // `hermesChanged` is passed, not inferred: on a dry run it is the only thing
  // that knows the ref is about to move, since the marker still says otherwise.
  const revisionChanged = await ensureHermesRevision(host, result, hermesChanged, dry);
  // …and its browser UI is not even a Python artifact: a Vite bundle, built
  // here from the checkout above, with a Node apt cannot supply.
  await ensureNode(opts, result, emit, dry);
  await ensureWebUi(manifest, opts, result, emit, dry);

  // ─── 2b. accounts ──────────────────────────────────────────────────────────
  // Before `files`, not merely before `units`: a rendered file that names
  // `hermes` as its owner can then be chowned on the pass that writes it,
  // instead of being deferred to after the post-steps.
  emit(opEvent("accounts", 0.35, `ensuring the ${HERMES_USER} account`, at()));
  await ensureAccounts(host, dry);

  // ─── 2c. the gateway unit, if upstream has not written it yet ──────────────
  emit(opEvent("units", 0.38, `checking ${HERMES_GATEWAY_UNIT}`, at()));
  const gatewayInstalled = await ensureGatewayUnit(host, dry);
  await ensureHermesHomeOwnership(host, dry);
  // After the account exists and after `ensureHermes`, which is what puts `uv`
  // on the box.
  await ensureAgentVenv(host, emit, dry);

  // ─── 3. files ──────────────────────────────────────────────────────────────
  emit(opEvent("files", 0.4, `checking ${manifest.files.length} rendered file(s)`, at()));
  const rewritten = new Set<string>();
  /**
   * Files whose owner does not exist yet. The `hermes` user is created by a
   * `commands` entry, which runs after `files` — so the chown is retried once
   * the post-steps have had their turn.
   */
  const deferredChowns: RenderedFile[] = [];
  for (const file of manifest.files) {
    if ((await write(file.path, file.content, file.mode)) === "content") {
      rewritten.add(file.path);
    }
    const outcome = await ensureOwnership(host, file, dry);
    if (outcome === "deferred") deferredChowns.push(file);
    else if (outcome === "changed") {
      result.changed.push(file.path);
      result.ownershipCorrected.push(file.path);
    }
  }
  emit(
    opEvent(
      "files",
      0.55,
      rewritten.size === 0 ? "no content drift" : `${rewritten.size} file(s) written`,
      at(),
    ),
  );

  // ─── 3b. Runtime secrets → tmpfs EnvironmentFile (§6.4, §8.3) ──────────────
  const keyEnv = PROVIDERS[manifest.provider].env;
  if (manifest.secrets_mode === "bitwarden" && !opts.bwsToken) {
    throw new AgentdError(
      "INTERNAL",
      `manifest sets secrets_mode: bitwarden but no bws token was resolved for ${manifest.name}`,
    );
  }
  if (keyEnv !== null && !opts.providerKey) {
    throw new AgentdError(
      "INTERNAL",
      `manifest sets provider: ${manifest.provider} but no ${keyEnv} was resolved for ${manifest.name}`,
    );
  }
  /**
   * **Unconditional**, and that is the change §8.3 needed.
   *
   * It used to run only when the manifest *had* something to put in the file,
   * which made the one case that matters invisible: an agent moved from a keyed
   * provider onto Bedrock has no key, so the step was skipped, so the previous
   * provider's key stayed in `secrets.env` and Hermes went on finding it in the
   * environment. `materialiseSecrets` writes the file the manifest describes —
   * empty when the manifest describes nothing — so the stale line goes with the
   * binding that put it there.
   *
   * It is the same file `hermetic-secrets.service` writes at boot, with the
   * same content for the same manifest, so this does not take authorship away
   * from that unit; it keeps the two in step between boots.
   */
  const wroteSecrets = await materialiseSecrets({
    host,
    ...(manifest.secrets_mode === "bitwarden" && opts.bwsToken
      ? { bitwarden: { token: opts.bwsToken, project: opts.bwsProject ?? manifest.name } }
      : {}),
    ...(keyEnv !== null && opts.providerKey
      ? { providerKey: { env: keyEnv, value: opts.providerKey } }
      : {}),
    ...(dry ? { dryRun: true } : {}),
  });
  if (wroteSecrets) {
    result.changed.push(SECRETS_ENV_PATH);
    result.contentChanged.push(SECRETS_ENV_PATH);
    rewritten.add(SECRETS_ENV_PATH);
  }

  // ─── 4. units ──────────────────────────────────────────────────────────────
  /**
   * First, take away the units these ones replace — before anything is enabled.
   *
   * `apply` has no general "a unit left the manifest, remove it" rule, and
   * neither of these is one: they are the two renames hermetic's own units have
   * been through. The dashboard unit took upstream's name
   * (`HERMES_LEGACY_DASHBOARD_UNIT`); the browser stack became per-identity
   * template instances (`LEGACY_BROWSER_UNITS`). In both cases the old unit is
   * still enabled on every box created before the rename, and competes with its
   * replacement for the one resource they share — `$HERMES_HOME` for the
   * dashboard, the display and the VNC ports for the browser.
   */
  const browserLegacyRemoved = await removeLegacyBrowserUnits(host, manifest, result, emit, dry);
  /**
   * Before any browser instance is enabled: `hermetic-browser@`'s
   * `ExecStartPre` creates its profile as `hermes`, which needs the directory
   * above it to be the account's.
   */
  await ensureBrowserProfileRoot(host, manifest, dry);
  const dashboardLegacyRemoved = manifest.units.includes(HERMES_DASHBOARD_UNIT)
    ? await removeLegacyDashboardUnit(host, result, emit, dry)
    : false;
  const legacyRemoved = browserLegacyRemoved || dashboardLegacyRemoved;

  const unitFilesChanged = [...rewritten].some((p) => p.startsWith(UNIT_DIR + "/"));
  // `legacyRemoved` already reloaded, after removing the file and with every
  // rendered file of this apply on disk — a second reload would say nothing new.
  if ((unitFilesChanged || hermesChanged) && !legacyRemoved) {
    emit(opEvent("units", 0.65, "systemctl daemon-reload", at()));
    if (!dry) await must(host, ["systemctl", "daemon-reload"]);
  }

  /**
   * Units this apply enabled for the first time.
   *
   * `systemctl enable` only writes a symlink for the next boot; it starts
   * nothing. A unit hermeticd *renders* is started anyway, because its file was
   * just written and the restart pass below catches it. A unit the manifest
   * merely lists — nginx's package-provided `nginx.service`, the loopback proxy
   * in front of Hermes — has no rendered file to change, so without this it
   * would be enabled and left stopped until the box next rebooted.
   */
  const newlyEnabled = new Set<string>();
  for (const unit of manifest.units) {
    const isEnabled = await host.exec(["systemctl", "is-enabled", unit]);
    if (isEnabled.code !== 0 || isEnabled.stdout.trim() !== "enabled") {
      // Not on a dry run: nothing has been written yet, so a unit this very
      // manifest renders is not on disk either, and the plan must not fail on
      // what the real run would create a phase earlier.
      if (!dry) await requireKnownUnit(host, manifest, unit, isEnabled);
      if (!dry) await must(host, ["systemctl", "enable", unit]);
      result.enabled.push(unit);
      newlyEnabled.add(unit);
    }
  }

  /**
   * Units a *non-unit* file asked for by name, and only where that file's
   * content actually changed this run (`RenderedFile.restart_units`).
   *
   * This is the narrow exception to "a file a unit merely reads does not force a
   * restart". The rule is still the right default — it is what stops every apply
   * from bouncing every service — but it left Hermes reading a config file it
   * would never be told had moved. A file that declares its dependents closes
   * that without giving up the default: nothing restarts unless something it
   * named was rewritten.
   *
   * `unit` here is whatever the manifest wrote, and the loop below is over
   * `manifest.units`, so a name that is not a declared unit is ignored rather
   * than handed to systemctl.
   */
  const watchTriggered = new Set<string>();
  for (const file of manifest.files) {
    if (!file.restart_units || !rewritten.has(file.path)) continue;
    for (const unit of file.restart_units) watchTriggered.add(unit);
  }
  /**
   * The same exception, for the one input that is not a file at all: a Hermes
   * install rewrites the venv and the checkout both units execute out of, and
   * neither unit's *own* file changed to say so. Without this the daemon-reload
   * below happened and nothing restarted, so a box that had just been moved to
   * a new `hermes_ref` went on running the old code until something else
   * bounced it. `ensureHermes` stopped them before the swap; this is what
   * starts them again.
   *
   * `revisionChanged` is the same gap one file further out: `HERMES_REVISION_ENV`
   * is hermeticd's, not a rendered file, so it cannot declare `restart_units`,
   * and an `EnvironmentFile` that moves after a process started does not reach
   * that process.
   */
  if (hermesChanged || revisionChanged) {
    watchTriggered.add(HERMES_DASHBOARD_UNIT);
    watchTriggered.add(HERMES_GATEWAY_UNIT);
  }
  /**
   * …and the same again for a swap that *did not finish*.
   *
   * `hermesChanged` only answers for this apply. An apply that stopped both
   * units and then failed anywhere before here — Node, the npm workspaces, the
   * gateway installer, a secret that would not resolve — left them down, and it
   * also left the ref marker and the reported version matching, so the next
   * apply's `ensureHermes` returns `false` and nothing would restart them.
   * The pending record is what survives that failure, and draining it here
   * makes the repair the ordinary thing an apply does rather than something an
   * operator has to go and do by hand. It covers every other crash between a
   * file write and a restart too, for the same reason and by the same route:
   * the obligation was written down before the change was made.
   */
  const owed = (await readApplyPending(host))?.units ?? owedBefore;
  for (const unit of owed) watchTriggered.add(unit);

  // Only units whose OWN file changed restart — plus the ones just enabled,
  // which are not running yet, the ones a rewritten file named, the ones a
  // previous apply left owed, and the gateway on the apply that installed it. A
  // file the unit merely *reads* and does not name does not force a restart;
  // that is the manifest author's job via `commands` (an nginx whose rendered
  // `nginx.conf` changed is reloaded by a post-step, not by this).
  // `restart` rather than `start`: it is the one verb that is correct whether or
  // not the unit happens to be up already.
  //
  // The gateway needs its own clause because `hermes gateway install` enables
  // it as well as writing it, so `is-enabled` already answers `enabled` by the
  // time the loop above runs and the unit is neither newly enabled nor rendered
  // by hermetic — it would be left installed and stopped.
  const toRestart = manifest.units.filter(
    (unit) =>
      rewritten.has(`${UNIT_DIR}/${unit}`) ||
      newlyEnabled.has(unit) ||
      watchTriggered.has(unit) ||
      (gatewayInstalled && unit === HERMES_GATEWAY_UNIT),
  );
  // The obligation restated, now that it is a fact rather than a prediction:
  // these units, and no others, are what this apply owes from here.
  if (!dry) await writeApplyPending(host, toRestart, manifest.config_hash);
  for (const unit of toRestart) {
    emit(opEvent("units", 0.75, `restarting ${unit}`, at()));
    if (!dry) await must(host, ["systemctl", "restart", unit]);
    result.restarted.push(unit);
    // After the restart, never before it: a `must` that throws has to leave the
    // next apply the same instruction this one was given.
    if (!dry) await dropApplyPendingUnit(host, unit);
  }

  // Everything owed is up again, so the record has nothing left to say.
  // (`HERMES_LEGACY_DASHBOARD_UNIT` can be in it and not in `manifest.units`, so
  // it is not restarted above — it is the unit the units phase has just deleted,
  // and a deleted unit needs no start.)
  if (!dry) await clearApplyPending(host);

  /**
   * The superseded Chrome trees, now that nothing is running from them.
   *
   * Here rather than beside the unpack, which is two phases earlier: until the
   * restart above, `hermetic-browser@` is still executing the old build, and
   * anything between the two phases can fail and leave that restart undone —
   * so a prune at the install site could strand a live unit on a binary it had
   * just deleted. See `pruneSupersededBuilds`.
   *
   * Only when this apply is the one that installed the build, which is also
   * when it is the one that restarted the browser onto it: the env file's
   * `CHROME_BIN` moved, so the units phase above restarted every instance. An
   * apply that found the pinned build already unpacked changed neither, so it
   * has no reason to believe anything stopped running from the old tree — and
   * deleting it on that belief is exactly the failure this ordering exists to
   * avoid. A leftover tree costs disk; a deleted one costs the browser.
   */
  if (!dry && chrome?.installed === true) await pruneSupersededBuilds(host, chrome.ref, emit);

  // ─── 5. commands ───────────────────────────────────────────────────────────
  /**
   * A post-step that fails stops the apply where it stands: the remaining
   * commands do not run, and neither does the deferred-ownership pass below.
   *
   * That is the deliberate half of it, not an accident of where the `throw`
   * happens to be. A deferred chown is deferred precisely because the account
   * it names does not exist yet, and the thing that was going to create it is a
   * `commands` entry — so running the pass after a failed command is either a
   * no-op or a `chown` onto whatever half-made account the failure left behind.
   * Stopping also keeps the invariant the rest of `apply` is built on: every
   * path here is idempotent, so the repair for a partial apply is to run it
   * again once the post-step's own problem is fixed, and a rerun redoes the
   * ownership pass from a box that has moved on. `apply` is re-entered on every
   * boot and by `hermetic agent rerun`, so "stop and be re-run" is a supported
   * state in a way "carry on past a failure" is not.
   *
   * What it costs is named: the `ApplyResult` is lost with the throw, so what
   * *did* change is only in the emitted events and the box itself.
   */
  for (const [i, command] of manifest.commands.entries()) {
    emit(
      opEvent(
        "commands",
        0.8 + (0.15 * (i + 1)) / Math.max(1, manifest.commands.length),
        command,
        at(),
      ),
    );
    if (!dry) {
      const res = await host.exec(["/bin/sh", "-c", command]);
      if (res.code !== 0) {
        throw new AgentdError("COMMAND_FAILED", `post-step failed: ${command}`, {
          command,
          code: res.code,
        });
      }
    }
    result.commands.push(command);
  }

  // ─── 6. deferred ownership ─────────────────────────────────────────────────
  for (const file of deferredChowns) {
    emit(opEvent("files", 0.97, `setting ownership on ${file.path}`, at()));
    const outcome = await ensureOwnership(host, file, dry, { final: true });
    if (outcome === "changed") {
      result.changed.push(file.path);
      result.ownershipCorrected.push(file.path);
    }
  }

  /**
   * Last, and only here: the box's record that it is *running* this
   * configuration (`manifest.ts`). Everything above can fail, and a failure
   * anywhere must leave the previous hash standing — a half-applied box that
   * reports the new one is a box the fleet reads as converged when it is not.
   * A dry run applied nothing and records nothing.
   */
  if (!dry) await recordAppliedConfig(host, manifest.config_hash);

  emit(
    opEvent(
      "done",
      1,
      `${result.changed.length} change(s), ${result.restarted.length} restart(s)`,
      at(),
    ),
  );
  return result;
}
