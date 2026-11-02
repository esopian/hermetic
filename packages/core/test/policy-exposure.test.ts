/**
 * §5.2: what the operator's own policy lets an agent box do. Each case is a
 * small policy written the way an operator would, and the assertion is which
 * rule (by key and index) is reported — never what the rule says.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFoundation } from "../src/backend/memory.ts";
import { policyExposure, policyExposureOf } from "../src/fleet/policy-exposure.ts";
import { hermeticBlocks } from "../src/fleet/policy.ts";
import { applyManagedBlocks } from "../src/fleet/hujson.ts";
import { testHermetic } from "./helpers.ts";

/** Which rules were reported, as `key[index]:severity`. */
function found(policy: unknown): string[] {
  return policyExposure(policy).map((e) => `${e.rule}[${e.index ?? "-"}]:${e.severity}`);
}

/** hermetic's own entries, which must never be reported against themselves. */
const MANAGED = {
  tagOwners: { "tag:hermetic": ["autogroup:admin"] },
  ssh: [
    {
      action: "accept",
      src: ["autogroup:member"],
      dst: ["tag:hermetic"],
      users: ["autogroup:nonroot", "root"],
    },
  ],
  acls: [
    {
      action: "accept",
      src: ["autogroup:member"],
      dst: ["tag:hermetic:22", "tag:hermetic:443", "tag:hermetic:7434"],
    },
  ],
};

