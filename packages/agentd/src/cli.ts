/**
 * `hermeticd`'s subcommands: argument parsing, the one-shot commands
 * (`bootstrap`, `stage …`, `apply`, `update`, `heartbeat`, `secrets`) and the
 * dispatch that runs them. The long-lived `serve` lives in `daemon.ts`; the
 * box's shared context and the redacting writers in `context.ts`; `main.ts` is
 * the entrypoint that wires this to `process`.
 *
 * Argument parsing is by hand: this binary has a handful of subcommands and
 * ships to every instance in the fleet, so it carries no CLI framework.
 * (Commander is the laptop's business, §3.4.)
 *
 * The `stage …` subcommands exist because the bootstrap stages are bash and
 * bash is the wrong language for anything that can destroy data, touch AWS or
 * hold a secret (§6.3). A stage orchestrates; these do the work.
 *
 * Exit codes: 0 ok, 1 error, 3 manifest refused.
 */
import { AgentdError, EXIT_OK } from "./errors.ts";
import { realHost, type Host } from "./host.ts";
import { paramPath } from "./fleet.ts";
import { normalize, resolve } from "node:path";
import { MANIFEST_PATH, parseManifestJson, readBundleManifest } from "./manifest.ts";
import { apply, materialiseSecrets, SECRETS_ENV_DIR, SECRETS_ENV_PATH } from "./apply/index.ts";
import { checkHermes } from "./hermes-check.ts";
import { bootstrap, installBootstrapUnit } from "./bootstrap.ts";
import { DATA_MOUNT, DEVICE_WAIT_MS, mountDataVolume } from "./disk.ts";
import { makeHeartbeat } from "./heartbeat.ts";
import { settleSwap, update } from "./update/index.ts";
import { PROVIDERS, isProviderKeySlot, providerKeyRefOf } from "@hermetic/core/shared";
import { HERMETICD_VERSION } from "./version.ts";
import { bootContext, context, log, stderrEmit, type RunDeps } from "./context.ts";
import { serve } from "./daemon.ts";

/** The SSM slots an agent has. A stage may ask for these and nothing else. */
export const SECRET_SLOTS = ["ts-key", "bws-token", "provider-key"] as const;
export type SecretSlot = (typeof SECRET_SLOTS)[number];

/**
 * Whether a name is a slot this box may read (§8.3).
 *
 * `provider-key` is no longer one name but a family: a box bound to a provider
 * profile reads `provider-key-<profile_id>-r<revision>`, and the manifest is
 * what says
 * which. The guard therefore admits the whole family rather than a fixed list —
 * still narrow, because every one of them is under this agent's own SSM prefix
 * and the instance role can read nothing else.
 */
/**
 * What `--slot` accepts, spelled for a human. `SECRET_SLOTS` alone would name
 * three fixed slots and leave out the family `isKnownSlot` actually admits, so
 * an operator staging a profile-bound agent's key would be told the slot the
 * manifest names is not a slot.
 */
export const SECRET_SLOT_USAGE = [...SECRET_SLOTS, "provider-key-<profile>-r<N>"].join("|");

export function isKnownSlot(slot: string): boolean {
  return (SECRET_SLOTS as readonly string[]).includes(slot) || isProviderKeySlot(slot);
}

export interface Argv {
  readonly command: string;
  readonly sub: string | null;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly rest: readonly string[];
}

/** `--flag value`, `--flag=value`, and bare `--flag` as a boolean. */
export function parseArgv(argv: readonly string[]): Argv {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  const [command = "", sub = null, ...rest] = positional;
  return { command, sub, flags, rest };
}

const USAGE = `hermeticd ${HERMETICD_VERSION}

  hermeticd bootstrap [--install]
  hermeticd stage secret --slot <${SECRET_SLOTS.join("|")}> --out <path>
  hermeticd stage disk-prepare [--mount <path>] [--wait-ms <ms>]
  hermeticd stage fetch-config [--out <path>]
  hermeticd stage verify-hermes [--manifest <path>]
  hermeticd apply [--manifest <path>] [--dry-run]
  hermeticd update [--check] [--force]
  hermeticd serve
  hermeticd heartbeat --once
  hermeticd secrets materialise --out <path> [--mode 0600]
  hermeticd version
`;

