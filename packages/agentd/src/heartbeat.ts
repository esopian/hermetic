/**
 * The heartbeat (§6.4): every 30 s hermeticd writes `last_heartbeat`,
 * `health{hermes, tailscale, disk, dashboard}` and
 * `metrics{cpu_pct, mem_pct, disk_pct, root_disk_pct?, root_free_mib?}` to its own row, and moves
 * `ready → degraded` when a check fails, back on recovery. `degraded` finally
 * has a writer.
 *
 * The write itself is unconditional — the heartbeat must never lose a race with
 * the operator — while the status change is guarded on the current status, so a
 * heartbeat cannot resurrect a `destroying` agent (§4.3).
 */
import type { Agent, ApplyRequest, Health, Metrics, UpdateRequest } from "@hermetic/core/schema";
import { HERMES_DASHBOARD_PORT, HERMES_HOME } from "@hermetic/core/shared";
import { HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT } from "@hermetic/core/shared";
import type { Aws } from "./aws.ts";
import type { Host } from "./host.ts";
import { DATA_MOUNT } from "./disk.ts";
import { STATE_DIR } from "./fleet.ts";
import { readAppliedConfigHash } from "./manifest.ts";
import { tailscaleIpv4, tailscaleSelf } from "./tailscale.ts";

export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Hysteresis. A single missed probe is usually a restart, a slow journal flush
 * or a Tailscale re-key, and flapping `ready ⇄ degraded` every 30 s is worse
 * than being 90 s late to the truth. Going down is deliberately slower than
 * coming back up.
 */
export const DEGRADE_AFTER_TICKS = 3;
export const RECOVER_AFTER_TICKS = 2;
/** `/data` — or the root filesystem — above this is a failed disk check. */
export const DISK_FULL_PCT = 90;
/**
 * The second filesystem the heartbeat samples. `/data` is the agent's memory;
 * this is everything else, and it fails differently: the self-update refuses to
 * swap `/usr/local/bin/hermeticd` when the filesystem holding it is short of
 * space (`update.ts`'s `freeSpaceFor`), and until now that showed up only as an
 * `update-failed` event on a box whose `/data` bar still read comfortable.
 *
 * `/` is the sample point rather than `/usr/local/bin` because they are the same
 * filesystem: hermeticd mounts exactly one extra volume, `/data` (`disk.ts`), so
 * the binary, its `.prev` backup, `/var/lib/hermeticd` and the stage logs all
 * live on the root filesystem. Sampling the mount point rather than a directory
 * inside it also means the reading survives a box where the binary is missing —
 * which is precisely the box whose free space is worth knowing.
 */
export const ROOT_MOUNT = "/";
/**
 * Hermes's own liveness route, rather than a path invented for this probe.
 * `GET /api/health` is a real handler (`hermes_cli/web_routers/status.py:113-116`)
 * and sits on the unauthenticated allowlist both auth gates share
 * (`hermes_cli/dashboard_auth/public_paths.py:9-27`), whose docstring requires
 * every entry on it to be "safe for external uptime probes".
 *
 * It replaces `/healthz`, which Hermes has never routed. The SPA is mounted on a
 * catch-all (`mount_spa`, `hermes_cli/web_server_dashboard.py:93`) that falls
 * back to `index.html` for any unmatched path, and only `/api/*` 404s honestly.
 * So `/healthz` answered 200 out of the bundle whenever a socket was bound and
 * the bundle was readable: a check that could not fail while anything at all
 * was listening on the port.
 */
export const HERMES_HEALTH_URL = `http://127.0.0.1:${String(HERMES_DASHBOARD_PORT)}/api/health`;
/**
 * The gateway's own account of itself, which systemd cannot give: `NRestarts`
 * says a process died, this says what it was doing when it did. Written by
 * `write_runtime_status` into `$HERMES_HOME` (`gateway/status.py:32`, `:165`,
 * `:804-867`) and read here the way upstream's own CLI reads it
 * (`hermes_cli/gateway.py:1169-1175`, `:4970-5008`).
 *
 * An internal format, not an API — `COMPAT_MANIFEST.md:3-4` is explicit that
 * upstream's internals are not a stable surface. So every read below tolerates
 * the file being absent, truncated, or a shape this build does not recognise,
 * and none of those is a failed check on its own: this file adds a reason to
 * signals hermeticd already has, it is never the only witness to anything.
 */
export const GATEWAY_STATE_PATH = `${HERMES_HOME}/gateway_state.json`;
/**
 * How old a `gateway_state.json` snapshot may be before nothing in it is
 * believed — upstream's own `_RUNTIME_STATUS_STALE_TTL_S`
 * (`gateway/status.py:875-884`), which exists because the file outlives a
 * gateway killed ungracefully.
 *
 * Both directions matter here. A stale `startup_failed` describes a failure
 * that may have been over for a week and must not degrade a box that is running
 * now; a stale `restart_requested` must not excuse a restart that happened
 * since. The gateway re-stamps `updated_at` on every write
 * (`gateway/status.py:831`), so a fresh snapshot is the ordinary case.
 */
export const GATEWAY_STATE_STALE_MS = 120_000;
/**
 * The two units whose liveness together *is* the agent's: the dashboard
 * hermetic renders and the gateway upstream installs (§6.4). Both are sampled
 * for the one `health.hermes` the row carries — an agent whose gateway is dead
 * has no messaging channels and no cron, and is not a healthy agent however
 * well its dashboard answers.
 */
