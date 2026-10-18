/**
 * The phone's pairing link (round 3): `hermetic://fleet?v=3&…`, the text the
 * laptop draws as a QR and the phone scans.
 *
 * It names a fleet, carries a snapshot of its agents and, optionally, the
 * viewer preferences the phone should start with, and nothing else. It holds
 * **no secret**: the phone's authentication to the fleet is tailnet
 * membership, exactly like the laptop's, so anyone who reads the link learns
 * a fleet id, an account id, a region, a tailnet name and some agent names,
 * and can reach none of them without being on the tailnet.
 *
 * ```
 * hermetic://fleet?v=3&fleet=<id>&alias=<alias or empty>&account=<12 digits>
 *   &region=<region>&tailnet=<tailnet>[&prefs=<key>:<value>(;<key>:<value>)*]
 *   [&n=<every live agent>]&agents=<name[:host],…>
 * ```
 *
 * `prefs` is the extensible part. It is present only when a preference is set,
 * and it is forward-compatible in both directions: the parser accepts `v=2`
 * (which never has `prefs`) and `v=3`, and drops a pref key it does not know,
 * a value outside that key's rule, or a malformed `prefs` string as a whole,
 * without refusing the link. A preference is a starting point the phone may
 * change later, so losing one is never a reason to lose the pairing. The keys
 * this build knows are `MOBILE_LINK_PREF_KEYS`.
 *
 * `host` follows a name only where the box's real MagicDNS name differs from
 * the one the phone would derive (`cloudName(fleet_id, name).<tailnet>`). The
 * first `MOBILE_LINK_MAX_AGENTS` agents may carry one; past that the link
 * carries names only. Past `MOBILE_LINK_MAX_LENGTH` characters it first drops
 * host overrides, from the end, and only then whole agents, from the end, and
 * never `prefs` (a few dozen characters at most): a
 * name without its host still lets the phone find the box (the derived name
 * may be stale, `GET /fleet` corrects it), a name left out does not. Either
 * way the phone fills the rest from hermeticd's `GET /fleet`. A link that left
 * agents out says so: `n` is the fleet's full agent count, written only then,
 * so the phone can tell a trimmed list from a fleet that shrank. A parser that
 * predates `n` ignores it, as it ignores any unknown parameter.
 *
 * Pure values only — no Zod, no `node:*`, no `URL`/`URLSearchParams` (React
 * Native's are incomplete) — because the phone imports this parser through
 * `@hermetic/core/shared` and the desktop page bundles it. The character
 * rules below restate `FleetIdSchema`, `FleetName`, `AccountId` and `Region`
 * (`schema/common.ts`, `schema/directory.ts`), which this module may not
 * import; `packages/core/test/mobile-link.test.ts` pins them together.
 */
import { HermeticError } from "../errors.ts";
import { type AvatarStyle, isAvatarStyle } from "./avatar/style.ts";
import { AGENT_NAME_RE } from "./naming.ts";

export const MOBILE_LINK_PREFIX = "hermetic://fleet";
/** The version the encoder writes. The parser also reads `MOBILE_LINK_ACCEPTED_VERSIONS`. */
export const MOBILE_LINK_VERSION = 3;
/** Every `v` the parser reads: v2 is v3 without `prefs`. */
export const MOBILE_LINK_ACCEPTED_VERSIONS: readonly number[] = [2, 3];
/** Agents past this many are carried as bare names, without a host override. */
export const MOBILE_LINK_MAX_AGENTS = 60;
/**
 * The longest link the encoder emits: under a version-40-L QR's 2,953 bytes,
 * so it always draws. Past it, host overrides go first, then agents, each from
 * the end.
 */
export const MOBILE_LINK_MAX_LENGTH = 2_900;
/** The parser refuses any input longer than this before looking at it. */
const MAX_INPUT_LENGTH = 4_096;

/** One agent in the link: its name, and its MagicDNS host when that is not the derived one. */
export interface MobileLinkAgentEntry {
  name: string;
  host?: string;
}

/**
 * The viewer preferences a link carries, each optional: the phone starts with
 * them on pairing and may change them in its own Settings afterwards.
 */
export interface MobileLinkPrefs {
  avatar_style?: AvatarStyle;
}

/** Every pref key this build reads and writes, in the order the encoder writes them. */
export const MOBILE_LINK_PREF_KEYS = [
  "avatar_style",
] as const satisfies readonly (keyof MobileLinkPrefs)[];

/** A pref key or value: lowercase letters, digits, `_` and `-`, so it needs no encoding. */
const PREF_TOKEN_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Set `key` to `value` on `prefs` when this build knows the key and the value
 * passes its rule; otherwise leave `prefs` as it was. The one place a pref's
 * rule lives: the encoder refuses what this would not set, the parser drops it.
 */
function setPref(prefs: MobileLinkPrefs, key: string, value: string): void {
  if (!PREF_TOKEN_RE.test(key) || !PREF_TOKEN_RE.test(value)) return;
  if (key === "avatar_style" && isAvatarStyle(value)) prefs.avatar_style = value;
}

/** What a link names. `alias` is display only; `fleet_id` is the identity (§4.6). */
export interface MobileLinkPayload {
  fleet_id: string;
  alias: string | null;
  account_id: string;
  region: string;
  tailnet: string;
  agents: MobileLinkAgentEntry[];
  /** `{}` when the link carries none (every v2 link). */
  prefs: MobileLinkPrefs;
  /**
   * The fleet's full agent count, present only when the link was trimmed and
   * `agents` names fewer (`n`). Absent: `agents` is every live agent.
   */
  agents_total?: number;
}

