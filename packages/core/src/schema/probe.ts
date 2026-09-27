import { z } from "zod";
import { Iso } from "./common.ts";
import { AgentStatus, BootstrapState, DisplayStatus, Health, Lock } from "./agent.ts";
import { AgentName } from "./requests.ts";
import { RpcBrowserHealth } from "./rpc.ts";

/**
 * `agents.probe` (§9): the *active* counterpart to `display_status`.
 *
 * Liveness is otherwise entirely passive — hermeticd writes `last_heartbeat`
 * every 30s and `deriveDisplayStatus` calls a row `unreachable` once that is
 * older than three intervals (§4.3). That single word covers four different
 * worlds, and they want four different next commands:
 *
 *   - the EC2 box is stopped or terminated             → `agent start`/`recreate`
 *   - the box runs but hermeticd is dead               → console logs, `reboot`
 *   - hermeticd is alive but its writes are failing    → the instance role
 *   - hermeticd is alive and *this laptop* is off-net  → `tailscale status`
 *
 * A probe asks each layer directly, in parallel and with a bounded timeout, and
 * reports what each one said. It writes nothing: no row update, no event, no
 * lock. A layer that fails is *data* — `outcome: "fail"` with the reason — not
 * an error, because "hermeticd did not answer" is precisely the answer the
 * operator asked for. Only a missing agent or a failed account guard throws.
 */

/** `ok` answered, `fail` was asked and did not, `skip` was not askable at all. */
export const ProbeOutcome = z.enum(["ok", "fail", "skip"]);
export type ProbeOutcome = z.infer<typeof ProbeOutcome>;

/**
 * One layer's answer. `detail` is always a human sentence — an empty detail
 * would make a `skip` indistinguishable from a layer nobody thought about.
 * `latency_ms` is null when nothing was actually attempted.
 */
export const ProbeLayer = z.object({
  outcome: ProbeOutcome,
  detail: z.string(),
  latency_ms: z.number().int().nonnegative().nullable(),
});
export type ProbeLayer = z.infer<typeof ProbeLayer>;

/**
 * `DescribeInstances` + `DescribeInstanceStatus`. The two status strings are
 * EC2's own vocabulary (`ok`/`impaired`/`insufficient-data`/`not-applicable`/
 * `initializing`), verbatim rather than mapped: `impaired` means something
 * specific to anyone who will go on to read the EC2 console, and a rename would
 * only cost them that.
 */
export const ProbeInstance = ProbeLayer.extend({
  instance_id: z.string().nullable(),
  /** `pending`|`running`|`stopping`|`stopped`|`shutting-down`|`terminated`. */
  state: z.string().nullable(),
  system_status: z.string().nullable(),
  instance_status: z.string().nullable(),
  /**
   * EC2 answered, and its answer was that this instance does not exist.
   *
   * Deliberately not the same thing as `outcome === "fail"`, and the
   * distinction is the most consequential one in the whole report: "the box is
   * gone" leads an operator to `agent recreate`/`agent destroy`, while "EC2 did
   * not answer in five seconds" leads them to try again. Collapsing the two
   * would let one slow `DescribeInstances` recommend rebuilding a healthy
   * agent, so the verdict rules gate on this flag and never on a bare failure.
   */
  not_found: z.boolean(),
});
export type ProbeInstance = z.infer<typeof ProbeInstance>;

/** `GET /healthz` over the tailnet — hermeticd answering for itself (§6.4). */
export const ProbeHermeticd = ProbeLayer.extend({
  tailscale_ip: z.string().nullable(),
  hermeticd_version: z.string().nullable(),
  protocol: z.number().int().nullable(),
  config_hash: z.string().nullable(),
});
export type ProbeHermeticd = z.infer<typeof ProbeHermeticd>;

/**
 * `https://<name>.<tailnet>/` from the laptop. Any HTTP response at all is a
 * pass — 401 and 404 both prove the tailnet cert, `tailscale serve` and a
 * listener, which is the whole question. Only a transport failure is a fail.
 */
