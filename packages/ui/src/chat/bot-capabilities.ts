/**
 * Bot Mode capability gates, carrying the certainty the probe reported.
 *
 * `bots.capabilities` returns a boolean per capability *and* a status saying how
 * much the probe actually learned. The two are not interchangeable. `refused`
 * is the gateway answering "no" — a settled answer, worth saying out loud and
 * not worth retrying. `unknown` is the probe learning nothing: a gateway fault,
 * a protocol error, a roster this build could not name a profile from. Both
 * arrive as a `false` boolean, and a portal that renders only the boolean tells
 * the operator a feature is absent when the truth is that the probe did not
 * come back.
 *
 * So every gate here resolves to one of five verdicts: the three the core
 * reports, plus the two states a browser has that the core does not — the sweep
 * still in flight, and the sweep itself having failed. Only `supported` opens an
 * affordance; only `unknown` and `unreadable` offer a retry, because those are
 * the only two where asking again can change the answer.
 */
import { useCallback, useEffect, useState } from "react";
import { botsCapabilities, fleetTarget } from "../api/index.ts";
import type { BotModeCapabilitiesView } from "../api/index.ts";

/** The four capabilities the gateway is probed for. */
export type CapabilityFlag = "profiles" | "routines" | "hosted_rooms" | "room_driver";

/**
 * `supported`/`refused`/`unknown` are the core's own statuses. `reading` is the
 * sweep in flight and `unreadable` is the sweep having failed outright (an
 * unreachable box, an aborted call) — which is not a verdict about any one
 * capability and must never be rendered as one.
 */
export type GateVerdict = "supported" | "refused" | "unknown" | "reading" | "unreadable";

export interface CapabilityGate {
  verdict: GateVerdict;
  /** Whether the affordance may be offered at all. True only for `supported`. */
  allowed: boolean;
  /** The headline a person reads. Never claims absence unless the gateway said so. */
  headline: string;
  /** The core's own explanation, or the browser's when the sweep never landed. */
  detail: string | null;
  /** Whether asking again could change this answer. */
  retryable: boolean;
}

export interface BotCapabilityState {
  caps: BotModeCapabilitiesView | null;
  loading: boolean;
  /** The sweep itself failed; no capability was learned, not even a refusal. */
  error: string | null;
  /** Re-probe. The core does not memoize an `unknown`, so this really re-asks. */
  reload: () => void;
}

/** What each flag is called on screen, so one gate renderer can name any of them. */
const FEATURE_NAMES: Record<CapabilityFlag, string> = {
  profiles: "Bot profile management",
  routines: "Scheduled jobs",
  hosted_rooms: "Group rooms",
  room_driver: "The hosted-room driver",
};

/**
 * Features Hermetic holds back on purpose.
 *
 * These are not gateway refusals and they are not unknown: the probe reports
 * them as a literal `false` because Hermetic has decided not to ship them yet.
 * Saying "your gateway refused this" about a decision made in this repo would be
 * the same dishonesty as saying "unsupported" about an unknown, so they get
 * their own wording, and no retry — asking again cannot move a gate that is not
 * the gateway's to open.
 */
export type GatedFeature = "membership_edit" | "cross_instance_rooms" | "cross_instance_relay";

export const HERMETIC_GATES: Record<GatedFeature, string> = {
  membership_edit:
    "Editing the members of an existing room is gated in Hermetic. The hosted protocol has no " +
    "member-update call, so the gate lifts only once that behaviour is implemented and qualified.",
  cross_instance_rooms:
    "Rooms that span instances are gated in Hermetic. Every room stays within one instance until " +
    "cross-instance behaviour is implemented and qualified.",
  cross_instance_relay:
    "Relaying messages between instances is gated in Hermetic, and stays gated until that " +
    "behaviour is implemented and qualified.",
};

/**
 * Reads one flag's certainty into something renderable.
 *
 * The version is surfaced here rather than re-derived: the gate is the flag plus
 * its status, and `protocol_version` is only ever additional context for the
 * sentence. A gate that recomputed support from the version would disagree with
 * the core the moment either changed.
 */