export const HERMES_UNITS = [HERMES_DASHBOARD_UNIT, HERMES_GATEWAY_UNIT] as const;
/**
 * What one `systemctl show` asks for. `ActiveState` alone is not enough:
 * systemd reports a unit between crashes as `activating (auto-restart)`, whose
 * `ActiveState` is `activating` but which `systemctl is-active` calls active.
 */
export const UNIT_SHOW_PROPERTIES = "ActiveState,SubState,NRestarts";
/**
 * Longer than the Hermes probe's 3 s: this one goes out to the tailnet and back
 * through `tailscale serve`, and a TLS handshake on a cold node is not a fast
 * loopback GET. Still far inside the 30 s tick.
 */
export const DASHBOARD_TIMEOUT_MS = 5_000;

/**
 * The URL the operator actually opens (§4.7) — the node's own MagicDNS name over
 * HTTPS, which is what `tailscale serve --https=443` publishes. The box probes
 * *itself* through the public name on purpose: hitting `127.0.0.1:9119` again
 * would only re-check Hermes, and it is the hop in front of Hermes that fails
 * silently when the tailnet has HTTPS certificates disabled in the admin console.
 */
export function dashboardUrl(dnsName: string): string {
  return `https://${dnsName}/`;
}

/**
 * Where the two counters a tick compares *against* are kept between processes.
 *
 * Both are deltas — systemd's `NRestarts` summed over the Hermes units, and
 * the cumulative jiffies in `/proc/stat` — so each is only ever as good as the
 * sample before it. Held in memory alone, that sample died with the process,
 * and hermeticd restarts itself every time it takes a release (§6.5): a Hermes
 * that had been crash-looping all night was handed a clean sheet by the nightly
 * update, reported `h+` for the tick after it, and the very check written to
 * catch a crash loop was blinded by the one event guaranteed to happen daily.
 *
 * A file, not the row: this is the box's own scratch, it is compared only
 * against itself, and a DynamoDB read on the path of a 30 s loop buys nothing.
 * 0644 and no secrets, like the fleet cache beside it.
 */
export const BASELINE_PATH = `${STATE_DIR}/heartbeat.json`;

/**
 * How often the baseline is refreshed when nothing about it has changed —
 * every fourth tick, so about every two minutes. See `baselineDue`.
 */
export const BASELINE_WRITE_EVERY = 4;

/** The previous tick's readings, as the next process picks them up. */
export interface HeartbeatBaseline {
  /** `NRestarts` summed over `HERMES_UNITS`; `null` when systemd said nothing. */
  readonly restarts: number | null;
  readonly cpu: CpuSample | null;
}

/**
 * `null` for anything that is not a baseline this build wrote — including a
 * file truncated by a power cut. A baseline is an optimisation, never a fact
 * worth failing a heartbeat over: losing one costs exactly what the old
 * in-memory behaviour cost, one tick with no delta.
 */
export function parseBaseline(text: string): HeartbeatBaseline | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;
  const restarts = record["restarts"];
  const cpu = record["cpu"];
  const sample =
    typeof cpu === "object" &&
    cpu !== null &&
    typeof (cpu as Record<string, unknown>)["total"] === "number" &&
    typeof (cpu as Record<string, unknown>)["idle"] === "number"
      ? ({
          total: (cpu as Record<string, number>)["total"] as number,
          idle: (cpu as Record<string, number>)["idle"] as number,
        } satisfies CpuSample)
      : null;
  return {
    restarts: typeof restarts === "number" && Number.isFinite(restarts) ? restarts : null,
    cpu: sample,
  };
}

export interface HeartbeatDeps {
  readonly host: Host;
  readonly aws: Aws;
  readonly name: string;
  readonly hermeticdVersion: string;
  /**
   * The digest of the binary this process was launched from, reported on every
   * tick so the fleet can tell a box that took a release from one that merely
   * answered the phone (`Agent.running_hermeticd_sha256`).
   *
   * Passed in rather than computed here, and computed once at start-up rather
   * than per tick, for two reasons: the binary is ~100 MB and this loop runs
   * every 30 s, and — the part that matters — the digest of the *file* stops
   * being the digest of the *running code* the moment a swap lands without its
   * restart. `serve` reads it before anything can swap anything.
   *
   * Optional so every existing caller and test keeps working; absent means the
   * field is simply not written, which reads as `unknown`.
   */
  readonly hermeticdSha256?: string | null;
  /**
   * No `hermesVersion` here any more.
   *
   * There was one, it was written to the row when set, and **no caller ever set
   * it** — so `agents.hermes_version` was only ever laptop-authored and every
   * surface rendered an intention as a fact. Wiring the dead parameter with the
   * pinned version would only have laundered the laptop's claim through the
   * box; what the box reports now is `running_hermes_version`, read out of
   * Hermes's own `/api/health` body (`versionFromHealth`), which is a fact it
   * is in a position to state.
   */
  readonly fetchImpl?: typeof fetch;
  /** Overridable so a test can watch the timeout fire without waiting 5 s for it. */
  readonly dashboardTimeoutMs?: number;
  /**
   * Called once per distinct `update_request.id` seen on the row (§6.6). The
   * heartbeat is the only loop that already reads the row, so it is where a
   * rollout request is noticed — but it does not update anything itself: the
   * callback hands the request to the update loop (`update-request.ts`), which
   * keeps the two loops uncoupled.
   */
  readonly onUpdateRequest?: (request: UpdateRequest) => void;
  /**
   * Called once per distinct `apply_request.id` seen on the row (§6.5) — the
   * converge receiver's half of the same arrangement `onUpdateRequest` has. The
   * heartbeat is the only loop already reading the row, so it is the only thing
   * that can notice either.
   */
  readonly onApplyRequest?: (request: ApplyRequest) => void;
  /**
   * Called after the first heartbeat write that succeeds, and never again.
   *
   * It is the best evidence this box produces that a new hermeticd release
   * actually works: reaching it means user-data parsed, the instance role
   * signed, DynamoDB answered and every probe ran. `serve` uses it to settle a
   * binary swap (§6.5) — which is why it is a callback rather than something
   * the heartbeat decides, since the heartbeat has no business knowing what an
   * update is.
   */
  readonly onFirstWrite?: () => void;
}

