/**
 * Runtime secrets → the tmpfs `EnvironmentFile` the rendered units read
 * (§6.4, §8.3).
 */
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
