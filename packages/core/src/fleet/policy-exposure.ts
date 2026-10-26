/**
 * What the rest of the tailnet policy lets an agent box do (§5.2).
 *
 * hermetic writes three entries and edits nothing else, and that is the right
 * boundary for *writing*. It is the wrong boundary for *looking*: the rules an
 * operator wrote long before hermetic arrived decide whether a compromised agent
 * — an AI with root on its own box — can reach the rest of the tailnet. The
 * managed rules only ever point *at* `tag:hermetic`; this module reads every
 * rule for the opposite direction and reports the ones that point *out of* it.
 *
 * It is pure: a parsed policy in, a list of findings out. No I/O, no Tailscale
 * API, no knowledge of which addresses the fleet's boxes hold today — so an
 * address range is judged against the whole tailnet range, and a range that
 * might or might not hold a box is reported as `info`, never silently skipped
 * and never claimed as certain.
 *
 * Findings name a rule by its top-level key and position only. The policy file
 * names people (a `groups` entry is a list of email addresses, §8.3), so every
 * word of a summary comes from the fixed vocabulary in this file and none from
 * the document — the same rule `managedDiff` follows for the diff.
 *
 * Selector semantics follow Tailscale's targets-and-selectors reference
 * (tailscale.com/kb/1396/targets) and the grants/via pages (kb/1378/via); see
 * each case below for what was taken from where.
 */
import { parseHujson } from "./hujson.ts";
import { TAILSCALE_TAG } from "../aws/tailscale.ts";
import type { PolicyExposure, PolicyExposureSeverity } from "../schema/index.ts";

/** Whether a selector matches an agent box: certainly, possibly, or not at all. */
type Reach = "yes" | "maybe" | "no";

/**
 * A selector's verdict and, when it matches, the fixed phrase saying how. The
 * phrase is the selector's *kind* — "a group", "a host alias" — never its name,
 * which may be a person's.
 */
interface Match {
  reach: Reach;
  how: string;
}

const NO: Match = { reach: "no", how: "" };
const RANK: Record<Reach, number> = { no: 0, maybe: 1, yes: 2 };

/** The stronger of two verdicts; the first wins a tie, so the phrase is stable. */
function stronger(a: Match, b: Match): Match {
  return RANK[b.reach] > RANK[a.reach] ? b : a;
}

/**
 * Selectors that match every tagged node outright. `*` is every source;
 * `autogroup:tagged` is "all devices that have at least one tag"; and
 * `autogroup:danger-all` is `*` plus devices shared in from other tailnets.
 */
const MATCHES_EVERY_BOX: Record<string, string> = {
  "*": "`*`",
  [TAILSCALE_TAG]: TAILSCALE_TAG,
  "autogroup:tagged": "autogroup:tagged",
  "autogroup:danger-all": "autogroup:danger-all",
};

/**
 * `autogroup:self` in a `dst` means "devices owned by the same user as the
 * source". A tagged device is owned by its tag, not a user, so for a box as the
 * source it names nothing — Tailscale documents that it applies to user-owned
 * devices only.
 */
const SELF = "autogroup:self";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** An inclusive address range, as integers, in one family. */
interface Span {
  v6: boolean;
  lo: bigint;
  hi: bigint;
}

function parseV4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function parseV6(text: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(`0x${g}`);
  }
  return n;
}

function parseAddress(text: string): { v6: boolean; n: bigint } | null {
  const v4 = parseV4(text);
  if (v4 !== null) return { v6: false, n: v4 };
  const v6 = parseV6(text);
  return v6 === null ? null : { v6: true, n: v6 };
}