export interface HeartbeatTick {
  readonly health: Health;
  readonly metrics: Metrics;
  /** The row as it was read at the start of the tick, for the status decision. */
  readonly row: Agent | null;
  /** The status transition this tick performed, if any. */
  readonly transitioned: "degraded" | "ready" | null;
  /** False when the row is gone and the heartbeat write was refused. */
  readonly written: boolean;
}

export interface Heartbeat {
  once(): Promise<HeartbeatTick>;
  run(signal: AbortSignal): Promise<void>;
}

/** What the Hermes probe concluded, and — when it failed — what gave it away. */
export interface HermesProbe {
  readonly ok: boolean;
  /**
   * One phrase per reason, for the degrade detail; empty when the probe passed.
   * The operator's next move is `hermetic logs <name> --unit <unit>`, so a unit
   * that is down has to name itself here and not only in the journal.
   */
  readonly failing: readonly string[];
}

export function makeHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const { host, aws, name } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const dashboardTimeoutMs = deps.dashboardTimeoutMs ?? DASHBOARD_TIMEOUT_MS;
  let previousCpu: CpuSample | null = null;
  /**
   * `NRestarts`, summed over `HERMES_UNITS`, as of the previous tick. A *delta*
   * is what matters, so a process with no previous sample has no delta to
   * report rather than a zero one — but "no previous sample" now means the box
   * has never taken a tick, not merely that this process has not. Both counters
   * are loaded from `BASELINE_PATH` on the first tick and written back on every
   * one, so a hermeticd restart is no longer an amnesty for a crash-looping
   * Hermes.
   */
  let previousRestarts: number | null = null;
  let baselineLoaded = false;
  let stateDirReady = false;
  /** Ticks since this process started, and the restart count last persisted. */
  let ticks = 0;
  let persistedRestarts: number | null = null;
  let announcedFirstWrite = false;

  async function loadBaseline(): Promise<void> {
    if (baselineLoaded) return;
    baselineLoaded = true;
    const text = await host.readFile(BASELINE_PATH);
    const baseline = text === null ? null : parseBaseline(text);
    if (baseline === null) return;
    previousRestarts = baseline.restarts;
    previousCpu = baseline.cpu;
  }

  /**
   * Best effort, on purpose. A full root disk must cost the fleet a stale
   * baseline, not a heartbeat — the row write is what tells hermetic this box
   * is alive, and it has already happened by the time this runs.
   */
  async function saveBaseline(): Promise<void> {
    const baseline: HeartbeatBaseline = { restarts: previousRestarts, cpu: previousCpu };
    try {
      if (!stateDirReady) {
        await host.mkdir(STATE_DIR, "0755");
        stateDirReady = true;
      }
      await host.writeFile(BASELINE_PATH, JSON.stringify(baseline) + "\n", "0644");
      persistedRestarts = previousRestarts;
    } catch {
      // Nothing to say and nobody to say it to: the next tick tries again.
    }
  }

  /**
   * Not every tick. The heartbeat runs every 30 s for the life of the box, and
   * an fsync'd write per tick is 2,880 writes a day to a root volume, for a
   * file whose only reader is the next process.
   *
   * Two rules cover what the file is for. The restart counter is written the
   * moment it changes, because *that* is the value a crash loop turns on and
   * losing one increment loses the signal; the CPU sample is refreshed
   * periodically, because losing it costs one tick reporting 0% and nothing
   * else. The first tick always writes, so a fresh box has a baseline
   * immediately rather than two minutes in.
   */
  function baselineDue(): boolean {
    return ticks === 1 || ticks % BASELINE_WRITE_EVERY === 0 || previousRestarts !== persistedRestarts;
  }
  let consecutiveFailing = 0;
  let consecutivePassing = 0;
  /**
   * The last rollout request this *process* reported. In memory on purpose: the
   * field is never cleared on the row, so the only thing that stops a request
   * being acted on every 30 s forever is remembering it — and a restart into
   * the new binary is exactly when forgetting it is harmless (the update it
   * asked for has happened, and the digest check makes a second run a no-op).
   */
  /**
   * What Hermes last told us it was, or `null` before the first answer.
   *
   * Kept across ticks rather than recomputed per write: a tick whose dashboard
   * probe failed knows nothing new, and writing that nothing would erase a
   * reading the fleet is using — the same rule the two Tailscale fields follow.
   * It is refreshed only by a health check that actually answered.
   */
  let reportedHermesVersion: string | null = null;
  let lastRequestId: string | null = null;
  let lastApplyId: string | null = null;

  async function showUnit(unit: string): Promise<UnitState> {
    const shown = await host.exec(["systemctl", "show", "-p", UNIT_SHOW_PROPERTIES, unit]);
    return parseUnitState(shown.stdout);
  }

  /**
   * `active (running)` and nothing else. `SubState` as well as `ActiveState`,
   * because `activating (auto-restart)` is reported as active by `systemctl
   * is-active` — the very moment in a crash loop this probe used to be fooled by.
   */
  function unitUp(state: UnitState): boolean {
    return state.activeState === "active" && state.subState === "running";
  }

  /** How a failing unit is named in the detail: `hermes-gateway.service inactive (dead)`. */
  function describeUnit(unit: string, state: UnitState): string {
    const active = state.activeState ?? "unknown";
    return state.subState === null ? `${unit} ${active}` : `${unit} ${active} (${state.subState})`;
  }

  /**
   * The dashboard's own answer, which is the only HTTP evidence either Hermes
   * process gives — and now the answer of a route Hermes actually serves
   * (`GET /api/health`, `hermes_cli/web_routers/status.py:113-116`).
   *
   * 2xx, and nothing else. The old rule — anything under 400 — was written for
   * `/healthz`, where it barely mattered: that path was answered by the SPA
   * catch-all (`hermes_cli/web_server_dashboard.py:93`) with a 200, so the
   * check was true whenever a listener was up. On a real route the distinction
   * is the point. A redirect is not followed and no longer passes: `/api/health`
   * either answers directly or something in front of it replied instead, and in
   * the second case systemd is the better witness. A 4xx or 5xx falls through
   * to systemd as before, which is also how a Hermes too old to route
   * `/api/health` is judged.
   */
  async function hermesHealthAnswers(): Promise<boolean> {
    try {
      const res = await doFetch(HERMES_HEALTH_URL, {
        signal: AbortSignal.timeout(3_000),
        redirect: "manual",
      });
      const ok = res.status >= 200 && res.status < 300;
      if (ok) reportedHermesVersion = await versionFromHealth(res);
      return ok;
    } catch {
      // Connection refused, or a Hermes with no `/api/health` to route.
      return false;
    }
  }

  /**
   * The Hermes version out of the health body this tick already fetched.
   *
   * Upstream answers `{"ok": true, "version": __version__, …}`
   * (`hermes_cli/web_routers/status.py`), and `__version__` is the same
   * `pyproject` semver the agent row's `hermes_version` is pinned to — so this
   * costs nothing beyond parsing a response that was being thrown away, and it
   * is the only thing on this box that can say which Hermes is *actually*
   * running. Every other writer of a Hermes version is a laptop stating an
   * intention: `agents.create` seeds the pin, and `upgrade --hermes` moves it
   * and then says so itself — "takes effect on next recreate".
   *
   * `null` for every way of not knowing, and never a guess: a body that is not
   * JSON, has no `version`, or whose `version` is not a string. An internal
   * format is not an API (`COMPAT_MANIFEST.md`), so a shape this build does not
   * recognise must read as unknown rather than degrade a healthy box.
   */
  async function versionFromHealth(res: Response): Promise<string | null> {
    try {
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null) return null;
      const version = (body as Record<string, unknown>)["version"];
      // Bounded on the way out, matching the row's own limit: a health endpoint
      // that answered with something enormous must not put it in DynamoDB.
      if (typeof version !== "string") return null;
      const trimmed = version.trim();
      return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /**
   * `gateway_state.json`, or `null` for "the gateway said nothing this tick".
   *
   * Four separate ways to get `null`, all of them ordinary: the file is not
   * there (a box whose gateway has never started), the read threw, the JSON is
   * truncated, or the snapshot is past its TTL and so describes some earlier
   * life of the gateway rather than this one. None of them is a failed check —
   * they only leave the checks that were already here judging alone.
   */
  async function readGatewayState(): Promise<GatewayState | null> {
    const text = await host.readFile(GATEWAY_STATE_PATH).catch(() => null);
    const state = text === null ? null : parseGatewayState(text);
    if (state === null || state.updatedAt === null) return null;
    const age = host.now().getTime() - state.updatedAt.getTime();
    return age > GATEWAY_STATE_STALE_MS ? null : state;
  }

  /**
   * Is Hermes up — and *staying* up?
   *
   * "Hermes" is two processes (§6.4): the dashboard hermetic renders, and the
   * gateway upstream installs, which is where the messaging channels and the
   * cron jobs run. Only the dashboard answers HTTP; the gateway opens no TCP
   * listener unless `api_server` is enabled (§7.4), but it is not silent — it
   * keeps `gateway_state.json` (`gateway/status.py:804-867`), which says what
   * it is doing and why it last stopped. Both units are sampled and folded into
   * the single `health.hermes` the row carries, and it is true only when both
   * are up — a box whose gateway died answers no messages, whatever its
   * dashboard says.
   *
   * The staying-up half is the one a single sample cannot answer. Both units
   * are `Restart=always`, so one that dies on every start is `active` for most
   * of every cycle: a probe that looks once every thirty seconds at a unit
   * cycling every seven catches it running nearly every time and reports `h+`
   * for a box that has never answered a message. What gives it away is not the
   * state but the *counter* — systemd's `NRestarts`, which only ever goes up.
   *
   * The counter compared between ticks is the **sum** across both units rather
   * than the maximum, because the sum moves whenever *either* unit restarts: a
   * gateway flapping behind a dashboard with a larger count would never move a
   * maximum, and catching either one is the entire point. A `systemctl
   * reset-failed` makes the sum fall, which reads as "no restart since the last
   * tick" — one missed sample, never a false alarm.
   *
   * On the first tick there is no baseline. That is not a reason to guess: the
   * state checks stand on their own, and the tick after has the counter.
   *
   * What the counter cannot say is *why*, and the answer decides whether the
   * restart means anything at all: exit 75 is how the gateway asks to be
   * restarted (`hermes_cli/gateway.py:2912,2922-2925`). `gateway_state.json` is read
   * alongside the two units to tell one apart from a crash — see
   * `plannedRestart` — and to name the cause when it was a crash.
   */
  async function probeHermes(): Promise<HermesProbe> {
    const [dashboard, gateway, gatewayState] = await Promise.all([
      showUnit(HERMES_DASHBOARD_UNIT),
      showUnit(HERMES_GATEWAY_UNIT),
      readGatewayState(),
    ]);
    const counters = [dashboard.restarts, gateway.restarts].filter((n): n is number => n !== null);
    const total = counters.length === 0 ? null : counters.reduce((a, b) => a + b, 0);
    const restarted = previousRestarts !== null && total !== null && total > previousRestarts;
    if (total !== null) previousRestarts = total;

    const failing: string[] = [];
    if (!(await hermesHealthAnswers()) && !unitUp(dashboard)) {
      failing.push(describeUnit(HERMES_DASHBOARD_UNIT, dashboard));
    }
    if (!unitUp(gateway)) failing.push(describeUnit(HERMES_GATEWAY_UNIT, gateway));
    // A gateway that could not finish starting is a failed check on its own,
    // ahead of the counter: it is both the most specific thing the box knows
    // and the reason the counter is about to move again.
    const failedStartup = startupFailure(gatewayState);
    if (failedStartup !== null) {
      failing.push(failedStartup);
    } else if (restarted && !plannedRestart(gatewayState)) {
      // A restart nobody asked for, which is the check HTTP cannot make.
      // Which of the two units moved is still deliberately not claimed — one
      // counter is compared against one baseline — but the gateway's own
      // account of its last stop is quoted, so the detail says what happened
      // rather than only that something did.
      failing.push(describeRestart(gatewayState));
    }
    return { ok: failing.length === 0, failing };
  }

  /**
   * The end-to-end check the other three cannot make between them: Hermes can be
   * up, the node online and the disk empty while the dashboard the operator was
   * told to open answers nothing at all — that is exactly what a tailnet with
   * HTTPS certificates disabled looks like, because `tailscale serve --https`
   * never gets a certificate and fails quietly behind a healthy-looking box.
   *
   * The chain under test is `serve` → the loopback nginx proxy → Hermes, and
   * with no auth gate anywhere in it the dashboard answers the SPA with a plain
   * 200. So a pass is any 2xx or 3xx. 401 and 403 are accepted too, harmlessly:
   * a challenge would still be Hermes deciding who we are, which means
   * everything in front of it worked.
   *
   * Every other 4xx fails, because on this chain a 4xx is a misconfiguration
   * rather than an answer: nginx rewriting the wrong Host or Origin, or Hermes
   * refusing what it was handed (`400 Invalid Host header`), or a `/` that
   * reaches something which is not the dashboard at all (404). Passing those
   * would report `dashboard: true` for exactly the shapes of failure this probe
   * exists to catch. A 5xx (the proxy admitting it could not reach its target)
   * and a thrown fetch (TLS failure, connection refused, timeout) fail as well.
   */
  function dashboardReachable(status: number): boolean {
    return status < 400 || status === 401 || status === 403;
  }

  async function probeDashboard(dnsName: string | null): Promise<boolean> {
    // No MagicDNS name means there is no URL to publish, so there is nothing
    // for the operator to open — reported as failing rather than as pending.
    if (dnsName === null) return false;
    try {
      const res = await doFetch(dashboardUrl(dnsName), {
        signal: AbortSignal.timeout(dashboardTimeoutMs),
        // A redirect is a perfectly good answer from the chain we are testing,
        // and following it could walk off the node entirely.
        redirect: "manual",
      });
      return dashboardReachable(res.status);
    } catch {
      return false;
    }
  }

  const once = async (): Promise<HeartbeatTick> => {
    // Before the probes: `probeHermes` compares against the restart counter
    // this loads, and on the first tick of a fresh process that counter is on
    // disk rather than in memory.
    await loadBaseline();
    ticks += 1;
    const row = await aws.getOwnRow(name);

    // Reported before the probes: a box whose Hermes is down still has to take
    // a rollout, and the id is marked handled either way — a request the update
    // loop could not act on yet is held there, not re-reported here.
    const request = row?.update_request;
    if (request && request.id !== lastRequestId) {
      lastRequestId = request.id;
      deps.onUpdateRequest?.(request);
    }

    // The same rule for §6.5's converge: report an id once, let the loop that
    // acts on it decide whether it can act now, and never clear the field —
    // "done" is `applied_config_hash`, written a few lines below.
    const applyRequest = row?.apply_request;
    if (applyRequest && applyRequest.id !== lastApplyId) {
      lastApplyId = applyRequest.id;
      deps.onApplyRequest?.(applyRequest);
    }

    const diskPct = await diskPercent(host, DATA_MOUNT);
    // `null`, not `0`, when neither statvfs nor `df` would answer: an unmeasured
    // root disk is omitted from the row rather than reported as empty.
    const rootDiskPct = await diskPercentOrNull(host, ROOT_MOUNT);
    const rootFreeMib = await freeMibOrNull(host, ROOT_MOUNT);
    // One `tailscale status` per tick: it answers both "are we online" and
    // "what name are we published under", and the dashboard probe needs the
    // second before it can run at all.
    const self = await tailscaleSelf(host);
    const [hermes, dashboard] = await Promise.all([probeHermes(), probeDashboard(self.dnsName)]);
    const health: Health = {
      hermes: hermes.ok,
      tailscale: self.online,
      // Either filesystem filling up is a disk failure. A full root disk stops
      // the box taking updates and eventually stops journald and Hermes itself,
      // so it degrades the agent exactly as a full `/data` does — but only when
      // it was actually measured; an unmeasured root disk decides nothing.
      disk: diskPct < DISK_FULL_PCT && (rootDiskPct === null || rootDiskPct < DISK_FULL_PCT),
      dashboard,
    };

    const cpuSample = await readCpuSample(host);
    const cpu_pct = cpuPercent(previousCpu, cpuSample);
    if (cpuSample) previousCpu = cpuSample;
    // Both counters as this tick leaves them, for whoever runs the next one.
    if (baselineDue()) await saveBaseline();
    const metrics: Metrics = {
      cpu_pct,
      mem_pct: await memoryPercent(host),
      disk_pct: diskPct,
      ...(rootDiskPct === null ? {} : { root_disk_pct: rootDiskPct }),
      ...(rootFreeMib === null ? {} : { root_free_mib: rootFreeMib }),
    };

    const tailscale_ip = self.online ? await tailscaleIpv4(host) : null;
    // One small local read per tick, and the only report of what this box has
    // actually applied (§6.6 skew). `null` when the manifest is unreadable,
    // which the writer treats as "say nothing" rather than "applied nothing".
    const applied_config_hash = await readAppliedConfigHash(host).catch(() => null);
    const written = await aws.heartbeat({
      name,
      health,
      metrics,
      hermeticd_version: deps.hermeticdVersion,
      // The label above says which release this box *calls* itself; this says
      // which bytes it is actually running. Only the second one can answer
      // "did the rollout land", because the label is a hand-edited constant
      // that two different releases routinely share (§6.6).
      ...(deps.hermeticdSha256 ? { running_hermeticd_sha256: deps.hermeticdSha256 } : {}),
      // Silence leaves the row's last reading standing, like the two Tailscale
      // fields: a tick whose dashboard probe failed has learned nothing, and
      // "I could not ask" is not the same as "it is running nothing".
      ...(reportedHermesVersion ? { running_hermes_version: reportedHermesVersion } : {}),
      ...(tailscale_ip ? { tailscale_ip } : {}),
      // The name the node actually answers to — `<name>-2.<tailnet>` when a
      // stale device from a previous incarnation still holds `<name>`. Omitted,
      // not nulled, when `tailscale status` told us nothing this tick: the row's
      // last known name is better than no name at all.
      ...(self.dnsName ? { tailscale_dns_name: self.dnsName } : {}),
      // The daemon's own version, which nothing on the laptop pins and nothing
      // on the laptop can predict: `01-tailscale.sh` turns Tailscale's updater
      // on, so this moves on the box's own schedule and the row is the only
      // record of where it got to. Same silence rule as the two fields above.
      ...(self.version ? { tailscale_version: self.version } : {}),
      ...(applied_config_hash ? { applied_config_hash } : {}),
    });

    if (!written) {
      // The row is gone; a transition would only recreate it as a fragment.
      return { health, metrics, row, transitioned: null, written };
    }

    if (!announcedFirstWrite) {
      announcedFirstWrite = true;
      deps.onFirstWrite?.();
    }

    const failing = !health.hermes || !health.tailscale || !health.disk || !health.dashboard;
    consecutiveFailing = failing ? consecutiveFailing + 1 : 0;
    consecutivePassing = failing ? 0 : consecutivePassing + 1;

    const status = row?.status ?? null;
    let transitioned: "degraded" | "ready" | null = null;
    // Only the two edges the state machine gives hermeticd are ever attempted,
    // and only from the status the row actually holds — a `stopping` or
    // `destroying` agent is left entirely alone (§4.3).
    if (
      failing &&
      consecutiveFailing >= DEGRADE_AFTER_TICKS &&
      (status === null || status === "ready")
    ) {
      const failed = [
        // Which of the two Hermes units is down, not merely that "hermes" is.
        health.hermes ? null : `hermes (${hermes.failing.join("; ")})`,
        health.tailscale ? null : "tailscale",
        health.disk ? null : "disk",
        health.dashboard ? null : "dashboard",
      ].filter((x): x is string => x !== null);
      if (
        await aws.transition({
          name,
          from: ["ready"],
          to: "degraded",
          action: "degrade",
          detail: `failing for ${consecutiveFailing} ticks: ${failed.join(", ")}`,
        })
      ) {
        transitioned = "degraded";
      }
    } else if (
      !failing &&
      consecutivePassing >= RECOVER_AFTER_TICKS &&
      (status === null || status === "degraded") &&
      (await aws.transition({
        name,
        from: ["degraded"],
        to: "ready",
        action: "recover",
        detail: `all checks passing for ${consecutivePassing} ticks`,
      }))
    ) {
      transitioned = "ready";
    }

    return { health, metrics, row, transitioned, written };
  };

  return {
    once,
    async run(signal) {
      while (!signal.aborted) {
        try {
          await once();
        } catch (e) {
          // A heartbeat that throws must not kill the service; the operator sees
          // the gap as `unreachable` and the next tick retries. The attempt is
          // still worth a line in the event log.
          await aws
            .appendEvent({
              name,
              action: "heartbeat-error",
              detail: e instanceof Error ? e.message : String(e),
            })
            .catch(() => undefined);
        }
        await host.sleep(HEARTBEAT_INTERVAL_MS);
      }
    },
  };
}

