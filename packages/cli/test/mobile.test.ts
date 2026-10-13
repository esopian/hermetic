/**
 * `hermetic mobile` rendering (`commands/mobile.ts`): the pair screen carries
 * the code, the URL and a QR; the device table never shows a token.
 */
import { describe, expect, test } from "bun:test";
import { fleetAliases, renderDevices, renderPair, renderSettings } from "../src/commands/mobile.ts";

const PAIR = {
  code: "ABCD2345",
  expires_at: "2026-10-13T12:10:00.000Z",
  url: "hermetic://pair?host=127.0.0.1&port=7877&code=ABCD2345&fleet=fxtr0001&name=main",
  host: "127.0.0.1",
  port: 7877,
};

describe("mobile rendering", () => {
  test("the pair screen has a QR, the code and the URL", () => {
    const text = renderPair(PAIR, { qr: true });
    expect(text).toContain("ABCD2345");
    expect(text).toContain(PAIR.url);
    expect(text).toContain("127.0.0.1:7877");
    expect(text).toMatch(/[█▀▄]/);
    expect(renderPair(PAIR, { qr: false })).not.toMatch(/[█▀▄]/);
  });

  test("devices list without secrets, and say whether a bridge runs here", () => {
    const text = renderDevices({
      devices: [
        {
          device_id: "dev-1",
          name: "FIXTURE phone",
          platform: "ios",
          created_at: "2026-10-13T12:00:00.000Z",
          last_seen_at: null,
          push_registered: true,
          previews: false,
          enabled: true,
          fleet_id: "fxtr0001",
        },
      ],
      serving: null,
    });
    expect(text).toContain("not running in this process");
    expect(text).toContain("FIXTURE phone");
    expect(text).toContain("on, no previews");
    expect(renderDevices({ devices: [], serving: null })).toContain("no paired devices");
  });

  test("the fleet column shows the alias when known, else the id, else a dash", () => {
    const base = {
      name: "FIXTURE phone",
      platform: "ios" as const,
      created_at: "2026-10-13T12:00:00.000Z",
      last_seen_at: null,
      push_registered: false,
      previews: true,
      enabled: true,
    };
    const result = {
      devices: [
        { ...base, device_id: "dev-1", fleet_id: "fxtr0001" },
        { ...base, device_id: "dev-2", fleet_id: "sg7k2m4p" },
        { ...base, device_id: "dev-3", fleet_id: null },
      ],
      serving: null,
    };
    const text = renderDevices(result, new Map([["fxtr0001", "main"]]));
    const lines = text.split("\n");
    expect(lines.find((l) => l.startsWith("DEVICE"))).toContain("FLEET");
    expect(lines.find((l) => l.startsWith("dev-1"))).toMatch(/\bmain\b/);
    expect(lines.find((l) => l.startsWith("dev-1"))).not.toContain("fxtr0001");
    expect(lines.find((l) => l.startsWith("dev-2"))).toContain("sg7k2m4p");
    expect(lines.find((l) => l.startsWith("dev-3"))).toContain("—");
    // Without aliases the id is the whole answer.
    expect(renderDevices(result)).toContain("fxtr0001");
  });

  test("settings repeat core's warning about a wildcard host", () => {
    const plain = renderSettings({ enabled: true, host: null, port: null });
    expect(plain).not.toContain("warning");
    const wild = renderSettings({
      enabled: true,
      host: "0.0.0.0",
      port: null,
      warning: "the bridge binds every interface",
    });
    expect(wild).toContain("host     0.0.0.0");
    expect(wild).toContain("warning: the bridge binds every interface");
  });
});

describe("fleetAliases", () => {
  const base = {
    name: "FIXTURE phone",
    platform: "ios" as const,
    created_at: "2026-10-13T12:00:00.000Z",
    last_seen_at: null,
    push_registered: false,
    previews: true,
    enabled: true,
  };
  const entry = (fleet_id: string | null, name: string | null) => ({ fleet_id, name });
  const hermetic = (list: () => Promise<unknown>) =>
    ({ fleets: { list } }) as unknown as Parameters<typeof fleetAliases>[0];

  test("reads aliases for fleets with a name, skipping the rest", async () => {
    const aliases = await fleetAliases(
      hermetic(async () => ({
        fleets: [entry("fxtr0001", "main"), entry("sg7k2m4p", null), entry(null, "x")],
      })),
      { devices: [{ ...base, device_id: "d", fleet_id: "fxtr0001" }], serving: null },
    );
    expect([...aliases]).toEqual([["fxtr0001", "main"]]);
  });

  test("does not ask when no device has a fleet", async () => {
    let asked = 0;
    const aliases = await fleetAliases(
      hermetic(async () => {
        asked++;
        return { fleets: [] };
      }),
      { devices: [{ ...base, device_id: "d", fleet_id: null }], serving: null },
    );
    expect(asked).toBe(0);
    expect(aliases.size).toBe(0);
  });

  test("a directory that throws leaves the ids", async () => {
    const aliases = await fleetAliases(
      hermetic(async () => {
        throw new Error("directory unreachable");
      }),
      { devices: [{ ...base, device_id: "d", fleet_id: "fxtr0001" }], serving: null },
    );
    expect(aliases.size).toBe(0);
  });
});
