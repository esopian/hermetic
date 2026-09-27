/**
 * `doctor` (§9), as a checklist rather than as a verdict.
 *
 * The report carries far more than the findings it derives `ok` from: the
 * account and fleet guards, the stack, the foundation version, the security
 * group, row parsing, heartbeats, EC2/DynamoDB drift, the tailnet's devices,
 * the policy file and the operator's own machine. The panel used to render only
 * the parts that had gone *wrong*, which meant a healthy fleet showed a green
 * badge and nothing else — an operator could not tell a check that passed from
 * a check that never ran.
 *
 * So every check states itself here, passing or not, and the checks that could
 * not run say so (`skip`) rather than being left out and read as clean.
 *
 * Pure and DOM-free, like `settings-logic.ts` and `foundation-logic.ts`: the
 * section renders what this returns, and the wording of every state is
 * assertable without mounting React.
 */
import { fmtDuration } from "./format.ts";

/**
 * `ok`/`bad` are the two halves of a check that ran and has a verdict; `warn`
 * is a check that ran, is not a fault, and is still worth acting on (an
 * available foundation update, a drifted policy block); `info` is something
 * hermetic cannot fix and does not judge (a stale device, an unreadable policy
 * file); `skip` is a check that could not run, which is never rendered as a
 * pass.
 */
export type CheckState = "ok" | "warn" | "bad" | "info" | "skip";

export interface DoctorCheck {
  id: string;
  label: string;
  state: CheckState;
  /** The one line under the label. Never a secret — the report carries none. */
  detail: string;
  /** The rows behind a count: the drifted instances, the agents, the notes. */
  items?: string[];
  /**
   * The `<summary>` a *passing* check's rows hide behind. A check that failed
   * shows its rows outright — that is the evidence — but a fleet where every
   * agent is heartbeating should not spend fifty lines saying so.
   */
  items_summary?: string;
}

export interface DoctorCheckGroup {
  title: string;
  checks: DoctorCheck[];
}

/**
 * `DoctorReport` (core `doctor.ts`), narrowed to what the checklist reads and
 * spelled here rather than imported from `api.ts` so this module stays free of
 * the `hc` client — the same reason `foundation-logic.ts` restates its inputs.
 * `api.ts`'s inferred `Doctor` is assignable to it.
 */