/** What `systemctl show -p ActiveState,SubState,NRestarts` said about a unit. */
export interface UnitState {
  readonly activeState: string | null;
  readonly subState: string | null;
  /** systemd's monotonic restart counter; null when it did not report one. */
  readonly restarts: number | null;
}

/**
 * Parse `Key=Value` lines. Anything absent or unparseable is `null` rather than
 * a default: "systemd did not say" and "systemd said zero" are different
 * answers, and only the second one licenses a comparison.
 */
export function parseUnitState(stdout: string): UnitState {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const counter = values.get("NRestarts") ?? "";
  const restarts = Number(counter);
  return {
    activeState: values.get("ActiveState") ?? null,
    subState: values.get("SubState") ?? null,
    // `Number("")` is 0, which would be a comparison against a number systemd
    // never gave us.
    restarts: counter !== "" && Number.isFinite(restarts) ? restarts : null,
  };
}

/**
 * The four fields of `gateway_state.json` this probe reads.
 *
 * Every one of them is optional, because the file belongs to upstream: a key
 * that is missing, or holds a type this build does not expect, reads as absent
 * rather than failing the parse, so one rename cannot blind the whole probe
 * (`COMPAT_MANIFEST.md:3-4`).
 */
export interface GatewayState {
  /**
   * `starting`, `running`, `draining`, `stopped`, `degraded`, `startup_failed`
   * — or whatever a later Hermes writes, which is carried through verbatim
   * rather than mapped onto this list (`gateway/run_startup.py:785`, `:867`,
   * `:1213`; `gateway/run_shutdown.py:1888-1897`).
   */
  readonly state: string | null;
  /**
   * Free prose, e.g. `"Gateway restart requested"`
   * (`gateway/run_shutdown.py:1886`) or an adapter's fatal error
   * (`gateway/run_adapters.py:340`). Never parsed, only quoted.
   */
  readonly exitReason: string | null;
  /**
   * True when the gateway asked to be *replaced* rather than merely stopping —
   * the flag behind its exit 75 (`gateway/run_shutdown.py:1883-1886`), and the
   * same field upstream's CLI checks before waiting on a systemd relaunch
   * (`hermes_cli/gateway.py:1311`).
   */
  readonly restartRequested: boolean;
  /** `updated_at`, re-stamped on every write (`gateway/status.py:831`). */
  readonly updatedAt: Date | null;
}

