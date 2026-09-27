import type {
  TailscaleApi,
  TailscaleDeleteOutcome,
  TailscaleDevice,
  TailscalePolicy,
  TailscaleWriteOutcome,
} from "../backend/types.ts";
import {
  HERMETIC_PARAM_ROOT,
  tailscaleOauthClientIdPath,
  tailscaleOauthSecretPath,
} from "../backend/constants.ts";
import { HermeticError } from "../errors.ts";
import type { SsmSecrets } from "./ssm.ts";

/**
 * Tailscale is the only way in, and it is required (§1) — but the OAuth client
 * itself must be created by hand in the admin console (§4.7 step 4), so hermetic
 * only ever holds the secret in an SSM slot and mints short-lived auth keys from
 * it. The client carries three scopes: `auth_keys` write and `devices:core`
 * read/write, both tagged `tag:hermetic`, and `policy_file`, which Tailscale
 * will not restrict to a tag and which is what lets hermetic keep its own
 * entries in the tailnet policy current (`policy.ts`).
 *
 * Nothing here returns, yields, or embeds the OAuth secret; the minted key goes
 * straight into the agent's own SSM slot and never appears in an `OpEvent`
 * (§8.3).
 */

/**
 * The foundation version that moved every parameter under the fleet id (§8.2).
 * Named here rather than imported as `FOUNDATION_VERSION`, which is *this
 * build's* number and will move again: what matters is the version at which
 * the account roots stopped being this fleet's.
 */
const FOUNDATION_SCOPED_PARAMS = 3;

export const TAILSCALE_API = "https://api.tailscale.com";
export const TAILSCALE_TAG = "tag:hermetic";
/** Single-use, one hour — a leaked key is dead before it matters (§8.3). */
export const AUTH_KEY_TTL_SECONDS = 3600;

/**
 * The policy content itself — the three entries, the paste-ready snippet and the
 * managed blocks — lives in `policy.ts`, which is also where the API calls below
 * are driven from. It is not imported here: this module is the transport, and
 * `policy.ts` imports `TAILSCALE_TAG` from it.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * What the policy endpoints are told they are being sent. The `/acl` routes
 * document HuJSON as the default representation, so this is the honest label —
 * and Tailscale parses the body either way, which is why a fallback content
 * type would only ever hide a real 400.
 */
export const POLICY_CONTENT_TYPE = "application/hujson";

/**
 * What `validatePolicy` says instead of "403". Kept here, beside the call that
 * produces it, and read in `policy.ts` to tell a read-only client from a policy
 * that is genuinely broken.
 */
export const NO_POLICY_WRITE_SCOPE = "the OAuth client lacks policy_file";

/**
 * Tailscale's `description` field for auth keys accepts letters, digits,
 * spaces, hyphens and underscores — nothing else, verified against the live
 * API (dots, colons, commas, slashes and parentheses all answer `400 keys:
 * description had invalid characters`). Everything we send goes through here
 * so a label can never make a mint fail. Agent names are already within the
 * set (§7.1), so theirs pass unchanged.
 */
