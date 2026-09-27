/**
 * The typed door to the app: which fleet this window is on, the init wizard's
 * reads, and the error vocabulary every caller renders. The requests themselves
 * go through the transport seam (`transport.ts`), so nothing in this file names
 * a request's carriage — only its name and its parameters.
 *
 * Nothing here imports `@hermetic/core` (§3.1) — the shapes are read back off
 * the bridge contract (`types.ts`).
 */
import { invalidateFetchCache } from "../lib/fetch-cache.ts";
import { transport } from "./transport.ts";
import type { Accepted, Meta } from "./types.ts";

export function isInitialized(meta: Meta | null): boolean {
  return meta === null ? true : meta.initialized !== false;
}

/* ── init (§4.7) ─────────────────────────────────────────────────────────── */

export type CredentialType = "static" | "sso" | "assume_role" | "process" | "unknown";

export type ProfileSource = "config" | "credentials" | "both";

/**
 * One row of the profile picker (core `AwsProfileInfo`). `credentialType` is
 * tolerated as an alias so an older server shape still renders.
 */
export interface InitProfile {
  name: string;
  region: string | null;
  credential_type?: CredentialType;
  credentialType?: CredentialType;
  source?: ProfileSource;
}

export function credentialTypeOf(p: InitProfile): CredentialType {
  return p.credential_type ?? p.credentialType ?? "unknown";
}

/** Where the profile was read from, spelled as the file the operator knows. */
export function sourceLabel(p: InitProfile): string {
  if (p.source === "credentials") return "~/.aws/credentials";
  if (p.source === "both") return "~/.aws/config + credentials";
  if (p.source === "config") return "~/.aws/config";
  return "";
}

export interface InitIdentity {
  account_id: string;
  arn: string;
  alias: string | null;
  org_id: string | null;
  /** Core echoes both back; the wizard uses them to pin the region it showed. */
  region?: string;
  profile?: string;
}

export interface InitFoundation {
  found: boolean | null;
  fleet_id: string | null;
  region: string | null;
  tailnet: string | null;
  stack_status: string | null;
}

/** Core `TailscalePreflight`: what this laptop's Tailscale daemon reports (§4.7). */
export interface InitTailscale {
  ok: boolean;
  installed: boolean;
  running: boolean;
  backend_state: string | null;
  tailnet: string | null;
  /** `CertDomains`: empty exactly when this tailnet has HTTPS certificates off. */
  cert_domains: string[];
  hostname: string | null;
  addresses: string[];
  binary: string | null;
  problem: string | null;
}

/**
 * Core `TailscaleOauthCheck`: the mint-and-revoke proof for the pasted secret,
 * plus the device-list read that proves the client's second scope. Only the
 * mint decides `ok` — a client without `devices:core` is usable, and every
 * fleet initialised before hermetic asked for that scope has one — so
 * `can_list_devices: false` is rendered as a note, never as a failure.
 */
export interface InitOauthCheck {
  ok: boolean;
  authenticated: boolean;
  can_mint: boolean;
  can_list_devices: boolean;
  revoked: boolean;
  /**
   * What the pasted client may do with the tailnet policy file (§4.7). `write`
   * lets `init` keep hermetic's blocks current by itself; `read` and `none` are
   * notes, never failures — a client without the Policy File scope still runs a
   * fleet, the operator just pastes the entries by hand.
   */
  policy_scope: "write" | "read" | "none";
  problem: string | null;
}

export interface InitInputBody {
  profile: string;
  region: string;
  account_id_typed: string;
  mode: "attach" | "create";
  tailnet?: string;
  tailscale_oauth_secret?: string;
  network?: "public" | "nat";
  /**
   * Leave the tailnet policy file alone (`init --skip-policy`). Off by default:
   * a client with Policy File write writes hermetic's `ssh`/`acls` blocks during
   * `init`, and this is the escape hatch for a policy that lives in git.
   */
  skip_policy?: boolean;
}

