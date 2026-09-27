import { z } from "zod";
import { AccountId, FleetIdSchema, Region } from "./common.ts";
import { PolicyScope } from "./policy.ts";

/**
 * The two pre-`init` reads of §4.7. They exist as schemas rather than as ad-hoc
 * interfaces because both heads render them: the CLI as a picker, the UI as a
 * form. Neither resolves an identity at list time — that would trigger an SSO
 * login for every profile.
 */

export const CredentialType = z.enum(["static", "sso", "assume_role", "process", "unknown"]);
export type CredentialType = z.infer<typeof CredentialType>;

/** One row of the profile picker (§4.7 step 1). No identity, no network call. */
export const AwsProfileInfo = z.object({
  name: z.string().min(1),
  region: z.string().nullable(),
  credential_type: CredentialType,
  source: z.enum(["config", "credentials", "both"]),
});
export type AwsProfileInfo = z.infer<typeof AwsProfileInfo>;

/** What `init.resolveIdentity` returns for the one chosen profile (§4.7 step 2). */
export const ResolvedIdentity = z.object({
  account_id: AccountId,
  arn: z.string().min(1),
  /** `iam list-account-aliases`, best effort. */
  alias: z.string().nullable(),
  /** `organizations describe-organization`, best effort; null on member accounts. */
  org_id: z.string().nullable(),
  region: Region,
  profile: z.string().min(1),
});
export type ResolvedIdentity = z.infer<typeof ResolvedIdentity>;

/**
 * What `init.describeFoundation` reports for one candidate profile and region,
 * *before* anything is frozen (§4.7 step 4). It is the read that decides the
 * attach-or-create branch, so the wizard can show the operator which fleet they
 * are about to join before they type twelve digits at it.
 *
 * Every field is nullable because every field is best effort: the stack may not
 * exist, and the `_fleet` item may not be readable by these credentials.
 */
export const FoundationSummary = z.object({
  found: z.boolean(),
  fleet_id: FleetIdSchema.nullable(),
  region: z.string().nullable(),
  tailnet: z.string().nullable(),
  stack_status: z.string().nullable(),
});
export type FoundationSummary = z.infer<typeof FoundationSummary>;

/** What `describeFoundation` returns when there is nothing there. */
export const NO_FOUNDATION: FoundationSummary = {
  found: false,
  fleet_id: null,
  region: null,
  tailnet: null,
  stack_status: null,
};

/**
 * §4.7 preflight: what this laptop's Tailscale daemon says about itself.
 *
 * Tailscale is the only way in and it is required (§1), so a foundation created
 * from a machine that is not on a tailnet is a fleet its own operator cannot
 * reach — SSM break-glass only. `init` reads this before it creates anything,
 * and the detected `tailnet` is what gets stamped on `_fleet`: the tailnet this
 * machine is on is, by assumption, the tailnet the fleet belongs to.
 *
 * Nothing here is a secret. `tailscale status` reports no keys.
 */
export const TailscalePreflight = z.object({
  /** Every check passed: the binary is there, the daemon is up, a tailnet is known. */
  ok: z.boolean(),
  /** False when no `tailscale` binary could be found at all. */
  installed: z.boolean(),
  /** `BackendState === "Running"`. `NeedsLogin`/`Stopped`/`NoState` are all false. */
  running: z.boolean(),
  /** Raw `BackendState`, for display; null when the binary is missing. */
  backend_state: z.string().nullable(),
  /** The MagicDNS suffix, e.g. `acme.ts.net` — every Serve URL is `<name>.<this>`. */
  tailnet: z.string().nullable(),
  /**
   * `CertDomains` from the same read: the names this tailnet can get a TLS
   * certificate for, and empty when HTTPS Certificates is off in the admin
   * console. Empty is a refusal, because every agent ends its apply in
   * `tailscale serve --https=443` and that cannot get a cert without it.
   */
  cert_domains: z.array(z.string()),
  /** This machine's name on the tailnet, for display. */
  hostname: z.string().nullable(),
  /** This machine's tailnet addresses, for display. */
  addresses: z.array(z.string()),
  /** Which binary answered, so an operator can tell which install was probed. */
  binary: z.string().nullable(),
  /** Why it is not usable, when `ok` is false. Never a secret. */
  problem: z.string().nullable(),
});
export type TailscalePreflight = z.infer<typeof TailscalePreflight>;

/** What `probeLocalTailscale` returns when no binary answered. */
export const NO_TAILSCALE: TailscalePreflight = {
  ok: false,
  installed: false,
  running: false,
  backend_state: null,
  tailnet: null,
  cert_domains: [],
  hostname: null,
  addresses: [],
  binary: null,
  problem: "no `tailscale` binary found on this machine",
};

/**
 * §4.7 step 4: whether the OAuth client the operator just pasted can actually
 * do the two jobs the fleet needs it for — minting tagged auth keys, and
 * reading and deleting the tagged devices those keys create.
 *
 * The first is answered by doing it: exchange the secret for a token, mint a key
 * with `tag:hermetic`, then revoke it. That single chain proves four things at
 * once — the secret is valid, it carries `auth_keys` write, the tailnet policy
 * has a `tagOwners` entry for `tag:hermetic` (minting a tagged key fails without
 * one), and the client is bound to a tailnet the API will accept.
 *
 * The second is answered by listing devices, which is the read half of
 * `devices:core`. It is deliberately *not* part of `ok`: fleets initialised
 * before hermetic asked for that scope carry a mint-only client and must keep
 * working, so a client that can mint is usable and a client that cannot list is
 * a note rather than a refusal.
 *
 * The secret is an *input* and never a field: nothing on this object, including
 * `problem`, may echo it (§8.3).
 */
export const TailscaleOauthCheck = z.object({
  /** Can this client do the job that blocks agent creation — mint keys? */
  ok: z.boolean(),
  /** The client credentials were exchanged for an access token. */
  authenticated: z.boolean(),
  /** A `tag:hermetic` auth key was minted — proves the scope and the tagOwners entry. */
  can_mint: z.boolean(),
  /**
   * The tailnet's devices could be listed — proves `devices:core` read, which is
   * what `doctor` needs for device drift and what `recreate`/`destroy` need to
   * delete an agent's stale device. False never flips `ok`; it produces a note.
   */
  can_list_devices: z.boolean(),
  /**
   * What the client may do with the tailnet policy file (§4.7): `write` is the
   * `policy_file` scope, `read` is `policy_file:read`, `none` is neither.
   *
   * Proved the same way as everything else here — by doing it. Fetching the
   * policy proves the read; validating that same policy *unchanged* proves the
   * write, because `/acl/validate` sits behind the write scope and stores
   * nothing. Like `can_list_devices` it never flips `ok`: hermetic managed
   * nothing in the policy file until this build, so every fleet that exists
   * carries a client without the scope, and refusing one would refuse the
   * status quo. What it costs is the three blocks staying yours to paste.
   */
  policy_scope: PolicyScope,
  /**
   * The probe key was revoked again. False means it was minted and left behind;
   * it is single-use with a five-minute expiry, so it is a warning, not a
   * failure, and never flips `ok`.
   */
  revoked: z.boolean(),
  /**
   * Why it failed, when it did — or, when `ok` is true and a second scope is
   * missing, the non-fatal note(s) about it, joined. Never contains the
   * secret.
   */
  problem: z.string().nullable(),
});
export type TailscaleOauthCheck = z.infer<typeof TailscaleOauthCheck>;
