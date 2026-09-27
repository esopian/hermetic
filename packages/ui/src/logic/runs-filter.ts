/**
 * Settings → Runs is an audit log, and this module is its narrowing rules.
 *
 * The local `runs` table (§4.6) is every command this laptop ran — from the CLI
 * and from the portal both. Once a home can freeze more than one fleet (§4.8),
 * an unfiltered list interleaves several fleets' histories and stops being an
 * audit trail: "what did I do to *this* fleet, and did it work" is no longer a
 * question the screen answers. So the default is scoped to the open fleet, and
 * widening it is a deliberate act the operator can see they took.
 *
 * Filtering happens here, in the browser, over a window of rows the section
 * already fetched — not as query parameters on `runs.list`. The run log is a
 * small local SQLite table, the whole window is one read, and keeping the rules
 * in one pure module means they can be tested without a server and without a
 * DOM. `RunsListInput` keeps the shape core already gives it.
 *
 * Pure and DOM-free on purpose, like `settings-nav.ts` and `volume-logic.ts`.
 */

/**
 * The parts of a `Run` the filter reads.
 *
 * Structural rather than `api.ts`'s `Run` so this module can be tested without
 * a server and without the generated client, and so an older server that
 * returns fewer of these fields still builds.
 */
export interface RunLike {
  command: string;
  args: string[];
  agent: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  /** The `fleet_id` this run was against, or null when it resolved none. */
  fleet?: string | null;
  /** The display alias that fleet answered to at the time (§4.8). */
  fleet_name?: string | null;
}

/**
 * How a run ended.
 *
 * `unfinished` is deliberately not called "running": a row is opened before its
 * command starts and closed when it exits, so a process that was killed — a
 * portal that died mid-op, a `^C`, a laptop that slept — leaves `exit_code`
 * null forever and is indistinguishable from one still in flight. Naming it
 * "running" would assert something the row does not know. Being able to *find*
 * those rows is half of what an audit log is for, so they get their own filter
 * rather than being folded into either success or failure.
 */
export type RunOutcome = "ok" | "failed" | "unfinished";

export function runOutcome(run: RunLike): RunOutcome {
  if (run.exit_code === null) return "unfinished";
  return run.exit_code === 0 ? "ok" : "failed";
}

export const RUN_OUTCOMES = [
  { id: "all", label: "All" },
  { id: "ok", label: "Succeeded" },
  { id: "failed", label: "Failed" },
  { id: "unfinished", label: "Unfinished" },
] as const satisfies ReadonlyArray<{ id: RunOutcome | "all"; label: string }>;

/**
 * The fleet select's "don't scope this" option.
 *
 * A sentinel rather than `null` because it is a *choice* the operator made and
 * has to be able to see they made — `null` is also what an uninitialized home's
 * current fleet is, and the two must not collapse into the same state.
 */
export const ALL_FLEETS = "*";

/**
 * The bucket for rows that name no fleet: a command that failed before the
 * target was resolved, and every row written before the heads recorded one.
 *
 * Its own option rather than an absence, for the reason the rows are no longer
 * folded onto the open fleet: "I cannot tell you what this was against" is an
 * answer, and one an operator auditing a fleet needs to be able to ask for.
 * Neither sentinel is a legal `fleet_id` (Crockford base32, eight characters),
 * so neither can collide with a real one.
 */
export const UNKNOWN_FLEET = "?";

/** How a row with no fleet is labelled wherever one is shown. */
export const UNKNOWN_FLEET_LABEL = "unknown";