/**
 * `--out` for a secret must resolve to a path under `/run` (tmpfs); §8.3 allows
 * nowhere else.
 *
 * The check is on the *resolved* path: `/run/../etc/shadow` starts with
 * `/run/` and is not on tmpfs, and the caller is a shell script whose variable
 * expansion is exactly where a path like that comes from.
 */
export function assertTmpfs(out: string): void {
  const resolved = resolve(out);
  if (resolved !== normalize(out) || out.split("/").includes("..") || !resolved.startsWith("/run/")) {
    throw new AgentdError(
      "INTERNAL",
      `refusing to write a secret to ${out}: runtime secrets live under /run (tmpfs), mode 600`,
      { out, resolved },
    );
  }
}

/**
 * A secret on tmpfs, 0600, in a directory only root can list.
 *
 * The directory matters as much as the file: `mkdir` honours the umask (0755 on
 * a stock Ubuntu) and does nothing at all to a directory that already exists,
 * so a 0755 `/run/hermetic` would make the 0600 key inside it enumerable by
 * every account on the box (§8.3).
 */
export async function writeSecretFile(host: Host, out: string, value: string): Promise<void> {
  assertTmpfs(out);
  const dir = out.slice(0, out.lastIndexOf("/"));
  if (dir.length > 0) {
    await host.mkdir(dir, "0700");
    await host.chmod(dir, "0700");
  }
  await host.writeFile(out, value, "0600");
}