export const ProbeDashboard = ProbeLayer.extend({
  url: z.string().nullable(),
  http_status: z.number().int().nullable(),
});
export type ProbeDashboard = z.infer<typeof ProbeDashboard>;

/**
 * `https://<name>.<tailnet>/vnc/` from the laptop: the agent's desktop (§7.3).
 *
 * The same two fields as `ProbeDashboard` and deliberately its own schema
 * rather than an alias — the two ask different questions of the same node, so
 * the day the desktop layer reports which browser identity it reached, it can,
 * without the dashboard growing a field it has no use for.
 *
 * Unlike the dashboard, not every response passes. The question here is whether
 * a noVNC *client* is published at that path, so a 404 — the pre-`index.html`
 * agent, serving a directory listing or nothing — is a fail with something to
 * do about it, and only 200 or a redirect is a pass.
 */
export const ProbeDesktop = ProbeLayer.extend({
  url: z.string().nullable(),
  http_status: z.number().int().nullable(),
});
export type ProbeDesktop = z.infer<typeof ProbeDesktop>;

/**
 * One browser identity as hermeticd reported it — the wire schema under the
 * name the report uses (`RpcBrowserHealth`, `schema/rpc.ts`). One shape, so
 * the box's answer travels to the operator without being re-described.
 */
export const ProbeBrowserIdentity = RpcBrowserHealth;
export type ProbeBrowserIdentity = z.infer<typeof ProbeBrowserIdentity>;

/**
 * The browser stack, as reported *by the box* rather than reached from the
 * laptop: hermeticd already asked systemd and CDP, and the probe relays it.
 *
 * `browsers` is empty whenever the layer did not get an answer — a `skip` for
 * an agent created with `--no-browser`, and a `skip` for a hermeticd too old to
 * report the field at all. Neither is a failure of the agent.
 */
export const ProbeBrowser = ProbeLayer.extend({
  browsers: z.array(ProbeBrowserIdentity),
});
export type ProbeBrowser = z.infer<typeof ProbeBrowser>;

export const ProbeVerdictLevel = z.enum(["ok", "warn", "bad", "unknown"]);
export type ProbeVerdictLevel = z.infer<typeof ProbeVerdictLevel>;

/**
 * The reading of the four layers together, and — the part that makes a probe
 * worth running — what to do about it. `hints` are concrete: commands to type,
 * or a named place in a console to look.
 */
export const ProbeVerdict = z.object({
  level: ProbeVerdictLevel,
  summary: z.string(),
  hints: z.array(z.string()),
});
export type ProbeVerdict = z.infer<typeof ProbeVerdict>;

/** The row as the probe read it, so the report explains its own verdict. */
export const ProbeRow = z.object({
  status: AgentStatus,
  display_status: DisplayStatus,
  last_heartbeat: Iso.nullable(),
  heartbeat_age_ms: z.number().nullable(),
  updated_at: Iso,
  health: Health.nullable(),
  hermeticd_version: z.string().nullable(),
  lock: Lock.nullable(),
  /**
   * The staged bootstrap's progress, so an `error` verdict can name the stage
   * that failed rather than saying only that one did. Carried on the report
   * because the operator reading a probe should not have to run `agent status`
   * to learn which of eight stages stopped.
   */
  bootstrap: BootstrapState.nullable(),
});
export type ProbeRow = z.infer<typeof ProbeRow>;

export const ProbeReport = z.object({
  name: AgentName,
  at: Iso,
  row: ProbeRow,
  instance: ProbeInstance,
  hermeticd: ProbeHermeticd,
  dashboard: ProbeDashboard,
  /**
   * The two browser layers, after the dashboard because that is the order they
   * depend on each other in for a reader: a desktop is only worth reaching if
   * the node answers at all, and a browser is only worth watching if the
   * desktop serves.
   */
  desktop: ProbeDesktop,
  browser: ProbeBrowser,
  verdict: ProbeVerdict,
});
export type ProbeReport = z.infer<typeof ProbeReport>;
