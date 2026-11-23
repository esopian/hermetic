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
import { apply, resetAptIndexState } from "./apply/index.ts";
import { hermesHeld } from "./apply/hermes-upgrade.ts";
import type { Aws } from "./aws.ts";
import { AgentdError } from "./errors.ts";
import { STATE_DIR, paramPath } from "./fleet.ts";
import { APPLY_LOCK_PATH, takeInstallLock } from "./install-lock.ts";
import type { Host } from "./host.ts";
import { INCOMING_DIR, MANIFEST_PATH, readAppliedConfigHash, readBundleManifest } from "./manifest.ts";

/**
 * What `hermeticd serve` hands its converge loop on start when a Hermes swap
 * was cut short (a crash or power cut): a request of its own, so the box
 * re-applies the configuration its row names whether or not the row still
 * carries an `apply_request` the heartbeat would deliver. That apply finishes
 * the swap and gates it, or rolls it back, and releases the hold either way;
 * `null` when nothing is held.
 */
export async function heldResumeRequest(host: Host): Promise<ApplyRequest | null> {
  if (!(await hermesHeld(host))) return null;
  // Held for an operator: only a new laptop request moves Hermes again, even after a restart.
  if (await operatorHeld(host)) return null;
  const at = host.now().toISOString();
  return {
    id: `${RESUME_ID_PREFIX}${at}`,
    config_hash: (await readAppliedConfigHash(host)) ?? "unrecorded",
    issued_at: at,
    issued_by: "hermeticd: resuming an interrupted Hermes swap",
  };
}
import { type Emit, opEvent } from "./events.ts";

/**
 * A configuration whose Hermes swap this box rolled back, and the requests
 * that asked for it. The row still names that configuration (a rollback the
 * laptop never saw: its wait cut short, an older laptop, or the box's own
 * `resume-held-swap-*` request), so a request re-delivered after a restart
 * would swap again with nobody watching. Root-owned, on the root volume.
 *
 * The same record, with the failure's `code`, holds Hermes down for an
 * operator after a failed rollback or restore (`NEEDS_OPERATOR`): one record
 * and one check, so the hold outlives a hermeticd restart or a reboot.
 */
export const HERMES_ROLLED_BACK_PATH = `${STATE_DIR}/hermes-rolled-back.json`;

/**
 * An operator hold whose record could not be written (most likely a full root
 * volume): empty and created by an append, so it needs an inode and no data
 * block. Its mtime dates the hold: only a laptop request issued after it is
 * let through (`refuseRecorded`), and that apply drops it.
 */
export const HERMES_OPERATOR_HOLD_PATH = `${STATE_DIR}/hermes-operator.hold`;

/** The id prefix of the box's own resume (`heldResumeRequest`): never a request from the laptop. */
export const RESUME_ID_PREFIX = "resume-held-swap-";

/** Failures that hold Hermes down for an operator by design: reported, never retried by the box. */
export const NEEDS_OPERATOR: ReadonlySet<string> = new Set([
  "HERMES_ROLLBACK_FAILED",
  "HERMES_RESTORE_FAILED",
]);

type RefusalCode = "HERMES_UPGRADE_ROLLED_BACK" | "HERMES_ROLLBACK_FAILED" | "HERMES_RESTORE_FAILED";

interface RolledBack {
  readonly config_hash: string;
  readonly request_ids: readonly string[];
  /** Absent on a record written before holds were recorded: a rollback. */
  readonly code?: RefusalCode;
}

/**
 * After an apply failed with `error`: when it was a rolled-back Hermes swap or
 * a failure that holds Hermes for an operator, remember `configHash`, the code
 * and the requests (`ids`) that must not apply again. Shared by a converge and
 * a stage's `hermeticd apply` (`agent rerun`).
 */
