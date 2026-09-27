/**
 * `hermeticd serve` — the systemd service and its three loops. The subcommands
 * that run and exit are in `cli.ts`; `main.ts` is the entrypoint.
 */
import type { Host } from "./host.ts";
import { readAppliedConfigHash } from "./manifest.ts";
import { BOOTSTRAP_UNIT } from "./bootstrap.ts";
import { makeHeartbeat } from "./heartbeat.ts";
import { HERMETICD_PATH } from "./stages.ts";
import { reportBrowsers } from "./browser-health.ts";
import { serveRpc, tailscaleWhois } from "./rpc.ts";
import {
  SWAP_SETTLE_MS,
  markSwapSettled,
  msUntilNightly,
  settleAfterUptime,
  update,
} from "./update/index.ts";
import { makeUpdateGate, type UpdateGate } from "./update-request.ts";
import { makeRequestGate, type RequestGate } from "./request-gate.ts";
import { convergeOnce, type ConvergeOutcome } from "./converge.ts";
import type { ApplyRequest } from "@hermetic/core/schema";
import { redactValue } from "./redact.ts";
import { HERMETICD_VERSION } from "./version.ts";
import { bootContext, log, stderrEmit, type Context, type RunDeps } from "./context.ts";

/**
 * The systemd service (§6.4): heartbeat every 30 s, self-update at start-up and
 * at 03:17 UTC, and answer operator RPCs on the Tailscale interface.
 *
 * The heartbeat and the update scheduler run as two independent loops. An
 * update fetches and swaps a binary, and the fleet must not see the agent go
 * `unreachable` while it does.
 */
/**
 * The digest of the binary *this* process is running
 * (`Agent.running_hermeticd_sha256`, §6.6) — read once by whoever is about to
 * heartbeat, and never re-read.
 *
 * `/proc/self/exe` first, and that is the whole point of this function. A swap
 * is a `rename` over `HERMETICD_PATH` (`update.ts`), so the moment an update
 * lands without its restart, that path holds the *new* bytes while this process
 * goes on executing the old ones — and a read of the path in that window
 * reports a release the box has not started, which is exactly the false
 * "landed" the field exists to prevent. Linux keeps the running executable's
 * inode reachable through `/proc/self/exe` across the rename, so hashing it
 * makes "the running code" true by construction rather than by having read
 * early enough.
 *
 * `HERMETICD_PATH` is the fallback for anywhere `/proc` is not mounted or the
 * link cannot be followed. It is right in every case but that window, and
 * reading it once before anything can swap keeps even that one right in
 * practice.
 *
 * Never re-read per tick: besides costing a hash of ~100 MB every 30 s, a fresh
 * read is the thing being avoided above.
 *
 * Best effort throughout — a box whose binary cannot be hashed still
 * heartbeats, just without this field, which reads as `unknown` rather than as
 * agreement.
 */
export async function runningBinarySha256(host: Host): Promise<string | null> {
  for (const path of ["/proc/self/exe", HERMETICD_PATH]) {
    const digest = await host.sha256File(path).catch(() => null);
    if (digest !== null) return digest;
  }
  log("could not hash this binary; this box will not report which release it is running");
  return null;
}

