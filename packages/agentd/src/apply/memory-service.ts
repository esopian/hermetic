/**
 * A service memory provider's server, box side (the `memory-service`
 * capability): the pinned release in its own venv on the data volume, the
 * model it would otherwise fetch inside the first recall, and the Hermes
 * plugin that talks to it — everything about `hermetic-memory.service` that is
 * not a rendered file.
 *
 * The unit file, the server's configuration (OpenViking's `ov.conf` under
 * `/etc/hermetic/memory`; Hindsight's plugin is configured by `HINDSIGHT_*`
 * lines in the Hermes units) and the managed `memory.provider` are the
 * laptop's, rendered and landed by the files phase like any other file.
 * The credential the server's own model calls use is `secrets.ts`
 * (`materialiseMemoryLlm`).
 *
 * Every step runs as the `hermes` account, not as root, for the reason
 * `installAccountDir` gives: all of it lives under `/data/hermes`, whose names
 * the account can replace with symlinks, so a root write there could be
 * steered anywhere and an unprivileged one cannot gain anything. Every step
 * probes first, so a converged box runs no `uv`, `git` or `curl`.
 */
import type { AgentConfig } from "@hermetic/core/schema";
import {
  HONCHO_PLUGIN_CONFIG_LINK,
  MEMORY_SERVICE_ROOT,
  MEMORY_SERVICE_UNIT,
  MEMORY_SERVICE_UNITS,
  OPENVIKING_DATA_DIRS,
  hermesPluginDir,
  honchoClientConfPath,
  memoryServiceDir,
  memoryServiceOf,
  type MemoryProvider,
  type MemoryServiceId,
  type MemoryServiceSpec,
} from "@hermetic/core/shared";
import { asHermes, installAccountDir } from "../account-dirs.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { HERMES_USER } from "./accounts.ts";
import { UV_ENV } from "./hermes.ts";
import { ensureHoncho, linkTarget } from "./memory-honcho.ts";
import {
  ACCOUNT_ENV,
  ACCOUNT_EXEC,
  MEMORY_PIN_MARKER,
  NET_ATTEMPTS,
  NET_RETRY_MS,
  ensureCheckout,
  writeAsHermes,
} from "./memory-shared.ts";
import type { ApplyResult } from "./shared.ts";
import { UNIT_DIR, retry } from "./shared.ts";

export { MEMORY_PIN_MARKER, PLUGIN_REF_MARKER } from "./memory-shared.ts";

export const MEMORY_SERVICE_UNIT_PATH = `${UNIT_DIR}/${MEMORY_SERVICE_UNIT}`;

/**
 * The directories under the service dir each server writes into, made by
 * hermeticd so the rendered configuration can name them and the unit never
 * has to create anything: Hugging Face's cache for Hindsight's embedding and
 * reranker models; OpenViking's two stores (`OPENVIKING_DATA_DIRS`) and the
 * GGUF model `ensureModel` seeds;
 * honcho's tiktoken cache. (honcho's `src` and `pg` are moved into place
 * whole, so neither is made here.)
 */
const SERVICE_SUBDIRS: Readonly<Record<MemoryServiceId, readonly string[]>> = {
  hindsight: ["hf"],
  // One store per embedding mode, both made so a flip finds its own.
  openviking: [OPENVIKING_DATA_DIRS.local, OPENVIKING_DATA_DIRS.remote, "models"],
  honcho: ["tiktoken"],
};

function isServiceId(provider: MemoryProvider | undefined): provider is MemoryServiceId {
  return provider === "hindsight" || provider === "openviking" || provider === "honcho";
}

/** The provider and its pinned server, when the manifest names a service provider at all. */
function serviceOf(
  manifest: AgentConfig,
): { provider: MemoryServiceId; spec: MemoryServiceSpec } | null {
  const provider = manifest.memory?.provider;
  if (!isServiceId(provider)) return null;
  const spec = memoryServiceOf(provider);
  return spec === null ? null : { provider, spec };
}

