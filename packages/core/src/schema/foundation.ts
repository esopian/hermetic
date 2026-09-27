import { z } from "zod";
import { Iso, Sha256, Version } from "./common.ts";
import { AgentStatus, Lock } from "./agent.ts";
import { ConfigVerdict, Skew } from "./skew.ts";
import { NetworkMode } from "./fleet.ts";

/**
 * What `foundation.status` answers (§6.6): which foundation contract the fleet
 * is on, which one this build ships, and — because the two halves of an update
 * are the stack *and* the hermeticd release — where every agent's own version
 * has got to.
 *
 * It costs one `_fleet` GetItem and one agents scan, and that budget is the
 * point: `/api/meta` calls this on every request, so a status read that fetched
 * the fleet manifest from S3 would be one no head could afford to make.
 *
 * The manifest is therefore *not* read here — but not because it says the same
 * thing. It does not: `upgrade --hermeticd` moves the manifest's release
 * pointer and deliberately writes nothing to `_fleet` (§6.5), and the release
 * digest and `build` fingerprint exist only in the manifest. So there are facts
 * about the fleet's release this read cannot see, and it must not be extended
 * to imply otherwise. The question those facts answer — "would pushing from
 * this checkout actually change the binary?" — belongs to `plan.foundation`,
 * which reads the manifest and carries the answer in `Plan["release"]`, and
 * which already pays for a CloudFormation change set.
 */
export const FoundationAgentStatus = z.object({
  name: z.string(),
  status: AgentStatus,
  /** What the box last reported on its heartbeat; null before the first one. */
  hermeticd_version: Version.nullable(),
  /**
   * True when that report matches the release this build ships, false when it
   * names a different one, and **null when the box has reported no version at
   * all** — a stopped agent, or one whose replacement instance has not booted
   * yet (`recreate` writes the target release onto the row and clears
   * `last_heartbeat` in the same write, so the version there is the laptop's
   * intention until the box speaks).
   *
   * Tri-state for the same reason `ConfigVerdict` is: a boolean forced "has not
   * reported" to be spelled as `false`, and every reader took `false` to mean
   * "behind" — so the skew count reported powered-off boxes as stragglers, and
   * the drawer marked a booting replacement as out of date.
   *
   * Note this is still a comparison of *labels*, and a label cannot see a
   * release that changed the binary without changing the version. The row's
   * `running_hermeticd_sha256` is the fact that can; this field only stopped
   * answering for boxes that have said nothing.
   */
  current: z.boolean().nullable(),
  /**
   * Whether the config this box applied is the one rendered for its row
   * (`configVerdict`). Here rather than on its own read because this is the
   * scan that already has both hashes, and because the per-agent list this
   * block feeds is the one place the whole fleet's drift is answerable at once.
   */
  /*
   * Optional on the wire, like `hermes` below: a status read served by an older
   * build carries no verdict, and a head that received `undefined` renders
   * `unknown` — which is exactly what it is.
   */
  config: ConfigVerdict.optional(),
  /**
   * The Hermes version this agent's row is pinned to. Free — the same scan that
   * answers the hermeticd column already carries it — and it is the number the
   * advisory check above is *about*: an operator deciding whether to bump needs
   * to see which agents are on what, not only what a new agent would get.
   */
  hermes_version: Version.nullable(),
  /**
   * What the *box* reports running, out of Hermes's own `/api/health`
   * (`Agent.running_hermes_version`) — the other half of the field above, which
   * is only ever a pin a laptop wrote.
   *
   * Optional on the wire like `config`: a status served by an older build
   * carries none, and a box on a hermeticd too old to report it never will.
   * Absent reads as *unknown*. Never counted as skew — §6.6 keeps Hermes an
   * advisory, per-agent decision — so this is shown beside the pin and is not
   * drift.
   */
  // `z.string()`, not `Version`, for the reason `Agent.running_hermes_version`
  // gives: upstream's `__version__` is PEP 440 and hermetic does not get to
  // reject what a box truthfully reports about itself.
  running_hermes_version: z.string().min(1).max(64).nullish(),
  last_heartbeat: Iso.nullable(),
});
export type FoundationAgentStatus = z.infer<typeof FoundationAgentStatus>;

/**
 * The *advisory* half of `foundation.status` (§6.6): where upstream Hermes has
 * got to, next to the pin this build ships.
 *
 * Bumping Hermes stays a manual, per-agent decision (`hermetic upgrade --hermes
 * <ver> <name>`) — hermetic will not move an operator's agents onto a release
 * nobody has read the notes for. What it will do is stop the operator finding
 * out months later, which is all this block is: a number, a timestamp and, when
 * the check could not be made, the reason it could not.
 *
 * Nothing here can fail a status read. Every failure mode — offline, GitHub
 * rate-limiting an unauthenticated caller, a tag shaped like nothing this can
 * order — lands as `latest: null` (or `update_available: false`) plus an
 * `error` string, never a thrown error and never a wait past the check's own
 * timeout.
 */
