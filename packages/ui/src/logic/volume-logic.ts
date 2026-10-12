/**
 * Pure derivations over the volume inventory (§9). DOM-free and React-free, the
 * same split `selectors.ts` has, so the two rules that decide what the *fleet*
 * shows can be unit tested without rendering anything.
 *
 * Core does the grouping (`volumes.ts`) — that is a join over EC2 and DynamoDB
 * and no head may recompute it. What lives here is presentation: which of those
 * groups reaches the fleet board at all, how many, and in what order.
 */
import type { AgentView, VolumeGroup, VolumeView } from "../api/index.ts";

/** Lane order in the Volumes view: what nothing is reading, first. */
export const VOLUME_LANES: ReadonlyArray<{
  group: VolumeGroup;
  title: string;
  hint: string;
  color: string;
}> = [
  {
    group: "no_agent",
    title: "No agent",
    hint: "Memory whose agent is gone. Put a new agent on one, or delete it. These are the tombstones on the board.",
    color: "var(--acc)",
  },
  {
    group: "ambiguous",
    title: "Ambiguous",
    hint: "Two volumes carry the same agent tag and hermetic cannot tell which one holds the memory. It refuses to guess (§1). Read-only until a human decides.",
    color: "var(--bad)",
  },
  {
    group: "detached",
    title: "Detached · agent exists",
    hint: "Not free — an agent still owns this volume and the fleet is showing it as a problem there. Nothing to create onto.",
    color: "var(--warn)",
  },
  {
    group: "attached",
    title: "Attached",
    hint: "Live agent memory. Nothing to do here — the agent owns it.",
    color: "var(--ok)",
  },
  {
    group: "unmanaged",
    title: "Not this fleet",
    hint: "Unattached volumes in the fleet's AZs that hermetic did not create. Listed because they bill; read-only because guessing what they hold is not allowed.",
    color: "var(--fg3)",
  },
];

/**
 * How many tombstones the board will carry before it collapses the rest into a
 * single card. The board is a list of agents; a fleet of forty agents and
 * twenty loose volumes must still read as a fleet.
 */
export const TOMBSTONE_CAP = 4;

/**
 * The volumes that appear on the *fleet* board as tombstones.
 *
 * Three rules, and each one is a claim the UI would otherwise be making without
 * evidence:
 *
 * - only `no_agent`: an ambiguous volume might be an agent's memory, but a
 *   tombstone says *which* agent, and hermetic does not know;
 * - never one a live agent on screen owns: that agent's own card carries its
 *   volume, and a tombstone beside it would be the same thing rendered twice.
 *   A destroy deletes the row (§6.7), so a destroyed agent's kept volume has no
 *   card of its own and is always drawn here;
 * - newest-free first, so the volume most likely to still matter is the one
 *   that survives the cap.
 */
export function tombstones(volumes: readonly VolumeView[], agents: readonly AgentView[]): VolumeView[] {
  const onScreen = new Set(agents.filter((a) => a.display_status !== "destroyed").map((a) => a.name));
  return volumes
    .filter((v) => v.group === "no_agent")
    .filter((v) => v.agent === null || !onScreen.has(v.agent))
    .sort((a, b) => (a.free_for_ms ?? 0) - (b.free_for_ms ?? 0));
}

/**
 * The fleet's text filter, applied to volumes too. Without this a query that
 * matches no agent would empty the board of cards and leave every tombstone
 * standing — the filter is meant to narrow the fleet, not to reveal things.
 */
export function filterVolumes(volumes: readonly VolumeView[], query: string): VolumeView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...volumes];
  return volumes.filter((v) =>
    [v.volume_id, v.agent ?? "", v.availability_zone ?? "", `${v.size_gib}`].some((f) =>
      f.toLowerCase().includes(q),
    ),
  );
}

export interface BoardVolumes {
  shown: VolumeView[];
  /** Volumes the cap held back, summarised by the `+ N more` card. */
  overflow: { count: number; gib: number; monthly: number };
  /** Loose volumes the fleet deliberately never shows: strays and ambiguous pairs. */
  hiddenElsewhere: number;
}

export function boardVolumes(
  volumes: readonly VolumeView[],
  agents: readonly AgentView[],
): BoardVolumes {
  const all = tombstones(volumes, agents);
  const shown = all.slice(0, TOMBSTONE_CAP);
  const rest = all.slice(TOMBSTONE_CAP);
  return {
    shown,
    overflow: {
      count: rest.length,
      gib: rest.reduce((n, v) => n + v.size_gib, 0),
      monthly: rest.reduce((n, v) => n + v.monthly_cost_usd, 0),
    },
    hiddenElsewhere: volumes.filter((v) => v.group === "ambiguous" || v.group === "unmanaged").length,
  };
}

/** The volume an agent row owns, for the Data volume line on its card. */
export function volumeOf(agent: AgentView, volumes: readonly VolumeView[]): VolumeView | null {
  const id = agent.volume_id;
  if (!id) return null;
  return volumes.find((v) => v.volume_id === id) ?? null;
}

