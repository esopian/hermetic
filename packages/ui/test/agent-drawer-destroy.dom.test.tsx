/**
 * The agent drawer's teardown ceremony, driven.
 *
 * `test/agent-drawer.test.ts` renders the drawer statically, which can see that
 * a confirm panel exists but not that it refuses. This is the flow core will
 * not protect anyone from — §3.2 rule 3: core never asks "are you sure", the
 * head does — so the guard is entirely here: the plan is read before the
 * button is offered, the button stays dead until the agent's own name is typed
 * *and* a plan for these exact inputs is on screen, and only then does
 * `apply` happen, once, carrying that plan.
 */
import { act, cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { AgentView, Meta, Plan } from "../src/api/index.ts";
import { AgentDrawer } from "../src/components/AgentDrawer.tsx";
import { FAKE_TARGET, errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";
import { FakeStream } from "./fake-stream.ts";
import { profilesState } from "./profiles-fixture.ts";

let server: FakeServer | null = null;

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
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

const META = {
  tailnet: "acme.ts.net",
  config: { fleet_id: "fxtr0001", fleet_name: "main" },
} as unknown as Meta;

/** The same home, switched to the other fleet (§4.8): same agent name, different box. */
const OTHER_FLEET = {
  tailnet: "acme.ts.net",
  config: { fleet_id: "sg7k2m4p", fleet_name: "staging" },
} as unknown as Meta;

/**
 * The plan the fake server answers with, built for the options asked for — the
 * real route does the same, and the whole point of the guard is that the plan
 * on screen is a function of the inputs, so a fixed plan would test nothing.
 */
function planFor(keepVolume: boolean): Plan {
  return {
    kind: "destroy",
    target: "lumen",
    options: {
      keep_volume: keepVolume,
      agent_version: 1,
      instance_id: "i-1",
      volume_id: "vol-1",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    steps: [
      { id: "instance", description: "terminate i-1", destructive: true },
      {
        id: "volume",
        description: keepVolume
          ? "keep data volume vol-1, released from the name"
          : "delete data volume vol-1",
        destructive: !keepVolume,
      },
      { id: "row", description: "delete the row; the tombstone keeps the record", destructive: false },
    ],
    warnings: ["the data volume is deleted by default"],
  } as unknown as Plan;
}

const PLAN = planFor(false);

/** The routes the drawer touches on mount, plus the two the destroy needs. */
function routes(over: Record<string, unknown> = {}) {
  return {
    "agents.history": [],
    "ops.list": { ops: [] },
    "agents.probe": { error: { code: "NOT_ASKED", message: "no probe here" } },
    "plan.destroy": (call: TransportCall) => planFor(call.params.keep_volume === true),
    apply: { op_id: "op-77" },
    ...over,
  };
}

/** `confirmOpen` lives in `App.tsx`, so the test owns it the same way. */
function Host({
  onOp = () => {},
  meta = META,
}: {
  onOp?: (name: string, opId: string | null) => void;
  meta?: Meta;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <AgentDrawer
      agent={agent()}
      meta={meta}
      latest="1.2.0"
      tailnet="acme.ts.net"
      profiles={profilesState()}
      runningOpId={null}
      onOp={onOp}
      onClose={() => {}}
      confirmOpen={confirmOpen}
      setConfirmOpen={setConfirmOpen}
    />
  );
}

/** Destroy lives in Lifecycle's danger zone; the confirm opens under its button. */
async function openDestroy(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Lifecycle" }));
  await user.click(screen.getByRole("button", { name: "Destroy lumen…" }));
}

async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
  await openDestroy(user);
  // The plan is read on open, not on submit: the operator confirms against the
  // steps, so the steps have to be on screen first.
  await screen.findByText(/terminate i-1/);
}

describe("AgentDrawer · destroy", () => {
  test("activity reports failure, retries, and retains data when the next read fails", async () => {
    let reads = 0;
    server = fakeServer(
      routes({
        "agents.history": () =>
          ++reads === 2
            ? [
                {
                  timestamp: "2026-09-01T00:00:00Z",
                  actor: "evan",
                  action: "created",
                  detail: "Recorded event",
                },
              ]
            : errorBody("OFFLINE", "History unavailable"),
        "agents.reboot": { command: "cmd-1" },
      }),
    );
    const user = userEvent.setup();
    render(<Host />);
    await screen.findByText(/Could not read activity: History unavailable/);
    expect(screen.queryByText(/no recorded events/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry activity" }));
    await screen.findByText(/Recorded event/);
    await user.click(screen.getByRole("tab", { name: "Lifecycle" }));
    await user.click(screen.getByRole("button", { name: "Reboot" }));
    // The reboot re-reads the history, which fails; Overview keeps the last good read.
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await screen.findByText(/showing the last good read/);
    expect(screen.getByText(/Recorded event/)).toBeTruthy();
  });

  test("Escape closes inline destroy confirmation before its drawer", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    render(<Host />);
    await openConfirm(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Type the agent name to confirm")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("reads the plan when the panel opens, and shows its destructive steps", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    render(<Host />);

    expect(screen.queryByRole("button", { name: "Destroy" })).toBeNull();
    await openConfirm(user);

    expect(server.to("plan.destroy").length).toBe(1);
    expect(screen.getByText(/the data volume is deleted by default/)).toBeTruthy();
  });

  test("the wrong name leaves the button dead; the right one arms it", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    render(<Host />);
    await openConfirm(user);

    const button = screen.getByRole("button", { name: "Destroy" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByLabelText("Type the agent name to confirm");
    await user.type(input, "lumn");
    expect(button.disabled).toBe(true);

    await user.clear(input);
    await user.type(input, "lumen");
    expect(button.disabled).toBe(false);
  });

  test("submitting applies the reviewed plan once and hands the op id up", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    const ops: Array<[string, string | null]> = [];
    render(<Host onOp={(name, opId) => ops.push([name, opId])} />);
    await openConfirm(user);

    await user.type(screen.getByLabelText("Type the agent name to confirm"), "lumen");
    await user.click(screen.getByRole("button", { name: "Destroy" }));

    await waitFor(() => expect(server?.to("apply").length).toBe(1));
    // Two things travel together, and the body is asserted whole so neither can
    // quietly stop being sent. The plan object itself, so the ids core rechecks
    // under the lock are the ids the operator read rather than a fresh
    // derivation from the name; and §4.7's target, so a tab left open across a
    // fleet switch is refused rather than obeyed against the new fleet.
    expect(server.to("apply")[0]?.params).toEqual({
      plan: PLAN,
      yes: true,
      target: FAKE_TARGET,
    });
    // …and nothing shortcut it: there is no direct delete, only plan + apply.
    expect(server.calls.map((c) => c.name)).not.toContain("agents.destroy");
    // The op the shell has to remember, so reopening the drawer reattaches.
    await waitFor(() => expect(ops).toContainEqual(["lumen", "op-77"]));
    // …and the drawer starts watching it rather than leaving a dead panel up.
    expect(FakeStream.last("ops.subscribe").params).toMatchObject({ op_id: "op-77" });
  });

  test("the volume choice is what puts `keep_volume` on both the plan and the call", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    render(<Host />);
    await openConfirm(user);

    expect(server.to("plan.destroy")[0]?.params).toMatchObject({ keep_volume: false });

    await user.click(screen.getByRole("radio", { name: /Keep volume/ }));
    // Re-planned, because the plan the operator is confirming has changed.
    await waitFor(() =>
      expect(server?.to("plan.destroy")[1]?.params).toMatchObject({ keep_volume: true }),
    );

    // The replacement plan has to be on screen before the button will arm.
    await screen.findByText(/keep data volume vol-1/);
    await user.type(screen.getByLabelText("Type the agent name to confirm"), "lumen");
    await user.click(screen.getByRole("button", { name: "Destroy" }));
    await waitFor(() => expect(server?.to("apply").length).toBe(1));
    expect(server.to("apply")[0]?.params).toEqual({
      plan: planFor(true),
      yes: true,
      target: FAKE_TARGET,
    });
  });

  /**
   * The rail an operator watches while the destroy runs. It used to be seeded
   * with `create`'s phases and worded from the shared label table, so a destroy
   * announced "Launch the EC2 instance" over the terminate and "Allocate the
   * data volume" over the step that deletes it — and `tailnet`, which the seed
   * list omitted entirely, arrived as a raw phase key *below* "Done".
   */
  test("the rail is destroy's own steps, each saying what it removes", async () => {
    server = fakeServer(
      routes({
        "ops.list": { ops: [{ id: "op-9", method: "agents.destroy", status: "running" }] },
      }),
    );
    render(<Host />);

    const stream = await waitFor(() => FakeStream.last("ops.subscribe"));
    expect(stream.params).toMatchObject({ op_id: "op-9" });
    const at = "2026-09-06T12:00:00.000Z";
    act(() => {
      stream.emit("event", { phase: "instance", progress: 0.2, message: "terminating i-1", at }, "1");
      stream.emit(
        "event",
        { phase: "tailnet", progress: 0.3, message: "removed tailnet device lumen", at },
        "2",
      );
    });

    expect(await screen.findByText("Terminate the EC2 instance")).toBeTruthy();
    expect(screen.getByText("Remove the node from the tailnet")).toBeTruthy();
    expect(screen.getByText("Delete the agent's SSM parameters")).toBeTruthy();
    expect(screen.getByText("Remove config objects from the bucket")).toBeTruthy();
    expect(screen.getByText("Delete the data volume, or release it if kept")).toBeTruthy();
    expect(screen.getByText("Write the tombstone and free the name")).toBeTruthy();
    expect(screen.getByText("Destroyed")).toBeTruthy();

    // Create's wording, and the raw key, are both gone.
    expect(screen.queryByText("Launch the EC2 instance and attach its data volume")).toBeNull();
    expect(screen.queryByText("Allocate the data volume")).toBeNull();
    expect(screen.queryByText("tailnet")).toBeNull();
  });

  /**
   * The gap the guard closes. Typing the name used to be the whole condition,
   * so the button armed over a failed plan read, over a read still in flight,
   * and over the previous plan still on screen while its replacement loaded.
   *
   * The agent dimension of the same rule is in `test/destroy-plan.test.ts`:
   * `armedPlan` refuses a plan whose key names another agent, and a drawer is
   * rendered per agent, so there is no extra wiring here to exercise.
   */
  test("destroy submit disabled without a current successful plan matching fleet, agent, and options", async () => {
    let fails = true;
    /** Set to hold the next plan read open, so the in-flight state is observable. */
    let hold: Promise<void> | null = null;
    let release: () => void = () => {};
    const holdPlan = () => {
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
    };

    server = fakeServer(
      routes({
        "plan.destroy": async (call: TransportCall) => {
          if (hold) await hold;
          return fails
            ? errorBody("OFFLINE", "the plan could not be read")
            : planFor(call.params.keep_volume === true);
        },
      }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<Host />);

    // 1. A failed plan read says so, offers the read again, and arms nothing.
    await openDestroy(user);
    await screen.findByText(/the plan could not be read/);
    const button = () => screen.getByRole("button", { name: "Destroy" }) as HTMLButtonElement;
    await user.type(screen.getByLabelText("Type the agent name to confirm"), "lumen");
    expect(button().disabled).toBe(true);

    // 2. The retry succeeds, and the name typed a moment ago now means
    //    something — the inputs never moved, so the confirmation still stands.
    fails = false;
    await user.click(screen.getByRole("button", { name: "Retry plan" }));
    await screen.findByText(/delete data volume vol-1/);
    await waitFor(() => expect(button().disabled).toBe(false));

    // 3. Changing the volume choice invalidates that plan: the confirmation is
    //    cleared and the button stays dead while the replacement is in flight.
    holdPlan();
    await user.click(screen.getByRole("radio", { name: /Keep volume/ }));
    expect((screen.getByLabelText("Type the agent name to confirm") as HTMLInputElement).value).toBe(
      "",
    );
    await user.type(screen.getByLabelText("Type the agent name to confirm"), "lumen");
    expect(button().disabled).toBe(true);
    await act(async () => {
      release();
    });
    await screen.findByText(/keep data volume vol-1/);
    await waitFor(() => expect(button().disabled).toBe(false));

    // 4. Switching the fleet under the panel does the same: same agent name,
    //    different box (§4.8), so the plan on screen is no longer this one's.
    holdPlan();
    rerender(<Host meta={OTHER_FLEET} />);
    await user.type(screen.getByLabelText("Type the agent name to confirm"), "lumen");
    expect(button().disabled).toBe(true);

    // Nothing was applied at any point along the way.
    expect(server.to("apply").length).toBe(0);
    // …and once the new fleet's plan lands, the ceremony is available again.
    await act(async () => {
      release();
    });
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  test("a stale plan refused by apply reopens the panel for a fresh one", async () => {
    let applies = 0;
    server = fakeServer(
      routes({
        apply: () =>
          ++applies === 1
            ? errorBody("PLAN_STALE", "lumen moved since this plan was made")
            : { op_id: "op-78" },
      }),
    );
    const user = userEvent.setup();
    render(<Host />);
    await openConfirm(user);

    await user.type(screen.getByLabelText("Type the agent name to confirm"), "lumen");
    await user.click(screen.getByRole("button", { name: "Destroy" }));

    // Refused, reported, and re-offered: a fresh plan is read and the button is
    // dead again until the operator confirms that one.
    await screen.findByText(/lumen moved since this plan was made/);
    const input = await screen.findByLabelText("Type the agent name to confirm");
    expect((input as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(server?.to("plan.destroy").length).toBe(2));
    expect((screen.getByRole("button", { name: "Destroy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("the panel closes on submit, so the ceremony cannot be repeated by a second click", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    render(<Host />);
    await openConfirm(user);

    await user.type(screen.getByLabelText("Type the agent name to confirm"), "lumen");
    await user.click(screen.getByRole("button", { name: "Destroy" }));

    await waitFor(() => expect(screen.queryByLabelText("Type the agent name to confirm")).toBeNull());
    expect(server.to("apply").length).toBe(1);
  });
});