/**
 * Refuse a manifest whose `memory.pin` is not the release this hermeticd
 * installs — first, before anything is touched.
 *
 * The pin names a release the box must install *by that name*; a hermeticd
 * built against another would install what it knows under the manifest's
 * name, and the laptop would believe a version the box is not running. The
 * remedy is a matching hermeticd, which only the laptop can publish.
 */
export function assertMemoryPin(manifest: AgentConfig): void {
  const memory = manifest.memory;
  if (!memory?.pin) return;
  const ours = memoryServiceOf(memory.provider)?.pin ?? null;
  if (ours === memory.pin) return;
  throw new AgentdError(
    "MANIFEST_REFUSED",
    `manifest pins ${memory.provider} ${memory.pin}; this hermeticd installs ` +
      `${ours ?? "no server for it"} — push a matching hermeticd (hermetic artifacts push), ` +
      "then recreate the agent so it fetches it",
    { provider: memory.provider, pin: memory.pin, supported: ours },
  );
}

/**
 * Install everything the pinned server needs that is not a rendered file.
 *
 * A no-op (`installed: false`) for a manifest with no `memory.pin`: an
 * in-process provider, or none. Otherwise, in order and each idempotent:
 *
 * 1. the service dir and its subdirectories, the account's, 0750;
 * 2. the venv, and the pinned packages in it, recorded in `MEMORY_PIN_MARKER`;
 * 3. the model file, when the spec seeds one, verified by size and sha256;
 * 4. the Hermes plugin, when the spec names one, at its pinned commit.
 *
 * A server built from a source checkout (honcho) replaces 2-4 with its own
 * steps (`memory-honcho.ts`): distro Postgres, a second managed Python, the
 * checkout and its locked sync, the database cluster and the plugin's config
 * link.
 *
 * Before the files phase, so the server's directories exist, the account's,
 * before anything else could create them. After `ensureHermes`, which
 * puts `uv` and the uv-managed Python 3.11 on the box (the venv is built on
 * that interpreter, as the account, which could not install one into the
 * root-owned `UV_PYTHON_INSTALL_DIR` itself), and after `ensureAccounts`.
 *
 * Returns `installed: true` when any of 2-4 (or of honcho's steps) did (or,
 * on a dry run, would do) work — the caller restarts the server and Hermes
 * then.
 */
export async function ensureMemoryService(input: {
  host: Host;
  manifest: AgentConfig;
  emit: Emit;
  dryRun: boolean;
  result?: ApplyResult;
}): Promise<{ installed: boolean }> {
  const { host, manifest, emit, dryRun: dry } = input;
  if (!manifest.memory?.pin) return { installed: false };
  const service = serviceOf(manifest);
  if (service === null) return { installed: false };
  const { provider, spec } = service;
  const dir = memoryServiceDir(provider);

  if (!dry) await ensureServiceDirs(host, provider, dir);
  if (spec.source !== null) {
    return ensureHoncho({
      host,
      spec,
      dir,
      emit,
      dry,
      ...(input.result ? { result: input.result } : {}),
    });
  }
  const venv = await ensureServiceVenv(host, provider, spec, dir, emit, dry);
  const model = await ensureModel(host, provider, spec, dir, emit, dry);
  const plugin = await ensurePlugin(host, provider, spec, emit, dry);

  if (input.result) {
    if (venv) input.result.installed.push(`memory:${spec.pin}`);
    if (model && spec.model) input.result.installed.push(`model:${spec.model.file}`);
    if (plugin && spec.plugin) input.result.installed.push(`plugin:${provider}@${spec.plugin.sha}`);
  }
  return { installed: venv || model || plugin };
}

