import type { MobilePushDevice } from "@hermetic/core/schema";
import {
  callHermeticd,
  fetchHealthz,
  firstFleetView,
  hermeticdUrl,
  noteTunnel,
  readFleetView,
  resetTunnelChecks,
  TUNNEL_TTL_MS,
  tunnelVerified,
} from "../../src/gateway/hermeticd.ts";
import { registerDevice, unregisterDevice } from "../../src/gateway/push-registry.ts";
import { fakeFetch, json } from "../helpers/fakes.ts";
import { fleetView } from "../helpers/fixtures.ts";

const VIEW = fleetView();

/** The plain-HTTP calls to hermeticd, without the tunnel gate's HTTPS probes. */
const rpc = <C extends { url: string }>(calls: C[]) => calls.filter((c) => c.url.startsWith("http://"));
const probes = <C extends { url: string }>(calls: C[]) =>
  calls.filter((c) => c.url.startsWith("https://"));

beforeEach(() => resetTunnelChecks());

/** hermeticd's refusal: one NDJSON error frame. */
const refusal = (status: number, code: string, message: string) =>
  new Response(`${JSON.stringify({ type: "error", code, message })}\n`, {
    status,
    headers: { "content-type": "application/x-ndjson" },
  });

describe("GET /fleet", () => {
  test("plain HTTP on 7434 with the protocol header, parsed with MobileFleetView", async () => {
    const f = fakeFetch(() => json(VIEW));
    expect(await readFleetView(f.fetch, "fxtr0001-atlas.hermetic.ts.net")).toEqual(VIEW);
    expect(f.calls[0]).toMatchObject({
      url: "https://fxtr0001-atlas.hermetic.ts.net/api/health",
      method: "GET",
    });
    expect(f.calls[1]).toMatchObject({
      url: "http://fxtr0001-atlas.hermetic.ts.net:7434/fleet",
      method: "GET",
      headers: { "x-hermetic-rpc": "1" },
    });
    expect(hermeticdUrl("fd7a:115c:a1e0::1", "/fleet")).toBe("http://[fd7a:115c:a1e0::1]:7434/fleet");
  });

  test("a shape it does not know is CHAT_PROTOCOL", async () => {
    const f = fakeFetch(() => json({ agents: "nope" }));
    await expect(readFleetView(f.fetch, "h.hermetic.ts.net")).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
    });
  });

  test("the first box to answer wins; the rest are cancelled", async () => {
    const f = fakeFetch(async (url, init) => {
      if (url.includes("slow")) {
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
      return json(VIEW);
    });
    const answer = await firstFleetView(
      f.fetch,
      ["slow.hermetic.ts.net", "fast.hermetic.ts.net"],
      "fxtr0001",
    );
    expect(answer.host).toBe("fast.hermetic.ts.net");
  });

  test("503 FLEET_LIST_UNAVAILABLE outranks a box that did not answer", async () => {
    const f = fakeFetch((url) => {
      if (url.includes("down")) throw new TypeError("Network request failed");
      return refusal(503, "FLEET_LIST_UNAVAILABLE", "the foundation predates version 16");
    });
    await expect(
      firstFleetView(f.fetch, ["down.hermetic.ts.net", "old.hermetic.ts.net"], "fxtr0001"),
    ).rejects.toMatchObject({ code: "FLEET_LIST_UNAVAILABLE" });
  });

  test("nobody answers: refused before 7434; a box for another fleet is not believed", async () => {
    const down = fakeFetch(() => {
      throw new TypeError("Network request failed");
    });
    await expect(firstFleetView(down.fetch, ["a.hermetic.ts.net"], "fxtr0001")).rejects.toMatchObject({
      code: "TUNNEL_UNVERIFIED",
    });
    expect(rpc(down.calls)).toEqual([]);
    // HTTPS answers, 7434 does not: the box's agent service is down.
    const dead = fakeFetch((url) => {
      if (url.startsWith("http://")) throw new TypeError("Network request failed");
      return json({ status: "ok" });
    });
    await expect(firstFleetView(dead.fetch, ["a.hermetic.ts.net"], "fxtr0001")).rejects.toMatchObject({
      code: "HERMETICD_UNAVAILABLE",
    });
    const other = fakeFetch(() => json({ ...VIEW, fleet: { ...VIEW.fleet, fleet_id: "sg7k2m4p" } }));
    await expect(firstFleetView(other.fetch, ["a.hermetic.ts.net"], "fxtr0001")).rejects.toMatchObject({
      code: "FLEET_MISMATCH",
    });
    await expect(firstFleetView(other.fetch, [], "fxtr0001")).rejects.toMatchObject({
      code: "HERMETICD_UNAVAILABLE",
    });
  });
});

