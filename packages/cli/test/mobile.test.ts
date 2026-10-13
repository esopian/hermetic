/**
 * `hermetic mobile` rendering (`commands/mobile.ts`): the pair screen carries
 * the code, the URL and a QR; the device table never shows a token.
 */
import { describe, expect, test } from "bun:test";
import { renderDevices, renderPair, renderSettings } from "../src/commands/mobile.ts";

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