/**
 * `MEMORY_SERVICE_ROOT`, the provider's dir and its subdirectories, as the
 * account — so the account owns them by construction, and nothing root
 * writes lands under them (the server's config is under `/etc/hermetic`).
 *
 * The one exception is the root itself, re-owned non-recursively (`-h`, so a
 * symlink in its place is changed, not followed) when it already exists: a
 * root-owned one, left by an operator, would otherwise make the unprivileged
 * `install -d` fail to set its mode. Never removed, by this or anything else:
 * it holds the agent's memory.
 *
 * The provider's dir (honcho's cluster under it included) is re-owned
 * recursively, as root, when anything in it no longer belongs to the account
 * (`reownAccountTree`).
 */
async function ensureServiceDirs(host: Host, provider: MemoryServiceId, dir: string): Promise<void> {
  const found = await host.lstat(MEMORY_SERVICE_ROOT);
  if (found?.isDirectory && !found.isSymlink) {
    await must(host, ["chown", "-h", `${HERMES_USER}:${HERMES_USER}`, MEMORY_SERVICE_ROOT]);
  }
  // The whole provider dir, honcho's cluster (`pg`) included: the probe walks it.
  await reownAccountTree(host, dir);
  await installAccountDir(host, MEMORY_SERVICE_ROOT, "0750");
  await installAccountDir(host, dir, "0750");
  for (const sub of SERVICE_SUBDIRS[provider]) await installAccountDir(host, `${dir}/${sub}`, "0750");
}

/**
 * Give `path` and everything under it back to the account when anything in
 * it is not the account's — probed first, over the whole tree, so a converged
 * box runs no `chown`.
 *
 * The `hermes` account is a `useradd --system` with no fixed uid, so a
 * recreate can allocate it another one, and the data volume still carries
 * the old. Most of the service would merely fail to write; Postgres refuses
 * to start on a data directory it does not own, so honcho's database (and the
 * API and worker behind it) would stay down for good.
 *
 * The probe is `find` for the first entry not owned by `hermes:hermes`, not a
 * `stat` of the top: `chown -R` re-owns the top first, so a re-own killed
 * part-way leaves a tree whose top is right and whose children are not, and
 * only a walk sees that. `-xdev` and no `-L`: it stays on the data volume and
 * never follows a link. A `find` that exits non-zero having printed nothing
 * (a file Postgres removed mid-walk) re-owns nothing; the next apply asks
 * again.
 *
 * As root, because only root can, with `-h` and no `-L`: a symlink planted in
 * the tree is re-owned itself and never followed — the pattern
 * `ensureHermesHomeOwnership` uses over `$HERMES_HOME`. A symlink at `path`
 * itself is left alone for `installAccountDir` to refuse by name. Modes are
 * not touched, so the cluster keeps the 0700 Postgres requires.
 */
async function reownAccountTree(host: Host, path: string): Promise<void> {
  const found = await host.lstat(path);
  if (found === null || !found.isDirectory || found.isSymlink) return;
  const foreign = await host.exec([
    "find",
    path,
    "-xdev",
    "(",
    "!",
    "-user",
    HERMES_USER,
    "-o",
    "!",
    "-group",
    HERMES_USER,
    ")",
    "-print",
    "-quit",
  ]);
  if (foreign.stdout.trim() === "") return;
  await must(host, ["chown", "-R", "-h", `${HERMES_USER}:${HERMES_USER}`, path]);
}

/**
 * The venv and the pinned packages, once per pin.
 *
 * Built only when its interpreter is absent, like Hermes's own; a pin change
 * re-runs the install over it, which moves every exact `==` spec. The marker
 * is written last, so an install that fails part-way is retried in full by the
 * next apply rather than recorded as done.
 *
 * An interpreter can be absent from a venv that is otherwise there: the venv
 * is on the data volume, but the uv-managed Python its `bin/python` links to
 * is on the root volume, which a recreate replaces — possibly with another
 * 3.11 patch release. That venv is rebuilt with `--clear` (uv no longer
 * overwrites one without it) and the install repopulates it, whatever the
 * marker says.
 *
 * `--no-cache`: `HOME` is the account's, so uv's wheel cache would otherwise
 * be hundreds of megabytes on the snapshotted data volume, kept for nothing.
 */
