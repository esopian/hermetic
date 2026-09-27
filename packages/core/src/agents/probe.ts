/**
 * `agents.probe` (§9): the active liveness check.
 *
 * Everything else hermetic knows about whether an agent is alive is passive.
 * hermeticd writes `last_heartbeat` every thirty seconds, and `deriveDisplayStatus`
 * (`state.ts`) calls a row `unreachable` once that is older than three intervals
 * (§4.3). That is cheap, it needs no cooperation at the moment you read it, and
 * it is exactly one bit wide — which is the problem. `unreachable` is the same
 * word for:
 *
 *   - the EC2 instance is stopped, or terminated out from under the row
 *   - the instance is running and hermeticd is dead
 *   - hermeticd is alive and its DynamoDB writes are failing (role, network)
 *   - everything on the box is fine and *this laptop* is off the tailnet
 *
 * Four worlds, four different next commands, and no passive signal can separate
 * them, because they all look like silence. So the probe asks: EC2 about the
 * box, the box about hermeticd, and the tailnet about the dashboard, all three
 * in parallel with their own timeouts, and reads the answers against the row.
 *
 * Three properties this module is built around:
 *
 * 1. **It writes nothing.** No row update, no event, no lock, no `guardFleet` —
 *    `guardAccount` only, the same as `agents.get`. A diagnostic that mutates
 *    is a diagnostic nobody runs on a fleet that is already unhappy.
 * 2. **A failed layer is data, not an error.** "hermeticd did not answer" is
 *    the answer, so it comes back as `outcome: "fail"` with the reason as its
 *    detail. Only a missing agent or a failed guard throws. This is why every
 *    layer is wrapped and awaited with `allSettled`: one dead layer must not
 *    take the other three with it.
 * 3. **The reading is pure.** `verdictFor` is a total function of the four
 *    answers, exported and table-tested, so the interesting logic — which
 *    combination means what, and what to type next — is testable without a
 *    backend, a clock or a network.
 *
 * Its own module with an explicit deps object (AGENTS.md rule 5), the same
 * shape as `volumes.ts`/`lifecycle.ts`; `hermetic.ts` only wires it.
 */
import type { Agent, ProbeReport, ProbeRow } from "../schema/index.ts";
import {
  agentDashboardUrl,
  agentDesktopUrl,
  agentHostnameMismatch,
  cloudName,
  legacyCloudNames,
  staleDeviceNote,
} from "../schema/index.ts";
import type {
  ProbeBrowser,
  ProbeBrowserIdentity,
  ProbeDashboard,
  ProbeDesktop,
  ProbeHermeticd,
  ProbeInstance,
  ProbeVerdict,
} from "../schema/index.ts";
import { validateName } from "../shared/naming.ts";
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import type { FetchLike } from "../aws/tailscale.ts";

/** How long any one layer is given before it is called a miss. */
export const AGENT_PROBE_TIMEOUT_MS = 5_000;

/**
 * What the probe needs beyond the shared context — of which it reads only the
 * account guard (a probe is a read, so `guardAccount` and not `guardFleet`),
 * the row reader and the view.
 */
export interface ProbeDeps {
  ctx: CoreContext;
  /**
   * The laptop's own `fetch`, injectable so fixture mode can answer without a
   * socket — the same reason `HermeticDeps.localTailscale` is injectable.
   */
  fetch?: FetchLike;
  timeoutMs?: number | undefined;
  /**
   * The fleet's MagicDNS suffix, or null when this home does not know it.
   * Async because the tailnet lives on the `_fleet` item, not in the frozen
   * local config — and a probe must survive `_fleet` being unreadable, so
   * "unknown" is an answer this returns rather than an error it throws.
   *
   * The suffix rather than a finished URL: the probe builds the dashboard URL
   * from the *row* (`agentHostname`), because after a recreate the node's real
   * name and its canonical spelling differ, and a probe that fetched the
   * canonical one would report the stale device's silence as this agent's.
   *
   * `fleet_id` comes back with it because the canonical spelling is
   * `<fleet id>-<agent>.<tailnet>` since foundation v4 (`cloudName`), and both
   * halves live on the same `_fleet` item — one read, not two.
   *
   * `fleet_name` comes back too, and is not used to build any name. It is what
   * `legacyCloudNames` needs to recognise a node built under v3, when the name
   * *was* the prefix — without it every such node reads as a stale device.
   * `null` is a pre-v3 fleet, whose nodes wear bare agent names.
   */
  tailnet: () => Promise<{
    tailnet: string | null;
    fleet_id: string | null;
    fleet_name: string | null;
  }>;
}

/** What `deps.tailnet()` answers, shared by every layer that builds a URL. */
type SeenFleet = { tailnet: string | null; fleet_id: string | null; fleet_name: string | null };

/** The row statuses for which a heartbeat is expected and silence means something. */
const LIVE_STATUSES: readonly Agent["status"][] = ["bootstrapping", "ready", "degraded"];

/** EC2 states that mean the box will not be coming back on its own. */
const GONE_STATES: readonly string[] = ["terminated", "shutting-down"];
const OFF_STATES: readonly string[] = ["stopped", "stopping"];

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Raised inside `layer` when the deadline passes; never leaves this module. */
const LAYER_ABORTED = Symbol("hermetic.probe.layer-aborted");

