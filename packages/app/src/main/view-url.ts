/**
 * Which page a window loads: the bundled one, or a hot-reload server's.
 *
 * Electrobun's Vite loop (its hot-reloading guide) keeps the main process up
 * and serves the webview from `http://localhost` instead of `views://`, so a
 * React edit lands in the open window without a relaunch. `scripts/dev-hmr.ts`
 * starts that server and names it in `HERMETIC_VIEW_URL`; this module decides
 * whether to believe it.
 *
 * Three things keep it from being a way to point the app at arbitrary content:
 * it is inert unless the bundle's channel is `dev` (the same gate as
 * `dev-probe.ts`), the URL must be loopback HTTP, and the server must answer
 * before the window opens. Anything else falls back to the bundled page with a
 * `warn` line, so a dev run whose server died still gets a working window — one
 * that is merely not hot.
 *
 * Deliberately explicit rather than the template's "probe :5173 and use it if
 * something answers": 5173 is every Vite project's default, and a window that
 * silently loads another checkout's page is a worse afternoon than no HMR.
 *
 * Nothing here imports the devkit, so a test drives it with a fake probe.
 */
import type { AppLog } from "../log.ts";
import { DEV_CHANNEL } from "./dev-probe.ts";

/** The page the build copies into the bundle (`electrobun.config.ts`). */
export const BUNDLED_VIEW_URL = "views://main/index.html";

/** The variable `scripts/dev-hmr.ts` sets. Empty or unset means no server. */
export const VIEW_URL_ENV = "HERMETIC_VIEW_URL";

/** How long the server gets to answer before the bundled page is used. */
export const PROBE_TIMEOUT_MS = 2_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface ViewUrlOptions {
  /** `Updater.localInfo.channel()`. */
  channel: string;
  env: Record<string, string | undefined>;
  /** Resolves when the URL answered at all; rejects otherwise. */
  probe(url: string, timeoutMs: number): Promise<void>;
  log: AppLog;
}

/** A loopback `http:` URL, or `null` for anything else. */
export function loopbackUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  return url.href;
}

/** The default probe: any HTTP answer counts, a status included. */
export async function fetchProbe(url: string, timeoutMs: number): Promise<void> {
  await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
}

export async function resolveViewUrl(options: ViewUrlOptions): Promise<string> {
  const raw = options.env[VIEW_URL_ENV]?.trim();
  if (raw === undefined || raw === "") return BUNDLED_VIEW_URL;

  if (options.channel !== DEV_CHANNEL) {
    options.log.line("warn", "view-url", `${VIEW_URL_ENV} ignored outside the dev channel`, {
      channel: options.channel,
    });
    return BUNDLED_VIEW_URL;
  }

  const url = loopbackUrl(raw);
  if (url === null) {
    options.log.line(
      "warn",
      "view-url",
      `${VIEW_URL_ENV} is not a loopback http URL; using the bundled page`,
      {
        value: raw,
      },
    );
    return BUNDLED_VIEW_URL;
  }

  try {
    await options.probe(url, PROBE_TIMEOUT_MS);
  } catch (e: unknown) {
    options.log.line("warn", "view-url", "hot-reload server did not answer; using the bundled page", {
      url,
      error: e instanceof Error ? e.message : String(e),
    });
    return BUNDLED_VIEW_URL;
  }

  options.log.line("info", "view-url", "loading the page from the hot-reload server", { url });
  return url;
}
