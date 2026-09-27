/**
 * The one helper both scope probes go through (§4.7).
 *
 * It exists because they disagreed: `preflight.ts` said `write` only on a 200
 * from `/acl/validate`, `policy.ts` said `write` on *any* failure but the exact
 * 403 message — so on one tailnet the wizard and `hermetic policy` could give
 * opposite answers about the same OAuth client. The rule below is the whole
 * fix, and the tests are the truth table.
 */
import { describe, expect, test } from "bun:test";
import { probePolicyScope } from "../src/fleet/policy-scope.ts";

const REFUSED = { ok: false as const, forbidden: true, message: "403" };

describe("probePolicyScope", () => {
  test("a refused read is `none`, and validate is never asked", async () => {
    let asked = 0;
    const result = await probePolicyScope({
      read: async () => null,
      validate: async () => {
        asked += 1;
        return REFUSED;
      },
    });
    expect(result).toEqual({ scope: "none", reason: null });
    expect(asked).toBe(0);
  });

  test("read plus a 403 from validate is `read`, with nothing to explain", async () => {
    const result = await probePolicyScope({
      read: async () => "{}",
      validate: async () => REFUSED,
    });
    expect(result).toEqual({ scope: "read", reason: null });
  });

  test("read plus a 200 from validate is `write`", async () => {
    const result = await probePolicyScope({
      read: async () => "{}",
      validate: async () => ({ ok: true }),
    });
    expect(result).toEqual({ scope: "write", reason: null });
  });

  /**
   * The case the two callers used to answer differently. A 400 is the
   * operator's own embedded ACL tests failing against the policy the tailnet
   * already has — information about the policy, not about the scope. Unproven
   * is reported as `read`: the cost of under-claiming is a note, and the cost
   * of over-claiming is an operator told to run an `apply` that will be refused.
   */
  test.each([
    ["HTTP 400", "400"],
    ["HTTP 429", "429"],
    ["HTTP 503", "503"],
  ])("a validate that answers %s is `read` with a reason", async (message) => {
    const result = await probePolicyScope({
      read: async () => "{}",
      validate: async () => ({ ok: false, forbidden: false, message }),
    });
    expect(result.scope).toBe("read");
    expect(result.reason).toBe(
      `could not prove policy_file write: validate answered ${message}; treating the client as read-only`,
    );
  });

  /** A validate that never answered is the same kind of unproven. */
  test("a validate that throws is `read`, not `write`", async () => {
    const result = await probePolicyScope({
      read: async () => "{}",
      validate: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(result.scope).toBe("read");
    expect(result.reason).toContain("could not be reached");
    // Never the thrown message: it can carry whatever was in flight (§8.3).
    expect(result.reason).not.toContain("socket hang up");
  });

  /** The candidate is the document that came back, byte for byte. */
  test("validates exactly what read returned", async () => {
    const seen: string[] = [];
    await probePolicyScope({
      read: async () => '{ "acls": [] }',
      validate: async (text) => {
        seen.push(text);
        return { ok: true };
      },
    });
    expect(seen).toEqual(['{ "acls": [] }']);
  });
});
