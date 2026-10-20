/**
 * Runtime secrets (§6.4, §8.1, §8.3): the managed block every Hermes `.env`
 * carries, and the memory server's own tmpfs `EnvironmentFile`.
 */
import type { AgentConfig } from "@hermetic/core/schema";
import {
  HERMES_ACCOUNT,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  MANAGED_ENV_BEGIN,
  MANAGED_ENV_END,
  MEMORY_LLM_ENV_PATH,
  MEMORY_SERVICE_UNIT,
  MEMORY_WORKER_UNIT,
  memoryServiceOf,
} from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";
import { pathKindAsHermes } from "../files/fs-ops.ts";
import { writeAsAccount } from "./plugins.ts";
import { sha256 } from "./shared.ts";

/**
 * Where the provider key and the Bitwarden lines used to live, before they
 * moved into the managed block of every Hermes `.env` (§8.1). Nothing writes
 * a secret here any more: apply removes the file, or empties it while a
 * rendered unit still names it in an `EnvironmentFile=` (`settleLegacySecretsEnv`).
 */
export const SECRETS_ENV_PATH = "/run/hermetic/secrets.env";
export const SECRETS_ENV_DIR = "/run/hermetic";
/**
 * `/run/hermetic` is root's and 0711: traversable, not listable, not writable.
 *
 * It was 0700 until hermes needed to reach paths under it — the durable file
 * secrets in `/run/hermetic/files/`, the ephemeral drops in
 * `/run/hermetic/drop/` and the files socket. The execute bit lets the account
 * open a path it already knows; it does not let it list the directory, so the
 * names of the root-only files here (`secrets.env`, a staged auth key) are not
 * enumerable, and every one of those files stays 0600 root, which the bit on
 * the directory above does nothing to. Nor can the account create or replace
 * anything here: there is no write bit for it. The same mode is rendered into
 * `hermetic-secrets.service`'s `ExecStartPre`, so boot and apply agree.
 */
export const SECRETS_ENV_DIR_MODE = "0711";

/**
 * The boot oneshot core renders on every agent (`secretsUnit`), whose
 * `ExecStart` is `hermeticd secrets materialise`: it writes the managed block
 * into every Hermes `.env` and `MEMORY_LLM_ENV_PATH`, from the manifest at
 * `MANIFEST_PATH`.
 */
export const SECRETS_UNIT = "hermetic-secrets.service";

/**
 * Every unit core renders with `Requires=` on `SECRETS_UNIT`: both Hermes
 * units (the gateway through its drop-in), the memory server and honcho's
 * worker. They read what that unit writes, and systemd restarts them
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
 * One `KEY=value` line, quoted the way upstream's own writer quotes it
 * (`_quote_env_value`, `hermes_cli/config.py`): bare unless the value holds a
 * `#`, a quote or whitespace, else double-quoted with `\\` and `"` escaped.
 *
 * That form round-trips through upstream's `_parse_env_value` and through
 * python-dotenv (both read single quotes verbatim, so the old systemd-style
 * `'…\\'…'` did not), and it is valid systemd `EnvironmentFile` syntax too,
 * so `memory-llm.env` uses the same function.
 */
