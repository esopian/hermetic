/**
 * Runtime secrets → the tmpfs `EnvironmentFile` the rendered units read
 * (§6.4, §8.3).
 */
import type { AgentConfig } from "@hermetic/core/schema";
import {
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  MEMORY_LLM_ENV_PATH,
  MEMORY_SERVICE_UNIT,
  MEMORY_WORKER_UNIT,
  memoryServiceOf,
} from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import { sha256 } from "./shared.ts";

/**
 * Runtime secrets live on tmpfs at mode 600, never on `/data` (§8.3). This is
 * the path core's rendered `hermes-dashboard.service` names in its `EnvironmentFile=`
 * line, so the two must not drift.
 */
export const SECRETS_ENV_PATH = "/run/hermetic/secrets.env";
export const SECRETS_ENV_DIR = "/run/hermetic";

/**
 * The boot oneshot core renders on every agent (`secretsUnit`), whose
 * `ExecStart` is `hermeticd secrets materialise`: it writes `SECRETS_ENV_PATH`
 * and `MEMORY_LLM_ENV_PATH` from the manifest at `MANIFEST_PATH`.
 */
export const SECRETS_UNIT = "hermetic-secrets.service";

/**
 * Every unit core renders with `Requires=` on `SECRETS_UNIT`: both Hermes
 * units (the gateway through its drop-in), the memory server and honcho's
 * worker. They read the two files that unit writes, and systemd restarts them
 * whenever it is restarted. honcho's database reads neither and is not here.
 * `tests/seams.test.ts` holds the list against the renderer.
 */
export const SECRETS_DEPENDENTS: readonly string[] = [
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  MEMORY_SERVICE_UNIT,
  MEMORY_WORKER_UNIT,
];

/**
 * Values that need no quoting in a systemd `EnvironmentFile`. Everything else
 * is single-quoted — see `envLine`.
 */
const ENV_VALUE_SAFE = /^[A-Za-z0-9_./:@,+=-]+$/;

/**
 * One `KEY=value` line for a systemd `EnvironmentFile`.
 *
 * systemd's parser is not a shell, and its unquoted values have three edges an
 * API key never hit but an arbitrary Bitwarden secret does: leading and trailing
 * whitespace is dropped, a backslash escapes the next character, and a value
 * that begins with `'` or `"` opens a quoted string that runs to the matching
 * close. So anything
 * outside a plainly safe alphabet is single-quoted, with `\` and `'` escaped —
 * which systemd honours inside single quotes even though a POSIX shell would
 * not. A `#` is literal in a value either way; it is quoted here too, because a
 * reader should not have to know that to trust the file.
 */
