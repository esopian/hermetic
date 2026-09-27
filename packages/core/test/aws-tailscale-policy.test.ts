/**
 * The transport half of §4.7's tailnet policy: `GET /acl`, `POST /acl/validate`,
 * `POST /acl` with `If-Match`. Same injected-`fetch` shape as
 * `aws-tailscale-devices.test.ts` — no network, and the SSM secret is mocked.
 *
 * What is being pinned here is the *answers*, because each one means something
 * different to `policy.ts`: 403 is a scope, 412 is somebody else's edit, 400 is
 * a policy Tailscale will not accept, and anything else is a Tailscale hermetic
 * cannot talk to.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { POLICY_CONTENT_TYPE, TailscaleClient } from "../src/aws/tailscale.ts";
import { HermeticError } from "../src/errors.ts";
import { SsmSecrets } from "../src/aws/ssm.ts";
import { tailscaleOauthClientIdPath, tailscaleOauthSecretPath } from "../src/backend/constants.ts";

/** The fleet these slots belong to; every OAuth path is scoped by it (§8.2). */
const TEST_FLEET_ID = "fxtr0001";
const TAILSCALE_OAUTH_SECRET_PATH = tailscaleOauthSecretPath(TEST_FLEET_ID);
const TAILSCALE_OAUTH_CLIENT_ID_PATH = tailscaleOauthClientIdPath(TEST_FLEET_ID);
import { installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const ssm = mockClient(SSMClient);

beforeEach(() => {
  ssm.reset();
  ssm.on(GetParameterCommand, { Name: TAILSCALE_OAUTH_SECRET_PATH }).resolves({
    Parameter: { Value: "tskey-client-abc123-realsecretvalue" },
  });
  ssm.on(GetParameterCommand, { Name: TAILSCALE_OAUTH_CLIENT_ID_PATH }).resolves({
    Parameter: { Value: undefined },
  });
});

const POLICY = `// acme's tailnet policy.\n{\n  "tagOwners": {\n    "tag:hermetic": ["autogroup:admin"],\n  },\n}\n`;

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A client whose every call is recorded, answered by `handler`. */
function client(handler: (seen: Seen) => Response): { client: TailscaleClient; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    const seen: Seen = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(seen);
    return handler(seen);
  }) as unknown as typeof fetch;
  return {
    calls,
    client: new TailscaleClient(new SsmSecrets(new SSMClient({ region: "us-west-2" })), {
      fleetId: () => TEST_FLEET_ID,
      fetch: fetchImpl,
      tailnet: "hermetic.ts.net",
    }),
  };
}

describe("TailscaleClient.getPolicy", () => {
  /**
   * HuJSON, not JSON: no `Accept: application/json`, because the comments and
   * the key order are the operator's and `hujson.ts` edits the document in
   * place rather than re-serializing it.
   */
  test("returns the policy verbatim with its ETag, and never asks for JSON", async () => {
    const c = client(() => new Response(POLICY, { status: 200, headers: { etag: '"abc123"' } }));
    const policy = await c.client.getPolicy();
    expect(policy).toEqual({ text: POLICY, etag: '"abc123"' });
    expect(c.calls[0]!.url).toBe("https://api.tailscale.com/api/v2/tailnet/hermetic.ts.net/acl");
    expect(c.calls[0]!.headers["accept"]).toBeUndefined();
  });

  /** A client without the scope is a report, not a failure (§4.7). */
  test("403 is null, not a throw", async () => {
    const c = client(() => new Response(JSON.stringify({ message: "nope" }), { status: 403 }));
    expect(await c.client.getPolicy()).toBeNull();
  });

  test("any other failure is TAILSCALE_UNAVAILABLE and carries the status", async () => {
    const c = client(() => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    const error = await c.client.getPolicy().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HermeticError);
    expect((error as HermeticError).code).toBe("TAILSCALE_UNAVAILABLE");
    expect((error as HermeticError).message).toContain("500");
  });
});