/**
 * One layer, timed and caught.
 *
 * The timeout has to be enforced *here*, by racing, and not merely handed down
 * as a signal. Two of the three layers call through `ComputeApi`, whose methods
 * take no `AbortSignal` at all — an AWS SDK call that never settles would
 * otherwise hang the probe forever while a perfectly good `AbortSignal.timeout`
 * fired into a listener nobody was waiting on. A deadline that only works when
 * the callee cooperates is not a deadline; it is a comment. So the signal is
 * still passed down (the layers that *can* honour it should stop early and stop
 * doing work), but the bound is the race.
 *
 * A throw becomes the layer's `detail` rather than the probe's rejection —
 * except when the *caller* aborted, which is not a diagnosis and must not be
 * reported as one: that rethrows so `probe()` can reject.
 */
async function layer<T extends { outcome: string; detail: string; latency_ms: number | null }>(
  now: () => number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Omit<T, "latency_ms">>,
  onFail: (detail: string) => Omit<T, "latency_ms">,
): Promise<T> {
  const started = now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const elapsed = (): number => Math.max(0, Math.round(now() - started));

  let stopListening = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const fire = (): void => reject(LAYER_ABORTED);
    if (combined.aborted) {
      fire();
      return;
    }
    combined.addEventListener("abort", fire, { once: true });
    stopListening = () => combined.removeEventListener("abort", fire);
  });

  try {
    const value: Omit<T, "latency_ms"> = await Promise.race([run(combined), aborted]);
    return { ...value, latency_ms: elapsed() } as T;
  } catch (e) {
    // The operator's Ctrl-C is not a finding about the agent. Reporting it as
    // "hermeticd did not answer" would be a confident wrong verdict about a
    // question that was never actually asked.
    if (signal?.aborted && !timeout.aborted) throw e === LAYER_ABORTED ? signal.reason : e;
    const detail =
      timeout.aborted || e === LAYER_ABORTED
        ? `timed out after ${timeoutMs}ms`
        : messageOf(e) || "failed for an unstated reason";
    return { ...onFail(detail), latency_ms: elapsed() } as T;
  } finally {
    stopListening();
  }
}
/**
 * The whole reading, as a pure function. Rules are ordered and the first match
 * wins, most-actionable first. Three things decide the order:
 *
 * - **What we could not see outranks what we saw.** If EC2 did not answer, no
 *   statement about the instance is safe, so that is rule 1 and it stops there.
 * - **Reality-vs-row drift outranks everything about the box's software.** A
 *   `stopped` row over a running, billing instance is the news; whether that
 *   box's dashboard serves TLS is not.
 * - **Never recommend a destructive command on a guess.** `recreate`/`destroy`
 *   appear only when EC2 positively said the instance does not exist, or said
 *   it is terminating — never because a call timed out.
 *
 * `hints` are the point. A verdict that only names the problem leaves the
 * operator to guess the command, and the guess ("just recreate it") is often
 * the expensive one.
 */
