/**
 * The fixture fleet's agent rows, as data.
 *
 * Eleven agents for `main` and two for `staging`, each chosen to put one state
 * a reader has to handle on screen: a failed bootstrap stage, a drifted config,
 * a node the tailnet renamed, a stopped box waiting on a rerun. They
 * live here rather than in `memory.ts` because they are a *table* — nothing
 * about them is behaviour — and `memory.ts` is the file in this package that
 * keeps running into the 2500-line limit (AGENTS.md rule 5).
 *
 * `seedFixtureAgents` in `memory.ts` is the only reader.
 */
import type { Agent } from "../../schema/index.ts";

/** The health snapshot of a box with nothing wrong with it. */
const HEALTHY = { hermes: true, tailscale: true, disk: true } as const;

export interface SeedSpec {
  name: string;
  status: Agent["status"];
  size: Agent["size"];
  /** null when the agent has no tailnet address to be reachable on. */
  ip: string | null;
  hermes: string;
  hermeticd: string;
  cpu: number;
  mem: number;
  disk: number;
  /**
   * The root filesystem, when this seed's hermeticd is new enough to report one.
   * Absent on the seeds still running an older build, so the fixture fleet
   * carries both shapes and every reader's "not reported" path is on screen in
   * `bun run dev:fixture` rather than only in a test.
   */
  root_disk?: number;
  /**
   * Free MiB as the box measured it, for the seeds new enough to report it.
   *
   * Seeded independently of `root_disk` rather than computed from it, because
   * the gap between the two is the point (`Metrics.root_free_mib`): a root
   * filesystem is smaller than the volume under it, so the true figure always
   * lands below what the percentage implies. Leaving it off a seed that *does*
   * carry `root_disk` is also a real shape — a box on a hermeticd that reports
   * the ratio and not the bytes — and puts the estimate path on screen too.
   */
  root_free_mib?: number;
  created_at: string;
  /** Minutes since the last heartbeat, or null for never/stopped. */
  heartbeat_age_min: number | null;
  health: Agent["health"];
  /** Set for the one seeded agent whose bootstrap stopped on a failed stage. */
  failed_stage?: { id: string; exit_code: number; message: string };
  /**
   * Set for the seeds holding a config the fleet did not render for them
   * (§6.6): the `drifted` verdict, on screen in `bun run dev:fixture` rather
   * than only in a test.
   */
  config_drifted?: boolean;
  /**
   * Set for the one seed whose hermeticd is too old to report which binary it is
   * running (§6.6). Its row carries no `running_hermeticd_sha256`, so
   * `foundation update`'s rollout reports it as *unconfirmed* rather than as
   * landed — the third outcome, on screen in `bun run dev:fixture` rather than
   * only in a test.
   */
  reports_no_digest?: boolean;
  /**
   * Set for the seed caught between `hermetic upgrade --hermes <v>` and the
   * `recreate` that applies it: the row pins one version and the box reports
   * the one it is still running. Without it the fixture could never show the
   * `hermes_version` / `running_hermes_version` split that exists precisely
   * because that window used to be invisible.
   */
  running_hermes?: string;
  browser?: boolean;
  provider?: Agent["provider"];
  secrets_mode?: Agent["secrets_mode"];
  /**
   * The node's real MagicDNS *hostname* — the part before the tailnet — when it
   * is not the agent's own name. One seed carries a suffixed one so the UI's
   * stale-device note, `doctor`'s `tailscale_stale_device` finding and the
   * probe's warning are all visible in `bun run dev:fixture` without anybody
   * having to break a real fleet to see them.
   */
  dns_host?: string;
  /**
   * The provider profile this agent is bound to (§8.3), by its key in
   * `FIXTURE_PROFILE_IDS`. Absent leaves the row without a binding at all,
   * which is the *legacy* shape — every agent created before profiles existed —
   * and the fixture carries both so each reader's fallback is on screen in
   * `bun run dev:fixture` rather than only in a test.
   */
  profile?: "anthropic" | "openrouter" | "nous" | "bedrock" | "vercel";
  /** The revision the row pinned; a number below the profile's makes it stale. */
  profile_revision?: number;
  /**
   * A profile change saved and not yet applied (§8.3) — the "Saved — pending
   * apply" state. One seed carries one, so the drawer's banner, `agent ps`'s
   * column and `plan rollout`'s extra line all have something real to render.
   */
  pending_profile?: "anthropic" | "openrouter" | "nous" | "bedrock" | "vercel";
  pending_model?: string;
}