/* ── error handling ──────────────────────────────────────────────────────── */

/**
 * The refusal vocabulary, defined in `errors.ts` because both sides of the
 * transport seam need it, and published from here because this is the door the
 * rest of the UI already imports.
 */
export { ApiError, isError, apiErrorOf } from "./errors.ts";
export type { ErrorBody } from "./errors.ts";

/* ── reads ───────────────────────────────────────────────────────────────── */

export function getMeta(): Promise<Meta> {
  return transport().request<Meta>("meta.get");
}

/* ── which fleet this tab means (§4.7) ───────────────────────────────────── */

/**
 * The immutable identity of the fleet this window is showing: account, region and
 * `fleet_id`. Mirrored here rather than imported, like every other shape in
 * this file — the UI may not import core (§3.1).
 */
export interface FleetTarget {
  account_id: string;
  region: string;
  fleet_id: string;
}

/**
 * Fleet selection lives in the *head*, globally: `fleets.switch` repoints the
 * whole app, and every window with it. A window that has been open since before
 * a switch would otherwise send `agents.destroy` for `atlas` believing it means
 * the `atlas` on screen, and delete one in another account.
 *
 * So every mutation this file sends names the fleet it means. This is that
 * name, recorded from the last `meta.get` the window read — the same document
 * the dashboard is rendering, so what the request claims and what the operator
 * is looking at cannot disagree. A stale window now gets `FLEET_MISMATCH` and
 * an error toast instead of acting on the wrong fleet.
 */
let currentTarget: FleetTarget | null = null;

/**
 * Records which fleet this window is on.
 *
 * Called where a `Meta` is *adopted* — `FleetProvider`'s `refreshMeta` and
 * `switchTo`, the two places the page decides "this is the fleet I am now
 * rendering" — and deliberately not inside `getMeta`. A read and an adoption
 * are not the same event: `refreshMeta` discards a reply that lost a race
 * against a newer request (`request !== metaRequest.current`), and a fetch-time
 * side effect would have pointed this window's mutations at a fleet the page then
 * refused to display. The invariant worth having is that `target` names what
 * the operator is looking at, so it moves only when the screen does.
 */
export function setFleetTarget(target: FleetTarget | null): void {
  // Every cached read below is fleet-scoped, so pointing this window at another
  // fleet makes all of them stale at once: an inventory answered from the
  // cache after a switch would be the departing fleet's.
  if (
    currentTarget?.fleet_id !== target?.fleet_id ||
    currentTarget?.account_id !== target?.account_id ||
    currentTarget?.region !== target?.region
  )
    invalidateFetchCache();
  currentTarget = target;
}

/**
 * The fleet a `meta.get` body is about, or null before `init` — `config` is
 * null there, and there is nothing to name.
 *
 * All three fields from one document. It used to take the account and the
 * region from `meta.config` and the `fleet_id` from `meta.fleet`, which is a
 * triple no single document ever asserted: if those two halves of a `meta.get`
 * body disagreed, the result named a fleet id in another fleet's account, and
 * every mutation this window sent would have claimed it.
 *
 * `meta.get` builds `fleet.id` and `config` from the same installed instance,
 * so the two agree by construction — which is exactly why a disagreement is
 * worth refusing rather than splicing. A body that contradicts itself names no
 * fleet this tab can act on, and naming none is how `target()` comes to say
 * "reload the page" instead of guessing.
 */
export function targetOf(meta: Meta): FleetTarget | null {
  const config = meta.config;
  if (!config) return null;
  const served = meta.fleet?.id ?? null;
  if (served !== null && served !== config.fleet_id) return null;
  return { account_id: config.account_id, region: config.region, fleet_id: config.fleet_id };
}