export function parseGatewayState(text: string): GatewayState | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;
  const state = record["gateway_state"];
  const reason = record["exit_reason"];
  const stamp = record["updated_at"];
  // `datetime.now(timezone.utc).isoformat()` (`gateway/status.py:178-179`) —
  // microsecond precision and an explicit offset, both of which `Date` accepts.
  const updatedAt = typeof stamp === "string" ? new Date(stamp) : null;
  return {
    state: typeof state === "string" ? state : null,
    exitReason: typeof reason === "string" && reason !== "" ? reason : null,
    restartRequested: record["restart_requested"] === true,
    updatedAt: updatedAt !== null && Number.isFinite(updatedAt.getTime()) ? updatedAt : null,
  };
}

/**
 * Upstream's prose, bounded and on one line. `exit_reason` can carry an
 * adapter's whole error message, and this ends up in a DynamoDB event detail
 * the operator reads in a table cell.
 */
export function shortReason(reason: string, limit = 120): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * The one thing the gateway says about itself that is a failure on its own:
 * it tried to start and could not (`gateway/run_startup.py:867`, `:1138`).
 * systemd may well report the unit `active` at this point — the process is up,
 * it is the gateway inside it that gave up — which is exactly the gap between
 * "a PID exists" and "an agent can answer a message".
 */
