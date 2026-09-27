/**
 * The §4.7 Tailscale preflight. Neither half touches a real daemon or
 * api.tailscale.com: the local probe takes an injected `exec`, and the OAuth
 * verifier takes an injected `fetch`, so every shape that matters — logged out,
 * daemon down, MagicDNS off, HTTPS certificates off, an OAuth client with no
 * `auth_keys` scope — is just a different canned answer.
 */
import { describe, expect, test } from "bun:test";
import {
  PROBE_KEY_TTL_SECONDS,
  TAILSCALE_ADMIN_DNS_URL,
  parseTailscaleStatus,
  probeLocalTailscale,
  verifyTailscaleOauthClient,
  type ExecResult,
} from "../src/fleet/preflight.ts";

const RUNNING = JSON.stringify({
  BackendState: "Running",
  MagicDNSSuffix: "acme.ts.net",
  TailscaleIPs: ["100.64.0.7", "fd7a::1"],
  CertDomains: ["laptop.acme.ts.net"],
  CurrentTailnet: { Name: "acme.com", MagicDNSSuffix: "acme.ts.net" },
  Self: { HostName: "laptop", DNSName: "laptop.acme.ts.net." },
});

describe("reading `tailscale status --json`", () => {
  test("a logged-in machine reports its MagicDNS suffix, not its org name", () => {
    const status = parseTailscaleStatus(RUNNING, "tailscale");
    expect(status.ok).toBe(true);
    // `CurrentTailnet.Name` is `acme.com`; no Serve URL is ever built from it.
    expect(status.tailnet).toBe("acme.ts.net");
    expect(status.hostname).toBe("laptop");
    expect(status.addresses[0]).toBe("100.64.0.7");
    expect(status.problem).toBeNull();
  });

  test("an older daemon that reports only Self.DNSName still yields the suffix", () => {
    const status = parseTailscaleStatus(
      JSON.stringify({
        BackendState: "Running",
        CertDomains: ["laptop.acme.ts.net"],
        Self: { DNSName: "laptop.acme.ts.net." },
      }),
      "tailscale",
    );
    expect(status.tailnet).toBe("acme.ts.net");
    expect(status.ok).toBe(true);
  });

  /** Logged out is the common case and deserves the actionable message. */
  test("NeedsLogin is not ok and says what to run", () => {
    const status = parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" }), "tailscale");
    expect(status.ok).toBe(false);
    expect(status.installed).toBe(true);
    expect(status.running).toBe(false);
    expect(status.problem).toContain("tailscale up");
  });

  test("Stopped is not ok", () => {
    const status = parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" }), "tailscale");
    expect(status.ok).toBe(false);
    expect(status.backend_state).toBe("Stopped");
  });

  /**
   * A running daemon with MagicDNS off has no suffix, so there is no hostname to
   * render into a Serve config — which makes it just as unusable as being logged
   * out, for a different reason.
   */
  test("running with no MagicDNS suffix is not ok", () => {
    const status = parseTailscaleStatus(JSON.stringify({ BackendState: "Running" }), "tailscale");
    expect(status.ok).toBe(false);
    expect(status.running).toBe(true);
    expect(status.problem).toContain("MagicDNS");
  });

  /**
   * The failure this check exists for is silent on the laptop and loud twenty
   * minutes later on the box: `tailscale serve --https=443`, which every
   * agent's apply ends in, needs a cert the tailnet will only issue when HTTPS
   * Certificates is on. The daemon reports that as `CertDomains`, so the answer
   * is already in the JSON `init` reads before it creates anything.
   */
  test("a tailnet with HTTPS certificates off is not ok, and says where to enable them", () => {
    const status = parseTailscaleStatus(
      JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "acme.ts.net", CertDomains: null }),
      "tailscale",
    );
    expect(status.ok).toBe(false);
    // Everything else about the machine is fine; only the tailnet setting is not.
    expect(status.running).toBe(true);
    expect(status.tailnet).toBe("acme.ts.net");
    expect(status.cert_domains).toEqual([]);
    expect(status.problem).toContain("HTTPS certificates");
    expect(status.problem).toContain("tailscale serve --https");
    expect(status.problem).toContain(TAILSCALE_ADMIN_DNS_URL);
  });

  /** An older daemon that omits the key entirely reads the same as "off". */
  test("a status with no CertDomains key at all is not ok", () => {
    const status = parseTailscaleStatus(
      JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "acme.ts.net" }),
      "tailscale",
    );
    expect(status.ok).toBe(false);
    expect(status.problem).toContain("HTTPS certificates");
  });

  /** An empty list is the same finding: nothing this tailnet can get a cert for. */
  test("an empty CertDomains list is not ok", () => {
    const status = parseTailscaleStatus(
      JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "acme.ts.net", CertDomains: [] }),
      "tailscale",
    );
    expect(status.ok).toBe(false);
    expect(status.problem).toContain("HTTPS certificates");
  });

  test("a tailnet with certificates on is ok and records the domains", () => {
    const status = parseTailscaleStatus(
      JSON.stringify({
        BackendState: "Running",
        MagicDNSSuffix: "acme.ts.net",
        CertDomains: ["laptop.acme.ts.net"],
      }),
      "tailscale",
    );
    expect(status.ok).toBe(true);
    expect(status.problem).toBeNull();
    expect(status.cert_domains).toEqual(["laptop.acme.ts.net"]);
  });

  /**
   * MagicDNS is the deeper of the two and a tailnet without it is usually
   * without certificates too, so the message names the toggle that has to be
   * flipped first.
   */
  test("with both off, MagicDNS is the reported problem", () => {
    const status = parseTailscaleStatus(JSON.stringify({ BackendState: "Running" }), "tailscale");
    expect(status.problem).toContain("MagicDNS");
    expect(status.problem).not.toContain("HTTPS");
  });

  /**
   * The macOS App Store shim exits zero and prints a plain-text error when the
   * app is not running, so its own message is the useful one.
   */
  test("output that is not JSON reports the CLI's own first line", () => {
    const status = parseTailscaleStatus(
      "The Tailscale CLI failed to start: The operation couldn't be completed.\n",
      "tailscale",
    );
    expect(status.ok).toBe(false);
    expect(status.installed).toBe(true);
    expect(status.problem).toBe(
      "The Tailscale CLI failed to start: The operation couldn't be completed.",
    );
  });

  test("empty output falls back to the generic explanation", () => {
    expect(parseTailscaleStatus("", "tailscale").problem).toContain("did not return JSON");
  });
});

