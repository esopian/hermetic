/**
 * The mobile bridge's local state: paired phones, one-time pair codes, and the
 * bridge's own settings row.
 *
 * Local to this laptop, like the inbox (§4.9): a phone pairs with the laptop
 * that showed it the code, and nothing here moves to DynamoDB. Two stores with
 * one interface — SQLite (`mobile_devices`, `mobile_pair_codes`, one `prefs`
 * row) for a real or fixture home, memory for a home-less instance and tests.
 *
 * Neither ever holds a raw secret. A device is found by the sha256 of its
 * token, a pair code by the sha256 of the code; the token itself exists only
 * in the one `pair` response that hands it to the phone.
 */
import type { Database } from "bun:sqlite";
import { MOBILE_PLATFORMS, type MobilePlatform } from "./protocol.ts";
import type { MobileDevice, MobileSettings } from "../schema/index.ts";

export interface MobileDeviceRow {
  device_id: string;
  name: string;
  platform: MobilePlatform;
  /** Lowercase hex. */
  token_sha256: string;
  created_at: string;
  last_seen_at: string | null;
  expo_push_token: string | null;
  previews: boolean;
  enabled: boolean;
  revoked_at: string | null;
  /**
   * The fleet the phone paired for; the bridge honours the token only while it
   * serves that fleet. `null` is a row paired before the column existed, and
   * is refused.
   */
  fleet_id: string | null;
}

export interface MobilePairCodeRow {
  code_sha256: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  name_hint: string | null;
}

export interface MobilePushPatch {
  expo_push_token?: string | null;
  previews?: boolean;
  enabled?: boolean;
}

export interface MobileStore {
  insertDevice(row: MobileDeviceRow): void;
  /** The device a token hash names, revoked or not; the caller decides. */
  deviceByTokenHash(hash: string): MobileDeviceRow | null;
  device(deviceId: string): MobileDeviceRow | null;
  /** Every device not revoked, oldest first. */
  listDevices(): MobileDeviceRow[];
  /** `false` when the device is unknown or already revoked. */
  revoke(deviceId: string, at: string): boolean;
  touch(deviceId: string, at: string): void;
  setPush(deviceId: string, patch: MobilePushPatch): MobileDeviceRow | null;
  insertPairCode(row: MobilePairCodeRow): void;
  /**
   * Spend a code: the row when it existed, was unused and unexpired at `now`,
   * stamped used in the same step so a second caller gets `null`.
   */
  consumePairCode(codeSha256: string, now: string): MobilePairCodeRow | null;
  /** Forget codes that expired or were used before `before`. */
  prunePairCodes(before: string): void;
  settings(): MobileSettings;
  setSettings(patch: Partial<MobileSettings>): MobileSettings;
}

export const DEFAULT_MOBILE_SETTINGS: MobileSettings = { enabled: false, host: null, port: null };

/** The `prefs` key the bridge settings live under. */
export const MOBILE_SETTINGS_PREF = "mobile_bridge";

/** What every head is shown: no token, no hash, no push token. */
export function deviceView(row: MobileDeviceRow): MobileDevice {
  return {
    device_id: row.device_id,
    name: row.name,
    platform: row.platform,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    push_registered: row.expo_push_token !== null,
    previews: row.previews,
    enabled: row.enabled,
    fleet_id: row.fleet_id,
  };
}

function mergeSettings(current: MobileSettings, patch: Partial<MobileSettings>): MobileSettings {
  return {
    enabled: patch.enabled ?? current.enabled,
    host: patch.host === undefined ? current.host : patch.host,
    port: patch.port === undefined ? current.port : patch.port,
  };
}

function parseSettings(raw: string | null): MobileSettings {
  if (raw === null) return { ...DEFAULT_MOBILE_SETTINGS };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      enabled: v["enabled"] === true,
      host: typeof v["host"] === "string" ? v["host"] : null,
      port: typeof v["port"] === "number" ? v["port"] : null,
    };
  } catch {
    // A row this build cannot read is a preference, not a failure.
    return { ...DEFAULT_MOBILE_SETTINGS };
  }
}

