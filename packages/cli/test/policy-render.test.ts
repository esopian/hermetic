/**
 * `hermetic policy`'s text, rendered directly rather than through a spawned
 * CLI: the two shapes that matter most are the ones the fixture fleet cannot
 * be in — an OAuth client that cannot read the policy at all, and one whose
 * write scope could not be proved.
 */
import { describe, expect, test } from "bun:test";
import type { PolicyReport } from "@hermetic/core";
import { renderPolicy } from "../src/commands/policy.ts";

function report(overrides: Partial<PolicyReport> = {}): PolicyReport {
  return {
    scope: "write",
    scope_reason: null,
    managed: "current",
    blocks: [
      { key: "tagOwners", state: "current", reason: null },
      { key: "ssh", state: "current", reason: null },
      { key: "acls", state: "current", reason: null },
    ],
    etag: '"policy-1"',
    diff: null,
    ...overrides,
  };
}

describe("renderPolicy", () => {
  /**
   * The bug this is about was not a wrong answer, it was the same answer four
   * times: the whole "create a client with the policy_file scope…" sentence on
   * every block line. One sentence, on the line it is about.
   */
  test("an unreadable policy explains itself once", () => {
    const text = renderPolicy(
      report({
        scope: "none",
        managed: "unavailable",
        blocks: [
          { key: "tagOwners", state: "skipped", reason: "policy unreadable" },
          { key: "ssh", state: "skipped", reason: "policy unreadable" },
          { key: "acls", state: "skipped", reason: "policy unreadable" },
        ],
        etag: null,
      }),
    );
    expect(text).toContain("scope          none — the OAuth client cannot see the tailnet policy file");
    expect(text).toContain("managed        unknown — the policy file could not be read");
    expect(text).toContain("  tagOwners    skipped  policy unreadable");
    expect(text.match(/policy unreadable/g)?.length).toBe(3);
    // The long sentence is not repeated down the table at all.
    expect(text).not.toContain("secrets push _fleet --tailscale-oauth");
    // And no empty diff header on a report with nothing to show.
    expect(text.trimEnd().endsWith("policy unreadable")).toBe(true);
  });

  /** A scope that could not be proved says which answer stopped it. */
  test("an unproven write scope prints the reason under the scope", () => {
    const text = renderPolicy(
      report({
        scope: "read",
        scope_reason:
          "could not prove policy_file write: validate answered HTTP 400; treating the client as read-only",
      }),
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain("read only (policy_file:read)");
    expect(lines[1]).toContain("could not prove policy_file write: validate answered HTTP 400");
    expect(lines[2]).toContain("managed");
  });

  /** Nothing extra when there is nothing extra to say. */
  test("a current policy is three lines and its blocks", () => {
    const lines = renderPolicy(report()).split("\n");
    expect(lines.length).toBe(6);
    expect(lines[0]).toContain("read + write (policy_file)");
  });
});