/** An address, a CIDR, or an `a-b` range (the form `ipsets` accept). */
function parseSpan(text: string): Span | null {
  const dash = text.indexOf("-");
  if (dash > 0) {
    const lo = parseAddress(text.slice(0, dash));
    const hi = parseAddress(text.slice(dash + 1));
    if (lo === null || hi === null || lo.v6 !== hi.v6 || lo.n > hi.n) return null;
    return { v6: lo.v6, lo: lo.n, hi: hi.n };
  }
  const slash = text.indexOf("/");
  const addr = parseAddress(slash === -1 ? text : text.slice(0, slash));
  if (addr === null) return null;
  const width = addr.v6 ? 128 : 32;
  const bits = slash === -1 ? width : Number(text.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const host = (1n << BigInt(width - bits)) - 1n;
  const lo = addr.n & ~host & ((1n << BigInt(width)) - 1n);
  return { v6: addr.v6, lo, hi: lo | host };
}

/**
 * Where a box's tailnet address can be: Tailscale assigns IPv4 from the CGNAT
 * range and IPv6 from its own ULA prefix. A range covering all of one of these
 * certainly holds every box; a range overlapping part of one may hold some.
 */
const TAILNET_SPANS: readonly Span[] = [parseSpan("100.64.0.0/10")!, parseSpan("fd7a:115c:a1e0::/48")!];

function addressReach(span: Span): Reach {
  let reach: Reach = "no";
  for (const t of TAILNET_SPANS) {
    if (t.v6 !== span.v6) continue;
    if (span.lo <= t.lo && span.hi >= t.hi) return "yes";
    if (span.lo <= t.hi && span.hi >= t.lo) reach = "maybe";
  }
  return reach;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The named collections a selector can refer to. */
interface Aliases {
  groups: Record<string, unknown>;
  hosts: Record<string, unknown>;
  ipsets: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Does `selector` match an agent box?
 *
 * - `*`, `tag:hermetic`, `autogroup:tagged`, `autogroup:danger-all`: yes.
 * - Any other tag, autogroup or user (anything with an `@`): no. In particular
 *   `autogroup:member` is the tailnet's *users*, and a tagged device belongs to
 *   its tag, not to a user.
 * - `group:…`: groups hold users. Tailscale refuses `autogroup:tagged` inside a
 *   group, and its reference documents no tag member either, so a group matches
 *   only if its members somehow resolve to one of the above — resolved anyway,
 *   recursively, so a hand-built policy the API would refuse cannot hide one.
 * - `ipset:…`: its targets are addresses, ranges, hosts and other ipsets (never
 *   tags, users or groups). Resolved as a union of its `add` targets; a
 *   `remove` that touches the tailnet range demotes a certain match to a
 *   possible one, since this module does not know which addresses boxes hold.
 * - A `hosts` alias: resolved to the address or range it names.
 * - A bare address, CIDR or range: judged against the tailnet range.
 */
function resolve(selector: string, aliases: Aliases, seen: ReadonlySet<string> = new Set()): Match {
  const outright = MATCHES_EVERY_BOX[selector];
  if (outright !== undefined) return { reach: "yes", how: outright };
  if (seen.has(selector)) return NO;
  const inner = new Set(seen).add(selector);

  if (selector.startsWith("group:")) {
    const found = strings(aliases.groups[selector]).reduce<Match>(
      (acc, m) => stronger(acc, resolve(m, aliases, inner)),
      NO,
    );
    return found.reach === "no" ? NO : { reach: found.reach, how: "a group" };
  }
  if (selector.startsWith("ipset:")) {
    let found: Match = NO;
    let removed = false;
    for (const raw of strings(aliases.ipsets[selector])) {
      const entry = raw.trim();
      const op = /^(add|remove)\s+(.+)$/.exec(entry);
      const target = op ? op[2]!.trim() : entry;
      const verdict = resolve(target, aliases, inner);
      if (op?.[1] === "remove") removed ||= verdict.reach !== "no";
      else found = stronger(found, verdict);
    }
    if (found.reach === "no") return NO;
    return { reach: removed ? "maybe" : found.reach, how: "an ipset" };
  }
  if (selector.startsWith("tag:") || selector.startsWith("autogroup:") || selector.includes("@")) {
    return NO;
  }
  if (Object.hasOwn(aliases.hosts, selector)) {
    const target = aliases.hosts[selector];
    const span = typeof target === "string" ? parseSpan(target) : null;
    const reach = span === null ? "no" : addressReach(span);
    return reach === "no" ? NO : { reach, how: "a host alias" };
  }
  const span = parseSpan(selector);
  if (span === null) return NO;
  const reach = addressReach(span);
  return reach === "no" ? NO : { reach, how: "an address range" };
}

function resolveAll(selectors: readonly string[], aliases: Aliases): Match {
  return selectors.reduce<Match>((acc, s) => stronger(acc, resolve(s, aliases)), NO);
}

/**
 * An `acls` destination is `target:ports`. The port list follows the last
 * colon; a bracketed IPv6 address keeps its own colons.
 */
function aclTarget(dst: string): string {
  if (dst.startsWith("[")) {
    const close = dst.indexOf("]");
    return close === -1 ? dst : dst.slice(1, close);
  }
  const colon = dst.lastIndexOf(":");
  return colon === -1 ? dst : dst.slice(0, colon);
}

/** True when every destination is another agent box (or names nothing for a tagged source). */
function solelyHermetic(targets: readonly string[]): boolean {
  return targets.every((t) => t === TAILSCALE_TAG || t === SELF);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function severityOf(reach: Reach): PolicyExposureSeverity {
  return reach === "yes" ? "high" : "info";
}

/** "agent boxes", or a hedge when only part of the tailnet range is named. */
function subject(match: Match): string {
  return match.reach === "yes" ? "agent boxes" : "addresses that may belong to agent boxes";
}

function finding(rule: string, index: number | null, match: Match, what: string): PolicyExposure {
  return {
    rule,
    index,
    severity: severityOf(match.reach),
    summary: `${rule}${index === null ? "" : `[${index}]`} ${what.replace("{who}", subject(match))} (matched through ${match.how})`,
  };
}

/** `acls` and `grants`: a source that includes a box, with somewhere else to go. */
function reachRules(key: "acls" | "grants", rules: unknown, aliases: Aliases): PolicyExposure[] {
  if (!Array.isArray(rules)) return [];
  const out: PolicyExposure[] = [];
  rules.forEach((raw, index) => {
    const rule = record(raw);
    const src = resolveAll(strings(rule.src), aliases);
    const dst = strings(rule.dst);
    const targets = key === "acls" ? dst.map(aclTarget) : dst;
    /**
     * Box to box is reach too, and not a lesser kind: hermetic's own rules
     * never let one box reach another, and 443 on every box is the Hermes
     * dashboard behind Serve, unauthenticated by design (§5.2) — so a box that
     * may reach a sibling's 443 may drive that sibling's agent.
     */
    if (src.reach !== "no" && solelyHermetic(targets) && targets.includes(TAILSCALE_TAG)) {
      out.push(finding(key, index, src, "lets {who} reach other agent boxes"));
    }
    if (src.reach !== "no" && !solelyHermetic(targets)) {
      // A grant with only `app` hands out capabilities rather than packets.
      const appOnly = key === "grants" && rule.ip === undefined && rule.app !== undefined;
      out.push(
        finding(
          key,
          index,
          src,
          appOnly
            ? "grants {who} application capabilities on nodes other than tag:hermetic"
            : "lets {who} reach nodes other than tag:hermetic",
        ),
      );
    }
    /**
     * `via` names the subnet routers, exit nodes or app connectors the grant's
     * traffic may take, and only tags may appear in it. A box in it is a router
     * for someone else's traffic. hermetic never advertises a route, so this is
     * reach only once a box does — `info`, not `high`.
     */
    if (key === "grants" && strings(rule.via).includes(TAILSCALE_TAG)) {
      out.push({
        rule: key,
        index,
        severity: "info",
        summary: `${key}[${index}] routes the traffic it grants through agent boxes (via ${TAILSCALE_TAG})`,
      });
    }
  });
  return out;
}

function sshRules(rules: unknown, aliases: Aliases): PolicyExposure[] {
  if (!Array.isArray(rules)) return [];
  const out: PolicyExposure[] = [];
  rules.forEach((raw, index) => {
    const src = resolveAll(strings(record(raw).src), aliases);
    if (src.reach !== "no") {
      out.push(finding("ssh", index, src, "lets {who} open Tailscale SSH sessions to other nodes"));
    }
  });
  return out;
}

/**
 * `autoApprovers`: who may advertise a subnet route (`routes`, keyed by CIDR)
 * or an exit node (`exitNode`) and have it approved with no admin in the loop.
 * A box in either list can attract other nodes' traffic on its own say-so.
 */
function autoApproverRules(value: unknown, aliases: Aliases): PolicyExposure[] {
  const approvers = record(value);
  const out: PolicyExposure[] = [];
  Object.values(record(approvers.routes)).forEach((who, index) => {
    const match = resolveAll(strings(who), aliases);
    if (match.reach !== "no") {
      out.push(
        finding(
          "autoApprovers.routes",
          index,
          match,
          "auto-approves subnet routes advertised by {who}",
        ),
      );
    }
  });
  const exit = resolveAll(strings(approvers.exitNode), aliases);
  if (exit.reach !== "no") {
    out.push(finding("autoApprovers.exitNode", null, exit, "auto-approves {who} as exit nodes"));
  }
  return out;
}

/** `nodeAttrs` granting `funnel`: a box may publish a port to the public internet. */
function funnelRules(rules: unknown, aliases: Aliases): PolicyExposure[] {
  if (!Array.isArray(rules)) return [];
  const out: PolicyExposure[] = [];
  rules.forEach((raw, index) => {
    const rule = record(raw);
    if (!strings(rule.attr).includes("funnel")) return;
    const match = resolveAll(strings(rule.target), aliases);
    if (match.reach !== "no") {
      out.push({
        ...finding(
          "nodeAttrs",
          index,
          match,
          "allows Funnel on {who}, so they can publish to the public internet",
        ),
        severity: "info",
      });
    }
  });
  return out;
}

/**
 * Every rule in `policy` (the value `parseHujson` returns) that lets a
 * `tag:hermetic` box reach beyond what hermetic needs, in document order of
 * key. Returns `[]` for a clean policy.
 */
export function policyExposure(policy: unknown): PolicyExposure[] {
  const doc = record(policy);
  const aliases: Aliases = {
    groups: record(doc.groups),
    hosts: record(doc.hosts),
    ipsets: record(doc.ipsets),
  };
  const out: PolicyExposure[] = [];
  /**
   * Tailscale's default policy is allow-all, and a policy with neither key
   * means the same thing: every node, boxes included, may reach every other.
   * An *empty* `acls` array is the opposite — nothing is allowed — so only
   * absence counts.
   */
  if (doc.acls === undefined && doc.grants === undefined) {
    out.push({
      rule: "acls",
      index: null,
      severity: "high",
      summary:
        "the policy has neither acls nor grants, which Tailscale reads as allow-all: agent boxes can reach every node",
    });
  }
  out.push(
    ...reachRules("acls", doc.acls, aliases),
    ...reachRules("grants", doc.grants, aliases),
    ...sshRules(doc.ssh, aliases),
    ...autoApproverRules(doc.autoApprovers, aliases),
    ...funnelRules(doc.nodeAttrs, aliases),
  );
  return out;
}

/**
 * The same, from the policy's text. Null when the text does not parse or is not
 * an object: an unreadable policy is not a clean one.
 */
export function policyExposureOf(text: string): PolicyExposure[] | null {
  let parsed: unknown;
  try {
    parsed = parseHujson(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return policyExposure(parsed);
}
