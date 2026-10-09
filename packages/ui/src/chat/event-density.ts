/**
 * The per-thread "background events" density, kept in this browser.
 *
 * One `localStorage` document for every thread rather than a key per thread:
 * only the threads switched to "failures only" are written, and switching back
 * to the default deletes the entry, so the document stays as small as the set
 * of threads somebody actually changed. A thread is named by the whole address
 * — fleet, instance, bot, session — because two fleets can both have a
 * `kestrel`, and two sessions with one bot are two different transcripts.
 */
import { useCallback, useEffect, useState } from "react";
import type { EventDensity } from "./process-events.ts";

export const EVENT_DENSITY_KEY = "hermetic.chat.event-density";

export function densityThreadKey(
  fleetId: string,
  instance: string,
  bot: string,
  session: string | null | undefined,
): string {
  return [fleetId, instance, bot, session ?? ""].map(encodeURIComponent).join("/");
}

function readAll(): Record<string, EventDensity> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(EVENT_DENSITY_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, EventDensity>)
      : {};
  } catch {
    // No storage, or a document that is not JSON: every thread is at the default.
    return {};
  }
}

export function loadEventDensity(thread: string): EventDensity {
  return readAll()[thread] === "failures" ? "failures" : "compact";
}

export function saveEventDensity(thread: string, density: EventDensity): void {
  const all = readAll();
  if (density === "failures") all[thread] = density;
  else delete all[thread];
  try {
    window.localStorage.setItem(EVENT_DENSITY_KEY, JSON.stringify(all));
  } catch {
    /* private mode: the choice holds for this page and does not persist */
  }
}

/** The density for one thread, re-read whenever the thread changes. */
export function useEventDensity(thread: string): [EventDensity, (density: EventDensity) => void] {
  const [state, setState] = useState(() => ({ thread, density: loadEventDensity(thread) }));
  useEffect(() => {
    if (state.thread !== thread) setState({ thread, density: loadEventDensity(thread) });
  }, [thread, state.thread]);
  const set = useCallback(
    (density: EventDensity) => {
      saveEventDensity(thread, density);
      setState({ thread, density });
    },
    [thread],
  );
  // Read through the thread the state was loaded for, so the frame between a
  // thread switch and the effect above never shows the old thread's choice.
  return [state.thread === thread ? state.density : loadEventDensity(thread), set];
}
