/**
 * §7.4's Desktop attach panel, driven.
 *
 * Three properties, and each of them is a decision the drawer makes rather
 * than a thing the route returns:
 *
 * - **Nothing is asked until the operator asks.** The route reaches the box
 *   over the tailnet, so opening a drawer must not fire it.
 * - **The token is masked until revealed**, because a drawer can sit open on a
 *   shared screen and the value only ever needs copying, not reading.
 * - **Switching agents drops it.** A token belongs to one box's dashboard
 *   process; showing box A's under box B's name would be worse than showing
 *   nothing.
 */
import { act, cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { AgentView, Meta } from "../src/api/index.ts";
import { AgentDrawer } from "../src/components/AgentDrawer.tsx";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";
import { profilesState } from "./profiles-fixture.ts";

let server: FakeServer | null = null;

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

function agent(name: string): AgentView {
  return {
    name,
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
    tailscale_ip: "100.64.0.9",
    last_heartbeat: "2026-09-05T11:59:55.000Z",
    heartbeat_age_ms: 5_000,
    health: { hermes: true, tailscale: true, disk: true, dashboard: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-05T11:59:55.000Z",
    resources: { ssm_paths: [] },
  } as unknown as AgentView;
}

const META = { tailnet: "acme.ts.net" } as unknown as Meta;

const TOKEN = "FIXTURE-HERMES-SESSION-TOKEN-lumen";

function routes(over: Record<string, unknown> = {}) {
  return {
    "agents.history": [],
    "ops.list": { ops: [] },
    "agents.probe": { error: { code: "NOT_ASKED", message: "no probe here" } },
    // One name for two agents, so the answer is built from what was asked —
    // the URL used to carry the name and the route key used to carry it twice.
    "agents.desktop": (call: TransportCall) => {
      const name = String(call.params.name);
      return {
        instance: name,
        url: `https://fleet0-${name}.acme.ts.net/`,
        token: name === "lumen" ? TOKEN : `FIXTURE-HERMES-SESSION-TOKEN-${name}`,
        rotates: true,
      };
    },
    ...over,
  };
}

function Host({ name = "lumen" }: { name?: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <AgentDrawer
      agent={agent(name)}
      meta={META}
      latest="1.2.0"
      tailnet="acme.ts.net"
      profiles={profilesState()}
      runningOpId={null}
      onOp={() => {}}
      onClose={() => {}}
      confirmOpen={confirmOpen}
      setConfirmOpen={setConfirmOpen}
      // The gateway credentials live on the Config section.
      tab="config"
    />
  );
}

describe("AgentDrawer · Hermes Desktop", () => {
  test("asks the box only when the operator asks, then shows both fields", async () => {
    let asked = 0;
    server = fakeServer(
      routes({
        "agents.desktop": () => {
          asked += 1;
          return {
            instance: "lumen",
            url: "https://fleet0-lumen.acme.ts.net/",
            token: TOKEN,
            rotates: true,
          };
        },
      }),
    );
    const user = userEvent.setup();
    render(<Host />);

    // Opening the drawer reaches no box: this route goes over the tailnet.
    await screen.findByRole("button", { name: "Connect Desktop" });
    expect(asked).toBe(0);

    await user.click(screen.getByRole("button", { name: "Connect Desktop" }));
    await screen.findByText("remote address");
    expect(asked).toBe(1);

    // The address is copyable as its whole self — `CopyId` puts the value in
    // the label and the aria-label both.
    expect(screen.getByRole("button", { name: "Copy https://fleet0-lumen.acme.ts.net/" })).toBeTruthy();
    // The token is copyable, and the panel says the thing that makes a stale
    // token legible rather than mysterious.
    expect(screen.getByRole("button", { name: `Copy ${TOKEN}` })).toBeTruthy();
    await screen.findByText(/dies with the box/);
  });

  test("masks the token until it is revealed", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await screen.findByRole("button", { name: "Connect Desktop" }));

    const copy = await screen.findByRole("button", { name: `Copy ${TOKEN}` });
    // Masked: the value is on the clipboard path, not on the screen.
    expect(copy.textContent).not.toContain("FIXTURE");
    expect(copy.textContent).toContain("•");

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(copy.textContent).toBe(TOKEN));

    await user.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(copy.textContent).not.toContain("FIXTURE"));
  });

  test("a box that does not answer says so instead of showing a blank field", async () => {
    server = fakeServer(
      routes({
        "agents.desktop": errorBody("CHAT_UNREACHABLE", "lumen: dashboard did not answer"),
      }),
    );
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await screen.findByRole("button", { name: "Connect Desktop" }));

    await screen.findByText(/lumen: dashboard did not answer/);
    expect(screen.queryByText("session token")).toBeNull();
  });

  test("switching agents drops the token the other box handed over", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    const { rerender } = render(<Host name="lumen" />);
    await user.click(await screen.findByRole("button", { name: "Connect Desktop" }));
    await screen.findByText("session token");

    await act(async () => {
      rerender(<Host name="vesper" />);
    });

    // The panel is gone entirely — not carrying `lumen`'s token under
    // `vesper`'s name, and not silently re-asking on the operator's behalf.
    await waitFor(() => expect(screen.queryByText("session token")).toBeNull());
    expect(screen.queryByRole("button", { name: `Copy ${TOKEN}` })).toBeNull();
  });
});
