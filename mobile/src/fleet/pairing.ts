/**
 * Pairing: a `hermetic://fleet?v=2&…` link (scanned, deep-linked or pasted)
 * read into the fleet the phone will keep, or the reason it will not.
 *
 * The link format is core's (`parseMobileLink` through `@hermetic/core/shared`,
 * the same parser `mobile.pair` is checked against in
 * `tests/mobile-link-seam.test.ts`); what is here is the phone's own caution on
 * top of it. A link carries no secret, so a link that *looks* like it carries
 * one (`token`, `key`, `secret`, `code` in a parameter name) is refused rather
 * than stored: it is not one `hermetic mobile pair` made. The tailnet must be a
 * Tailscale MagicDNS suffix (`*.ts.net`) or the one the build names as the
 * operator's, because the phone will dial names under it. Labels from outside
 * the app are cleaned before a screen shows them. Pure.
 */
import { MOBILE_LINK_PREFIX, type MobileLinkPayload, parseMobileLink } from "@hermetic/core/shared";

export interface PairErrorCopy {
  title: string;
  detail: string;
}

/** The longest label a phone shows for a name it did not choose (a fleet alias). */
export const LABEL_MAX = 64;

/**
 * Text from outside the app made safe to show: control and bidi-override
 * characters removed (so `‮` cannot reverse what follows), trimmed, and capped
 * at `max` characters.
 */
export function cleanLabel(raw: string | null | undefined, max: number = LABEL_MAX): string {
  return (raw ?? "")
    .replace(/[\p{Cc}‎‏‪-‮⁦-⁩]/gu, "")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * A fleet id as core mints it: 8 lowercase Crockford base32 characters
 * (`FLEET_ID_ALPHABET` in `packages/core/src/schema/common.ts`), e.g. `fxtr0001`.
 */
export const FLEET_ID_RE = /^[0123456789abcdefghjkmnpqrstvwxyz]{8}$/;

/** Parameter names a pairing link must never carry: it holds no secret. */
const CREDENTIAL_KEY = /token|key|secret|code/i;

/** The query's parameter names, read without decoding anything else. */
function paramNames(link: string): string[] {
  const query = link.slice(link.indexOf("?") + 1);
  return query
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      const raw = eq === -1 ? part : part.slice(0, eq);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    })
    .filter((name) => name.length > 0);
}

/** Whether `tailnet` is a zone the phone may dial names under. */
export function tailnetAllowed(tailnet: string, operatorTailnet?: string | null): boolean {
  const zone = tailnet.trim().toLowerCase().replace(/\.$/, "");
  if (zone.endsWith(".ts.net") && zone !== "ts.net") return true;
  const operator = operatorTailnet?.trim().toLowerCase().replace(/\.$/, "");
  return !!operator && zone === operator;
}

/** A pairing link, read and checked: what the confirm screen shows and what is stored. */
export interface PairedLink {
  /** The link as scanned, trimmed: what is kept, so a re-parse gives the same answer. */
  link: string;
  payload: MobileLinkPayload;
  /** `alias` cleaned for display, else the fleet id. */
  label: string;
}

export type PairProposal = { ok: true; link: PairedLink } | { ok: false; error: PairErrorCopy };

export interface PairOptions {
  /** A tailnet other than `*.ts.net` the build trusts (an operator's custom domain). */
  operatorTailnet?: string | null;
}

const NOT_A_LINK: PairErrorCopy = {
  title: "That is not a Hermetic pairing link.",
  detail:
    "Scan the QR from `hermetic mobile pair` on the laptop (or Settings → Pair a phone in the desktop app), or paste the `hermetic://fleet?v=2&…` link it prints.",
};

/**
 * The one gate between a link and the confirmation screen: core's parser, then
 * the phone's refusals. Nothing the link spells reaches a screen unchecked.
 */
export function readPairingLink(text: unknown, opts: PairOptions = {}): PairProposal {
  if (typeof text !== "string") return { ok: false, error: NOT_A_LINK };
  const link = text.trim();
  if (!link.startsWith(`${MOBILE_LINK_PREFIX}?`)) return { ok: false, error: NOT_A_LINK };
  const credential = paramNames(link).find((name) => CREDENTIAL_KEY.test(name));
  if (credential !== undefined)
    return {
      ok: false,
      error: {
        title: "This link carries a credential, so the app will not keep it.",
        detail: `A Hermetic pairing link names a fleet and nothing secret; this one has a \`${cleanLabel(credential, 32)}\` parameter. Make a new link with \`hermetic mobile pair\`.`,
      },
    };
  const payload = parseMobileLink(link);
  if (payload === null) {
    if (/[?&]v=1(&|$)/.test(link))
      return {
        ok: false,
        error: {
          title: "That link is from an older Hermetic.",
          detail: "Update hermetic on the laptop and run `hermetic mobile pair` again.",
        },
      };
    return { ok: false, error: NOT_A_LINK };
  }
  if (!FLEET_ID_RE.test(payload.fleet_id)) return { ok: false, error: NOT_A_LINK };
  if (!tailnetAllowed(payload.tailnet, opts.operatorTailnet))
    return {
      ok: false,
      error: {
        title: `${cleanLabel(payload.tailnet) || "That tailnet"} is not a Tailscale tailnet.`,
        detail:
          "The phone reaches the fleet only over Tailscale, at names under the tailnet's `*.ts.net` suffix.",
      },
    };
  const alias = cleanLabel(payload.alias);
  return {
    ok: true,
    link: { link, payload, label: alias || payload.fleet_id },
  };
}

/** The confirm screen's lines: fleet, tailnet, agent count. */
export function pairConfirmLines(paired: PairedLink): {
  fleet: string;
  tailnet: string;
  agents: string;
} {
  const { payload } = paired;
  const alias = cleanLabel(payload.alias);
  const n = payload.agents.length;
  return {
    fleet: alias && alias !== payload.fleet_id ? `${alias} · ${payload.fleet_id}` : payload.fleet_id,
    tailnet: cleanLabel(payload.tailnet),
    agents: `${n} agent${n === 1 ? "" : "s"}`,
  };
}

/**
 * Where an incoming system URL goes. A `hermetic://fleet?…` link (a scanned QR
 * opened by the Camera app, or a tapped link) becomes `/pair?link=<the link>`,
 * so the Pair screen reads it whole and shows the confirmation; it never pairs
 * by itself. Anything else is left as it came.
 */
export function pairingRedirect(path: string): string {
  const q = path.indexOf("?");
  const head = q === -1 ? path : path.slice(0, q);
  if (!/^(hermetic:\/\/|\/)?fleet\/?$/i.test(head)) return path;
  if (q === -1) return "/pair";
  return `/pair?link=${encodeURIComponent(`${MOBILE_LINK_PREFIX}${path.slice(q)}`)}`;
}
