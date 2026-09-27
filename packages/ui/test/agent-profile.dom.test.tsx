/**
 * §8.3's agent-side edit: change the profile or the model, save, then apply.
 *
 * The two steps are the behaviour under test. `agents.set` stages the change on
 * the row and touches nothing on the box, so the panel says "Saved — pending
 * apply" rather than claiming the agent moved; applying is the rollout that
 * already exists (`plan.rollout` → review → `apply`). An offline agent is
 * offered no apply at all, because there is nothing running to restart.
 *
 * The panel is driven on its own rather than through the whole agent drawer:
 * it is the component that owns this state machine, and the drawer's own
 * mounting is already covered by `agent-drawer-destroy.dom.test.tsx`.
 */
import { cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { AgentView } from "../src/api/index.ts";
import { AgentProfilePanel } from "../src/components/AgentProfilePanel.tsx";
import { FAKE_TARGET, fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { FIXTURE_PROFILES, fixtureProfilesState } from "./profiles-fixture.ts";

let server: FakeServer | null = null;
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

const PENDING = {
  profile_id: "0pr0ut3r",
  profile_revision: 1,
  provider: "openrouter" as const,
  model: "deepseek/deepseek-v4.1-flash",
  credential_ref: "provider-key-0pr0ut3r-r1",
  staged_at: "2026-09-14T00:00:00.000Z",
  staged_by: "evan",
};

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    name: "lumen",
    // The row version every write is composed against (§8.3's optimistic
    // concurrency, mirroring `SettingsSetInput.expected_version`).
    version: 7,
    provider: "anthropic",
    display_status: "ready",
    profile_id: "an7hr0p1",
    profile_revision: 1,
    credential_ref: "provider-key-an7hr0p1-r1",
    hermes: { model: "claude-sonnet-5" },
    ...over,
  } as AgentView;
}