export const SEEDS: readonly SeedSpec[] = [
  {
    name: "atlas",
    status: "ready",
    size: "medium",
    ip: "100.64.12.4",
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 34,
    mem: 61,
    disk: 62,
    root_disk: 27,
    root_free_mib: 13980,
    created_at: "2026-07-22T14:05:00.000Z",
    heartbeat_age_min: 0.3,
    health: HEALTHY,
    // Pinned to a revision the profile has since moved past, so "Update
    // available" is on screen without anybody having to edit a profile first.
    profile: "bedrock",
    provider: "bedrock",
    profile_revision: 1,
  },
  {
    name: "corvid",
    status: "ready",
    size: "large",
    ip: "100.64.12.9",
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 58,
    mem: 44,
    disk: 48,
    root_disk: 33,
    created_at: "2026-07-22T16:40:00.000Z",
    heartbeat_age_min: 0.2,
    health: HEALTHY,
    dns_host: "corvid-2",
    // The staged state: saved on the row, waiting for `hermetic apply`.
    provider: "openrouter",
    profile: "openrouter",
    pending_profile: "anthropic",
    pending_model: "claude-sonnet-5",
  },
  {
    name: "ember",
    status: "degraded",
    size: "medium",
    ip: "100.64.12.17",
    hermes: "0.14.2",
    hermeticd: "0.4.0",
    cpu: 96,
    mem: 88,
    disk: 91,
    created_at: "2026-08-20T08:12:00.000Z",
    heartbeat_age_min: 0.4,
    health: { hermes: false, tailscale: true, disk: true },
  },
  {
    name: "fathom",
    status: "ready",
    size: "small",
    ip: "100.64.12.21",
    hermes: "0.14.2",
    hermeticd: "0.5.1",
    cpu: 12,
    mem: 39,
    disk: 34,
    root_disk: 19,
    created_at: "2026-08-23T11:30:00.000Z",
    heartbeat_age_min: 0.5,
    health: HEALTHY,
    browser: false,
  },
  {
    name: "granite",
    status: "ready",
    size: "medium",
    ip: "100.64.12.23",
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 41,
    mem: 72,
    disk: 55,
    root_disk: 78,
    root_free_mib: 3890,
    created_at: "2026-08-24T09:55:00.000Z",
    heartbeat_age_min: 0.1,
    health: HEALTHY,
  },
  // The one agent whose staged bootstrap stopped: `agent rerun` is what the
  // board offers for it, and the triage view has a real failure to render.
  {
    name: "heron",
    status: "error",
    size: "medium",
    ip: "100.64.12.30",
    hermes: "0.14.2",
    hermeticd: "0.4.0",
    cpu: 77,
    mem: 51,
    disk: 57,
    created_at: "2026-08-25T13:20:00.000Z",
    heartbeat_age_min: 0.2,
    health: { hermes: false, tailscale: true, disk: true },
    // The live shape this axis was built for: a box whose verify failed while
    // holding a config an older build rendered.
    config_drifted: true,
    failed_stage: {
      id: "02-data-volume",
      exit_code: 100,
      message: "device /dev/nvme1n1 has an unknown signature; refusing to mkfs",
    },
  },
  {
    name: "ibis",
    status: "ready",
    size: "small",
    ip: "100.64.12.31",
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 8,
    mem: 27,
    disk: 22,
    root_disk: 24,
    created_at: "2026-08-26T07:45:00.000Z",
    heartbeat_age_min: 0.3,
    health: HEALTHY,
    browser: false,
  },
  {
    name: "juniper",
    status: "stopped",
    size: "large",
    ip: "100.64.12.38",
    hermes: "0.13.8",
    hermeticd: "0.3.9",
    cpu: 0,
    mem: 0,
    disk: 70,
    created_at: "2026-08-12T18:00:00.000Z",
    heartbeat_age_min: null,
    health: { hermes: false, tailscale: false, disk: true },
  },
  {
    name: "kestrel",
    status: "ready",
    size: "medium",
    ip: "100.64.12.40",
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 29,
    mem: 55,
    disk: 41,
    root_disk: 46,
    created_at: "2026-08-29T10:10:00.000Z",
    heartbeat_age_min: 0.2,
    health: HEALTHY,
    // Pinned forward by `hermetic upgrade --hermes 0.21.0`; still running what
    // it booted with, until a recreate applies it.
    running_hermes: "0.20.0",
    provider: "anthropic",
    profile: "anthropic",
    secrets_mode: "bitwarden",
  },
  // Stale heartbeat: 20 minutes is far past three 30-second intervals, so `ps`
  // shows `unreachable` without anything having written that status. Its failing
  // disk check is the root filesystem, not `/data` — the case the fleet could
  // not see at all before `root_disk_pct`: 18% of the memory volume used, and a
  // root disk with nothing left for the next hermeticd to be written to.
  {
    name: "lumen",
    status: "ready",
    size: "small",
    ip: "100.64.12.44",
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 63,
    mem: 34,
    disk: 18,
    root_disk: 96,
    // 0.25 GiB, not the 0.32 GiB that 4% of 8 GiB would imply: below the
    // ~300 MiB a self-update needs, which is why this box has stopped taking
    // them while its `/data` bar still reads 18%.
    root_free_mib: 256,
    created_at: "2026-08-31T21:15:00.000Z",
    heartbeat_age_min: 20,
    health: { hermes: true, tailscale: true, disk: false },
    // Running a hermeticd from before the field existed: the rollout can say
    // nothing about it, which is a different answer from "behind".
    reports_no_digest: true,
  },
  {
    name: "marrow",
    status: "stopped",
    size: "medium",
    ip: "100.64.12.47",
    hermes: "0.14.0",
    hermeticd: "0.4.0",
    cpu: 0,
    mem: 0,
    disk: 66,
    created_at: "2026-08-04T12:00:00.000Z",
    heartbeat_age_min: null,
    health: { hermes: false, tailscale: false, disk: true },
    /**
     * The *keyed* legacy shape (§8.3): no binding, and a provider whose key
     * came from the fleet's shared `nous-key` slot through
     * `settings.providers.nous.secret`. It is the only seed that reads that map
     * for a real key, which is what makes `secrets rm nous-key` refuse on the
     * fixture — the state the refusal exists for, on screen rather than only in
     * a test.
     */
    provider: "nous",
  },
  // No destroyed seed: a destroy deletes the row (§6.7). The fixture's
  // destroyed agent, `oriole`, is a tombstone and a kept volume
  // (`seedFixtureTombstones` in `memory-fixture.ts`), never a row.
];

/**
 * The `staging` fixture fleet: two agents, one of each of the two states a
 * second fleet has to have for the switcher to be worth looking at — one live
 * and one stopped. It is small on purpose. Nothing about a fleet switch is
 * clearer for the second fleet also having eleven agents, and a demo that
 * takes a second to tell apart is a demo that hides the switch.
 */
export const STAGING_SEEDS: readonly SeedSpec[] = [
  {
    name: "ember",
    status: "ready",
    size: "small",
    ip: "100.64.31.6",
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 21,
    mem: 38,
    disk: 30,
    root_disk: 22,
    created_at: "2026-08-11T10:15:00.000Z",
    heartbeat_age_min: 0.3,
    health: HEALTHY,
    config_drifted: true,
  },
  {
    name: "quill",
    status: "stopped",
    size: "medium",
    ip: null,
    hermes: "0.21.0",
    hermeticd: "0.5.1",
    cpu: 0,
    mem: 0,
    disk: 41,
    created_at: "2026-08-18T16:02:00.000Z",
    heartbeat_age_min: null,
    health: null,
  },
];

/**
 * Seed `_fleet` plus the eleven sample agents, their resources, and an event
 * history for each. Everything lives in one region — the fixture config's.
 */
