/**
 * The Desktop tab, driven.
 *
 * `agent-drawer.test.ts` renders the drawer statically, which can see that the
 * cold panel offers to connect but not that it *stays* cold — and the whole
 * point of the tab is what it does not do on its own. Everything here is about
 * the lifetime of one viewer: there is none until Connect, there is exactly
 * one after it, `Reconnect` replaces it rather than adding to it, and leaving
 * the tab takes it away. Each of those is a live RFB stream over the tailnet,
 * so a second one is not a cosmetic bug.
 */
import { cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { AgentTab } from "../src/nav/agent-nav.ts";
import type { AgentView, Meta } from "../src/api/index.ts";
import { AgentDesktop, DESKTOP_VIEW_TAG } from "../src/components/AgentDesktop.tsx";
import { AgentDrawer } from "../src/components/AgentDrawer.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { profilesState } from "./profiles-fixture.ts";

let server: FakeServer | null = null;

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

const DEFAULT_BROWSERS = [{ name: "default", serve_path: "/vnc" }];

/**
 * A stand-in for the devkit's `<electrobun-webview>`, which only exists behind
 * `views://`. It records, in order, every `src` it is given and every
 * `setNavigationRules` call, and — like the real element — ignores the rules
 * until it has a `webviewId`. `readyOnConnect` decides whether that id arrives
 * the moment the element connects or only when a test hands it over.
 */
const devkit = {
  readyOnConnect: true,
  log: [] as Array<["src", string | null] | ["rules", string[]]>,
};

class FakeDevkitWebview extends HTMLElement {
  static observedAttributes = ["src"];
  webviewId: number | null = null;
  connectedCallback(): void {
    if (devkit.readyOnConnect) this.webviewId = 1;
  }
  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === "src") devkit.log.push(["src", value]);
  }
  setNavigationRules(rules: string[]): void {
    if (this.webviewId !== null) devkit.log.push(["rules", rules]);
  }
}
if (!customElements.get(DESKTOP_VIEW_TAG)) customElements.define(DESKTOP_VIEW_TAG, FakeDevkitWebview);

afterEach(() => {
  devkit.readyOnConnect = true;
  devkit.log = [];
});

/** The mounted viewers, and what each was created with. */
function frames(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(DESKTOP_VIEW_TAG));
}

function panel(over: Partial<Parameters<typeof AgentDesktop>[0]> = {}) {
  return (
    <AgentDesktop
      name="lumen"
      tailnet="acme.ts.net"
      dnsName={null}
      fleetId={null}
      browsers={DEFAULT_BROWSERS}
      status="ready"
      {...over}
    />
  );
}

