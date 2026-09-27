import { z } from "zod";
import {
  BROWSER_CDP_PORT_BASE,
  BROWSER_DISPLAY_BASE,
  BROWSER_NAME,
  BROWSER_PROFILE_ROOT,
  BROWSER_RFB_PORT_BASE,
  BROWSER_WS_PORT_BASE,
  DEFAULT_BROWSER_NAME,
  browserServePath,
} from "../shared/browser.ts";
export {
  BROWSER_NAME,
  DEFAULT_BROWSER_NAME,
  BROWSER_DISPLAY_BASE,
  BROWSER_CDP_PORT_BASE,
  BROWSER_RFB_PORT_BASE,
  BROWSER_WS_PORT_BASE,
  BROWSER_PROFILE_ROOT,
  BROWSER_SERVE_ROOT,
  browserServePath,
  CHROME_INSTALL_ROOT,
  CHROME_ZIP_ROOT_DIR,
  chromeBinaryPath,
  chromeInstallDir,
} from "../shared/browser.ts";

export const BrowserIdentity = z.object({
  name: z.string().regex(BROWSER_NAME),
  /** X display number: `DISPLAY=:<display>`. */
  display: z.number().int().nonnegative(),
  /** Chrome's `--remote-debugging-port`, loopback only, never published. */
  cdp_port: z.number().int().positive(),
  /** x11vnc's `-rfbport`, loopback only. */
  rfb_port: z.number().int().positive(),
  /** websockify's listen port, loopback only; the Serve route's target. */
  ws_port: z.number().int().positive(),
  /** `--user-data-dir`: on the data volume, so it survives a recreate. */
  profile_dir: z.string().min(1),
  /** The Tailscale Serve path noVNC is published under: `/vnc` for `default`. */
  serve_path: z.string().min(1),
});
export type BrowserIdentity = z.infer<typeof BrowserIdentity>;

/** The identity at index `i` under the allocation rule above. */
export function browserIdentity(name: string, index: number): BrowserIdentity {
  return BrowserIdentity.parse({
    name,
    display: BROWSER_DISPLAY_BASE + index,
    cdp_port: BROWSER_CDP_PORT_BASE + index,
    rfb_port: BROWSER_RFB_PORT_BASE + index,
    ws_port: BROWSER_WS_PORT_BASE + index,
    profile_dir: `${BROWSER_PROFILE_ROOT}/${name}`,
    serve_path: browserServePath(name),
  });
}

/**
 * The identities every agent runs: exactly `[default]` today.
 *
 * A function returning a constant, rather than the constant, because the list is
 * where a second identity arrives (§H of plan `0016`) and every caller should
 * already be reading a list it did not choose the length of.
 *
 * It used to take a boolean, and there used to be agents with no identities at
 * all. There are not any more: the browser is part of what an agent *is*, not an
 * option on one, so there is no longer a shape of agent this can return empty
 * for.
 */
export function browserIdentities(): BrowserIdentity[] {
  return [browserIdentity(DEFAULT_BROWSER_NAME, 0)];
}