export function verdictFor(input: {
  name?: string;
  row: ProbeRow;
  instance: ProbeInstance;
  hermeticd: ProbeHermeticd;
  dashboard: ProbeDashboard;
  /**
   * The node's real MagicDNS name and the canonical one it did not get, when
   * the two differ; `null` when they agree or when the tailnet was unreadable
   * and the comparison could not honestly be made.
   *
   * A *fact*, passed in, rather than something this function goes and asks:
   * `verdictFor` stays a pure function of what was seen. It never changes which
   * rule fires — every layer above already probed the real name, so the agent
   * is as healthy as it looks — it only adds the cleanup nobody else will
   * mention, and lifts an otherwise-clean `ok` to `warn` so it is not silently
   * appended to a green report.
   */
  hostname_mismatch?: { real: string; canonical: string; kind: "legacy" | "stale" } | null;
}): ProbeVerdict {
  const { row, instance, hermeticd, dashboard } = input;
  const n = input.name ?? "<name>";
  const live = LIVE_STATUSES.includes(row.status);
  const stale = row.display_status === "unreachable";
  const running = instance.state === "running";
  const gone = instance.not_found || GONE_STATES.includes(instance.state ?? "");

  const verdict = ((): ProbeVerdict => {
    /**
     * 1. EC2 was asked and did not answer — a timeout, a throttle, a refused
     * credential. Every rule below reads the instance layer, and reading a
     * layer that failed to load is how "DescribeInstances took five seconds"
     * becomes "your instance is gone, here is `recreate`". So it stops here,
     * and it stops at `warn`: nothing is known to be wrong with the agent.
     */
    if (instance.outcome === "fail" && !instance.not_found) {
      return {
        level: "warn",
        summary: `EC2 did not answer about the instance: ${instance.detail}`,
        hints: [
          `run \`hermetic agent probe ${n}\` again — this says nothing about the agent yet`,
          "hermetic doctor",
        ],
      };
    }

    /**
     * 2. A create that never got a box. `creating` is not a live status, so the
     * rule below it does not cover this, and the answer is different: there is
     * nothing to recreate *into*, so the way out is to clear the row.
     */
    if (row.status === "creating" && gone) {
      return {
        level: "bad",
        summary: "create died before the instance came up",
        hints: [`hermetic agent destroy ${n}`, "hermetic doctor"],
      };
    }

    // 3. The row believes in an instance EC2 positively does not have, or is
    // disposing of. Nothing else can be true while this is, so nothing else is
    // asked.
    if (live && gone) {
      return {
        level: "bad",
        summary: `the instance is gone but the row still says ${row.status}`,
        hints: [`hermetic agent recreate ${n}`, `hermetic agent destroy ${n}`, "hermetic doctor"],
      };
    }

    /**
     * 4. Drift on a row that is not expected to be heartbeating: the row says
     * one thing and EC2 says another. This has to outrank every software-level
     * rule below it — a `stopped` row over a running instance is a box being
     * paid for that nothing is watching, and answering "enable HTTPS
     * certificates" to that would be answering the smaller question.
     */
    if (!live && DRIFTABLE.includes(row.status) && !instanceAgreesWith(row.status, instance)) {
      return {
        level: "bad",
        summary: `the row says ${row.status} but EC2 says the instance is ${instance.state ?? "in an unknown state"}`,
        hints: driftHints(n, row.status, instance),
      };
    }

    // 5. Someone used the EC2 console. The row is not wrong so much as unaware.
    if (live && OFF_STATES.includes(instance.state ?? "")) {
      return {
        level: "bad",
        summary: `the instance was stopped outside hermetic (EC2 says ${instance.state})`,
        hints: [`hermetic agent start ${n}`],
      };
    }

    // 6. Booting. Not a fault yet, and the console is the only view of it.
    if (instance.state === "pending") {
      return {
        level: "warn",
        summary: "the instance is still booting",
        hints: [`hermetic logs ${n} --console`],
      };
    }

    // 7. EC2 itself says the box is unwell; nothing hermetic did can fix that.
    if (running && (instance.system_status === "impaired" || instance.instance_status === "impaired")) {
      return {
        level: "bad",
        summary: "EC2 status checks are failing on a running instance",
        hints: [`hermetic agent reboot ${n}`, `hermetic logs ${n} --console`],
      };
    }

    /**
     * 8. The bootstrap failed. `error` is a status the operator put effort into
     * reaching a resumable state (§4.3), so it is read before any of the
     * liveness rules: "a stage failed" is the headline, and "the dashboard does
     * not serve" is a symptom of it, not a separate finding.
     */
    if (row.status === "error") {
      return {
        level: "warn",
        summary: errorSummary(row),
        hints: [
          `hermetic agent rerun ${n}`,
          `hermetic agent history ${n}`,
          `hermetic logs ${n} --unit hermeticd`,
        ],
      };
    }

    /**
     * 9. A create that is either still running or died after `RunInstances`.
     * The two look identical from outside, and the local run log is what tells
     * them apart — so the hint is to go read it rather than to act.
     */
    if (row.status === "creating") {
      return {
        level: "warn",
        summary:
          instance.outcome === "skip"
            ? "create is in progress; no instance has been launched yet"
            : "create is still in progress, or died after the instance launched",
        hints: ["hermetic runs", `hermetic agent history ${n}`],
      };
    }

    // 10. The interesting one, and the reason this method exists: hermeticd
    // answers, so the process is alive — the heartbeat path to DynamoDB is what
    // is broken, which is a permissions or network question, not a boot one.
    if (running && hermeticd.outcome === "ok" && stale) {
      return {
        level: "bad",
        summary: "hermeticd is alive but its heartbeat is not reaching DynamoDB",
        hints: [
          `hermetic logs ${n} --unit hermeticd`,
          "check the instance role can write the agents table (hermetic doctor)",
        ],
      };
    }

    // 11. No tailnet address yet on a box that is still bootstrapping: stage
    // `01-tailscale` has not finished, so there is nothing to have reached.
    if (running && hermeticd.outcome === "skip" && row.status === "bootstrapping") {
      return {
        level: "warn",
        summary: "still bootstrapping; tailscale has not come up yet",
        hints: [`hermetic logs ${n} --console`],
      };
    }

    // 12. Silent both ways. The box is on and nothing on it is talking.
    if (running && hermeticd.outcome === "fail" && stale) {
      return {
        level: "bad",
        summary: "the instance is up but hermeticd is not answering and has stopped heartbeating",
        hints: [`hermetic logs ${n} --console`, `hermetic ssh ${n}`, `hermetic agent reboot ${n}`],
      };
    }

    /**
     * 13. Heartbeats are landing, so the box is fine and the *laptop* is not:
     * the tailnet path from here is what failed, and recreating would be a
     * rebuild of a healthy agent to fix a local network problem.
     *
     * Gated on `live` as well as `!stale`, which the rule as stated is not:
     * `stale` is only ever true for a status that expects a heartbeat, so on a
     * `stopped` row `!stale` is vacuous and this would claim the agent "is
     * heartbeating" about a row that is not supposed to be.
     */
    if (live && running && hermeticd.outcome === "fail" && !stale) {
      return {
        level: "warn",
        summary: "hermeticd is heartbeating but this laptop cannot reach it over the tailnet",
        hints: [
          "run `tailscale status` — this machine may be logged out or offline",
          "check the tailnet ACL still grants your user access to tag:hermetic",
        ],
      };
    }

    // 14. hermeticd answers on 7434 but nothing serves 443: `tailscale serve`
    // or, far more often, HTTPS certificates not enabled on the tailnet.
    if (hermeticd.outcome === "ok" && dashboard.outcome === "fail") {
      return {
        level: "warn",
        summary: "hermeticd answers but the dashboard is not reachable over HTTPS",
        hints: [
          "enable HTTPS Certificates in the Tailscale admin console (DNS → HTTPS Certificates)",
          `hermetic logs ${n} --unit tailscaled`,
        ],
      };
    }

    /**
     * 15. Every layer answers and the box's own self-report is unhappy.
     *
     * Gated on `live`, which the rule as stated is not: `health` is the last
     * heartbeat's snapshot, and a `stopped` agent's last heartbeat naturally
     * says hermes and tailscale are down. Reporting that as a warning would
     * make every stopped agent permanently amber for having stopped.
     */
    const failing = live ? failedChecks(row.health) : [];
    if (failing.length > 0) {
      /**
       * `dashboard` alone, on a box whose Hermes is otherwise up, is almost
       * never Hermes: it binds loopback and stays up, and the loopback nginx in
       * front of it (`render.ts`'s `nginxConf`) is what Serve actually talks
       * to. So what has broken is the tailnet path — HTTPS certificates turned
       * off, `tailscale serve` not up, MagicDNS pointing somewhere else — and
       * the hints name that path rather than the agent.
       *
       * There is nothing to push any more: the dashboard needs no login, so
       * "the fleet password is unset" has stopped being one of this check's two
       * causes and the verdict no longer reads a slot to tell them apart.
       */
      const dashboardOnly =
        failing.length === 1 && failing[0] === "dashboard" && row.health?.hermes === true;
      if (dashboardOnly) {
        return {
          level: "warn",
          summary:
            "the box reports the dashboard down while hermes is up, so this is the tailnet path rather than Hermes",
          hints: [
            "enable HTTPS Certificates in the Tailscale admin console (DNS → HTTPS Certificates)",
            `hermetic logs ${n} --unit tailscaled`,
            `hermetic logs ${n} --unit hermes`,
          ],
          // A stale device holding the canonical name is the other thing that
          // makes a healthy box look unreachable, and it is appended to every
          // verdict below rather than repeated here.
        };
      }
      return {
        level: "warn",
        summary: `the box reports failing checks: ${failing.join(", ")}`,
        hints: [`hermetic agent status ${n}`, `hermetic logs ${n}`],
      };
    }

    // 16. A row that is deliberately not live, with an instance that agrees.
    // "stopped, and the instance is stopped" is a *good* answer — the operator
    // asked whether reality matches the row, and it does.
    if (!live && instanceAgreesWith(row.status, instance)) {
      return {
        level: "ok",
        summary: consistentSummary(row.status, instance),
        hints: [],
      };
    }

    // 17. `live` as well: a row that is *not* expected to be heartbeating and
    // whose instance disagreed with it has already fallen past rule 16, and
    // "all layers answer" would bless exactly that drift.
    if (
      live &&
      instance.outcome === "ok" &&
      hermeticd.outcome === "ok" &&
      dashboard.outcome !== "fail" &&
      !stale
    ) {
      // A `skip` is not an answer, and claiming otherwise would let "we never
      // asked about the dashboard" read as "the dashboard is fine".
      const skipped = [instance, hermeticd, dashboard].some((l) => l.outcome === "skip");
      return {
        level: "ok",
        summary: skipped ? "every layer that could be asked answers" : "all layers answer",
        hints: [],
      };
    }

    // 18. Something the rules above do not name. Say what was seen rather than
    // inventing a diagnosis: an honest "I do not know, here is everything" is
    // more use than a confident wrong verdict.
    return {
      level: "unknown",
      summary: [
        `instance: ${instance.detail}`,
        `hermeticd: ${hermeticd.detail}`,
        `dashboard: ${dashboard.detail}`,
      ].join("; "),
      hints: [`hermetic agent status ${n}`, "hermetic doctor"],
    };
  })();

  /**
   * Two notes that belong on *every* verdict rather than being rules of their
   * own, because neither one competes with the eighteen above: they are true
   * alongside whatever else was found, and a rule would have had to outrank all
   * of them to be seen at all.
   */
  const notes: string[] = [];
  // A held lock explains a great deal of apparent weirdness — a box
  // mid-recreate is *supposed* to be silent.
  if (row.lock) {
    notes.push(`an operation (${row.lock.owner}) holds the lock until ${row.lock.expires}`);
  }
  // The name the node ended up with: everything above probed the name it
  // actually holds, so the reading stands — but `<canonical>.<tailnet>` in a
  // browser, in a bookmark, or in anything hermetic did not build does not
  // reach it. Said for both kinds, because both surprise whoever typed the
  // canonical name; only one of them is a fault.
  if (input.hostname_mismatch) {
    notes.push(staleDeviceNote(n, input.hostname_mismatch));
  }
  /**
   * Only a *stale* device warns. A `legacy` node is every box built before the
   * naming rule last moved, which on the day of a foundation update is every
   * box in the fleet — warning on each would turn `probe` amber fleet-wide for
   * a state that is expected, correct, and cleared by ordinary recreates. The
   * note is still printed; it is information, not a fault.
   */
  const faulty = input.hostname_mismatch?.kind === "stale";
  if (notes.length === 0) return verdict;
  return {
    ...verdict,
    // Never a downgrade: a mismatch cannot make a `bad` verdict merely `warn`.
    level: faulty && verdict.level === "ok" ? "warn" : verdict.level,
    hints: [...verdict.hints, ...notes],
  };
}