describe("TailscaleClient.validatePolicy", () => {
  test("200 is ok, and the candidate goes as HuJSON", async () => {
    const c = client(() => new Response(null, { status: 200 }));
    expect(await c.client.validatePolicy(POLICY)).toEqual({ ok: true });
    expect(c.calls[0]!.url).toEndWith("/acl/validate");
    expect(c.calls[0]!.method).toBe("POST");
    expect(c.calls[0]!.headers["content-type"]).toBe(POLICY_CONTENT_TYPE);
    expect(c.calls[0]!.body).toBe(POLICY);
  });

  /** Tailscale's own message is the useful one: it names the line and column. */
  test("400 hands back the message Tailscale gave", async () => {
    const c = client(
      () =>
        new Response(JSON.stringify({ message: "line 4, column 3: unexpected comma" }), {
          status: 400,
        }),
    );
    expect(await c.client.validatePolicy(POLICY)).toEqual({
      ok: false,
      message: "line 4, column 3: unexpected comma",
    });
  });

  /** The sentinel `policy.ts` reads to tell a read-only client from a bad policy. */
  test("403 answers the missing-scope sentence rather than a body", async () => {
    const c = client(() => new Response(JSON.stringify({ message: "nope" }), { status: 403 }));
    const result = await c.client.validatePolicy(POLICY);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("policy_file");
  });

  test("500 is a message rather than a throw: the caller decides", async () => {
    const c = client(() => new Response(null, { status: 500 }));
    const result = await c.client.validatePolicy(POLICY);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("500");
  });
});

describe("TailscaleClient.setPolicy", () => {
  test("sends If-Match and returns the new ETag", async () => {
    const c = client(() => new Response(POLICY, { status: 200, headers: { etag: '"def456"' } }));
    expect(await c.client.setPolicy(POLICY, '"abc123"')).toEqual({
      kind: "written",
      etag: '"def456"',
    });
    expect(c.calls[0]!.headers["if-match"]).toBe('"abc123"');
    expect(c.calls[0]!.body).toBe(POLICY);
  });

  /** The whole reason the ETag is carried through the plan (§4.7). */
  test("412 is a conflict, not a throw", async () => {
    const c = client(() => new Response(null, { status: 412 }));
    expect(await c.client.setPolicy(POLICY, '"abc123"')).toEqual({ kind: "conflict" });
  });

  test("403 is forbidden and 400 is invalid, with Tailscale's message", async () => {
    const forbidden = client(() => new Response(null, { status: 403 }));
    expect(await forbidden.client.setPolicy(POLICY, '"e"')).toEqual({ kind: "forbidden" });

    const invalid = client(
      () => new Response(JSON.stringify({ message: "test(s) failed" }), { status: 400 }),
    );
    expect(await invalid.client.setPolicy(POLICY, '"e"')).toEqual({
      kind: "invalid",
      message: "test(s) failed",
    });
  });

  test("anything else throws TAILSCALE_UNAVAILABLE", async () => {
    const c = client(() => new Response(JSON.stringify({ message: "boom" }), { status: 502 }));
    const error = await c.client.setPolicy(POLICY, '"e"').catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("TAILSCALE_UNAVAILABLE");
  });

  /**
   * No ETag, no write. An unconditional POST over a document somebody may have
   * edited in the console is exactly what `If-Match` is here to prevent, so a
   * missing ETag refuses rather than falling back to one.
   */
  test("refuses to write without an ETag rather than writing unconditionally", async () => {
    const c = client(() => new Response(null, { status: 200 }));
    const error = await c.client.setPolicy(POLICY, "").catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("TAILSCALE_UNAVAILABLE");
    expect(c.calls).toEqual([]);
  });

  /** The policy can name people, so no message ever carries the document. */
  test("no failure message contains the policy text", async () => {
    const c = client(() => new Response(JSON.stringify({ message: "boom" }), { status: 502 }));
    const error = await c.client
      .setPolicy('{ "groups": { "group:ops": ["alice@example.com"] } }', '"e"')
      .catch((e: unknown) => e);
    expect((error as HermeticError).message).not.toContain("alice@example.com");
  });
});
