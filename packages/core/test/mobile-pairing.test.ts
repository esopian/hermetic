/**
 * Pairing and device tokens (`mobile/pairing.ts`) and the device store
 * (`mobile/device-store.ts`): codes are single-use and expire, a bad code is
 * one refusal whatever was wrong with it, a source that keeps guessing is
 * locked out, and no raw secret is ever persisted.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCode } from "../src/errors.ts";
import { openLocalDb } from "../src/local/db/index.ts";
import {
  MemoryMobileStore,
  SqliteMobileStore,
  deviceView,
  type MobileStore,
} from "../src/mobile/device-store.ts";
import {
  bearerOf,
  createPairLimiter,
  generatePairCode,
  generateToken,
  issuePairCode,
  normalizePairCode,
  redeemPairCode,
  sha256Hex,
  verifyToken,
} from "../src/mobile/pairing.ts";
import { MOBILE_PROTOCOL, PAIR_CODE_ALPHABET } from "../src/mobile/protocol.ts";

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const REQUEST = { device_name: "FIXTURE phone", platform: "ios" as const };

function redeem(store: MobileStore, code: string, now = T0, limiter = createPairLimiter()) {
  return redeemPairCode(store, { ...REQUEST, code }, { now, source: "100.64.0.9", limiter });
}

function refusedWith(fn: () => unknown, code: Parameters<typeof hasCode>[1]): boolean {
  try {
    fn();
  } catch (e) {
    return hasCode(e, code);
  }
  return false;
}

describe("codes and tokens", () => {
  test("a pair code is 8 Crockford characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairCode();
      expect(code).toHaveLength(MOBILE_PROTOCOL.PAIR_CODE_LENGTH);
      for (const ch of code) expect(PAIR_CODE_ALPHABET).toContain(ch);
    }
  });

  test("a typed code is folded the Crockford way, and junk is not a code", () => {
    expect(normalizePairCode("abcd-ef01")).toBe("ABCDEF01");
    expect(normalizePairCode("o1l1 ii00")).toBe("01111100");
    expect(normalizePairCode("ABCDEFG")).toBeNull();
    expect(normalizePairCode("ABCDEFGU")).toBeNull();
  });

  test("a token is hmt_ plus 32 random bytes in base64url", () => {
    const token = generateToken();
    expect(token.startsWith("hmt_")).toBe(true);
    expect(Buffer.from(token.slice(4), "base64url")).toHaveLength(32);
    expect(generateToken()).not.toBe(token);
  });

  test("bearer parsing", () => {
    expect(bearerOf("Bearer hmt_abc")).toBe("hmt_abc");
    expect(bearerOf("bearer   hmt_abc ")).toBe("hmt_abc");
    expect(bearerOf("Basic xyz")).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });
});

describe("pairing", () => {
  test("a code pairs once, and the device carries only the token's hash", () => {
    const store = new MemoryMobileStore();
    const { code } = issuePairCode(store, { now: T0 });
    const { token, device } = redeem(store, code);
    expect(device.token_sha256).toBe(sha256Hex(token));
    expect(JSON.stringify(deviceView(device))).not.toContain(token);
    expect(JSON.stringify(deviceView(device))).not.toContain(device.token_sha256);
    expect(refusedWith(() => redeem(store, code), "PAIR_CODE_INVALID")).toBe(true);
  });

  test("a code expires at its TTL", () => {
    const store = new MemoryMobileStore();
    const { code, expires_at } = issuePairCode(store, { now: T0, ttlMs: 60_000 });
    expect(Date.parse(expires_at)).toBe(T0 + 60_000);
    expect(refusedWith(() => redeem(store, code, T0 + 60_000), "PAIR_CODE_INVALID")).toBe(true);
    const fresh = issuePairCode(store, { now: T0, ttlMs: 60_000 });
    expect(redeem(store, fresh.code, T0 + 59_999).device.name).toBe("FIXTURE phone");
  });

  test("an unknown or malformed code is the same refusal", () => {
    const store = new MemoryMobileStore();
    issuePairCode(store, { now: T0 });
    expect(refusedWith(() => redeem(store, "ZZZZZZZZ"), "PAIR_CODE_INVALID")).toBe(true);
    expect(refusedWith(() => redeem(store, "nope"), "PAIR_CODE_INVALID")).toBe(true);
  });

  test("five bad codes from one source lock it out for a minute, then it may try again", () => {
    const store = new MemoryMobileStore();
    const limiter = createPairLimiter();
    for (let i = 0; i < MOBILE_PROTOCOL.PAIR_MAX_FAILURES; i++) {
      expect(refusedWith(() => redeem(store, "ZZZZZZZZ", T0 + i, limiter), "PAIR_CODE_INVALID")).toBe(
        true,
      );
    }
    const { code } = issuePairCode(store, { now: T0 });
    // Locked out: even the right code is refused, and is not spent.
    expect(refusedWith(() => redeem(store, code, T0 + 10, limiter), "RATE_LIMITED")).toBe(true);
    // Another source is unaffected.
    const other = issuePairCode(store, { now: T0 });
    expect(
      redeemPairCode(
        store,
        { ...REQUEST, code: other.code },
        { now: T0 + 10, source: "100.64.0.10", limiter },
      ).device.platform,
    ).toBe("ios");
    const later = T0 + 10 + MOBILE_PROTOCOL.PAIR_LOCKOUT_MS;
    expect(redeem(store, code, later, limiter).device.name).toBe("FIXTURE phone");
  });
});

describe("token verification", () => {
  test("the right token finds its device; unknown and revoked find nothing", () => {
    const store = new MemoryMobileStore();
    const { code } = issuePairCode(store, { now: T0 });
    const { token, device } = redeem(store, code);
    expect(verifyToken(store, token)?.device_id).toBe(device.device_id);
    expect(verifyToken(store, generateToken())).toBeNull();
    expect(verifyToken(store, "")).toBeNull();
    expect(verifyToken(store, `${token}x`)).toBeNull();
    expect(store.revoke(device.device_id, new Date(T0).toISOString())).toBe(true);
    expect(store.revoke(device.device_id, new Date(T0).toISOString())).toBe(false);
    expect(verifyToken(store, token)).toBeNull();
    expect(store.listDevices()).toEqual([]);
  });
});

describe("the SQLite store", () => {
  test("round-trips devices, codes and settings, and never writes a token or a code", () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-mobile-store-"));
    const local = openLocalDb({ home });
    const store = new SqliteMobileStore(local.db);
    const issued = issuePairCode(store, { now: T0, name: "FIXTURE hint" });
    const { token, device } = redeem(store, issued.code);

    const listed = store.listDevices();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(device);
    expect(store.deviceByTokenHash(sha256Hex(token))?.device_id).toBe(device.device_id);
    expect(verifyToken(store, token)?.device_id).toBe(device.device_id);

    store.setPush(device.device_id, { expo_push_token: "ExponentPushToken[FIXTURE]", previews: false });
    const pushed = store.device(device.device_id);
    expect(pushed?.expo_push_token).toBe("ExponentPushToken[FIXTURE]");
    expect(pushed?.previews).toBe(false);
    expect(pushed?.enabled).toBe(true);
    store.touch(device.device_id, "2026-10-13T12:05:00.000Z");
    expect(store.device(device.device_id)?.last_seen_at).toBe("2026-10-13T12:05:00.000Z");

    expect(store.settings()).toEqual({ enabled: false, host: null, port: null });
    expect(store.setSettings({ enabled: true, port: 7900 })).toEqual({
      enabled: true,
      host: null,
      port: 7900,
    });
    expect(new SqliteMobileStore(local.db).settings().port).toBe(7900);

    expect(store.revoke(device.device_id, "2026-10-13T12:06:00.000Z")).toBe(true);
    expect(store.device(device.device_id)?.expo_push_token).toBeNull();

    // Flush the WAL, then look at every byte the home holds.
    local.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    local.close();
    for (const file of readdirSync(home)) {
      const bytes = readFileSync(join(home, file)).toString("latin1");
      expect(bytes.includes(token)).toBe(false);
      expect(bytes.includes(token.slice(4))).toBe(false);
      expect(bytes.includes(issued.code)).toBe(false);
    }
  });
});
