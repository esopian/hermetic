/**
 * Pairing and device tokens for the mobile bridge.
 *
 * A pair code is eight Crockford base32 characters drawn with
 * `crypto.randomInt`, single-use, short-lived, and stored only as its sha256.
 * That is 40 bits: the hash keeps the code out of a casual read of the
 * database, but anyone holding a copy could brute-force it, so the real bound
 * is the ten-minute TTL and single use, not the hash. Redeeming one mints a
 * device token — `hmt_` plus 32 random bytes in base64url — which is returned
 * once and stored only as its sha256; at 256 bits, that hash is as good as
 * gone.
 *
 * Verification hashes the presented token, looks the hash up, and compares the
 * two digests with `timingSafeEqual`; an unknown token is compared against a
 * fixed dummy digest so it takes the same path as a wrong one. A source that
 * keeps presenting bad pair codes is refused `RATE_LIMITED` for a while.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { HermeticError } from "../errors.ts";
import type { MobilePairRequest } from "../schema/index.ts";
import type { MobileDeviceRow, MobileStore } from "./device-store.ts";
import { MOBILE_PROTOCOL, PAIR_CODE_ALPHABET } from "./protocol.ts";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generatePairCode(length: number = MOBILE_PROTOCOL.PAIR_CODE_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i++) code += PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)];
  return code;
}

/**
 * A code as typed: case-folded, separators dropped, and Crockford's look-alikes
 * read as the digits they stand for. Returns `null` for anything that cannot be
 * a code, so a malformed one is refused like a wrong one.
 */
export function normalizePairCode(input: string): string | null {
  const folded = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (folded.length !== MOBILE_PROTOCOL.PAIR_CODE_LENGTH) return null;
  for (const ch of folded) if (!PAIR_CODE_ALPHABET.includes(ch)) return null;
  return folded;
}

export function generateToken(): string {
  return `${MOBILE_PROTOCOL.TOKEN_PREFIX}${randomBytes(MOBILE_PROTOCOL.TOKEN_BYTES).toString("base64url")}`;
}

const DUMMY_DIGEST = Buffer.from(sha256Hex("hermetic-mobile-no-such-device"), "hex");

/**
 * The live device a presented token names, or `null`. Unknown, malformed and
 * revoked tokens all return `null` after the same hash-and-compare work.
 */
export function verifyToken(store: MobileStore, presented: string): MobileDeviceRow | null {
  const hash = sha256Hex(presented);
  const digest = Buffer.from(hash, "hex");
  const row = store.deviceByTokenHash(hash);
  const stored = row === null ? DUMMY_DIGEST : Buffer.from(row.token_sha256, "hex");
  const equal = stored.length === digest.length && timingSafeEqual(stored, digest);
  if (row === null || !equal || row.revoked_at !== null) return null;
  return row;
}

/** The bearer token on a request, or `null`. */
export function bearerOf(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Per-source failed pair attempts, and the lockout they earn. */
export interface PairLimiter {
  /** Throws `RATE_LIMITED` while the source is locked out. */
  check(source: string, now: number): void;
  fail(source: string, now: number): void;
  succeed(source: string): void;
}

export function createPairLimiter(
  opts: { maxFailures?: number; lockoutMs?: number } = {},
): PairLimiter {
  const maxFailures = opts.maxFailures ?? MOBILE_PROTOCOL.PAIR_MAX_FAILURES;
  const lockoutMs = opts.lockoutMs ?? MOBILE_PROTOCOL.PAIR_LOCKOUT_MS;
  const state = new Map<string, { failures: number; first: number; lockedUntil: number }>();
  return {
    check(source, now) {
      const s = state.get(source);
      if (s === undefined) return;
      if (s.lockedUntil > now) {
        throw new HermeticError("RATE_LIMITED", "too many pair attempts; wait a minute", {
          retry_after_ms: s.lockedUntil - now,
        });
      }
      if (s.lockedUntil !== 0 || now - s.first > lockoutMs) state.delete(source);
    },
    fail(source, now) {
      const s = state.get(source) ?? { failures: 0, first: now, lockedUntil: 0 };
      s.failures += 1;
      if (s.failures >= maxFailures) s.lockedUntil = now + lockoutMs;
      state.set(source, s);
    },
    succeed(source) {
      state.delete(source);
    },
  };
}

export interface PairCodeIssued {
  code: string;
  expires_at: string;
}

export function issuePairCode(
  store: MobileStore,
  opts: { now: number; ttlMs?: number; name?: string | undefined },
): PairCodeIssued {
  const nowIso = new Date(opts.now).toISOString();
  store.prunePairCodes(nowIso);
  const code = generatePairCode();
  const expires_at = new Date(
    opts.now + (opts.ttlMs ?? MOBILE_PROTOCOL.PAIR_CODE_TTL_MS),
  ).toISOString();
  // A digest, not a KDF: see the header — the TTL is what bounds a copied code.
  store.insertPairCode({
    code_sha256: sha256Hex(code),
    created_at: nowIso,
    expires_at,
    used_at: null,
    name_hint: opts.name ?? null,
  });
  return { code, expires_at };
}

export interface Redeemed {
  token: string;
  device: MobileDeviceRow;
}

/**
 * Spend a code and mint a device for `fleet_id`, the fleet the bridge serves
 * at this moment. Every refusal of the code itself — unknown, expired, used,
 * malformed — is the same `PAIR_CODE_INVALID`, and counts against the source.
 */
export function redeemPairCode(
  store: MobileStore,
  request: MobilePairRequest,
  opts: { now: number; source: string; limiter: PairLimiter; fleet_id: string },
): Redeemed {
  opts.limiter.check(opts.source, opts.now);
  const nowIso = new Date(opts.now).toISOString();
  const code = normalizePairCode(request.code);
  const spent = code === null ? null : store.consumePairCode(sha256Hex(code), nowIso);
  if (spent === null) {
    opts.limiter.fail(opts.source, opts.now);
    throw new HermeticError("PAIR_CODE_INVALID", "that pair code is unknown, expired or used");
  }
  opts.limiter.succeed(opts.source);
  const token = generateToken();
  const device: MobileDeviceRow = {
    device_id: randomUUID(),
    name: request.device_name,
    platform: request.platform,
    token_sha256: sha256Hex(token),
    created_at: nowIso,
    last_seen_at: nowIso,
    expo_push_token: null,
    previews: true,
    enabled: true,
    revoked_at: null,
    fleet_id: opts.fleet_id,
  };
  store.insertDevice(device);
  return { token, device };
}