async function ensureServiceVenv(
  host: Host,
  provider: MemoryProvider,
  spec: MemoryServiceSpec,
  dir: string,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const marker = `${dir}/${MEMORY_PIN_MARKER}`;
  const venv = `${dir}/venv`;
  const python = `${venv}/bin/python`;
  const hasPython = (await host.stat(python)) !== null;
  if (hasPython && (await host.readFile(marker))?.trim() === spec.pin) {
    emit(opEvent("packages", 0.36, `${provider} server ${spec.pin} already installed`, host.now()));
    return false;
  }
  emit(opEvent("packages", 0.36, `installing the ${provider} server (${spec.pin})`, host.now()));
  if (dry) return true;

  const env = { ...UV_ENV, ...ACCOUNT_ENV };
  if (!hasPython) {
    const stale = (await host.lstat(venv)) !== null;
    await must(
      host,
      asHermes([
        "uv",
        "venv",
        "--no-config",
        ...(stale ? ["--clear"] : []),
        "--python",
        spec.python,
        venv,
      ]),
      { env, ...ACCOUNT_EXEC },
    );
  }
  const argv = ["uv", "pip", "install", "--no-config", "--no-cache", "--python", python];
  for (const index of spec.extra_index) argv.push("--extra-index-url", index);
  for (const dist of spec.only_binary) argv.push("--only-binary", dist);
  argv.push(...spec.packages);
  await retry(host, NET_ATTEMPTS, NET_RETRY_MS, () =>
    must(host, asHermes(argv), { env, ...ACCOUNT_EXEC }),
  );
  await writeAsHermes(host, marker, `${spec.pin}\n`);
  return true;
}

/**
 * The model file the server would otherwise download inside its first
 * embedding call — longer than Hermes waits for a recall.
 *
 * Downloaded beside its final name and renamed into place only once both its
 * size and its sha256 match the spec, so a truncated or substituted file is
 * never where the server looks; a mismatch removes the partial file and fails
 * the apply with `CHECKSUM_MISMATCH`.
 */
async function ensureModel(
  host: Host,
  provider: MemoryProvider,
  spec: MemoryServiceSpec,
  dir: string,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const model = spec.model;
  if (model === null) return false;
  const target = `${dir}/models/${model.file}`;
  const present = await host.stat(target);
  if (present?.size === model.size && (await host.sha256File(target)) === model.sha256) return false;

  emit(opEvent("packages", 0.37, `downloading the ${provider} model ${model.file}`, host.now()));
  if (dry) return true;
  const part = `${dir}/models/.${model.file}.part`;
  await must(host, asHermes(["rm", "-f", part]), ACCOUNT_EXEC);
  await must(
    host,
    asHermes(["curl", "-fsSL", "--retry", String(NET_ATTEMPTS), "-o", part, model.url]),
    { env: { ...ACCOUNT_ENV }, ...ACCOUNT_EXEC },
  );
  const size = (await host.stat(part))?.size ?? null;
  const sum = await host.sha256File(part);
  if (size !== model.size || sum !== model.sha256) {
    await must(host, asHermes(["rm", "-f", part]), ACCOUNT_EXEC);
    throw new AgentdError(
      "CHECKSUM_MISMATCH",
      `the ${provider} model ${model.file} from ${model.url} is not the pinned file ` +
        `(want ${model.size} bytes, sha256 ${model.sha256}; got ${size ?? "nothing"} bytes, sha256 ${sum ?? "none"})`,
      { url: model.url, want: model.sha256, got: sum, size },
    );
  }
  await must(host, asHermes(["mv", "-f", "-T", part, target]), ACCOUNT_EXEC);
  return true;
}

/**
 * The Hermes plugin for the provider, at the commit the spec pins, in
 * `hermesPluginDir(<provider>)`: a sparse checkout of just the plugin's
 * subdirectory (`ensureCheckout`).
 */
