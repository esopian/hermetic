/**
 * This laptop's create presets (§4.6), held once for the whole page.
 *
 * Two places read them — Settings › Create presets edits them, and the create
 * drawer's strip offers the loadout — and they must agree the moment a write
 * lands: rearrange the loadout, open New agent, and the strip is already the
 * new one. So the document lives here, in one module-level holder, rather than
 * in either component's state.
 *
 * Laptop-local, so it is not keyed on the fleet: switching fleets changes
 * nothing about which machines this laptop offers.
 *
 * Until the first read answers — or if it fails — `view` is the built-in
 * document, computed by the same function core answers with
 * (`presetsView(null)` in `@hermetic/core/shared`): no row stored means exactly
 * that, so the fallback is the answer a fresh laptop would get anyway.
 */
import { useEffect, useSyncExternalStore } from "react";
import { presetsView } from "@hermetic/core/shared";
import type { PresetsView } from "@hermetic/core/shared";
import { getPresets, setPresets } from "../api/index.ts";
import type { PresetsSetInput } from "../api/index.ts";

export interface PresetsSnapshot {
  view: PresetsView;
  /** Whether `view` is the laptop's answer rather than the built-in fallback. */
  loaded: boolean;
  /** The last read's failure, when the fallback is showing because of one. */
  error: string | null;
}

const BUILTIN: PresetsSnapshot = { view: presetsView(null), loaded: false, error: null };

let snapshot: PresetsSnapshot = BUILTIN;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: PresetsSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

/** Read the laptop's presets. Concurrent callers share one request. */
export function loadPresets(): Promise<void> {
  if (inflight !== null) return inflight;
  inflight = getPresets()
    .then(
      (view) => publish({ view: view as PresetsView, loaded: true, error: null }),
      (e: unknown) => publish({ ...snapshot, error: e instanceof Error ? e.message : String(e) }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Write a patch and adopt the answer. Rejects on failure, so the caller can
 * say what went wrong where it happened; the held document is left as it was.
 */
export async function savePresets(input: PresetsSetInput): Promise<PresetsView> {
  const view = (await setPresets(input)) as PresetsView;
  publish({ view, loaded: true, error: null });
  return view;
}

function getSnapshot(): PresetsSnapshot {
  return snapshot;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The held document without starting a read — for the Settings rail's count,
 * which (like every rail item) reports only what the page already holds.
 */
export function useHeldPresets(): PresetsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The held document, read by a component, with a read started on first use. */
export function usePresets(): PresetsSnapshot {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    // Every mount re-reads: another laptop cannot write this row, but the CLI
    // on this one can (`hermetic presets set`), and opening the drawer or the
    // page is when a stale loadout would be seen.
    void loadPresets();
  }, []);
  return current;
}

/**
 * Back to the built-ins with nothing read — or, given a document, holding that
 * one as though it had been read. Tests only: the page never forgets.
 */
export function resetPresetsStore(view?: PresetsView): void {
  inflight = null;
  publish(view === undefined ? BUILTIN : { view, loaded: true, error: null });
}
