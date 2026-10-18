/**
 * The phone companion's pairing link, from Settings › Mobile.
 *
 * `mobile.pair` reads the open fleet and its live agents and answers a
 * `hermetic://fleet?…` link for the QR. A read: it mints nothing and the link
 * holds no secret, since the phone authenticates to the boxes by being on the
 * fleet's tailnet. `prefs` are the viewer preferences the phone starts with
 * (this page's avatar style); the phone may change them later.
 */
import type { AvatarStyle } from "@hermetic/core/shared";
import { transport } from "./transport.ts";
import type { MobilePairView } from "./types.ts";

/** The preferences a pairing link may carry to the phone (`MobilePairPrefs` in core). */
export interface MobilePairPrefsRequest {
  avatar_style?: AvatarStyle;
}

export function pairMobile(prefs: MobilePairPrefsRequest = {}): Promise<MobilePairView> {
  return transport().request<MobilePairView>(
    "mobile.pair",
    Object.keys(prefs).length === 0 ? {} : { prefs },
  );
}
