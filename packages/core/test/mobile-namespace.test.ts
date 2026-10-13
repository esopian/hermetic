/**
 * The `mobile.*` methods on a fixture `Hermetic` (`mobile/index.ts`): settings
 * persist in the home's database, `pair` builds the `hermetic://pair` URL for
 * the fleet, `serve` streams `OpEvent`s until its signal aborts and redeems the
 * codes `pair` issued, and `revoke` ends a device.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCode } from "../src/errors.ts";
import { mobileBridgeHost, openHermetic } from "../src/index.ts";
import { MOBILE_PROTOCOL, MOBILE_ROUTES } from "../src/mobile/protocol.ts";
import type { OpEvent } from "../src/schema/index.ts";

const HEADER = { [MOBILE_PROTOCOL.VERSION_HEADER]: "1", "content-type": "application/json" };

function home(): string {
  return mkdtempSync(join(tmpdir(), "hermetic-mobile-ns-"));
}

describe("mobile.*", () => {
  test("settings read, write and persist; an empty request reads", async () => {
    const dir = home();
    const h = await openHermetic({ fixture: true, home: dir });
    expect(await h.mobile.settings({})).toEqual({ enabled: false, host: null, port: null });
    expect(await h.mobile.settings({ enabled: true, port: 7999 })).toEqual({
      enabled: true,
      host: null,
      port: 7999,
    });
    const again = await openHermetic({ fixture: true, home: dir });
    expect(await again.mobile.settings()).toEqual({ enabled: true, host: null, port: 7999 });
    expect(await again.mobile.settings({ port: null })).toEqual({
      enabled: true,
      host: null,
      port: null,
    });
    await expect(h.mobile.settings({ port: 70_000 })).rejects.toThrow();
    await expect(h.mobile.settings({ extra: 1 })).rejects.toThrow();
  });

  test("pair builds the fleet's pair URL on loopback in fixture mode", async () => {
    const h = await openHermetic({ fixture: true, home: home() });
    const result = await h.mobile.pair({ name: "FIXTURE phone" });
    const url = new URL(result.url);
    expect(url.protocol).toBe("hermetic:");
    expect(result.host).toBe("127.0.0.1");
    expect(result.port).toBe(MOBILE_PROTOCOL.DEFAULT_PORT);
    expect(url.searchParams.get("code")).toBe(result.code);
    expect(url.searchParams.get("fleet")).toBe(h.target?.fleet_id ?? "");
    expect(url.searchParams.get("port")).toBe(String(MOBILE_PROTOCOL.DEFAULT_PORT));
    const explicit = await h.mobile.pair({ host: "100.64.0.7", port: 7001 });
    expect(new URL(explicit.url).searchParams.get("host")).toBe("100.64.0.7");
    expect((await h.mobile.devices({})).devices).toEqual([]);
  });

  test("serve listens, pairs, reports devices, and stops on abort", async () => {
    const h = await openHermetic({ fixture: true, home: home() });
    expect(() => h.mobile.serve({ port: -1 })).toThrow();
    const controller = new AbortController();
    const it = h.mobile
      .serve({ port: 0, tick_swarms: false }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    const first = (await it.next()).value as OpEvent;
    expect(first.phase).toBe("listening");
    const serving = (await h.mobile.devices({})).serving;
    expect(serving?.app).toBe("cli");
    expect(first.message).toContain(serving?.url ?? "missing");

    // A second bridge in the same process is refused.
    let conflict = false;
    try {
      await mobileBridgeHost(h).start({ app: "desktop" });
    } catch (e) {
      conflict = hasCode(e, "CONFLICT");
    }
    expect(conflict).toBe(true);

    // `pair` now advertises the running bridge, and the bridge redeems it.
    const paired = await h.mobile.pair({});
    expect(paired.port).toBe(serving?.port ?? -1);
    const res = await fetch(`${serving?.url}${MOBILE_ROUTES.pair}`, {
      method: "POST",
      headers: HEADER,
      body: JSON.stringify({ code: paired.code, device_name: "FIXTURE phone", platform: "android" }),
    });
    expect(res.status).toBe(200);
    const { token, device_id } = (await res.json()) as { token: string; device_id: string };
    const pairedEvent = (await it.next()).value as OpEvent;
    expect(pairedEvent.phase).toBe("paired");
    expect(pairedEvent.message).not.toContain(paired.code);
    expect(pairedEvent.message).not.toContain(token);

    const { devices } = await h.mobile.devices({});
    expect(devices.map((d) => d.device_id)).toEqual([device_id]);
    expect(JSON.stringify(devices)).not.toContain(token);
    expect(await h.mobile.revoke({ device_id })).toEqual({ revoked: true });
    expect(await h.mobile.revoke({ device_id })).toEqual({ revoked: false });
    const after = await fetch(`${serving?.url}${MOBILE_ROUTES.hello}`, {
      headers: { ...HEADER, authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);

    controller.abort();
    const rest: OpEvent[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
    expect(rest.at(-1)?.phase).toBe("stopped");
    expect((await h.mobile.devices({})).serving).toBeNull();
  });
});
