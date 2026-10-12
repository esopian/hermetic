/**
 * Following one op (`GET /api/ops/:id/stream`): the stream replays everything
 * that already happened and then tails, so this hook is correct whether it
 * attaches at the start of an op or long after the drawer was closed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { followOp } from "../api/index.ts";
import type { OpEvent } from "../api/index.ts";

/** The `phase` values `agents.create` emits, in order (core `hermetic.ts`). */
export const CREATE_PHASES = [
  "validate",
  "secrets",
  "render",
  "volume",
  "instance",
  // `create` no longer ends at handoff: it watches the row for hermeticd's
  // first report for a bounded window (core `handoff.ts`), so the rail has a
  // step for the part of a create that actually takes minutes.
  "handoff",
  "done",
];

/**
 * The other lifecycle ops, so their rails are pre-seeded too. Seeding matters
 * most for `create`: without it the drawer's step list only ever shows the
 * phases that already happened, so an operator watching a create cannot see
 * what is still to come, and a create that ends at `done` looks complete even
 * though the box has not reported yet (§6.3).
 *
 * Every list is core's own first-appearance order — `destroy` and `recreate`
 * both sweep the tailnet, and `recreate` never renders or uploads (its config
 * step lives inside `instance`). The UI may not import core (§3.1), so they are
 * spelled here and pinned against the real generators by `tests/op-phases.test.ts`;
 * a phase core emits that is missing here lands *after* `done`, which is how
 * `tailnet` came to be a raw key at the bottom of a destroy rail.
 */
export const DESTROY_PHASES = ["instance", "tailnet", "secrets", "config", "volume", "release", "done"];
export const RECREATE_PHASES = ["plan", "instance", "tailnet", "secrets", "done"];
export const STOP_PHASES = ["instance", "done"];
export const START_PHASES = ["instance", "done"];

/** The rail for an op the drawer knows only by its short label. */
export function phasesForOp(label: string): readonly string[] {
  if (label === "create") return CREATE_PHASES;
  if (label === "destroy") return DESTROY_PHASES;
  if (label === "recreate") return RECREATE_PHASES;
  if (label === "stop") return STOP_PHASES;
  if (label === "start") return START_PHASES;
  return [];
}

/**
 * The default for `useOp`'s `labels`, and the answer for an op with no rail of
 * its own. A fresh `{}` per call would be a new memo dependency on every render
 * for every caller that does not pass one, so the empty case is one shared
 * object — and so is every map below.
 */
const NO_LABELS: Readonly<Record<string, string>> = {};

/**
 * What each lifecycle step *does*, in the voice of the op doing it.
 *
 * `PHASE_LABELS` further down is one table shared by every op, and a lifecycle
 * phase name means the opposite thing depending on who is saying it: `instance`
 * launches a box on create and terminates one on destroy, `secrets` mints a key
 * on create and deletes the agent's slots on destroy. A single table has to pick
 * one of those, which is why a destroy rail used to read as a create — right
 * down to "Allocate the data volume" over a step that deletes it. So each op
 * brings its own reading of every step it seeds, and destroy's is the bootstrap
 * in reverse: each line names what it removes.
 */
const CREATE_LABELS: Record<string, string> = {
  validate: "Validate name and claim the row",
  secrets: "Mint the tailscale key into SSM",
  render: "Render config and manifest",
  volume: "Allocate the data volume",
  instance: "Launch the EC2 instance and attach its data volume",
  handoff: "Wait for hermeticd's first report",
  done: "Created",
};

const DESTROY_LABELS: Record<string, string> = {
  instance: "Terminate the EC2 instance",
  tailnet: "Remove the node from the tailnet",
  secrets: "Delete the agent's SSM parameters",
  config: "Remove config objects from the bucket",
  // Delete first, because deleting is the default (§6.7): core keeps the
  // volume, released from the name, only when `--keep-volume` was asked for.
  volume: "Delete the data volume, or release it if kept",
  // §6.7: the row goes last, after its tombstone is written, so the name is free.
  release: "Write the tombstone and free the name",
  done: "Destroyed",
};