/** The heartbeat's own checks that came back false; `dashboard` is optional. */
function failedChecks(health: ProbeRow["health"]): string[] {
  if (!health) return [];
  const out: string[] = [];
  if (!health.hermes) out.push("hermes");
  if (!health.tailscale) out.push("tailscale");
  if (!health.disk) out.push("disk");
  if (health.dashboard === false) out.push("dashboard");
  return out;
}

/** What an `error` row says about itself, naming the stage when the row carries one. */
function errorSummary(row: ProbeRow): string {
  const failed = row.bootstrap?.stages.find((s) => s.status === "failed");
  if (!failed) return "the row is in error: a bootstrap stage failed";
  const why = failed.message ? `: ${failed.message}` : "";
  return `the row is in error: bootstrap stage ${failed.id} failed${why}`;
}

/**
 * The statuses for which "EC2 disagrees with the row" is a *finding*.
 *
 * `creating` and `error` are excluded on purpose and have rules of their own:
 * a create that failed halfway is *defined* by the instance being in an
 * unpredictable place, so calling that drift would fire on every one of them.
 */
const DRIFTABLE: readonly ProbeRow["status"][] = ["stopped", "stopping", "destroying", "destroyed"];

/**
 * For a row that is not expected to be heartbeating, does EC2 agree with it?
 *
 * `stopped`/`stopping` want a box that is off; `destroying`/`destroyed` want no
 * box at all. Only asked about `DRIFTABLE` statuses; anything else is false so
 * that a status with no agreement defined for it can never be blessed as `ok`
 * by rule 16 on the strength of this function's silence.
 */
