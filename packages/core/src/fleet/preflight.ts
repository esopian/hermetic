/**
 * The §4.7 Tailscale preflight: the two checks `init` makes before it creates a
 * foundation, neither of which touches AWS.
 *
 * 1. **This machine is on a tailnet that can host the fleet.** Tailscale is the
 *    only way in and it is required (§1); a foundation created from a laptop
 *    that is not on a tailnet is a fleet its own operator cannot reach. The
 *    detected MagicDNS suffix is also what gets stamped on `_fleet` and rendered
 *    into every Serve URL (§6.4), so detecting it removes the one free-text
 *    field in the wizard that nothing validated and whose typo only surfaced
 *    minutes later, on a booted box. The same JSON says whether the tailnet
 *    issues HTTPS certificates, which every agent needs: `hermeticd apply` ends
 *    in `tailscale serve --https=443`, and on a tailnet with certificates off
 *    that fails on the box roughly twenty minutes into provisioning. The laptop
 *    can see it before anything is created, so it does.
 *
 * 2. **The OAuth client works.** Proved by using it: token → mint a `tag:hermetic`
 *    key → revoke it → list the tailnet's devices → read and validate the tailnet
 *    policy. The mint proves `auth_keys` write, which is what agent creation
 *    needs; the list proves `devices:core` read, which is what `doctor`'s device
 *    drift and the stale-device cleanup at recreate/destroy need; the policy
 *    read and validate prove `policy_file:read` and `policy_file`, which are
 *    what lets hermetic keep its own three entries in the tailnet policy up to
 *    date instead of asking for them to be pasted (§4.7, `policy.ts`). Only the
 *    first is fatal — see `TailscaleOauthCheck`.
 *
 * This lives in core rather than in the CLI (where §3.2 lists the shelling-out)
 * because of the parity contract: everything the CLI can do, the UI can do, and
 * the UI reaches a local binary only through core.
 *
 * Nothing here logs, prints, or returns a secret (§8.3): the OAuth secret is an
 * argument and never a field of a result, and no HTTP response body — which can
 * echo the request — is ever folded into `problem`.
 */
import { NO_TAILSCALE, type TailscaleOauthCheck, type TailscalePreflight } from "../schema/index.ts";
import {
  POLICY_CONTENT_TYPE,
  TAILSCALE_API,
  TAILSCALE_TAG,
  keyDescription,
  tailscaleErrorMessage,
  type FetchLike,
} from "../aws/tailscale.ts";
import { NO_POLICY_SCOPE_NOTE, READ_ONLY_POLICY_NOTE } from "./policy.ts";
import { probePolicyScope, type PolicyScopeResult } from "./policy-scope.ts";

/**
 * Where a `tailscale` binary might be. `tailscale` alone covers anything on
 * `PATH`; the rest are the installs that deliberately are not — Homebrew on
 * Apple silicon, and the macOS App Store build, whose CLI only exists inside the
 * app bundle.
 */