describe("AgentDesktop · one stream, and only when asked", () => {
  test("nothing streams until Connect is pressed", async () => {
    const user = userEvent.setup();
    render(panel());
    expect(frames()).toHaveLength(0);
    expect(screen.getByText(/not connected/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    const [frame] = frames();
    expect(frames()).toHaveLength(1);
    // The long client URL, not `/vnc/`: it is the one that connects on an agent
    // whose manifest has not been re-applied since `index.html` existed.
    expect(frame?.getAttribute("src")).toContain(
      "https://lumen.acme.ts.net/vnc/vnc.html?path=vnc/websockify",
    );
    expect(screen.getByText(/This is the browser the agent is using/)).toBeTruthy();
  });

  test("the viewer is a sandboxed webview held to the box's origin, never an iframe", async () => {
    const user = userEvent.setup();
    render(panel());
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    // An iframe would share the app webview, whose every frame gets the RPC
    // bridge: a box's page could then call `secrets.push`.
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    const [view] = frames();
    expect(view?.hasAttribute("sandbox")).toBe(true);
    expect(JSON.parse(view?.getAttribute("navigation-rules") ?? "null")).toEqual([
      "^*",
      "https://lumen.acme.ts.net/*",
    ]);
  });

  test("the rules are set on the view before it is pointed at the box", async () => {
    // The devkit drops rules passed at creation, so the attribute above is not
    // enough: `setNavigationRules` has to reach the view, and before `src` does.
    const user = userEvent.setup();
    render(panel());
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    expect(devkit.log[0]).toEqual(["src", "about:blank"]);
    expect(devkit.log.slice(1)).toEqual([
      ["rules", ["^*", "https://lumen.acme.ts.net/*"]],
      ["src", expect.stringContaining("https://lumen.acme.ts.net/vnc/vnc.html")],
    ]);
  });

  test("a view the devkit has not created yet is not pointed at the box until it is", async () => {
    devkit.readyOnConnect = false;
    const user = userEvent.setup();
    render(panel());
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    // No id yet: rules would be ignored, so the client URL must wait too.
    expect(devkit.log).toEqual([["src", "about:blank"]]);
    expect(frames()[0]?.getAttribute("src")).toBe("about:blank");

    (frames()[0] as unknown as FakeDevkitWebview).webviewId = 7;
    await waitFor(() => expect(devkit.log).toHaveLength(3));
    expect(devkit.log[1]?.[0]).toBe("rules");
    expect(devkit.log[2]?.[0]).toBe("src");
  });

  test("New tab asks the app to open the desktop, rather than opening a window itself", async () => {
    server = fakeServer({ "app.openExternal": { opened: true } });
    const opened: unknown[] = [];
    const realOpen = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      const user = userEvent.setup();
      render(panel());
      await user.click(screen.getByRole("button", { name: /New tab/ }));
      expect(server.to("app.openExternal").map((c) => c.params)).toEqual([
        { url: "https://lumen.acme.ts.net/vnc/" },
      ]);
      expect(opened).toEqual([]);
    } finally {
      window.open = realOpen;
    }
  });

  test("Reconnect replaces the frame instead of opening a second one", async () => {
    const user = userEvent.setup();
    render(panel());
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    const first = frames()[0];
    await user.click(screen.getByRole("button", { name: /Reconnect/ }));
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).not.toBe(first);
  });

  test("1:1 reloads the client with scaling off", async () => {
    const user = userEvent.setup();
    render(panel());
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    expect(frames()[0]?.getAttribute("src")).toContain("resize=scale");
    await user.click(screen.getByRole("button", { name: "1:1" }));
    expect(frames()).toHaveLength(1);
    expect(frames()[0]?.getAttribute("src")).toContain("resize=off");
  });

  /**
   * One identity is not a choice, so it is a label. The second one is a real
   * choice, and switching it is a different machine's screen — so the session
   * is dropped rather than re-pointed.
   */
  test("a second browser identity is a select, and switching drops the stream", async () => {
    const user = userEvent.setup();
    render(
      panel({
        browsers: [...DEFAULT_BROWSERS, { name: "clean", serve_path: "/vnc/clean" }],
      }),
    );
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    expect(frames()).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText("Which browser to watch"), "clean");
    expect(frames()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    expect(frames()[0]?.getAttribute("src")).toContain("/vnc/clean/vnc.html");
  });

  test("with one identity the selector is a label, not a dropdown", () => {
    render(panel());
    expect(screen.queryByLabelText("Which browser to watch")).toBeNull();
    expect(screen.getByText("default")).toBeTruthy();
  });

  /**
   * A cross-origin frame swallows every keydown, Escape included — so there is
   * no key that gets focus back out of it, and the hint must not claim there
   * is. Clicking off the frame is the move that works.
   */
  test("the focus hint says to click out of the frame, not to press Esc twice", async () => {
    const user = userEvent.setup();
    render(panel());
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    expect(screen.getByText(/click outside the frame, then Esc closes the drawer/)).toBeTruthy();
    expect(screen.queryByText(/Esc twice/)).toBeNull();
  });

  /**
   * The desktop of a box that is not running is not a cold session, it is no
   * session: `Connect →` would dial a hostname with nothing behind it.
   */
  for (const status of ["stopped", "destroyed"]) {
    test(`a ${status} agent gets an explanation instead of Connect`, () => {
      render(panel({ status }));
      expect(screen.getByText(new RegExp(`No desktop while this agent is ${status}`))).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Connect →/ })).toBeNull();
      expect(frames()).toHaveLength(0);
    });
  }

  test("a running agent still gets the connect panel", () => {
    render(panel({ status: "degraded" }));
    expect(screen.getByRole("button", { name: /Connect →/ })).toBeTruthy();
  });

  /**
   * An overlay raised over the drawer hides the frame without unmounting it,
   * and a hidden iframe keeps its socket: the agent's screen would stay live
   * behind a Settings pane. Being covered is treated as leaving.
   */
  test("being covered drops the stream, and coming back is cold", async () => {
    const user = userEvent.setup();
    const view = render(panel());
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    expect(frames()).toHaveLength(1);

    view.rerender(panel({ suspended: true }));
    expect(frames()).toHaveLength(0);

    view.rerender(panel({ suspended: false }));
    expect(frames()).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Connect →/ })).toBeTruthy();
  });
});

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "lumen",
    status: "ready",
    display_status: "ready",
    version: 1,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
    instance_id: "i-1",
    volume_id: "vol-1",
    volume_gib: 100,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    config_hash: null,
    provider: "bedrock",
    secrets_mode: "none",
    browser: true,
    browsers: DEFAULT_BROWSERS,
    tailscale_ip: "100.64.0.9",
    resources: { ssm_paths: [] },
    last_heartbeat: "2026-09-05T11:59:55.000Z",
    heartbeat_age_ms: 5_000,
    health: { hermes: true, tailscale: true, disk: true, dashboard: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-05T11:59:55.000Z",
    ...overrides,
  } as AgentView;
}

