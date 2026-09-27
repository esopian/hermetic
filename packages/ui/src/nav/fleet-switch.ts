/**
 * The fleet switcher's pure rules. DOM-free and React-free, the same split
 * `settings-nav.ts` and `volume-logic.ts` keep, so what a fleet entry means —
 * sortable order, whether it can be switched to, its badge, its confirm copy —
 * is testable without a browser or a server round trip.
 *
 * `FleetListEntry` mirrors the server's per-fleet shape by hand: the UI may
 * never import `@hermetic/core` (boundaries test), so every core type the UI
 * needs is copied here rather than imported.
 */

export interface FleetListEntry {
  /** The optional display alias (§4.6). `null` means the fleet shows as its id. */
  name: string | null;
  fleet_id: string | null;
  account_id: string | null;
  region: string | null;
  local: boolean;
  registered: boolean;
  default: boolean;
  current: boolean;
  status: "active" | "tearing_down" | "torn_down" | null;
  foundation_version: number | null;
  update_available: boolean;
  updated_at: string | null;
}

/**
 * The switcher's list order: the fleet already open first (nothing to switch
 * to), then the default (the one most operators reach for next), then torn
 * down last (nothing to do there but look), otherwise alphabetical. `sort` is
 * not stable across engines for unequal comparator results in the general
 * case, but here ties fall through to the label comparison, so the result is
 * deterministic and the input array is left untouched.
 */
/**
 * What a row is *called* on screen: its alias, or its `fleet_id` when it has
 * none (§4.6). Never blank and never "unnamed" — a fleet without an alias is
 * not anonymous, its id is simply the name it goes by.
 */
export function fleetLabel(f: FleetListEntry): string {
  return f.name ?? f.fleet_id ?? "—";
}

export function sortFleets(fleets: FleetListEntry[]): FleetListEntry[] {
  const rank = (f: FleetListEntry): number => {
    if (f.current) return 0;
    if (f.status === "torn_down") return 3;
    if (f.default) return 1;
    return 2;
  };
  return [...fleets].sort((a, b) => rank(a) - rank(b) || fleetLabel(a).localeCompare(fleetLabel(b)));
}

/**
 * Whether a fleet can be switched to, and — when it cannot — the one-line
 * reason the switcher shows instead of a disabled control with no
 * explanation. Only a fleet frozen in *this home's* local db can be switched
 * to at all: switching means pointing the same portal process at a different
 * local config, not reaching across accounts.
 */
export function switchability(f: FleetListEntry): { can: boolean; reason: string | null } {
  if (f.current) return { can: false, reason: "current fleet" };
  if (!f.local) {
    return {
      can: false,
      reason: `not frozen here — run \`hermetic init --attach --fleet ${f.fleet_id ?? "<fleet-id>"}\``,
    };
  }
  if (f.status === "torn_down") return { can: false, reason: "torn down" };
  return { can: true, reason: null };
}

/**
 * Whether `fleets.use` would accept this fleet as the laptop's default, and so
 * whether the row may offer "make default" at all. The rule is core's, not the
 * switcher's: `fleets.use` is local-only and refuses `NOT_FOUND` for a fleet
 * that is not frozen here, and a torn-down fleet is a history entry rather than
 * something a bare `hermetic agent ps` could ever mean. Offering the action and
 * then reporting the refusal would be the UI asking the server a question it
 * already knows the answer to.
 */
export function defaultable(f: FleetListEntry): boolean {
  return f.local && f.status !== "torn_down" && !f.default;
}

/**
 * The one badge a fleet row carries. Order matters: a torn-down fleet is
 * always muted regardless of its other flags (there is nothing left to warn
 * about), a fleet mid-teardown is next because it is the one thing happening
 * right now, then a fleet this build is newer than. Only a fleet with nothing
 * else to say gets its plain foundation version.
 */
export function fleetBadge(f: FleetListEntry): { kind: "ok" | "warn" | "muted"; label: string } {
  if (f.status === "torn_down") return { kind: "muted", label: "torn down" };
  if (f.status === "tearing_down") return { kind: "warn", label: "tearing down" };
  if (f.update_available) return { kind: "warn", label: "update available" };
  if (!f.registered) return { kind: "muted", label: "unregistered" };
  return { kind: "ok", label: f.foundation_version === null ? "—" : `v${f.foundation_version}` };
}

/**
 * Names of the other fleets that need a foundation update, for the
 * Foundation section's "N other fleets need a foundation update" line. Only
 * `active` fleets qualify — a fleet mid-teardown or gone is not a fleet an
 * operator can update, so counting it would make the line claim work that is
 * not actually available.
 */
export function otherFleetsNeedingUpdate(fleets: FleetListEntry[]): string[] {
  return fleets
    .filter((f) => !f.current && f.update_available && f.status === "active")
    .map(fleetLabel)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The switch confirmation's one line. Named "from" only when there is a
 * current fleet to name — the wizard's pre-init screens can reach this with
 * no fleet open yet, and "Switch from null" would be a bug wearing a string.
 */
export function confirmSwitchText(from: string | null, to: FleetListEntry): string {
  const region = to.region === null ? "" : ` (${to.region})`;
  return from === null
    ? `Switch to ${fleetLabel(to)}${region}?`
    : `Switch from ${from} to ${fleetLabel(to)}${region}?`;
}