describe("finding a tailscale binary", () => {
  const ok = async (): Promise<ExecResult> => ({ code: 0, stdout: RUNNING, stderr: "" });

  test("falls through to the next install location when one is absent", async () => {
    const tried: string[] = [];
    const status = await probeLocalTailscale({
      binaries: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
      exec: async (argv) => {
        tried.push(argv[0] as string);
        // The macOS App Store build is not on PATH; only the bundle answers.
        if (argv[0] === "tailscale") throw new Error("ENOENT");
        return ok();
      },
    });
    expect(tried).toHaveLength(2);
    expect(status.ok).toBe(true);
    expect(status.binary).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  });

  /**
   * The shim at `/usr/local/bin` exits *zero* while failing, so a zero exit is
   * not enough to stop looking: the app bundle may be a working install.
   */
  test("a zero exit with unparseable output still falls through to the next binary", async () => {
    const status = await probeLocalTailscale({
      binaries: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
      exec: async (argv) =>
        argv[0] === "tailscale"
          ? { code: 0, stdout: "The Tailscale CLI failed to start", stderr: "" }
          : ok(),
    });
    expect(status.ok).toBe(true);
    expect(status.binary).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  });

  /** A daemon that answered "logged out" is a real answer; stop there. */
  test("a logged-out daemon stops the search rather than falling through", async () => {
    const tried: string[] = [];
    const status = await probeLocalTailscale({
      binaries: ["tailscale", "/opt/homebrew/bin/tailscale"],
      exec: async (argv) => {
        tried.push(argv[0] as string);
        return { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" };
      },
    });
    expect(tried).toEqual(["tailscale"]);
    expect(status.backend_state).toBe("NeedsLogin");
  });

  test("no binary anywhere reports not-installed rather than not-running", async () => {
    const status = await probeLocalTailscale({
      binaries: ["tailscale"],
      exec: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(status.installed).toBe(false);
    expect(status.ok).toBe(false);
    expect(status.problem).toContain("no `tailscale` binary");
  });

  /** A binary that exits non-zero is present; saying "not installed" would misdirect. */
  test("a binary that fails is reported as installed, with its own first line", async () => {
    const status = await probeLocalTailscale({
      binaries: ["tailscale"],
      exec: async () => ({ code: 1, stdout: "", stderr: "failed to connect to local tailscaled\n" }),
    });
    expect(status.installed).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.problem).toBe("failed to connect to local tailscaled");
  });
});

describe("verifying an OAuth client by using it", () => {
  interface Call {
    url: string;
    method: string;
    body?: string;
  }

  function stub(handler: (call: Call) => { status: number; body?: unknown }): {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
    calls: Call[];
  } {
    const calls: Call[] = [];
    return {
      calls,
      fetch: async (url, init) => {
        const call: Call = { url, method: init?.method ?? "GET" };
        if (typeof init?.body === "string") call.body = init.body;
        calls.push(call);
        const { status, body } = handler(call);
        return new Response(body === undefined ? null : JSON.stringify(body), { status });
      },
    };
  }

  test("token, mint, revoke, list devices — and the minted key is short-lived", async () => {
    let minted: Record<string, unknown> | null = null;
    const calls: Call[] = [];
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secretpart", {
      fetch: async (url, init) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/oauth/token")) {
          return Response.json({ access_token: "tskey-api-x", expires_in: 3600 });
        }
        // The policy read and its validate: the third scope, proved by asking
        // Tailscale to check the policy it already has.
        if (url.endsWith("/acl")) return new Response("{}\n", { status: 200 });
        if (url.endsWith("/acl/validate")) return new Response(null, { status: 200 });
        if (init?.method === "POST") {
          minted = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({ id: "kProbe1", key: "tskey-auth-…" });
        }
        return new Response(null, { status: 200 });
      },
    });

    expect(check).toEqual({
      ok: true,
      authenticated: true,
      can_mint: true,
      can_list_devices: true,
      policy_scope: "write",
      revoked: true,
      problem: null,
    });
    expect(minted).toMatchObject({ expirySeconds: PROBE_KEY_TTL_SECONDS });
    // Tagged with `tag:hermetic`: minting is what proves the tagOwners entry.
    expect(JSON.stringify(minted)).toContain("tag:hermetic");
    // The probe key is not left behind — and it goes before the device read, so
    // asking about the second scope can never strand a key.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.tailscale.com/api/v2/oauth/token",
      "POST https://api.tailscale.com/api/v2/tailnet/-/keys",
      "DELETE https://api.tailscale.com/api/v2/tailnet/-/keys/kProbe1",
      "GET https://api.tailscale.com/api/v2/tailnet/-/devices",
      "GET https://api.tailscale.com/api/v2/tailnet/-/acl",
      "POST https://api.tailscale.com/api/v2/tailnet/-/acl/validate",
    ]);
  });

  /**
   * §4.7: the third scope. `policy_file` is what lets hermetic keep its own
   * three entries in the tailnet policy current instead of asking for them to
   * be pasted — and, like `devices:core`, its absence is a note rather than a
   * refusal, because no fleet that exists today has it.
   */
  describe("the policy_file scope", () => {
    /** Reading the policy *and* validating it unchanged proves the write scope. */
    test("read plus validate is write", async () => {
      const s = stub((call) =>
        call.url.endsWith("/oauth/token")
          ? { status: 200, body: { access_token: "tskey-api-x" } }
          : call.url.endsWith("/acl") || call.url.endsWith("/acl/validate")
            ? { status: 200 }
            : call.method === "POST"
              ? { status: 200, body: { id: "kProbe1" } }
              : { status: 200 },
      );
      const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
        fetch: s.fetch,
      });
      expect(check.policy_scope).toBe("write");
      expect(check.problem).toBeNull();
      // The candidate sent to `/validate` is the policy that came back, byte for
      // byte: it is the one document guaranteed to be valid, so a 400 can only
      // be about the tailnet's own policy and a 403 only about the scope.
      const validate = s.calls.find((c) => c.url.endsWith("/acl/validate"));
      expect(validate?.body).toBe("");
    });

    /** A client that can read but not validate carries `policy_file:read`. */
    test("read without validate is read, and says what it costs", async () => {
      const s = stub((call) =>
        call.url.endsWith("/oauth/token")
          ? { status: 200, body: { access_token: "tskey-api-x" } }
          : call.url.endsWith("/acl/validate")
            ? { status: 403, body: { message: "calling actor does not have enough permissions" } }
            : call.url.endsWith("/acl")
              ? { status: 200 }
              : call.method === "POST"
                ? { status: 200, body: { id: "kProbe1" } }
                : { status: 200 },
      );
      const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
        fetch: s.fetch,
      });
      expect(check.ok).toBe(true);
      expect(check.policy_scope).toBe("read");
      expect(check.problem).toContain("policy_file");
      expect(check.problem).toContain("hermetic secrets push _fleet --tailscale-oauth");
    });

    /** No scope at all: the state every fleet created before this build is in. */
    test("a 403 on the policy read is none, and still not a failure", async () => {
      const s = stub((call) =>
        call.url.endsWith("/oauth/token")
          ? { status: 200, body: { access_token: "tskey-api-x" } }
          : call.url.includes("/acl")
            ? { status: 403, body: { message: "calling actor does not have enough permissions" } }
            : call.method === "POST"
              ? { status: 200, body: { id: "kProbe1" } }
              : { status: 200 },
      );
      const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
        fetch: s.fetch,
      });
      expect(check.ok).toBe(true);
      expect(check.policy_scope).toBe("none");
      expect(check.problem).toContain("policy_file");
      // A refused read is not retried against `/validate`: nothing to send.
      expect(s.calls.some((c) => c.url.endsWith("/acl/validate"))).toBe(false);
    });

    /**
     * The one that used to differ between the two callers. A validate that
     * fails for any reason *other* than 403 proves nothing about the scope —
     * a policy whose own embedded tests fail answers 400, a rate limit answers
     * 429 — so it reads as `read` with the answer Tailscale gave, never as a
     * write scope the operator does not have.
     */
    test("a validate that answers 400 is read, and says what answered", async () => {
      const s = stub((call) =>
        call.url.endsWith("/oauth/token")
          ? { status: 200, body: { access_token: "tskey-api-x" } }
          : call.url.endsWith("/acl/validate")
            ? { status: 400, body: { message: "test(s) failed" } }
            : call.url.endsWith("/acl")
              ? { status: 200 }
              : call.method === "POST"
                ? { status: 200, body: { id: "kProbe1" } }
                : { status: 200 },
      );
      const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
        fetch: s.fetch,
      });
      expect(check.policy_scope).toBe("read");
      expect(check.problem).toContain("could not prove policy_file write");
      expect(check.problem).toContain("HTTP 400");
      // The status is the whole finding: no response body is read (§8.3).
      expect(check.problem).not.toContain("test(s) failed");
    });

    /** A 429 is the same shape, and is never a green light. */
    test("a rate-limited validate is read, not write", async () => {
      const s = stub((call) =>
        call.url.endsWith("/oauth/token")
          ? { status: 200, body: { access_token: "tskey-api-x" } }
          : call.url.endsWith("/acl/validate")
            ? { status: 429 }
            : call.url.endsWith("/acl")
              ? { status: 200 }
              : call.method === "POST"
                ? { status: 200, body: { id: "kProbe1" } }
                : { status: 200 },
      );
      const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
        fetch: s.fetch,
      });
      expect(check.policy_scope).toBe("read");
      expect(check.problem).toContain("HTTP 429");
    });

    /** Both second scopes missing: both notes, in one sentence. */
    test("a client missing devices:core and policy_file says both", async () => {
      const s = stub((call) =>
        call.url.endsWith("/oauth/token")
          ? { status: 200, body: { access_token: "tskey-api-x" } }
          : call.url.endsWith("/devices") || call.url.includes("/acl")
            ? { status: 403, body: { message: "nope" } }
            : call.method === "POST"
              ? { status: 200, body: { id: "kProbe1" } }
              : { status: 200 },
      );
      const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
        fetch: s.fetch,
      });
      expect(check.ok).toBe(true);
      expect(check.problem).toContain("devices:core");
      expect(check.problem).toContain("policy_file");
    });
  });

  /**
   * The decision this check exists to record: `devices:core` is a second scope
   * on the same client, and a client that lacks it is *usable* — every fleet
   * created before hermetic asked for it is in exactly this state. So the
   * verdict stays green and the missing scope is a note.
   */
  test("no devices:core is a note, not a failure", async () => {
    const s = stub((call) =>
      call.url.endsWith("/oauth/token")
        ? { status: 200, body: { access_token: "tskey-api-x" } }
        : call.url.endsWith("/devices")
          ? { status: 403, body: { message: "calling actor does not have enough permissions" } }
          : call.method === "POST"
            ? { status: 200, body: { id: "kProbe1" } }
            : { status: 200 },
    );
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
      fetch: s.fetch,
    });
    expect(check.ok).toBe(true);
    expect(check.can_mint).toBe(true);
    expect(check.can_list_devices).toBe(false);
    expect(check.problem).toContain("devices:core");
    expect(check.problem).toContain("hermetic secrets push _fleet --tailscale-oauth");
  });

  /** A client that cannot mint is fatal, and never gets asked about devices. */
  test("a mint failure stays fatal and stops before the device read", async () => {
    const s = stub((call) =>
      call.url.endsWith("/oauth/token")
        ? { status: 200, body: { access_token: "tskey-api-x" } }
        : { status: 403, body: { message: "calling actor does not have enough permissions" } },
    );
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
      fetch: s.fetch,
    });
    expect(check.ok).toBe(false);
    expect(check.can_list_devices).toBe(false);
    expect(s.calls.some((c) => c.url.endsWith("/devices"))).toBe(false);
  });

  test("a secret that is not an OAuth client is rejected without a network call", async () => {
    const s = stub(() => ({ status: 200 }));
    const check = await verifyTailscaleOauthClient("tskey-auth-not-a-client", { fetch: s.fetch });
    expect(check.ok).toBe(false);
    expect(check.authenticated).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  test("bad credentials fail at the token exchange", async () => {
    const s = stub(() => ({ status: 401 }));
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-wrong", { fetch: s.fetch });
    expect(check.ok).toBe(false);
    expect(check.authenticated).toBe(false);
    expect(check.problem).toContain("401");
    // One call: it does not go on to try minting.
    expect(s.calls).toHaveLength(1);
  });

  /** The failure this whole check exists for: authenticated but cannot mint. */
  test("a 403 on mint points at the client's scope", async () => {
    const s = stub((call) =>
      call.url.endsWith("/oauth/token")
        ? { status: 200, body: { access_token: "tskey-api-x" } }
        : { status: 403, body: { message: "calling actor does not have enough permissions" } },
    );
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
      fetch: s.fetch,
    });
    expect(check.ok).toBe(false);
    expect(check.authenticated).toBe(true);
    expect(check.can_mint).toBe(false);
    expect(check.problem).toContain("HTTP 403: calling actor does not have enough permissions");
    expect(check.problem).toContain("auth_keys");
  });

  /** Tailscale answers a tag the client may not use with a 400 that names tags. */
  test("a 400 about tags points at the client's tag and the tagOwners entry", async () => {
    const s = stub((call) =>
      call.url.endsWith("/oauth/token")
        ? { status: 200, body: { access_token: "tskey-api-x" } }
        : {
            status: 400,
            body: { message: "requested tags [tag:hermetic] are invalid or not permitted" },
          },
    );
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
      fetch: s.fetch,
    });
    expect(check.ok).toBe(false);
    expect(check.problem).toContain("invalid or not permitted");
    expect(check.problem).toContain("tagOwners");
  });

  /**
   * The bug this guards: the probe once sent `hermetic preflight (revoked
   * immediately)` and every real tailnet answered `400 keys: description had
   * invalid characters`, which the old message reduced to `HTTP 400`.
   */
  test("the probe key's description uses only characters Tailscale accepts", async () => {
    const s = stub((call) =>
      call.url.endsWith("/oauth/token")
        ? { status: 200, body: { access_token: "tskey-api-x" } }
        : { status: 200, body: { id: "k1" } },
    );
    await verifyTailscaleOauthClient("tskey-client-kABC123-secret", { fetch: s.fetch });
    const mint = s.calls.find((c) => c.url.endsWith("/keys"));
    const body = JSON.parse(mint!.body!) as { description: string };
    expect(body.description).toMatch(/^[A-Za-z0-9 _-]{1,50}$/);
  });

  /** A key that could not be revoked still expires on its own; it is not a failure. */
  test("a failed revoke is reported but does not flip ok", async () => {
    const s = stub((call) =>
      call.url.endsWith("/oauth/token")
        ? { status: 200, body: { access_token: "tskey-api-x" } }
        : call.method === "POST"
          ? { status: 200, body: { id: "kProbe1" } }
          : { status: 500 },
    );
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
      fetch: s.fetch,
    });
    expect(check.ok).toBe(true);
    expect(check.revoked).toBe(false);
  });

  test("an unreachable API is a finding, not a throw", async () => {
    const check = await verifyTailscaleOauthClient("tskey-client-kABC123-secret", {
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.tailscale.com");
      },
    });
    expect(check.ok).toBe(false);
    expect(check.problem).toContain("api.tailscale.com");
  });

  /**
   * §8.3: the secret is an argument and never a field. A `problem` that echoed
   * it would put it straight into an operator's terminal and the server's log.
   */
  test("no result mentions the secret", async () => {
    const secret = "tskey-client-kABC123-supersecretvalue";
    const outcomes = [
      await verifyTailscaleOauthClient(secret, {
        fetch: async () => new Response(null, { status: 401 }),
      }),
      await verifyTailscaleOauthClient(secret, {
        fetch: async (url) =>
          url.endsWith("/oauth/token")
            ? Response.json({ access_token: "t" })
            : // Tailscale error bodies can echo the request that produced them.
              new Response(JSON.stringify({ message: `bad request: ${secret}` }), { status: 400 }),
      }),
    ];
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain("supersecretvalue");
    }
  });
});