describe("push registration", () => {
  const device: MobilePushDevice = {
    device_id: "dev-1",
    token: "ExponentPushToken[FIXTURE]",
    platform: "ios",
    app_version: "0.1.0",
    listening: "all",
    previews: false,
  };
  const boxes = [
    { instance: "atlas", host: "fxtr0001-atlas.hermetic.ts.net" },
    { instance: "corvid", host: "fxtr0001-corvid.hermetic.ts.net" },
  ];

  test("POSTs the device to every box in parallel, each box's answer its own", async () => {
    const f = fakeFetch((url) =>
      url.includes("corvid") ? refusal(429, "RATE_LIMITED", "too many") : json({ ok: true }),
    );
    const results = await registerDevice(boxes, device, f.fetch);
    expect(results).toEqual([
      { instance: "atlas", box: boxes[0], status: "ok", ok: true },
      {
        instance: "corvid",
        box: boxes[1],
        status: "failed",
        ok: false,
        code: "RATE_LIMITED",
        message: "fxtr0001-corvid.hermetic.ts.net: too many",
      },
    ]);
    const calls = rpc(f.calls);
    expect(calls[0]).toMatchObject({
      url: "http://fxtr0001-atlas.hermetic.ts.net:7434/push/devices",
      method: "POST",
      headers: { "x-hermetic-rpc": "1", "content-type": "application/json" },
    });
    // Every field it was given, `previews` included: nothing here picks fields.
    expect(JSON.parse(calls[0]!.body!)).toEqual(device);
  });

  test("a box's 403 FORBIDDEN is status forbidden, naming the box, so the phone mints a new id", async () => {
    const f = fakeFetch((url) =>
      url.includes("corvid") && url.startsWith("http://")
        ? refusal(403, "FORBIDDEN", "device dev-1 belongs to another login")
        : json({ ok: true }),
    );
    const results = await registerDevice(boxes, device, f.fetch);
    expect(results[0]).toMatchObject({ status: "ok", ok: true });
    expect(results[1]).toMatchObject({
      instance: "corvid",
      box: boxes[1],
      status: "forbidden",
      ok: false,
      code: "FORBIDDEN",
    });
  });

  test("a failure never repeats the token", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("Network request failed");
    });
    const results = await registerDevice(boxes.slice(0, 1), device, f.fetch);
    expect(results[0]).toMatchObject({ ok: false, status: "failed", code: "TUNNEL_UNVERIFIED" });
    expect(JSON.stringify(results)).not.toContain("FIXTURE]");
  });

  test("DELETE /push/devices/<id> to unregister", async () => {
    const f = fakeFetch(() => json({ ok: true }));
    await unregisterDevice(boxes, "dev 1", f.fetch);
    expect(rpc(f.calls).map((c) => [c.method, c.url])).toEqual([
      ["DELETE", "http://fxtr0001-atlas.hermetic.ts.net:7434/push/devices/dev%201"],
      ["DELETE", "http://fxtr0001-corvid.hermetic.ts.net:7434/push/devices/dev%201"],
    ]);
  });
});