function startupFailure(state: GatewayState | null): string | null {
  if (state === null || state.state !== "startup_failed") return null;
  const reason = state.exitReason === null ? "" : `: ${shortReason(state.exitReason)}`;
  return `${HERMES_GATEWAY_UNIT} startup failed${reason}`;
}

/**
 * A restart the gateway *asked for*, which is not a symptom of anything.
 *
 * Exit 75 is how upstream requests its own replacement, and the unit is built
 * for it: `Restart=always`, `RestartForceExitStatus=75`, `SuccessExitStatus=75`,
 * `StartLimitIntervalSec=0` (`hermes_cli/gateway.py:2912,2922-2925`). It is the
 * normal end of the `/restart` slash command, of `hermes update`, and of a
 * stale-code respawn (`gateway/code_skew.py`) — upstream's own restart-loop
 * guard treats even a chain of them as a known, self-healing pattern
 * (`gateway/restart_loop_guard.py:26-32`).
 *
 * So a planned restart is not counted at all, rather than being absorbed by
 * `DEGRADE_AFTER_TICKS`: three chained `/restart`s used to degrade an agent
 * that did exactly what it was told. A restart with no fresh snapshot to
 * explain it, or one alongside `startup_failed`, counts as it always has.
 *
 * The flag alone is not enough to excuse one, because upstream never clears it
 * promptly. `write_runtime_status` is a read-merge-write over the whole record
 * and only assigns the fields it was passed (`gateway/status.py:792-796`,
 * `:815`), the shutdown that set it writes `gateway_state="stopped"` with
 * `restart_requested=True` (`gateway/run_shutdown.py:1897` through
 * `gateway/run.py:3858-3865`), and the replacement process then writes
 * `gateway_state="starting"` *without* passing `restart_requested` at all
 * (`gateway/run_startup.py:785`) — so the stale `true` survives. It is cleared
 * only when startup succeeds and the new process writes `running` with its own
 * `_restart_requested`, which is `False` (`gateway/run_startup.py:1399`,
 * `gateway/run.py:3272`).
 *
 * That leaves a window — from the planned stop until startup finishes — in
 * which the flag says "planned" about *any* restart. It is not a narrow one: a
 * gateway that takes a while to connect its adapters sits in `starting` for as
 * long as that takes, and a crash-loop in there reads as planned every tick
 * while `previousRestarts` has already consumed the delta, so the degrade is
 * not merely deferred but permanently missed. So the state has to agree: the
 * excuse holds only while the gateway is `stopped` or `draining` — the states
 * a restart it asked for actually leaves behind — and a restart observed while
 * it is `starting`, `running` or `startup_failed` is counted.
 */
