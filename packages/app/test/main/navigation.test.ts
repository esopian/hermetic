/**
 * The main window's navigation allow-list (`main/navigation.ts`).
 *
 * The rules themselves are evaluated natively, so what the suite can hold is
 * their meaning — `navigationAllowed` mirrors the native evaluation — and the
 * guard that turns a refusal into an external open. Whether the native side
 * really cancels is the devkit's behaviour, cited in the module header, and
 * only a built app can show it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryLog } from "../../src/log.ts";
import {
  DUPLICATE_WINDOW_MS,
  MAIN_NAVIGATION_RULES,
  MAIN_VIEW_URL,
  applyNavigationRules,
  installNavigationGuard,
  mainNavigationRules,
  navigationAllowed,
  readNavigationEvent,
} from "../../src/main/navigation.ts";

type Kind = "will-navigate" | "new-window-open";

function guard() {
  const listeners = new Map<Kind, (event: unknown) => void>();
  const opened: string[] = [];
  const log = memoryLog();
  let clock = 0;
  installNavigationGuard({
    on: (event, listener) => void listeners.set(event, listener),
    openExternal: (url) => void opened.push(url),
    log,
    now: () => clock,
  });
  return {
    opened,
    log,
    advance: (ms: number) => void (clock += ms),
    /** A `will-navigate` as the native side raises it: the detail is a JSON string. */
    navigate: (url: string, allowed: boolean) =>
      listeners.get("will-navigate")?.({ data: { detail: JSON.stringify({ url, allowed }) } }),
    /** A `new-window-open`: the devkit has already parsed its detail. */
    newWindow: (url: string) =>
      listeners.get("new-window-open")?.({ data: { detail: { url, isCmdClick: false } } }),
  };
}

describe("the main window's rules", () => {
  test("the bundled page is allowed, and so are its reloads and fragments", () => {
    expect(navigationAllowed(MAIN_VIEW_URL)).toBe(true);
    expect(navigationAllowed(`${MAIN_VIEW_URL}#/agents/lumen`)).toBe(true);
    expect(navigationAllowed(`${MAIN_VIEW_URL}?fleet=main`)).toBe(true);
  });

  test("anything that is not views://main is refused", () => {
    for (const url of [
      "https://lumen.acme.ts.net/vnc/vnc.html",
      "http://127.0.0.1:7433/",
      "file:///etc/passwd",
      "about:blank",
      "javascript:alert(1)",
      "views://other/index.html",
      "data:text/html,<script>1</script>",
    ]) {
      expect({ url, allowed: navigationAllowed(url) }).toEqual({ url, allowed: false });
    }
  });

  test("the rule list is block-all, then the bundle, in that order", () => {
    // Last match wins natively; the other order would allow nothing at all.
    expect(MAIN_NAVIGATION_RULES).toEqual(["^*", "views://main/*"]);
    expect(navigationAllowed(MAIN_VIEW_URL, [...MAIN_NAVIGATION_RULES].reverse())).toBe(false);
  });
});

describe("mainNavigationRules", () => {
  test("the bundled page gets the plain rules", () => {
    expect(mainNavigationRules(MAIN_VIEW_URL)).toEqual(MAIN_NAVIGATION_RULES);
  });

  test("a hot-reload page also allows its own origin, and only that", () => {
    const rules = mainNavigationRules("http://127.0.0.1:5273/");
    expect(rules).toEqual(["^*", "views://main/*", "http://127.0.0.1:5273/*"]);
    expect(navigationAllowed("http://127.0.0.1:5273/", rules)).toBe(true);
    expect(navigationAllowed("http://127.0.0.1:5273/#/agents/lumen", rules)).toBe(true);
    expect(navigationAllowed(MAIN_VIEW_URL, rules)).toBe(true);
    expect(navigationAllowed("http://127.0.0.1:5173/", rules)).toBe(false);
    expect(navigationAllowed("https://example.com/", rules)).toBe(false);
  });
});

describe("applyNavigationRules", () => {
  test("puts the rules on the webview itself", () => {
    const set: string[][] = [];
    applyNavigationRules({ setNavigationRules: (rules) => void set.push(rules) });
    expect(set).toEqual([[...MAIN_NAVIGATION_RULES]]);
  });

  test("puts the given rules when the window loads another page", () => {
    const set: string[][] = [];
    const rules = mainNavigationRules("http://127.0.0.1:5273/");
    applyNavigationRules({ setNavigationRules: (r) => void set.push(r) }, rules);
    expect(set).toEqual([[...rules]]);
  });
});