/** What `encodeMobileLink` takes: a payload whose `prefs` may be left out. */
export type MobileLinkInput = Omit<MobileLinkPayload, "prefs" | "agents_total"> & {
  prefs?: MobileLinkPrefs;
};

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
function payloadProblem(p: MobileLinkInput): string | null {
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
  for (const [key, value] of Object.entries(p.prefs ?? {})) {
    if (value === undefined) continue;
    const check: MobileLinkPrefs = {};
    if (typeof value === "string") setPref(check, key, value);
    if ((check as Record<string, unknown>)[key] !== value) return `pref ${key}`;
  }
  return null;
}

/** `prefs`' value: `key:value` pairs joined by `;`, in key order; empty when none is set. */
function renderPrefs(prefs: MobileLinkPrefs | undefined): string {
  const pairs: string[] = [];
  for (const key of MOBILE_LINK_PREF_KEYS) {
    const value = prefs?.[key];
    if (value !== undefined) pairs.push(`${key}:${value}`);
  }
  return pairs.join(";");
}

function render(p: MobileLinkInput, agents: readonly MobileLinkAgentEntry[], total?: number): string {
  const list = agents.map((a) => (a.host !== undefined ? `${a.name}:${a.host}` : a.name)).join(",");
  const prefs = renderPrefs(p.prefs);
  // Every value is drawn from [A-Za-z0-9.-] (plus `:` and `,` in `agents`,
  // and `_`, `:` and `;` in `prefs`, all legal in a query), so nothing needs
  // percent-encoding.
  return (
    `${MOBILE_LINK_PREFIX}?v=${MOBILE_LINK_VERSION}` +
    `&fleet=${p.fleet_id}` +
    `&alias=${p.alias ?? ""}` +
    `&account=${p.account_id}` +
    `&region=${p.region}` +
    `&tailnet=${p.tailnet}` +
    (prefs === "" ? "" : `&prefs=${prefs}`) +
    (total === undefined ? "" : `&n=${total}`) +
    `&agents=${list}`
  );
}

/**
 * The prefs a link's `prefs` value names. Forgiving on purpose: a malformed
 * string (a character outside the token rules, an entry without `:`) reads as
 * no prefs, and an unknown key, an invalid value or a repeated key is dropped
 * on its own. A newer laptop's pref never costs an older phone the pairing.
 */
function parsePrefs(raw: string | undefined): MobileLinkPrefs {
  const prefs: MobileLinkPrefs = {};
  if (raw === undefined || raw === "") return prefs;
  const entries: [string, string][] = [];
  for (const entry of raw.split(";")) {
    const colon = entry.indexOf(":");
    if (colon === -1) return {};
    const key = entry.slice(0, colon);
    const value = entry.slice(colon + 1);
    if (!PREF_TOKEN_RE.test(key) || !PREF_TOKEN_RE.test(value)) return {};
    entries.push([key, value]);
  }
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const [key] of entries) {
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  for (const [key, value] of entries) {
    if (!repeated.has(key)) setPref(prefs, key, value);
  }
  return prefs;
}

/**
 * The link for `payload`. Throws `VALIDATION` on a payload the parser would
 * refuse, so a link this returns always parses (an unknown pref key or an
 * invalid pref value is a `VALIDATION` too: the encoder writes only what this
 * build's parser reads). Hosts past `MOBILE_LINK_MAX_AGENTS` are omitted.
 * While the link is longer than `MOBILE_LINK_MAX_LENGTH` characters, host
 * overrides are dropped from the end, and only when none is left are agents
 * dropped from the end, and `n` then carries the full count; `prefs` is never
 * dropped. Parse the result to learn what it kept.
 */
export function encodeMobileLink(payload: MobileLinkInput): string {
  const problem = payloadProblem(payload);
  if (problem !== null) {
    throw new HermeticError("VALIDATION", `cannot encode a pairing link: invalid ${problem}`, {
      field: problem,
    });
  }
  const agents: MobileLinkAgentEntry[] = payload.agents.map((a, i) =>
    a.host !== undefined && i < MOBILE_LINK_MAX_AGENTS
      ? { name: a.name, host: a.host }
      : { name: a.name },
  );
  let link = render(payload, agents);
  for (let i = agents.length - 1; i >= 0 && link.length > MOBILE_LINK_MAX_LENGTH; i--) {
    const agent = agents[i];
    if (agent?.host === undefined) continue;
    agents[i] = { name: agent.name };
    link = render(payload, agents);
  }
  let count = agents.length;
  while (link.length > MOBILE_LINK_MAX_LENGTH && count > 0) {
    count--;
    link = render(payload, agents.slice(0, count), agents.length);
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
 * v2 or v3 fleet link: another scheme, another version, a missing or repeated
 * field, a value outside its character rules, a duplicate agent. Unknown
 * parameters are ignored, and `prefs` never refuses a link (`parsePrefs`).
 * Never throws, whatever it is handed.
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
    const version = fields.get("v");
    if (!MOBILE_LINK_ACCEPTED_VERSIONS.some((v) => String(v) === version)) return null;
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
      prefs: parsePrefs(fields.get("prefs")),
    };
    // Forgiving, like `prefs`: an `n` that is not a count above the list is dropped.
    const total = fields.get("n");
    if (total !== undefined && /^\d{1,6}$/.test(total) && Number(total) > agents.length)
      payload.agents_total = Number(total);
    return payloadProblem(payload) === null ? payload : null;
  } catch {
    return null;
  }
}