/** The in-process store tests and a home-less instance get. */
export class MemoryMobileStore implements MobileStore {
  private readonly devices = new Map<string, MobileDeviceRow>();
  private readonly codes = new Map<string, MobilePairCodeRow>();
  private prefs: MobileSettings = { ...DEFAULT_MOBILE_SETTINGS };

  insertDevice(row: MobileDeviceRow): void {
    this.devices.set(row.device_id, { ...row });
  }
  deviceByTokenHash(hash: string): MobileDeviceRow | null {
    for (const row of this.devices.values()) if (row.token_sha256 === hash) return { ...row };
    return null;
  }
  device(deviceId: string): MobileDeviceRow | null {
    const row = this.devices.get(deviceId);
    return row === undefined ? null : { ...row };
  }
  listDevices(): MobileDeviceRow[] {
    return [...this.devices.values()]
      .filter((r) => r.revoked_at === null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((r) => ({ ...r }));
  }
  revoke(deviceId: string, at: string): boolean {
    const row = this.devices.get(deviceId);
    if (row === undefined || row.revoked_at !== null) return false;
    row.revoked_at = at;
    row.expo_push_token = null;
    return true;
  }
  touch(deviceId: string, at: string): void {
    const row = this.devices.get(deviceId);
    if (row !== undefined) row.last_seen_at = at;
  }
  setPush(deviceId: string, patch: MobilePushPatch): MobileDeviceRow | null {
    const row = this.devices.get(deviceId);
    if (row === undefined) return null;
    if (patch.expo_push_token !== undefined) row.expo_push_token = patch.expo_push_token;
    if (patch.previews !== undefined) row.previews = patch.previews;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    return { ...row };
  }
  insertPairCode(row: MobilePairCodeRow): void {
    this.codes.set(row.code_sha256, { ...row });
  }
  consumePairCode(codeSha256: string, now: string): MobilePairCodeRow | null {
    const row = this.codes.get(codeSha256);
    if (row === undefined || row.used_at !== null || row.expires_at <= now) return null;
    row.used_at = now;
    return { ...row };
  }
  prunePairCodes(before: string): void {
    for (const [key, row] of this.codes) {
      if (row.expires_at < before || (row.used_at !== null && row.used_at < before)) {
        this.codes.delete(key);
      }
    }
  }
  settings(): MobileSettings {
    return { ...this.prefs };
  }
  setSettings(patch: Partial<MobileSettings>): MobileSettings {
    this.prefs = mergeSettings(this.prefs, patch);
    return this.settings();
  }
}

interface DeviceSqlRow {
  device_id: string;
  name: string;
  platform: string;
  token_sha256: string;
  created_at: string;
  last_seen_at: string | null;
  expo_push_token: string | null;
  previews: number;
  enabled: number;
  revoked_at: string | null;
  fleet_id: string | null;
}

function platformOf(value: string): MobilePlatform {
  return (MOBILE_PLATFORMS as readonly string[]).includes(value) ? (value as MobilePlatform) : "other";
}

function fromSql(row: DeviceSqlRow | null): MobileDeviceRow | null {
  if (row === null) return null;
  return {
    device_id: row.device_id,
    name: row.name,
    platform: platformOf(row.platform),
    token_sha256: row.token_sha256,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expo_push_token: row.expo_push_token,
    previews: row.previews !== 0,
    enabled: row.enabled !== 0,
    revoked_at: row.revoked_at,
    fleet_id: row.fleet_id ?? null,
  };
}

/** `mobile_devices`, `mobile_pair_codes` and one `prefs` row, in this home's database. */
export class SqliteMobileStore implements MobileStore {
  constructor(private readonly db: Database) {}

