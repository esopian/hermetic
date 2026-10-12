import type { Agent, AgentStatus, DisplayStatus, Lock } from "../schema/agent.ts";
import { AGENT_STATUSES } from "../schema/agent.ts";
import { HermeticError } from "../errors.ts";

/** hermeticd's default heartbeat period (§6.4). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** How many missed intervals before `ps` shows `unreachable` (§4.3). */
export const UNREACHABLE_INTERVALS = 3;

/** Statuses for which a heartbeat is expected, and therefore staleness is meaningful. */
const HEARTBEAT_EXPECTED: readonly AgentStatus[] = ["bootstrapping", "ready", "degraded"];

/**
 * The status state machine of §4.3, written out explicitly rather than derived,
 * because the interesting content is which edges are *missing*.
 *
 *   creating → bootstrapping → ready
 *   bootstrapping → error         (a bootstrap stage failed)
 *   error → bootstrapping         (`agent rerun`, or a recreate)
 *   ready ⇄ degraded
 *   ready → stopping → stopped → (start) → bootstrapping
 *   any   → destroying → (row deleted; name released, §6.7)
 *   any   → error
 *
 * `destroyed` is legacy only. Destroy used to end on it and keep the row
 * forever; it now ends by deleting the row (`lifecycle/release-name.ts`), so
 * the status survives only on rows destroyed before tombstones existed and on
 * old events' `to_status`. Those rows are released the first time a destroy or
 * a create touches them — never moved out of `destroyed` by a transition.
 */
export const TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  creating: ["bootstrapping", "destroying", "error"],
  // The staged bootstrap ends in `ready`, or in `error` on the first stage that
  // fails; there is no third state between them any more.
  bootstrapping: ["ready", "degraded", "destroying", "error"],
  ready: ["degraded", "stopping", "destroying", "error"],
  degraded: ["ready", "stopping", "destroying", "error"],
  stopping: ["stopped", "destroying", "error"],
  // `start` boots a fresh instance, which re-runs bootstrap.
  stopped: ["bootstrapping", "destroying", "error"],
  destroying: ["destroyed", "error"],
  // Terminal, and legacy only: nothing writes it now (§6.7). A legacy row is
  // released — deleted — rather than moved anywhere.
  destroyed: [],
  // `error` is recoverable by `agent rerun` or recreate (→ bootstrapping), or
  // by giving up (→ destroying).
  error: ["bootstrapping", "destroying"],
} as const;

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Is the row already where we are being asked to move it?
 *
 * Being asked to move an agent to the status it already holds is not a bad
 * request; it means our picture of the row was stale. Something already did the
 * work — an earlier attempt of this same op that died partway, a resumed op,
 * another operator — and the honest response is to adopt reality and carry on
 * rather than refuse. That is what makes §4.5's promise true in practice: a run
 * that died partway can simply be run again, with no wedged state and no hand
 * editing of DynamoDB. (The wedge this replaces: a `destroy` that failed after
 * `DeleteVolume` was refused left the row in `destroying`, and every subsequent
 * `destroy` threw `INVALID_TRANSITION` before it reached the step that actually
 * needed finishing.) The store is the source of truth; local state that
 * disagrees with it resyncs passively, one op at a time.
 *
 * A re-entry is deliberately *not* modelled as a self-edge in `TRANSITIONS`.
 * §4.3 has no self-edges and should not grow any: `destroying → destroying` is
 * not a state change, it is the same state being reasserted, and the two want
 * different handling (a re-entry writes no history event, because nothing
 * moved). Keeping them apart is what lets `canTransition` stay an honest
 * reading of the diagram — and it is why `destroyed` re-entering itself changes
 * nothing about it being terminal (§6.6): the table still has no edge out of
 * `destroyed`, and re-entering it is a no-op on a row that is already gone, not
 * a resurrection.
 */
export function isReentry(from: AgentStatus, to: AgentStatus): boolean {
  return from === to;
}

export function assertTransition(from: AgentStatus, to: AgentStatus): void {
  if (!canTransition(from, to)) {
    throw new HermeticError("INVALID_TRANSITION", `cannot move agent from ${from} to ${to}`, {
      from,
      to,
      allowed: TRANSITIONS[from],
    });
  }
}

/** Every (from, to) pair, for the table test. */
export function allStatusPairs(): Array<[AgentStatus, AgentStatus]> {
  const pairs: Array<[AgentStatus, AgentStatus]> = [];
  for (const from of AGENT_STATUSES) for (const to of AGENT_STATUSES) pairs.push([from, to]);
  return pairs;
}

