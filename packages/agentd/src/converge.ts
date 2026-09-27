/**
 * The converge receiver (§6.5): "apply the configuration your row names, now".
 *
 * A `ready` box had nothing listening for that until this existed. The only
 * ways a rendered change reached one were `agent rerun`, which requires the box
 * to have *failed* a stage, and `recreate`, which rebuilds it — so a change in
 * the renderer reached a twelve-agent fleet only as twelve manual acts.
 *
 * The request arrives the one way anything can reach a box: on its own row
 * (§5.1 scopes hermeticd's DynamoDB access to exactly that row). The heartbeat
 * already reads the row every 30 s, so it notices the request and hands it here
 * through a gate, exactly as §6.6's `update_request` is handed to the update
 * loop. The two loops never import each other.
 *
 * **Nothing acks.** The laptop decides "done" from `applied_config_hash`, which
 * the heartbeat writes from the manifest on disk — so a successful converge is
 * reported by the same fact that reports a successful bootstrap, and a box
 * running a hermeticd too old to know `apply_request` simply never moves that
 * hash. A rollout then reports it as unconverged, which is true, rather than as
 * done, which is what an ack field would have let it believe.
 *
 * The work itself is the work stages `03-config` and `04-apply` do, called
 * through the same functions rather than reimplemented: fetch the bundle the row
 * names, write `/etc/hermetic/manifest.json`, apply it. A converge is therefore
 * not a second way to configure a box — it is the same way, asked for at a
 * different moment.
 */
import type { ApplyRequest } from "@hermetic/core/schema";
import { PROVIDERS, providerKeyRefOf } from "@hermetic/core/shared";
import { apply } from "./apply/index.ts";
import type { Aws } from "./aws.ts";
import { AgentdError } from "./errors.ts";
import { paramPath } from "./fleet.ts";
import type { Host } from "./host.ts";
import { INCOMING_DIR, MANIFEST_PATH, readAppliedConfigHash, readBundleManifest } from "./manifest.ts";
import type { Emit } from "./events.ts";

export interface ConvergeDeps {
  readonly host: Host;
  readonly aws: Aws;
  readonly name: string;
  readonly bucket: string;
  /** `/hermes/<fleet>/<agent>/`, for the two secret slots an apply may need. */
  readonly paramPrefix: string;
  readonly emit?: Emit;
  readonly log?: (message: string) => void;
}

export type ConvergeOutcome =
  /** Applied; `applied_config_hash` moves on the next heartbeat. */
  | { readonly kind: "applied"; readonly config_hash: string }
  /** The box is already running it — a request re-delivered, or a race with a boot. */
  | { readonly kind: "current"; readonly config_hash: string }
  /** Not now: a bootstrap is running. The caller keeps the request for the next tick. */
  | { readonly kind: "deferred"; readonly reason: string };

/**
 * Apply the configuration the row names.
 *
 * The *row* is the authority on which bundle to fetch, not the request: a
 * request names the hash that was current when it was written, and by the time
 * it is read the row may name a newer one. Converging to the row means an
 * operator who rolls out twice in a minute gets the second configuration, not a
 * race between them. The request's hash is still carried, and is the thing this
 * says it satisfied.
 */
