/**
 * Settings › Mobile, minus React: the address form's parse, the bridge feed's
 * frames, and the few strings the page formats. Pure and DOM-free, so each
 * rule is tested from literals (`test/mobile-logic.test.ts`).
 */
import type { MobileServingView, MobileSettingsView } from "../api/types.ts";

/**
 * The bridge's port when settings name none — core's
 * `MOBILE_PROTOCOL.DEFAULT_PORT`, which the UI cannot import (§3.1). The unit
 * test pins the two together.
 */
export const DEFAULT_MOBILE_PORT = 7877;

/** The same rule core's `MobileSettingsInput.host` validates with. */
const HOST = /^[A-Za-z0-9.:_-]+$/;

const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

/** A bind on every interface: reachable from any network this laptop joins, not only the tailnet. */
export function isWildcardHost(host: string | null | undefined): boolean {
  return host !== null && host !== undefined && WILDCARD.has(host.trim());
}

/** The address form as typed: empty means "the default". */
export interface AddressDraft {
  host: string;
  port: string;
}

export function draftOf(settings: MobileSettingsView | null): AddressDraft {
  return {
    host: settings?.host ?? "",
    port: settings?.port === null || settings?.port === undefined ? "" : String(settings.port),
  };
}

export type AddressParse =
  | { ok: true; patch: { host: string | null; port: number | null } }
  | { ok: false; error: string };

/** The draft as a `mobile.settings` write, or the sentence saying why it cannot be one. */
export function parseAddress(draft: AddressDraft): AddressParse {
  const host = draft.host.trim();
  const port = draft.port.trim();
  if (host !== "" && (host.length > 253 || !HOST.test(host))) {
    return { ok: false, error: "Host must be a hostname or an IP address, not a URL." };
  }
  let portValue: number | null = null;
  if (port !== "") {
    portValue = /^\d+$/.test(port) ? Number(port) : Number.NaN;
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
      return { ok: false, error: "Port must be a whole number from 1 to 65535." };
    }
  }
  return { ok: true, patch: { host: host === "" ? null : host, port: portValue } };
}

/** Whether the draft says something other than what is saved. */
export function addressDirty(settings: MobileSettingsView | null, draft: AddressDraft): boolean {
  const saved = draftOf(settings);
  return saved.host !== draft.host.trim() || saved.port !== draft.port.trim();
}

/** `ABCD-EFGH`: an eight-character code in two groups, as people read it aloud. The bridge ignores the dash. */
export function formatPairCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** `4:05` until a deadline, `0:00` once it has passed. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ── the feed ────────────────────────────────────────────────────────────── */

export type MobileFeedEvent =
  | { kind: "status"; status: MobileServingView | null }
  | { kind: "paired"; device_id: string; name: string }
  | {
      kind: "device";
      device_id: string;
      action: "connected" | "disconnected" | "revoked";
    };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: Record<string, unknown>, key: string): string | null {
  const v = value[key];
  return typeof v === "string" ? v : null;
}

const ACTIONS = new Set(["connected", "disconnected", "revoked"]);

/**
 * One `mobile.serve` frame (`app/src/mobile-host.ts`), or null for a frame the
 * page has no use for. The feed's payloads are core's untyped event objects, so
 * every field is checked rather than cast.
 */
export function mobileFeedEvent(frame: { event: string; data: unknown }): MobileFeedEvent | null {
  if (frame.event === "status") {
    if (frame.data === null) return { kind: "status", status: null };
    const d = record(frame.data);
    if (d === null || typeof d["url"] !== "string" || typeof d["port"] !== "number") return null;
    return { kind: "status", status: d as unknown as MobileServingView };
  }
  const d = record(frame.data);
  if (d === null) return null;
  const device_id = str(d, "device_id");
  if (device_id === null) return null;
  if (frame.event === "paired") {
    return { kind: "paired", device_id, name: str(d, "name") ?? device_id };
  }
  if (frame.event === "device") {
    const action = str(d, "action");
    if (action === null || !ACTIONS.has(action)) return null;
    return { kind: "device", device_id, action: action as "connected" | "disconnected" | "revoked" };
  }
  return null;
}

/**
 * Which phones have a socket open, moved by one event. The bridge reports a
 * count, not names, so this is learned from `device` events since the page
 * opened: a phone that connected before then reads as idle until it
 * reconnects. `status` with no bridge clears it.
 */
export function nextConnected(connected: ReadonlySet<string>, event: MobileFeedEvent): Set<string> {
  const next = new Set(connected);
  if (event.kind === "status" && event.status === null) next.clear();
  if (event.kind === "device") {
    if (event.action === "connected") next.add(event.device_id);
    else next.delete(event.device_id);
  }
  return next;
}

/** The "last event" fact: what happened, in words, or null for a frame that is only a status. */
export function describeFeedEvent(
  event: MobileFeedEvent,
  nameOf: (deviceId: string) => string,
): string | null {
  switch (event.kind) {
    case "paired":
      return `paired ${event.name}`;
    case "device":
      return `${nameOf(event.device_id)} ${event.action}`;
    case "status":
      return event.status === null ? "bridge stopped" : null;
  }
}

/* ── formatting ──────────────────────────────────────────────────────────── */

const PLATFORM: Record<string, string> = { ios: "iOS", android: "Android", other: "Other" };

export function platformLabel(platform: string): string {
  return PLATFORM[platform] ?? platform;
}

const STAMP = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** `Oct 13 at 02:04 PM` in this laptop's zone, or `—` for never. */
export function fmtStamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : STAMP.format(d);
}

/** `02:04:31 PM`: when a feed event arrived. */
export function fmtClock(at: number): string {
  return CLOCK.format(new Date(at));
}
