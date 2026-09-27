/**
 * §5's fleet network mode, as the rules the Foundation section and the
 * re-network drawer read — pure, DOM-free, and testable without mounting React.
 *
 * Same reason `foundation-logic.ts` and `doctor-logic.ts` exist: the wording of
 * "this fleet has never recorded a mode" is the part that matters, and it should
 * be assertable without a drawer around it.
 *
 * The one rule every function here keeps: a missing mode is never rendered as
 * `public`. A fleet created with `--network nat` before the field existed
 * records nothing, and reading absence as the default would state, in the one
 * place an operator goes to check, a fact nobody checked.
 */

/** The two modes. Spelled here so this module needs no `hc` client. */
export type NetworkModeName = "public" | "nat";

/**
 * `NetworkReport` (core `schema/network.ts`), narrowed to what these rules
 * read. `api.ts`'s inferred `NetworkReport` is assignable to it.
 */
export interface NetworkFacts {
  mode: NetworkModeName | null;
  stack_mode: NetworkModeName | null;
  consistent: boolean;
  egress_ip: string | null;
  nat: {
    instance_id: string | null;
    instance_state: string | null;
    egress_ip: string | null;
    route_state: "active" | "blackhole" | null;
  } | null;
  agents: Array<{ name: string; placement: "matches" | "drifted" | "unknown" }>;
  drifted: number;
}

/**
 * The `network mode` row in the Foundation table. `unrecorded` is its own
 * state, with the hint saying what fixes it — the v6 migration runs inside
 * `foundation update` and back-fills the cache from the stack's own parameter.
 */
export function networkModeLine(mode: NetworkModeName | null | undefined): {
  text: string;
  unrecorded: boolean;
} {
  if (mode === "public")
    return { text: "public — every agent has its own public IP", unrecorded: false };
  if (mode === "nat") {
    return { text: "nat (fck-nat) — agents are in private subnets behind one NAT", unrecorded: false };
  }
  return {
    text: "unrecorded — this fleet predates the field; run `hermetic foundation update` to back-fill it from the stack",
    unrecorded: true,
  };
}

/** The mode a re-network would move to: the other one. Null when nobody can say which. */
export function renetworkTarget(stackMode: NetworkModeName | null | undefined): NetworkModeName | null {
  if (stackMode === "public") return "nat";
  if (stackMode === "nat") return "public";
  return null;
}

/**
 * The compact status block under the table: the facts a `nat` fleet's operator
 * is actually asking for, and nothing on a `public` one that has no NAT box to
 * report. Each entry is a label and a value so the panel lays them out as rows
 * rather than a sentence that wraps badly.
 */
export function networkFactRows(report: NetworkFacts): Array<{ k: string; v: string; bad: boolean }> {
  const rows: Array<{ k: string; v: string; bad: boolean }> = [];
  if (!report.consistent) {
    rows.push({
      k: "stack says",
      v: `${report.stack_mode ?? "unknown"} — CloudFormation is authoritative and the _fleet cache disagrees`,
      bad: true,
    });
  }
  if (report.stack_mode === "nat") {
    const nat = report.nat;
    rows.push({ k: "egress ip", v: report.egress_ip ?? nat?.egress_ip ?? "—", bad: false });
    rows.push({
      k: "nat instance",
      v:
        nat === null
          ? "not readable — the appliance could not be described"
          : `${nat.instance_id ?? "—"} · ${nat.instance_state ?? "no state"}`,
      bad: nat === null || nat.instance_state !== "running",
    });
    rows.push({
      k: "private route",
      v:
        nat?.route_state === null || nat === null
          ? "unknown"
          : nat.route_state === "blackhole"
            ? "blackhole — the fleet has no egress at all"
            : "active",
      bad: nat?.route_state === "blackhole",
    });
  }
  rows.push({
    k: "agent placement",
    v:
      report.drifted === 0
        ? `all ${report.agents.length} agent(s) on this fleet's subnets`
        : `${report.drifted} of ${report.agents.length} left behind on the old subnets — recreate each`,
    bad: report.drifted > 0,
  });
  return rows;
}

/** The agents a mode change has stranded, by name — the list `agent recreate` works through. */
export function driftedAgents(report: NetworkFacts): string[] {
  return report.agents.filter((a) => a.placement === "drifted").map((a) => a.name);
}

/**
 * Whether the Foundation section may offer a re-network at all, and the line it
 * says when it may not. A foundation update in flight holds the `_fleet` lock,
 * which is the same lock `apply` takes — offering the button would only produce
 * a `LOCKED` the operator could have been told about first.
 */
export function renetworkAvailable(input: { report: NetworkFacts | null; updateInProgress: boolean }): {
  allowed: boolean;
  reason: string;
} {
  if (input.updateInProgress) {
    return {
      allowed: false,
      reason: "a foundation update holds the _fleet lock — wait for it to finish",
    };
  }
  if (input.report === null) return { allowed: false, reason: "reading the network status…" };
  if (input.report.stack_mode === null) {
    return {
      allowed: false,
      reason:
        "the foundation stack carries no Network parameter, so hermetic cannot tell which mode this fleet is in — run a foundation update first",
    };
  }
  return { allowed: true, reason: `change to ${renetworkTarget(input.report.stack_mode)}` };
}

/**
 * What the drawer's Apply button may do. The acknowledgement is a checkbox
 * rather than a typed word: this is not the teardown ceremony — it destroys no
 * data — but it is the most destructive op short of one, and the sentence being
 * acknowledged (stranded agents are recreated by hand) is the part operators
 * are most likely to skim.
 */
export function applyGate(input: {
  plan: { steps: unknown[] } | null;
  acknowledged: boolean;
  starting: boolean;
}): { allowed: boolean; reason: string } {
  if (input.plan === null) return { allowed: false, reason: "reading the network plan…" };
  if (!input.acknowledged) {
    return { allowed: false, reason: "acknowledge the consequences to enable Apply" };
  }
  if (input.starting) return { allowed: false, reason: "applying…" };
  return { allowed: true, reason: `${input.plan.steps.length} steps · 1 stack update` };
}