/**
 * The `fleet_id` a `meta.get` body is about — the one reader, used by
 * everything that needs one.
 *
 * One reader rather than three: this was written out by hand in three places
 * and one of them read only `config.fleet_id`, so the agent drawer keyed its
 * destroy plan on one fleet while every mutation it sent named another — the
 * exact mismatch that key exists to catch (§4.8).
 *
 * `fleet.id` is tried first because it is what *this head* says it is
 * serving. Within one `meta.get` body the two cannot disagree — `metaGet`
 * builds both from the same installed instance, and `targetOf` refuses a body
 * where they somehow do — so the fallback is for a body that carries `config`
 * and no `fleet` block at all, not for a contradiction. Identity is `fleet_id`
 * and nothing else (§4.6): the alias is display only.
 */
export function fleetIdOf(meta: Meta | null | undefined): string | null {
  return meta?.fleet?.id ?? meta?.config?.fleet_id ?? null;
}

/** The current fleet, for tests and for callers that need to read it back. */
export function fleetTarget(): FleetTarget | null {
  return currentTarget;
}

/**
 * Whether two targets name the same fleet: core's own `sameFleetTarget`
 * (`@hermetic/core/shared`), all three fields, a null on either side never a
 * match. `fleet_id` alone is not it, because the same eight characters can be
 * minted in two accounts.
 */
export { sameFleetTarget } from "@hermetic/core/shared";

/**
 * The `target` a mutation sends. It throws rather than omitting the field when
 * the window does not know which fleet it is on: an unsent target is a request
 * the head would refuse anyway, and failing here says so before the round trip —
 * and before any chance of it being read as "whichever fleet you like".
 */
export function target(): FleetTarget {
  if (currentTarget === null) {
    throw new Error("this window does not know which fleet it is showing; reload the page");
  }
  return currentTarget;
}

/* ── init endpoints ──────────────────────────────────────────────────────── */

export async function initProfiles(): Promise<InitProfile[]> {
  const body = await transport().request<{ profiles: InitProfile[] }>("init.profiles");
  return body.profiles;
}

export function initIdentity(
  profile: string,
  region?: string,
): Promise<{ identity: InitIdentity; foundation: InitFoundation }> {
  return transport().request("init.identity", region === undefined ? { profile } : { profile, region });
}

/**
 * §4.7 preflight. The wizard shows this instead of asking for a tailnet: the
 * tailnet this machine is on is the one the fleet belongs to, and `init`
 * refuses the create branch on the same reading, so a green panel here is a
 * preview of the gate rather than a substitute for it.
 */
export async function initTailscale(): Promise<InitTailscale> {
  const body = await transport().request<{ tailscale: InitTailscale }>("init.tailscale");
  return body.tailscale;
}

/**
 * Proves the pasted OAuth client by minting a `tag:hermetic` key, revoking it,
 * and listing the tailnet's devices — the two scopes the fleet needs. The secret
 * goes over the same loopback channel `startInit` uses and is never stored; only
 * the verdict comes back.
 */
export async function initVerifyOauth(secret: string): Promise<InitOauthCheck> {
  const body = await transport().request<{ oauth: InitOauthCheck }>("init.tailscale.oauth", {
    secret,
  });
  return body.oauth;
}

/**
 * One entry of the tailnet policy, keyed by where it goes. The wizard shows
 * these as separate copy blocks because the policy file is HuJSON with fixed
 * top-level keys: an operator splices entries in, never pastes a whole object.
 */
export interface AclPart {
  key: "tagOwners" | "ssh" | "acls";
  purpose: string;
  body: string;
}

export interface AclSnippet {
  /** The whole policy as one object, for merging by eye. */
  snippet: string;
  parts: AclPart[];
}

export async function initAcl(): Promise<AclSnippet> {
  const body = await transport().request<AclSnippet>("init.acl");
  return { snippet: body.snippet, parts: body.parts };
}

/**
 * `{ op_id, op }`, followed like any other op. The OAuth secret rides in the
 * request straight to core and is never logged or stored by the UI.
 */
export function startInit(input: InitInputBody): Promise<Accepted> {
  return transport().request<Accepted>("init", { ...input });
}
