import { useEffect, useLayoutEffect, useRef } from "react";
import { App } from "./App.tsx";
import { NotifyProvider } from "./state/notify-state.tsx";
import { useFleet } from "./state/state.tsx";
import { isInitialized } from "./api/index.ts";
import { ListeningProvider } from "./state/listening-state.tsx";
import { markPageInactive } from "./lib/visibility.ts";

/** Notification caches and chat URLs belong to the same fleet lifetime. */
export function Portal() {
  const fleet = useFleet();
  const identity = JSON.stringify([
    fleet.meta?.config?.account_id,
    fleet.meta?.config?.region,
    fleet.meta?.fleet?.id ?? fleet.meta?.config?.fleet_id,
  ]);
  // Every CSS animation in the page pauses while the window is not in front
  // (`styles/polish.css`). Held by the portal rather than installed once by the
  // entry, so that unmounting the page takes its listeners with it.
  useEffect(() => markPageInactive(), []);
  const previousFleet = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!fleet.meta?.config?.fleet_id) return;
    if (
      previousFleet.current !== null &&
      previousFleet.current !== identity &&
      window.location.hash.startsWith("#chat/")
    ) {
      // This owner outlives the keyed inbox and App. Clear the old route before
      // their new passive effects can resolve it against another fleet.
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#chat`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    previousFleet.current = identity;
  }, [identity, fleet.meta?.config?.fleet_id]);
  return (
    <ListeningProvider key={identity} enabled={isInitialized(fleet.meta)}>
      <NotifyProvider>
        <App />
      </NotifyProvider>
    </ListeningProvider>
  );
}