function instanceAgreesWith(status: ProbeRow["status"], instance: ProbeInstance): boolean {
  const state = instance.state ?? "";
  if (status === "stopped" || status === "stopping") {
    return absentInstance(instance) || OFF_STATES.includes(state);
  }
  if (status === "destroyed" || status === "destroying") {
    return absentInstance(instance) || GONE_STATES.includes(state);
  }
  return false;
}

/**
 * There is no instance, and we know it — either the row never named one, or EC2
 * answered that the id does not exist.
 *
 * A *failed* lookup is deliberately not absence. "We could not ask" and "there
 * is nothing there" are the same shape and opposite meanings, and treating the
 * first as the second is how a destroyed row over an unreadable EC2 gets
 * reported as consistent when nothing was actually checked.
 */
function absentInstance(instance: ProbeInstance): boolean {
  return instance.not_found || (instance.outcome === "skip" && instance.instance_id === null);
}

/** What to do about a row and an instance that disagree, per direction of drift. */
function driftHints(n: string, status: ProbeRow["status"], instance: ProbeInstance): string[] {
  const state = instance.state ?? "";
  if ((status === "stopped" || status === "stopping") && GONE_STATES.includes(state)) {
    // `agent start` boots a *fresh* instance from the row, and the row's
    // instance id no longer exists — so it is the one command that cannot work.
    return [
      `\`hermetic agent start ${n}\` cannot work: the instance is ${state}`,
      `hermetic agent recreate ${n}`,
      `hermetic agent destroy ${n}`,
      "hermetic doctor",
    ];
  }
  if (status === "stopped" || status === "stopping") {
    // Running while the row says stopped: it is billing and nothing watches it.
    return [`hermetic agent stop ${n}`, `hermetic agent destroy ${n}`, "hermetic doctor"];
  }
  return [`hermetic agent destroy ${n}`, "hermetic doctor"];
}

function consistentSummary(status: ProbeRow["status"], instance: ProbeInstance): string {
  if (instance.instance_id === null) return `${status}, and there is no instance`;
  if (instance.not_found) return `${status}, and the instance is gone`;
  return `${status}, and the instance is ${instance.state}`;
}

