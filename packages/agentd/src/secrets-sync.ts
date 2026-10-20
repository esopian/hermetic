/**
 * The managed block in every Hermes `.env` (§8.1): the default profile's and
 * each bot's (`$HERMES_HOME/profiles/<bot>/.env`), all rewritten together from
 * the slots this box's manifest names.
 *
 * Four things run a sync: apply (phase 3b, with the values it already
 * resolved), the boot oneshot (`hermeticd secrets materialise`), the laptop's
 * `POST /secrets/sync` poke after a key edit, and the daemon's own loops — a
 * heartbeat tick that sees the provider slot's SSM `Version` move, and a poll
 * of the profiles directory that sees a bot appear. Every key read is a fresh
 * `.env` read upstream, so nothing restarts Hermes over a key change.
 */
import type { AgentConfig } from "@hermetic/core/schema";
import {
  HERMES_PROFILES_DIR,
  HERMES_USER_ENV,
  MEMORY_SERVICE_UNIT,
  MEMORY_WORKER_UNIT,
  PROVIDERS,
  providerKeyRefOf,
} from "@hermetic/core/shared";
import type { Aws } from "./aws.ts";
import { AgentdError } from "./errors.ts";
import { paramPath } from "./fleet.ts";
import type { Host } from "./host.ts";
import { must } from "./host.ts";
import { MANIFEST_PATH, parseManifestJson } from "./manifest.ts";
import {
  SECRETS_ENV_DIR,
  SECRETS_ENV_DIR_MODE,
  managedEnvLines,
  materialiseMemoryLlm,
  memoryLlmFor,
  writeManagedEnv,
} from "./apply/secrets.ts";

/** One lock for every `.env` rewrite, shared by apply, the oneshot and the daemon. */
export const ENV_LOCK = `${SECRETS_ENV_DIR}/env.lock`;

/** How often the daemon looks for a new bot directory. */
export const PROFILES_POLL_MS = 2_000;

/** `$HERMES_PROFILES_DIR/<bot>/.env`. */
export function botEnvPath(bot: string): string {
  return `${HERMES_PROFILES_DIR}/${bot}/.env`;
}

/**
 * The bots on this box: the real directories under `HERMES_PROFILES_DIR`.
 * Dot-names are skipped (upstream builds a profile as `.<name>.staging-<pid>`
 * and publishes it by rename), and so is a symlink or anything not a directory.
 */
export async function listBotHomes(host: Host): Promise<string[]> {
  const bots: string[] = [];
  for (const name of await host.readdir(HERMES_PROFILES_DIR)) {
    if (name.startsWith(".")) continue;
    const found = await host.lstat(`${HERMES_PROFILES_DIR}/${name}`);
    if (found === null || found.isSymlink || !found.isDirectory) continue;
    bots.push(name);
  }
  return bots;
}

export interface SyncSecretsInput {
  readonly host: Host;
  /** The provider API key and the variable it becomes; absent on a role-authenticated vendor. */
  readonly providerKey?: { env: string; value: string };
  /** The Bitwarden machine-account token and the project it may read. */
  readonly bitwarden?: { token: string; project: string };
  readonly dryRun?: boolean;
}

export interface SyncSecretsResult {
  /** Every `.env` path rewritten (or, dry, that would be). */
  readonly changed: string[];
  /** The bots whose `.env` now holds the current block. */
  readonly bots: string[];
  /** Bots whose `.env` was refused (a symlink, a directory); named, never fatal. */
  readonly refused: string[];
}

/**
 * Build the block once, then, under `ENV_LOCK`, splice it into the default
 * `.env` and every bot's. A refusal on the default `.env` throws; a refusal on
 * one bot's is reported and the rest go on, so one odd bot cannot keep a
 * rotated key from the others.
 *
 * shortcut: an upstream `.env` write (the dashboard's Keys page, `hermes
 * setup`) landing between our read and our `mv` is lost. The next sync puts
 * the block back; revisit if upstream turns out to rewrite `.env` often.
 */
export async function syncSecrets(input: SyncSecretsInput): Promise<SyncSecretsResult> {
  const { host } = input;
  const dryRun = input.dryRun === true;
  const lines = await managedEnvLines({
    host,
    ...(input.providerKey ? { providerKey: input.providerKey } : {}),
    ...(input.bitwarden ? { bitwarden: input.bitwarden } : {}),
  });
  if (!dryRun) {
    // `mkdir` leaves an existing directory's mode alone, so chmod as well: a
    // box booted before 0711 has a 0700 one (`SECRETS_ENV_DIR_MODE`).
    await host.mkdir(SECRETS_ENV_DIR, SECRETS_ENV_DIR_MODE);
    await host.chmod(SECRETS_ENV_DIR, SECRETS_ENV_DIR_MODE);
  }
  return host.withFileLock(ENV_LOCK, async () => {
    const changed: string[] = [];
    const bots: string[] = [];
    const refused: string[] = [];
    if (await writeManagedEnv(host, HERMES_USER_ENV, lines, { dryRun })) changed.push(HERMES_USER_ENV);
    for (const bot of await listBotHomes(host)) {
      const path = botEnvPath(bot);
      try {
        if (await writeManagedEnv(host, path, lines, { dryRun })) changed.push(path);
        bots.push(bot);
      } catch (e) {
        if (!(e instanceof AgentdError)) throw e;
        refused.push(bot);
      }
    }
    return { changed, bots, refused };
  });
}

export interface ResolveAndSyncDeps {
  readonly host: Host;
  readonly aws: Pick<Aws, "getParameter" | "getParameterVersion">;
  readonly paramPrefix: string;
  /** Read from `MANIFEST_PATH` when absent. */
  readonly manifest?: AgentConfig;
  /**
   * Restart the memory server's units when `memory-llm.env` moved. The daemon's
   * syncs set it; the boot oneshot does not, because those units start after it.
   */
  readonly restartMemory?: boolean;
}

