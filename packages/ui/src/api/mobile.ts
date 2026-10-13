/**
 * The phone companion's pairing link, from Settings › Mobile.
 *
 * `mobile.pair` reads the open fleet and its live agents and answers a
 * `hermetic://fleet?…` link for the QR. A read: it mints nothing and the link
 * holds no secret, since the phone authenticates to the boxes by being on the
 * fleet's tailnet.
 */
import { transport } from "./transport.ts";
import type { MobilePairView } from "./types.ts";

export function pairMobile(): Promise<MobilePairView> {
  return transport().request<MobilePairView>("mobile.pair", {});
}