const RECREATE_LABELS: Record<string, string> = {
  plan: "Plan the recreate",
  instance: "Replace the EC2 instance and reattach the volume",
  tailnet: "Remove the old node from the tailnet",
  secrets: "Mint a fresh tailscale key into SSM",
  done: "Recreated",
};

const STOP_LABELS: Record<string, string> = {
  instance: "Stop the EC2 instance",
  done: "Stopped",
};

/** `start` ends when EC2 accepts it; hermeticd reports readiness later (§6.3). */
const START_LABELS: Record<string, string> = {
  instance: "Start the EC2 instance",
  done: "Starting",
};

/** The labels for the rail `phasesForOp` seeds, keyed the same way. */
export function labelsForOp(label: string): Readonly<Record<string, string>> {
  if (label === "create") return CREATE_LABELS;
  if (label === "destroy") return DESTROY_LABELS;
  if (label === "recreate") return RECREATE_LABELS;
  if (label === "stop") return STOP_LABELS;
  if (label === "start") return START_LABELS;
  return NO_LABELS;
}

/** `init` takes one of two paths; both are pre-seeded so the rail is honest. */
export const INIT_ATTACH_PHASES = ["identity", "preflight", "attach", "artifacts", "done"];
export const INIT_CREATE_PHASES = [
  "identity",
  // The §4.7 Tailscale preflight. On attach it only appears as a warning, and
  // an unseen seed phase folds out once the op's real events arrive.
  "preflight",
  "foundation",
  "tailscale",
  "ami",
  "fleet",
  "artifacts",
  "ready",
  "done",
];

/**
 * `INIT_CREATE_PHASES` with §4.7's policy write folded in. Core emits `policy`
 * between `tailscale` and `ami` exactly when the run will attempt one — there is
 * a client secret to write with — or when `--skip-policy` is the reason it did
 * not (`core/init.ts`). Seeded conditionally for the reason `teardownPhases`
 * is: an unseen seed stays grey for the whole run, so seeding it always would
 * leave a step on every init that had no secret to offer.
 */
export function initCreatePhases(policy: boolean): string[] {
  if (!policy) return [...INIT_CREATE_PHASES];
  const phases = [...INIT_CREATE_PHASES];
  phases.splice(phases.indexOf("ami"), 0, "policy");
  return phases;
}

/**
 * `teardown` (core `hermetic.ts`): guard, empty the bucket, delete the stack,
 * then the four optional flag-driven phases. Seed phases are never folded back
 * out (an unseen one stays `pending` for the whole run), so the rail must be
 * built from the flags the operator actually submitted — otherwise a run with
 * `delete_volumes` off finishes at 100% with three grey steps that were never
 * going to happen.
 */
export function teardownPhases(options: {
  purge: boolean;
  delete_snapshots: boolean;
  delete_volumes: boolean;
  reset_local: boolean;
}): string[] {
  return [
    "agents_check",
    "bucket",
    "stack",
    ...(options.purge ? ["ssm"] : []),
    ...(options.delete_snapshots ? ["snapshots"] : []),
    ...(options.delete_volumes ? ["volumes"] : []),
    ...(options.reset_local ? ["local"] : []),
    "done",
  ];
}

/**
 * `foundation.update`'s phases, in order (§6.6). The list is core's — it is
 * `foundationPhases()` in `packages/core/src/schema/foundation.ts`, which is the
 * source of truth — but the UI may not import core (§3.1), so it is spelled here
 * and pinned by `test/foundation-phases.test.ts`.
 */
export function foundationPhases(): string[] {
  return ["preflight", "archive", "stack", "artifacts", "migrate", "rollout", "done"];
}