const CATALOG_REPLY = {
  provider: "openrouter",
  models: [{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
  default_model: "deepseek/deepseek-v4.1-flash",
  fetched_at: "2026-09-14T00:00:00.000Z",
};

const ROLLOUT_PLAN = {
  kind: "rollout",
  summary: "1 agent",
  steps: [
    { id: "lumen", description: "re-render the manifest and restart Hermes", destructive: false },
  ],
  warnings: [],
  options: {},
};

/**
 * The row as the fleet stream brings it back: `agents.set` returns the staged
 * row, and the panel's `profiles.refresh()` is what the page does next — so the
 * host flips to the pending row at exactly that moment.
 */
function Host({ base = {}, ops = [] as string[] }: { base?: Partial<AgentView>; ops?: string[] }) {
  const [staged, setStaged] = useState(false);
  return (
    <AgentProfilePanel
      agent={agent(staged ? { ...base, pending: PENDING } : base)}
      profiles={fixtureProfilesState({ refresh: () => setStaged(true) })}
      busy={false}
      onRunOp={async (label, fn) => {
        ops.push(label);
        await fn();
      }}
    />
  );
}

describe("AgentProfilePanel", () => {
  test("an edit stages the change and the banner says it is pending, not done", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.set": agent({ pending: PENDING }),
      "plan.rollout": ROLLOUT_PLAN,
      apply: { op_id: "op-9", op: { id: "op-9" } },
    });
    const user = userEvent.setup();
    const ops: string[] = [];
    render(<Host ops={ops} />);

    await user.click(screen.getByRole("button", { name: "Change profile or model" }));
    await user.selectOptions(screen.getAllByRole("combobox")[0] as HTMLSelectElement, "0pr0ut3r");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(server?.to("agents.set")).toHaveLength(1));
    expect(server.to("agents.set")[0]?.params).toEqual({
      name: "lumen",
      expected_version: 7,
      provider_profile: "0pr0ut3r",
      // §4.7: the fleet this tab is showing, named on every mutation.
      target: FAKE_TARGET,
    });

    // The box has not moved; the row carries the staged values and says so.
    await waitFor(() => expect(screen.getByText(/Saved — pending apply/)).toBeTruthy());
    expect(
      screen.getByText(/openrouter-cheap · openrouter · deepseek\/deepseek-v4.1-flash/),
    ).toBeTruthy();

    // Applying is the existing rollout: plan, review, then apply.
    await user.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(server?.to("plan.rollout")).toHaveLength(1));
    expect(server.to("plan.rollout")[0]?.params).toMatchObject({ agents: ["lumen"] });
    expect(screen.getByText(/re-render the manifest/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Confirm rollout" }));
    await waitFor(() => expect(server?.to("apply")).toHaveLength(1));
    expect(ops).toEqual(["rollout"]);
    const applied = server.to("apply")[0]?.params as { plan: { kind: string }; yes: boolean };
    expect(applied.plan.kind).toBe("rollout");
    expect(applied.yes).toBe(true);
  });

  test("switching profiles reseeds the model from the new profile", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.set": agent({ pending: PENDING }),
    });
    const user = userEvent.setup();
    render(<Host />);

    await user.click(screen.getByRole("button", { name: "Change profile or model" }));
    await user.selectOptions(screen.getAllByRole("combobox")[0] as HTMLSelectElement, "0pr0ut3r");
    // The new profile's own model, not the Anthropic id this agent was running.
    expect(screen.getByText("deepseek/deepseek-v4.1-flash", { selector: "b" })).toBeTruthy();
  });

  test("an offline agent is told the change waits, and is offered no rollout", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.set": agent({ pending: PENDING }),
    });
    const user = userEvent.setup();
    render(<Host base={{ display_status: "stopped" }} />);

    await user.click(screen.getByRole("button", { name: "Change profile or model" }));
    await user.selectOptions(screen.getAllByRole("combobox")[0] as HTMLSelectElement, "0pr0ut3r");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText(/Saved — pending apply/)).toBeTruthy());
    // Not "on its next start": starting the instance boots it back into the
    // configuration it already has. `pending` is consumed by an apply or by a
    // recreate, and those are the two things the banner is allowed to name.
    expect(screen.queryByText(/next start/)).toBeNull();
    expect(screen.getByText(/start it and apply the rollout, or recreate it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  });

  /**
   * §8.3: `credential_ref` has three states and only one of them is a slot.
   * `null` is the cleared state core writes when an agent moves onto a
   * role-authenticated provider — there is no key, and the panel used to answer
   * `provider-key`, naming a legacy slot nothing has written since the day the
   * agent was created.
   */
  test("a role-authenticated agent says IAM instance role, not the legacy key slot", () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    render(
      <AgentProfilePanel
        agent={agent({
          provider: "bedrock",
          profile_id: "b3dr0ck0",
          credential_ref: null,
        } as Partial<AgentView>)}
        profiles={fixtureProfilesState()}
        busy={false}
        onRunOp={async () => {}}
      />,
    );

    expect(screen.getByText("IAM instance role · no key")).toBeTruthy();
    expect(screen.queryByText("provider-key")).toBeNull();
  });

  test("a keyed row written before profiles existed keeps the provider-key fallback", () => {
    server = fakeServer({ "providers.models": CATALOG_REPLY });
    render(
      <AgentProfilePanel
        // No `profile_id`, no `credential_ref`: the pre-profiles shape, whose
        // credential really does live in the legacy slot.
        agent={
          {
            name: "lumen",
            version: 7,
            provider: "anthropic",
            display_status: "ready",
            hermes: { model: "claude-sonnet-5" },
          } as unknown as AgentView
        }
        profiles={fixtureProfilesState()}
        busy={false}
        onRunOp={async () => {}}
      />,
    );

    expect(screen.getByText("provider-key")).toBeTruthy();
  });

  /**
   * The fleet stream means this panel can be looking at a row somebody else is
   * editing. `expected_version` makes that a refusal instead of an overwrite,
   * and the refusal has to read as an instruction — retrying the same body only
   * loses the same race again.
   */
  test("a CONFLICT is reported as another operator's write, and says to reload", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.set": {
        status: 409,
        json: { error: { code: "CONFLICT", message: "agent lumen changed since it was read" } },
      },
    });
    const user = userEvent.setup();
    render(<Host />);

    await user.click(screen.getByRole("button", { name: "Change profile or model" }));
    await user.selectOptions(screen.getAllByRole("combobox")[0] as HTMLSelectElement, "0pr0ut3r");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText(/changed by another operator/)).toBeTruthy());
    expect(screen.getByText(/reload before saving again/)).toBeTruthy();
    // The form stays open on the values that were typed: a lost race is not a
    // reason to make somebody retype the change they are about to re-apply.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("a profile that moved since this agent pinned it shows an update, and Refresh re-pins it", async () => {
    server = fakeServer({
      "providers.models": CATALOG_REPLY,
      "agents.set": agent({ pending: PENDING }),
    });
    const user = userEvent.setup();
    const moved = FIXTURE_PROFILES.map((p) => (p.id === "an7hr0p1" ? { ...p, revision: 4 } : p));
    render(
      <AgentProfilePanel
        agent={agent()}
        profiles={fixtureProfilesState({ list: moved })}
        busy={false}
        onRunOp={async () => {}}
      />,
    );

    expect(screen.getByText(/update available/)).toBeTruthy();
    expect(screen.getByText(/Nothing moves until the change is staged/)).toBeTruthy();

    // "Refresh profile" is the explicit re-pin: same profile, latest revision,
    // and any model override this agent has is kept by core.
    await user.click(screen.getByRole("button", { name: "Refresh profile" }));
    await waitFor(() => expect(server?.to("agents.set")).toHaveLength(1));
    expect(server.to("agents.set")[0]?.params).toEqual({
      name: "lumen",
      expected_version: 7,
      refresh_profile: true,
      target: FAKE_TARGET,
    });
  });
});