export function createProbe(deps: ProbeDeps) {
  const { backend } = deps.ctx;
  const timeoutMs = deps.timeoutMs ?? AGENT_PROBE_TIMEOUT_MS;
  // `performance.now()` is monotonic, so a latency cannot come back negative
  // because NTP moved the wall clock mid-probe.
  const now = (): number => performance.now();

  /** EC2's two questions about the box, as one layer. */
  async function instanceLayer(agent: Agent, signal: AbortSignal | undefined): Promise<ProbeInstance> {
    const id = agent.instance_id ?? null;
    if (!id) {
      return {
        outcome: "skip",
        detail: "the row has no instance",
        latency_ms: null,
        instance_id: null,
        state: null,
        system_status: null,
        instance_status: null,
        not_found: false,
      };
    }
    return layer<ProbeInstance>(
      now,
      timeoutMs,
      signal,
      async () => {
        const ref = await backend.compute.describeInstance(id);
        if (!ref) {
          // EC2 answered, and the answer was "no such instance". This is the
          // one path that may set `not_found`, and therefore the only one that
          // can lead the verdict to a destructive hint.
          return {
            outcome: "fail",
            detail: `instance ${id} not found (terminated and expired out of EC2?)`,
            instance_id: id,
            state: null,
            system_status: null,
            instance_status: null,
            not_found: true,
          };
        }
        // Status checks are asked for second and separately: a box EC2 has no
        // opinion about is still a box EC2 knows the state of, and losing the
        // state because the checks were empty would be the worse trade.
        const checks = await backend.compute.describeInstanceStatus(id);
        const parts = [ref.state];
        if (checks?.system_status) parts.push(`system ${checks.system_status}`);
        if (checks?.instance_status) parts.push(`instance ${checks.instance_status}`);
        return {
          outcome: "ok",
          detail: parts.join(" · "),
          instance_id: id,
          state: ref.state,
          system_status: checks?.system_status ?? null,
          instance_status: checks?.instance_status ?? null,
          not_found: false,
        };
      },
      // A throw or a timeout: EC2 did not answer, so nothing is known about
      // whether the instance exists. `not_found` stays false — that is what
      // stops rule 3 from recommending `recreate` on a slow API call.
      (detail) => ({
        outcome: "fail",
        detail,
        instance_id: id,
        state: null,
        system_status: null,
        instance_status: null,
        not_found: false,
      }),
    );
  }

  /**
   * hermeticd answering for itself over the tailnet.
   *
   * `seen` is how the browser layer gets its answer without a second call: one
   * `/healthz` carries both, and asking the box twice for one response body
   * would double the cost of the probe to re-read a field it already has.
   */
  async function hermeticdLayer(
    agent: Agent,
    signal: AbortSignal | undefined,
    seen: { browsers: ProbeBrowserIdentity[] | null },
  ): Promise<ProbeHermeticd> {
    const ip = agent.tailscale_ip ?? null;
    if (!ip) {
      return {
        outcome: "skip",
        detail: "no tailscale ip yet (hermeticd reports it on its first heartbeat)",
        latency_ms: null,
        tailscale_ip: null,
        hermeticd_version: null,
        protocol: null,
        config_hash: null,
      };
    }
    return layer<ProbeHermeticd>(
      now,
      timeoutMs,
      signal,
      async (combined) => {
        const health = await backend.rpc.health(agent.name, { signal: combined });
        seen.browsers = health.browsers ?? null;
        const parts = [`hermeticd ${health.hermeticd_version}`, `protocol ${health.protocol}`];
        // A version the box reports and the row does not is a heartbeat that
        // has not caught up — worth saying, because it changes what a stale
        // `hermeticd_version` in `agent status` means.
        if (agent.hermeticd_version && agent.hermeticd_version !== health.hermeticd_version) {
          parts.push(`row says ${agent.hermeticd_version}`);
        }
        return {
          outcome: "ok",
          detail: parts.join(" · "),
          tailscale_ip: ip,
          hermeticd_version: health.hermeticd_version,
          protocol: health.protocol,
          config_hash: health.config_hash ?? null,
        };
      },
      (detail) => ({
        outcome: "fail",
        detail,
        tailscale_ip: ip,
        hermeticd_version: null,
        protocol: null,
        config_hash: null,
      }),
    );
  }

  /**
   * The end-to-end one: the agent's dashboard over HTTPS from the laptop.
   * *Any* HTTP response passes — 401, 404 and a redirect all prove the tailnet
   * cert, `tailscale serve` and a listener behind it, which is the entire
   * question. Only a transport failure (TLS, DNS, refused, timed out) is a fail.
   *
   * The host is `agentHostname`, not `<name>.<tailnet>`: after a recreate whose
   * predecessor still sits in the device list, the canonical name resolves to
   * the dead node, and fetching it would report a stale device's silence as
   * this agent's dashboard being down.
   */
  async function dashboardLayer(
    agent: Agent,
    signal: AbortSignal | undefined,
    /** The shared `_fleet` read, so two layers cost one `GetItem`. */
    readFleet: () => Promise<SeenFleet>,
  ): Promise<ProbeDashboard> {
    /**
     * The URL is resolved *inside* the timed body. Working out where the
     * dashboard lives means a `GetItem` on `_fleet`, which is a network call
     * like any other — resolving it outside the race would leave one DynamoDB
     * read as the single unbounded step in a method whose whole contract is
     * that every step is bounded.
     */
    let url: string | null = null;
    return layer<ProbeDashboard>(
      now,
      timeoutMs,
      signal,
      async (combined) => {
        const { tailnet, fleet_id } = await readFleet();
        url = tailnet ? agentDashboardUrl(agent, tailnet, cloudName(fleet_id, agent.name)) : null;
        if (!url) {
          return {
            outcome: "skip",
            detail: "tailnet not recorded in config",
            url: null,
            http_status: null,
          };
        }
        const http = deps.fetch;
        if (!http) {
          return {
            outcome: "skip",
            detail: "no HTTP client available to this build",
            url,
            http_status: null,
          };
        }
        const res = await http(url, { method: "GET", redirect: "manual", signal: combined });
        return {
          outcome: "ok",
          detail: `HTTP ${res.status} from ${url}`,
          url,
          http_status: res.status,
        };
      },
      (detail) => ({ outcome: "fail", detail, url, http_status: null }),
    );
  }

  /**
   * The desktop: `https://<host>/vnc/`, the noVNC client onto the display the
   * agent's browser draws on (§7.3). The same fetch as the dashboard layer, one
   * path along, and deliberately *not* the same acceptance rule.
   *
   * Any response proves the node serves; that is the dashboard's question and
   * it is already answered by the time this runs. This layer's question is
   * narrower — is a client published here — so only 200 (the rendered
   * `index.html`, a meta refresh) or a redirect (a future server-side one)
   * passes. A 404 is the agent that has not been re-applied since the file
   * existed, and it has a fix, so it is reported as a failure with the fix in
   * its detail rather than quietly as "the node answered".
   */
  async function desktopLayer(
    agent: Agent,
    signal: AbortSignal | undefined,
    readFleet: () => Promise<SeenFleet>,
  ): Promise<ProbeDesktop> {
    let url: string | null = null;
    return layer<ProbeDesktop>(
      now,
      timeoutMs,
      signal,
      async (combined) => {
        const { tailnet, fleet_id } = await readFleet();
        url = tailnet ? agentDesktopUrl(agent, tailnet, cloudName(fleet_id, agent.name)) : null;
        if (!url) {
          return {
            outcome: "skip",
            detail: "tailnet not recorded in config",
            url: null,
            http_status: null,
          };
        }
        const http = deps.fetch;
        if (!http) {
          return {
            outcome: "skip",
            detail: "no HTTP client available to this build",
            url,
            http_status: null,
          };
        }
        const res = await http(url, { method: "GET", redirect: "manual", signal: combined });
        const served = res.status === 200 || (res.status >= 300 && res.status < 400);
        const why = res.status === 404 ? " — no noVNC client at that path (re-apply this agent)" : "";
        return {
          outcome: served ? "ok" : "fail",
          detail: `HTTP ${res.status} from ${url}${why}`,
          url,
          http_status: res.status,
        };
      },
      (detail) => ({ outcome: "fail", detail, url, http_status: null }),
    );
  }

  /**
   * The browser stack itself, which only the box can see: Chrome's CDP port is
   * on loopback and never published (§B), so nothing on the laptop can reach
   * it. hermeticd asks systemd and CDP on our behalf and reports the answer on
   * `/healthz`, and this layer relays what the hermeticd layer already fetched
   * — it opens no socket of its own.
   */
  async function browserLayer(
    hermeticd: Promise<ProbeHermeticd>,
    seen: { browsers: ProbeBrowserIdentity[] | null },
  ): Promise<ProbeBrowser> {
    const skip = (detail: string): ProbeBrowser => ({
      outcome: "skip",
      detail,
      latency_ms: null,
      browsers: [],
    });
    // The same promise the hermeticd layer is awaiting, not a second call.
    const health = await hermeticd;
    if (health.outcome !== "ok") {
      return skip(`hermeticd did not answer, so its browsers were not asked: ${health.detail}`);
    }
    const browsers = seen.browsers;
    if (!browsers) {
      // Absent, not empty: this hermeticd predates the field, or its manifest
      // is missing or unreadable, so the box said nothing. The distinction is
      // the whole reason the field is optional — reporting it as "no browsers
      // are running" would send an operator to debug a unit that is fine on a
      // box whose only problem is an old binary.
      return skip("hermeticd did not report browsers (older release; run artifacts push and rerun)");
    }
    if (browsers.length === 0) {
      // Empty, not absent: hermeticd read a manifest and it lists no browsers,
      // while this agent's row says browser is on (`!agent.browser` already
      // returned above). The box is current and its applied configuration is
      // not — it predates the browser stack, or was rendered `--no-browser` and
      // the row flipped since — so there is a rerun owing, not a unit to debug.
      return {
        outcome: "fail",
        detail:
          "hermeticd reports no browser identities although this agent has browser on — " +
          "its applied config predates the browser stack; run agent rerun",
        latency_ms: health.latency_ms,
        browsers,
      };
    }
    const down = browsers.find((b) => !(b.unit_active && b.cdp_ok));
    if (down) {
      return {
        outcome: "fail",
        detail: `${down.name}: ${down.detail}`,
        latency_ms: health.latency_ms,
        browsers,
      };
    }
    return {
      outcome: "ok",
      detail: browsers
        .map((b) => `${b.name}: hermetic-browser@${b.name} active, CDP ${b.cdp_version ?? "unknown"}`)
        .join(" · "),
      latency_ms: health.latency_ms,
      browsers,
    };
  }

  /** §3.2 rule 2's abort, in the shape `checkAbort` raises it in `hermetic.ts`. */
  function aborted(phase: string): HermeticError {
    return new HermeticError("ABORTED", `operation aborted during ${phase}`, { phase });
  }

  async function probe(name: string, opts: { signal?: AbortSignal } = {}): Promise<ProbeReport> {
    // A caller who has already given up gets the abort, not four layers of
    // work followed by a report nobody asked for.
    if (opts.signal?.aborted) throw aborted("probe");
    validateName(name);
    await deps.ctx.guardAccount();
    const agent = await deps.ctx.getAgent(name);
    const v = deps.ctx.view(agent);

    const row: ProbeRow = {
      status: v.status,
      display_status: v.display_status,
      last_heartbeat: v.last_heartbeat ?? null,
      heartbeat_age_ms: v.heartbeat_age_ms,
      updated_at: v.updated_at,
      health: v.health ?? null,
      hermeticd_version: v.hermeticd_version ?? null,
      lock: v.lock ?? null,
      bootstrap: v.bootstrap ?? null,
    };

    /**
     * In parallel, and settled rather than raced: the whole value of the report
     * is that a dead layer does not stop the others from answering. Each
     * `*Layer` already catches its own failures, so a rejection here would be a
     * bug in this module — but the fallbacks below mean it still cannot take
     * the probe down with it.
     */
    // `_fleet` is read once and shared: the dashboard and desktop layers both
    // need the tailnet to build a URL, and the hostname comparison below needs
    // the fleet's id and name, and none of that is worth three `GetItem`s. A
    // fleet item this caller cannot read is "not asked", not "down", so the
    // failure resolves to the same nulls an unconfigured fleet gives.
    const seen: SeenFleet = { tailnet: null, fleet_id: null, fleet_name: null };
    let fleetRead: Promise<SeenFleet> | null = null;
    const readFleet = (): Promise<SeenFleet> => {
      fleetRead ??= deps
        .tailnet()
        .catch(() => ({ tailnet: null, fleet_id: null, fleet_name: null }))
        .then((v) => {
          seen.tailnet = v.tailnet;
          seen.fleet_id = v.fleet_id;
          seen.fleet_name = v.fleet_name;
          return v;
        });
      return fleetRead;
    };

    // One `/healthz` answers two layers: `hermeticdLayer` fetches it and the
    // browser layer reads what it saw, so the box is asked once.
    const seenHealth: { browsers: ProbeBrowserIdentity[] | null } = { browsers: null };
    const hermeticdP = hermeticdLayer(agent, opts.signal, seenHealth);

    const [instanceR, hermeticdR, dashboardR, desktopR, browserR] = await Promise.allSettled([
      instanceLayer(agent, opts.signal),
      hermeticdP,
      dashboardLayer(agent, opts.signal, readFleet),
      desktopLayer(agent, opts.signal, readFleet),
      browserLayer(hermeticdP, seenHealth),
    ]);

    /**
     * The operator gave up. `layer` rethrows rather than inventing a detail in
     * this case, so the settled results are rejections carrying nothing worth
     * reporting — and a half-cancelled report would be worse than none, because
     * three `fail`s would read as a diagnosis of the agent rather than of the
     * Ctrl-C.
     */
    if (opts.signal?.aborted) throw aborted("probe");

    const instance: ProbeInstance =
      instanceR.status === "fulfilled"
        ? instanceR.value
        : {
            outcome: "fail",
            detail: messageOf(instanceR.reason),
            latency_ms: null,
            instance_id: agent.instance_id ?? null,
            state: null,
            system_status: null,
            instance_status: null,
            not_found: false,
          };
    const hermeticd: ProbeHermeticd =
      hermeticdR.status === "fulfilled"
        ? hermeticdR.value
        : {
            outcome: "fail",
            detail: messageOf(hermeticdR.reason),
            latency_ms: null,
            tailscale_ip: agent.tailscale_ip ?? null,
            hermeticd_version: null,
            protocol: null,
            config_hash: null,
          };
    const dashboard: ProbeDashboard =
      dashboardR.status === "fulfilled"
        ? dashboardR.value
        : {
            outcome: "fail",
            detail: messageOf(dashboardR.reason),
            latency_ms: null,
            url: null,
            http_status: null,
          };

    const desktop: ProbeDesktop =
      desktopR.status === "fulfilled"
        ? desktopR.value
        : {
            outcome: "fail",
            detail: messageOf(desktopR.reason),
            latency_ms: null,
            url: null,
            http_status: null,
          };
    const browser: ProbeBrowser =
      browserR.status === "fulfilled"
        ? browserR.value
        : {
            outcome: "fail",
            detail: messageOf(browserR.reason),
            latency_ms: null,
            browsers: [],
          };

    return {
      name,
      at: backend.clock.now().toISOString(),
      row,
      instance,
      hermeticd,
      dashboard,
      desktop,
      browser,
      /**
       * Neither new layer is passed to the verdict, and that is the rule rather
       * than an omission: a browser that is down is *reported*,
       * not a failed probe. The verdict answers "is this agent reachable and
       * is its row true", and a dead Chrome changes neither.
       */
      verdict: verdictFor({
        name,
        row,
        instance,
        hermeticd,
        dashboard,
        hostname_mismatch: agentHostnameMismatch(
          agent,
          seen.tailnet,
          cloudName(seen.fleet_id, agent.name),
          legacyCloudNames(seen.fleet_name, agent.name),
        ),
      }),
    };
  }

  return { probe };
}
