import type { MobilePushDevice } from "@hermetic/core/schema";
import { firstFleetView, hermeticdUrl, readFleetView } from "../../src/gateway/hermeticd.ts";
import { registerDevice, unregisterDevice } from "../../src/gateway/push-registry.ts";
import { fakeFetch, json } from "../helpers/fakes.ts";
import { fleetView } from "../helpers/fixtures.ts";

const VIEW = fleetView();

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

  test("nobody answers: HERMETICD_UNAVAILABLE; a box for another fleet is not believed", async () => {
    const down = fakeFetch(() => {
      throw new TypeError("Network request failed");
    });
    await expect(firstFleetView(down.fetch, ["a.hermetic.ts.net"], "fxtr0001")).rejects.toMatchObject({
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
      { instance: "atlas", ok: true },
      {
        instance: "corvid",
        ok: false,
        code: "RATE_LIMITED",
        message: "fxtr0001-corvid.hermetic.ts.net: too many",
      },
    ]);
    expect(f.calls[0]).toMatchObject({
      url: "http://fxtr0001-atlas.hermetic.ts.net:7434/push/devices",
      method: "POST",
      headers: { "x-hermetic-rpc": "1", "content-type": "application/json" },
    });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual(device);
  });

  test("a failure never repeats the token", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("Network request failed");
    });
    const results = await registerDevice(boxes.slice(0, 1), device, f.fetch);
    expect(results[0]).toMatchObject({ ok: false, code: "HERMETICD_UNAVAILABLE" });
    expect(JSON.stringify(results)).not.toContain("FIXTURE]");
  });

  test("DELETE /push/devices/<id> to unregister", async () => {
    const f = fakeFetch(() => json({ ok: true }));
    await unregisterDevice(boxes, "dev 1", f.fetch);
    expect(f.calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", "http://fxtr0001-atlas.hermetic.ts.net:7434/push/devices/dev%201"],
      ["DELETE", "http://fxtr0001-corvid.hermetic.ts.net:7434/push/devices/dev%201"],
    ]);
  });
});
