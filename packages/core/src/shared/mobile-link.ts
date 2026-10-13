/**
 * The phone's pairing link (round 3): `hermetic://fleet?v=2&…`, the text the
 * laptop draws as a QR and the phone scans.
 *
 * It names a fleet and carries a snapshot of its agents, and nothing else. It
 * holds **no secret**: the phone's authentication to the fleet is tailnet
 * membership, exactly like the laptop's, so anyone who reads the link learns
 * a fleet id, an account id, a region, a tailnet name and some agent names,
 * and can reach none of them without being on the tailnet.
 *
 * ```
 * hermetic://fleet?v=2&fleet=<id>&alias=<alias or empty>&account=<12 digits>
 *   &region=<region>&tailnet=<tailnet>&agents=<name[:host],…>
 * ```
 *
 * `host` follows a name only where the box's real MagicDNS name differs from
 * the one the phone would derive (`cloudName(fleet_id, name).<tailnet>`). The
 * first `MOBILE_LINK_MAX_AGENTS` agents may carry one; past that the link
 * carries names only, and past `MOBILE_LINK_MAX_LENGTH` characters it drops
 * agents from the end. Either way the phone fills the rest from hermeticd's
 * `GET /fleet`.
 *
 * Pure values only — no Zod, no `node:*`, no `URL`/`URLSearchParams` (React
 * Native's are incomplete) — because the phone imports this parser through
 * `@hermetic/core/shared` and the desktop page bundles it. The character
 * rules below restate `FleetIdSchema`, `FleetName`, `AccountId` and `Region`
 * (`schema/common.ts`, `schema/directory.ts`), which this module may not
 * import; `packages/core/test/mobile-link.test.ts` pins them together.
 */
import { HermeticError } from "../errors.ts";
import { AGENT_NAME_RE } from "./naming.ts";

export const MOBILE_LINK_PREFIX = "hermetic://fleet";
export const MOBILE_LINK_VERSION = 2;
/** Agents past this many are carried as bare names, without a host override. */
export const MOBILE_LINK_MAX_AGENTS = 60;
/**
 * The longest link the encoder emits: under a version-40-L QR's 2,953 bytes,
 * so it always draws. Agents past what fits are dropped from the end.
 */
export const MOBILE_LINK_MAX_LENGTH = 2_900;
/** The parser refuses any input longer than this before looking at it. */
const MAX_INPUT_LENGTH = 4_096;

/** One agent in the link: its name, and its MagicDNS host when that is not the derived one. */
export interface MobileLinkAgentEntry {
  name: string;
  host?: string;
}

/** What a link names. `alias` is display only; `fleet_id` is the identity (§4.6). */
export interface MobileLinkPayload {
  fleet_id: string;
  alias: string | null;
  account_id: string;
  region: string;
  tailnet: string;
  agents: MobileLinkAgentEntry[];
}

const FLEET_ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/;
const FLEET_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ACCOUNT_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
/** A DNS name with at least two labels, no trailing dot, no scheme, no port. */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function isHost(value: string): boolean {
  return value.length <= 253 && HOST_RE.test(value);
}

function isAgentName(value: string): boolean {
  return AGENT_NAME_RE.test(value);
}

/** Why a payload cannot be encoded, or `null` when it can. */
function payloadProblem(p: MobileLinkPayload): string | null {
  if (!FLEET_ID_RE.test(p.fleet_id)) return "fleet_id";
  if (p.alias !== null && !FLEET_ALIAS_RE.test(p.alias)) return "alias";
  if (!ACCOUNT_RE.test(p.account_id)) return "account_id";
  if (!REGION_RE.test(p.region)) return "region";
  if (!isHost(p.tailnet)) return "tailnet";
  const seen = new Set<string>();
  for (const a of p.agents) {
    if (!isAgentName(a.name)) return "agent name";
    if (seen.has(a.name)) return "duplicate agent name";
    seen.add(a.name);
    if (a.host !== undefined && !isHost(a.host)) return "agent host";
  }
  return null;
}

