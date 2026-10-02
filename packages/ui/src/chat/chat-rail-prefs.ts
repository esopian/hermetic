/**
 * The chat rail's layout preferences: which bots are pinned to the top and
 * which instance buckets are folded shut.
 *
 * Both belong to this laptop, not the fleet — they are how one operator reads
 * the rail, and a second laptop on the same fleet has its own habits. They are
 * keyed by `fleet_id` all the same: `veronica/default` on one fleet is not the
 * same conversation as `veronica/default` on another, and a pin that followed a
 * fleet switch would point at whichever bot happened to share the name.
 *
 * Folding a bucket hides its rows, never its signal: the header still carries
 * the bucket's unread and needs-you counts, and the bots in it keep notifying.
 * That is the whole difference between collapsing an instance and not
 * listening to it.
 */
import { useSyncExternalStore } from "react";

export const CHAT_RAIL_PREFS_KEY = "hermetic.chat.rail";
const CHANGED = "hermetic:chat-rail-prefs";

export interface RailPrefs {
  /** `instance/bot` keys, in the order they were pinned. */
  pinned: string[];
  /** Instances whose bucket is folded shut. */
  collapsed: string[];
}

const EMPTY: RailPrefs = { pinned: [], collapsed: [] };

export function railKey(instance: string, bot: string): string {
  return `${instance}/${bot}`;
}

/** A denied write must not undo a choice that can still apply to this open page. */
const volatile = new Map<string, RailPrefs>();
/**
 * `useSyncExternalStore` compares snapshots by identity, so a parse per read
 * would re-render forever. One parsed value per raw string.
 */
const parsed = new Map<string, { raw: string | null; prefs: RailPrefs }>();

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string"))]
    : [];
}

function storageKey(fleetId: string): string {
  return `${CHAT_RAIL_PREFS_KEY}.${fleetId}`;
}

export function readRailPrefs(fleetId: string): RailPrefs {
  const held = volatile.get(fleetId);
  if (held) return held;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(fleetId));
  } catch {
    return EMPTY;
  }
  const cached = parsed.get(fleetId);
  if (cached && cached.raw === raw) return cached.prefs;
  let prefs = EMPTY;
  if (raw !== null) {
    // Written by this page or an older build of it; anything unreadable is
    // treated as no preference rather than a broken rail.
    try {
      const doc = JSON.parse(raw) as Partial<Record<keyof RailPrefs, unknown>> | null;
      prefs = { pinned: strings(doc?.pinned), collapsed: strings(doc?.collapsed) };
    } catch {
      prefs = EMPTY;
    }
  }
  parsed.set(fleetId, { raw, prefs });
  return prefs;
}

function writeRailPrefs(fleetId: string, prefs: RailPrefs): void {
  try {
    window.localStorage.setItem(storageKey(fleetId), JSON.stringify(prefs));
    volatile.delete(fleetId);
  } catch {
    volatile.set(fleetId, prefs);
  }
  window.dispatchEvent(new Event(CHANGED));
}

function toggled(list: readonly string[], item: string): string[] {
  return list.includes(item) ? list.filter((v) => v !== item) : [...list, item];
}

export function togglePinned(fleetId: string, instance: string, bot: string): void {
  const prefs = readRailPrefs(fleetId);
  writeRailPrefs(fleetId, { ...prefs, pinned: toggled(prefs.pinned, railKey(instance, bot)) });
}

export function toggleCollapsed(fleetId: string, instance: string): void {
  const prefs = readRailPrefs(fleetId);
  writeRailPrefs(fleetId, { ...prefs, collapsed: toggled(prefs.collapsed, instance) });
}

function subscribe(changed: () => void): () => void {
  const stored = (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith(CHAT_RAIL_PREFS_KEY)) return;
    volatile.clear();
    changed();
  };
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", stored);
  };
}

export function useRailPrefs(fleetId: string): RailPrefs {
  return useSyncExternalStore(
    subscribe,
    () => readRailPrefs(fleetId),
    () => EMPTY,
  );
}

/**
 * What a folded bucket's header still says. A needs-you bot outranks unread
 * ones, the way it does on a row: the `!` is the badge, and the count is only
 * drawn when nothing is waiting on the operator.
 */
export function bucketSignal<B extends { needs_action: boolean }>(
  bots: readonly B[],
  unreadOf: (bot: B) => number,
): { unread: number; needs: number } {
  let unread = 0;
  let needs = 0;
  for (const bot of bots) {
    if (bot.needs_action) needs += 1;
    unread += unreadOf(bot);
  }
  return { unread, needs };
}