const PLANNED_RESTART_STATES = new Set(["stopped", "draining"]);

function plannedRestart(state: GatewayState | null): boolean {
  if (state?.restartRequested !== true || state.state === null) return false;
  return PLANNED_RESTART_STATES.has(state.state);
}

/** `a hermes unit restarted since the last tick (gateway stopped: OOM)`. */
function describeRestart(state: GatewayState | null): string {
  const cause =
    state === null
      ? "gateway state unknown"
      : `gateway ${state.state ?? "unknown"}` +
        (state.exitReason === null ? "" : `: ${shortReason(state.exitReason)}`);
  return `a hermes unit restarted since the last tick (${cause})`;
}

export interface CpuSample {
  readonly total: number;
  readonly idle: number;
}

/** First line of `/proc/stat`: `cpu user nice system idle iowait irq softirq steal …`. */
export function parseProcStat(text: string): CpuSample | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) return null;
  const total = fields.reduce((a, b) => a + b, 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { total, idle };
}

async function readCpuSample(host: Host): Promise<CpuSample | null> {
  const text = await host.readFile("/proc/stat");
  return text === null ? null : parseProcStat(text);
}

/** Busy fraction between two samples; 0 on the very first tick, which has no delta. */
export function cpuPercent(previous: CpuSample | null, current: CpuSample | null): number {
  if (!previous || !current) return 0;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return 0;
  return clampPct(((total - idle) / total) * 100);
}