const META = { tailnet: "acme.ts.net" } as unknown as Meta;

/** The tab lives in `App.tsx`, so the test owns it the same way the app does. */
function Host({ closed }: { closed?: () => void }) {
  const [tab, setTab] = useState<AgentTab>("overview");
  return (
    <AgentDrawer
      agent={agent()}
      meta={META}
      latest="1.2.0"
      tailnet="acme.ts.net"
      profiles={profilesState()}
      runningOpId={null}
      onOp={() => {}}
      onClose={() => closed?.()}
      confirmOpen={false}
      setConfirmOpen={() => {}}
      tab={tab}
      onTab={setTab}
    />
  );
}

describe("AgentDrawer · the tab owns the stream", () => {
  test("switching tabs mounts the frame and switching back drops it", async () => {
    server = fakeServer({
      "agents.history": [],
      "ops.list": { ops: [] },
    });
    const user = userEvent.setup();
    render(<Host />);
    await screen.findByText(/no recorded events/);
    expect(frames()).toHaveLength(0);

    await user.click(screen.getByRole("tab", { name: "Desktop" }));
    // Cold on arrival: the tab is not a connect.
    expect(frames()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Connect →/ }));
    expect(frames()).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: "Overview" }));
    expect(frames()).toHaveLength(0);
    // And coming back is cold again, not a resumed session.
    await user.click(screen.getByRole("tab", { name: "Desktop" }));
    expect(frames()).toHaveLength(0);
  });

  /**
   * Esc is the drawer's close key and also the key an operator presses at the
   * agent's own screen. While the frame has focus the drawer must not take it.
   */
  test("Escape is ignored while the desktop frame has focus", async () => {
    server = fakeServer({
      "agents.history": [],
      "ops.list": { ops: [] },
    });
    let closes = 0;
    const user = userEvent.setup();
    render(<Host closed={() => ++closes} />);
    await screen.findByText(/no recorded events/);
    await user.click(screen.getByRole("tab", { name: "Desktop" }));
    await user.click(screen.getByRole("button", { name: /Connect →/ }));

    const frame = frames()[0];
    // The devkit's element is undefined here, so it is made focusable by hand
    // to stand in for "the operator is in the viewer".
    frame?.setAttribute("tabindex", "-1");
    frame?.focus();
    expect(document.activeElement?.tagName).toBe("ELECTROBUN-WEBVIEW");
    await user.keyboard("{Escape}");
    expect(closes).toBe(0);

    // Focus back on the drawer's own controls, and Esc closes as it always did.
    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{Escape}");
    expect(closes).toBe(1);
  });
});
