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
  HERMES_ACCOUNT_HOME,
  MEMORY_SERVICE_ROOT,
  MEMORY_SERVICE_UNIT,
  hermesPluginDir,
  memoryServiceDir,
  memoryServiceOf,
  type MemoryProvider,
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
import type { ApplyResult } from "./shared.ts";
import { UNIT_DIR, retry } from "./shared.ts";

export const MEMORY_SERVICE_UNIT_PATH = `${UNIT_DIR}/${MEMORY_SERVICE_UNIT}`;

/** In the service dir: the pin whose packages the venv last received. */
export const MEMORY_PIN_MARKER = ".hermetic-pin";
/** In the plugin dir: the commit it was checked out at. */
export const PLUGIN_REF_MARKER = ".hermetic-ref";

/** Same budget as the Hermes checkout and its pip install: both are third parties. */
const NET_ATTEMPTS = 3;
const NET_RETRY_MS = 5_000;

/**
 * `HOME` is the account's because `runuser` keeps root's, and uv's cache, git's
 * config and curl's `.curlrc` would otherwise be read out of `/root`. The
 * account's home is also the working directory, because uv reads a `uv.toml`
 * out of whatever directory it starts in (`--no-config` as well, for the same
 * reason as `ensureAgentVenv`).
 */
const ACCOUNT_EXEC = { cwd: HERMES_ACCOUNT_HOME } as const;
const ACCOUNT_ENV = { HOME: HERMES_ACCOUNT_HOME } as const;
/** A clone that would otherwise block forever asking an unattended box to log in. */
const GIT_ENV = { ...ACCOUNT_ENV, GIT_TERMINAL_PROMPT: "0" } as const;

/**
 * The directories under the service dir each server writes into, made by
 * hermeticd so the rendered configuration can name them and the unit never
 * has to create anything: Hugging Face's cache for Hindsight's embedding and
 * reranker models; OpenViking's data and the GGUF model `ensureModel` seeds.
 */
const SERVICE_SUBDIRS: Readonly<Record<"hindsight" | "openviking", readonly string[]>> = {
  hindsight: ["hf"],
  openviking: ["data", "models"],
};