export function parseMeminfo(text: string): number {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match?.[1] && match[2]) values.set(match[1], Number(match[2]));
  }
  const total = values.get("MemTotal") ?? 0;
  const available = values.get("MemAvailable") ?? values.get("MemFree") ?? 0;
  if (total <= 0) return 0;
  return clampPct(((total - available) / total) * 100);
}

async function memoryPercent(host: Host): Promise<number> {
  const text = await host.readFile("/proc/meminfo");
  return text === null ? 0 : parseMeminfo(text);
}

/**
 * statvfs on a mount point; `df` is the fallback where statfs is unavailable.
 * `null` when neither would answer — "we did not measure this", which is not
 * the same claim as "this filesystem is empty".
 */
export async function diskPercentOrNull(host: Host, path: string): Promise<number | null> {
  const fs = await host.statfs(path);
  if (fs && fs.blocks > 0) {
    return clampPct(((fs.blocks - fs.available) / fs.blocks) * 100);
  }
  const df = await host.exec(["df", "-kP", path]);
  if (df.code !== 0) return null;
  const line = df.stdout.trim().split("\n")[1];
  const pct = line ? /(\d+)%/.exec(line)?.[1] : undefined;
  return pct ? clampPct(Number(pct)) : null;
}

/**
 * The same reading for `/data`, where an unknowable answer stays `0`: `disk_pct`
 * is required on the row, and the disk *check* it feeds has always read an
 * unmeasurable data volume as "not full" rather than refusing to decide.
 */
export async function diskPercent(host: Host, path: string): Promise<number> {
  return (await diskPercentOrNull(host, path)) ?? 0;
}

/**
 * Free space on the filesystem holding `path`, in MiB; `null` when unmeasurable.
 *
 * Reported alongside the percentage rather than instead of it because the two
 * answer different questions, and only this one answers the question the root
 * disk actually raises: a self-update needs *bytes* for the new binary and its
 * backup, and 90% of 8 GiB and 90% of 500 GiB are the same percentage with
 * opposite verdicts. It cannot be derived on the reading end either — the
 * volume is not the filesystem (`Metrics.root_free_mib`).
 *
 * `df -kP` reports 1K blocks, so its "available" column is already KiB; statfs
 * gives blocks and a block size. Both land in MiB.
 */
export async function freeMibOrNull(host: Host, path: string): Promise<number | null> {
  const fs = await host.statfs(path);
  if (fs && fs.blockSize > 0) {
    return Math.floor((fs.available * fs.blockSize) / (1024 * 1024));
  }
  const df = await host.exec(["df", "-kP", path]);
  if (df.code !== 0) return null;
  const line = df.stdout.trim().split("\n")[1];
  // `Filesystem 1024-blocks Used Available Capacity Mounted`: the fourth column.
  const available = line?.trim().split(/\s+/)[3];
  if (available === undefined || !/^\d+$/.test(available)) return null;
  return Math.floor(Number(available) / 1024);
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}
