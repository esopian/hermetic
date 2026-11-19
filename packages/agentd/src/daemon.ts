/**
 * `hermeticd serve` — the systemd service and its six loops. The subcommands
 * that run and exit are in `cli.ts`; `main.ts` is the entrypoint.
 */
import type { Host } from "./host.ts";
import { must } from "./host.ts";
import { UNIT_DIR } from "./apply/shared.ts";
import { readAppliedConfigHash } from "./manifest.ts";
import { BOOTSTRAP_UNIT } from "./bootstrap.ts";
import { makeHeartbeat } from "./heartbeat.ts";
import { HERMETICD_PATH } from "./stages.ts";
import { STATE_DIR } from "./fleet.ts";
import { reportBrowsers } from "./browser-health.ts";
import { haltHermes, serveRpc, tailscaleWhois } from "./rpc.ts";
import { fleetViewSource, makeMobileRoutes } from "./rpc-mobile.ts";
import { pushDeviceStore } from "./push/devices.ts";
import { bunChatSocket } from "./push/socket.ts";
import { createWatcher } from "./push/watch.ts";
import { tailnetLogins } from "./tailscale.ts";
import { createHermesChat } from "@hermetic/core/chat-client";
import { HERMES_DASHBOARD_UNIT, expoPushSender, expoReceiptFetcher } from "@hermetic/core/shared";
import { startFiles } from "./files/service.ts";
import { makeFilesSettings, type FilesSettingsHolder } from "./files/settings.ts";
import {
  SWAP_SETTLE_MS,
  autoUpdate,
  markSwapSettled,
  msUntilNightly,
  settleAfterUptime,
  update,
  type UpdateDeps,
  type UpdateResult,
} from "./update/index.ts";
import { makeUpdateGate, type UpdateGate } from "./update-request.ts";
import { makeRequestGate, type RequestGate } from "./request-gate.ts";
import { convergeOnce, type ConvergeOutcome, heldResumeRequest, NEEDS_OPERATOR } from "./converge.ts";
import { APPLY_LOCK_PATH, readInstallLock, takeInstallLock } from "./install-lock.ts";
import { makeSecretsSyncer } from "./secrets-sync.ts";
import { ensureLoginShell } from "./apply/accounts.ts";
import type { ApplyRequest } from "@hermetic/core/schema";
import { redactValue } from "./redact.ts";
import { AgentdError } from "./errors.ts";
import { HERMETICD_VERSION } from "./version.ts";
import { bootContext, log, stderrEmit, type Context, type RunDeps } from "./context.ts";
import { withUpgradeHistory } from "./events.ts";

/**
 * The systemd service (§6.4): heartbeat every 30 s, self-update at start-up and
 * at 03:17 UTC, answer operator RPCs on the Tailscale interface, and watch the
 * box's own gateway for pushes to paired phones (§9.4).
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

/**
 * systemd's default `OOMPolicy=stop` stops a whole service when the kernel
 * OOM-kills any process in its cgroup: a web build an apply runs took hermeticd
 * down mid-swap, so no rollback ever ran. With `continue` the build fails as a
 * command (exit 137) and the apply rolls back. Also the bootstrap unit, whose
 * stage `hermeticd apply` (`agent rerun`, a reboot's drift rerun) can swap too;
 * on a fresh box it is written only once this first runs, after `04-apply`.
 * Drop-ins written here rather than in the rendered unit, so they are in force
 * (systemd reads `OOMPolicy` at the OOM event, from the unit as last loaded)
 * before the first converge of a box whose unit predates them: the apply's
 * files phase runs after the install they guard.
 */
export const oomDropIn = (unit: string): string => `${UNIT_DIR}/${unit}.d/hermetic-oom.conf`;
const OOM_CONF =
  "# Written by hermeticd: an OOM-killed child fails its command instead of stopping this unit.\n" +
  "[Service]\nOOMPolicy=continue\n";

export async function ensureOomPolicy(host: Host): Promise<boolean> {
  let wrote = false;
  for (const unit of ["hermeticd.service", BOOTSTRAP_UNIT]) {
    if ((await host.readFile(oomDropIn(unit))) === OOM_CONF) continue;
    await host.mkdir(`${UNIT_DIR}/${unit}.d`, "0755");
    await host.writeFile(oomDropIn(unit), OOM_CONF, "0644");
    wrote = true;
  }
  if (wrote) await must(host, ["systemctl", "daemon-reload"]);
  return wrote;
}

