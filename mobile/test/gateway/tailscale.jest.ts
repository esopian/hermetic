import { resetTunnelChecks, tunnelVerified } from "../../src/gateway/hermeticd.ts";
import { classifyProbeError, probeHosts, probeTailscale } from "../../src/gateway/tailscale.ts";
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
    ["bare 'Network request failed' (fast): says nothing about DNS", RN.bare(), "network"],
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

  test("every probe failing to resolve, by an explicit DNS signature: off", async () => {
    const f = fakeFetch(() => {
      throw RN.cannotFindHost();
    });
    expect(await probeTailscale({ hosts: ["a.t.ts.net", "b.t.ts.net"], fetch: f.fetch })).toEqual({
      status: "off",
      failing: ["a.t.ts.net", "b.t.ts.net"],
    });
  });

  test("a bare fast 'Network request failed' is unreachable, never off", async () => {
    const bare = fakeFetch(() => {
      throw RN.bare();
    });
    expect((await probeTailscale({ hosts: ["a.t.ts.net"], fetch: bare.fetch })).status).toBe(
      "unreachable",
    );
    const mixed = fakeFetch((url) => {
      throw url.includes("a.") ? RN.cannotFindHost() : RN.bare();
    });
    expect(
      (await probeTailscale({ hosts: ["a.t.ts.net", "b.t.ts.net"], fetch: mixed.fetch })).status,
    ).toBe("unreachable");
  });

  test("each probe records whether HTTPS to its host worked, for the 7434 gate", async () => {
    resetTunnelChecks();
    const f = fakeFetch((url) => {
      if (url.includes("b.")) throw RN.refused();
      return json({ status: "ok" });
    });
    await probeTailscale({ hosts: ["a.t.ts.net", "b.t.ts.net"], fetch: f.fetch });
    expect(tunnelVerified("a.t.ts.net")).toBe(true);
    expect(tunnelVerified("b.t.ts.net")).toBe(false);
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

describe("probeHosts", () => {
  test("ready agents first, then the rest, at most three, each once", () => {
    expect(
      probeHosts([
        { host: "a.t.ts.net", status: "error" },
        { host: "b.t.ts.net", status: null },
        { host: "c.t.ts.net", status: "ready" },
        { host: "d.t.ts.net", status: "ready" },
        { host: "c.t.ts.net", status: "ready" },
        { host: "e.t.ts.net", status: "ready" },
        { host: "f.t.ts.net", status: "ready" },
      ]),
    ).toEqual(["c.t.ts.net", "d.t.ts.net", "e.t.ts.net"]);
    expect(
      probeHosts([
        { host: "a.t.ts.net", status: "error" },
        { host: null, status: "ready" },
        { host: "c.t.ts.net", status: "ready" },
      ]),
    ).toEqual(["c.t.ts.net", "a.t.ts.net"]);
  });
});