export function envLine(key: string, value: string): string {
  if (ENV_VALUE_SAFE.test(value)) return `${key}=${value}`;
  return `${key}='${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * `bws secret list <project>` for this agent's own project → an
 * `EnvironmentFile` on tmpfs at mode 600 (§6.4). The token reaches `bws` through
 * the environment and the values are never logged or written under `/data`.
 *
 * The file is written even when there is nothing to put in it. The rendered
 * `hermes-dashboard.service` names it in an unconditional `EnvironmentFile=`, and systemd
 * fails a unit whose environment file is missing — so "no secrets" has to mean
 * an empty file, not no file.
 *
 * Returns true when the file's content changed.
 */
export async function materialiseSecrets(input: {
  host: Host;
  /** The provider API key and the variable it becomes; from SSM (§8.1). */
  providerKey?: { env: string; value: string };
  /** The Bitwarden machine-account token and the project it may read. */
  bitwarden?: { token: string; project: string };
  outPath?: string;
  dryRun?: boolean;
}): Promise<boolean> {
  const { host } = input;
  const outPath = input.outPath ?? SECRETS_ENV_PATH;

  // `bws secret list` is a read, so even a dry run can answer honestly whether
  // the environment file would change.
  const slash = outPath.lastIndexOf("/");
  if (!input.dryRun) {
    await host.mkdir(slash > 0 ? outPath.slice(0, slash) : SECRETS_ENV_DIR, "0700");
  }

  // The provider key comes first so a Bitwarden project that also carries one
  // wins — the project is the operator's own, and an explicit secret there is
  // a deliberate override of the slot.
  const lines: string[] = [];
  if (input.providerKey) lines.push(envLine(input.providerKey.env, input.providerKey.value));

  if (input.bitwarden) {
    const listed = await must(
      host,
      ["bws", "secret", "list", input.bitwarden.project, "--output", "json"],
      { env: { BWS_ACCESS_TOKEN: input.bitwarden.token } },
    );

    let secrets: Array<{ key?: string; value?: string }>;
    try {
      secrets = JSON.parse(listed.stdout) as Array<{ key?: string; value?: string }>;
    } catch {
      throw new AgentdError("INTERNAL", "bws secret list did not return JSON");
    }
    for (const secret of secrets) {
      if (!secret.key || secret.value === undefined) continue;
      lines.push(envLine(secret.key, secret.value));
    }
  }

  // An empty file is `"\n"`, not `""`: one is a file systemd is happy to read,
  // and the other is indistinguishable from a truncated write.
  const body = lines.join("\n") + "\n";

  const existing = await host.readFile(outPath);
  if (existing !== null && sha256(existing) === sha256(body)) return false;
  if (input.dryRun) return true;
  await host.writeFile(outPath, body, "0600");
  await host.chmod(outPath, "0600");
  return true;
}

/**
 * The credential a service memory provider's own model calls use
 * (`MEMORY_LLM_ENV_PATH`): the agent's provider key, under each name the
 * manifest's `memory.llm.key_env` lists. `null` when the manifest names no
 * service provider, which is the caller's cue to remove the file.
 *
 * Throws when a name is listed and no key was resolved — the same refusal the
 * provider key itself gets — rather than writing a file that starts the server
 * with no credential. An empty `key_env` (a role-authenticated vendor) needs
 * no key and yields an empty value.
 */
export function memoryLlmFor(
  manifest: AgentConfig,
  providerKey: string | undefined,
): { key_env: string[]; value: string } | null {
  const memory = manifest.memory;
  if (!memory || memoryServiceOf(memory.provider) === null) return null;
  const key_env = memory.llm?.key_env ?? [];
  if (key_env.length > 0 && !providerKey) {
    throw new AgentdError(
      "INTERNAL",
      `manifest sets memory.provider: ${memory.provider} with ${key_env.join(", ")} but no provider key was resolved for ${manifest.name}`,
      { provider: memory.provider },
    );
  }
  return { key_env, value: providerKey ?? "" };
}

/**
 * Write (or remove) `MEMORY_LLM_ENV_PATH`, the memory service's own
 * `EnvironmentFile`, beside `secrets.env` and by the same rules: tmpfs, root,
 * 0600, rewritten only when its hash moves, and nothing on a dry run but the
 * answer.
 *
 * Its own file rather than lines in `secrets.env`: the key goes in under names
 * the memory server reads (`HINDSIGHT_API_LLM_API_KEY`, sometimes a plain
 * `OPENAI_API_KEY`), and those must not reach Hermes's environment, which
 * `secrets.env` is.
 *
 * Written whenever the manifest names a service provider, even with nothing in
 * it: `hermetic-memory.service` names it in an unconditional `EnvironmentFile=`,
 * and systemd fails a unit whose environment file is missing. Removed when the
 * manifest names none, so a key copied for a provider the agent no longer has
 * does not outlive the binding.
 *
 * Returns true when the file changed (or, on a dry run, would).
 */
export async function materialiseMemoryLlm(input: {
  host: Host;
  /** `memoryLlmFor`'s answer; `null` removes the file. */
  memoryLlm: { key_env: string[]; value: string } | null;
  dryRun?: boolean;
}): Promise<boolean> {
  const { host, memoryLlm } = input;
  const existing = await host.readFile(MEMORY_LLM_ENV_PATH);
  if (memoryLlm === null) {
    if (existing === null) return false;
    if (!input.dryRun) await host.remove(MEMORY_LLM_ENV_PATH);
    return true;
  }
  const lines = memoryLlm.key_env.map((name) => envLine(name, memoryLlm.value));
  const body = lines.join("\n") + "\n";
  if (existing !== null && sha256(existing) === sha256(body)) {
    // The bits are corrected without counting as a change: nothing reads them
    // differently, so nothing restarts over them.
    const stat = await host.stat(MEMORY_LLM_ENV_PATH);
    if (!input.dryRun && stat !== null && stat.mode !== "0600") {
      await host.chmod(MEMORY_LLM_ENV_PATH, "0600");
    }
    return false;
  }
  if (input.dryRun) return true;
  await host.mkdir(SECRETS_ENV_DIR, "0700");
  await host.writeFile(MEMORY_LLM_ENV_PATH, body, "0600");
  await host.chmod(MEMORY_LLM_ENV_PATH, "0600");
  return true;
}