export interface DoctorFacts {
  ok: boolean;
  account: { frozen: string; observed: string; ok: boolean };
  fleet: { local: string | null; stack_tag: string | null; fleet_item: string | null; ok: boolean };
  foundation: {
    present: boolean;
    status: string | null;
    outdated: boolean;
    version: number;
    available_version: number;
  };
  security_group: { inbound_rules: number; ok: boolean };
  env_overrides: string[];
  unparseable_rows: string[];
  heartbeats: Array<{ name: string; status: string; age_ms: number | null; unreachable: boolean }>;
  findings: string[];
  instance_drift: Array<{ kind: string; agent: string | null; detail: string }>;
  tailscale: {
    available: boolean;
    missing: string[];
    stale: Array<{ agent: string; note: string }>;
    detail: string | null;
    policy: { scope: string; managed: string; blocks_drifted: string[] } | null;
  };
  local_tailscale: {
    ok: boolean;
    tailnet: string | null;
    https_certificates: boolean;
    detail: string;
  };
  /**
   * §5's fleet network mode. `checked_nat` is the field that keeps a `public`
   * fleet's two NAT checks out of the pass column: there is no appliance to
   * look at, so neither ran, and `skip` is the only honest state for them.
   */
  network: {
    mode: "public" | "nat" | null;
    stack_mode: "public" | "nat" | null;
    consistent: boolean;
    nat: {
      instance_id: string | null;
      instance_state: string | null;
      egress_ip: string | null;
      route_state: "active" | "blackhole" | null;
    } | null;
    checked_nat: boolean;
    drifted: string[];
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12m ago" / "just now" / "never", the same vocabulary the fleet table uses. */
function age(ms: number | null): string {
  if (ms === null) return "never";
  if (ms < 60_000) return "just now";
  return `${fmtDuration(ms)} ago`;
}

function accountAndFleet(d: DoctorFacts): DoctorCheck[] {
  const f = d.fleet;
  return [
    {
      id: "account",
      label: "account",
      state: d.account.ok ? "ok" : "bad",
      detail: d.account.ok
        ? `credentials resolve to ${d.account.frozen}, the account this home is frozen to`
        : `frozen to ${d.account.frozen} but credentials resolve to ${d.account.observed}`,
    },
    {
      id: "fleet",
      label: "fleet id",
      state: f.ok ? "ok" : "bad",
      detail: f.ok
        ? `${f.local} — local config, stack tag and the _fleet item all agree`
        : "the three copies of the fleet id disagree",
      items: f.ok
        ? undefined
        : [
            `local config: ${f.local ?? "—"}`,
            `stack tag: ${f.stack_tag ?? "—"}`,
            `_fleet item: ${f.fleet_item ?? "—"}`,
          ],
    },
    {
      id: "foundation-stack",
      label: "foundation stack",
      state: d.foundation.present ? "ok" : "bad",
      detail: d.foundation.present
        ? (d.foundation.status ?? "present")
        : "no stack found, under its own name or any other tagged with this fleet id",
    },
    {
      /**
       * A `warn`, never a `bad`: core reports an available update as a field
       * and keeps it out of `findings` for the reason §6.6 gives — every fleet
       * would go permanently un-`ok` the moment a new hermetic shipped.
       */
      id: "foundation-version",
      label: "foundation version",
      state: d.foundation.outdated ? "warn" : "ok",
      detail: d.foundation.outdated
        ? `v${d.foundation.version} → v${d.foundation.available_version} — this build would apply an update`
        : `v${d.foundation.version}, the version this build ships`,
    },
    {
      id: "security-group",
      label: "agent security group",
      state: d.security_group.ok ? "ok" : "bad",
      detail: d.security_group.ok
        ? "no inbound rules — every agent is reached over the tailnet"
        : `${plural(d.security_group.inbound_rules, "inbound rule")}; it must have none`,
    },
    {
      id: "agent-rows",
      label: "agent rows",
      state: d.unparseable_rows.length === 0 ? "ok" : "bad",
      detail:
        d.unparseable_rows.length === 0
          ? "every row in the agents table parses"
          : `${plural(d.unparseable_rows.length, "row")} do not parse and are hidden from every fleet read`,
      items: d.unparseable_rows.length === 0 ? undefined : d.unparseable_rows,
    },
  ];
}

function agents(d: DoctorFacts): DoctorCheck[] {
  const beats = d.heartbeats;
  const unreachable = beats.filter((h) => h.unreachable);
  const drift = d.instance_drift;
  return [
    {
      id: "heartbeats",
      label: "heartbeats",
      state: beats.length === 0 ? "info" : unreachable.length === 0 ? "ok" : "bad",
      detail:
        beats.length === 0
          ? "no agents in this fleet"
          : unreachable.length === 0
            ? `all ${plural(beats.length, "agent")} heartbeating`
            : `${unreachable.length} of ${plural(beats.length, "agent")} not heartbeating`,
      items: beats.map(
        (h) => `${h.name} · ${h.status} · ${age(h.age_ms)}${h.unreachable ? " · unreachable" : ""}`,
      ),
      items_summary: `${plural(beats.length, "agent")}, with their last heartbeat`,
    },
    {
      id: "instance-drift",
      label: "EC2 ↔ DynamoDB",
      state: drift.length === 0 ? "ok" : "bad",
      detail:
        drift.length === 0
          ? "every row and every live instance agree"
          : `${plural(drift.length, "disagreement")} between the rows and what EC2 is running`,
      items: drift.length === 0 ? undefined : drift.map((x) => x.detail),
    },
  ];
}

/**
 * §5's egress, as four checks rather than one verdict.
 *
 * Three of them can only run on a `nat` fleet, and this is exactly the place
 * the file's header rule earns its keep: a `public` fleet has no NAT appliance
 * and no private default route, so those checks did not run and are `skip`.
 * Rendering them green would tell an operator that a box which does not exist
 * is healthy — which is the same sentence a `nat` fleet gets when its appliance
 * is fine, and the two must not look alike.
 */
function network(d: DoctorFacts): DoctorCheck[] {
  const n = d.network;
  const nat = n.nat;
  return [
    {
      /**
       * The cache against CloudFormation, the same reconciliation §4.8 does for
       * `foundation_version`. `skip` only when neither side answered — a stack
       * that could not be described says nothing about the fleet's mode.
       */
      id: "network-mode",
      label: "network mode",
      state: n.mode === null && n.stack_mode === null ? "skip" : n.consistent ? "ok" : "bad",
      detail:
        n.mode === null && n.stack_mode === null
          ? "unchecked — neither the _fleet item nor the stack reported a mode"
          : n.consistent
            ? `${n.stack_mode} — the _fleet item and the foundation stack agree`
            : n.mode === null
              ? `the stack says ${n.stack_mode ?? "nothing"} but the _fleet item records no mode; a foundation update back-fills it`
              : `the _fleet item records ${n.mode} but the stack says ${n.stack_mode ?? "nothing"}; the stack is authoritative`,
    },
    {
      id: "nat-instance",
      label: "NAT instance",
      state: !n.checked_nat ? "skip" : nat?.instance_state === "running" ? "ok" : "bad",
      detail: !n.checked_nat
        ? "unchecked — this fleet has no NAT appliance to look at"
        : nat?.instance_state === "running"
          ? `${nat.instance_id ?? "—"} is running${nat.egress_ip === null ? "" : ` · egress ${nat.egress_ip}`}`
          : `${nat?.instance_id ?? "the NAT instance"} is ${nat?.instance_state ?? "not reporting a state"} — every agent is without internet access until it is running`,
    },
    {
      id: "nat-route",
      label: "private default route",
      state: !n.checked_nat ? "skip" : nat?.route_state === "blackhole" ? "bad" : "ok",
      detail: !n.checked_nat
        ? "unchecked — this fleet has no private subnets to route out of"
        : nat?.route_state === "blackhole"
          ? "blackholed: it is pinned to a NAT instance that no longer exists, so the fleet has no egress at all"
          : nat?.route_state === "active"
            ? "active — the private subnets reach the internet through the NAT instance"
            : "no route state was reported, so nothing contradicts it",
    },
    {
      id: "network-placement",
      label: "agents on the fleet's subnets",
      state: n.drifted.length === 0 ? "ok" : "bad",
      detail:
        n.drifted.length === 0
          ? "every agent is in a subnet this fleet still launches into"
          : `${plural(n.drifted.length, "agent")} left behind by a network mode change — run \`hermetic agent recreate <name>\` for each`,
      items: n.drifted.length === 0 ? undefined : n.drifted,
    },
  ];
}

function tailnet(d: DoctorFacts): DoctorCheck[] {
  const t = d.tailscale;
  const policy = t.policy;
  const checks: DoctorCheck[] = [
    {
      /**
       * Informational when it is unavailable, not a fault: the fix is a new
       * OAuth client, which no hermetic command can mint for the operator.
       */
      id: "device-list",
      label: "device list",
      state: t.available ? "ok" : "info",
      detail: t.available
        ? "readable — this fleet's OAuth client has the devices:core scope"
        : "unavailable, so device drift went unchecked",
      items: t.available || t.detail === null ? undefined : [t.detail],
    },
    {
      id: "device-peers",
      label: "ready agents on the tailnet",
      state: !t.available ? "skip" : t.missing.length === 0 ? "ok" : "bad",
      detail: !t.available
        ? "unchecked — there is no device list to compare the rows against"
        : t.missing.length === 0
          ? "every ready agent has a tailnet device"
          : `${plural(t.missing.length, "ready agent")} with no tailnet device`,
      items: t.missing.length === 0 ? undefined : t.missing,
    },
    {
      /**
       * Never a fault either (§6.5): deleting the device happens in a console
       * hermetic's OAuth client has no scope to reach, so a fleet with one
       * recreated agent would otherwise read red for ever.
       */
      id: "stale-devices",
      label: "stale devices",
      state: t.stale.length === 0 ? "ok" : "info",
      detail:
        t.stale.length === 0
          ? "no agent's canonical name points at a dead node"
          : `${plural(t.stale.length, "agent")} whose canonical name resolves to a dead node`,
      items: t.stale.length === 0 ? undefined : t.stale.map((s) => s.note),
    },
  ];
  if (policy === null) {
    checks.push({
      id: "policy",
      label: "tailnet policy",
      state: "info",
      detail: "could not be read — this is not a clean bill",
    });
  } else if (policy.scope === "none") {
    checks.push({
      id: "policy",
      label: "tailnet policy",
      state: "skip",
      detail:
        "unchecked — the fleet's OAuth client has no policy_file scope, so hermetic cannot read the file",
    });
  } else {
    const drifted = policy.blocks_drifted;
    checks.push({
      id: "policy",
      label: "tailnet policy",
      state: drifted.length === 0 ? "ok" : "warn",
      detail:
        drifted.length === 0
          ? `${policy.managed} · every hermetic-managed block matches (${policy.scope} scope)`
          : `${plural(drifted.length, "managed block")} absent or saying something else`,
      items: drifted.length === 0 ? undefined : drifted,
    });
  }
  return checks;
}

function thisMachine(d: DoctorFacts): DoctorCheck[] {
  const lt = d.local_tailscale;
  /**
   * The probe answered iff it reported a tailnet: `checkLocalTailscale` returns
   * a null one for every way of not finding out (wedged daemon, timeout,
   * throw). Without that distinction an unanswered probe and a tailnet with
   * HTTPS off look identical, and the second is a real fault while the first is
   * simply unknown.
   */
  const answered = lt.ok || lt.tailnet !== null;
  return [
    {
      id: "local-tailscale",
      label: "this machine's tailscale",
      state: lt.ok ? "ok" : "bad",
      detail: lt.detail,
    },
    {
      id: "https-certificates",
      label: "HTTPS certificates",
      state: !answered ? "skip" : lt.https_certificates ? "ok" : "bad",
      detail: !answered
        ? "unchecked — this machine's tailscale did not answer"
        : lt.https_certificates
          ? "on for this tailnet — `tailscale serve --https=443` can get a certificate"
          : "off for this tailnet — every agents.create will fail on the box, twenty minutes in",
    },
    {
      /**
       * `aws.client()` pins the frozen profile, so these change nothing — but
       * it ignores them silently, and an operator who exported them is owed the
       * sentence saying why they had no effect.
       */
      id: "env-overrides",
      label: "credential env vars",
      state: d.env_overrides.length === 0 ? "ok" : "warn",
      detail:
        d.env_overrides.length === 0
          ? "none set — the frozen profile is what every call uses"
          : `set and ignored: ${d.env_overrides.join(", ")}`,
    },
  ];
}

/** Every check `doctor` performed, grouped in the order an operator reads them. */
export function doctorChecks(d: DoctorFacts): DoctorCheckGroup[] {
  return [
    { title: "Account and fleet", checks: accountAndFleet(d) },
    { title: "Agents", checks: agents(d) },
    { title: "Network", checks: network(d) },
    { title: "Tailnet", checks: tailnet(d) },
    { title: "This machine", checks: thisMachine(d) },
  ];
}

/** The badge over the checklist: how many checks are in each state. */
export function checkTally(groups: DoctorCheckGroup[]): Record<CheckState, number> {
  const tally: Record<CheckState, number> = { ok: 0, warn: 0, bad: 0, info: 0, skip: 0 };
  for (const g of groups) for (const c of g.checks) tally[c.state] += 1;
  return tally;
}

/** The one-line summary beside the badge: "12 passed · 1 needs attention · 2 unchecked". */
export function tallyLine(tally: Record<CheckState, number>): string {
  const parts = [`${tally.ok} passed`];
  if (tally.bad > 0) parts.push(`${tally.bad} failed`);
  if (tally.warn > 0) parts.push(`${tally.warn} to look at`);
  if (tally.info > 0) parts.push(`${tally.info} informational`);
  if (tally.skip > 0) parts.push(`${tally.skip} unchecked`);
  return parts.join(" · ");
}
