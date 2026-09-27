/**
 * The main window loads the bundled page and nothing else.
 *
 * The window's webview holds the RPC bridge, and in Electrobun that bridge is
 * the page itself: the preload (with the bridge's AES key and socket port) is a
 * `WKUserScript` injected into every frame, and the `bunBridge` / `hostBridge`
 * script-message handlers answer whichever frame posts to them without asking
 * which one it was. Whatever document is in that webview can call
 * `secrets.push`, `agents.create` or `apply`. So the rule is enforced natively,
 * before a navigation commits: `applyNavigationRules` hands
 * `MAIN_NAVIGATION_RULES` to the window's webview, the native side evaluates
 * them on every navigation of every frame, and anything other than
 * `views://main/…` is cancelled.
 *
 * Through `setNavigationRules`, not the `navigationRules` constructor option.
 * In the devkit this app builds against, the option is accepted and then
 * dropped: `createWebview` in `proc/native.ts` neither destructures it nor has
 * an FFI argument for it, so a window built with it runs with no rules at all.
 * `setNavigationRules` is the only call that reaches native
 * (`setWebviewNavigationRules`).
 *
 * A refused link is not dropped on the floor. The native side still reports it
 * — a `will-navigate` with `allowed: false`, or a `new-window-open` for a
 * `target="_blank"`, a `window.open` or a Cmd-click — and `installNavigationGuard`
 * hands an http(s) one to the operator's browser through the same allow-list
 * `app.openExternal` uses (`external-url.ts`). A box's noVNC client, the one
 * remote document the page shows, lives in its own sandboxed webview with no
 * bridge at all (`AgentDesktop.tsx`, `<electrobun-webview sandbox>`), never in
 * this one.
 *
 * Pure apart from its injected `on` and `openExternal`, so the suite can drive
 * it without an app; `main/index.ts` wires the devkit's emitter in.
 */
import type { AppLog } from "../log.ts";
import { externalUrl } from "../external-url.ts";

/** The page the main window is built for, and the only one it may show. */
export const MAIN_VIEW_URL = "views://main/index.html";

/**
 * Electrobun's navigation rules: glob patterns, a leading `^` blocks, and the
 * last pattern that matches decides (`-[AbstractView shouldAllowNavigationToURL:]`
 * in the devkit's native wrapper). Block everything, then allow the bundle.
 * `views://main/*` rather than the one file so a reload, a fragment or a query
 * on the same page is not refused.
 */
export const MAIN_NAVIGATION_RULES: readonly string[] = ["^*", "views://main/*"];

/**
 * The rules for a window loading `viewUrl`. The bundled page gets
 * `MAIN_NAVIGATION_RULES` as they are; a hot-reload server's page
 * (`main/view-url.ts`, dev channel and loopback only) also gets its own
 * origin, or the native side would cancel the very page the window opens.
 */
export function mainNavigationRules(viewUrl: string): readonly string[] {
  if (viewUrl === MAIN_VIEW_URL) return MAIN_NAVIGATION_RULES;
  return [...MAIN_NAVIGATION_RULES, `${new URL(viewUrl).origin}/*`];
}

/** As much of the devkit's `BrowserView` as the rules need. */
export interface RuledView {
  setNavigationRules(rules: string[]): void;
}

/**
 * Puts the main window's rules on its webview. Called straight after the
 * window is constructed: the bundled page it is already loading is allowed, and
 * the call is a synchronous FFI write, so it lands before the page has run a
 * line of script that could navigate anywhere.
 */
export function applyNavigationRules(
  view: RuledView,
  rules: readonly string[] = MAIN_NAVIGATION_RULES,
): void {
  view.setNavigationRules([...rules]);
}

/**
 * The same decision in TypeScript, so the suite can pin what the rules above
 * mean. Mirrors the native evaluation — last match wins, no match allows — over
 * the one glob character the rules use.
 */
export function navigationAllowed(
  url: string,
  rules: readonly string[] = MAIN_NAVIGATION_RULES,
): boolean {
  let allowed = true;
  for (const rule of rules) {
    const block = rule.startsWith("^");
    const pattern = block ? rule.slice(1) : rule;
    if (globMatch(pattern, url)) allowed = !block;
  }
  return allowed;
}

function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(value);
}

/** What the native side reports, reduced to the URL and whether it went through. */
export interface NavigationReport {
  url: string;
  allowed: boolean;
}

/**
 * Reads a `will-navigate` or `new-window-open` event's detail. The first
 * arrives as a JSON *string* (`{"url":…,"allowed":…}`); the second is parsed by
 * the devkit into an object (`{url, isCmdClick, …}`) and always means "not in
 * this webview". Anything else reads as nothing to act on.
 */
export function readNavigationEvent(
  kind: "will-navigate" | "new-window-open",
  event: unknown,
): NavigationReport | null {
  if (typeof event !== "object" || event === null) return null;
  let detail: unknown = (event as { data?: { detail?: unknown } }).data?.detail;
  if (typeof detail === "string") {
    try {
      detail = JSON.parse(detail);
    } catch {
      return null;
    }
  }
  if (typeof detail !== "object" || detail === null) return null;
  const { url, allowed } = detail as { url?: unknown; allowed?: unknown };
  if (typeof url !== "string" || url === "") return null;
  if (kind === "new-window-open") return { url, allowed: false };
  return { url, allowed: allowed !== false };
}

export interface NavigationGuardOptions {
  /** Subscribes to one of this window's webview events. */
  on(event: "will-navigate" | "new-window-open", listener: (event: unknown) => void): void;
  /** `Utils.openExternal`; only ever handed a URL `externalUrl` accepted. */
  openExternal(url: string): void;
  log?: AppLog;
  /** Injected for the suite's clock. */
  now?: () => number;
}

/**
 * How long the same URL is treated as the same click. A Cmd-click is reported
 * twice — by the preload's own click listener and by the native navigation
 * delegate — and one click should be one browser tab.
 */
export const DUPLICATE_WINDOW_MS = 1000;

/**
 * Sends every refused http(s) navigation to the operator's browser and logs
 * the rest. Never reopens anything in this window: the native rules already
 * cancelled it, and the guard's only job is making the refusal useful.
 */
export function installNavigationGuard(options: NavigationGuardOptions): void {
  const now = options.now ?? Date.now;
  let last: { url: string; at: number } | null = null;
  const handle = (kind: "will-navigate" | "new-window-open") => (event: unknown) => {
    const report = readNavigationEvent(kind, event);
    if (report === null || report.allowed) return;
    const at = now();
    if (last !== null && last.url === report.url && at - last.at < DUPLICATE_WINDOW_MS) return;
    last = { url: report.url, at };
    let href: string;
    try {
      href = externalUrl(report.url);
    } catch {
      // `file:`, `javascript:`, a custom scheme: refused in the window and not
      // handed to the OS either. Logged by scheme only — the URL is the page's
      // text, and a query string can carry anything.
      options.log?.line("warn", "navigation", "refused a navigation", {
        kind,
        scheme: schemeOf(report.url),
      });
      return;
    }
    options.openExternal(href);
  };
  options.on("will-navigate", handle("will-navigate"));
  options.on("new-window-open", handle("new-window-open"));
}

function schemeOf(url: string): string {
  const colon = url.indexOf(":");
  return colon > 0 ? url.slice(0, colon + 1) : "(none)";
}
