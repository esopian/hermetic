/**
 * The desktop head's own requests about this build (`app/src/handlers/app.ts`):
 * what it is, and an update check. A head with no desktop behind it refuses
 * both `UNSUPPORTED`.
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
 * One interactive check, now. The outcome is not the answer: it arrives as an
 * `app.update` push (`state/app-update-state.tsx`), and a newer release also
 * raises the native "open the release page?" box before this resolves.
 */
export function checkForUpdate(): Promise<{ checked: true }> {
  return transport().request<{ checked: true }>("app.checkForUpdate", {});
}