export function keyDescription(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 _-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

/**
 * The `message` Tailscale puts in a failed response's body, if any, with every
 * string in `redact` blanked. The key endpoints carry the bearer token in a
 * header and no secret in the body, so their messages are safe to show once
 * redacted; the token exchange is never surfaced, because its request body
 * *is* the secret (§8.3).
 */
export async function tailscaleErrorMessage(
  res: Response,
  redact: readonly string[],
): Promise<string | null> {
  try {
    const json = (await res.json()) as { message?: unknown };
    if (typeof json.message !== "string" || json.message.length === 0) return null;
    return redact.reduce(
      (text, value) => (value.length > 0 ? text.replaceAll(value, "<redacted>") : text),
      json.message,
    );
  } catch {
    return null;
  }
}

export interface TailscaleClientOptions {
  /** Injected in tests; production uses the global `fetch`. */
  fetch?: FetchLike;
  tailnet?: string;
  tag?: string;
  /**
   * The fleet whose OAuth slots to read (§8.2). A function, not a value: `init`
   * binds the fleet after the backend is built, and the client is constructed
   * before that. Absent — only in tests that stub `fetch` and never reach SSM
   * — the account-root paths of a pre-v3 fleet are used.
   */
  fleetId?: () => string | undefined;
  /**
   * This fleet's `foundation_version`, which is the *only* thing that licenses
   * reading the pre-v3 account-root slot. `null` for a fleet with no version
   * recorded (every fleet older than the stamp) and for one that cannot be
   * read, both of which are legacy. Never throws.
   */
  foundationVersion?: () => Promise<number | null>;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * OAuth client secrets are `tskey-client-<id>-<rest>`; the id is in the string,
 * which is why `init` never asks for it separately.
 */
export function clientIdFromSecret(secret: string): string | null {
  const m = /^tskey-client-([A-Za-z0-9]+)(?:-|$)/.exec(secret);
  return m?.[1] ?? null;
}

export class TailscaleClient implements TailscaleApi {
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly secrets: SsmSecrets,
    private readonly opts: TailscaleClientOptions = {},
  ) {}

  private get http(): FetchLike {
    return this.opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The pre-v3 account-root pair, which is where a fleet that has not taken v3 keeps them. */
  private static readonly LEGACY_SLOTS = {
    secret: `${HERMETIC_PARAM_ROOT}tailscale/oauth-secret`,
    clientId: `${HERMETIC_PARAM_ROOT}tailscale/oauth-client-id`,
  };

  /**
   * The two slots this fleet's OAuth client lives in, and the one case in which
   * the pre-v3 account-root pair may be read instead.
   *
   * A fleet whose home has taken this build but whose `foundation update` has
   * not run yet keeps its client on the roots and has nothing under its fleet
   * id — and every `agent create` mints from it, so reading only the scoped
   * path would break the fleet for the window between the upgrade and the
   * update. That window is what the fallback is for, and `foundation_version <
   * 3` is what proves a fleet is in it.
   *
   * A **v3+ fleet does not get the fallback**, even when its scoped slot is
   * empty. On such a fleet the root path is not "our client, not moved yet" —
   * it is whatever is left in an account-global namespace that other fleets
   * also wrote to, and minting from it would use another fleet's OAuth client
   * (and put this fleet's nodes in that client's audit trail). An empty scoped
   * slot on a migrated fleet is a missing secret, and it is reported as one.
   */
  private async slots(): Promise<{ secret: string; clientId: string; legacy: boolean }> {
    const id = this.opts.fleetId?.();
    if (id === undefined) return { ...TailscaleClient.LEGACY_SLOTS, legacy: true };
    const scoped = {
      secret: tailscaleOauthSecretPath(id),
      clientId: tailscaleOauthClientIdPath(id),
    };
    if (await this.secrets.exists(scoped.secret)) return { ...scoped, legacy: false };
    if (!(await this.preV3())) return { ...scoped, legacy: false };
    if (await this.secrets.exists(TailscaleClient.LEGACY_SLOTS.secret)) {
      return { ...TailscaleClient.LEGACY_SLOTS, legacy: true };
    }
    return { ...scoped, legacy: false };
  }

  /**
   * Whether this fleet predates the fleet-scoped namespace. An unreadable or
   * absent `_fleet` answers *yes*: a fleet whose item cannot be read is one
   * `init --attach` has not finished with, which is the legacy shape, and the
   * fallback only ever *widens* what is searched for a secret this fleet is
   * entitled to.
   */
  private async preV3(): Promise<boolean> {
    if (!this.opts.foundationVersion) return true;
    try {
      const version = await this.opts.foundationVersion();
      return version === null || version < FOUNDATION_SCOPED_PARAMS;
    } catch {
      return true;
    }
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 30_000) return this.token.value;
    const slots = await this.slots();

    /**
     * The slot may exist and still be empty: `init` creates it, and the operator
     * pushes the value separately (§8.2). A placeholder must read as "not pushed
     * yet", not as a credential Tailscale will reject with an opaque 401.
     */
    if (await this.secrets.isPlaceholder(slots.secret)) {
      throw new HermeticError(
        "NOT_FOUND",
        `the tailscale OAuth slot ${slots.secret} is still a placeholder; create the client in the admin console scoped to auth_keys write and devices:core read/write (both with ${this.opts.tag ?? TAILSCALE_TAG}) plus policy_file, then push it`,
        { path: slots.secret, placeholder: true },
      );
    }
    const secret = await this.secrets.reveal(slots.secret);
    if (!secret) {
      /**
       * Neither path holds one. The two ways out are different commands, and
       * which one applies depends on something this class cannot see, so both
       * are named: a fleet that has an OAuth client on the pre-v3 root needs
       * `foundation update` to copy it under the fleet id, and a fleet that has
       * never had one needs the push.
       */
      throw new HermeticError(
        "NOT_FOUND",
        `no tailscale OAuth client secret in ${slots.secret}; if this fleet predates foundation v3 run \`hermetic foundation update\` to move it under the fleet id, otherwise create a client in the admin console scoped to auth_keys write and devices:core read/write (both with ${this.opts.tag ?? TAILSCALE_TAG}) plus policy_file and \`hermetic secrets push _fleet --tailscale-oauth\` it`,
        { path: slots.secret },
      );
    }
    const clientId = (await this.secrets.reveal(slots.clientId)) ?? clientIdFromSecret(secret);
    if (!clientId) {
      throw new HermeticError(
        "UNSUPPORTED",
        `could not determine the tailscale OAuth client id; push it to ${slots.clientId}`,
        { path: slots.clientId },
      );
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    });
    const res = await this.http(`${TAILSCALE_API}/api/v2/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      // The response body can echo the request; never include it.
      throw new HermeticError(
        "INTERNAL",
        `tailscale rejected the OAuth client credentials (HTTP ${res.status})`,
        { status: res.status },
      );
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new HermeticError("INTERNAL", "tailscale returned no access token", {});
    }
    this.token = {
      value: json.access_token,
      expiresAtMs: now + (json.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  /** §6.2 step 3: tagged, single-use, one-hour, pre-authorised, `--ssh` capable. */
  async mintAuthKey(name: string): Promise<string> {
    const token = await this.accessToken();
    const tailnet = this.opts.tailnet ?? "-";
    const res = await this.http(`${TAILSCALE_API}/api/v2/tailnet/${tailnet}/keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: false,
              preauthorized: true,
              tags: [this.opts.tag ?? TAILSCALE_TAG],
            },
          },
        },
        expirySeconds: AUTH_KEY_TTL_SECONDS,
        description: keyDescription(`hermetic agent ${name}`),
      }),
    });
    if (!res.ok) {
      const message = await tailscaleErrorMessage(res, [token]);
      throw new HermeticError(
        "INTERNAL",
        `tailscale refused to mint an auth key for ${name} (HTTP ${res.status}${message ? `: ${message}` : ""})`,
        { status: res.status, name, ...(message ? { message } : {}) },
      );
    }
    const json = (await res.json()) as { key?: string };
    if (!json.key) {
      throw new HermeticError("INTERNAL", `tailscale returned no key for ${name}`, { name });
    }
    return json.key;
  }

  /**
   * §9: the tailscale side of `doctor`'s reconciliation. Never throws — a
   * missing `devices:core` read scope on the OAuth client, an expired
   * placeholder secret, or a network error are all just "we don't know",
   * and `doctor` reports that rather than failing outright.
   */
  async listDevices(): Promise<TailscaleDevice[] | null> {
    try {
      const token = await this.accessToken();
      const tailnet = this.opts.tailnet ?? "-";
      const res = await this.http(`${TAILSCALE_API}/api/v2/tailnet/${tailnet}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        devices?: Array<{
          id?: string;
          nodeId?: string;
          name?: string;
          hostname?: string;
          addresses?: string[];
          online?: boolean;
          tags?: string[];
        }>;
      };
      if (!json.devices) return null;
      return json.devices.map((d) => ({
        // `DELETE /api/v2/device/{id}` takes either; `nodeId` is the one
        // Tailscale documents going forward, so prefer it when it is there.
        id: d.nodeId ?? d.id ?? "",
        // The FQDN comes back with a trailing dot on some tailnets. Nothing
        // downstream wants to think about that, so it is dropped here.
        name: (d.name ?? "").replace(/\.$/, ""),
        hostname: d.hostname ?? "",
        addresses: d.addresses ?? [],
        online: d.online === true,
        tags: d.tags ?? [],
      }));
    } catch {
      return null;
    }
  }

  /**
   * §6.5/§6.7: delete one device, so the name it holds goes back to the fleet.
   *
   * Unlike `listDevices` this does not swallow everything — the caller has to
   * be able to tell "the client cannot write devices" (say so once, and stop)
   * from "the device was already gone" (fine) — but the three answers that
   * *are* expected come back as values, not throws.
   */
  async deleteDevice(id: string): Promise<TailscaleDeleteOutcome> {
    const token = await this.accessToken();
    const res = await this.http(`${TAILSCALE_API}/api/v2/device/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 200 || res.status === 204) return "deleted";
    if (res.status === 403) return "forbidden";
    if (res.status === 404) return "not_found";
    const message = await tailscaleErrorMessage(res, [token]);
    throw new HermeticError(
      "TAILSCALE_UNAVAILABLE",
      `tailscale refused to delete device ${id} (HTTP ${res.status}${message ? `: ${message}` : ""})`,
      { status: res.status, id, ...(message ? { message } : {}) },
    );
  }

  private aclUrl(suffix = ""): string {
    return `${TAILSCALE_API}/api/v2/tailnet/${this.opts.tailnet ?? "-"}/acl${suffix}`;
  }

  /**
   * §4.7: the tailnet policy file, HuJSON verbatim.
   *
   * Verbatim matters. The endpoint answers JSON when asked for JSON and HuJSON
   * otherwise, and hermetic wants the HuJSON: the document is the operator's,
   * its comments say why each rule exists, and `hujson.ts` edits it in place
   * rather than re-serializing it. So no `Accept: application/json` here, and
   * the `ETag` comes back with it because the write is conditional on it.
   *
   * `null` for a 403 — an OAuth client with no policy scope, which is every
   * client created before this feature — because hermetic manages three blocks
   * in a file it does not own, and not being allowed to look is a thing to
   * report, not to fail on.
   */
  async getPolicy(): Promise<TailscalePolicy | null> {
    const token = await this.accessToken();
    const res = await this.http(this.aclUrl(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 403) return null;
    if (!res.ok) {
      const message = await tailscaleErrorMessage(res, [token]);
      throw new HermeticError(
        "TAILSCALE_UNAVAILABLE",
        `tailscale refused to return the tailnet policy (HTTP ${res.status}${message ? `: ${message}` : ""})`,
        { status: res.status, ...(message ? { message } : {}) },
      );
    }
    const text = await res.text();
    /**
     * An ETag hermetic did not get is an ETag it cannot send back, and a write
     * with no `If-Match` is the overwrite this whole path exists to avoid. The
     * empty string is what `setPolicy` refuses on rather than a silent
     * unconditional POST.
     */
    return { text, etag: res.headers.get("etag") ?? "" };
  }

  /**
   * `POST …/acl/validate`: Tailscale's own parse, plus the policy's embedded
   * tests, against a candidate document. Nothing is stored. A 400 carries the
   * reason — `line N, column M: …`, or `test(s) failed` with the failures in
   * `data` — and that reason is the most useful thing hermetic can say, so it
   * is passed through (redacted of the bearer token, which is the only secret
   * anywhere near this call).
   */
  async validatePolicy(text: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const token = await this.accessToken();
    const res = await this.http(this.aclUrl("/validate"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": POLICY_CONTENT_TYPE },
      body: text,
    });
    if (res.ok) return { ok: true };
    if (res.status === 403) return { ok: false, message: NO_POLICY_WRITE_SCOPE };
    const message = await tailscaleErrorMessage(res, [token]);
    return {
      ok: false,
      message: message ?? `tailscale rejected the policy (HTTP ${res.status})`,
    };
  }

  /**
   * `POST …/acl` with `If-Match`. The three answers a caller must decide about
   * come back as values — 412 somebody edited the policy first, 403 no write
   * scope, 400 the policy is not valid — and everything else throws, because it
   * is a Tailscale hermetic cannot talk to rather than an answer about the
   * policy. The document itself never appears in a message: a policy file can
   * name people (§8.3).
   */
  async setPolicy(text: string, etag: string): Promise<TailscaleWriteOutcome> {
    if (etag.length === 0) {
      throw new HermeticError(
        "TAILSCALE_UNAVAILABLE",
        "tailscale returned no ETag for the policy file, so it cannot be written back safely; retry, and if it persists apply the entries by hand",
      );
    }
    const token = await this.accessToken();
    const res = await this.http(this.aclUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": POLICY_CONTENT_TYPE,
        "if-match": etag,
      },
      body: text,
    });
    if (res.ok) return { kind: "written", etag: res.headers.get("etag") ?? etag };
    if (res.status === 412) return { kind: "conflict" };
    if (res.status === 403) return { kind: "forbidden" };
    if (res.status === 400) {
      const message = await tailscaleErrorMessage(res, [token]);
      return { kind: "invalid", message: message ?? "tailscale rejected the policy (HTTP 400)" };
    }
    const message = await tailscaleErrorMessage(res, [token]);
    throw new HermeticError(
      "TAILSCALE_UNAVAILABLE",
      `tailscale refused to write the tailnet policy (HTTP ${res.status}${message ? `: ${message}` : ""})`,
      { status: res.status, ...(message ? { message } : {}) },
    );
  }
}
