/**
 * The phone companion's bridge, from Settings › Mobile. Four local requests
 * and one feed:
 *
 * - `mobile.settings` reads (empty input) or writes the bridge's `enabled`,
 *   `host` and `port`; the head starts, stops or moves the hosted bridge before
 *   it answers.
 * - `mobile.pair` issues a single-use pairing code and the `hermetic://pair`
 *   URL the QR carries. The answer is a credential until it expires: callers
 *   keep it in component state and nowhere else.
 * - `mobile.devices` lists the paired phones and what the bridge is serving.
 * - `mobile.revoke` signs one phone out.
 * - `followMobile` joins `mobile.serve`, the hosted bridge's `status` and
 *   events. Joining starts the bridge, so only a page showing an enabled
 *   bridge joins.
 */
import { transport, type StreamFrame } from "./transport.ts";
import type {
  MobileDevicesView,
  MobilePairInput,
  MobilePairView,
  MobileRevokeResult,
  MobileSettingsInput,
  MobileSettingsView,
} from "./types.ts";

export function fetchMobileSettings(): Promise<MobileSettingsView> {
  return transport().request<MobileSettingsView>("mobile.settings", {});
}

/** A stated field writes; `null` clears an override back to the default. */
export function setMobileSettings(input: MobileSettingsInput): Promise<MobileSettingsView> {
  return transport().request<MobileSettingsView>("mobile.settings", { ...input });
}

export function pairMobile(input: MobilePairInput = {}): Promise<MobilePairView> {
  return transport().request<MobilePairView>("mobile.pair", { ...input });
}

export function fetchMobileDevices(): Promise<MobileDevicesView> {
  return transport().request<MobileDevicesView>("mobile.devices", {});
}

export function revokeMobileDevice(device_id: string): Promise<MobileRevokeResult> {
  return transport().request<MobileRevokeResult>("mobile.revoke", { device_id });
}

/**
 * Follow the hosted bridge. `onFrame` gets every frame as sent — `status`
 * first, then `paired`, `device` and `status` again as the bridge reports them
 * (`logic/mobile-logic.ts` reads them). `onConnected(false)` means the follow
 * could not open: a head that hosts no bridge refuses it. Returns the
 * unsubscribe.
 */
export function followMobile(handlers: {
  onFrame: (frame: StreamFrame) => void;
  onConnected: (connected: boolean) => void;
}): () => void {
  return transport().subscribe("mobile", null, handlers);
}
