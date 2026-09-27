/**
 * Pure derivations over a fleet snapshot: counts for the toolbar legend,
 * filter matching, and triage grouping. Split out of `state.tsx` (which also
 * carries the React context/hooks) so these can be unit tested without a DOM.
 */
import type { AgentView } from "../api/index.ts";
import { compareVersions, hostname, isBehind, isBusy, isOff, sizeSpec } from "./format.ts";

export interface Counts {
  total: number;
  ready: number;
  degraded: number;
  busy: number;
  stopped: number;
  unreachable: number;
  destroyed: number;
}

/**
 * `isOff` is true for both `stopped` and `destroyed` (they share a color), but
 * the dashboard treats them very differently — a destroyed agent is history,
 * not a machine you can start — so every bucket below tests this first.
 */
function isDestroyed(a: AgentView): boolean {
  return a.display_status === "destroyed";
}

/** The fleet minus its tombstones — what the dashboard shows by default. */
export function withoutDestroyed(agents: AgentView[]): AgentView[] {
  return agents.filter((a) => !isDestroyed(a));
}

/**
 * Deselect only when the *toggle* closes over a destroyed agent. Keying on the
 * agent's status alone would slam the drawer shut the moment a `destroy` op
 * wrote its final transition — which lands before the op's `done` event — so
 * the operator would lose the progress bar and any late failure at ~95%.
 */
export function shouldDeselect(
  prevShow: boolean,
  nextShow: boolean,
  selectedStatus: string | null,
): boolean {
  return prevShow && !nextShow && selectedStatus === "destroyed";
}

export function countsOf(agents: AgentView[]): Counts {
  const c: Counts = {
    // The headline is the fleet you are running: destroyed rows are history and
    // are carried by `destroyed` alone.
    total: 0,
    ready: 0,
    degraded: 0,
    busy: 0,
    stopped: 0,
    unreachable: 0,
    destroyed: 0,
  };
  for (const a of agents) {
    if (isDestroyed(a)) {
      c.destroyed += 1;
      continue;
    }
    c.total += 1;
    if (a.display_status === "ready") c.ready += 1;
    else if (a.display_status === "degraded") c.degraded += 1;
    else if (a.display_status === "unreachable") c.unreachable += 1;
    else if (isOff(a)) c.stopped += 1;
    else if (isBusy(a)) c.busy += 1;
  }
  return c;
}

/**
 * The empty-state line under an empty fleet view.
 *
 * `hiddenDestroyed` is the number of destroyed rows the toggle is hiding *that
 * match the current query* — so a search for a destroyed agent by name says
 * where it went instead of flatly denying it exists, which the fleet's own
 * history (§6.6) would contradict.
 */
export function emptyHint(opts: {
  /** Every row the fleet holds, destroyed included. */
  total: number;
  query: string;
  hiddenDestroyed: number;
}): string {
  if (opts.total === 0) return "no agents in this fleet · press n to create one";
  const q = opts.query.trim();
  const n = opts.hiddenDestroyed;
  if (n > 0) {
    const agents = `${n} destroyed agent${n === 1 ? "" : "s"}`;
    if (q) {
      return `nothing matches “${opts.query}” among live agents · ${agents} ${
        n === 1 ? "matches" : "match"
      } — use the toolbar to show them`;
    }
    return `${agents} hidden — use the toolbar to show them`;
  }
  return `nothing matches “${opts.query}”`;
}

/**
 * name · hostname · version · size · instance_type · status.
 *
 * Both spellings of the hostname, because after a recreate they differ: an
 * operator who searches the name they gave the agent must still find it, and
 * one who pastes the `<name>-2` they saw in the Tailscale console must too.
 */
