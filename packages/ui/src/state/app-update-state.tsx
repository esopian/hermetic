/**
 * The updater's state, as one line in the footer.
 *
 * The main process broadcasts `app.update` at every open window
 * (`app/src/main/updates.ts`) and the RPC transport hands each one to
 * `emitAppUpdate` below. This module is the rest of it: the held value, the
 * subscription, and the one sentence each status is worth.
 *
 * It reaches the footer as a prop (`App.tsx` passes `<AppUpdateNotice />` to
 * `<Footer update={…}>`). It used to be portalled in from the provider, which
 * meant it depended on `.footer` existing in the document and on a second
 * render pass to find it; plain composition says the same thing with nothing to
 * look up and nothing to race.
 */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
// Type-only, and deliberately so: this module is in the browser bundle's graph
// and `transport-rpc.ts` must not be. It imports `electrobun/view`, which
// resolves only behind `views://` — Bun's bundler cannot even find it — so the
// dependency runs the other way at runtime: the transport imports `emitAppUpdate`
// from here. An `import type` is erased before anything is resolved.
import type { AppUpdate } from "../api/transport-rpc.ts";

export type { AppUpdate };

const listeners = new Set<(update: AppUpdate) => void>();

/**
 * The last `app.update` seen, replayed to a late subscriber.
 *
 * The push is a broadcast on a six-hour timer (`main/updates.ts`,
 * `UPDATE_INTERVAL_MS`), not an answer to a request, so the first one can
 * easily land before the footer has mounted. Holding one value is the whole
 * difference between an update notice that shows up and one that does not.
 */
let last: AppUpdate | null = null;

/** Called by the RPC transport for every `app.update` push. */
export function emitAppUpdate(update: AppUpdate): void {
  last = update;
  for (const listener of [...listeners]) listener(update);
}

/** Subscribe; the current state arrives immediately if there is one. */
export function onAppUpdate(listener: (update: AppUpdate) => void): () => void {
  listeners.add(listener);
  if (last !== null) listener(last);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forget the held update. Only a test has a reason to: a page lives as long as
 * the window, and the state it describes outlives any one transport.
 */
export function clearAppUpdate(): void {
  last = null;
}

/**
 * What the footer says for a status, or nothing.
 *
 * `none` is the common case by far — checked, nothing newer — and a footer that
 * says "up to date" every six hours is noise. An unknown status is treated the
 * same way: `app.update` types its status as a plain string, and a main process
 * from a newer build saying something this one has never heard of should draw
 * nothing rather than draw the word raw.
 */
export function appUpdateText(update: AppUpdate | null): string | null {
  if (update === null) return null;
  const version = update.version === undefined ? "" : ` v${update.version}`;
  switch (update.status) {
    // The app never installs an update itself (`app/src/main/updates.ts`): an
    // available one is a release page to visit, not a download in progress.
    case "available":
      return `Update${version} available`;
    case "error":
      return "Update check failed";
    default:
      return null;
  }
}

/** The last `app.update`, or null until one arrives. */
export function useAppUpdate(): AppUpdate | null {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  useEffect(() => onAppUpdate(setUpdate), []);
  return update;
}

/**
 * The footer's update line, or nothing.
 *
 * A status worth no sentence draws nothing at all, which is the common case:
 * `none` means "checked, nothing newer", and a footer that says "up to date"
 * every six hours is noise. A page with no footer never renders this at all —
 * the init wizard has no `<Footer>` to pass it to.
 */
export function AppUpdateNotice(): ReactElement | null {
  const update = useAppUpdate();
  const text = appUpdateText(update);
  // `appUpdateText(null)` is null, so a sentence implies an update — but that
  // is a fact about the other function, and `data-app-update` below reads the
  // record directly. Narrowing it here says so to the compiler and to a reader.
  if (update === null || text === null) return null;
  return (
    <span className="foot-tick" data-app-update={update.status}>
      <i className="tick-dot" style={{ background: "var(--acc)" }} />
      {text}
    </span>
  );
}
