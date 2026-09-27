import { describe, expect, test } from "bun:test";
import { HermeticdRpc } from "../src/aws/rpc.ts";
import { TailscaleClient } from "../src/aws/tailscale.ts";
import { aclSnippet, aclSnippetParts, type AclSnippetPart } from "../src/fleet/policy.ts";
import type { SsmSecrets } from "../src/aws/ssm.ts";
import type { AgentStore } from "../src/backend/types.ts";
import {
  HERMETICD_RPC_PORT,
  RPC_PATHS,
  RPC_VERSION_HEADER,
  type RpcFrame,
  decodeRpcFrame,
  encodeRpcFrame,
} from "../src/schema/index.ts";
import { SECRET_PLACEHOLDER, tailscaleOauthSecretPath } from "../src/backend/constants.ts";

/** The fleet whose OAuth slot these stubs stand in for (§8.2). */
const TEST_FLEET_ID = "fxtr0001";
const TAILSCALE_OAUTH_SECRET_PATH = tailscaleOauthSecretPath(TEST_FLEET_ID);
import { HermeticError } from "../src/errors.ts";
import { MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";

const AT = "2026-09-01T12:00:00.000Z";

function ndjson(frames: RpcFrame[]): Response {
  return new Response(frames.map(encodeRpcFrame).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
}

/**
 * A stream that hands over `frames` and then dies. The chunks are enqueued from
 * `pull`, one per read, because a `controller.error()` issued while chunks are
 * still queued discards them — which would test the opposite of what this is
 * for: whether a *complete* stream survives its socket being torn down.
 */
function dyingNdjson(frames: RpcFrame[], error: Error): Response {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const frame = frames[i];
        i += 1;
        if (frame === undefined) controller.error(error);
        else controller.enqueue(enc.encode(encodeRpcFrame(frame)));
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

function agentStore(): AgentStore {
  return seedFixtureFleet(new MemoryBackend()).store.agents;
}

/** The wire format `packages/agentd` implements the server side against (§6.4). */
describe("the hermeticd RPC wire format", () => {
  test("frames round-trip through NDJSON", () => {
    const frame: RpcFrame = {
      type: "log",
      line: { unit: "hermes", at: AT, message: "packages up to date", stream: "stdout" },
    };
    const line = encodeRpcFrame(frame);
    expect(line.endsWith("\n")).toBe(true);
    expect(decodeRpcFrame(line.trim())).toEqual(frame);
  });

  test("an unknown frame type is refused rather than ignored", () => {
    expect(() => decodeRpcFrame(JSON.stringify({ type: "shell", cmd: "rm -rf /" }))).toThrow();
  });
});

describe("HermeticdRpc", () => {
  test("logs go to the agent's tailnet address, under the protocol header", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async (url, init) => {
        seenUrl = url;
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return ndjson([
          { type: "log", line: { unit: "hermes", at: AT, message: "started" } },
          { type: "done", ok: true },
        ]);
      },
    });

    const lines = [];
    for await (const line of rpc.logs("atlas")) lines.push(line);

    expect(seenUrl).toStartWith(`http://100.64.12.4:${HERMETICD_RPC_PORT}${RPC_PATHS.logs}`);
    expect(seenHeaders[RPC_VERSION_HEADER]).toBe("1");
    expect(lines.map((l) => l.message)).toEqual(["started"]);
  });

  test("an error frame becomes a typed HermeticError", async () => {
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async () => ndjson([{ type: "error", code: "CONFLICT", message: "no such unit" }]),
    });
    const run = (async () => {
      for await (const _ of rpc.logs("atlas")) void _;
    })();
    await expect(run).rejects.toThrow(HermeticError);
  });

  test("logs streams NDJSON log frames", async () => {
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async (url) => {
        expect(url).toContain(`${RPC_PATHS.logs}?unit=hermes`);
        return ndjson([
          { type: "log", line: { unit: "hermes", at: AT, message: "started" } },
          { type: "log", line: { unit: "hermes", at: AT, message: "healthy" } },
        ]);
      },
    });
    const lines = [];
    for await (const line of rpc.logs("atlas", { unit: "hermes" })) lines.push(line);
    expect(lines.map((l) => l.message)).toEqual(["started", "healthy"]);
  });

  /**
   * The `follow` half of §6.4, and the reason `logs` takes options at all.
   *
   * A request that asks to follow keeps the body open on the box; one that does
   * not lets journalctl exit, which is what ends the stream with `done`. The
   * client used to send `follow=true` unconditionally, so every `hermetic logs
   * <name>` sat on a connection nothing would ever write to again and failed
   * when it was eventually dropped — a socket error from a command that had
   * already printed everything there was.
   */
  test("a plain logs request does not ask the box to follow", async () => {
    let seenUrl = "";
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async (url) => {
        seenUrl = url;
        return ndjson([
          { type: "log", line: { unit: "hermes", at: AT, message: "started" } },
          { type: "done", ok: true },
        ]);
      },
    });
    const lines = [];
    for await (const line of rpc.logs("atlas")) lines.push(line);
    expect(seenUrl).not.toContain("follow");
    expect(lines.map((l) => l.message)).toEqual(["started"]);
  });

  /**
   * The other source on the box: `$HERMES_HOME/logs/<file>.log` rather than a
   * journal unit. The client's job is only to name it — which reader answers is
   * hermeticd's decision, and it refuses a query carrying both.
   */
  test("a file request names the file and no unit", async () => {
    let seenUrl = "";
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async (url) => {
        seenUrl = url;
        return ndjson([
          { type: "log", line: { unit: "errors.log", at: AT, message: "WARNING turn aborted" } },
          { type: "done", ok: true },
        ]);
      },
    });
    const lines = [];
    for await (const line of rpc.logs("atlas", { file: "errors" })) lines.push(line);
    expect(seenUrl).toContain("file=errors");
    expect(seenUrl).not.toContain("unit=");
    expect(lines.map((l) => l.unit)).toEqual(["errors.log"]);
  });

  test("follow and tail are passed through when the caller asks for them", async () => {
    let seenUrl = "";
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async (url) => {
        seenUrl = url;
        return ndjson([{ type: "done", ok: true }]);
      },
    });
    for await (const _ of rpc.logs("atlas", { unit: "hermes", follow: true, tail: 50 })) void _;
    expect(seenUrl).toContain("unit=hermes");
    expect(seenUrl).toContain("follow=true");
    expect(seenUrl).toContain("tail=50");
  });

  /**
   * `done` is the end of the stream, not a hint that one is coming. A socket
   * torn down after it — hermeticd exiting, a tailnet blip, an idle timeout on
   * either side — must not turn a complete read into a failure.
   */
  test("a socket that dies after the done frame is not an error", async () => {
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async () =>
        dyingNdjson(
          [
            { type: "log", line: { unit: "hermes", at: AT, message: "started" } },
            { type: "done", ok: true },
          ],
          new Error("socket hang up"),
        ),
    });

    const lines = [];
    for await (const line of rpc.logs("atlas")) lines.push(line);
    expect(lines.map((l) => l.message)).toEqual(["started"]);
  });

  test("a socket that dies before the done frame still fails", async () => {
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async () =>
        dyingNdjson(
          [{ type: "log", line: { unit: "hermes", at: AT, message: "started" } }],
          new Error("socket hang up"),
        ),
    });
    const run = (async () => {
      for await (const _ of rpc.logs("atlas")) void _;
    })();
    await expect(run).rejects.toThrow();
  });

  /**
   * `health()` is the one RPC that must come back — `logs --follow` is unbounded
   * by design — so it is the one that reads `requestTimeoutMs`. `agents.probe`
   * turns each of these failures into a `fail` layer with the message as its
   * detail, which is why the messages are asserted and not just the code.
   */
  test("health GETs /healthz on the tailnet address and parses the payload", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async (url, init) => {
        seenUrl = url;
        seenMethod = String(init?.method);
        return new Response(
          JSON.stringify({
            name: "atlas",
            hermeticd_version: "0.4.1",
            protocol: 1,
            config_hash: "abc123",
          }),
        );
      },
    });

    const health = await rpc.health("atlas");
    expect(seenUrl).toBe(`http://100.64.12.4:${HERMETICD_RPC_PORT}${RPC_PATHS.health}`);
    expect(seenMethod).toBe("GET");
    expect(health).toEqual({
      name: "atlas",
      hermeticd_version: "0.4.1",
      protocol: 1,
      config_hash: "abc123",
    });
  });

  test("a non-200 is a typed INTERNAL naming the status", async () => {
    const rpc = new HermeticdRpc(agentStore(), {
      fetch: async () => new Response("nope", { status: 503 }),
    });
    let error: HermeticError | null = null;
    try {
      await rpc.health("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("INTERNAL");
    expect(error!.message).toContain("HTTP 503");
  });

  /**
   * The property the probe depends on: a box that accepts the connection and
   * then says nothing must not hang the caller. Twenty milliseconds is enough
   * to prove the budget is honoured without making the suite wait.
   */
  test("a hermeticd that never answers times out rather than hanging", async () => {
    const rpc = new HermeticdRpc(agentStore(), {
      requestTimeoutMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    let error: HermeticError | null = null;
    const started = Date.now();
    try {
      await rpc.health("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("INTERNAL");
    expect(error!.message).toContain("did not answer within 20ms");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  /**
   * The caller's own signal is honoured too, not traded away for the timeout:
   * an operator's Ctrl-C and a dead box are both reasons to stop waiting, and a
   * client that respected only its own budget would ignore the first.
   */
  test("the caller's abort signal stops the wait as well", async () => {
    const rpc = new HermeticdRpc(agentStore(), {
      // Far longer than this test may take, so only the caller's abort can end it.
      requestTimeoutMs: 60_000,
      // Shaped like the platform `fetch`: an already-aborted signal rejects at
      // once rather than waiting for an `abort` event that has been and gone.
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = (): void => reject(new Error("operator gave up"));
          if (init?.signal?.aborted) return fail();
          init?.signal?.addEventListener("abort", fail);
        }),
    });
    const controller = new AbortController();
    const run = rpc.health("atlas", { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(run).rejects.toThrow(HermeticError);
  });

  test("an agent with no tailscale address is a typed CONFLICT, not a hang", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    await backend.store.agents.update("atlas", 8, { tailscale_ip: null });
    const rpc = new HermeticdRpc(backend.store.agents, {
      fetch: async () => {
        throw new Error("should not have been called");
      },
    });
    const run = (async () => {
      for await (const _ of rpc.logs("atlas")) void _;
    })();
    await expect(run).rejects.toThrow(HermeticError);
  });
});

describe("TailscaleClient", () => {
  function secrets(map: Map<string, string>): SsmSecrets {
    return {
      // `exists` is what picks the scoped slot over the pre-v3 root pair, so a
      // stub that lacked it would exercise only the fallback (§8.2).
      exists: async (path: string) => map.has(path),
      reveal: async (path: string) => map.get(path) ?? null,
      isPlaceholder: async (path: string) => map.get(path) === SECRET_PLACEHOLDER,
    } as unknown as SsmSecrets;
  }

  /** The pre-v3 pair, for the fallback a fleet that has not run `foundation update` needs. */
  const LEGACY_SECRET_PATH = "/hermetic/tailscale/oauth-secret";

  test("mints a tagged, single-use, one-hour, pre-authorised key (§6.2 step 3)", async () => {
    const bodies: string[] = [];
    const client = new TailscaleClient(
      secrets(new Map([[TAILSCALE_OAUTH_SECRET_PATH, "tskey-client-kABC123-oauthsecret"]])),
      {
        fleetId: () => TEST_FLEET_ID,
        fetch: async (url, init) => {
          bodies.push(String(init?.body ?? ""));
          if (url.endsWith("/oauth/token")) {
            return new Response(JSON.stringify({ access_token: "tsoauth", expires_in: 3600 }));
          }
          return new Response(JSON.stringify({ key: "tskey-auth-MINTED" }));
        },
      },
    );

    expect(await client.mintAuthKey("atlas")).toBe("tskey-auth-MINTED");

    // The client id is derived from the secret, which never leaves the request.
    expect(bodies[0]).toContain("client_id=kABC123");
    const keyRequest = JSON.parse(bodies[1]!) as {
      capabilities: { devices: { create: Record<string, unknown> } };
      expirySeconds: number;
    };
    expect(keyRequest.capabilities.devices.create).toMatchObject({
      reusable: false,
      ephemeral: false,
      preauthorized: true,
      tags: ["tag:hermetic"],
    });
    expect(keyRequest.expirySeconds).toBe(3600);
  });

  test("a slot that is still a placeholder is NOT_FOUND, not an opaque 401", async () => {
    const client = new TailscaleClient(
      secrets(new Map([[TAILSCALE_OAUTH_SECRET_PATH, SECRET_PLACEHOLDER]])),
      { fleetId: () => TEST_FLEET_ID, fetch: async () => new Response("{}") },
    );
    let error: HermeticError | null = null;
    try {
      await client.mintAuthKey("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("NOT_FOUND");
    expect(error!.details).toMatchObject({ placeholder: true });
  });

  /**
   * §8.2: a home on this build whose fleet has not taken `foundation update`
   * yet still has its OAuth client on the pre-v3 root — and every `agent
   * create` mints from it, so reading only the scoped path would break the
   * fleet for the window between the upgrade and the update.
   */
  test("falls back to the pre-v3 root pair when the scoped slot is not there yet", async () => {
    const bodies: string[] = [];
    const client = new TailscaleClient(
      secrets(new Map([[LEGACY_SECRET_PATH, "tskey-client-kLEGACY-oauthsecret"]])),
      {
        fleetId: () => TEST_FLEET_ID,
        // A fleet that has not run `foundation update` yet: v2, so the roots
        // are still its own.
        foundationVersion: async () => 2,
        fetch: async (url, init) => {
          bodies.push(String(init?.body ?? ""));
          return url.endsWith("/oauth/token")
            ? new Response(JSON.stringify({ access_token: "tsoauth", expires_in: 3600 }))
            : new Response(JSON.stringify({ key: "tskey-auth-MINTED" }));
        },
      },
    );
    expect(await client.mintAuthKey("main-atlas")).toBe("tskey-auth-MINTED");
    expect(bodies[0]).toContain("client_id=kLEGACY");
  });

  /** The scoped slot wins whenever there is anything in it. */
  test("prefers the fleet-scoped slot over the root when both exist", async () => {
    const bodies: string[] = [];
    const client = new TailscaleClient(
      secrets(
        new Map([
          [TAILSCALE_OAUTH_SECRET_PATH, "tskey-client-kSCOPED-oauthsecret"],
          [LEGACY_SECRET_PATH, "tskey-client-kLEGACY-oauthsecret"],
        ]),
      ),
      {
        fleetId: () => TEST_FLEET_ID,
        fetch: async (url, init) => {
          bodies.push(String(init?.body ?? ""));
          return url.endsWith("/oauth/token")
            ? new Response(JSON.stringify({ access_token: "tsoauth", expires_in: 3600 }))
            : new Response(JSON.stringify({ key: "tskey-auth-MINTED" }));
        },
      },
    );
    await client.mintAuthKey("main-atlas");
    expect(bodies[0]).toContain("client_id=kSCOPED");
  });

  /**
   * The other side of the same gate, and the one that matters: on a fleet that
   * has taken v3 the account roots are not "our client, not moved yet" — they
   * are an account-global namespace other fleets also wrote to, and minting
   * from what is left there would use somebody else's OAuth client.
   */
  test("a v3 fleet never falls back to the root, even with a secret sitting there", async () => {
    const client = new TailscaleClient(
      secrets(new Map([[LEGACY_SECRET_PATH, "tskey-client-kLEGACY-oauthsecret"]])),
      {
        fleetId: () => TEST_FLEET_ID,
        foundationVersion: async () => 3,
        fetch: async () => new Response("{}"),
      },
    );
    let error: HermeticError | null = null;
    try {
      await client.mintAuthKey("main-atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("NOT_FOUND");
    // It names the scoped path it looked in, not the root it refused to read.
    expect(error!.details).toMatchObject({ path: TAILSCALE_OAUTH_SECRET_PATH });
    expect(error!.message).toContain("foundation update");
    expect(error!.message).toContain("secrets push _fleet --tailscale-oauth");
  });

  /** A `_fleet` with no version recorded at all is a pre-stamp fleet: legacy. */
  test("a fleet with no foundation_version is treated as pre-v3", async () => {
    const bodies: string[] = [];
    const client = new TailscaleClient(
      secrets(new Map([[LEGACY_SECRET_PATH, "tskey-client-kLEGACY-oauthsecret"]])),
      {
        fleetId: () => TEST_FLEET_ID,
        foundationVersion: async () => null,
        fetch: async (url, init) => {
          bodies.push(String(init?.body ?? ""));
          return url.endsWith("/oauth/token")
            ? new Response(JSON.stringify({ access_token: "tsoauth", expires_in: 3600 }))
            : new Response(JSON.stringify({ key: "tskey-auth-MINTED" }));
        },
      },
    );
    await client.mintAuthKey("main-atlas");
    expect(bodies[0]).toContain("client_id=kLEGACY");
  });

  test("a missing OAuth slot is NOT_FOUND with instructions, never a stack trace", async () => {
    const client = new TailscaleClient(secrets(new Map()), {
      fleetId: () => TEST_FLEET_ID,
      fetch: async () => new Response("{}"),
    });
    let error: HermeticError | null = null;
    try {
      await client.mintAuthKey("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("NOT_FOUND");
    expect(error!.message).toContain("admin console");
    expect(error!.message).not.toContain("tskey-client");
  });

  test("a rejected credential never echoes the secret", async () => {
    const client = new TailscaleClient(
      secrets(new Map([[TAILSCALE_OAUTH_SECRET_PATH, "tskey-client-kABC123-oauthsecret"]])),
      {
        fleetId: () => TEST_FLEET_ID,
        fetch: async () =>
          new Response("bad client_secret=tskey-client-kABC123-oauthsecret", { status: 401 }),
      },
    );
    let error: HermeticError | null = null;
    try {
      await client.mintAuthKey("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("INTERNAL");
    expect(error!.message).not.toContain("oauthsecret");
  });
});

describe("acl_snippet", () => {
  test("is valid JSON with the tag owner, the SSH rule and the Serve rule", () => {
    const body = aclSnippet().split("\n").slice(1).join("\n");
    const acl = JSON.parse(body) as {
      tagOwners: Record<string, string[]>;
      ssh: Array<{ dst: string[] }>;
      acls: Array<{ dst: string[] }>;
    };
    expect(acl.tagOwners["tag:hermetic"]).toEqual(["autogroup:admin"]);
    expect(acl.ssh[0]!.dst).toEqual(["tag:hermetic"]);
    expect(acl.acls[0]!.dst).toContain(`tag:hermetic:${HERMETICD_RPC_PORT}`);
  });

  /**
   * The wizard shows the parts one per top-level key so the operator splices
   * rather than merges; each must parse on its own and add up to the object.
   */
  test("the parts splice into the same policy the whole snippet renders", () => {
    const parts = aclSnippetParts();
    expect(parts.map((p: AclSnippetPart) => p.key)).toEqual(["tagOwners", "ssh", "acls"]);
    const whole = JSON.parse(aclSnippet().split("\n").slice(1).join("\n")) as Record<string, unknown>;
    for (const part of parts) {
      const value = JSON.parse(part.key === "tagOwners" ? `{${part.body}}` : part.body) as unknown;
      expect(part.key === "tagOwners" ? whole.tagOwners : (whole[part.key] as unknown[])[0]).toEqual(
        value,
      );
      expect(part.purpose.length).toBeGreaterThan(0);
    }
  });
});
