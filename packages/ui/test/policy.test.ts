/**
 * §4.7's tailnet policy, as the Settings card and the plan drawer render it.
 * Static markup only — effects do not run, so nothing here fetches: this is the
 * first paint of each `PolicyReport` state, which is exactly where the "nobody
 * has looked" cases are easy to render as "nothing to do".
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PolicyReport } from "../src/api/index.ts";
import { PolicyPanel, managedLine, scopeLine } from "../src/components/settings/PolicySection.tsx";
import { applyGate } from "../src/components/PolicyDrawer.tsx";

const DIFF = [
  "--- policy",
  "+++ policy",
  "@@",
  "+    // hermetic:managed",
  '+    {"action": "accept", "src": ["autogroup:member"], "dst": ["tag:hermetic:443"]},',
].join("\n");

function report(over: Partial<PolicyReport> = {}): PolicyReport {
  return {
    scope: "write",
    managed: "current",
    blocks: [
      { key: "tagOwners", state: "skipped", reason: "you already own tag:hermetic" },
      { key: "ssh", state: "current", reason: null },
      { key: "acls", state: "current", reason: null },
    ],
    etag: '"abc123"',
    diff: null,
    ...over,
  } as PolicyReport;
}

function panel(over: { report?: PolicyReport | null; error?: string | null } = {}): string {
  return renderToStaticMarkup(
    createElement(PolicyPanel, {
      report: over.report === undefined ? report() : over.report,
      error: over.error ?? null,
      onPreview: () => {},
    }),
  );
}

describe("PolicyPanel", () => {
  test("before the first read it is a skeleton, never an empty verdict", () => {
    const out = panel({ report: null });
    expect(out).toContain("reading the tailnet policy…");
    expect(out).not.toContain("current —");
    expect(out).not.toContain("Preview change");
  });

  test("a failed read says so instead of showing a report", () => {
    const out = panel({ report: null, error: "TAILSCALE: HTTP 500" });
    expect(out).toContain("TAILSCALE: HTTP 500");
    expect(out).not.toContain("reading the tailnet policy…");
  });

  test("current: every block is named, and there is nothing to preview", () => {
    const out = panel();
    expect(out).toContain("the policy says what hermetic would say");
    expect(out).toContain("tagOwners");
    expect(out).toContain("you already own tag:hermetic");
    expect(out).toContain("&quot;abc123&quot;");
    // The button exists — this card is where the drawer lives — but a policy
    // that already agrees has no change to show.
    expect(out).toContain("Preview change");
    expect(out).toContain('disabled=""');
  });

  test("absent: the blocks are missing, and the preview opens", () => {
    const out = panel({
      report: report({
        managed: "absent",
        blocks: [
          { key: "tagOwners", state: "skipped", reason: "you already own tag:hermetic" },
          { key: "ssh", state: "absent", reason: null },
          { key: "acls", state: "absent", reason: null },
        ],
        diff: DIFF,
      }),
    });
    expect(out).toContain("hermetic&#x27;s blocks are not in the policy");
    expect(out).not.toContain('disabled=""');
  });

  test("drifted: the preview opens, and the file is not called clean", () => {
    const out = panel({
      report: report({
        managed: "drifted",
        blocks: [
          { key: "tagOwners", state: "skipped", reason: "you already own tag:hermetic" },
          { key: "ssh", state: "current", reason: null },
          { key: "acls", state: "drifted", reason: null },
        ],
        diff: DIFF,
      }),
    });
    expect(out).toContain("differs from what hermetic would write");
    expect(out).not.toContain('disabled=""');
  });

  test("unavailable: named as unread, not as clean, and it names the missing scope", () => {
    const out = panel({
      report: report({
        scope: "none",
        managed: "unavailable",
        blocks: [
          { key: "tagOwners", state: "skipped", reason: "no policy file scope" },
          { key: "ssh", state: "skipped", reason: "no policy file scope" },
          { key: "acls", state: "skipped", reason: "no policy file scope" },
        ],
        etag: null,
        diff: null,
      }),
    });
    expect(out).toContain("nobody has looked");
    expect(out).toContain("policy_file:read");
    expect(out).toContain("not a clean bill");
    // Nothing to preview: there is no reading to compare against.
    expect(out).toContain('disabled=""');
  });

  test("a client that cannot write carries the rotation command", () => {
    const out = panel({ report: report({ scope: "read" }) });
    expect(out).toContain("hermetic secrets push _fleet --tailscale-oauth");
    expect(out).toContain("Policy File → Read, Write");
    // A `write` client is not told how to rotate one it already has.
    expect(panel()).not.toContain("hermetic secrets push _fleet --tailscale-oauth");
  });
});

describe("scopeLine / managedLine", () => {
  test("every scope has a line of its own", () => {
    const lines = (["write", "read", "none"] as const).map(scopeLine);
    expect(new Set(lines).size).toBe(3);
    expect(scopeLine("write")).toContain("read and write");
    expect(scopeLine("read")).toContain("not write");
    expect(scopeLine("none")).toContain("without the Policy File scope");
  });

  test("only `current` is green — an unread policy is never a clean bill", () => {
    expect(managedLine("current").color).toBe("var(--ok)");
    for (const state of ["absent", "drifted", "unavailable"] as const) {
      expect(managedLine(state).color).toBe("var(--warn)");
    }
  });
});

describe("applyGate", () => {
  const plan = { kind: "policy", target: "tailnet", steps: [{}, {}], warnings: [] } as never;

  test("a write client with a diff may apply", () => {
    const gate = applyGate({ scope: "write", plan, hasDiff: true });
    expect(gate.allowed).toBe(true);
  });

  test("read and none are refused, with the rotation hint as the reason", () => {
    for (const scope of ["read", "none"] as const) {
      const gate = applyGate({ scope, plan, hasDiff: true });
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain("hermetic secrets push _fleet --tailscale-oauth");
      expect(gate.reason).toContain("Policy File → Read, Write");
    }
  });

  test("nothing to write is refused too, and says why", () => {
    const gate = applyGate({ scope: "write", plan, hasDiff: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("already says what hermetic would say");
  });

  test("no plan yet is refused rather than optimistic", () => {
    expect(applyGate({ scope: "write", plan: null, hasDiff: true }).allowed).toBe(false);
  });
});