export function gateFor(state: BotCapabilityState, flag: CapabilityFlag): CapabilityGate {
  const name = FEATURE_NAMES[flag];
  if (state.error !== null)
    return {
      verdict: "unreadable",
      allowed: false,
      headline: `${name} could not be checked`,
      detail: state.error,
      retryable: true,
    };
  if (state.caps === null)
    return {
      verdict: "reading",
      allowed: false,
      headline: "Checking what this instance supports…",
      detail: null,
      retryable: false,
    };
  const status = state.caps.status[flag];
  if (status === "supported")
    return { verdict: "supported", allowed: true, headline: name, detail: null, retryable: false };
  const detail = state.caps.detail[flag];
  const said = [detail, versionNote(state.caps, flag)].filter((part) => part !== null);
  if (status === "refused")
    return {
      verdict: "refused",
      allowed: false,
      headline: `${name} is not available on ${state.caps.instance}`,
      detail: said.length ? said.join(" ") : null,
      retryable: false,
    };
  // `unknown`: the probe learned nothing, so nothing on screen may read as a
  // verdict about the gateway. The word is "undetermined", never "unsupported".
  return {
    verdict: "unknown",
    allowed: false,
    headline: `${name} could not be determined on ${state.caps.instance}`,
    detail: said.length
      ? said.join(" ")
      : "The gateway did not answer this probe, so the portal cannot say either way.",
    retryable: true,
  };
}

/**
 * The gate a room creation sits behind.
 *
 * A room needs the hosted protocol *and* a persistent driver, and the two fail
 * for different reasons, so the first closed gate is the one worth saying: a
 * gateway on protocol 1 has no driver either, and reporting the missing driver
 * would bury the version that actually explains it.
 */
export function roomGate(state: BotCapabilityState): CapabilityGate {
  const hosted = gateFor(state, "hosted_rooms");
  return hosted.allowed ? gateFor(state, "room_driver") : hosted;
}

/**
 * The reported hosted-room protocol, as a sentence, when it helps.
 *
 * The core already names the version inside `detail.hosted_rooms` for the
 * version case. It does not for `room_driver`, which inherits the hosted-room
 * reason, and it cannot when the gateway answered with a version but failed the
 * probe some other way — so the version is stated here too, where an operator
 * comparing a box against a release note needs the number.
 */
function versionNote(caps: BotModeCapabilitiesView, flag: CapabilityFlag): string | null {
  if (flag !== "hosted_rooms" && flag !== "room_driver") return null;
  if (caps.protocol_version === null) return null;
  const said = `hosted-room protocol ${caps.protocol_version}`;
  const already = caps.detail[flag]?.includes(`version ${caps.protocol_version}`) === true;
  return already ? null : `This gateway reports ${said}.`;
}

/**
 * In-flight sweeps, keyed by instance.
 *
 * The hook aborts on cleanup so a probe nobody is waiting on does not keep
 * three gateway calls running. React also unmounts on a remount of the *same*
 * instance — StrictMode, the jobs pane's per-bot `key`, auto-select then the
 * hash picking a different bot — and aborting those is the failure this map
 * exists to stop. An aborted sweep is not cached in core, so the next mount
 * repeats the three RPCs from scratch, which is the red `(canceled)` row in
 * the network panel on every Bot Chat open.
 *
 * Retain bumps a generation that a scheduled drop watches. A remount in the
 * same turn reclaims the sweep; a real unmount lets the microtask abort it.
 */
interface Sweep {
  instance: string;
  promise: Promise<BotModeCapabilitiesView>;
  controller: AbortController;
  refs: number;
  generation: number;
  value: BotModeCapabilitiesView | null;
}

const sweeps = new Map<string, Sweep>();

/**
 * How long a *settled* sweep is reused for, keyed by instance.
 *
 * The in-flight sharing above covers a remount that lands while the three
 * probes are still running. It does nothing for the one that lands a second
 * after they finished — closing and reopening the pane, the jobs tab going back
 * to a bot the operator already looked at — and each of those is three fresh
 * gateway calls for an answer the browser had. Thirty seconds is short enough
 * that a gateway being upgraded under the operator is noticed within one idle
 * pause, and long enough that moving between bots and back costs nothing. The
 * core memoizes for a few seconds on its own; this is the browser-side span,
 * and `reload` bypasses both.
 */
export const CAPABILITY_CACHE_MS = 30_000;

/**
 * Settled sweeps worth replaying. Never holds an unknown.
 *
 * Keyed `fleet_id/instance`, the same identity the core memoizes under: an
 * instance name is only unique within a fleet, so a tab that switched fleets
 * and met a box of the same name would otherwise replay the departing fleet's
 * gateway answers. Keying rather than clearing on switch, because the key is
 * already to hand (`fleetTarget()`) and a key that is right needs nothing to
 * remember to invalidate it.
 */
const answered = new Map<string, { at: number; value: BotModeCapabilitiesView }>();

/** `fleet_id/instance`, with a placeholder before `/api/meta` has been read. */
const memoKey = (instance: string): string => `${fleetTarget()?.fleet_id ?? "-"}/${instance}`;

