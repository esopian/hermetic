/**
 * Telling boxes where to push: `POST /push/devices` (register or update this
 * phone's Expo token) and `DELETE /push/devices/<device_id>` on each box the
 * phone listens to, in parallel, each box's answer its own.
 *
 * The phone registers on pair, on a listening change and on a token change, and
 * unregisters on sign out (§9.4). The token is never logged; a failure says
 * which box and why, never what was sent. Pure: `fetch` is injected.
 */
import type { MobilePushDevice } from "@hermetic/core/schema";
import { pushDevicePath, RPC_PATHS } from "@hermetic/core/shared";
import { errorCode, reasonOf } from "../client/errors.ts";
import { callHermeticd, type FetchLike } from "./hermeticd.ts";

/** One box to register with: its instance name and MagicDNS host. */
export interface PushBox {
  instance: string;
  host: string;
}

/**
 * One box's answer. `forbidden` is the box's 403 `FORBIDDEN`: this `device_id`
 * is registered there by another tailnet login (a reinstall that kept the id,
 * or a second member's phone that chose the same one). Retrying cannot fix
 * it; the caller mints a new `device_id` and registers again. `box` and
 * `status` are always set here; they are optional only so a registrar double
 * may answer the bare `{ instance, ok }`.
 */
export type PushBoxResult =
  | { instance: string; box?: PushBox; status?: "ok"; ok: true }
  | {
      instance: string;
      box?: PushBox;
      status?: "failed" | "forbidden";
      ok: false;
      code: string;
      message: string;
    };

function forbidden(error: unknown): boolean {
  if (errorCode(error) === "FORBIDDEN") return true;
  const details = (error as { details?: { status?: unknown } } | null)?.details;
  return details?.status === 403;
}

async function each(
  boxes: readonly PushBox[],
  call: (box: PushBox) => Promise<unknown>,
): Promise<PushBoxResult[]> {
  const settled = await Promise.allSettled(boxes.map((box) => call(box)));
  return settled.map((result, i) => {
    const box = boxes[i] ?? { instance: "", host: "" };
    const instance = box.instance;
    if (result.status === "fulfilled") return { instance, box, status: "ok", ok: true };
    return {
      instance,
      box,
      status: forbidden(result.reason) ? "forbidden" : "failed",
      ok: false,
      ...reasonOf(result.reason),
    };
  });
}

/**
 * Register (or update) `device` with every box in `boxes`. The body is
 * `device` as given, every field of it (`MobilePushDevice` grows; nothing here
 * picks fields).
 */
export function registerDevice(
  boxes: readonly PushBox[],
  device: MobilePushDevice,
  fetch: FetchLike,
  opts: { timeoutMs?: number } = {},
): Promise<PushBoxResult[]> {
  const body = JSON.stringify(device);
  return each(boxes, (box) =>
    callHermeticd(fetch, box.host, RPC_PATHS.pushDevices, { method: "POST", body, ...opts }),
  );
}

/** Forget `deviceId` on every box in `boxes`. */
export function unregisterDevice(
  boxes: readonly PushBox[],
  deviceId: string,
  fetch: FetchLike,
  opts: { timeoutMs?: number } = {},
): Promise<PushBoxResult[]> {
  return each(boxes, (box) =>
    callHermeticd(fetch, box.host, pushDevicePath(deviceId), { method: "DELETE", ...opts }),
  );
}