export const TAILSCALE_BINARIES: readonly string[] = [
  "tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/**
 * The console and download URLs the heads link to. They live in `shared/`
 * (the browser links to them too) and are re-exported here so core's own
 * callers keep one import.
 */
export {
  TAILSCALE_ADMIN_ACL_URL,
  TAILSCALE_ADMIN_DNS_URL,
  TAILSCALE_ADMIN_OAUTH_URL,
  TAILSCALE_DOWNLOAD_URL,
} from "../shared/tailscale-urls.ts";
import { TAILSCALE_ADMIN_DNS_URL } from "../shared/tailscale-urls.ts";

/** The probe key is short-lived and revoked immediately; five minutes is slack. */
export const PROBE_KEY_TTL_SECONDS = 300;

/**
 * A wedged `tailscaled` makes `tailscale status` block rather than fail, and
 * `init` must not inherit that: an unanswerable daemon is the same finding as a
 * stopped one, and it arrives in three seconds instead of never.
 */
export const PROBE_TIMEOUT_MS = 3000;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Injected in tests; production spawns the binary. */
export type ExecLike = (argv: readonly string[]) => Promise<ExecResult>;

export interface ProbeOptions {
  exec?: ExecLike;
  binaries?: readonly string[];
}

async function spawnCapture(argv: readonly string[]): Promise<ExecResult> {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The MagicDNS suffix, which is the "tailnet" every hostname is built from —
 * *not* `CurrentTailnet.Name`, which is the organisation (`acme.com`, or a
 * `tail1a2b3c` handle) and does not appear in a Serve URL.
 *
 * The top-level field is authoritative; `CurrentTailnet` and `Self.DNSName`
 * are fallbacks for older daemons, which reported one or the other.
 */
function suffixOf(status: Record<string, unknown>): string | null {
  const top = status["MagicDNSSuffix"];
  if (typeof top === "string" && top.length > 0) return top.replace(/\.$/, "");

  const current = status["CurrentTailnet"];
  if (current !== null && typeof current === "object") {
    const nested = (current as Record<string, unknown>)["MagicDNSSuffix"];
    if (typeof nested === "string" && nested.length > 0) return nested.replace(/\.$/, "");
  }

  // `host.acme.ts.net.` → `acme.ts.net`: drop this node's own label.
  const self = status["Self"];
  if (self !== null && typeof self === "object") {
    const dns = (self as Record<string, unknown>)["DNSName"];
    if (typeof dns === "string" && dns.includes(".")) {
      const rest = dns.replace(/\.$/, "").split(".").slice(1).join(".");
      if (rest.length > 0) return rest;
    }
  }
  return null;
}

/** The first non-empty line, capped — a CLI error message, never a secret. */
function firstLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line === undefined ? null : line.slice(0, 200);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * `tailscale status --json` → the preflight. Exported for its own tests: the
 * shapes that matter (logged out, daemon down, a tailnet with a custom domain)
 * are all just different JSON, and none of them need a daemon to exercise.
 */
export function parseTailscaleStatus(raw: string, binary: string): TailscalePreflight {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object") {
    /**
     * The macOS App Store shim exits *zero* and prints a plain-text error when
     * the app itself is not running ("The Tailscale CLI failed to start: …"),
     * so its own message is the useful one — "did not return JSON" would send
     * the operator looking in the wrong place.
     */
    return {
      ...NO_TAILSCALE,
      installed: true,
      binary,
      problem: firstLine(raw) ?? "`tailscale status --json` did not return JSON",
    };
  }
  const status = parsed as Record<string, unknown>;

  const backendState = typeof status["BackendState"] === "string" ? status["BackendState"] : null;
  const running = backendState === "Running";
  const tailnet = suffixOf(status);
  const self = (status["Self"] ?? null) as Record<string, unknown> | null;
  const hostname = typeof self?.["HostName"] === "string" ? (self["HostName"] as string) : null;
  const addresses = stringsOf(status["TailscaleIPs"] ?? self?.["TailscaleIPs"]);
  /**
   * `CertDomains` is the daemon's answer to "can this tailnet get a TLS cert":
   * a list of names when HTTPS Certificates is on, and `null` when it is off.
   * It is reported to every node, so this laptop's copy is the fleet's answer.
   */
  const certDomains = stringsOf(status["CertDomains"]);

  const problem = !running
    ? backendState === "NeedsLogin"
      ? "tailscale is installed but not logged in; run `tailscale up`"
      : backendState === "Stopped"
        ? "tailscale is installed but stopped; run `tailscale up`"
        : `tailscale is not running (backend state ${backendState ?? "unknown"})`
    : tailnet === null
      ? "tailscale is running but reported no MagicDNS suffix; enable MagicDNS for this tailnet"
      : /**
         * Last, because MagicDNS is the more fundamental of the two and a
         * tailnet missing it is usually missing certificates as well — naming
         * the deeper problem first sends the operator to the toggle that has
         * to be flipped anyway.
         */
        certDomains.length === 0
        ? `tailscale is running but this tailnet has HTTPS certificates disabled; every agent publishes its dashboard with \`tailscale serve --https\`, which cannot get a certificate without them — enable HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}`
        : null;

  return {
    ok: problem === null,
    installed: true,
    running,
    backend_state: backendState,
    tailnet,
    cert_domains: certDomains,
    hostname,
    addresses,
    binary,
    problem,
  };
}

/**
 * Ask this machine's Tailscale daemon where it is. Never throws: "we could not
 * find out" is an answer the wizard renders, not a failure that ends `init`
 * before the operator has been told why.
 */
export async function probeLocalTailscale(opts: ProbeOptions = {}): Promise<TailscalePreflight> {
  const exec = opts.exec ?? spawnCapture;
  const binaries = opts.binaries ?? TAILSCALE_BINARIES;

  let lastFailure: TailscalePreflight | null = null;
  for (const binary of binaries) {
    let result: ExecResult;
    try {
      result = await exec([binary, "status", "--json"]);
    } catch {
      // ENOENT for this candidate: try the next install location.
      continue;
    }
    if (result.code !== 0) {
      /**
       * A non-zero exit still means the binary is *there*, which is a different
       * message from "not installed" — but a later candidate may be a working
       * install, so keep looking and only report this if nothing else answers.
       */
      lastFailure = {
        ...NO_TAILSCALE,
        installed: true,
        binary,
        problem:
          result.stderr.trim().split("\n")[0] ?? `\`${binary} status --json\` exited ${result.code}`,
      };
      continue;
    }
    const status = parseTailscaleStatus(result.stdout, binary);
    /**
     * Unparseable output means this install did not answer — the shim case
     * above — so keep looking: another location may be a working install. A
     * daemon that answered and merely said "logged out" is a real answer and
     * stops the search.
     */
    if (status.backend_state === null && !status.running) {
      lastFailure = status;
      continue;
    }
    return status;
  }
  return lastFailure ?? { ...NO_TAILSCALE };
}

interface VerifyOptions {
  fetch?: FetchLike;
  /**
   * `-` is the tailnet the credentials themselves belong to. An OAuth client is
   * bound to exactly one tailnet, so this is unambiguous — and it avoids
   * guessing the API's name for a tailnet from a MagicDNS suffix, which differ
   * for tailnets on a custom domain.
   */
  tailnet?: string;
  tag?: string;
}

function failed(problem: string, partial: Partial<TailscaleOauthCheck> = {}): TailscaleOauthCheck {
  return {
    ok: false,
    authenticated: false,
    can_mint: false,
    can_list_devices: false,
    policy_scope: "none",
    revoked: false,
    problem,
    ...partial,
  };
}

/**
 * The note a mint-capable client with no `devices:core` gets. It is prose rather
 * than a code because it is the whole of what a head has to say: what is
 * missing, what stops working without it, and the one command that fixes it.
 */
export const NO_DEVICES_SCOPE_NOTE =
  "the client can mint keys but lacks devices:core read/write: stale devices will not be cleaned and doctor cannot check drift; create a client with every scope and run hermetic secrets push _fleet --tailscale-oauth";

/**
 * The read half of `devices:core`, asked the same way as everything else here —
 * by doing it. A listing that comes back is proof of the scope; a 403 is proof
 * of its absence; an unreachable API is indistinguishable from either, so it
 * reads as "no" and produces the same non-fatal note rather than a false green.
 */
async function canListDevices(http: FetchLike, token: string, tailnet: string): Promise<boolean> {
  try {
    const res = await http(`${TAILSCALE_API}/api/v2/tailnet/${tailnet}/devices`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The third scope, asked the same way (§4.7) and through the same helper
 * `policy.status` uses (`policy-scope.ts`), so the wizard's verdict and the
 * fleet's cannot disagree about one tailnet. `GET /acl` answering proves
 * `policy_file:read`; a 200 from sending that same policy — unchanged, so
 * nothing can come of it — to `POST /acl/validate` proves the write scope,
 * because the validate endpoint sits behind `policy_file` and stores nothing.
 *
 * The unchanged policy is deliberate: it is the only candidate document that is
 * guaranteed to be *valid*, so a 400 here says something about the policy the
 * tailnet already has rather than about the scope — which is why it is reported
 * as unproven rather than as proof either way. No response body is read: the
 * status is the whole finding, and Tailscale's error bodies can echo the
 * request that produced them (§8.3).
 */
async function policyScope(
  http: FetchLike,
  token: string,
  tailnet: string,
): Promise<PolicyScopeResult> {
  const url = `${TAILSCALE_API}/api/v2/tailnet/${tailnet}/acl`;
  return probePolicyScope({
    read: async () => {
      try {
        const res = await http(url, { headers: { authorization: `Bearer ${token}` } });
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    },
    validate: async (policy) => {
      const res = await http(`${url}/validate`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": POLICY_CONTENT_TYPE },
        body: policy,
      });
      if (res.ok) return { ok: true };
      return { ok: false, forbidden: res.status === 403, message: `HTTP ${res.status}` };
    },
  });
}

/**
 * The notes a mint-capable client with a missing second scope carries. A scope
 * that could not be *proved* says which answer stopped it being proved, rather
 * than the flat "read only" note — the operator's next move is different when
 * the reason is their own policy's failing tests.
 */
function scopeNotes(canListDevices: boolean, policy: PolicyScopeResult): string | null {
  const notes = [
    ...(canListDevices ? [] : [NO_DEVICES_SCOPE_NOTE]),
    ...(policy.scope === "none"
      ? [NO_POLICY_SCOPE_NOTE]
      : policy.scope === "read"
        ? [policy.reason ?? READ_ONLY_POLICY_NOTE]
        : []),
  ];
  return notes.length === 0 ? null : notes.join("; ");
}

/**
 * Prove the OAuth client can mint what agents boot with, by minting one and
 * revoking it, and can read the devices those keys create (§4.7 step 4). Like
 * the local probe it never throws — a network error is a finding, not a crash —
 * and like everything else that touches this secret it puts no response body in
 * the result, because Tailscale's error bodies can echo the request that
 * produced them (§8.3).
 */
export async function verifyTailscaleOauthClient(
  secret: string,
  opts: VerifyOptions = {},
): Promise<TailscaleOauthCheck> {
  const http: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const tailnet = opts.tailnet ?? "-";
  const tag = opts.tag ?? TAILSCALE_TAG;

  const clientId = /^tskey-client-([A-Za-z0-9]+)-/.exec(secret)?.[1];
  if (!clientId) {
    return failed("that does not look like a Tailscale OAuth client secret (tskey-client-…)");
  }

  let token: string;
  try {
    const res = await http(`${TAILSCALE_API}/api/v2/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: secret,
      }).toString(),
    });
    if (!res.ok) {
      return failed(`Tailscale rejected these client credentials (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) return failed("Tailscale returned no access token");
    token = json.access_token;
  } catch {
    return failed("could not reach api.tailscale.com");
  }

  let keyId: string;
  try {
    const res = await http(`${TAILSCALE_API}/api/v2/tailnet/${tailnet}/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: { reusable: false, ephemeral: true, preauthorized: true, tags: [tag] },
          },
        },
        expirySeconds: PROBE_KEY_TTL_SECONDS,
        description: keyDescription("hermetic preflight, revoked immediately"),
      }),
    });
    if (!res.ok) {
      /**
       * Tailscale's own message is the most useful thing here and is safe to
       * show: the mint request carries no secret. Two failures still deserve a
       * hint on top. A 403 means the client lacks the `auth_keys` write scope
       * (§4.7: the fleet's client carries that and `devices:core`, both tagged).
       * A 400 mentioning tags means the policy has no `tagOwners` entry for
       * the tag, or the client was created without it — the heads have the
       * operator apply the policy first, so the client is the likelier
       * culprit by the time anyone reads this.
       */
      const message = await tailscaleErrorMessage(res, [secret, token]);
      const hint =
        res.status === 403
          ? `recreate the OAuth client with the auth_keys write and devices:core read/write scopes, both tagged ${tag}, plus policy_file`
          : /tag/i.test(message ?? "")
            ? `check the OAuth client was created with tag ${tag} and your tailnet policy has a tagOwners entry for it`
            : null;
      return failed(
        `Tailscale refused to mint a ${tag} key (HTTP ${res.status}${message ? `: ${message}` : ""})${hint ? ` — ${hint}` : ""}`,
        { authenticated: true },
      );
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      // Minted but unidentifiable, so unrevokable. It expires on its own.
      const listed = await canListDevices(http, token, tailnet);
      const policy = await policyScope(http, token, tailnet);
      return {
        ok: true,
        authenticated: true,
        can_mint: true,
        can_list_devices: listed,
        policy_scope: policy.scope,
        revoked: false,
        problem: scopeNotes(listed, policy),
      };
    }
    keyId = json.id;
  } catch {
    return failed("could not reach api.tailscale.com to mint a probe key", { authenticated: true });
  }

  let revoked = false;
  try {
    const res = await http(`${TAILSCALE_API}/api/v2/tailnet/${tailnet}/keys/${keyId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    revoked = res.ok;
  } catch {
    revoked = false;
  }

  /**
   * Last, and after the probe key is gone: the second scope is the one a fleet
   * can live without, so nothing about asking for it may leave a key behind.
   */
  const listed = await canListDevices(http, token, tailnet);
  const policy = await policyScope(http, token, tailnet);

  return {
    ok: true,
    authenticated: true,
    can_mint: true,
    can_list_devices: listed,
    policy_scope: policy.scope,
    revoked,
    problem: scopeNotes(listed, policy),
  };
}