export async function serve(host: Host, deps: RunDeps = {}): Promise<void> {
  // Before `bootContext`, so nothing that could swap a binary has run yet.
  const hermeticdSha256 = await runningBinarySha256(host);

  const ctx = await bootContext(host, deps);
  // Before any loop starts, so before any converge can run a build.
  await ensureOomPolicy(host).catch((e: unknown) => {
    log(`could not set hermeticd's OOM policy: ${e instanceof Error ? e.message : String(e)}`);
  });
  /**
   * The account fixes a release carries but no apply will run for it: a
   * self-update restarts this service and nothing else (§6.5). Best effort —
   * a `usermod` that fails costs the operator's SSH login, not the heartbeat.
   */
  await ensureLoginShell(host).then(
    (changed) => {
      if (changed) log("gave the hermes account its login shell");
    },
    (e: unknown) => {
      log(
        `could not give the hermes account its login shell: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  );
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

  /**
   * The managed `.env` block (§8.1): synced on the first heartbeat tick, when
   * the provider slot's `Version` moves, when a bot directory appears, and on
   * the laptop's `POST /secrets/sync`.
   */
  const secrets = makeSecretsSyncer({ host, aws: ctx.aws, paramPrefix: ctx.paramPrefix, log });

  const heartbeat = makeHeartbeat({
    host,
    aws: ctx.aws,
    name: ctx.userData.name,
    hermeticdVersion: HERMETICD_VERSION,
    hermeticdSha256,
    onUpdateRequest: gate.onUpdateRequest,
    onApplyRequest: converge.onRequest,
    onFirstWrite: settled,
    secretsTick: secrets.tick,
  });

  // The phones this box pushes to: written by `POST /push/devices`, read by
  // the gateway watcher, pruned by Expo's receipts (§9.4).
  const devices = pushDeviceStore(host, log);
  const mobile = makeMobileRoutes({
    fleetView: fleetViewSource({
      aws: ctx.aws,
      manifest: () => ctx.fleet,
      now: () => host.now(),
      log,
    }),
    devices,
    now: () => host.now().getTime(),
    log,
  });

  // The fleet's files settings: the cached manifest's now, then every manifest
  // the update loop fetches (`updateLoop`'s `onManifest`). A change on the
  // laptop takes effect at this box's next manifest read (`files/settings.ts`).
  const filesSettings = makeFilesSettings(ctx.fleet, log);

  // The files service (attachments, request slots, the plugin socket). Best
  // effort throughout: without it the box is an older hermeticd to the laptop.
  const files = await startFiles({
    host,
    aws: ctx.aws,
    paramPrefix: ctx.paramPrefix,
    name: ctx.userData.name,
    hermeticdVersion: HERMETICD_VERSION,
    log,
    settings: filesSettings.current,
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
      mobile,
      ...(files.tailnet ? { files: files.tailnet } : {}),
      secretsSync: async () => {
        const synced = await secrets.sync();
        return { changed: synced.changed.length > 0 || synced.memoryChanged, bots: synced.bots };
      },
      powerHalt: () => haltHermes(host),
    },
    { log },
  );
  log(`rpc on ${listener.hostname}:${listener.port}`);

  const forever = new AbortController();
  // Six loops, never awaiting each other. The files sweeper and the profiles
  // poll never resolve on their own; they are in the race so they stop with the rest.
  const beats = heartbeat.run(forever.signal);
  const updates = updateLoop(host, ctx, gate, forever.signal, filesSettings);
  const converges = convergeLoop(host, ctx, converge, forever.signal);
  const watches = pushWatchLoop(host, ctx, devices, forever.signal);
  const sweeps = files.run(forever.signal);
  const profiles = secrets.watchProfiles(forever.signal);
  await Promise.race([beats, updates, converges, watches, sweeps, profiles]);
}

/**
 * §9.4's gateway watcher, wired: the chat adapter over Bun's `fetch` and
 * `WebSocket` against this box's own dashboard on loopback, Expo's public push
 * API over the same `fetch`, and agentd's redaction on every preview. Idle
 * while the dashboard unit is not running — a box mid-bootstrap or with Hermes
 * stopped has nothing to watch. The loop never throws (`push/watch.ts`), so a
 * gateway outage costs pushes, never the heartbeat beside it.
 */
function pushWatchLoop(
  host: Host,
  ctx: Context,
  devices: ReturnType<typeof pushDeviceStore>,
  signal: AbortSignal,
): Promise<void> {
  const http = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(input, init);
  const watcher = createWatcher({
    chat: createHermesChat({
      fetch: http,
      openSocket: bunChatSocket,
      now: () => host.now().toISOString(),
    }),
    devices,
    send: expoPushSender(http),
    fetchReceipts: expoReceiptFetcher(http),
    now: () => host.now().getTime(),
    sleep: (ms) => host.sleep(ms),
    log,
    instance: ctx.userData.name,
    fleet_id: ctx.fleet.fleet_id,
    redact: redactValue,
    gatewayUp: async () => {
      const res = await host
        .exec(["systemctl", "is-active", "--quiet", HERMES_DASHBOARD_UNIT])
        .catch(() => null);
      return res !== null && res.code === 0;
    },
    // Owners who have left the tailnet lose their registrations (§9.4).
    tailnetLogins: () => tailnetLogins(host),
  });
  return watcher.run(signal);
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
  const record = async (action: string, detail: string): Promise<void> => {
    await ctx.aws.appendEvent({
      name: ctx.userData.name,
      action,
      from_status: null,
      to_status: null,
      detail,
    });
  };
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
          emit: withUpgradeHistory(stderrEmit, record),
          log,
        },
        request,
        bootstrapUnitActive,
      ),
    record,
    resume: () => heldResumeRequest(host),
    reportFailure: async (request, code) => {
      await ctx.aws.reportApplyFailure(ctx.userData.name, {
        request_id: request.id,
        config_hash: request.config_hash,
        code,
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
  /** Writes `apply_failure` on the row: the request that failed and hermeticd's code for why. */
  readonly reportFailure: (request: ApplyRequest, code: string) => Promise<void>;
  /**
   * Asked at start, then every `RESUME_RETRY_MS` while nothing is pending: a
   * request the box owes itself, such as finishing a Hermes swap a crash cut
   * short (`heldResumeRequest`). A request the heartbeat delivers meanwhile
   * replaces it, and either one re-applies.
   */
  readonly resume?: () => Promise<ApplyRequest | null>;
  readonly log?: (message: string) => void;
}

/** The loop without the wiring, so it can be tested without a box. */
export async function runConvergeLoop(deps: ConvergeLoopDeps): Promise<void> {
  const { host, gate, signal } = deps;
  const say = deps.log ?? log;

  const owed = await deps.resume?.().catch(() => null);
  if (owed && gate.pending() === null) gate.onRequest(owed);
  let nextResume = host.now().getTime() + RESUME_RETRY_MS;
  let needsOperator = false;

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
        } else {
          needsOperator = false;
          if (outcome.kind === "applied") {
            await deps
              .record("apply", `converged to config ${outcome.config_hash}`)
              .catch(() => undefined);
          }
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
        const code = e instanceof AgentdError ? e.code : "INTERNAL";
        needsOperator = NEEDS_OPERATOR.has(code);
        // Kept until written: the heartbeat never re-delivers this request, so a
        // lost report would leave the laptop waiting out a timeout instead of the code.
        await deps
          .reportFailure(request, code)
          .then(
            () => host.remove(UNSENT_FAILURE_PATH),
            async () => {
              await host.mkdir(STATE_DIR, "0755");
              await host.writeFile(
                UNSENT_FAILURE_PATH,
                `${JSON.stringify({ request, code })}\n`,
                "0600",
              );
            },
          )
          .catch(() => undefined);
      }
      nextResume = host.now().getTime() + RESUME_RETRY_MS;
    }
    if (signal?.aborted) return;
    await resendFailure(deps).catch(() => undefined);
    // A box left held with nothing pending is never a resting state: ask again,
    // unless the last failure is one that waits for an operator by design.
    if (!needsOperator && gate.pending() === null && host.now().getTime() >= nextResume) {
      nextResume = host.now().getTime() + RESUME_RETRY_MS;
      const again = await deps.resume?.().catch(() => null);
      if (again && gate.pending() === null) gate.onRequest(again);
    }
    await gate.wait(host, CONVERGE_POLL_MS);
  }
}

/** A failure report DynamoDB did not take, retried each tick until it lands. Root-owned. */
export const UNSENT_FAILURE_PATH = `${STATE_DIR}/apply-failure.unsent.json`;

async function resendFailure(deps: ConvergeLoopDeps): Promise<void> {
  const raw = await deps.host.readFile(UNSENT_FAILURE_PATH);
  if (raw === null) return;
  let unsent: { request: ApplyRequest; code: string };
  try {
    unsent = JSON.parse(raw) as { request: ApplyRequest; code: string };
  } catch {
    await deps.host.remove(UNSENT_FAILURE_PATH);
    return;
  }
  await deps.reportFailure(unsent.request, unsent.code);
  await deps.host.remove(UNSENT_FAILURE_PATH);
}

/** How often the converge loop asks again whether a held Hermes swap is owed a resume. */
export const RESUME_RETRY_MS = 10 * 60_000;

/** How often the converge loop looks when it has no news. */
export const CONVERGE_POLL_MS = 15_000;

/** `serve`'s wiring of the update loop; the loop itself is `runUpdateLoop`. */
function updateLoop(
  host: Host,
  ctx: Context,
  gate: UpdateGate,
  signal: AbortSignal,
  filesSettings: FilesSettingsHolder,
): Promise<void> {
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
    // Every manifest this loop reads carries the fleet's files settings.
    onManifest: filesSettings.update,
  };
  return runUpdateLoop({
    host,
    gate,
    name: ctx.userData.name,
    signal,
    runUpdate: () => maybeUpdate(host, deps),
    runAutoCheck: () => maybeUpdate(host, deps, { auto: true }),
  });
}

export interface UpdateLoopDeps {
  readonly host: Host;
  readonly gate: UpdateGate;
  /** Whose nightly slot this is (§4.4) — the minute is derived from the name. */
  readonly name: string;
  /** `maybeUpdate` in the service; `null` from it means "not now". */
  readonly runUpdate: () => Promise<unknown>;
  /**
   * The auto-update backstop, every `AUTO_UPDATE_CHECK_MS` between full runs:
   * `maybeUpdate(…, { auto: true })` in the service, which reads the fleet
   * manifest and does nothing more when it switches auto-update off. Its result
   * is not looked at — it never moves the nightly slot, and a deferral or a
   * failure simply waits for the next interval. Absent: no backstop.
   */
  readonly runAutoCheck?: () => Promise<unknown>;
  /** The service never aborts; a test does, to get its loop back. */
  readonly signal?: AbortSignal;
  readonly log?: (message: string) => void;
}

/**
 * Once at start-up — a box that has been off for a week should catch up before
 * it does anything else — once per nightly slot after that, and immediately
 * whenever `foundation.update` asks for it (§6.6). In between, every
 * `AUTO_UPDATE_CHECK_MS`, an auto check (`runAutoCheck`) installs a changed
 * release if the fleet manifest leaves auto-update on.
 *
 * The wait at the bottom is `gate.wait`, not `host.sleep`, so a rollout request
 * does not sit out the poll interval. It is still a full sleep whenever the
 * loop has nothing new: a deferred request (the bootstrap unit is still
 * running) stays pending without cutting the wait short, or the whole bootstrap
 * window would be a spin of `systemctl is-active` and manifest fetches.
 */
export async function runUpdateLoop(deps: UpdateLoopDeps): Promise<void> {
  const { host, gate, name, runUpdate, runAutoCheck, signal } = deps;
  const say = deps.log ?? log;
  let nightlyDue = host.now().getTime() + msUntilNightly(host.now(), name);
  let autoDue = host.now().getTime() + AUTO_UPDATE_CHECK_MS;
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
      if (outcome === "ran") {
        // A full run has just read the manifest; the backstop counts from it.
        autoDue = host.now().getTime() + AUTO_UPDATE_CHECK_MS;
      } else if (outcome === "idle" && runAutoCheck !== undefined && host.now().getTime() >= autoDue) {
        // Moved before the check, so one that throws or is deferred waits out
        // the interval like one that passed, instead of retrying every poll.
        autoDue = host.now().getTime() + AUTO_UPDATE_CHECK_MS;
        await runAutoCheck();
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
  deps: UpdateDeps,
  /**
   * `auto`: the backstop check (`autoUpdate`) rather than a full `update`. It
   * defers without a log line — it runs again in `AUTO_UPDATE_CHECK_MS`, and a
   * bootstrap in progress is not news to it.
   */
  opts: { readonly auto?: boolean } = {},
): Promise<UpdateResult | "off" | null> {
  const bootstrap = await bootstrapUnitBusy(host);
  // A restart mid-apply would cut a Hermes swap or its rollback short, so the
  // update holds the apply lock through its restart: an apply (converge here,
  // or a stage's `hermeticd apply`) started meanwhile defers or waits. A held
  // box with no apply running may restart: `serve` resumes the swap on start,
  // and an operator-held box may need the new hermeticd to recover.
  const lock = bootstrap.busy ? null : await takeInstallLock(host, "update", { path: APPLY_LOCK_PATH });
  if (lock === null) {
    if (opts.auto !== true) {
      const applying = bootstrap.busy ? null : await readInstallLock(host, APPLY_LOCK_PATH);
      const busy = bootstrap.busy
        ? bootstrap.detail
        : `an apply (pid ${applying?.pid ?? "?"}) is running`;
      log(`${busy}; deferring the update`);
    }
    return null;
  }
  try {
    return opts.auto === true ? await autoUpdate(deps) : await update(deps);
  } finally {
    // Reached only when no restart took: a successful one ends this process,
    // and the lock it leaves names a pid that is gone.
    await lock.release();
  }
}

/** How often the scheduler checks whether the nightly slot has arrived. */
export const UPDATE_POLL_MS = 60_000;

/**
 * How often the update loop checks the fleet manifest for a new release while
 * `auto_update_hermeticd` is on — the backstop for a box the laptop's
 * `update_request` nudge did not reach. A multiple of `UPDATE_POLL_MS`, which
 * is the loop's resolution.
 */
export const AUTO_UPDATE_CHECK_MS = 5 * 60_000;