export async function serve(host: Host, deps: RunDeps = {}): Promise<void> {
  // Before `bootContext`, so nothing that could swap a binary has run yet.
  const hermeticdSha256 = await runningBinarySha256(host);

  const ctx = await bootContext(host, deps);
  // The one thing the two loops share: the heartbeat sees a rollout request on
  // the row, the update loop acts on it (§6.6).
  const gate = makeUpdateGate({ log });

  /**
   * The two ways a binary swap is declared good (§6.5), both of them evidence
   * *this* process produced rather than a clock reading.
   *
   * The heartbeat is the better one: a write that lands means user-data parsed,
   * the instance role signed, DynamoDB answered and every probe ran — the whole
   * chain a bad release breaks. The uptime timer is the fallback for a box
   * whose row was deleted or whose table is unreachable but which is otherwise
   * perfectly alive; without it such a box would carry an unsettled marker
   * until something restarted it four times.
   *
   * Neither may throw into the loops around them: failing to settle costs a
   * stale marker, and the alternative is a service that will not stay up.
   */
  const settled = (): void => {
    void markSwapSettled({ host, log }).catch((e: unknown) => {
      log(`could not settle the last binary swap: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  void settleAfterUptime({ host, log }, SWAP_SETTLE_MS).catch(() => undefined);

  /**
   * §6.5's converge, wired the same way §6.6's rollout is: the heartbeat is the
   * only loop reading the row, so it notices the request and hands it to a gate
   * the converge loop drains. Three loops now, none awaiting another.
   */
  const converge = makeRequestGate<ApplyRequest>((request) => {
    log(
      `converge requested by ${request.issued_by}: config ${request.config_hash} (request ${request.id})`,
    );
  });

  const heartbeat = makeHeartbeat({
    host,
    aws: ctx.aws,
    name: ctx.userData.name,
    hermeticdVersion: HERMETICD_VERSION,
    hermeticdSha256,
    onUpdateRequest: gate.onUpdateRequest,
    onApplyRequest: converge.onRequest,
    onFirstWrite: settled,
  });

  const listener = await serveRpc(
    {
      host,
      name: ctx.userData.name,
      hermeticdVersion: HERMETICD_VERSION,
      configHash: () => readAppliedConfigHash(host),
      // The browser stack's own answer (§7.3). Read from the manifest on disk
      // on every request, like the config hash beside it, so a converge that
      // adds or removes a browser changes what the next `/healthz` reports.
      browsers: () => reportBrowsers(host),
      whois: tailscaleWhois(host),
      // One audit line per RPC, through the same redacting stderr writer
      // everything else here uses — journald is where it belongs (§8.3).
      log,
    },
    { log },
  );
  log(`rpc on ${listener.hostname}:${listener.port}`);

  const forever = new AbortController();
  // Three loops, never awaiting each other.
  const beats = heartbeat.run(forever.signal);
  const updates = updateLoop(host, ctx, gate, forever.signal);
  const converges = convergeLoop(host, ctx, converge, forever.signal);
  await Promise.race([beats, updates, converges]);
}

/**
 * §6.5's converge loop: take a request the heartbeat saw, apply the config the
 * row names, and say so on the agent's own event log.
 *
 * Deliberately small. Everything it could get wrong — which bundle, which
 * secrets, whether a bootstrap is already writing the same files — belongs to
 * `convergeOnce` (`converge.ts`), which does it the way the stages do it. This
 * is the scheduling around it: wait for news, act once, never die.
 *
 * A failure is logged and recorded, and the loop keeps running. The box is
 * still serving whatever it had before, and its `applied_config_hash` still
 * names that older config — which is exactly what makes the rollout on the
 * laptop report this agent as unconverged rather than as done.
 */
export function convergeLoop(
  host: Host,
  ctx: Context,
  gate: RequestGate<ApplyRequest>,
  signal: AbortSignal,
): Promise<void> {
  return runConvergeLoop({
    host,
    gate,
    signal,
    run: (request) =>
      convergeOnce(
        {
          host,
          aws: ctx.aws,
          name: ctx.userData.name,
          bucket: ctx.bucket,
          paramPrefix: ctx.paramPrefix,
          emit: stderrEmit,
          log,
        },
        request,
        bootstrapUnitActive,
      ),
    record: async (action, detail) => {
      await ctx.aws.appendEvent({
        name: ctx.userData.name,
        action,
        from_status: null,
        to_status: null,
        detail,
      });
    },
    log,
  });
}

export interface ConvergeLoopDeps {
  readonly host: Host;
  readonly gate: RequestGate<ApplyRequest>;
  readonly signal?: AbortSignal;
  readonly run: (request: ApplyRequest) => Promise<ConvergeOutcome>;
  /** Writes the agent's event log, so `agent history` carries the outcome. */
  readonly record: (action: string, detail: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

/** The loop without the wiring, so it can be tested without a box. */
export async function runConvergeLoop(deps: ConvergeLoopDeps): Promise<void> {
  const { host, gate, signal } = deps;
  const say = deps.log ?? log;

  while (!signal?.aborted) {
    const request = gate.take();
    if (request) {
      try {
        const outcome = await deps.run(request);
        if (outcome.kind === "deferred") {
          // Not lost: it stays pending, and stops cutting the wait short so the
          // bootstrap window is not a spin loop (`request-gate.ts`).
          gate.restore(request);
          say(`converge ${request.id} deferred: ${outcome.reason}`);
        } else if (outcome.kind === "applied") {
          await deps
            .record("apply", `converged to config ${outcome.config_hash}`)
            .catch(() => undefined);
        }
      } catch (e) {
        const why = redactValue(e instanceof Error ? e.message : String(e));
        say(`converge ${request.id} failed: ${why}`);
        /**
         * Recorded, not thrown. The agent is still running the configuration it
         * had, so this is not a state change — it is a thing that happened,
         * which is what the event log is for, and it is what `agent history`
         * shows an operator whose rollout reported this box unconverged.
         */
        await deps
          .record("apply", `converge to config ${request.config_hash} failed: ${why}`)
          .catch(() => undefined);
      }
    }
    if (signal?.aborted) return;
    await gate.wait(host, CONVERGE_POLL_MS);
  }
}

/** How often the converge loop looks when it has no news. */
export const CONVERGE_POLL_MS = 15_000;

/** `serve`'s wiring of the update loop; the loop itself is `runUpdateLoop`. */
function updateLoop(host: Host, ctx: Context, gate: UpdateGate, signal: AbortSignal): Promise<void> {
  const deps = {
    host,
    aws: ctx.aws,
    name: ctx.userData.name,
    bucket: ctx.bucket,
    hermeticdVersion: HERMETICD_VERSION,
    emit: stderrEmit,
    log,
    // This loop *is* the service, so its restarts are the ones that count.
    asService: true,
  };
  return runUpdateLoop({
    host,
    gate,
    name: ctx.userData.name,
    signal,
    runUpdate: () => maybeUpdate(host, deps),
  });
}

export interface UpdateLoopDeps {
  readonly host: Host;
  readonly gate: UpdateGate;
  /** Whose nightly slot this is (§4.4) — the minute is derived from the name. */
  readonly name: string;
  /** `maybeUpdate` in the service; `null` from it means "not now". */
  readonly runUpdate: () => Promise<unknown>;
  /** The service never aborts; a test does, to get its loop back. */
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
}

/**
 * Once at start-up — a box that has been off for a week should catch up before
 * it does anything else — once per nightly slot after that, and immediately
 * whenever `foundation.update` asks for it (§6.6).
 *
 * The wait at the bottom is `gate.wait`, not `host.sleep`, so a rollout request
 * does not sit out the poll interval. It is still a full sleep whenever the
 * loop has nothing new: a deferred request (the bootstrap unit is still
 * running) stays pending without cutting the wait short, or the whole bootstrap
 * window would be a spin of `systemctl is-active` and manifest fetches.
 */
export async function runUpdateLoop(deps: UpdateLoopDeps): Promise<void> {
  const { host, gate, name, runUpdate, signal } = deps;
  const say = deps.log ?? log;
  let nightlyDue = host.now().getTime() + msUntilNightly(host.now(), name);
  let first = true;

  while (!signal?.aborted) {
    const due = first || host.now().getTime() >= nightlyDue;
    try {
      const outcome = await updateTick(gate, due, runUpdate);
      // Only the nightly slot moves the nightly slot: a requested update is an
      // extra run, not a replacement for the scheduled one.
      if (due && outcome === "ran") {
        first = false;
        nightlyDue = host.now().getTime() + msUntilNightly(host.now(), name);
      }
    } catch (e) {
      say(`update: ${redactValue(e instanceof Error ? e.message : String(e))}`);
    }
    if (signal?.aborted) return;
    await gate.wait(host, UPDATE_POLL_MS);
  }
}

/** What one turn of the update loop did. */
export type UpdateTickOutcome = "idle" | "ran" | "deferred";

/**
 * One turn of the update loop, without the loop — the scheduling arithmetic and
 * the error handling stay in `runUpdateLoop`, so this is the part worth
 * testing on its own.
 *
 * `runUpdate` is `maybeUpdate`, which returns `null` while the bootstrap unit
 * is still running its stages. A request that lands in that window is put back
 * rather than dropped: the heartbeat de-duplicates on id and will not report it
 * again. A request that fails for any other reason is *not* put back — hermetic
 * lists the box as a straggler and the nightly check picks it up, which is
 * better than retrying a permanent failure every minute forever.
 */
export async function updateTick(
  gate: UpdateGate,
  due: boolean,
  /** `null` means "not now" — the only outcome this function branches on. */
  runUpdate: () => Promise<unknown>,
): Promise<UpdateTickOutcome> {
  const requested = gate.take();
  if (!due && requested === null) return "idle";
  const result = await runUpdate();
  if (result === null) {
    if (requested) gate.restore(requested);
    return "deferred";
  }
  return "ran";
}

/**
 * The states in which the bootstrap unit is doing something, or might be.
 *
 * `activating` is the one that matters and the one the old probe missed. A
 * `Type=oneshot` unit is `activating` for the whole of its `ExecStart` — which
 * for this unit is the entire boot, stages and all — and only ever reaches
 * `active` for the instant before it finishes. `systemctl is-active --quiet`
 * exits non-zero for `activating`, so the question "is the bootstrap running"
 * was being answered "no" precisely while it was running, and the updater took
 * that as leave to rewrite `/opt/hermetic/stages` under a runner mid-stage.
 */
export const BUSY_UNIT_STATES = new Set(["active", "activating", "reloading", "deactivating"]);

/**
 * The states in which it is certainly not. Everything else — including an
 * unreadable answer and a `systemctl` that would not run — is busy: the cost of
 * guessing "busy" wrongly is one deferred update a minute later, and the cost
 * of guessing "idle" wrongly is two installers in one directory.
 */
export const IDLE_UNIT_STATES = new Set(["inactive", "failed"]);

/** What systemd says about a unit, and what this box concludes from it. */
export interface UnitBusy {
  readonly busy: boolean;
  /** `ActiveState (SubState)`, or why there is no answer. For the log line. */
  readonly detail: string;
}

/**
 * Ask systemd what the bootstrap unit is doing, and fail closed.
 *
 * `systemctl show` rather than `is-active`, and without `--value`: the reply is
 * `ActiveState=activating\nSubState=start`, which says which property each
 * value belongs to instead of relying on systemd listing them in the order
 * they were asked for. `is-active`'s exit code cannot express `activating` at
 * all, which is the distinction this whole function exists to draw.
 */
export async function bootstrapUnitBusy(host: Host, unit = BOOTSTRAP_UNIT): Promise<UnitBusy> {
  const res = await host
    .exec(["systemctl", "show", "-p", "ActiveState", "-p", "SubState", unit])
    .catch(() => null);
  if (res === null || res.code !== 0) {
    const why = res === null ? "systemctl could not be run" : `systemctl exited ${res.code}`;
    return { busy: true, detail: `${unit}: ${why}` };
  }
  const props = new Map<string, string>();
  for (const line of res.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0)
      props.set(
        line.slice(0, at).trim(),
        line
          .slice(at + 1)
          .trim()
          .toLowerCase(),
      );
  }
  const active = props.get("ActiveState") ?? "";
  const sub = props.get("SubState") ?? "";
  const shown = sub ? `${active} (${sub})` : active || "no ActiveState in systemctl's reply";
  if (IDLE_UNIT_STATES.has(active)) return { busy: false, detail: `${unit}: ${shown}` };
  if (BUSY_UNIT_STATES.has(active)) return { busy: true, detail: `${unit} is ${shown}` };
  return { busy: true, detail: `${unit}: ${shown}` };
}

/** True while `hermeticd-bootstrap.service` might still be running its stages. */
export async function bootstrapUnitActive(host: Host): Promise<boolean> {
  return (await bootstrapUnitBusy(host)).busy;
}

/**
 * The start-up update, skipped while the boot is still in flight.
 *
 * `05-service` starts `hermeticd.service`, whose update loop runs immediately —
 * while the bootstrap runner is still in `05`/`06`. If a new release landed in
 * that window both would be installing stages into `/opt/hermetic/stages` at
 * once. Returns `null` when it skipped, so the caller tries again next tick.
 *
 * A systemd query *and* a lock file, where this used to say a lock file was the
 * wrong shape because it outlives the process that took it. That objection was
 * right about a bare lock file and is answered by one that records its holder:
 * `install-lock.ts` treats a lock whose pid is gone, or whose boot id is not
 * this boot, as the litter it is. The two are not redundant — this query is
 * cheap and covers the common case without touching the disk, and the lock
 * covers the direction systemd cannot answer, since the bootstrap runner has no
 * way to ask whether the *updater* is installing right now (`hermeticd.service`
 * is `active` either way).
 */
export async function maybeUpdate(
  host: Host,
  deps: Parameters<typeof update>[0],
): Promise<Awaited<ReturnType<typeof update>> | null> {
  const bootstrap = await bootstrapUnitBusy(host);
  if (bootstrap.busy) {
    log(`${bootstrap.detail}; deferring the update`);
    return null;
  }
  return await update(deps);
}

/** How often the scheduler checks whether the nightly slot has arrived. */
export const UPDATE_POLL_MS = 60_000;
