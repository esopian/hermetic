/**
 * The Hermes external memory provider, box side: the provider's Python
 * dependencies in Hermes's venv (the `memory-provider` capability,
 * `AGENT_CONFIG_CAPABILITIES`). A service provider's own server is
 * `memory-service.ts`.
 *
 * The choice of provider itself is not here. It is `memory.provider` in the
 * managed `/etc/hermes/config.yaml`, which the laptop renders and the files
 * phase lands like any other rendered file.
 */
import type { AgentConfig } from "@hermetic/core/schema";
import { MEMORY_PROVIDERS } from "@hermetic/core/shared";
import { must } from "../host.ts";
import type { Host } from "../host.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { HERMES_VENV_DIR, UV_ENV } from "./hermes.ts";
import type { ApplyResult } from "./shared.ts";
import { retry } from "./shared.ts";

/**
 * Distribution name → the module `import` finds it under, for every dependency
 * `MEMORY_PROVIDERS` lists. The two can differ (a distribution named
 * `foo-ai` that imports as `foo`), and guessing wrong would probe the wrong
 * name and reinstall on every apply. A dependency missing from this table falls
 * back to the PEP 503-normalised name with `_` for `-`, which is right for most.
 */
const PIP_MODULES: Readonly<Record<string, string>> = {
  "hindsight-client": "hindsight_client",
  numpy: "numpy",
};

/** `hindsight-client==0.10.3` → `hindsight-client`: the distribution a requirement names. */
export function distributionOf(spec: string): string {
  return spec.split(/[<>=!~;[\s]/, 1)[0]!.toLowerCase();
}

export function importNameOf(spec: string): string {
  const dist = distributionOf(spec);
  return PIP_MODULES[dist] ?? dist.replace(/[-.]/g, "_");
}

/** Same budget as the Hermes checkout: PyPI is a third party too. */
const PIP_ATTEMPTS = 3;
const PIP_RETRY_MS = 5_000;

/**
 * Preinstall the memory provider's Python dependencies into Hermes's venv.
 *
 * Upstream lazy-installs a provider's `pip_dependencies` the first time the
 * provider is used, unless `security.allow_lazy_installs: false` forbids it —
 * in which case the provider is simply unavailable. Installing them here makes
 * the first turn deterministic (no stall on a download, no dependence on that
 * setting) and keeps the running agent off PyPI.
 *
 * Same invocation as the Hermes install (`ensureHermes`): root, `uv pip install
 * --python <venv>/bin/python`, `UV_ENV`. Each dependency is probed with an
 * `import` first and only the missing ones are installed, so a converged box
 * makes no network call. A dry run probes (a read) and reports, installing
 * nothing.
 *
 * Returns true when something was (or, on a dry run, would be) installed —
 * the caller restarts the Hermes units then, so a process that started
 * without the dependency picks it up.
 */
export async function ensureMemoryDeps(
  host: Host,
  manifest: AgentConfig,
  result: ApplyResult,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const provider = manifest.memory?.provider;
  if (!provider) return false;
  const specs = MEMORY_PROVIDERS[provider].pip;
  if (specs.length === 0) return false;

  const python = `${HERMES_VENV_DIR}/bin/python`;
  // No venv yet is only reachable on a dry run before the first Hermes
  // install; there is nothing to probe, and everything would be installed.
  const venv = (await host.stat(python)) !== null;
  const missing: string[] = [];
  for (const spec of specs) {
    const probe = venv ? await host.exec([python, "-c", `import ${importNameOf(spec)}`]) : null;
    if (probe?.code !== 0) missing.push(spec);
  }

  if (missing.length === 0) {
    emit(opEvent("packages", 0.34, `${provider} memory dependencies already installed`, host.now()));
    return false;
  }
  emit(
    opEvent(
      "packages",
      0.34,
      `installing ${provider} memory dependencies: ${missing.join(" ")}`,
      host.now(),
    ),
  );
  if (!dry) {
    await retry(host, PIP_ATTEMPTS, PIP_RETRY_MS, () =>
      must(host, ["uv", "pip", "install", "--python", python, ...missing], { env: { ...UV_ENV } }),
    );
  }
  result.installed.push(...missing.map((spec) => `pip:${spec}`));
  return true;
}