export interface VolumeLine {
  label: string;
  state: string;
  color: string;
  /**
   * The whole id, not the elided `label`. A card has room for about half of a
   * real 21-character EBS id, and the half it shows is the half that is the
   * same on every volume in the account — so what is drawn is a label and this
   * is the value, for the tooltip and the clipboard.
   */
  id: string;
  /** The rest of what the cell knows, for that tooltip: `100 GiB · attached`. */
  note: string;
}

/**
 * The Data volume line every agent card and row carries. It reads from the
 * *inventory* when there is one and falls back to the agent row alone — the
 * fleet must still render before the first volume read lands, and it must not
 * claim `attached` on the strength of a row that only records an id.
 */
export function volumeLine(agent: AgentView, volume: VolumeView | null): VolumeLine | null {
  if (!agent.volume_id) return null;
  // Real EBS ids are 21 characters and the card has room for about half of
  // one; a shorter id (the fixture's, a test's) is shown whole rather than
  // being given an ellipsis it has not earned.
  const short = agent.volume_id.length > 13 ? `${agent.volume_id.slice(0, 12)}…` : agent.volume_id;
  const label = `${short} · ${agent.volume_gib} GiB`;
  const id = agent.volume_id;
  const gib = `${agent.volume_gib} GiB`;
  if (!volume) return { label, state: "", color: "var(--fg3)", id, note: gib };
  if (volume.attached) {
    return { label, state: "attached", color: "var(--ok)", id, note: `${gib} · attached` };
  }
  return { label, state: "detached", color: "var(--warn)", id, note: `${gib} · detached` };
}

/** `3d 04h`, or `—` when nothing has ever attached it. */
export function freeFor(v: VolumeView, fmt: (ms: number) => string): string {
  if (v.attached) return "—";
  return v.free_for_ms === null ? "—" : fmt(v.free_for_ms);
}

/**
 * The next free agent name for a volume, from the agent its tag names.
 * A destroy releases the name (row deleted, tombstone kept; §6.7), so a volume
 * whose former owner was destroyed gets its own name back: `cinder`'s memory
 * comes back as `cinder`. The `-2` suffix applies only when the tag names an
 * agent that is still alive, or a legacy pre-release `destroyed` row that
 * still holds the name — offered, not imposed: the field stays editable.
 */
export function suggestedName(tag: string | null, taken: ReadonlySet<string>): string {
  if (tag === null) return "";
  if (!taken.has(tag)) return tag;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${tag}-${n}`;
    if (!taken.has(candidate) && candidate.length <= 31) return candidate;
  }
  return "";
}

/**
 * Where an agent has come to rest, as far as its data volume is concerned.
 *
 * `ready` and `degraded` are one phase — both have an instance holding the
 * volume, and a heartbeat flapping between them attaches nothing. Every
 * mid-flight status, and `unreachable` (a stale heartbeat, not a transition),
 * is `null`: an op is still moving, or nothing has moved at all.
 */
export type SettledPhase = "up" | "stopped" | "destroyed" | "error";

export function settledPhase(status: string): SettledPhase | null {
  switch (status) {
    case "ready":
    case "degraded":
      return "up";
    case "stopped":
    case "destroyed":
    case "error":
      return status;
    default:
      return null;
  }
}

/**
 * Whether the fleet just finished something that can move a volume.
 *
 * The inventory is a 30s poll of its own (`useVolumes`) and the fleet is a
 * stream, so without this a destroy that kept its volume went on listing that
 * volume as attached to the agent it just left until the next poll or a manual
 * refresh. An op's end is visible on the stream as an agent coming to rest in a
 * phase it was not resting in before — which catches ops started from the CLI
 * too, not only the ones this page is following. A `null` `prev` is the first
 * read, which is no change: the inventory is being read for the first time anyway.
 * Mid-flight rows keep their last settled phase, so the rest after an op is
 * compared against the rest before it rather than against the op.
 *
 * A name that leaves the fleet altogether is a change too: a destroy ends by
 * deleting the row (§6.7), so the last thing the stream shows of it is its
 * absence, and its volume was just deleted or released.
 */
export function settleVolumes(
  prev: ReadonlyMap<string, SettledPhase> | null,
  agents: readonly Pick<AgentView, "name" | "display_status">[],
): { next: Map<string, SettledPhase>; changed: boolean } {
  const next = new Map(prev ?? []);
  let changed = false;
  for (const a of agents) {
    const phase = settledPhase(a.display_status);
    if (phase === null || next.get(a.name) === phase) continue;
    next.set(a.name, phase);
    if (prev !== null) changed = true;
  }
  const present = new Set(agents.map((a) => a.name));
  for (const name of [...next.keys()]) {
    if (present.has(name)) continue;
    next.delete(name);
    changed = true;
  }
  return { next, changed };
}
