import { classifyProbeError, probeTailscale } from "../../src/gateway/tailscale.ts";
import { fakeFetch, json } from "../helpers/fakes.ts";

/** Errors shaped like what React Native's fetch rejects with on iOS. */
const RN = {
  bare: () => new TypeError("Network request failed"),
  cannotFindHost: () =>
    Object.assign(new TypeError("A server with the specified hostname could not be found."), {
      code: "NSURLErrorDomain -1003",
    }),
  timedOut: () => new TypeError("The request timed out. (NSURLErrorDomain error -1001)"),
  refused: () => new TypeError("Could not connect to the server. (NSURLErrorDomain error -1004)"),
};

describe("classifyProbeError", () => {
  test.each([
    ["bare 'Network request failed' (fast)", RN.bare(), "dns"],
    ["NSURLErrorDomain -1003 / hostname could not be found", RN.cannotFindHost(), "dns"],
    ["NSURLErrorDomain -1001 / timed out", RN.timedOut(), "timeout"],
    ["NSURLErrorDomain -1004 / could not connect", RN.refused(), "refused"],
    [
      "ENOTFOUND in a cause",
      Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }),
      "dns",
    ],
    ["ECONNREFUSED", new Error("connect ECONNREFUSED 100.64.0.1:443"), "refused"],
  ])("%s", (_name, error, expected) => {
    expect(classifyProbeError(error, false)).toBe(expected);
  });

  test("this module's own deadline is a timeout whatever the error says", () => {
    expect(classifyProbeError(RN.bare(), true)).toBe("timeout");
  });
});

describe("probeTailscale", () => {
  test("no hosts: unknown", async () => {
    const f = fakeFetch(() => json({}));
    expect(await probeTailscale({ hosts: [], fetch: f.fetch })).toEqual({
      status: "unknown",
      failing: [],
    });
    expect(f.calls).toHaveLength(0);
  });

  test("any probe answering is ok, with the failing hosts listed; at most three probed", async () => {
    const f = fakeFetch((url) => {
      if (url.includes("b.")) throw RN.timedOut();
      return json({ status: "ok" });
    });
    const result = await probeTailscale({
      hosts: ["a.t.ts.net", "b.t.ts.net", "c.t.ts.net", "d.t.ts.net"],
      fetch: f.fetch,
    });
    expect(result).toEqual({ status: "ok", failing: ["b.t.ts.net"] });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://a.t.ts.net/api/health",
      "https://b.t.ts.net/api/health",
      "https://c.t.ts.net/api/health",
    ]);
  });

  test("an HTTP error status still proves the tailnet carried the probe", async () => {
    const f = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    expect((await probeTailscale({ hosts: ["a.t.ts.net"], fetch: f.fetch })).status).toBe("ok");
  });

  test("every probe failing to resolve: off", async () => {
    const f = fakeFetch((url) => {
      throw url.includes("a.") ? RN.cannotFindHost() : RN.bare();
    });
    expect(await probeTailscale({ hosts: ["a.t.ts.net", "b.t.ts.net"], fetch: f.fetch })).toEqual({
      status: "off",
      failing: ["a.t.ts.net", "b.t.ts.net"],
    });
  });

  test("every probe timing out or refused: unreachable", async () => {
    const f = fakeFetch((url) => {
      throw url.includes("a.") ? RN.timedOut() : RN.refused();
    });
    expect((await probeTailscale({ hosts: ["a.t.ts.net", "b.t.ts.net"], fetch: f.fetch })).status).toBe(
      "unreachable",
    );
  });

  test("the 3 s deadline fires on a probe that never answers: unreachable", async () => {
    const f = fakeFetch(
      (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(RN.bare()))),
    );
    expect(
      (await probeTailscale({ hosts: ["a.t.ts.net"], fetch: f.fetch, timeoutMs: 10 })).status,
    ).toBe("unreachable");
  });
});