export async function convergeOnce(
  deps: ConvergeDeps,
  request: ApplyRequest,
  bootstrapActive: (host: Host) => Promise<boolean>,
): Promise<ConvergeOutcome> {
  const { host, aws, name } = deps;

  /**
   * The same guard the updater takes (§6.4). A bootstrap in flight is already
   * writing these exact files from stage `04-apply`; two writers would race over
   * `/etc/hermetic` and over systemd. Deferring costs one tick.
   */
  if (await bootstrapActive(host)) {
    return { kind: "deferred", reason: `${"hermeticd-bootstrap.service"} is still running` };
  }

  const row = await aws.getOwnRow(name);
  const key = row?.resources?.config_key;
  if (!key) {
    throw new AgentdError("INTERNAL", `the agent row for ${name} names no config_key`, { name });
  }

  /**
   * Read **before** the bundle is fetched, and unpack the bundle somewhere
   * other than `BUNDLE_DIR`.
   *
   * Both halves matter and both were wrong. `readBundleManifest` unpacks the
   * tarball into the directory it is given, and the bundle carries its own
   * `manifest.json` — so unpacking into `BUNDLE_DIR` overwrote `MANIFEST_PATH`,
   * the file this comparison then read. The incoming hash always equalled
   * itself, every converge on a real box answered `current` without applying
   * anything, and `hermetic apply` of a rollout plan reported a fleet converged
   * onto a configuration no box had installed. Tests missed it because a bundle
   * served as JSON (`readBundleManifest`'s other branch) never unpacks at all.
   *
   * `readAppliedConfigHash` rather than `JSON.parse` on the file, for a third
   * reason of the same kind: a `manifest.json` that does not parse reads as
   * `null` — "this box is running no config hermetic recognises" — and the
   * converge re-applies, which is the repair. Parsing inline threw instead, and
   * since nothing acks a request (§6.5) the loop re-armed it every heartbeat:
   * one failed converge event per tick, forever, for a box one re-apply would
   * have fixed. The write below stages and renames, so hermeticd cannot leave a
   * torn file itself — but the bootstrap stage's `tar -xzf` lands this path in
   * place, so a truncated one is reachable.
   */
  const already = await readAppliedConfigHash(host);

  const tarball = await aws.getObjectBytes(deps.bucket, key);
  const manifest = await readBundleManifest(tarball, host, INCOMING_DIR);

  if (already === manifest.config_hash) {
    /**
     * Not a no-op out of laziness: the heartbeat reports `applied_config_hash`
     * from this file, so a box that already holds the requested config has, by
     * the only definition hermetic uses, already converged. Re-applying would
     * restart units for nothing.
     */
    deps.log?.(`converge ${request.id}: already running ${manifest.config_hash}`);
    return { kind: "current", config_hash: manifest.config_hash };
  }

  // The two slots an apply may need, fetched only when this manifest could use
  // them — the same condition `hermeticd apply` uses, so a converge makes no SSM
  // call an apply would not have made.
  let bwsToken: string | undefined;
  let providerKey: string | undefined;
  if (manifest.secrets_mode === "bitwarden") {
    bwsToken = await aws.getParameter(paramPath(deps.paramPrefix, "bws-token"));
  }
  if (PROVIDERS[manifest.provider].env !== null) {
    providerKey = await aws.getParameter(paramPath(deps.paramPrefix, providerKeyRefOf(manifest)));
  }

  await apply(manifest, {
    host,
    ...(deps.emit ? { emit: deps.emit } : {}),
    ...(bwsToken ? { bwsToken } : {}),
    ...(providerKey ? { providerKey } : {}),
  });

  /**
   * **After** the apply, and only on success. 0640: the service user reads it,
   * nothing else needs to.
   *
   * This file is the box's answer to "what config are you running" — the
   * heartbeat reports it as `applied_config_hash` (`manifest.ts`'s
   * `readAppliedConfigHash`), and `configVerdict` compares it against what the
   * fleet rendered. Writing it first made that answer a statement of intent:
   * §6.5 says a failed apply "changes no status: the agent is still serving the
   * configuration it had, and its stale `applied_config_hash` already reads as
   * `drifted`", and the opposite happened — an apply that threw in the middle
   * left the row reading `current`, in green, for a half-configured box.
   *
   * Two things made that worse than a cosmetic lie. The heartbeat runs
   * concurrently in this same process, and an apply that installs packages
   * takes minutes, so every tick of that window reported the new hash for work
   * still in progress. And `resetForConfigDrift` (`stages.ts`) decides whether
   * `agent rerun` re-runs `03-config`/`04-apply` by comparing the row's
   * `config_hash` against this file — which, after a failed converge, already
   * matched. The recovery path skipped both stages and the box never got the
   * config, which is the exact failure that function exists to prevent.
   *
   * `apply()` never reads this path — it takes the parsed manifest object — so
   * nothing needed the file to be there first.
   *
   * The cost of the new ordering is one window: a crash between a successful
   * apply and this write leaves the old hash on the row, and the next converge
   * re-applies. Nothing acks a request (§6.5), so it is still pending, and
   * `apply` is idempotent — a redundant re-apply is the cheap direction to
   * fail in, and reporting a box as converged when it is not is the expensive
   * one.
   */
  await host.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "0640");

  deps.log?.(`converge ${request.id}: applied ${manifest.config_hash}`);
  return { kind: "applied", config_hash: manifest.config_hash };
}
