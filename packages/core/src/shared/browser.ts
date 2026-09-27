/**
 * The browser stack's fixed points (§7.3): identity names, the port and display
 * allocation bases, where profiles and the mirrored Chrome build live on the
 * box, and the Serve path an identity is published under.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

/**
 * One browser identity on an agent (§7.3): a headed Chrome
 * owned by `hermetic-browser@<name>.service`, drawing on its own X display,
 * watched over its own x11vnc/websockify pair, published at its own Serve
 * path. The agent runs exactly one today, named `default`; the shape is a
 * list so a second identity is a data change rather than a redesign.
 *
 * Every number here is derived from the identity's index by
 * `browserIdentities`, never chosen by hand: display `:99 + i`, CDP `9222 + i`,
 * RFB `5900 + i`, websockify `6080 + i`. The defaults for index 0 are the ports
 * the pre-template units always used, so an agent re-applied after this change
 * keeps the same addresses.
 */
export const BROWSER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const DEFAULT_BROWSER_NAME = "default";
export const BROWSER_DISPLAY_BASE = 99;
export const BROWSER_CDP_PORT_BASE = 9222;
export const BROWSER_RFB_PORT_BASE = 5900;
export const BROWSER_WS_PORT_BASE = 6080;
/** Where every identity's profile lives: `<BROWSER_PROFILE_ROOT>/<name>`. */
export const BROWSER_PROFILE_ROOT = "/data/hermes/browser";
/** The Serve path of the default identity; others nest under it. */
export const BROWSER_SERVE_ROOT = "/vnc";

/** The Serve path one identity is published at (`/vnc`, `/vnc/<name>`). */
export function browserServePath(name: string): string {
  return name === DEFAULT_BROWSER_NAME ? BROWSER_SERVE_ROOT : `${BROWSER_SERVE_ROOT}/${name}`;
}

/** Where a mirrored Chrome for Testing build is unpacked on the box. */
export const CHROME_INSTALL_ROOT = "/opt/hermetic/chrome";

/** The zip's top-level directory, as Playwright's CDN ships it. */
export const CHROME_ZIP_ROOT_DIR = "chrome-linux-arm64";

/** The headed Chrome binary for one pinned build. */
export function chromeBinaryPath(chromeRef: string): string {
  return `${CHROME_INSTALL_ROOT}/${chromeRef}/${CHROME_ZIP_ROOT_DIR}/chrome`;
}

/** The directory `chromeBinaryPath` lives under; the unzip target. */
export function chromeInstallDir(chromeRef: string): string {
  return `${CHROME_INSTALL_ROOT}/${chromeRef}`;
}