export function filterAgents(
  agents: AgentView[],
  query: string,
  tailnet?: string,
  fleetId?: string | null,
): AgentView[] {
  const q = query.trim().toLowerCase();
  if (!q) return agents;
  return agents.filter((a) =>
    [
      a.name,
      hostname(a.name, tailnet, undefined, fleetId),
      a.tailscale_dns_name ?? "",
      a.hermes_version,
      a.size,
      a.instance_type,
      a.display_status,
      sizeSpec(a.size).glyph,
    ]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/* ── sorting (the table's column headers) ────────────────────────────────── */

/**
 * The six columns worth ordering by. Health, Tailscale and Data volume are
 * deliberately absent: the first two are not scalars an operator ranks agents
 * by, and the volume cell is a state word, not a magnitude.
 */
export type SortKey = "name" | "status" | "cpu" | "mem" | "version" | "uptime";
export type SortDir = "asc" | "desc";
export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/**
 * The order statuses sort in when the Status column is the key: worst first.
 * "Alphabetical" would put `bootstrapping` above `error`, which is precisely
 * backwards from why anyone sorts a fleet by status.
 */
const STATUS_RANK: Record<string, number> = {
  error: 0,
  unreachable: 1,
  degraded: 2,
  creating: 3,
  bootstrapping: 4,
  stopping: 5,
  destroying: 6,
  ready: 7,
  stopped: 8,
  destroyed: 9,
};

/**
 * A missing metric is not a zero. An agent with no CPU sample has not been
 * measured at 0%, and sorting it as if it had would bury the running agents an
 * operator sorted the column to find — so unmeasured rows go last in both
 * directions, the way a spreadsheet keeps blanks at the bottom.
 */
function compareMaybeNumber(a: number | null | undefined, b: number | null | undefined): number {
  const av = a ?? null;
  const bv = b ?? null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return av - bv;
}

/** Uptime as a number: age since `created_at`, and `null` for anything not running. */
function uptimeMs(a: AgentView, now: number): number | null {
  if (isOff(a) || a.last_heartbeat === null || a.last_heartbeat === undefined) return null;
  const created = Date.parse(a.created_at);
  return Number.isNaN(created) ? null : now - created;
}

/**
 * Whether this column has no value at all for this agent — a stopped box has no
 * CPU sample and no uptime. Kept separate from the comparator because it must
 * *not* flip with the sort direction: descending CPU should open on the busiest
 * agent, not on a screen of dashes.
 */
export function isUnmeasured(a: AgentView, key: SortKey, now: number): boolean {
  switch (key) {
    case "cpu":
      return isOff(a) || (a.metrics?.cpu_pct ?? null) === null;
    case "mem":
      return isOff(a) || (a.metrics?.mem_pct ?? null) === null;
    case "uptime":
      return uptimeMs(a, now) === null;
    default:
      return false;
  }
}

/**
 * The comparator behind one column, before direction is applied. Exported for
 * its own tests: this is the whole of what "click to sort" means, and it is
 * easier to be wrong about here than to see on screen.
 */
export function compareAgents(a: AgentView, b: AgentView, key: SortKey, now: number): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "status": {
      const d = (STATUS_RANK[a.display_status] ?? 50) - (STATUS_RANK[b.display_status] ?? 50);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    }
    case "cpu":
      return compareMaybeNumber(
        isOff(a) ? null : a.metrics?.cpu_pct,
        isOff(b) ? null : b.metrics?.cpu_pct,
      );
    case "mem":
      return compareMaybeNumber(
        isOff(a) ? null : a.metrics?.mem_pct,
        isOff(b) ? null : b.metrics?.mem_pct,
      );
    case "version":
      return compareVersions(a.hermes_version, b.hermes_version);
    case "uptime":
      return compareMaybeNumber(uptimeMs(a, now), uptimeMs(b, now));
  }
}

/**
 * A stable sort in the requested direction, with the name as the tie-break so
 * a fleet where every agent is `ready` on the same version does not reshuffle
 * itself on every tick as the stream re-emits the rows.
 *
 * `null` is the server's own order — the state the board is in before anyone
 * has clicked a header, and the one an operator gets back by clicking the same
 * header a third time.
 */