async function ensurePlugin(
  host: Host,
  provider: MemoryProvider,
  spec: MemoryServiceSpec,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const plugin = spec.plugin;
  if (plugin === null) return false;
  return ensureCheckout(
    host,
    {
      repo: plugin.repo,
      sha: plugin.sha,
      subdir: plugin.subdir,
      target: hermesPluginDir(provider),
      label: `the ${provider} Hermes plugin ${plugin.version}`,
    },
    emit,
    dry,
    0.38,
  );
}

/**
 * Take a memory server's units away from an agent whose manifest no longer
 * lists them, and honcho's plugin config link from one no longer on honcho.
 *
 * Not for a recreate: the units are on the root volume, which a recreate
 * replaces, so the new box never had them. It is for a box whose manifest
 * changes under it — a provider changed in place (honcho → hindsight leaves
 * honcho's worker and database behind, while `MEMORY_SERVICE_UNIT` becomes
 * hindsight's), dropped, or removed from the catalogue (a stored row then
 * reads as no provider) — where a unit would otherwise stay enabled with
 * nothing rendering it.
 *
 * `apply` has no general rule for a unit that left the manifest (see
 * `removeLegacyDashboardUnit`), so this one is named: every
 * `MEMORY_SERVICE_UNITS` member on disk and not in `manifest.units` is
 * disabled, stopped and deleted, with one daemon-reload after them. The names
 * are hermetic's own, so no marker is asked of the files. Only the units go:
 * `MEMORY_SERVICE_ROOT` (honcho's database included) is the agent's memory and
 * outlives any provider choice (§1), and the Postgres packages stay installed —
 * with the distro's cluster never created and this unit gone, nothing of them
 * runs. Reloads systemd itself, like the legacy removals, so the caller can
 * skip its own reload; a dry run reports the paths and emits nothing.
 *
 * Returns whether it removed (and so reloaded) any unit.
 */
export async function removeMemoryService(
  host: Host,
  manifest: AgentConfig,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  await removeHonchoLink(host, manifest, result, emit, dry);
  const gone: string[] = [];
  for (const unit of MEMORY_SERVICE_UNITS) {
    if (manifest.units.includes(unit)) continue;
    if ((await host.lstat(`${UNIT_DIR}/${unit}`)) !== null) gone.push(unit);
  }
  if (gone.length === 0) return false;
  for (const unit of gone) result.changed.push(`${UNIT_DIR}/${unit}`);
  if (dry) return false;
  for (const unit of gone) {
    emit(
      opEvent(
        "units",
        0.6,
        `removing ${unit}: the agent's memory provider no longer runs it (its data under ${MEMORY_SERVICE_ROOT} is kept)`,
        host.now(),
      ),
    );
    await must(host, ["systemctl", "disable", "--now", unit]);
    await host.remove(`${UNIT_DIR}/${unit}`);
  }
  await must(host, ["systemctl", "daemon-reload"]);
  return true;
}

/**
 * `HONCHO_PLUGIN_CONFIG_LINK`, once the agent is not on honcho — and only the
 * link hermeticd made (a symlink to `honchoClientConfPath`): an operator's own
 * file or link is theirs. Removed as the account, whose `$HERMES_HOME` it is in.
 */
async function removeHonchoLink(
  host: Host,
  manifest: AgentConfig,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<void> {
  if (manifest.memory?.provider === "honcho") return;
  const found = await host.lstat(HONCHO_PLUGIN_CONFIG_LINK);
  if (found?.isSymlink !== true) return;
  if ((await linkTarget(host, HONCHO_PLUGIN_CONFIG_LINK)) !== honchoClientConfPath) return;
  result.changed.push(HONCHO_PLUGIN_CONFIG_LINK);
  if (dry) return;
  emit(
    opEvent(
      "units",
      0.6,
      `removing ${HONCHO_PLUGIN_CONFIG_LINK}: the agent is no longer on honcho`,
      host.now(),
    ),
  );
  await must(host, asHermes(["rm", "-f", HONCHO_PLUGIN_CONFIG_LINK]), ACCOUNT_EXEC);
}
