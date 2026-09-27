/**
 * The last `doctor` run (§6.5), held once for the whole page.
 *
 * Two places run it — the env strip's fleet popover and Settings › Diagnostics
 * — and each used to keep its own answer, so a run in one left the other still
 * saying "doctor not run". The answer is about the fleet, not about the button
 * that asked, so it lives here, in one module-level holder, and both read it.
 *
 * Keyed on the fleet: the held run remembers the target it was asked against
 * (`fleetTarget()` at request time), and `useDoctor` hands back nothing when
 * the open fleet is another one — a checklist for `main` under `staging` would
 * be a wrong answer, not a stale one. Only the newest request may write, so a
 * slow reply for a fleet the page has since left cannot land over a newer one.
 */
import { useSyncExternalStore } from "react";
import { fleetTarget, getDoctor, sameFleetTarget } from "../api/index.ts";
import type { Doctor, FleetTarget } from "../api/index.ts";

export interface DoctorSnapshot {
  /** The last good report. A failed re-run keeps it, under the error. */
  doctor: Doctor | null;
  busy: boolean;
  /** The last run's failure, if it failed. */
  error: string | null;
}

interface Held extends DoctorSnapshot {
  /** The fleet the held run was asked against. */
  target: FleetTarget | null;
}

const EMPTY: DoctorSnapshot = { doctor: null, busy: false, error: null };
const NONE: Held = { ...EMPTY, target: null };

let held: Held = NONE;
let request = 0;
const listeners = new Set<() => void>();

function publish(next: Held): void {
  held = next;
  for (const l of listeners) l();
}

/**
 * Run doctor against the open fleet. A run for another fleet than the held one
 * starts from nothing, so its last good report is never shown as this one's.
 */
export function runDoctor(): void {
  const mine = ++request;
  const target = fleetTarget();
  const same = sameFleet(held.target, target);
  publish({ doctor: same ? held.doctor : null, busy: true, error: null, target });
  getDoctor().then(
    (doctor) => {
      if (mine === request) publish({ doctor, busy: false, error: null, target });
    },
    (e: unknown) => {
      if (mine === request)
        publish({ ...held, busy: false, error: e instanceof Error ? e.message : String(e) });
    },
  );
}

/**
 * `sameFleetTarget`, except that two nulls match: a window that does not know
 * its target yet still sends the run, and must still be shown its answer.
 */
function sameFleet(a: FleetTarget | null, b: FleetTarget | null): boolean {
  return (a === null && b === null) || sameFleetTarget(a, b);
}

function getSnapshot(): Held {
  return held;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The held run, or nothing when it was for another fleet than the open one. */
export function useDoctor(): DoctorSnapshot {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return sameFleet(current.target, fleetTarget()) ? current : EMPTY;
}

/** Back to nothing run, with any reply in flight dropped. Tests only. */
export function resetDoctorStore(): void {
  request++;
  publish(NONE);
}
