/**
 * The two things a head needs to reach an agent's desktop (§7.3):
 * the URLs, and the list of browser identities `agents.list`/`agents.get`
 * carry so a head does not have to derive one for itself.
 *
 * `packages/ui/src/logic/format.ts` restates both URL rules by hand — the UI may not
 * import core, per the boundaries table — and `tests/naming-mirror.test.ts` is
 * what holds the two spellings together. These tests are the core side: what
 * the rule *is*, before anyone mirrors it.
 */
import { describe, expect, test } from "bun:test";
import { agentDesktopClientUrl, agentDesktopUrl } from "../src/schema/index.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { testHermetic } from "./helpers.ts";

const TAILNET = "hermetic.ts.net";
const AGENT = { name: "atlas" };

describe("agentDesktopUrl", () => {
  test("the default browser is `/vnc/`, trailing slash and all", () => {
    expect(agentDesktopUrl(AGENT, TAILNET, "fxtr0001-atlas")).toBe(
      "https://fxtr0001-atlas.hermetic.ts.net/vnc/",
    );
  });

  /**
   * The slash is the reason this function exists rather than a template string
   * at each call site: `/vnc` without it makes the client's relative links —
   * and any relative redirect — resolve at the site root, which is the Hermes
   * dashboard, so the operator lands somewhere else entirely.
   */
  test("the trailing slash is not optional", () => {
    expect(agentDesktopUrl(AGENT, TAILNET)).toEndWith("/vnc/");
  });

  /** The name the node actually holds wins, as it does for the dashboard. */
  test("a node wearing a suffixed name is addressed by that name", () => {
    expect(
      agentDesktopUrl({ name: "atlas", tailscale_dns_name: "atlas-2.hermetic.ts.net" }, TAILNET),
    ).toBe("https://atlas-2.hermetic.ts.net/vnc/");
  });

  /** A second identity nests under the first: one data change, no redesign. */
  test("a named browser is published one level down", () => {
    expect(agentDesktopUrl(AGENT, TAILNET, null, "scratch")).toBe(
      "https://atlas.hermetic.ts.net/vnc/scratch/",
    );
  });
});

describe("agentDesktopClientUrl", () => {
  /**
   * The long form works on an agent that has not been re-applied and has no
   * `index.html`, and its `path=` is what stops noVNC dialling the site root.
   */
  test("names the client page and the websocket path it would otherwise guess", () => {
    expect(agentDesktopClientUrl(AGENT, TAILNET)).toBe(
      "https://atlas.hermetic.ts.net/vnc/vnc.html" +
        "?path=vnc/websockify&autoconnect=true&resize=scale&reconnect=true",
    );
  });

  /** The socket path is the browser's own Serve path, never a constant. */
  test("a named browser carries its own websocket path", () => {
    expect(agentDesktopClientUrl(AGENT, TAILNET, null, "scratch")).toContain(
      "/vnc/scratch/vnc.html?path=vnc/scratch/websockify",
    );
  });

  /** Root-relative page, root-less query: noVNC appends `path` to the origin. */
  test("the websocket path has no leading slash", () => {
    expect(agentDesktopClientUrl(AGENT, TAILNET)).not.toContain("path=/vnc");
  });
});

describe("AgentView.browsers", () => {
  function seeded() {
    const backend = seedFixtureFleet(new MemoryBackend());
    return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
  }

  test("every agent lists exactly one identity, named default", async () => {
    const { hermetic } = seeded();
    const atlas = await hermetic.agents.get("atlas");
    expect(atlas.browsers).toEqual([{ name: "default", serve_path: "/vnc" }]);
  });

  /** Derived, not stored: every view of the fleet carries it, not just `get`. */
  test("`agents.list` carries it too", async () => {
    const { hermetic } = seeded();
    const rows = await hermetic.agents.list();
    expect(rows.every((r) => Array.isArray(r.browsers))).toBe(true);
  });
});