/**
 * `apply` of a `network` plan, in core's order (§5, `packages/core/src/network.ts`'s
 * `PHASE`). Spelled here for the same reason `foundationPhases` is — the UI may
 * not import core (§3.1) — and pinned by `test/network.test.ts`.
 *
 * Four of the five names are shared with other ops and mean something else in
 * them, so the drawer passes its own `labels` rather than widening the shared
 * table: `preflight` here is the fleet lock and the fck-nat AMI, not this
 * machine's tailnet.
 */
export function networkPhases(): string[] {
  return ["preflight", "archive", "stack", "stamp", "drift", "done"];
}

/**
 * The fallback table: `init`, `teardown` and `foundation.update` read their
 * steps from here, and so does any phase an op emits that its own map does not
 * name (`resume`, which only a resumed create ever says). The lifecycle rails do
 * not — they pass the maps above, because the create wording several of these
 * entries carry is exactly wrong for a destroy.
 */
const PHASE_LABELS: Record<string, string> = {
  validate: "Validate name and claim the row",
  resume: "Resume the interrupted create",
  secrets: "Mint the tailscale key into SSM",
  render: "Render config and manifest",
  volume: "Allocate the data volume",
  instance: "Launch the EC2 instance and attach its data volume",
  handoff: "Wait for hermeticd's first report",
  plan: "Plan the change",
  config: "Remove config objects",
  upload: "Upload rendered config",
  identity: "Resolve caller identity",
  preflight: "Check this machine's tailnet",
  archive: "Archive the current foundation",
  migrate: "Run foundation migrations and stamp _fleet",
  rollout: "Ask every agent to take the new hermeticd",
  artifacts: "Publish the hermeticd artifact",
  attach: "Attach to the existing fleet",
  stack: "Update the foundation stack",
  foundation: "Create the CloudFormation stack",
  tailscale: "Store the Tailscale OAuth secret",
  policy: "Write hermetic's blocks into the tailnet policy",
  ami: "Pin the Ubuntu arm64 image",
  fleet: "Write the _fleet item",
  ready: "Check the fleet can launch an agent",
  agents_check: "Refuse if any agent still exists",
  bucket: "Empty the fleet bucket",
  ssm: "Delete SSM parameters",
  snapshots: "Delete DLM snapshots",
  volumes: "Delete leftover data volumes",
  local: "Reset the local config",
  done: "Done",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase.replace(/[:_-]/g, " ");
}

export interface OpStep {
  phase: string;
  label: string;
  state: "done" | "current" | "pending";
  time: string;
  /**
   * When the current step began, for a live timer: the server's `at` of its
   * `start` event (else its first event) when that clock is plausible, else
   * the moment this browser received it. The fallback covers the fixture
   * backend's frozen clock and any real skew between server and browser.
   */
  startedAt: string | null;
}

/** A server timestamp within a day of local time is trusted for elapsed math. */
const PLAUSIBLE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Which phase is running, from the events so far. A phase with a `start` is
 * open until its own `done` or until another phase speaks (phases are
 * sequential), and stays current through its own progress lines and through
 * silence. Streams without kinds (older cores, short ops) fall back to the
 * last phase seen — which is what misnamed the current step during a
 * three-minute stack create, and why `kind` exists.
 */
export function currentPhaseOf(events: readonly OpEvent[]): string | null {
  let open: string | null = null;
  for (const e of events) {
    if (open !== null && e.phase !== open) open = null;
    if (e.kind === "start") open = e.phase;
    else if (e.kind === "done" && open === e.phase) open = null;
  }
  if (open !== null) return open;
  const last = events[events.length - 1];
  return last?.phase ?? null;
}

export interface OpState {
  events: OpEvent[];
  steps: OpStep[];
  percent: number;
  running: boolean;
  finished: boolean;
  ok: boolean;
  error: { code: string; message: string } | null;
}

/**
 * `phaseLabel`'s table is shared by every op, and a few phase names mean
 * different things in different ones — `preflight` is the Tailscale check in
 * `init` and the guards-and-fleet-lock step in `foundation.update`. An op with
 * its own reading of a shared name passes it here rather than renaming the
 * phase or making the shared table vaguer. Pass a module-level constant: it is
 * a memo dependency.
 */