function render(p: MobileLinkPayload, agents: readonly MobileLinkAgentEntry[]): string {
  const list = agents
    .map((a, i) =>
      a.host !== undefined && i < MOBILE_LINK_MAX_AGENTS ? `${a.name}:${a.host}` : a.name,
    )
    .join(",");
  // Every value is drawn from [A-Za-z0-9.-] (plus `:` and `,` in `agents`,
  // both legal in a query), so nothing needs percent-encoding.
  return (
    `${MOBILE_LINK_PREFIX}?v=${MOBILE_LINK_VERSION}` +
    `&fleet=${p.fleet_id}` +
    `&alias=${p.alias ?? ""}` +
    `&account=${p.account_id}` +
    `&region=${p.region}` +
    `&tailnet=${p.tailnet}` +
    `&agents=${list}`
  );
}

/**
 * The link for `payload`. Throws `VALIDATION` on a payload the parser would
 * refuse, so a link this returns always parses. Hosts past
 * `MOBILE_LINK_MAX_AGENTS` are omitted, and agents are dropped from the end
 * until the link is at most `MOBILE_LINK_MAX_LENGTH` characters; parse the
 * result to learn how many it kept.
 */
export function encodeMobileLink(payload: MobileLinkPayload): string {
  const problem = payloadProblem(payload);
  if (problem !== null) {
    throw new HermeticError("VALIDATION", `cannot encode a pairing link: invalid ${problem}`, {
      field: problem,
    });
  }
  let count = payload.agents.length;
  let link = render(payload, payload.agents);
  while (link.length > MOBILE_LINK_MAX_LENGTH && count > 0) {
    count--;
    link = render(payload, payload.agents.slice(0, count));
  }
  return link;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * The payload a link names, or `null` for anything that is not a well-formed
 * v2 fleet link: another scheme, a missing or repeated field, a value outside
 * its character rules, a duplicate agent. Never throws, whatever it is handed.
 */
export function parseMobileLink(text: unknown): MobileLinkPayload | null {
  try {
    if (typeof text !== "string" || text.length > MAX_INPUT_LENGTH) return null;
    const trimmed = text.trim();
    const head = `${MOBILE_LINK_PREFIX}?`;
    if (!trimmed.startsWith(head)) return null;
    const query = trimmed.slice(head.length);
    if (query.includes("#")) return null;
    const fields = new Map<string, string>();
    for (const part of query.split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      const key = decode(part.slice(0, eq));
      const value = decode(part.slice(eq + 1));
      if (key === null || value === null) return null;
      if (fields.has(key)) return null;
      fields.set(key, value);
    }
    if (fields.get("v") !== String(MOBILE_LINK_VERSION)) return null;
    const fleet_id = fields.get("fleet");
    const alias = fields.get("alias");
    const account_id = fields.get("account");
    const region = fields.get("region");
    const tailnet = fields.get("tailnet");
    const agentList = fields.get("agents");
    if (
      fleet_id === undefined ||
      alias === undefined ||
      account_id === undefined ||
      region === undefined ||
      tailnet === undefined ||
      agentList === undefined
    ) {
      return null;
    }
    const agents: MobileLinkAgentEntry[] = [];
    if (agentList !== "") {
      for (const entry of agentList.split(",")) {
        const colon = entry.indexOf(":");
        const name = colon === -1 ? entry : entry.slice(0, colon);
        const host = colon === -1 ? undefined : entry.slice(colon + 1);
        agents.push(host === undefined ? { name } : { name, host });
      }
    }
    const payload: MobileLinkPayload = {
      fleet_id,
      alias: alias === "" ? null : alias,
      account_id,
      region,
      tailnet,
      agents,
    };
    return payloadProblem(payload) === null ? payload : null;
  } catch {
    return null;
  }
}
