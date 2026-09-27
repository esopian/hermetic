/**
 * The dev channel's shell hook.
 *
 * A built app has no terminal to drive it from: the manual check list — does
 * the board render, does an op rail appear, does a chat turn stream and abort,
 * does an external link reach the browser — is a person clicking. This hook is
 * the one seam that lets a shell script do the clicking instead: a dev build
 * launched with `HERMETIC_DEV_SCRIPT=/path/to/probe.ts` imports that module
 * after the window is up and calls its default export with the same `dispatch`
 * the RPC binding calls and the window whose webview it can script.
 *
 * Two things keep it honest. It is inert unless the bundle's channel is `dev`,
 * so a release build cannot be talked into loading a file by an environment
 * variable; and running it writes a `warn` line, so a log from a build that
 * somehow did run one says so rather than reading like an ordinary session.
 *
 * Nothing here imports the devkit: the window is whatever the caller hands
 * over, which is what makes this module testable with a fake loader.
 */
import { pathToFileURL } from "node:url";
import type { AppLog } from "../log.ts";

/** The channel a bundle must be on for the hook to exist at all. */
export const DEV_CHANNEL = "dev";

/** The variable naming the module to load. Empty or unset means no probe. */
export const DEV_SCRIPT_ENV = "HERMETIC_DEV_SCRIPT";

/**
 * What a probe module is handed.
 *
 * `dispatch` is the handler-table entry point (`handlers/dispatch.ts`) with the
 * window's context already bound, `sink` included — a probe can therefore drive
 * a streaming method (`chat.observe`, an op) and read its frames directly,
 * without the RPC layer's per-window subscription plumbing in the way.
 */
export interface DevProbeApi<Window> {
  dispatch(name: string, params?: unknown, sink?: (frame: unknown) => void): Promise<unknown>;
  /** The main window, so a probe can `window.webview.executeJavascript(...)`. */
  window: Window;
  log: AppLog;
  env: Record<string, string | undefined>;
}

/** The shape a probe module's default export must have. */
export type DevProbe<Window> = (api: DevProbeApi<Window>) => unknown;

export interface DevProbeOptions<Window> {
  /** `Updater.localInfo.channel()` — anything but `dev` and nothing happens. */
  channel: string;
  env: Record<string, string | undefined>;
  /** Injected so a test never has to write a module to disk. */
  load(href: string): Promise<unknown>;
  api: DevProbeApi<Window>;
  log: AppLog;
}

function defaultExport<Window>(module: unknown): DevProbe<Window> | null {
  if (typeof module === "function") return module as DevProbe<Window>;
  if (typeof module !== "object" || module === null) return null;
  const value = (module as { default?: unknown }).default;
  return typeof value === "function" ? (value as DevProbe<Window>) : null;
}

/**
 * Loads and runs the probe, if this build may have one.
 *
 * Returns whether a probe ran, which is what a test asserts on. A probe that
 * throws — synchronously or from its promise — is logged and swallowed: the
 * hook exists to observe the app, and an app that dies because its observer
 * did is worse than no observation.
 */
export async function installDevProbe<Window>(options: DevProbeOptions<Window>): Promise<boolean> {
  if (options.channel !== DEV_CHANNEL) return false;
  const path = options.env[DEV_SCRIPT_ENV]?.trim();
  if (path === undefined || path === "") return false;

  options.log.line("warn", "dev-probe", "running dev probe script", { path, channel: options.channel });

  try {
    const module = await options.load(pathToFileURL(path).href);
    const probe = defaultExport<Window>(module);
    if (probe === null) {
      options.log.line("warn", "dev-probe", "module has no callable default export", { path });
      return false;
    }
    await probe(options.api);
    options.log.line("info", "dev-probe", "dev probe finished", { path });
    return true;
  } catch (e: unknown) {
    options.log.line(
      "error",
      "dev-probe",
      `dev probe failed: ${e instanceof Error ? e.message : String(e)}`,
      {
        path,
      },
    );
    return false;
  }
}