export function useOp(
  opId: string | null,
  seedPhases: readonly string[] = [],
  labels: Readonly<Record<string, string>> = NO_LABELS,
): OpState {
  const [events, setEvents] = useState<OpEvent[]>([]);
  // Local receipt time per event object, for the timer fallback above.
  const receivedAt = useRef(new WeakMap<OpEvent, number>());
  const [finished, setFinished] = useState(false);
  const [ok, setOk] = useState(true);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    if (!opId) return;
    if (current.current !== opId) {
      current.current = opId;
      setEvents([]);
      setFinished(false);
      setOk(true);
      setError(null);
    }
    const stop = followOp(
      opId,
      (e) => {
        receivedAt.current.set(e, Date.now());
        setEvents((prev) => [...prev, e]);
      },
      (okay, err) => {
        setFinished(true);
        setOk(okay);
        setError(err);
      },
    );
    return stop;
  }, [opId]);

  return useMemo<OpState>(() => {
    const seen: string[] = [];
    const firstAt = new Map<string, number>();
    const lastAt = new Map<string, number>();
    const startAt = new Map<string, number>();
    const doneAt = new Map<string, number>();
    const beganLocal = new Map<string, number>();
    for (const e of events) {
      if (!seen.includes(e.phase)) seen.push(e.phase);
      const t = Date.parse(e.at);
      if (!firstAt.has(e.phase)) firstAt.set(e.phase, t);
      lastAt.set(e.phase, t);
      if (e.kind === "start" && !startAt.has(e.phase)) startAt.set(e.phase, t);
      if (e.kind === "done") doneAt.set(e.phase, t);
      const local = receivedAt.current.get(e);
      if (local !== undefined && (e.kind === "start" || !beganLocal.has(e.phase)))
        beganLocal.set(e.phase, local);
    }
    const order = [...seedPhases];
    for (const p of seen) if (!order.includes(p)) order.push(p);

    const currentPhase = finished ? null : currentPhaseOf(events);
    const steps: OpStep[] = order.map((phase) => {
      const reached = seen.includes(phase);
      const state: OpStep["state"] = finished
        ? reached
          ? "done"
          : "pending"
        : phase === currentPhase
          ? "current"
          : reached
            ? "done"
            : "pending";
      let time = "";
      let startedAt: string | null = null;
      if (state === "current") {
        time = "…";
        const server = startAt.get(phase) ?? firstAt.get(phase);
        const local = beganLocal.get(phase);
        const began =
          server !== undefined &&
          Number.isFinite(server) &&
          Math.abs(Date.now() - server) < PLAUSIBLE_SKEW_MS
            ? server
            : local;
        if (began !== undefined) startedAt = new Date(began).toISOString();
      } else if (reached) {
        // A start/done pair is the phase's own measurement; otherwise it is
        // the gap to the next phase's first word, as before.
        const idx = seen.indexOf(phase);
        const next = seen[idx + 1];
        const start = startAt.get(phase) ?? firstAt.get(phase);
        const end = doneAt.get(phase) ?? (next ? firstAt.get(next) : lastAt.get(phase));
        if (start !== undefined && end !== undefined && end >= start) {
          time = `${((end - start) / 1000).toFixed(1)}s`;
        }
      }
      return { phase, label: labels[phase] ?? phaseLabel(phase), state, time, startedAt };
    });

    const last = events[events.length - 1];
    const percent = finished
      ? ok
        ? 100
        : Math.round((last?.progress ?? 0) * 100)
      : Math.round((last?.progress ?? 0) * 100);

    return {
      events,
      steps,
      percent,
      running: opId !== null && !finished,
      finished,
      ok,
      error,
    };
  }, [events, finished, ok, error, opId, seedPhases, labels]);
}
