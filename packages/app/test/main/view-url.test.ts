/**
 * Which page a window loads (`bun run dev:hmr`).
 *
 * The probe is a function the test controls, so no server is started. What is
 * worth pinning is the gate — dev channel, loopback http, a server that answers
 * — and that every refusal lands on the bundled page rather than a dead window.
 */
import { describe, expect, test } from "bun:test";
import { memoryLog } from "../../src/log.ts";
import {
  BUNDLED_VIEW_URL,
  loopbackUrl,
  resolveViewUrl,
  VIEW_URL_ENV,
} from "../../src/main/view-url.ts";

function resolve(over: { channel?: string; value?: string; answers?: boolean }) {
  const log = memoryLog();
  const probed: string[] = [];
  const result = resolveViewUrl({
    channel: over.channel ?? "dev",
    env: over.value === undefined ? {} : { [VIEW_URL_ENV]: over.value },
    probe: (url) => {
      probed.push(url);
      return over.answers === false ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve();
    },
    log,
  });
  return { result, probed, log };
}

describe("resolveViewUrl", () => {
  test("no variable: the bundled page, nothing probed", async () => {
    const { result, probed } = resolve({});
    expect(await result).toBe(BUNDLED_VIEW_URL);
    expect(probed).toEqual([]);
  });

  test("dev channel, loopback server that answers: the server", async () => {
    const { result, probed } = resolve({ value: "http://127.0.0.1:5273/" });
    expect(await result).toBe("http://127.0.0.1:5273/");
    expect(probed).toEqual(["http://127.0.0.1:5273/"]);
  });

  test("outside the dev channel the variable is ignored and never probed", async () => {
    const { result, probed, log } = resolve({ channel: "stable", value: "http://127.0.0.1:5273/" });
    expect(await result).toBe(BUNDLED_VIEW_URL);
    expect(probed).toEqual([]);
    expect(log.lines.some((l) => l.includes("WARN"))).toBe(true);
  });

  test("a non-loopback URL is refused without a request", async () => {
    const { result, probed } = resolve({ value: "http://example.com:5273/" });
    expect(await result).toBe(BUNDLED_VIEW_URL);
    expect(probed).toEqual([]);
  });

  test("a server that does not answer falls back with a warning", async () => {
    const { result, log } = resolve({ value: "http://localhost:5273/", answers: false });
    expect(await result).toBe(BUNDLED_VIEW_URL);
    expect(log.lines.some((l) => l.includes("WARN") && l.includes("did not answer"))).toBe(true);
  });
});

describe("loopbackUrl", () => {
  test.each([
    ["http://127.0.0.1:5273", "http://127.0.0.1:5273/"],
    ["http://localhost:1/x", "http://localhost:1/x"],
    ["http://[::1]:5273/", "http://[::1]:5273/"],
  ])("%s is accepted", (raw, href) => {
    expect(loopbackUrl(raw)).toBe(href);
  });

  test.each([
    "https://127.0.0.1:5273/",
    "http://127.0.0.2:5273/",
    "http://localhost.evil.test/",
    "file:///etc/passwd",
    "not a url",
  ])("%s is refused", (raw) => {
    expect(loopbackUrl(raw)).toBeNull();
  });
});