export interface ResolvedSync extends SyncSecretsResult {
  /** The provider slot's SSM `Version` read before its value; `null` with no key slot. */
  readonly slotVersion: number | null;
  /** Whether `MEMORY_LLM_ENV_PATH` was written or removed. */
  readonly memoryChanged: boolean;
}

export async function readManifest(host: Host): Promise<AgentConfig | null> {
  const text = await host.readFile(MANIFEST_PATH);
  return text === null ? null : parseManifestJson(text);
}

/**
 * Read this box's own slots (the ones its manifest names, with the instance
 * role), then `syncSecrets` and the memory server's credential file.
 *
 * The version is read before the value, so a slot that moves in between is
 * recorded as the older version and the next heartbeat tick syncs again.
 */
export async function resolveAndSync(deps: ResolveAndSyncDeps): Promise<ResolvedSync> {
  const { host, aws, paramPrefix } = deps;
  const manifest = deps.manifest ?? (await readManifest(host));
  if (manifest === null) {
    throw new AgentdError("MANIFEST_REFUSED", `no manifest at ${MANIFEST_PATH}`);
  }
  const keyEnv = PROVIDERS[manifest.provider].env;
  const slot = paramPath(paramPrefix, providerKeyRefOf(manifest));
  const slotVersion = keyEnv === null ? null : await aws.getParameterVersion(slot);
  const token =
    manifest.secrets_mode === "bitwarden"
      ? await aws.getParameter(paramPath(paramPrefix, "bws-token"))
      : null;
  const key = keyEnv === null ? null : await aws.getParameter(slot);
  // Before any file is written: a memory server that needs the key and has
  // none is refused here, as `apply` refuses it.
  const memoryLlm = memoryLlmFor(manifest, key ?? undefined);
  const synced = await syncSecrets({
    host,
    ...(token ? { bitwarden: { token, project: manifest.name } } : {}),
    ...(keyEnv !== null && key ? { providerKey: { env: keyEnv, value: key } } : {}),
  });
  const memoryChanged = await materialiseMemoryLlm({ host, memoryLlm });
  if (memoryChanged && deps.restartMemory) {
    for (const unit of [MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT]) {
      if (manifest.units.includes(unit)) await must(host, ["systemctl", "restart", unit]);
    }
  }
  return { ...synced, slotVersion, memoryChanged };
}

/** One line for the journal: paths and bot names, never a value. */
export function describeSync(result: SyncSecretsResult): string {
  const bots = result.bots.length > 0 ? result.bots.join(", ") : "none";
  const refused = result.refused.length > 0 ? `; refused: ${result.refused.join(", ")}` : "";
  return `secrets sync: ${result.changed.length} .env file(s) rewritten; bots: ${bots}${refused}`;
}

export interface SecretsSyncerDeps {
  readonly host: Host;
  readonly aws: Pick<Aws, "getParameter" | "getParameterVersion">;
  readonly paramPrefix: string;
  readonly log: (message: string) => void;
}

export interface SecretsSyncer {
  /** Sync now (the route's and the poll's call); serialised, and it throws. */
  sync(): Promise<ResolvedSync>;
  /** The heartbeat's call: sync on the first tick and when the slot's `Version` moved. Never throws. */
  tick(): Promise<void>;
  /** Poll `HERMES_PROFILES_DIR` and sync when the set of entries changes. Never throws. */
  watchProfiles(signal: AbortSignal, intervalMs?: number): Promise<void>;
}

/** The daemon's syncs, sharing the last synced slot version. */
export function makeSecretsSyncer(deps: SecretsSyncerDeps): SecretsSyncer {
  const { host, aws, paramPrefix, log } = deps;
  /** `undefined` until the first sync: boot always syncs. */
  let lastVersion: number | null | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const sync = (): Promise<ResolvedSync> => {
    const run = async (): Promise<ResolvedSync> => {
      // A failed sync leaves the next heartbeat tick owing one.
      lastVersion = undefined;
      const result = await resolveAndSync({ host, aws, paramPrefix, restartMemory: true });
      lastVersion = result.slotVersion;
      if (result.changed.length > 0 || result.refused.length > 0 || result.memoryChanged) {
        log(describeSync(result));
      }
      return result;
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  const failed = (what: string, e: unknown): void => {
    log(`secrets sync (${what}) failed: ${e instanceof AgentdError ? e.code : "unexpected error"}`);
  };

  return {
    sync,

    async tick() {
      try {
        const manifest = await readManifest(host);
        // Mid-bootstrap there is nothing to sync yet; apply does the first one.
        if (manifest === null) return;
        if (lastVersion !== undefined) {
          const keyed = PROVIDERS[manifest.provider].env !== null;
          const version = keyed
            ? await aws.getParameterVersion(paramPath(paramPrefix, providerKeyRefOf(manifest)))
            : null;
          if (version === lastVersion) return;
        }
        await sync();
      } catch (e) {
        failed("heartbeat", e);
      }
    },

    async watchProfiles(signal, intervalMs = PROFILES_POLL_MS) {
      let seen: string | null = null;
      while (!signal.aborted) {
        try {
          const now = (await host.readdir(HERMES_PROFILES_DIR))
            .filter((n) => !n.startsWith("."))
            .join("\n");
          const moved = seen !== null && now !== seen;
          // Seen before the sync, so a failing one is retried by the heartbeat
          // (which it left owing a sync), not every two seconds here.
          seen = now;
          if (moved && (await readManifest(host)) !== null) await sync();
        } catch (e) {
          failed("profiles", e);
        }
        await host.sleep(intervalMs);
      }
    },
  };
}