/** Time windows, coarse on purpose: an audit log is scanned, not queried. */
export const RUN_RANGES = [
  { id: "all", label: "All time", ms: null },
  { id: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { id: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const satisfies ReadonlyArray<{ id: string; label: string; ms: number | null }>;

export type RunRange = (typeof RUN_RANGES)[number]["id"];

export interface RunsFilter {
  /** A `fleet_id`, or one of the two sentinels: `ALL_FLEETS`, `UNKNOWN_FLEET`. */
  fleet: string;
  outcome: RunOutcome | "all";
  /** Free text, matched against the command line, the agent and the fleet. */
  query: string;
  range: RunRange;
}

/**
 * Where the section starts: this fleet, everything else open. `current` is a
 * `fleet_id`, because that is what the rows are keyed on.
 *
 * `ALL_FLEETS` when the home has no current fleet — before `init`, or on a
 * server too old to report one. Scoping to a fleet nobody named would hide
 * every row behind a filter the operator cannot satisfy.
 */
export function defaultRunsFilter(current: string | null): RunsFilter {
  return { fleet: current ?? ALL_FLEETS, outcome: "all", query: "", range: "all" };
}

/**
 * Which fleet a row belongs to: its own `fleet_id`, or null for none.
 *
 * Null means the run never resolved a target — it failed before core chose a
 * fleet, or it was recorded by a build that did not write one. It does **not**
 * mean "the fleet you have open". Reading it that way is what this rule
 * replaced: every unattributed row in the log silently became part of whichever
 * fleet the operator happened to be looking at, so the same row read as
 * `main`'s history on one screen and `staging`'s on the next. An audit log that
 * re-attributes itself per viewer is not an audit log.
 *
 * Attribution is on `fleet_id` alone, never on the alias: a label can move to
 * another fleet, and a row is about the fleet it ran against (§4.8).
 */
export function runFleet(run: RunLike): string | null {
  return run.fleet ?? null;
}

/**
 * What a row's fleet is *called* on screen: the alias recorded with the run,
 * falling back to the id it is keyed on, and to "unknown" for a row that names
 * neither. The alias is display only — every head renders `alias ?? fleet_id`
 * and compares on `fleet_id` (§4.6).
 */
export function runFleetLabel(run: RunLike): string {
  return run.fleet_name ?? run.fleet ?? UNKNOWN_FLEET_LABEL;
}

/** The command line as one string — the thing the table prints and search matches. */
export function runLabel(run: RunLike): string {
  return run.args.length > 0 ? `${run.command} ${run.args.join(" ")}` : run.command;
}

/** One entry of the fleet select: what it filters on, and what it reads as. */
export interface FleetOption {
  /** A `fleet_id`, or `UNKNOWN_FLEET`. What `RunsFilter.fleet` is compared to. */
  id: string;
  /** The alias these rows carried, else the id itself. */
  label: string;
}

/**
 * The fleet select's options: every fleet these rows mention, plus the current
 * one even when it has no runs yet — a freshly switched-to fleet is exactly
 * when an operator wants to confirm nothing has been done to it.
 *
 * Current first, then alphabetical by id, so the default selection is the top
 * entry. The unattributed bucket is last, and appears **only** when some row is
 * actually unattributed: an option that would always match nothing is a control
 * that teaches the operator to distrust the ones beside it.
 *
 * Keyed on `fleet_id` throughout; the label is whatever the most recent row
 * called that fleet, which is the alias as it stood when the command ran.
 */
export function fleetOptions(
  runs: readonly RunLike[],
  current: string | null,
  currentLabel?: string | null,
): FleetOption[] {
  const labels = new Map<string, string | null>();
  if (current) labels.set(current, currentLabel ?? null);
  // Newest first, so the first alias seen for a fleet is the freshest one.
  for (const run of runs) {
    const fleet = runFleet(run);
    if (fleet === null) continue;
    const seen = labels.get(fleet) ?? null;
    if (!labels.has(fleet) || seen === null) labels.set(fleet, run.fleet_name ?? seen);
  }
  const option = (id: string): FleetOption => ({ id, label: labels.get(id) ?? id });
  const rest = [...labels.keys()].filter((id) => id !== current).sort();
  const ordered = (current && labels.has(current) ? [current, ...rest] : rest).map(option);
  if (runs.some((run) => runFleet(run) === null)) {
    ordered.push({ id: UNKNOWN_FLEET, label: UNKNOWN_FLEET_LABEL });
  }
  return ordered;
}

function withinRange(run: RunLike, range: RunRange, now: number): boolean {
  const window = RUN_RANGES.find((r) => r.id === range)?.ms ?? null;
  if (window === null) return true;
  const started = Date.parse(run.started_at);
  // An unparseable timestamp is kept rather than hidden: a row the UI cannot
  // place in time is a row worth seeing, not one worth silently dropping.
  if (Number.isNaN(started)) return true;
  return now - started <= window;
}

/**
 * Free text over what the row *says*: the command line, the agent, the fleet
 * it was against by id, and the alias it carried at the time. Both spellings of
 * the fleet, because an operator searching an audit log types whichever one
 * they remember.
 */
function matchesQuery(run: RunLike, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const fleet = `${runFleet(run) ?? ""} ${run.fleet_name ?? ""}`;
  return `${runLabel(run)} ${run.agent ?? ""} ${fleet}`.toLowerCase().includes(needle);
}

/** Whether a row is in the selected fleet scope, comparing `fleet_id` only. */
function inFleetScope(run: RunLike, scope: string): boolean {
  if (scope === ALL_FLEETS) return true;
  const fleet = runFleet(run);
  if (scope === UNKNOWN_FLEET) return fleet === null;
  return fleet === scope;
}

/**
 * `current` is deliberately not a parameter. Whether a row belongs to the
 * selected scope is a property of the row and the filter, and nothing else —
 * the moment the fleet the operator is looking at can reach this decision, the
 * log starts answering differently depending on who reads it (§4.6).
 */
export function matchesRunsFilter(run: RunLike, filter: RunsFilter, now: number): boolean {
  if (!inFleetScope(run, filter.fleet)) return false;
  if (filter.outcome !== "all" && runOutcome(run) !== filter.outcome) return false;
  if (!withinRange(run, filter.range, now)) return false;
  return matchesQuery(run, filter.query);
}

export function filterRuns<T extends RunLike>(
  runs: readonly T[],
  filter: RunsFilter,
  now: number,
): T[] {
  return runs.filter((run) => matchesRunsFilter(run, filter, now));
}

/**
 * Whether anything is narrowing the list beyond the fleet scope it opened with.
 *
 * The fleet select is excluded on purpose: it starts scoped, so counting it
 * would mean the section always claims a filter is on. What this answers is
 * "does a Clear button have anything to do".
 */
export function hasActiveRunsFilter(filter: RunsFilter, current: string | null): boolean {
  const base = defaultRunsFilter(current);
  return (
    filter.fleet !== base.fleet ||
    filter.outcome !== "all" ||
    filter.range !== "all" ||
    filter.query.trim() !== ""
  );
}

/**
 * The line under the table: what is being shown, and out of what.
 *
 * It names the fleet whenever the list is scoped, because the two expensive
 * misreadings of an audit log are both about scope — thinking you are looking
 * at everything when you are looking at one fleet, and thinking you are looking
 * at the fleet you are *on* when you are looking at another one. The second
 * gets said outright: reading staging's history while the portal is pointed at
 * main is a fine thing to do and a terrible thing to do by accident.
 *
 * `label` is what the scoped fleet is *called* — the alias, when it has one.
 * The filter itself holds a `fleet_id`, which is what the rows are compared on,
 * but a line an operator reads should say what the switcher above it says.
 */
export function describeRunsFilter(
  shown: number,
  total: number,
  filter: RunsFilter,
  current: string | null,
  label?: string | null,
): string {
  const elsewhere = current !== null && filter.fleet !== current;
  const scope =
    filter.fleet === ALL_FLEETS
      ? "all fleets"
      : filter.fleet === UNKNOWN_FLEET
        ? "no fleet recorded"
        : `fleet ${label ?? filter.fleet}${elsewhere ? " · not the fleet you are on" : ""}`;
  if (total === 0) return `no runs recorded · ${scope}`;
  if (shown === total) return `${total} run${total === 1 ? "" : "s"} · ${scope}`;
  return `${shown} of ${total} runs · ${scope}`;
}
