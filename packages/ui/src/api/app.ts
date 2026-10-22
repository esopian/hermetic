/**
 * The desktop head's own requests about this build (`app/src/handlers/app.ts`):
 * what it is, an update check, and installing a verified update. A head with
 * no desktop behind it refuses each `UNSUPPORTED`.
 */
import { transport } from "./transport.ts";

/** `app.info`: the bundle's version and channel, and where a newer build is downloaded. */
export interface AppInfo {
  version: string;
  channel: string;
  home: string;
  logPath: string | null;
  releasesUrl: string;
}

export function appInfo(): Promise<AppInfo> {
  return transport().request<AppInfo>("app.info", {});
}

/**
 * One interactive check, now. The outcome is not the answer: it arrives as
 * `app.update` pushes (`state/app-update-state.tsx`). A newer release is
 * downloaded and verified, and raises the native "restart now?" box (or, if it
 * could not be verified, "open the release page?") before this resolves.
 */
export function checkForUpdate(): Promise<{ checked: true }> {
  return transport().request<{ checked: true }>("app.checkForUpdate", {});
}

/**
 * Installs the downloaded, verified update and restarts the app. `started` is
 * false when nothing verified is waiting; a started install quits the app, so
 * the answer may never arrive.
 */
export function installUpdate(): Promise<{ started: boolean }> {
  return transport().request<{ started: boolean }>("app.installUpdate", {});
}
