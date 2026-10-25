/**
 * Several paired fleets, one in front (`fleets.ts`). It reads the list and
 * renders `FleetProvider` for the active fleet, keyed by its id: switching
 * fleets remounts the provider and the stack under it, so the app comes back
 * at its entry route for the other fleet, the way a multi-account app switches
 * accounts. Nothing renders until the list is read; a read the locked keychain
 * refused is tried again once the app is in front.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type FleetDeps, FleetProvider, type FleetSwitcher } from "./FleetProvider.tsx";
import { type FleetIndex, loadFleets, saveFleets, withFleet, withoutFleet } from "./fleets.ts";
import { FleetStore, fleetRecordKey, type TextFile } from "./store.ts";

export interface FleetSwitchDeps extends Omit<FleetDeps, "viewCache" | "inboxFile" | "recordKey"> {
  /** One fleet's view cache and inbox; `null` is the empty state before any pairing. */
  fleetFiles(fleetId: string | null): { viewCache: TextFile; inboxFile: TextFile };
}

export function FleetSwitch({
  deps,
  onOpen,
  onSwitched,
  children,
}: {
  deps: FleetSwitchDeps;
  onOpen?: (href: string) => void;
  /**
   * Another fleet came to the front (or none is left), after the remount: send
   * the stack to its entry route. A remounted navigator can keep its old routes.
   */
  onSwitched?: () => void;
  children: ReactNode;
}) {
  const [index, setIndex] = useState<FleetIndex | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    let live = true;
    let offRetry: (() => void) | null = null;
    const read = () =>
      loadFleets(deps.secure, { operatorTailnet: deps.operatorTailnet }).then(
        (next) => {
          if (live) setIndex(next);
        },
        () => {
          if (!live || offRetry) return;
          // Already in front, so no lock to wait out: try again shortly rather than show nothing.
          if (deps.appState.current() === "active") {
            setTimeout(() => {
              if (live) void read();
            }, 2_000);
            return;
          }
          offRetry = deps.appState.subscribe((state) => {
            if (state !== "active") return;
            offRetry?.();
            offRetry = null;
            void read();
          });
        },
      );
    void read();
    return () => {
      live = false;
      offRetry?.();
    };
  }, [deps]);

  const active = index?.active ?? null;
  const onSwitchedRef = useRef(onSwitched);
  onSwitchedRef.current = onSwitched;
  const shown = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!index) return;
    const before = shown.current;
    shown.current = active;
    if (before !== undefined && before !== active) onSwitchedRef.current?.();
  }, [index, active]);
  // One object per fleet: the provider re-boots whenever its deps change.
  const fleetDeps = useMemo<FleetDeps>(
    () => ({
      ...deps,
      ...deps.fleetFiles(active),
      recordKey: active ? fleetRecordKey(active) : null,
    }),
    [deps, active],
  );

  const switcher = useMemo<FleetSwitcher | null>(() => {
    if (!index) return null;
    const commit = async (next: FleetIndex) => {
      await saveFleets(deps.secure, next);
      setIndex(next);
    };
    const current = () => indexRef.current ?? index;
    return {
      fleets: index.fleets,
      async add(link) {
        const id = link.payload.fleet_id;
        // The fleet's own store keeps a re-scanned fleet's choices, as one pairing always has.
        const store = new FleetStore({
          secure: deps.secure,
          viewCache: deps.fleetFiles(id).viewCache,
          fetch: deps.fetch,
          now: deps.now ?? (() => new Date().toISOString()),
          operatorTailnet: deps.operatorTailnet,
          recordKey: fleetRecordKey(id),
        });
        await store.load();
        await store.pair(link);
        await commit(withFleet(current(), link));
      },
      async switchTo(fleetId) {
        const now = current();
        if (now.active === fleetId || !now.fleets.some((f) => f.fleet_id === fleetId)) return;
        await commit({ ...now, active: fleetId });
      },
      remove: (fleetId) => commit(withoutFleet(current(), fleetId)),
      // The fleet in front re-paired: its label and tailnet may have changed.
      refresh: (link) => commit(withFleet(current(), link)),
    };
  }, [deps, index]);

  if (!index) return null;
  return (
    <FleetProvider key={active ?? "none"} deps={fleetDeps} switcher={switcher} onOpen={onOpen}>
      {children}
    </FleetProvider>
  );
}