describe("the tunnel gate", () => {
  const HOST = "fxtr0001-atlas.hermetic.ts.net";

  test("no HTTPS success: TUNNEL_UNVERIFIED and no 7434 request is made", async () => {
    const f = fakeFetch((url) => {
      if (url.startsWith("https://")) throw new TypeError("Network request failed");
      return json(VIEW);
    });
    await expect(readFleetView(f.fetch, HOST)).rejects.toMatchObject({ code: "TUNNEL_UNVERIFIED" });
    await expect(
      callHermeticd(f.fetch, HOST, "/push/devices", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({
      code: "TUNNEL_UNVERIFIED",
    });
    expect(probes(f.calls).map((c) => c.url)).toEqual([
      `https://${HOST}/api/health`,
      `https://${HOST}/api/health`,
    ]);
    expect(rpc(f.calls)).toEqual([]);
  });

  test("a probe that never answers is cut at 3 s and nothing is sent", async () => {
    jest.useFakeTimers();
    try {
      const f = fakeFetch(
        (url, init) =>
          new Promise((resolve, reject) => {
            if (url.startsWith("http://")) resolve(json(VIEW));
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      );
      const read = readFleetView(f.fetch, HOST);
      const settled = expect(read).rejects.toMatchObject({ code: "TUNNEL_UNVERIFIED" });
      await jest.advanceTimersByTimeAsync(3_000);
      await settled;
      expect(rpc(f.calls)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("one HTTPS success vouches for the host for 60 s, then it is proved again", async () => {
    const f = fakeFetch(() => json(VIEW));
    await readFleetView(f.fetch, HOST);
    await readFleetView(f.fetch, HOST);
    expect(probes(f.calls)).toHaveLength(1);
    expect(rpc(f.calls)).toHaveLength(2);
    noteTunnel(HOST, true, Date.now() - TUNNEL_TTL_MS - 1);
    expect(tunnelVerified(HOST)).toBe(false);
    await readFleetView(f.fetch, HOST);
    expect(probes(f.calls)).toHaveLength(2);
  });

  test("the Tailscale probe's record stands in for the gate's own probe", async () => {
    noteTunnel(HOST, true);
    const f = fakeFetch(() => json(VIEW));
    await readFleetView(f.fetch, HOST);
    expect(probes(f.calls)).toEqual([]);
    expect(rpc(f.calls)).toHaveLength(1);
  });

  test("a 7434 request that does not get through withdraws the record", async () => {
    noteTunnel(HOST, true);
    const f = fakeFetch(() => {
      throw new TypeError("Network request failed");
    });
    await expect(readFleetView(f.fetch, HOST)).rejects.toMatchObject({ code: "HERMETICD_UNAVAILABLE" });
    expect(tunnelVerified(HOST)).toBe(false);
  });
});

describe("GET /healthz", () => {
  const HOST = "fxtr0001-atlas.hermetic.ts.net";

  test("who the box is and which hermeticd it runs, through the gate", async () => {
    const f = fakeFetch((url) =>
      url.endsWith("/healthz")
        ? json({ name: "atlas", hermeticd_version: "0.4.2", protocol: 1, config_hash: "abc" })
        : json({ status: "ok" }),
    );
    expect(await fetchHealthz(HOST, f.fetch)).toEqual({
      name: "atlas",
      hermeticd_version: "0.4.2",
      ok: true,
      error: null,
    });
    expect(f.calls.map((c) => c.url)).toEqual([
      `https://${HOST}/api/health`,
      `http://${HOST}:7434/healthz`,
    ]);
  });

  test("a box that does not answer, or answers in another shape, is ok: false and never throws", async () => {
    const down = fakeFetch(() => {
      throw new TypeError("Network request failed");
    });
    expect(await fetchHealthz(HOST, down.fetch)).toMatchObject({
      name: null,
      ok: false,
      error: { code: "TUNNEL_UNVERIFIED" },
    });
    expect(rpc(down.calls)).toEqual([]);
    const odd = fakeFetch(() => json({ hello: "world" }));
    expect(await fetchHealthz(HOST, odd.fetch)).toMatchObject({
      ok: false,
      error: { code: "CHAT_PROTOCOL" },
    });
  });
});
