/**
 * Settings › Mobile, minus React: the pairing link's QR and the sentences the
 * page says about it. Pure and DOM-free, so each rule is tested from literals
 * (`test/mobile-logic.test.ts`).
 */
import { encodeQr, qrToSvg } from "@hermetic/core/shared";

/**
 * The pairing link as an SVG QR, or `null` when it is too long for the
 * encoder. Core's encoder emits fixed markup and module coordinates only, so
 * no character of the link reaches the SVG.
 */
export function pairQrSvg(link: string): string | null {
  try {
    return qrToSvg(encodeQr(link));
  } catch {
    return null;
  }
}

/** `11 of 11 agents in the code`: how many of the fleet's live agents the link names. */
export function agentsInLinkLine(inLink: number, total: number): string {
  return `${inLink} of ${total} agent${total === 1 ? "" : "s"} in the code`;
}

/**
 * Why the link names fewer agents than the fleet has, or `null` when it names
 * them all. Core trims the list only to keep the link short enough for a QR;
 * the phone reads the full list from the fleet once it is on the tailnet.
 */
export function agentsLeftOutNote(inLink: number, total: number): string | null {
  const left = total - inLink;
  if (left <= 0) return null;
  return `The phone reads the other ${left} from the fleet once it is on the tailnet.`;
}

/** A fleet as heads name it: the alias when it has one, else its id (§4.6). */
export function fleetLabel(fleet: { fleet_id: string; alias: string | null }): string {
  return fleet.alias ?? fleet.fleet_id;
}

/** The one line of setup the phone needs before it scans. */
export function pairHelp(tailnet: string): string {
  return `Install the Hermetic app and Tailscale on the phone, sign Tailscale into ${tailnet}, then scan this code.`;
}