describe("readNavigationEvent", () => {
  test("reads the native will-navigate detail string", () => {
    expect(
      readNavigationEvent("will-navigate", {
        data: { detail: '{"url":"https://example.com/","allowed":false}' },
      }),
    ).toEqual({ url: "https://example.com/", allowed: false });
  });

  test("a new window is never allowed in this webview", () => {
    expect(
      readNavigationEvent("new-window-open", { data: { detail: { url: "https://example.com/" } } }),
    ).toEqual({ url: "https://example.com/", allowed: false });
  });

  test("anything unreadable is nothing to act on", () => {
    expect(readNavigationEvent("will-navigate", null)).toBe(null);
    expect(readNavigationEvent("will-navigate", { data: { detail: "not json" } })).toBe(null);
    expect(readNavigationEvent("new-window-open", { data: { detail: { url: 7 } } })).toBe(null);
  });
});

describe("installNavigationGuard", () => {
  test("a refused https link goes to the operator's browser", () => {
    const g = guard();
    g.navigate("https://docs.example.com/page", false);
    expect(g.opened).toEqual(["https://docs.example.com/page"]);
  });

  test("window.open and target=_blank go to the operator's browser", () => {
    const g = guard();
    g.newWindow("https://lumen.acme.ts.net/");
    expect(g.opened).toEqual(["https://lumen.acme.ts.net/"]);
  });

  test("an allowed navigation is left alone", () => {
    const g = guard();
    g.navigate(MAIN_VIEW_URL, true);
    expect(g.opened).toEqual([]);
  });

  test("a refused non-web scheme is not handed to the OS either", () => {
    const g = guard();
    g.navigate("file:///etc/passwd", false);
    g.newWindow("javascript:alert(1)");
    g.newWindow("https://user:pw@example.com/");
    expect(g.opened).toEqual([]);
    const logged = g.log.lines.join("");
    expect(logged).toContain('scheme="file:"');
    // The scheme, never the URL: a query string can carry anything.
    expect(logged).not.toContain("/etc/passwd");
    expect(logged).not.toContain("pw@");
  });

  test("one click reported twice opens one tab", () => {
    const g = guard();
    g.newWindow("https://example.com/");
    g.navigate("https://example.com/", false);
    expect(g.opened).toEqual(["https://example.com/"]);
    g.advance(DUPLICATE_WINDOW_MS);
    g.newWindow("https://example.com/");
    expect(g.opened).toEqual(["https://example.com/", "https://example.com/"]);
  });
});

describe("the main window is built with the rules", () => {
  // `main/index.ts` imports the devkit and cannot be loaded outside a built
  // app, so the wiring is read as text: the one window factory hands the rules
  // and the guard to every window it opens.
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "main", "index.ts"), "utf8");

  test("the window loads the resolved page with that page's rules set at creation", () => {
    const construction = /new BrowserWindow\(\{[\s\S]*?\}\);/.exec(source)?.[0] ?? "";
    expect(source).toContain("const navigationRules = mainNavigationRules(viewUrl);");
    expect(construction).toContain("url: viewUrl");
    expect(construction).toContain("navigationRules: JSON.stringify(navigationRules)");
    expect(construction).not.toContain("sandbox: true"); // the page needs its bridge
    expect(source.match(/new BrowserWindow\(/g)?.length).toBe(1);
  });

  test("the rules are set on the webview after construction, not only passed to it", () => {
    // The devkit drops the `navigationRules` constructor option before native
    // (`createWebview` in `proc/native.ts` has no argument for it); only
    // `setNavigationRules` reaches `setWebviewNavigationRules`.
    const construction = source.indexOf("new BrowserWindow(");
    const applied = source.indexOf("applyNavigationRules(window.webview, navigationRules);");
    expect(applied).toBeGreaterThan(construction);
    // Straight after it: nothing between the constructor and the rules.
    const between = source.slice(source.indexOf("});", construction) + 3, applied);
    expect(between.trim()).toBe("");
  });

  test("the guard is installed on that window's webview", () => {
    expect(source).toContain("installNavigationGuard({");
    expect(source).toContain("`${event}-${window.webviewId}`");
  });
});