export async function run(
  argv: readonly string[],
  host: Host = realHost(),
  deps: RunDeps = {},
): Promise<number> {
  const { command, sub, flags } = parseArgv(argv);

  /**
   * The first thing the service does, before anything that can fail.
   *
   * A binary swap is judged by whether the new binary *stays up* (§6.5), and
   * the binary a rollback exists for is exactly the one that dies early — in
   * `bootContext`'s user-data read, in the fleet-manifest fetch, in
   * `serveRpc`'s wait for a Tailscale address. Settling inside the update loop
   * meant none of those ever reached the decision, so a fast crash loop simply
   * burned through systemd's `StartLimitBurst` and parked the unit with the bad
   * release still installed. This reads local files and talks to `systemctl`;
   * it needs no network, no credentials and no manifest.
   *
   * `serve` only. Every other subcommand is a *different* process by design —
   * `04-apply` runs `hermeticd apply`, a stage runs `hermeticd stage …` — and
   * counting those as restarts of the service would roll back a healthy release
   * on a box that was merely booting normally.
   */
  if (command === "serve") {
    /**
     * Best effort, and the `try` is the point.
     *
     * Everything in here writes to `/var/lib/hermeticd` and unlinks a file in
     * `/usr/local/bin`, and both can fail for reasons that have nothing to do
     * with the swap: a full root volume, a read-only remount after an fsck, an
     * `EACCES` from something that changed the mode. Letting that reject would
     * take down `serve` itself — and with `Restart=always` the box would spin
     * on it forever without ever heartbeating, which is a far worse outcome
     * than an unsettled marker. Settling is an optimisation; staying up and
     * telling hermetic you are alive is not.
     */
    try {
      await settleSwap({ host, log, asService: true });
    } catch (e) {
      log(`could not settle the last binary swap: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  switch (command) {
    case "version":
    case "--version":
      process.stdout.write(`${HERMETICD_VERSION}\n`);
      return EXIT_OK;

    case "help":
    case "--help":
    case "":
      process.stdout.write(USAGE);
      return command === "" ? 1 : EXIT_OK;

    case "bootstrap": {
      if (flags["install"] === true) {
        await installBootstrapUnit(host);
        return EXIT_OK;
      }
      const ctx = await bootContext(host, deps);
      const outcome = await bootstrap({
        host,
        aws: ctx.aws,
        userData: ctx.userData,
        region: ctx.region,
        fleet: ctx.fleet,
        emit: stderrEmit,
        log: (line) => process.stdout.write(line + "\n"),
      });
      // Exit 1 on a give-up so systemd's `Restart=on-failure` tries the boot
      // again; the stage markers make that a resume, not a restart (§4.2).
      return outcome.ok ? EXIT_OK : 1;
    }

    case "stage":
      return await stageCommand(host, sub, flags, deps);

    case "apply": {
      const path = typeof flags["manifest"] === "string" ? flags["manifest"] : MANIFEST_PATH;
      const text = await host.readFile(path);
      if (text === null) {
        throw new AgentdError("MANIFEST_REFUSED", `no manifest at ${path}`, { path });
      }
      const manifest = parseManifestJson(text);
      const dryRun = flags["dry-run"] === true;
      let bwsToken: string | undefined;
      let providerKey: string | undefined;
      // Only when `apply` would rewrite `secrets.env` at all. On a box where it
      // would not, `hermetic-secrets.service` remains the file's sole author and
      // there is nothing for apply to preserve — so no SSM call is made.
      if (manifest.secrets_mode === "bitwarden" || PROVIDERS[manifest.provider].env !== null) {
        const ctx = await context(host, deps);
        if (manifest.secrets_mode === "bitwarden") {
          bwsToken = await ctx.aws.getParameter(paramPath(ctx.paramPrefix, "bws-token"));
        }
        if (PROVIDERS[manifest.provider].env !== null) {
          providerKey = await ctx.aws.getParameter(
            paramPath(ctx.paramPrefix, providerKeyRefOf(manifest)),
          );
        }
      }
      const result = await apply(manifest, {
        host,
        emit: stderrEmit,
        ...(dryRun ? { dryRun: true } : {}),
        ...(bwsToken ? { bwsToken } : {}),
        ...(providerKey ? { providerKey } : {}),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return EXIT_OK;
    }

    case "update": {
      const ctx = await bootContext(host, deps);
      const result = await update(
        {
          host,
          aws: ctx.aws,
          name: ctx.userData.name,
          bucket: ctx.bucket,
          hermeticdVersion: HERMETICD_VERSION,
          emit: stderrEmit,
          log,
          // A hand-run `hermeticd update` is not the service, so it never
          // counts as one of the service's restarts (§6.5).
        },
        {
          ...(flags["check"] === true ? { check: true } : {}),
          ...(flags["force"] === true ? { force: true } : {}),
        },
      );
      process.stdout.write(
        JSON.stringify({
          running: result.running,
          target: result.target,
          up_to_date: result.upToDate,
          binary_changed: result.binaryChanged,
          stages_changed: result.stagesChanged,
          // A swap this box has not restarted into is the one state where the
          // digest on disk and the running code disagree (§6.5); it is reported
          // rather than hidden behind `up_to_date: false`.
          restart_pending: result.restartPending,
          rolled_back: result.rolledBack,
          blocked: result.blocked,
          // The digest is what the update actually compares (§6.5), so an
          // operator asking what would happen is told the number, not just the
          // label — and told in one sentence why nothing will happen.
          target_sha256: result.targetSha256,
          installed_sha256: result.installedSha256,
          blocked_reason: result.blockedReason,
        }) + "\n",
      );
      return EXIT_OK;
    }

    case "heartbeat": {
      if (flags["once"] !== true) {
        process.stderr.write("hermeticd heartbeat requires --once; use `serve` for the loop\n");
        return 1;
      }
      const ctx = await context(host, deps);
      const tick = await makeHeartbeat({
        host,
        aws: ctx.aws,
        name: ctx.userData.name,
        hermeticdVersion: HERMETICD_VERSION,
        /*
         * No digest from a hand-run tick, deliberately.
         *
         * `heartbeat --once` is a *different process* from the service. Its
         * `/proc/self/exe` is the file at `HERMETICD_PATH` — which, in the one
         * state this field exists for, is not what the daemon is executing: a
         * swap that landed and whose `systemctl restart` failed leaves the new
         * bytes on disk while `hermeticd.service` goes on running the old ones.
         * Reporting them here would write the *target* digest onto the row and
         * a running rollout would call the box landed while the service runs
         * the release it never started.
         *
         * Omitting is the safe direction. The row keeps whatever digest the
         * service last reported; `last_heartbeat` moves, so the rollout sees a
         * fresh heartbeat with a digest that does not match the target and
         * classes the box a straggler — which is exactly what it is until the
         * service restarts and reports for itself.
         */
      }).once();
      process.stdout.write(
        JSON.stringify({
          health: tick.health,
          metrics: tick.metrics,
          transitioned: tick.transitioned,
        }) + "\n",
      );
      return EXIT_OK;
    }

    case "secrets": {
      if (sub !== "materialise" && sub !== "materialize") {
        process.stderr.write(USAGE);
        return 1;
      }
      const out = typeof flags["out"] === "string" ? flags["out"] : SECRETS_ENV_PATH;
      // Runtime secrets live on tmpfs and nowhere else (§8.3). `/data` is
      // snapshotted nightly; the root volume is disposable but not ephemeral.
      if (!out.startsWith(SECRETS_ENV_DIR + "/") && !out.startsWith("/run/")) {
        throw new AgentdError(
          "INTERNAL",
          `refusing to write secrets to ${out}: runtime secrets live under /run (tmpfs), mode 600`,
          { out },
        );
      }
      const text = await host.readFile(MANIFEST_PATH);
      if (text === null) {
        throw new AgentdError("MANIFEST_REFUSED", `no manifest at ${MANIFEST_PATH}`);
      }
      const manifest = parseManifestJson(text);
      const keyEnv = PROVIDERS[manifest.provider].env;
      // No early return, even with nothing to write. `hermes-dashboard.service` names
      // this file in an unconditional `EnvironmentFile=`, so a Bedrock box with
      // no provider key and no Bitwarden project still needs an (empty) file to
      // exist — otherwise systemd refuses to start the unit at all.
      const ctx = await context(host, deps);
      const token =
        manifest.secrets_mode === "bitwarden"
          ? await ctx.aws.getParameter(paramPath(ctx.paramPrefix, "bws-token"))
          : null;
      const key =
        keyEnv === null
          ? null
          : await ctx.aws.getParameter(paramPath(ctx.paramPrefix, providerKeyRefOf(manifest)));
      if (manifest.secrets_mode !== "bitwarden" && keyEnv === null) {
        process.stderr.write(
          "no provider key and no bitwarden project; writing an empty environment file\n",
        );
      }
      const mode = typeof flags["mode"] === "string" ? flags["mode"] : "0600";
      const changed = await materialiseSecrets({
        host,
        ...(token ? { bitwarden: { token, project: manifest.name } } : {}),
        ...(keyEnv !== null && key ? { providerKey: { env: keyEnv, value: key } } : {}),
        outPath: out,
      });
      // Unconditional: an existing file with the right content may still have
      // the wrong bits, and that is exactly the case worth correcting.
      await host.chmod(out, mode);
      process.stderr.write(`${changed ? "wrote" : "unchanged"} ${out}\n`);
      return EXIT_OK;
    }

    case "serve":
      await serve(host, deps);
      return EXIT_OK;

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

/**
 * The helpers the bootstrap stages call. Each is here rather than in the stage
 * because it decrypts a secret, formats a disk, or validates a document this
 * build may refuse — none of which belongs in bash (§4.3).
 */
async function stageCommand(
  host: Host,
  sub: string | null,
  flags: Readonly<Record<string, string | boolean>>,
  deps: RunDeps = {},
): Promise<number> {
  switch (sub) {
    case "secret": {
      const slot = flags["slot"];
      if (typeof slot !== "string" || !isKnownSlot(slot)) {
        throw new AgentdError(
          "USAGE",
          `hermeticd stage secret requires --slot <${SECRET_SLOT_USAGE}>`,
          { slot: typeof slot === "string" ? slot : null },
        );
      }
      const out = flags["out"];
      if (typeof out !== "string" || out.length === 0) {
        throw new AgentdError("USAGE", "hermeticd stage secret requires --out <path>");
      }
      assertTmpfs(out);
      const ctx = await context(host, deps);
      await writeSecretFile(host, out, await ctx.aws.getParameter(paramPath(ctx.paramPrefix, slot)));
      // Nothing on stdout, ever: the caller is a shell, and a shell that can
      // capture the value is a shell that can put it in a log.
      return EXIT_OK;
    }

    case "disk-prepare": {
      const mount = typeof flags["mount"] === "string" ? flags["mount"] : DATA_MOUNT;
      const waitMs = typeof flags["wait-ms"] === "string" ? Number(flags["wait-ms"]) : DEVICE_WAIT_MS;
      if (!Number.isFinite(waitMs) || waitMs < 0) {
        throw new AgentdError("USAGE", `--wait-ms must be a non-negative number`, {
          "wait-ms": String(flags["wait-ms"]),
        });
      }
      // The row is the fleet's record of which EBS volume belongs to this
      // agent. A modern row always supplies it; older rows retain the cautious
      // label/candidate/size fallback in `disk.ts` for compatibility.
      const ctx = await context(host, deps);
      const row = await ctx.aws.getOwnRow(ctx.userData.name);
      const resourceVolume = row?.resources.volume_id;
      const rowVolume = row?.volume_id ?? undefined;
      if (resourceVolume !== undefined && rowVolume !== undefined && resourceVolume !== rowVolume) {
        throw new AgentdError(
          "INTERNAL",
          `agent row disagrees about its data volume (${resourceVolume} vs ${rowVolume}); refusing to choose a disk`,
          { resources_volume_id: resourceVolume, volume_id: rowVolume },
        );
      }
      const expectedVolumeId = resourceVolume ?? rowVolume;
      const device = await mountDataVolume(host, stderrEmit, mount, waitMs, expectedVolumeId);
      process.stderr.write(`hermeticd: ${mount} is ${device ?? "unmounted"}\n`);
      return EXIT_OK;
    }

    case "fetch-config": {
      const out = typeof flags["out"] === "string" ? flags["out"] : MANIFEST_PATH;
      const ctx = await context(host, deps);
      const row = await ctx.aws.getOwnRow(ctx.userData.name);
      const key = row?.resources?.config_key;
      if (!key) {
        throw new AgentdError(
          "INTERNAL",
          `the agent row for ${ctx.userData.name} names no config_key yet`,
          { name: ctx.userData.name },
        );
      }
      const tarball = await ctx.aws.getObjectBytes(ctx.bucket, key);
      const manifest = await readBundleManifest(tarball, host);
      // 0640: the service user reads it, nothing else needs to.
      await host.writeFile(out, JSON.stringify(manifest, null, 2) + "\n", "0640");
      process.stderr.write(`hermeticd: wrote ${out} (config_hash ${manifest.config_hash})\n`);
      return EXIT_OK;
    }

    /**
     * The last stage's assertion that this agent can answer, not merely that it
     * started (`hermes-check.ts`). Reads the manifest for the provider and
     * checks hermetic's own three outputs against the box.
     *
     * Every failing check is printed, not just the first: an operator reading a
     * failed boot should learn everything that is wrong with it in one pass.
     * Nothing printed here is a secret — the key check reports presence.
     */
    case "verify-hermes": {
      const path = typeof flags["manifest"] === "string" ? flags["manifest"] : MANIFEST_PATH;
      const raw = await host.readFile(path);
      if (raw === null) {
        throw new AgentdError("MANIFEST_REFUSED", `no manifest at ${path}`, { path });
      }
      const checks = await checkHermes(host, parseManifestJson(raw));
      for (const check of checks) {
        const verdict = check.ok ? "ok" : check.advisory === true ? "WARN" : "FAIL";
        process.stderr.write(`hermeticd: ${verdict} ${check.name}: ${check.detail}\n`);
      }
      /**
       * Advisory checks are printed and then set aside (`HermesCheck.advisory`).
       *
       * A failing one is a finding about an agent that works: an operator's
       * `/browser connect` override, or a probe resting on upstream behaviour
       * hermetic has not confirmed. Throwing on those puts the agent into
       * `error` on its next rerun for something hermetic itself describes as a
       * choice somebody may have made on purpose.
       */
      const failed = checks.filter((c) => !c.ok && c.advisory !== true);
      if (failed.length > 0) {
        throw new AgentdError(
          "HERMES_MISCONFIGURED",
          `hermes is not configured to answer: ${failed.map((c) => c.name).join(", ")}`,
          { failed: failed.map((c) => c.name).join(",") },
        );
      }
      return EXIT_OK;
    }

    default:
      process.stderr.write(USAGE);
      return 1;
  }
}
