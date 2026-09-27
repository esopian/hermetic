/**
 * Every "open outside" in the page goes through `app.openExternal`.
 *
 * The app's webview refuses to navigate anywhere but its own bundle, and the
 * main process decides which URLs may leave it (`app/src/external-url.ts`). A
 * `window.open` in the page bypasses that decision, and an `<iframe>` of remote
 * content would sit in the one webview holding the RPC bridge. So neither may
 * appear in the UI's source; `lib/open-external.ts` is the only door.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openExternal } from "../src/lib/open-external.ts";
import { fakeServer, type FakeServer } from "./fake-transport.ts";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Source with comments removed, so prose about `window.open` is not a hit. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

let server: FakeServer | null = null;
afterEach(() => {
  server?.restore();
  server = null;
});

describe("external links", () => {
  test("no component opens a window of its own", () => {
    const offenders = sourceFiles(SRC).filter((path) => /\bwindow\.open\s*\(/.test(code(path)));
    expect(offenders).toEqual([]);
  });

  test("no component embeds remote content in the app's own webview", () => {
    const offenders = sourceFiles(SRC).filter((path) => /<iframe\b/.test(code(path)));
    expect(offenders).toEqual([]);
  });

  test("openExternal asks the app, and a refusal stays quiet", async () => {
    server = fakeServer({ "app.openExternal": { opened: true } });
    openExternal("https://lumen.acme.ts.net/");
    expect(server.to("app.openExternal").map((c) => c.params)).toEqual([
      { url: "https://lumen.acme.ts.net/" },
    ]);
    server.restore();

    // No route: the fake refuses by name, and the button that asked must not
    // turn that into an unhandled rejection.
    server = fakeServer({});
    openExternal("file:///etc/passwd");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.to("app.openExternal")).toHaveLength(1);
  });
});
