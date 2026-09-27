/**
 * Where the heads send an operator for the parts of a Tailscale setup that
 * have no API: the download page, and the admin-console pages `init --create`
 * cannot do for them (§4.7).
 *
 * Constants, not wire fields: a link target is not something a response should
 * get to decide. They live here, under `shared/`, rather than beside the
 * preflight probes because the browser links to them too and must not pull the
 * probe (a spawned binary, a call to api.tailscale.com) into its bundle.
 * `fleet/preflight.ts` re-exports them so core's own callers are unchanged.
 */

/** Where an operator goes when the probe says there is nothing to talk to. */
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
/**
 * The two admin-console pages the create branch sends an operator to, in the
 * order they must be visited: the policy editor first, because the OAuth
 * client form only offers tags that already have a `tagOwners` entry; then
 * the OAuth clients page. There is no API for either, so links are the most
 * hermetic can do (§4.7 step 4).
 */
export const TAILSCALE_ADMIN_ACL_URL = "https://login.tailscale.com/admin/acls/file";
export const TAILSCALE_ADMIN_OAUTH_URL = "https://login.tailscale.com/admin/settings/oauth";
/**
 * The DNS page, which is where "HTTPS Certificates" is turned on. Also a
 * console-only toggle, so also a link — and unlike the two above it belongs to
 * the *pre*-create reading, because a tailnet without certificates cannot serve
 * a single agent's dashboard.
 */
export const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
