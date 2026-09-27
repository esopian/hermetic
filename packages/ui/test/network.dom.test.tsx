/**
 * §5 as an operator meets it: the mode on the Foundation table, and the drawer
 * that changes it.
 *
 * `test/network.test.ts` covers the rules; what it cannot see is the two things
 * this file is for. First, that an absent mode reaches the screen as
 * "unrecorded" — the pure function can say so, but only a render proves the
 * panel does not quietly print the default instead. Second, that Apply is shut
 * until the operator has ticked the sentence about recreating stranded agents:
 * the gate is a pure function, and a drawer that forgot to consult it would
 * look identical.
 */
import { cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { FoundationStatus, NetworkReport } from "../src/api/index.ts";
import { NetworkStep } from "../src/components/InitSteps.tsx";
import { NetworkDrawer } from "../src/components/NetworkDrawer.tsx";
import { FoundationPanel } from "../src/components/settings/FoundationSection.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

let server: FakeServer | null = null;
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

function status(network?: "public" | "nat"): FoundationStatus {
  return {
    fleet: {
      foundation_version: 5,
      template_sha256: "a".repeat(64),
      hermeticd_version: "0.4.1",
      ubuntu_release: "noble",
      ami_id: "ami-0123456789abcdef0",
      ...(network ? { network } : {}),
    },
    available: {
      foundation_version: 5,
      template_sha256: "a".repeat(64),
      hermeticd_version: "0.4.1",
    },
    update_available: false,
    tool_outdated: false,
    in_progress: null,
    agents: [],
  } as FoundationStatus;
}

function report(over: Partial<NetworkReport> = {}): NetworkReport {
  return {
    mode: "nat",
    stack_mode: "nat",
    consistent: true,
    subnet_ids: ["subnet-private0"],
    egress_ip: "203.0.113.10",
    nat: {
      instance_id: "i-nat0",
      instance_state: "running",
      egress_ip: "203.0.113.10",
      route_state: "active",
    },
    agents: [
      { name: "atlas", instance_id: "i-atlas", subnet_id: "subnet-public0", placement: "drifted" },
    ],
    drifted: 1,
    ...over,
  } as NetworkReport;
}

const PLAN = {
  kind: "network",
  target: "f-abc",
  options: { network: "public" },
  steps: [
    { id: "preflight", description: "take the _fleet lock", destructive: false },
    { id: "archive", description: "archive the fleet", destructive: true },
    { id: "stack", description: "update the foundation stack with Network=public", destructive: true },
  ],
  warnings: [
    "EC2 cannot move a running instance between subnets, so atlas will keep running on the nat subnets",
    "re-networking is the most destructive operation short of teardown",
  ],
};

describe("the Foundation panel's network row", () => {
  test("renders a recorded public mode", () => {
    render(<FoundationPanel foundation={status("public")} onOpenUpdate={() => {}} />);
    expect(screen.getByText("network mode")).toBeDefined();
    expect(screen.getByText(/public — every agent has its own public IP/)).toBeDefined();
  });

  test("renders a recorded nat mode", () => {
    render(<FoundationPanel foundation={status("nat")} onOpenUpdate={() => {}} />);
    expect(screen.getByText(/nat \(fck-nat\)/)).toBeDefined();
  });

  test("an absent mode reads `unrecorded`, and never `public`", () => {
    render(<FoundationPanel foundation={status()} onOpenUpdate={() => {}} />);
    const row = screen.getByText(/unrecorded/);
    expect(row.textContent).toContain("foundation update");
    expect(screen.queryByText(/public — every agent has its own public IP/)).toBe(null);
  });

  test("the compact status block names the egress ip and the stranded agent", () => {
    render(<FoundationPanel foundation={status("nat")} network={report()} onOpenUpdate={() => {}} />);
    expect(screen.getByText("203.0.113.10")).toBeDefined();
    expect(screen.getByText(/1 of 1 left behind/)).toBeDefined();
  });

  test("the re-network button is offered, and refused with a reason while the status read is out", () => {
    const { rerender } = render(
      <FoundationPanel foundation={status("nat")} onOpenUpdate={() => {}} onOpenNetwork={() => {}} />,
    );
    const waiting = screen.getByRole("button", { name: /Change network mode/ });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <FoundationPanel
        foundation={status("nat")}
        network={report()}
        onOpenUpdate={() => {}}
        onOpenNetwork={() => {}}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /Change network mode/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("the re-network drawer", () => {
  test("reviews the plan for the other mode, with its warnings", async () => {
    server = fakeServer({ "plan.network": PLAN });
    render(<NetworkDrawer report={report()} onClose={() => {}} onApplied={() => {}} />);

    await waitFor(() => expect(screen.getByText(/update the foundation stack/)).toBeDefined());
    // The target is the *other* mode, and it is the one asked for.
    expect(server.to("plan.network")[0]?.params).toMatchObject({ to: "public" });
    expect(screen.getByText(/Read before applying/)).toBeDefined();
    expect(screen.getByText(/keep running on the nat subnets/)).toBeDefined();
  });

  test("Apply stays shut until the recreate consequence is acknowledged", async () => {
    server = fakeServer({ "plan.network": PLAN });
    render(<NetworkDrawer report={report()} onClose={() => {}} onApplied={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText(/recreated by hand/)).toBeDefined();
    expect(screen.getByText(/is refused outright/)).toBeDefined();
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    await userEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("a refusal is shown with its code — AGENTS_EXIST is the one operators hit", async () => {
    server = fakeServer({
      "plan.network": {
        status: 409,
        json: { error: { code: "AGENTS_EXIST", message: "atlas still has an instance" } },
      },
    });
    render(
      <NetworkDrawer
        report={report({ mode: "nat", stack_mode: "nat" })}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );
    // Twice: in the Steps block where the plan would have been, and on the foot.
    await waitFor(() => expect(screen.getAllByText(/AGENTS_EXIST/).length).toBe(2));
    expect(screen.getByText(/atlas still has an instance/)).toBeDefined();
    // Nothing to continue to: there is no plan.
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the init wizard's Network step", () => {
  test("no longer calls the choice frozen — it names the way back", () => {
    render(<NetworkStep network="public" onNetwork={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Frozen at init");
    expect(text).not.toContain("re-initialising");
    expect(text).toContain("Settings → Foundation → Change network mode");
    expect(text).toContain("recreated");
  });

  test("keeps the cost and DERP trade-off, and names the new nat facts", () => {
    render(<NetworkStep network="nat" onNetwork={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("$3.65/mo");
    expect(text).toContain("elastic IP");
    expect(text).toContain("IPv6");
    expect(text).toContain("DERP");
  });
});