export function sortAgents(agents: AgentView[], sort: Sort | null, now: number): AgentView[] {
  if (sort === null) return agents;
  const sign = sort.dir === "asc" ? 1 : -1;
  const { key } = sort;
  return [...agents].sort((a, b) => {
    // Applied before the sign, so "unmeasured last" survives the flip.
    const aGone = isUnmeasured(a, key, now);
    const bGone = isUnmeasured(b, key, now);
    if (aGone !== bGone) return aGone ? 1 : -1;
    const primary = compareAgents(a, b, key, now);
    if (primary !== 0) return primary * sign;
    return a.name.localeCompare(b.name);
  });
}

/**
 * What a click on a column header does: a new column starts ascending, the
 * current one flips, and a third click on the same column drops back to the
 * server's order rather than trapping the operator in a sort they cannot undo.
 */
export function nextSort(current: Sort | null, key: SortKey): Sort | null {
  if (current === null || current.key !== key) return { key, dir: "asc" };
  if (current.dir === "asc") return { key, dir: "desc" };
  return null;
}

/** How each sortable column reads in prose, for the chip that says what is in force. */
const SORT_LABELS: Record<SortKey, string> = {
  name: "name",
  status: "status",
  cpu: "CPU",
  mem: "memory",
  version: "version",
  uptime: "uptime",
};

/**
 * What the toolbar says about the order the fleet is in.
 *
 * The order is chosen on the table's headers but applied to all three layouts,
 * so on the board and in triage it was previously invisible *and* unresettable:
 * an operator who sorted by CPU, switched to the board and forgot would be
 * looking at a deliberately reordered fleet with nothing on screen saying so.
 * `null` when the fleet is in the server's own order and there is nothing to
 * say.
 */
export function sortLabel(sort: Sort | null): string | null {
  if (sort === null) return null;
  return `${SORT_LABELS[sort.key]} ${sort.dir === "asc" ? "↑" : "↓"}`;
}

/** The `aria-sort` value for one header, given the sort in force. */
export function ariaSort(current: Sort | null, key: SortKey): "ascending" | "descending" | "none" {
  if (current === null || current.key !== key) return "none";
  return current.dir === "asc" ? "ascending" : "descending";
}

export interface TriageGroup {
  key: string;
  label: string;
  color: string;
  hint: string;
  items: AgentView[];
}

export function triageGroups(
  agents: AgentView[],
  latest: string | null,
  showDestroyed = false,
): TriageGroup[] {
  const attention = agents.filter(
    (a) =>
      a.display_status === "degraded" ||
      a.display_status === "unreachable" ||
      a.display_status === "error" ||
      (!isOff(a) && !isBusy(a) && isBehind(a, latest)),
  );
  const progress = agents.filter((a) => isBusy(a));
  const healthy = agents.filter((a) => a.display_status === "ready" && !isBehind(a, latest));
  const stopped = agents.filter((a) => isOff(a) && !isDestroyed(a));
  const destroyed = agents.filter(isDestroyed);
  const groups: TriageGroup[] = [
    {
      key: "attention",
      label: "attention",
      color: "var(--warn)",
      hint: latest ? `Degraded, unreachable, or running behind ${latest}.` : "Degraded or unreachable.",
      items: attention,
    },
    {
      key: "progress",
      label: "in progress",
      color: "var(--acc)",
      hint: "Long operations streaming from the engine.",
      items: progress,
    },
    {
      key: "healthy",
      label: "healthy",
      color: "var(--ok)",
      hint: "Current version, all checks green.",
      items: healthy,
    },
    {
      key: "stopped",
      label: "stopped",
      color: "var(--fg3)",
      hint: "Instance stopped; data volume retained.",
      items: stopped,
    },
  ];
  // Last, and only while the toggle is on — where it behaves like every other
  // group, `— none —` and all. Gating on `destroyed.length` instead would make
  // the group appear and vanish under a live fleet as rows come and go.
  if (showDestroyed) {
    groups.push({
      key: "destroyed",
      label: "destroyed",
      color: "var(--fg3)",
      hint: "Record kept; instance gone, data volume retained.",
      items: destroyed,
    });
  }
  return groups;
}
