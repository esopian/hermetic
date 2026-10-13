/**
 * The phone's own preferences — haptics, notification delivery, quiet hours —
 * persisted in the same store as the theme. Nothing here leaves the phone:
 * they decide whether this phone interrupts for an event its own sockets saw.
 * Push from the boxes is switched on and off separately (Settings → Push).
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { KvStorage as PrefStorage } from "../fleet/store.ts";
import { inQuietHours, type QuietHours } from "../client/inbox-logic.ts";
import { setHapticsEnabled } from "../ui/haptics.ts";

export interface Prefs {
  haptics: boolean;
  /** Local alerts (system notifications and in-app banners) for socket-delivered events. */
  notifications: boolean;
  quiet: QuietHours;
}

export const DEFAULT_PREFS: Prefs = {
  haptics: true,
  notifications: true,
  quiet: { enabled: false, start: "22:00", end: "07:00" },
};

const PREFS_SLOT = "hermetic.prefs.v1";

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<Prefs>;
    return {
      haptics: typeof v.haptics === "boolean" ? v.haptics : DEFAULT_PREFS.haptics,
      notifications:
        typeof v.notifications === "boolean" ? v.notifications : DEFAULT_PREFS.notifications,
      quiet: {
        enabled: typeof v.quiet?.enabled === "boolean" ? v.quiet.enabled : DEFAULT_PREFS.quiet.enabled,
        start: typeof v.quiet?.start === "string" ? v.quiet.start : DEFAULT_PREFS.quiet.start,
        end: typeof v.quiet?.end === "string" ? v.quiet.end : DEFAULT_PREFS.quiet.end,
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export interface PrefsValue {
  prefs: Prefs;
  update(patch: Partial<Prefs>): void;
  /** Whether a local alert may interrupt right now. */
  mayAlert(now?: Date): boolean;
}

const PrefsContext = createContext<PrefsValue>({
  prefs: DEFAULT_PREFS,
  update: () => {},
  mayAlert: () => true,
});

export function PrefsProvider({ children, storage }: { children: ReactNode; storage?: PrefStorage }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  useEffect(() => {
    let live = true;
    void storage
      ?.get(PREFS_SLOT)
      .then((raw) => {
        if (!live) return;
        const next = parsePrefs(raw);
        setHapticsEnabled(next.haptics);
        setPrefs(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [storage]);

  const update = useCallback(
    (patch: Partial<Prefs>) => {
      setPrefs((current) => {
        const next = { ...current, ...patch, quiet: { ...current.quiet, ...(patch.quiet ?? {}) } };
        setHapticsEnabled(next.haptics);
        void storage?.set(PREFS_SLOT, JSON.stringify(next)).catch(() => {});
        return next;
      });
    },
    [storage],
  );

  const value = useMemo<PrefsValue>(
    () => ({
      prefs,
      update,
      mayAlert: (now = new Date()) => prefs.notifications && !inQuietHours(now, prefs.quiet),
    }),
    [prefs, update],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsValue {
  return useContext(PrefsContext);
}