  insertDevice(row: MobileDeviceRow): void {
    this.db.run(
      `INSERT INTO mobile_devices (device_id, name, platform, token_sha256, created_at,
         last_seen_at, expo_push_token, previews, enabled, revoked_at, fleet_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.device_id,
        row.name,
        row.platform,
        row.token_sha256,
        row.created_at,
        row.last_seen_at,
        row.expo_push_token,
        row.previews ? 1 : 0,
        row.enabled ? 1 : 0,
        row.revoked_at,
        row.fleet_id,
      ],
    );
  }
  deviceByTokenHash(hash: string): MobileDeviceRow | null {
    return fromSql(
      this.db
        .query(`SELECT * FROM mobile_devices WHERE token_sha256 = ?`)
        .get(hash) as DeviceSqlRow | null,
    );
  }
  device(deviceId: string): MobileDeviceRow | null {
    return fromSql(
      this.db
        .query(`SELECT * FROM mobile_devices WHERE device_id = ?`)
        .get(deviceId) as DeviceSqlRow | null,
    );
  }
  listDevices(): MobileDeviceRow[] {
    const rows = this.db
      .query(`SELECT * FROM mobile_devices WHERE revoked_at IS NULL ORDER BY created_at, device_id`)
      .all() as DeviceSqlRow[];
    return rows.map((r) => fromSql(r) as MobileDeviceRow);
  }
  revoke(deviceId: string, at: string): boolean {
    const result = this.db.run(
      `UPDATE mobile_devices SET revoked_at = ?, expo_push_token = NULL
       WHERE device_id = ? AND revoked_at IS NULL`,
      [at, deviceId],
    );
    return result.changes > 0;
  }
  touch(deviceId: string, at: string): void {
    this.db.run(`UPDATE mobile_devices SET last_seen_at = ? WHERE device_id = ?`, [at, deviceId]);
  }
  setPush(deviceId: string, patch: MobilePushPatch): MobileDeviceRow | null {
    if (patch.expo_push_token !== undefined) {
      this.db.run(`UPDATE mobile_devices SET expo_push_token = ? WHERE device_id = ?`, [
        patch.expo_push_token,
        deviceId,
      ]);
    }
    if (patch.previews !== undefined) {
      this.db.run(`UPDATE mobile_devices SET previews = ? WHERE device_id = ?`, [
        patch.previews ? 1 : 0,
        deviceId,
      ]);
    }
    if (patch.enabled !== undefined) {
      this.db.run(`UPDATE mobile_devices SET enabled = ? WHERE device_id = ?`, [
        patch.enabled ? 1 : 0,
        deviceId,
      ]);
    }
    return this.device(deviceId);
  }
  insertPairCode(row: MobilePairCodeRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO mobile_pair_codes (code_sha256, created_at, expires_at, used_at, name_hint)
       VALUES (?, ?, ?, ?, ?)`,
      [row.code_sha256, row.created_at, row.expires_at, row.used_at, row.name_hint],
    );
  }
  consumePairCode(codeSha256: string, now: string): MobilePairCodeRow | null {
    // One statement decides and stamps, so two phones racing one code cannot both win.
    const result = this.db.run(
      `UPDATE mobile_pair_codes SET used_at = ?
       WHERE code_sha256 = ? AND used_at IS NULL AND expires_at > ?`,
      [now, codeSha256, now],
    );
    if (result.changes === 0) return null;
    return this.db
      .query(`SELECT * FROM mobile_pair_codes WHERE code_sha256 = ?`)
      .get(codeSha256) as MobilePairCodeRow | null;
  }
  prunePairCodes(before: string): void {
    this.db.run(
      `DELETE FROM mobile_pair_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)`,
      [before, before],
    );
  }
  settings(): MobileSettings {
    const row = this.db.query(`SELECT value FROM prefs WHERE key = ?`).get(MOBILE_SETTINGS_PREF) as {
      value: string;
    } | null;
    return parseSettings(row?.value ?? null);
  }
  setSettings(patch: Partial<MobileSettings>): MobileSettings {
    const next = mergeSettings(this.settings(), patch);
    this.db.run(
      `INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [MOBILE_SETTINGS_PREF, JSON.stringify(next)],
    );
    return next;
  }
}