export const HermesUpstream = z.object({
  /** `BUILD_VERSIONS.hermes`: the version a newly created agent is pinned to. */
  pinned: Version,
  /**
   * `BUILD_VERSIONS.hermes_ref`: the upstream git tag that *is* `pinned`.
   *
   * It is the ref, not the version, that the comparison below is made against.
   * Hermes Agent ships no PyPI release, so upstream's releases are tagged by
   * date (`v2026.8.31`) while its `pyproject` carries a semver (`0.21.0`) —
   * see `schema/manifest.ts`. Ordering GitHub's `tag_name` against `pinned`
   * would compare a date to a semver and call every fleet out of date forever.
   */
  pinned_ref: z.string().min(1),
  /**
   * The tag on upstream's latest GitHub release, with a leading `v` stripped —
   * so it is directly comparable with `pinned_ref` normalised the same way.
   * `null` when the check did not answer; `error` says why.
   */
  latest: z.string().min(1).nullable(),
  /** `latest` is strictly newer than `pinned_ref`. False whenever `error` is set. */
  update_available: z.boolean(),
  /** When the answer being reported was fetched; `null` if it never was. */
  checked_at: Iso.nullable(),
  /** A short reason the check did not produce a comparison, or `null`. */
  error: z.string().nullable(),
});
export type HermesUpstream = z.infer<typeof HermesUpstream>;

export const FoundationStatus = z.object({
  /** What the fleet is on now. `foundation_version` absent on `_fleet` reads as 0. */
  fleet: z.object({
    foundation_version: z.number().int().nonnegative(),
    template_sha256: Sha256.nullable(),
    /** `_fleet.min_hermetic_version`: the release the fleet is pointed at. */
    hermeticd_version: Version,
    /**
     * The image the fleet was built on, straight off `_fleet`. Facts, not
     * preferences — there is no "available" counterpart to compare them with —
     * and this is the one read that already opens the `_fleet` item, so it is
     * where a head asks what AMI its agents boot.
     */
    ubuntu_release: z.string().min(1),
    ami_id: z.string().min(1),
    /**
     * Which network mode the fleet is in (§5), straight off `_fleet.network`.
     * Absent means the fleet predates the field and the v6 migration has not
     * back-filled it yet — not `public`, which is why this is optional rather
     * than defaulted.
     */
    network: NetworkMode.optional(),
    /**
     * The Bedrock model ids this fleet's agent role may invoke, as `_fleet`
     * records them (§8.3). Absent on a fleet the v10 migration has not reached
     * yet — which reads as *not recorded*, never as an empty grant.
     */
    bedrock_model_ids: z.array(z.string().min(1)).optional(),
  }),
  /** What this build of hermetic would apply. */
  available: z.object({
    foundation_version: z.number().int().nonnegative(),
    template_sha256: Sha256,
    hermeticd_version: Version,
  }),
  /** The version is behind, or the template digest differs, or the release does. */
  update_available: z.boolean(),
  /**
   * The *fleet* is ahead of this build: somebody updated the foundation from a
   * newer hermetic. Upgrading the tool is the fix; `foundation.update` refuses
   * with `FOUNDATION_NEWER` rather than applying an older template over a newer
   * one.
   */
  tool_outdated: z.boolean(),
  /** `_fleet.lock` while it is live: an update is running right now. */
  in_progress: Lock.nullable(),
  /**
   * §6.6's version skew, computed from the two blocks above and the agent list
   * below (`computeSkew`). Every head renders this rather than comparing the
   * numbers itself: the portal’s band, the drawer’s band and the CLI’s stderr
   * warning are then the same sentence about the same fleet, and a head that
   * disagreed with another about whether a fleet is skewed would be a bug in
   * one of them rather than a difference of opinion.
   */
  skew: Skew.optional(),
  /**
   * §6.6's advisory upstream-Hermes check. Optional on the wire so a status
   * read that was told not to pay for it — the CLI's per-command nag, which
   * renders none of this — is still a `FoundationStatus`, and so an older
   * server can be talked to by a newer head.
   */
  hermes: HermesUpstream.optional(),
  /**
   * §8.3: Bedrock models this fleet's profiles or agents name that its role may
   * not invoke. Non-empty means the grant is stale and `hermetic foundation
   * update` is the fix — the update reconciles the parameter and records the
   * result. Empty means the comparison was made and found nothing.
   *
   * **Absent is a third answer**, not a synonym for empty: this fleet records
   * no grant to compare against — it predates v10, so nothing has reconciled
   * its policy — or the server is older than the field. A head that rendered
   * absent as "current" would report an unchecked IAM policy as a checked one,
   * and the fix for the unchecked case is the same `foundation update`.
   */
  stale_bedrock_grants: z.array(z.string().min(1)).optional(),
  agents: z.array(FoundationAgentStatus),
});
export type FoundationStatus = z.infer<typeof FoundationStatus>;

/** Upper bound on `rollout_wait_ms` (§6.6). */
export const MAX_ROLLOUT_WAIT_MS = 30 * 60_000;

/**
 * `foundation.update` (§6.6). `yes` is the head saying the operator confirmed —
 * core never asks (§3.2 rule 1) and does not read it; it is here so the CLI's
 * `--yes` and the route's body validate against the same schema core does.
 */
export const FoundationUpdateInput = z.object({
  yes: z.boolean().optional(),
  /**
   * How long the `rollout` phase waits for every targeted agent to report the
   * new hermeticd. Overrides the deployment default (ten minutes in real mode,
   * zero in fixtures and tests); a timeout is a warning, never a failure.
   * Capped at thirty minutes: the fleet lock is held for the whole wait, and a
   * request body must not be able to park the fleet for a day.
   */
  rollout_wait_ms: z.number().int().nonnegative().max(MAX_ROLLOUT_WAIT_MS).optional(),
});
export type FoundationUpdateInput = z.infer<typeof FoundationUpdateInput>;

/**
 * The phases `foundation.update` emits, in order. Exported so a head can seed
 * its progress UI before the first event arrives, rather than discovering the
 * shape of the op from the op.
 */
export function foundationPhases(): string[] {
  return ["preflight", "archive", "stack", "artifacts", "migrate", "rollout", "done"];
}