describe("policyExposure", () => {
  test("a policy of hermetic's own entries is clean", () => {
    expect(found(MANAGED)).toEqual([]);
  });

  test("hermetic's managed blocks, spliced into a real document, are clean", () => {
    const text = applyManagedBlocks(
      '{\n  "ssh": [\n  ],\n  "acls": [\n  ],\n}\n',
      hermeticBlocks(),
    ).text;
    expect(policyExposureOf(text)).toEqual([]);
  });

  test("no acls and no grants is Tailscale's allow-all default", () => {
    expect(found({ groups: {}, tagOwners: MANAGED.tagOwners })).toEqual(["acls[-]:high"]);
    expect(policyExposure({})[0]!.summary).toContain("allow-all");
  });

  test("an empty acls array is deny-all, not allow-all", () => {
    expect(found({ acls: [] })).toEqual([]);
  });

  test("allow-all written out in acls", () => {
    expect(found({ acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }] })).toEqual(["acls[0]:high"]);
  });

  test("allow-all written out in grants", () => {
    expect(found({ grants: [{ src: ["*"], dst: ["*"], ip: ["*"] }] })).toEqual(["grants[0]:high"]);
  });

  test("autogroup:tagged includes the box", () => {
    const policy = {
      ...MANAGED,
      grants: [{ src: ["autogroup:tagged"], dst: ["tag:monitoring"], ip: ["tcp:9090"] }],
    };
    expect(found(policy)).toEqual(["grants[0]:high"]);
    expect(policyExposure(policy)[0]!.summary).toContain("autogroup:tagged");
  });

  test("autogroup:member and other tags do not", () => {
    expect(
      found({
        acls: [
          { action: "accept", src: ["autogroup:member"], dst: ["*:*"] },
          { action: "accept", src: ["tag:build"], dst: ["*:*"] },
          { action: "accept", src: ["alice@example.com"], dst: ["*:*"] },
        ],
      }),
    ).toEqual([]);
  });

  /**
   * hermetic never lets one box reach another, and every box's 443 is an
   * unauthenticated Hermes dashboard, so box-to-box reach is lateral movement
   * inside the fleet and reported as such.
   */
  test("tag:hermetic to tag:hermetic is reported as reach between agent boxes", () => {
    const policy = { acls: [{ action: "accept", src: ["*"], dst: ["tag:hermetic:443"] }] };
    expect(found(policy)).toEqual(["acls[0]:high"]);
    expect(policyExposure(policy)[0]?.summary).toContain("other agent boxes");
  });

  test("autogroup:self as the only destination names nothing for a box", () => {
    expect(
      found({ acls: [{ action: "accept", src: ["tag:hermetic"], dst: ["autogroup:self:*"] }] }),
    ).toEqual([]);
  });

  test("a hosts alias covering the tailnet range includes every box", () => {
    const policy = {
      hosts: { tailnet: "100.64.0.0/10", office: "192.168.10.0/24" },
      acls: [
        { action: "accept", src: ["office"], dst: ["*:*"] },
        { action: "accept", src: ["tailnet"], dst: ["office:*"] },
      ],
    };
    expect(found(policy)).toEqual(["acls[1]:high"]);
    expect(policyExposure(policy)[0]!.summary).toContain("a host alias");
  });

  test("an address that may be a box is info, not high", () => {
    const policy = {
      hosts: { laptop: "100.101.102.103" },
      acls: [{ action: "accept", src: ["laptop"], dst: ["*:*"] }],
    };
    expect(found(policy)).toEqual(["acls[0]:info"]);
    expect(policyExposure(policy)[0]!.summary).toContain("may belong to agent boxes");
  });

  test("IPv6: the tailnet ULA prefix and ::/0 include the box", () => {
    expect(found({ acls: [{ action: "accept", src: ["::/0"], dst: ["*:*"] }] })).toEqual([
      "acls[0]:high",
    ]);
    expect(found({ acls: [{ action: "accept", src: ["fd7a:115c:a1e0::/48"], dst: ["*:*"] }] })).toEqual(
      ["acls[0]:high"],
    );
  });

  test("an ipset resolves its hosts and ranges, and a remove hedges it", () => {
    const base = { hosts: { everything: "0.0.0.0/0" } };
    expect(
      found({
        ...base,
        ipsets: { "ipset:wide": ["add everything"] },
        grants: [{ src: ["ipset:wide"], dst: ["tag:db"], ip: ["*"] }],
      }),
    ).toEqual(["grants[0]:high"]);
    expect(
      found({
        ...base,
        ipsets: { "ipset:wide": ["add everything", "remove 100.64.0.0/10"] },
        grants: [{ src: ["ipset:wide"], dst: ["tag:db"], ip: ["*"] }],
      }),
    ).toEqual(["grants[0]:info"]);
  });

  test("a group matches only through what it resolves to", () => {
    expect(
      found({
        groups: { "group:eng": ["alice@example.com", "bob@example.com"] },
        acls: [{ action: "accept", src: ["group:eng"], dst: ["*:*"] }],
      }),
    ).toEqual([]);
    // Tailscale would refuse this, but a hand-built policy cannot hide one.
    expect(
      found({
        groups: { "group:odd": ["group:inner"], "group:inner": ["tag:hermetic"] },
        acls: [{ action: "accept", src: ["group:odd"], dst: ["*:*"] }],
      }),
    ).toEqual(["acls[0]:high"]);
  });

  test("a group cycle terminates", () => {
    expect(
      found({
        groups: { "group:a": ["group:b"], "group:b": ["group:a"] },
        acls: [{ action: "accept", src: ["group:a"], dst: ["*:*"] }],
      }),
    ).toEqual([]);
  });

  test("an ssh rule whose src includes the box", () => {
    const policy = {
      ...MANAGED,
      ssh: [
        ...MANAGED.ssh,
        { action: "accept", src: ["autogroup:tagged"], dst: ["tag:build"], users: ["root"] },
      ],
    };
    expect(found(policy)).toEqual(["ssh[1]:high"]);
  });

  test("autoApprovers covering the box, for routes and for exit nodes", () => {
    expect(
      found({
        ...MANAGED,
        autoApprovers: {
          routes: { "10.0.0.0/8": ["group:ops"], "192.168.0.0/16": ["tag:hermetic"] },
          exitNode: ["autogroup:tagged"],
        },
      }),
    ).toEqual(["autoApprovers.routes[1]:high", "autoApprovers.exitNode[-]:high"]);
  });

  test("funnel on the box is info", () => {
    expect(
      found({
        ...MANAGED,
        nodeAttrs: [
          { target: ["tag:hermetic"], attr: ["mullvad"] },
          { target: ["*"], attr: ["funnel"] },
        ],
      }),
    ).toEqual(["nodeAttrs[1]:info"]);
  });

  test("a grant via tag:hermetic is info", () => {
    expect(
      found({
        ...MANAGED,
        grants: [
          { src: ["autogroup:member"], dst: ["autogroup:internet"], ip: ["*"], via: ["tag:hermetic"] },
        ],
      }),
    ).toEqual(["grants[0]:info"]);
  });

  /**
   * §5.2 tells operators to add this grant so only capable callers may use the
   * files routes. It grants *to* the box, not from it.
   */
  test("the files require_cap grant is not reported", () => {
    expect(
      found({
        ...MANAGED,
        grants: [
          {
            src: ["autogroup:member"],
            dst: ["tag:hermetic"],
            app: { "hermetic.dev/cap/files": [{}] },
          },
        ],
      }),
    ).toEqual([]);
  });

  test("an app-only grant out of the box says capabilities, not reach", () => {
    const [only] = policyExposure({
      ...MANAGED,
      grants: [{ src: ["tag:hermetic"], dst: ["tag:db"], app: { "example.com/cap/sql": [{}] } }],
    });
    expect(only!.summary).toContain("application capabilities");
  });

  test("no summary quotes the document", () => {
    const policy = {
      groups: { "group:people": ["alice@example.com", "tag:hermetic"] },
      hosts: { "alice-laptop": "100.64.0.0/10" },
      ipsets: { "ipset:secret-project": ["alice-laptop"] },
      acls: [
        { action: "accept", src: ["group:people"], dst: ["alice-laptop:*"] },
        { action: "accept", src: ["ipset:secret-project"], dst: ["10.9.8.0/24:*"] },
      ],
      ssh: [{ action: "accept", src: ["alice-laptop"], dst: ["tag:build"], users: ["alice"] }],
      autoApprovers: { routes: { "10.9.8.0/24": ["group:people"] } },
    };
    const findings = policyExposure(policy);
    expect(findings.length).toBe(4);
    for (const f of findings) {
      for (const secret of ["alice", "example.com", "people", "secret-project", "10.9.8", "100.64"]) {
        expect(f.summary).not.toContain(secret);
      }
    }
  });
});

