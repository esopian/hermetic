/**
 * What the box says about its browser stack (§7.3).
 *
 * The distinction this file exists to keep: an active unit and an answering CDP
 * port are two questions, and a Chrome that starts and dies into its restart
 * loop answers the first and not the second.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { browserIdentities } from "@hermetic/core/schema";
import { CDP_TIMEOUT_MS, browserUnit, probeBrowsers, reportBrowsers } from "../src/browser-health.ts";
import { MANIFEST_PATH } from "../src/manifest.ts";
import { FakeHost } from "./fake-host.ts";
import { makeManifest } from "./fixtures.ts";

const IDENTITIES = browserIdentities();
const DEFAULT = IDENTITIES[0]!;
const UNIT = browserUnit(DEFAULT.name);
const VERSION_URL = `http://127.0.0.1:${String(DEFAULT.cdp_port)}/json/version`;

/** A `/json/version` that answers like Chrome does, or fails like it does not. */
function cdp(answer: "ok" | "refused" | "timeout" | "not-json" | number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(VERSION_URL);
    if (answer === "refused")
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    if (answer === "timeout")
      throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    if (typeof answer === "number") return new Response("nope", { status: answer });
    if (answer === "not-json") return new Response("<html>", { status: 200 });
    return Response.json({
      Browser: "Chrome/153.0.8010.12",
      webSocketDebuggerUrl: `ws://127.0.0.1:${String(DEFAULT.cdp_port)}/devtools/browser/abc`,
    });
  }) as typeof fetch;
}

describe("the browser health probe", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
  });

  test("an active unit whose CDP answers is ok, and says which Chrome", async () => {
    const [browser, ...rest] = await probeBrowsers(host, IDENTITIES, cdp("ok"));

    expect(rest).toHaveLength(0);
    expect(browser).toEqual({
      name: "default",
      unit_active: true,
      cdp_ok: true,
      cdp_version: "Chrome/153.0.8010.12",
      detail: `${UNIT} active (running), CDP Chrome/153.0.8010.12`,
    });
  });

  test("a unit in its restart loop is not active, however `is-active` would answer", async () => {
    // The trap the Hermes probe already learned: `systemctl is-active` calls
    // `activating (auto-restart)` active, and that is the middle of a crash loop.
    host.unitStates.set(UNIT, { ActiveState: "activating", SubState: "auto-restart" });

    const [browser] = await probeBrowsers(host, IDENTITIES, cdp("refused"));

    expect(browser?.unit_active).toBe(false);
    expect(browser?.cdp_ok).toBe(false);
    expect(browser?.detail).toBe(`${UNIT} activating (auto-restart), CDP refused`);
  });

  test("a failed unit is reported with what systemd said", async () => {
    host.unitStates.set(UNIT, { ActiveState: "failed", SubState: "failed" });

    const [browser] = await probeBrowsers(host, IDENTITIES, cdp("refused"));

    expect(browser).toEqual({
      name: "default",
      unit_active: false,
      cdp_ok: false,
      cdp_version: null,
      detail: `${UNIT} failed (failed), CDP refused`,
    });
  });

  test("an active unit with a silent CDP port fails on CDP alone", async () => {
    const [browser] = await probeBrowsers(host, IDENTITIES, cdp("timeout"));

    expect(browser?.unit_active).toBe(true);
    expect(browser?.cdp_ok).toBe(false);
    expect(browser?.detail).toBe(
      `${UNIT} active (running), CDP no answer in ${String(CDP_TIMEOUT_MS)}ms`,
    );
  });

  test("a non-2xx answer is not an answer", async () => {
    const [browser] = await probeBrowsers(host, IDENTITIES, cdp(503));

    expect(browser?.cdp_ok).toBe(false);
    expect(browser?.detail).toContain("CDP answered 503");
  });

  test("a body this build cannot read is still a browser that is up", async () => {
    const [browser] = await probeBrowsers(host, IDENTITIES, cdp("not-json"));

    expect(browser?.cdp_ok).toBe(true);
    expect(browser?.cdp_version).toBeNull();
    expect(browser?.detail).toContain("CDP up, version unknown");
  });

  test("the unit is asked about by name, on loopback only", async () => {
    await probeBrowsers(host, IDENTITIES, cdp("ok"));
    expect(host.commandsMatching(/^systemctl show/)).toEqual([
      `systemctl show -p ActiveState,SubState,NRestarts ${UNIT}`,
    ]);
  });
});

describe("what `GET /healthz` reports", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
  });

  test("a browser agent's manifest produces one entry per identity", async () => {
    host.seed(MANIFEST_PATH, JSON.stringify(makeManifest({ browser: true })));

    const browsers = await reportBrowsers(host, cdp("ok"));

    expect(browsers?.map((b) => b.name)).toEqual(["default"]);
  });

  /**
   * Empty, not absent. A manifest that parses and lists no browsers is the box
   * saying so, and the probe turns that into "this agent's applied config
   * predates the browser stack; run agent rerun" — a sentence it can only reach
   * because an empty list is distinguishable from an absent one.
   */
  test("a manifest that lists no browsers reports an empty list, not nothing", async () => {
    host.seed(MANIFEST_PATH, JSON.stringify(makeManifest()));
    expect(await reportBrowsers(host, cdp("ok"))).toEqual([]);
  });

  test("a box with no manifest, or one this build refuses, reports nothing", async () => {
    expect(await reportBrowsers(host, cdp("ok"))).toBeUndefined();
    host.seed(MANIFEST_PATH, "{not json");
    expect(await reportBrowsers(host, cdp("ok"))).toBeUndefined();
  });
});