const CAPABILITY_FLAGS = Object.keys(FEATURE_NAMES) as CapabilityFlag[];

/**
 * Whether this answer may be remembered at all.
 *
 * An `unknown` is the probe having learned nothing, and the pane offers a retry
 * precisely because asking again can change it — so caching one would turn that
 * retry into a replay of the guess. The core refuses to memoize an unknown for
 * the same reason (design.md §9, `bots.capabilities`) and this is the browser
 * saying the same thing. A sweep that *failed* never reaches here: a rejected
 * promise is not a result.
 */
function cacheable(value: BotModeCapabilitiesView): boolean {
  return CAPABILITY_FLAGS.every((flag) => value.status[flag] !== "unknown");
}

/** A settled answer still inside its TTL, or null. */
function replay(instance: string): BotModeCapabilitiesView | null {
  const key = memoKey(instance);
  const held = answered.get(key);
  if (!held) return null;
  if (Date.now() - held.at >= CAPABILITY_CACHE_MS) {
    answered.delete(key);
    return null;
  }
  return held.value;
}

function retain(instance: string): Sweep {
  const existing = sweeps.get(instance);
  if (existing) {
    existing.refs += 1;
    existing.generation += 1;
    return existing;
  }
  const controller = new AbortController();
  const held = replay(instance);
  if (held !== null) {
    // No probe at all: the answer is already known and still current. Shaped
    // like any other sweep so `release` and `invalidate` need no special case.
    const cachedSweep: Sweep = {
      instance,
      controller,
      refs: 1,
      generation: 0,
      value: held,
      promise: Promise.resolve(held),
    };
    sweeps.set(instance, cachedSweep);
    return cachedSweep;
  }
  const pending = botsCapabilities({ instance }, controller.signal);
  const sweep: Sweep = {
    instance,
    controller,
    refs: 1,
    generation: 0,
    value: null,
    promise: pending.then((value) => {
      sweep.value = value;
      // Not after an abort: the caller hung up, and an answer nobody waited for
      // is not evidence the next mount should trust.
      if (!controller.signal.aborted && cacheable(value)) {
        answered.set(memoKey(instance), { at: Date.now(), value });
      }
      return value;
    }),
  };
  sweeps.set(instance, sweep);
  return sweep;
}

function release(sweep: Sweep): void {
  sweep.refs -= 1;
  if (sweep.refs > 0) return;
  const generation = sweep.generation;
  queueMicrotask(() => {
    if (sweep.generation !== generation || sweep.refs > 0) return;
    if (sweeps.get(sweep.instance) === sweep) sweeps.delete(sweep.instance);
    sweep.controller.abort();
  });
}

/**
 * Forget every remembered sweep.
 *
 * Test seam. The memo is module state and bun runs a whole file in one
 * process, so two tests that probe the same instance name would otherwise see
 * each other's answers — which is a property of the memo working, not a bug,
 * but it makes a suite's cases depend on their order.
 */
export function resetBotCapabilityMemo(): void {
  answered.clear();
}

/** Drop a cached sweep so the next retain is a real probe, not a replay. */
function invalidate(instance: string): void {
  // Both layers, or "retry" would replay the settled answer it is retrying.
  answered.delete(memoKey(instance));
  const sweep = sweeps.get(instance);
  if (!sweep) return;
  sweep.generation += 1;
  sweeps.delete(instance);
}

/**
 * One instance's capability sweep, with a retry that genuinely re-probes.
 *
 * The core memoizes an answered sweep for a few seconds and deliberately does
 * not memoize one carrying an `unknown`, so `reload` on an undetermined flag
 * reaches the gateway again rather than replaying the guess. Mounting this is
 * what triggers the probe, so it belongs in the component that owns the gated
 * affordance — not in the workspace, which would probe every box the operator
 * merely looked at.
 */
export function useBotCapabilities(instance: string): BotCapabilityState {
  const [caps, setCaps] = useState<BotModeCapabilitiesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(instance !== "");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (instance === "") {
      setCaps(null);
      setError(null);
      setLoading(false);
      return;
    }
    let ignore = false;
    const sweep = retain(instance);
    setCaps(sweep.value);
    setError(null);
    setLoading(sweep.value === null);
    sweep.promise
      .then((answer) => {
        if (ignore || sweep.controller.signal.aborted) return;
        setCaps(answer);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (ignore || sweep.controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      });
    return () => {
      ignore = true;
      release(sweep);
    };
  }, [instance, attempt]);
  const reload = useCallback(() => {
    invalidate(instance);
    setAttempt((n) => n + 1);
  }, [instance]);
  return { caps, loading, error, reload };
}
