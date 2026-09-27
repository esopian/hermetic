/**
 * The env strip and the footer: status and identity only.
 *
 * Both strips used to carry prose ("actions here affect live agents", "engine:
 * local", "no open ports · no SSH keys", "polled 3s ago"). What is left is the
 * part an operator acts on — which fleet, account, region and tailnet, and a
 * coloured square per background read — so these pin that the facts are there
 * and the prose stays gone.
 */
import { cleanup, render, screen } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { Meta } from "../src/api/index.ts";
import { EnvStrip } from "../src/components/EnvStrip.tsx";
import { Footer } from "../src/components/Footer.tsx";
import { withNav } from "./nav.tsx";

afterEach(() => cleanup());

function meta(fixture: boolean): Meta {
  return {
    initialized: true,
    home: "/tmp/hermetic-home",
    header: "▸ main · acme · 123456789012 · us-west-2",
    config: {
      name: "main",
      fleet_id: "m4in0abc",
      account_id: "123456789012",
      account_alias: "acme",
      org_id: null,
      profile: "acme-dev",
      region: "us-west-2",
      stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic/abc",
      tailnet: "acme.ts.net",
      tailscale_oauth_client_id: "kAbC1",
      frozen_at: "2026-09-01T00:00:00.000Z",
      frozen_by: "evan",
      schema_version: 1,
    },
    fleet: { id: "m4in0abc", alias: "main", default: "m4in0abc", directory_region: "us-east-1" },
    fixture,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    tailnet: "acme.ts.net",
    last_teardown: null,
  } as unknown as Meta;
}

function strip(): HTMLElement {
  return document.querySelector(".envstrip") as HTMLElement;
}

describe("env strip", () => {
  test("names fleet, account, region and tailnet, and nothing else", () => {
    render(withNav(<EnvStrip meta={meta(false)} connected />));
    const text = strip().textContent ?? "";
    for (const fact of ["main", "123456789012", "us-west-2", "acme.ts.net", "connected"]) {
      expect(text).toContain(fact);
    }
    expect(text).not.toContain("actions here affect");
    expect(text).not.toContain("FIXTURE");
    // The fleet name is the switcher's trigger, and says it opens something.
    const button = screen.getByRole("button", { name: /switch fleet/i });
    expect(button.textContent).toContain("main");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("fixture mode keeps a FIXTURE marker, since grey alone reads as a theme", () => {
    render(withNav(<EnvStrip meta={meta(true)} connected={false} />));
    const text = strip().textContent ?? "";
    expect(text).toContain("FIXTURE");
    expect(text).toContain("reconnecting");
    expect(text).not.toContain("in-memory fleet, no AWS");
  });

  test("with the switcher off the fleet is still named, but is not a control", () => {
    render(withNav(<EnvStrip meta={meta(false)} connected switcher={false} />));
    expect(strip().textContent).toContain("main");
    expect(screen.queryByRole("button", { name: /switch fleet/i })).toBeNull();
  });
});

describe("footer", () => {
  test("two squares and their words, no ages and no prose", () => {
    const now = new Date().toISOString();
    render(
      <Footer lastPollAt={now} connected everConnected volumesReadAt={now} onShortcuts={() => {}} />,
    );
    const footer = document.querySelector(".footer") as HTMLElement;
    const text = footer.textContent ?? "";
    expect(text).toContain("fleet");
    expect(text).toContain("volumes");
    for (const gone of ["polled", "ago", "engine: local", "IAM-only", "no open ports"]) {
      expect(text).not.toContain(gone);
    }
    const ticks = [...footer.querySelectorAll<HTMLElement>(".foot-tick")];
    expect(ticks.map((t) => t.dataset.tick)).toEqual(["ok", "ok"]);
    // The detail moved to the tooltip rather than disappearing.
    expect(ticks[0]?.title).toContain("last scan");
    expect(ticks[1]?.title).toContain("last read");
  });

  test("a failed read is bad, nothing read yet is pending", () => {
    render(
      <Footer
        lastPollAt={null}
        connected={false}
        scanError="Scan throttled"
        volumesError="DescribeVolumes denied"
      />,
    );
    const ticks = [...document.querySelectorAll<HTMLElement>(".foot-tick")];
    expect(ticks.map((t) => t.dataset.tick)).toEqual(["bad", "bad"]);
    expect(ticks[0]?.title).toContain("Scan throttled");
    cleanup();

    render(<Footer lastPollAt={null} connected={false} />);
    const pending = [...document.querySelectorAll<HTMLElement>(".foot-tick")];
    expect(pending.map((t) => t.dataset.tick)).toEqual(["pending", "pending"]);
  });
});