export function envLine(key: string, value: string): string {
  if (!/[#"'\s]/.test(value)) return `${key}=${value}`;
  return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The lines of the managed block: the provider key, then whatever
 * `bws secret list <project>` returns for this agent's own project (§6.4). The
 * token reaches `bws` through the environment; no value is ever logged.
 *
 * The provider key comes first so a Bitwarden project that also carries one
 * wins (the last assignment wins in every dotenv reader): the project is the
 * operator's own, and an explicit secret there is a deliberate override.
 * Bedrock with no project is `[]`, an empty block.
 */
export async function managedEnvLines(input: {
  host: Host;
  /** The provider API key and the variable it becomes; from SSM (§8.1). */
  providerKey?: { env: string; value: string };
  /** The Bitwarden machine-account token and the project it may read. */
  bitwarden?: { token: string; project: string };
}): Promise<string[]> {
  const lines: string[] = [];
  if (input.providerKey) lines.push(envLine(input.providerKey.env, input.providerKey.value));
  if (input.bitwarden) {
    const listed = await must(
      input.host,
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
  return lines;
}

/**
 * `existing` with the managed block replaced by one holding `lines`. Every line
 * outside the fence comes back byte for byte. A file with no complete fence
 * gets one at the top (stray marker lines dropped), so an assignment the agent
 * or the operator made further down still wins: that is a deliberate per-bot
 * key, which a sync reports (`bots_keyed`) and never overwrites.
 */
export function spliceManagedBlock(existing: string, lines: readonly string[]): string {
  const block = [MANAGED_ENV_BEGIN, ...lines, MANAGED_ENV_END];
  if (existing === "") return block.join("\n") + "\n";
  const all = existing.split("\n");
  const begin = all.indexOf(MANAGED_ENV_BEGIN);
  const end = begin === -1 ? -1 : all.indexOf(MANAGED_ENV_END, begin + 1);
  if (end !== -1) {
    all.splice(begin, end - begin + 1, ...block);
    return all.join("\n");
  }
  return [...block, ...all.filter((l) => l !== MANAGED_ENV_BEGIN && l !== MANAGED_ENV_END)].join("\n");
}

/**
 * The lines inside the managed block of `env`, or `null` when it has no
 * complete fence. For the checks, which compare blocks and never print them.
 */
export function managedBlockOf(env: string): string[] | null {
  const all = env.split("\n");
  const begin = all.indexOf(MANAGED_ENV_BEGIN);
  const end = begin === -1 ? -1 : all.indexOf(MANAGED_ENV_END, begin + 1);
  return end === -1 ? null : all.slice(begin + 1, end);
}

/** `env` with the managed block (fence included) taken out: what the agent wrote. */
export function outsideManagedBlock(env: string): string {
  const all = env.split("\n");
  const begin = all.indexOf(MANAGED_ENV_BEGIN);
  const end = begin === -1 ? -1 : all.indexOf(MANAGED_ENV_END, begin + 1);
  if (end !== -1) all.splice(begin, end - begin + 1);
  return all.join("\n");
}

/**
 * Splice `lines` into the `.env` at `path` (a Hermes home's), as the account.
 *
 * Read with `readStreamAs` and written with `writeAsAccount` (staged, then
 * `mv -f -T`), so root never opens or follows anything under `/data`, and
 * every write is a new inode: upstream's `load_env_file` memoises on the
 * file's stat identity, so the next turn reads the new key. Mode 0600, the
 * account's. Skipped when the content would not change, so a sync that moved
 * nothing does not bounce the bot's adapters at upstream's next reconcile.
 * A missing file is created holding just the block; a symlink or anything
 * else that is not a regular file is refused.
 *
 * Returns true when the file changed (or, on a dry run, would).
 */
export async function writeManagedEnv(
  host: Host,
  path: string,
  lines: readonly string[],
  opts: { dryRun?: boolean } = {},
): Promise<boolean> {
  const kind = await pathKindAsHermes(host, path);
  if (kind === "other") {
    throw new AgentdError(
      "AGENT_DIR_UNSAFE",
      `${path} is not a regular file (a symlink, or a directory); hermetic will not write ` +
        "the provider key through it. Remove it on the box, then re-apply.",
      { path },
    );
  }
  const existing =
    kind === "missing" ? "" : await new Response(host.readStreamAs(HERMES_ACCOUNT, path)).text();
  const next = spliceManagedBlock(existing, lines);
  if (kind === "regular" && sha256(existing) === sha256(next)) return false;
  if (opts.dryRun) return true;
  await writeAsAccount(host, path, next, "0600");
  return true;
}

/**
 * The old `SECRETS_ENV_PATH`, settled: removed once no rendered file names it,
 * and an empty file (`"\n"`, no secret) while one still does, because systemd
 * fails a unit whose `EnvironmentFile=` is missing. The second case is a box
 * running this hermeticd under a render from before the key moved into `.env`.
 * Returns true when the file changed.
 */
export async function settleLegacySecretsEnv(
  host: Host,
  manifest: AgentConfig,
  dryRun = false,
): Promise<boolean> {
  const named = manifest.files.some((f) => f.content.includes(SECRETS_ENV_PATH));
  const existing = await host.readFile(SECRETS_ENV_PATH);
  if (named ? existing === "\n" : existing === null) return false;
  if (dryRun) return true;
  if (!named) {
    await host.remove(SECRETS_ENV_PATH);
    return true;
  }
  await host.mkdir(SECRETS_ENV_DIR, SECRETS_ENV_DIR_MODE);
  await host.writeFile(SECRETS_ENV_PATH, "\n", "0600");
  await host.chmod(SECRETS_ENV_PATH, "0600");
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
 * `EnvironmentFile`: tmpfs, root, 0600, rewritten only when its hash moves,
 * and nothing on a dry run but the answer.
 *
 * Its own file rather than lines in the managed `.env` block: the key goes in
 * under names the memory server reads (`HINDSIGHT_API_LLM_API_KEY`, sometimes
 * a plain `OPENAI_API_KEY`), and those must not reach Hermes.
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