describe("policyExposureOf", () => {
  test("text that does not parse is null, not clean", () => {
    expect(policyExposureOf("{ not hujson")).toBeNull();
    expect(policyExposureOf("[]")).toBeNull();
  });

  test("reads HuJSON with comments and trailing commas", () => {
    expect(
      policyExposureOf(`{
        // everything, everywhere
        "acls": [ { "action": "accept", "src": ["*"], "dst": ["*:*"] }, ],
      }`),
    ).toEqual([
      {
        rule: "acls",
        index: 0,
        severity: "high",
        summary: "acls[0] lets agent boxes reach nodes other than tag:hermetic (matched through `*`)",
      },
    ]);
  });
});

describe("policy.status carries the exposure", () => {
  function fleet(mutate: (backend: MemoryBackend) => void = () => {}) {
    const backend = seedFixtureFoundation(new MemoryBackend());
    mutate(backend);
    return testHermetic({ backend, config: FIXTURE_CONFIG });
  }

  test("the fixture policy's metrics grant is the one finding", async () => {
    const report = await fleet().policy.status();
    expect(report.exposure).toEqual([
      {
        rule: "grants",
        index: 0,
        severity: "high",
        summary:
          "grants[0] lets agent boxes reach nodes other than tag:hermetic (matched through autogroup:tagged)",
      },
    ]);
  });

  test("an unreadable policy has no exposure verdict", async () => {
    const report = await fleet((b) => {
      b.policyScope = "none";
    }).policy.status();
    expect(report.exposure).toBeNull();
  });
});