/** The provider and its pinned server, when the manifest names a service provider at all. */
function serviceOf(
  manifest: AgentConfig,
): { provider: "hindsight" | "openviking"; spec: MemoryServiceSpec } | null {
  const provider = manifest.memory?.provider;
  if (provider !== "hindsight" && provider !== "openviking") return null;
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
 * Before the files phase, so the server's directories exist, the account's,
 * before anything else could create them. After `ensureHermes`, which
 * puts `uv` and the uv-managed Python 3.11 on the box (the venv is built on
 * that interpreter, as the account, which could not install one into the
 * root-owned `UV_PYTHON_INSTALL_DIR` itself), and after `ensureAccounts`.
 *
 * Returns `installed: true` when any of 2-4 did (or, on a dry run, would do)
 * work — the caller restarts the server and Hermes then.
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
 */
async function ensureServiceDirs(
  host: Host,
  provider: "hindsight" | "openviking",
  dir: string,
): Promise<void> {
  const found = await host.lstat(MEMORY_SERVICE_ROOT);
  if (found?.isDirectory && !found.isSymlink) {
    await must(host, ["chown", "-h", `${HERMES_USER}:${HERMES_USER}`, MEMORY_SERVICE_ROOT]);
  }
  await installAccountDir(host, MEMORY_SERVICE_ROOT, "0750");
  await installAccountDir(host, dir, "0750");
  for (const sub of SERVICE_SUBDIRS[provider]) await installAccountDir(host, `${dir}/${sub}`, "0750");
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
 * `hermesPluginDir(<provider>)`.
 *
 * A blobless, sparse clone of just the plugin's subdirectory into a sibling
 * dot-directory, then moved over the old checkout. The marker inside the
 * checkout is the record: a dir without it, or with another commit in it, is
 * replaced; one that matches is left alone, edits and all.
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
  const target = hermesPluginDir(provider);
  const marker = `${target}/${PLUGIN_REF_MARKER}`;
  if ((await host.readFile(marker))?.trim() === plugin.sha) return false;

  emit(
    opEvent(
      "packages",
      0.38,
      `checking out the ${provider} Hermes plugin ${plugin.version} (${plugin.sha.slice(0, 12)})`,
      host.now(),
    ),
  );
  if (dry) return true;

  const parent = target.slice(0, target.lastIndexOf("/"));
  if ((await host.stat(parent))?.isDirectory !== true) await installAccountDir(host, parent, "0750");
  const clone = `${parent}/.${provider}.clone`;
  const git = { env: { ...GIT_ENV }, ...ACCOUNT_EXEC };
  // The checkout fetches the subdirectory's blobs, so it is network too and
  // sits inside the retry; each attempt starts from no clone at all.
  await retry(host, NET_ATTEMPTS, NET_RETRY_MS, async () => {
    await must(host, asHermes(["rm", "-rf", clone]), ACCOUNT_EXEC);
    await must(
      host,
      asHermes(["git", "clone", "--filter=blob:none", "--no-checkout", "--quiet", plugin.repo, clone]),
      git,
    );
    await must(
      host,
      asHermes(["git", "-C", clone, "sparse-checkout", "set", "--no-cone", plugin.subdir]),
      git,
    );
    await must(host, asHermes(["git", "-C", clone, "checkout", "--quiet", plugin.sha]), git);
  });
  await must(host, asHermes(["rm", "-rf", target]), ACCOUNT_EXEC);
  await must(host, asHermes(["mv", "-T", `${clone}/${plugin.subdir}`, target]), ACCOUNT_EXEC);
  await must(host, asHermes(["rm", "-rf", clone]), ACCOUNT_EXEC);
  await writeAsHermes(host, marker, `${plugin.sha}\n`);
  return true;
}

/** A small file written by the account (`tee`, fed on stdin), for the reason the module header gives. */
async function writeAsHermes(host: Host, path: string, content: string): Promise<void> {
  await must(host, asHermes(["tee", path]), { stdin: content, ...ACCOUNT_EXEC });
}

/**
 * Take `hermetic-memory.service` away from an agent whose manifest no longer
 * names a service provider.
 *
 * Not for a recreate: the unit is on the root volume, which a recreate
 * replaces, so the new box never had it. It is for a box whose manifest
 * changes under it — a provider removed from the catalogue (a stored row
 * then reads as no provider), or an in-place provider change should one ever
 * exist — where the unit would otherwise stay enabled with nothing rendering it.
 *
 * `apply` has no general rule for a unit that left the manifest (see
 * `removeLegacyDashboardUnit`), so this one is named. The unit's name is
 * hermetic's own, so no marker is asked of the file. Only the unit goes:
 * `MEMORY_SERVICE_ROOT` is the agent's memory and outlives any provider
 * choice (§1). Reloads systemd itself, like the legacy removals, so the
 * caller can skip its own reload; a dry run reports the file and emits nothing.
 *
 * Returns whether it removed the unit.
 */
export async function removeMemoryService(
  host: Host,
  manifest: AgentConfig,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  if (serviceOf(manifest) !== null || manifest.units.includes(MEMORY_SERVICE_UNIT)) return false;
  if ((await host.lstat(MEMORY_SERVICE_UNIT_PATH)) === null) return false;
  result.changed.push(MEMORY_SERVICE_UNIT_PATH);
  if (dry) return false;
  emit(
    opEvent(
      "units",
      0.6,
      `removing ${MEMORY_SERVICE_UNIT}: the agent has no memory server any more (its data under ${MEMORY_SERVICE_ROOT} is kept)`,
      host.now(),
    ),
  );
  await must(host, ["systemctl", "disable", "--now", MEMORY_SERVICE_UNIT]);
  await host.remove(MEMORY_SERVICE_UNIT_PATH);
  await must(host, ["systemctl", "daemon-reload"]);
  return true;
}
