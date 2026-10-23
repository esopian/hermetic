import { describe, expect, test } from "bun:test";
import { renderPlan } from "../src/confirm.ts";

describe("renderPlan", () => {
  test("prints each config change: one line per agent, then its paths, fields and note", () => {
    const text = renderPlan({
      kind: "rollout",
      target: "fxtr0001",
      options: {},
      steps: [],
      warnings: [],
      config_changes: [
        {
          name: "atlas",
          from: "aaaa",
          to: "bbbb",
          deferred: null,
          pending: null,
          files: ["/etc/hermes/a", "/etc/hermes/b"],
          manifest: ["commands"],
          note: null,
        },
        {
          name: "corvid",
          from: null,
          to: "cccc",
          deferred: "no applied config reported",
          pending: null,
          files: null,
          manifest: [],
          note: "no applied config reported",
        },
        {
          name: "ember",
          from: "dddd",
          to: "dddd",
          deferred: "already current",
          pending: null,
          files: [],
          manifest: [],
          note: null,
        },
      ],
    });
    expect(text).toContain(
      [
        "  config changes:",
        "    atlas: aaaa → bbbb",
        "      /etc/hermes/a",
        "      /etc/hermes/b",
        "      manifest: commands",
        "    corvid: deferred — no applied config reported",
        "      (no applied config reported)",
      ].join("\n"),
    );
    // Already current: kept in the data, left out of what is printed.
    expect(text).not.toContain("ember");
  });
});
