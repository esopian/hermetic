/**
 * Which webview renderer a build gets: CEF in development, the system WebKit
 * (WKWebView on macOS, WebKitGTK on Linux) in a release.
 *
 * A release ships the system WebKit (WKWebView on macOS, WebKitGTK on Linux) —
 * it is what the app is designed and
 * signed against, and bundling Chromium would add a few hundred megabytes to a
 * download that has no use for it. Development defaults to CEF for one reason:
 * Chromium speaks the DevTools protocol, so a coding agent (or Playwright, or
 * `bun run app:cdp`) can attach to the running window on loopback, read its
 * console, evaluate script, take screenshots and click. WKWebView offers none
 * of that outside Safari's Web Inspector, which only a person can drive.
 *
 * The cost is a second renderer, and the rule that pays for it is in
 * `AGENTS.md` ("Renderers"): the page is written for WebKit, nothing branches
 * on the renderer, and a visual or behavioural check is final only on
 * `HERMETIC_RENDERER=native`.
 *
 * `electrobun.config.ts` is evaluated by Hutch with `ELECTROBUN_BUILD_ENV` set
 * to the build environment (`dev`, `canary`, `stable`), so the choice is made
 * here, per build, with no per-environment block in the config to forget. Any
 * environment that is not `dev` — an unset one included — gets the native
 * renderer and no CEF, and asking for CEF there is a build failure rather than
 * a release that quietly ships Chromium.
 *
 * Linux follows the same contract: a dev build defaults to CEF, for the same
 * DevTools reason, and `HERMETIC_RENDERER=native` opts out to WebKitGTK. A
 * Linux release, like a Mac one, never bundles CEF, and a non-dev build that
 * asks for it fails.
 *
 * Nothing here imports the devkit, so a test drives it with a plain env.
 */

/** Set by Hutch while it evaluates the config. */
export const BUILD_ENV = "ELECTROBUN_BUILD_ENV";

/**
 * `cef` or `native`. Honoured only in a dev build, where the default is `cef`
 * on a Mac and on Linux.
 */
export const RENDERER_ENV = "HERMETIC_RENDERER";

/** The DevTools port a dev CEF build listens on, on 127.0.0.1. */
export const CDP_PORT_ENV = "HERMETIC_CDP_PORT";

export const DEFAULT_CDP_PORT = 9333;

export type Renderer = "native" | "cef";

/** The renderer keys of `ElectrobunConfig["build"]["mac"]` and `["linux"]`. */
export interface RendererKeys {
  bundleCEF: boolean;
  defaultRenderer: Renderer;
  chromiumFlags?: Record<string, string | boolean>;
}

const NATIVE: RendererKeys = { bundleCEF: false, defaultRenderer: "native" };

function requested(env: Record<string, string | undefined>): Renderer | undefined {
  const raw = env[RENDERER_ENV]?.trim() ?? "";
  if (raw === "") return undefined;
  if (raw === "cef" || raw === "native") return raw;
  throw new Error(`${RENDERER_ENV} must be "cef" or "native", not "${raw}"`);
}

/** The DevTools port from the environment, or the default. */
export function cdpPort(env: Record<string, string | undefined>): number {
  const raw = env[CDP_PORT_ENV]?.trim() ?? "";
  if (raw === "") return DEFAULT_CDP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${CDP_PORT_ENV} must be a port from 1024 to 65535, not "${raw}"`);
  }
  return port;
}

// The two wrappers exist to name the two config keys; they do not differ.

/** The renderer keys for `build.mac`: CEF by default in a dev build. */
export function macRenderer(env: Record<string, string | undefined>): RendererKeys {
  return rendererKeys(env);
}

/** The renderer keys for `build.linux`: CEF by default in a dev build. */
export function linuxRenderer(env: Record<string, string | undefined>): RendererKeys {
  return rendererKeys(env);
}

function rendererKeys(env: Record<string, string | undefined>): RendererKeys {
  const buildEnv = env[BUILD_ENV] ?? "";
  const asked = requested(env);
  if (buildEnv !== "dev") {
    if (asked === "cef") {
      throw new Error(
        `${RENDERER_ENV}=cef is for dev builds only; a ${buildEnv || "non-dev"} build ships the native renderer`,
      );
    }
    return NATIVE;
  }
  if (asked === "native") return NATIVE;
  return {
    bundleCEF: true,
    defaultRenderer: "cef",
    // Pinned rather than Electrobun's automatic dev port, so a driver knows
    // where to attach without reading the app's stdout. CEF binds it to
    // 127.0.0.1 only.
    chromiumFlags: { "remote-debugging-port": String(cdpPort(env)) },
  };
}