export async function recordRolledBack(
  host: Host,
  error: unknown,
  configHash: string,
  ids: ReadonlyArray<string | undefined>,
  emit?: Emit,
): Promise<void> {
  if (!(error instanceof AgentdError)) return;
  const code = error.code;
  if (
    code !== "HERMES_UPGRADE_ROLLED_BACK" &&
    code !== "HERMES_ROLLBACK_FAILED" &&
    code !== "HERMES_RESTORE_FAILED"
  ) {
    return;
  }
  const request_ids = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const record: RolledBack = { config_hash: configHash, request_ids, code };
  // Best effort: the failure is what the caller reports, never a full disk's error instead.
  try {
    await host.writeFile(HERMES_ROLLED_BACK_PATH, `${JSON.stringify(record)}\n`, "0600");
  } catch (failure) {
    if (NEEDS_OPERATOR.has(code)) {
      await host.appendFile(HERMES_OPERATOR_HOLD_PATH, "", "0600").catch(() => undefined);
    }
    const why = failure instanceof Error ? failure.message : String(failure);
    emit?.(
      opEvent(
        "units",
        1,
        `${code} for config ${configHash} was not recorded: ${why}`,
        host.now(),
        "warn",
      ),
    );
  }
}

/** Hermes held down for an operator: a recorded `NEEDS_OPERATOR` failure, or the marker left when it could not be recorded. */
async function operatorHeld(host: Host): Promise<boolean> {
  return (
    NEEDS_OPERATOR.has((await readRolledBack(host))?.code ?? "") ||
    (await host.lstat(HERMES_OPERATOR_HOLD_PATH)) !== null
  );
}

async function readRolledBack(host: Host): Promise<RolledBack | null> {
  try {
    const r = JSON.parse(
      (await host.readFile(HERMES_ROLLED_BACK_PATH)) ?? "null",
    ) as Partial<RolledBack> | null;
    return typeof r?.config_hash === "string" &&
      Array.isArray(r.request_ids) &&
      r.request_ids.every((id) => typeof id === "string") &&
      (r.code === undefined || r.code === "HERMES_UPGRADE_ROLLED_BACK" || NEEDS_OPERATOR.has(r.code))
      ? (r as RolledBack)
      : null;
  } catch {
    return null;
  }
}

/**
 * Not again by itself: only a laptop request the record does not already list
 * applies `configHash`, and clears the record. A rolled-back configuration is
 * refused unless the box is held and the request is not the box's own (that
 * apply is what finishes or undoes its swap); while Hermes is held for an
 * operator, every configuration is. Refused
 * with the record's own code, so the row's `apply_failure` keeps saying what
 * happened. `request` resolving to nothing (no request on the row, a row
 * that cannot be read) is never a new request.
 *
 * An operator hold left only as the marker names no request, so the one that
 * failed, re-delivered after a restart, would pass for new: only a request
 * issued after the marker was created lets Hermes move again, whatever record
 * is or is not on disk beside it.
 */
export async function refuseRecorded(
  host: Host,
  configHash: string,
  request: () => Promise<Pick<ApplyRequest, "id" | "issued_at"> | null | undefined>,
): Promise<void> {
  const record = await readRolledBack(host);
  const marker = await host.lstat(HERMES_OPERATOR_HOLD_PATH);
  if (record === null && marker === null) return;
  const asked = await request().catch(() => null);
  const id = asked?.id ?? null;
  // The box's own resume is never new: a held box that applied it would swap the rolled-back config again, unwatched.
  const own = id?.startsWith(RESUME_ID_PREFIX) === true;
  // shortcut: compares the laptop's clock (`issued_at`) with the box's (the marker's mtime); a laptop
  // running behind by more than the failed apply took is refused until its clock passes the marker.
  if (
    marker !== null &&
    (own || !(Date.parse(asked?.issued_at ?? "") > (marker.mtimeMs ?? Infinity)))
  ) {
    const code =
      record !== null && record.code !== undefined && NEEDS_OPERATOR.has(record.code)
        ? record.code
        : "HERMES_ROLLBACK_FAILED";
    throw new AgentdError(
      code,
      "Hermes is held down for an operator after a failure this box could not record; it is applied " +
        "again only on a request the laptop issues after the hold",
      { config_hash: configHash, request_id: id, record: HERMES_OPERATOR_HOLD_PATH },
    );
  }
  if (record !== null) {
    const code = record.code ?? "HERMES_UPGRADE_ROLLED_BACK";
    const forOperator = NEEDS_OPERATOR.has(code);
    const applies = forOperator || record.config_hash === configHash;
    if (applies && (forOperator || own || !(await hermesHeld(host)))) {
      if (!id || own || record.request_ids.includes(id)) {
        throw new AgentdError(
          code,
          forOperator
            ? `Hermes is held down for an operator after ${code} on config ${record.config_hash}; it is applied again only on a new request from the laptop`
            : `config ${configHash} was rolled back on this box; it is applied again only on a new request from the laptop`,
          { config_hash: configHash, request_id: id, record: HERMES_ROLLED_BACK_PATH },
        );
      }
      await host.remove(HERMES_ROLLED_BACK_PATH);
    }
  }
  await host.remove(HERMES_OPERATOR_HOLD_PATH);
}

