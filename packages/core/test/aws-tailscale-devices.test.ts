import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { TailscaleClient } from "../src/aws/tailscale.ts";
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

function client(fetchImpl: typeof fetch) {
  return new TailscaleClient(new SsmSecrets(new SSMClient({ region: "us-west-2" })), {
    fleetId: () => TEST_FLEET_ID,
    fetch: fetchImpl,
    tailnet: "hermetic.ts.net",
  });
}

/** §9: the tailscale half of `doctor`'s three-way reconciliation. */
describe("TailscaleClient.listDevices", () => {
  test("returns the tailnet's devices", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/devices")) {
        return new Response(
          JSON.stringify({
            devices: [
              {
                id: "123456789",
                nodeId: "nodeFIXTUREatlas",
                // Tailscale returns the FQDN, sometimes with a trailing dot.
                name: "atlas.hermetic.ts.net.",
                hostname: "atlas",
                addresses: ["100.64.1.1"],
                online: true,
                tags: ["tag:hermetic"],
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const devices = await client(fetchImpl).listDevices();
    expect(devices).toEqual([
      {
        // `nodeId` wins over the legacy numeric `id`; both address the same
        // device on `DELETE /api/v2/device/{id}`.
        id: "nodeFIXTUREatlas",
        name: "atlas.hermetic.ts.net",
        hostname: "atlas",
        addresses: ["100.64.1.1"],
        online: true,
        tags: ["tag:hermetic"],
      },
    ]);
  });

  /** A tailnet that has not adopted `nodeId` still has to be deletable. */
  test("falls back to the legacy numeric id when there is no nodeId", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          devices: [{ id: "123456789", name: "atlas.hermetic.ts.net", hostname: "atlas" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const devices = await client(fetchImpl).listDevices();
    expect(devices![0]!.id).toBe("123456789");
    expect(devices![0]!.online).toBe(false);
    expect(devices![0]!.tags).toEqual([]);
  });

  test("degrades to null when the API rejects the call (missing devices:core scope)", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/devices")) {
        return new Response("forbidden", { status: 403 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    expect(await client(fetchImpl).listDevices()).toBeNull();
  });

  test("degrades to null rather than throwing when the OAuth token call fails entirely", async () => {
    const fetchImpl = (async () => {
      throw new Error("network is down");
    }) as unknown as typeof fetch;

    expect(await client(fetchImpl).listDevices()).toBeNull();
  });
});

/**
 * §6.5/§6.7: the delete that gives the canonical MagicDNS name back to the
 * fleet. The three expected answers are values, so `recreate`/`destroy` can
 * tell "not allowed" from "already gone"; anything else is a `HermeticError`
 * the caller downgrades to a warning.
 */
describe("TailscaleClient.deleteDevice", () => {
  /** The `DELETE` the client sent, so the id and the method are assertable. */
  function deleting(status: number, body = ""): { calls: string[]; fetch: typeof fetch } {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(body === "" ? null : body, { status });
    }) as typeof fetch;
    return { calls, fetch: fetchImpl };
  }

  test("204 is a deletion, at the device's own endpoint", async () => {
    const { calls, fetch: fetchImpl } = deleting(204);
    expect(await client(fetchImpl).deleteDevice("nodeFIXTUREatlas")).toBe("deleted");
    expect(calls).toEqual(["DELETE https://api.tailscale.com/api/v2/device/nodeFIXTUREatlas"]);
  });

  test("200 is a deletion too — the API answers with either", async () => {
    const { fetch: fetchImpl } = deleting(200, JSON.stringify({}));
    expect(await client(fetchImpl).deleteDevice("nodeFIXTUREatlas")).toBe("deleted");
  });

  /** The client that was never re-scoped to `devices:core` write. */
  test("403 is forbidden, not an error", async () => {
    const { fetch: fetchImpl } = deleting(403, JSON.stringify({ message: "access denied" }));
    expect(await client(fetchImpl).deleteDevice("nodeFIXTUREatlas")).toBe("forbidden");
  });

  /** Somebody deleted it in the console first: the state we wanted. */
  test("404 is not_found, not an error", async () => {
    const { fetch: fetchImpl } = deleting(404);
    expect(await client(fetchImpl).deleteDevice("nodeFIXTUREatlas")).toBe("not_found");
  });

  test("anything else throws TAILSCALE_UNAVAILABLE, carrying the API's message", async () => {
    const { fetch: fetchImpl } = deleting(500, JSON.stringify({ message: "internal error" }));
    const err = await client(fetchImpl)
      .deleteDevice("nodeFIXTUREatlas")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(HermeticError);
    expect((err as HermeticError).code).toBe("TAILSCALE_UNAVAILABLE");
    expect((err as HermeticError).message).toContain("HTTP 500");
    expect((err as HermeticError).message).toContain("internal error");
  });

  /** §8.3: a failure message may never carry the bearer token back out. */
  test("the bearer token is redacted out of a failure message", async () => {
    const { fetch: fetchImpl } = deleting(500, JSON.stringify({ message: "bad token tok" }));
    const err = (await client(fetchImpl)
      .deleteDevice("nodeFIXTUREatlas")
      .catch((e: unknown) => e)) as HermeticError;
    expect(err.message).not.toContain("bad token tok");
    expect(err.message).toContain("<redacted>");
  });
});