/**
 * Is this TTL lock still somebody else's problem (§4.4)?
 *
 * The one liveness rule, for both scopes. An agent's lock and the `_fleet`
 * item's lock are the same shape and are read the same way — "is there a lock,
 * is it somebody else's, has it not expired yet" — and the two hand-written
 * copies (`hermetic.ts`'s `lockHeldByOther`, `foundation.ts`'s `lockIsLive`)
 * could have drifted into two different answers to the same question about the
 * same fleet.
 *
 * `self` is the owner asking. Omit it — as the fleet-wide guard does — to ask
 * the unqualified question: *anybody* holding this lock blocks the caller, and
 * a re-entrant owner gets no free pass.
 *
 * Expiry is deliberately `>=` and not `>`, because this reader has to give the
 * same answer as the store it is reading about. DynamoDB frees a lock on
 * `#lock.#expires < :now` and the memory backend's `lockIsLive` matches it, so
 * at the exact expiry instant a take is still refused. Reading `>` there made
 * the one millisecond in which a head would offer an action — "the lock is
 * dead, go ahead" — that the store then refused with `LOCKED`.
 *
 * Typed as a predicate so a caller that has just established the lock is live
 * can go on to name its owner and expiry without a non-null assertion.
 */
export function isLockLive(
  lock: Lock | null | undefined,
  self: string | undefined,
  nowMs: number,
): lock is Lock {
  if (!lock) return false;
  if (self !== undefined && lock.owner === self) return false;
  return Date.parse(lock.expires) >= nowMs;
}

export function heartbeatAgeMs(
  agent: Pick<Agent, "last_heartbeat">,
  now: Date | number = Date.now(),
): number | null {
  if (!agent.last_heartbeat) return null;
  const at = Date.parse(agent.last_heartbeat);
  if (Number.isNaN(at)) return null;
  return (typeof now === "number" ? now : now.getTime()) - at;
}

/**
 * How long a `bootstrapping` agent may say nothing before it is `unreachable`.
 *
 * Ten minutes, not ninety seconds, because during a boot the thing that writes
 * is not the heartbeat. hermeticd's stage runner writes the row on throttled
 * `::progress` output and at each stage boundary, and a legitimate stage is
 * allowed to be silent for a long time — an `npm ci && npm run build` of the
 * Hermes SPA, an apt install over a slow mirror, a docker pull. Judging that
 * silence by the heartbeat's three-intervals rule called every long stage a
 * dead box, which is the one report an operator must be able to trust.
 *
 * The runner also pulses the row while a stage runs (`packages/agentd/src/stages.ts`),
 * so this bound is about a box that has genuinely stopped talking rather than
 * about how long a stage may take.
 */
export const BOOTSTRAP_STALE_MS = 10 * 60_000;

/**
 * `unreachable` is a derived display state, never stored (§4.3): an agent that
 * ought to be heartbeating and whose last heartbeat is older than three
 * intervals. A row that has never heartbeated is unreachable once its own
 * `updated_at` is that old — the grace period covers the boot window.
 *
 * A `bootstrapping` row is judged differently, and on a different clock. Its
 * heartbeat may not exist yet — `hermeticd.service` is installed by a bootstrap
 * stage, so on a first boot nothing is beating until most of the stages have
 * run — and the signal that *is* live is the stage runner's own writes. So the
 * freshest of what the box has said (the bootstrap state, a heartbeat if one
 * has started, the row's own `updated_at`) is measured against
 * `BOOTSTRAP_STALE_MS`.
 */
export function deriveDisplayStatus(
  agent: Pick<Agent, "status" | "last_heartbeat" | "updated_at" | "bootstrap">,
  now: Date | number = Date.now(),
  heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
): DisplayStatus {
  if (!HEARTBEAT_EXPECTED.includes(agent.status)) return agent.status;

  const nowMs = typeof now === "number" ? now : now.getTime();

  if (agent.status === "bootstrapping") {
    const spoke = newestOf(agent.bootstrap?.updated_at, agent.last_heartbeat, agent.updated_at);
    return spoke !== null && nowMs - spoke > BOOTSTRAP_STALE_MS ? "unreachable" : agent.status;
  }

  const threshold = heartbeatIntervalMs * UNREACHABLE_INTERVALS;
  const age = heartbeatAgeMs(agent, nowMs);
  if (age === null) {
    const since = nowMs - Date.parse(agent.updated_at);
    return Number.isNaN(since) || since <= threshold ? agent.status : "unreachable";
  }
  return age > threshold ? "unreachable" : agent.status;
}

/**
 * The most recent of a set of ISO timestamps, ignoring the absent and the
 * unparseable. `null` when nothing usable was given — which reads as "we have
 * no evidence either way", and no row is called unreachable on no evidence.
 */
function newestOf(...stamps: ReadonlyArray<string | null | undefined>): number | null {
  let newest: number | null = null;
  for (const stamp of stamps) {
    if (!stamp) continue;
    const at = Date.parse(stamp);
    if (Number.isNaN(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}