export interface ConvergeDeps {
  readonly host: Host;
  readonly aws: Aws;
  readonly name: string;
  readonly bucket: string;
  /** `/hermes/<fleet>/<agent>/`, for the secret slots and durable file secrets an apply reads. */
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
  const { host } = deps;

  /**
   * The same guard the updater takes (§6.4). A bootstrap in flight is already
   * writing these exact files from stage `04-apply`; two writers would race over
   * `/etc/hermetic` and over systemd. Deferring costs one tick.
   */
  if (await bootstrapActive(host)) {
    return { kind: "deferred", reason: `${"hermeticd-bootstrap.service"} is still running` };
  }
  // A stage's `hermeticd apply` (`agent rerun`) may be mid-swap: never two applies at once.
  const lock = await takeInstallLock(host, "apply", { path: APPLY_LOCK_PATH });
  if (lock === null) return { kind: "deferred", reason: "another hermeticd apply is running" };
  try {
    return await convergeLocked(deps, request);
  } finally {
    await lock.release();
  }
}

async function convergeLocked(deps: ConvergeDeps, request: ApplyRequest): Promise<ConvergeOutcome> {
  const { host, aws, name } = deps;
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

  // A box held mid-swap is not running the config it last recorded: re-apply,
  // which finishes the swap or puts it back (`apply/hermes-upgrade.ts`). Nor is one held
  // for an operator: the recorded hash may be the config its failed rollback restarted.
  if (already === manifest.config_hash && !(await hermesHeld(host)) && !(await operatorHeld(host))) {
    /**
     * Not a no-op out of laziness: the heartbeat reports `applied_config_hash`
     * from this file, so a box that already holds the requested config has, by
     * the only definition hermetic uses, already converged. Re-applying would
     * restart units for nothing.
     */
    deps.log?.(`converge ${request.id}: already running ${manifest.config_hash}`);
    return { kind: "current", config_hash: manifest.config_hash };
  }

  await refuseRecorded(host, manifest.config_hash, async () => request);

  // The slots an apply may need, fetched only when this manifest could use
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

  /**
   * A converge runs in `hermeticd serve`, which lives for weeks, and the apt
   * index is refreshed once per process (`installPackages`). Without this, the
   * first converge that needs a package (an agent moved onto honcho, which
   * needs Postgres) would install from whatever index the process last fetched,
   * possibly days old, and a mirror that has rotated the old package versions
   * out answers 404. Each converge counts as a fresh process for that purpose.
   */
  resetAptIndexState();

  try {
    await apply(manifest, {
      host,
      ...(deps.emit ? { emit: deps.emit } : {}),
      ...(bwsToken ? { bwsToken } : {}),
      // Also the memory server's credential (`memory.llm.key_env`): the agent's
      // own key under the server's names, so there is no slot of its own to read.
      ...(providerKey ? { providerKey } : {}),
      // The durable file secrets are re-read on a converge as on any apply, with
      // the same role and prefix; best-effort inside `apply`.
      fileSecrets: { aws, paramPrefix: deps.paramPrefix, ...(deps.log ? { log: deps.log } : {}) },
    });
  } catch (error) {
    // The row's own request too: the one heartbeats re-deliver after a restart.
    await recordRolledBack(
      host,
      error,
      manifest.config_hash,
      [request.id, row?.apply_request?.id],
      deps.emit,
    );
    throw error;
  }
  await host.remove(HERMES_ROLLED_BACK_PATH);

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
   * nothing needed the file to be there first. The one process that does read
   * it during an apply, `hermetic-secrets.service`, is never re-run by `apply`
   * while it is active, and when it is started its files are written again
   * after it (`SECRETS_UNIT` in `apply/index.ts`), so it cannot put the previous
   * configuration's secrets back.
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
