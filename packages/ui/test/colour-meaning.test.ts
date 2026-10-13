/**
 * Colour carries one meaning each (docs/ui-brief.md, "Colour meaning"): an
 * action that is recommended, an update that is available and a volume that
 * costs money with nothing reading it are `--warn`; the accent is brand and
 * activity only. These were each drawn in `--acc` once, which made "press
 * this" and "something is running" the same colour.
 *
 * The rendered half checks the class a recommended Lifecycle card carries; the
 * stylesheet half pins what that class and its neighbours paint, read off the
 * CSS text because happy-dom does no layout or cascade.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentView } from "../src/api/index.ts";
import { AgentDrawer } from "../src/components/AgentDrawer.tsx";
import { VOLUME_LANES } from "../src/logic/volume-logic.ts";
import { profilesState } from "./profiles-fixture.ts";

function sheet(name: string): string {
  const text = readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of the one top-level rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function declaration(body: string, property: string): string | null {
  return new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? null;
}

const drawer = sheet("drawer.css");
const shell = sheet("shell.css");

/** A ready agent one Hermes release behind, so Upgrade Hermes is the recommended card. */
function behindAgent(): AgentView {
  return {
    name: "fathom",
    display_status: "ready",
    status: "ready",
    size: "small",
    instance_type: "r8g.large",
    region: "us-west-2",
    provider: "bedrock",
    secrets_mode: "none",
    hermes_version: "1.1.0",
    volume_gib: 100,
    created_at: "2026-08-23T00:00:00Z",
    created_by: "evan",
  } as unknown as AgentView;
}

function lifecycle(a: AgentView): string {
  return renderToStaticMarkup(
    createElement(AgentDrawer, {
      agent: a,
      meta: null,
      latest: "1.2.0",
      tailnet: "acme.ts.net",
      profiles: profilesState(),
      runningOpId: null,
      onOp: () => {},
      onClose: () => {},
      confirmOpen: false,
      setConfirmOpen: () => {},
      tab: "lifecycle",
      onTab: () => {},
    }),
  );
}

describe("a recommended action is --warn, never the accent", () => {
  test("the recommended Lifecycle card carries the rec class and the Recommended tag", () => {
    const out = lifecycle(behindAgent());
    expect(out).toMatch(/<section class="dr-lc rec" aria-label="Upgrade Hermes">/);
    expect(out).toContain('<span class="dr-tag">Recommended</span>');
    // Lifecycle's nav sub-line names the same recommendation in the same colour.
    expect(out).toMatch(
      /<small id="agent-tab-lifecycle-sub" class="warn">● upgrade available<\/small>/,
    );
  });

  test("the rec border and the tag paint in --warn", () => {
    expect(declaration(ruleBody(drawer, ".dr-lc.rec"), "border-color")).toBe("var(--warn)");
    const tag = ruleBody(drawer, ".dr-tag");
    expect(declaration(tag, "border-color")).toBe("var(--warn)");
    expect(declaration(tag, "color")).toBe("var(--text-warn, var(--warn))");
    expect(declaration(ruleBody(drawer, '.dr-snav [role="tab"] small.warn'), "color")).toBe(
      "var(--text-warn, var(--warn))",
    );
  });
});

describe("a loose volume is --warn: it costs money and wants a decision", () => {
  test("the no-agent lane", () => {
    expect(VOLUME_LANES.find((l) => l.group === "no_agent")?.color).toBe("var(--warn)");
  });

  test("the Fleet tab suffix and the lens switch's price", () => {
    expect(declaration(ruleBody(shell, ".viewnav-loose"), "color")).toBe(
      "var(--text-warn, var(--warn))",
    );
    expect(declaration(ruleBody(shell, ".lens-switch em"), "color")).toBe(
      "var(--text-warn, var(--warn))",
    );
  });
});
