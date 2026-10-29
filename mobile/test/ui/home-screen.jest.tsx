/**
 * The home screen over real roster and inbox stores (a canned roster source,
 * an in-memory inbox file): the empty state with nothing listened, the hero of
 * per-instance defaults, quiet sections per instance, needs-you raised by an
 * inbox entry while the roster says false, pins taking over the hero, and the
 * hero built around the primary instance.
 */
import type { Swarm } from "@hermetic/core/chat-client";
import { act, fireEvent, screen } from "@testing-library/react-native";
import Home from "../../app/home.tsx";
import { RosterStore } from "../../src/client/roster-store.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { memoryFile } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { flush } from "../helpers/fakes.ts";
import { bot, inboxEntry, msg, swarm, todoTool } from "../helpers/fixtures.ts";
import { renderUi } from "../helpers/render.tsx";

const mockPush = jest.fn();
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  return {
    Redirect: () => null,
    router: { push: (href: string) => mockPush(href), back: jest.fn() },
    useFocusEffect: (fn: () => undefined | (() => void)) => useEffect(fn, [fn]),
  };
});

async function setup(
  swarms: Swarm[],
  listening: string[],
  pinned: string[] = [],
  primary: string | null = null,
  chatViews: readonly unknown[] = [],
  extra: Partial<FleetContextValue> = {},
) {
  const roster = new RosterStore(
    {
      swarms: async () => ({ swarms }),
      listening: async () => ({ instances: listening }),
      listen: async () => ({ instances: listening }),
    },
    { load: async () => ({ pinned, folded: [] }), save: async () => {} },
  );
  await roster.setFleet("fxtr0001");
  const inbox = new InboxStore(memoryFile(), () => "2026-10-13T12:00:00.000Z");
  const fleetState = { link: null };
  const ctx = {
    client: { roster, inbox, chat: { views: () => chatViews, subscribe: () => () => {} } },
    status: "paired",
    primary,
    needsPrimary: false,
    tailscale: null,
    probing: false,
    probeTailscale: async () => {},
    refresh: async () => {},
    fleet: { subscribe: () => () => {}, getState: () => fleetState, agents: () => [] },
    ...extra,
  } as unknown as FleetContextValue;
  await renderUi(
    <FleetContext.Provider value={ctx}>
      <Home />
    </FleetContext.Provider>,
  );
  for (let i = 0; i < 5; i++) await act(flush);
  return { roster, inbox };
}

const SWARMS = [
  swarm("atlas", [
    bot({ name: "ops", title: "Ops", is_default: true }),
    bot({
      name: "scribe",
      title: "Scribe",
      preview: "the digest is out",
      last_message_at: "2026-10-13T09:00:00.000Z",
    }),
  ]),
  swarm("corvid", [
    bot({ name: "pilot", title: "Pilot", is_default: true }),
    bot({ name: "wren", title: "Wren" }),
  ]),
  swarm("heron", [], { reachable: false, unreachable_reason: "TIMEOUT: no answer" }),
];

beforeEach(() => mockPush.mockClear());

test("nothing listened: the empty prompt opens the instance picker", async () => {
  await setup([], []);
  expect(screen.getByTestId("home-empty")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Choose instances"));
  expect(mockPush).toHaveBeenCalledWith("/listening");
});

test("hero of defaults (no star), quiet sections per instance, a down instance says so", async () => {
  await setup(SWARMS, ["atlas", "corvid", "heron"]);
  expect(screen.queryByTestId("home-empty")).toBeNull();
  expect(screen.getByLabelText("Default bot: Ops")).toBeTruthy();
  expect(screen.getByLabelText("Default bot: Pilot")).toBeTruthy();
  expect(screen.queryByTestId("hero-star")).toBeNull();
  // Each remaining bot under its own instance's header; no "· instance" suffix.
  expect(screen.getByTestId("home-section-atlas")).toBeTruthy();
  expect(screen.getByTestId("home-section-corvid")).toBeTruthy();
  expect(screen.getByLabelText("Scribe")).toBeTruthy();
  expect(screen.getByLabelText("Wren")).toBeTruthy();
  expect(screen.queryByText(/· atlas/)).toBeNull();
  expect(screen.getByLabelText("heron, unreachable")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Default bot: Pilot"));
  expect(mockPush).toHaveBeenCalledWith("/chat/corvid/pilot");
});

test("an unread needs_action entry raises needs-you on a bot the roster calls quiet", async () => {
  const { inbox } = await setup(SWARMS, ["atlas", "corvid"]);
  await act(async () => {
    inbox.ingest(inboxEntry({ kind: "needs_action", instance: "corvid", bot: "wren", dedupe: "n1" }));
  });
  expect(screen.getByLabelText("Wren, needs you")).toBeTruthy();
  expect(screen.getByTestId("row-needs")).toBeTruthy();
  await act(async () => inbox.markThreadRead("corvid", "wren"));
  expect(screen.getByLabelText("Wren")).toBeTruthy();
  expect(screen.queryByTestId("row-needs")).toBeNull();
});

test("pins take over the hero, starred; the defaults go back to their sections", async () => {
  await setup(SWARMS, ["atlas", "corvid"], ["corvid/wren"]);
  expect(screen.getByLabelText("Pinned bot: Wren")).toBeTruthy();
  expect(screen.getByTestId("hero-star")).toBeTruthy();
  expect(screen.queryByLabelText("Default bot: Ops")).toBeNull();
  expect(screen.getByLabelText("Ops")).toBeTruthy();
  expect(screen.getByLabelText("Pilot")).toBeTruthy();
});

test("a primary: the hero is each default, the primary's first; the rest sit below", async () => {
  await setup(SWARMS, ["atlas", "corvid", "heron"], [], "corvid");
  const hero = screen.getAllByTestId(/^home-hero-(?!kicker)/).map((n) => n.props.testID);
  expect(hero).toEqual(["home-hero-corvid/pilot", "home-hero-atlas/ops"]);
  expect(screen.getByLabelText("Default bot: Pilot")).toBeTruthy();
  expect(screen.getByLabelText("Default bot: Ops")).toBeTruthy();
  // Several instances' defaults: no "Primary" kicker.
  expect(screen.queryByTestId("home-hero-kicker")).toBeNull();
  // corvid's other bots are rows in its section, first.
  expect(screen.getByLabelText("Wren")).toBeTruthy();
  expect(screen.getAllByTestId(/^home-section-/)[0]?.props.testID).toBe("home-section-corvid");
});

test("pins still win the hero over the primary; the primary's section sorts first", async () => {
  await setup(SWARMS, ["atlas", "corvid"], ["atlas/scribe"], "corvid");
  expect(screen.getByTestId("home-hero-kicker").props.children).toBe("Pinned");
  expect(screen.getByLabelText("Pinned bot: Scribe")).toBeTruthy();
  const sections = screen.getAllByTestId(/^home-section-/).map((n) => n.props.testID);
  expect(sections).toEqual(["home-section-corvid", "home-section-atlas"]);
});

test("a Bot Chat's task list tags its row, boxed beside the name, and never the hero", async () => {
  const list = todoTool([
    ["1", "Read the policy", "done"],
    ["2", "Draft the change", "active"],
    ["3", "Apply it", "pending"],
  ]);
  const view = (instance: string, bot: string, sending: boolean) => ({
    target: { instance, bot, session: null },
    messages: [msg({ blocks: [list] })],
    live: null,
    sending,
    activity: sending ? "streaming" : "idle",
    remote: null,
  });
  await setup(SWARMS, ["atlas", "corvid"], [], null, [
    view("atlas", "scribe", true),
    view("corvid", "wren", false),
    view("atlas", "ops", true),
  ]);
  // Running: the fraction, said with the row. Paused: the same fraction, said paused.
  expect(screen.getByLabelText("Scribe, tasks 1 of 3")).toBeTruthy();
  expect(screen.getByLabelText("Wren, tasks 1 of 3, paused")).toBeTruthy();
  expect(screen.getAllByTestId("row-tasks")).toHaveLength(2);
  expect(screen.getByLabelText("Default bot: Ops")).toBeTruthy();
});

/** The path and the row shapes are decoration: hidden from VoiceOver, so asked for explicitly. */
const HIDDEN = { includeHiddenElements: true } as const;

describe("the connection header", () => {
  const down = swarm("atlas", [], { reachable: false, unreachable_reason: "TIMEOUT: no answer" });
  const probe = (tunnel: "connected" | "down"): FleetContextValue["tailscale"] => ({
    status: tunnel === "down" ? "off" : "unreachable",
    failing: ["atlas.t.ts.net"],
    tunnel,
  });
  /** An attempt started `ago` ms before now: past the quiet beat, so the path shows. */
  const attempt = (ago: number) => ({ connection: { startedAt: Date.now() - ago } });

  test("Tailscale still waking: the path, the step, and row shapes while nothing is drawn yet", async () => {
    await setup([], ["atlas"], [], "atlas", [], { ...attempt(2_000), tailscale: probe("down") });
    expect(screen.getByTestId("connection-path-waking", HIDDEN)).toBeTruthy();
    expect(screen.getByLabelText("atlas, waking tailscale")).toBeTruthy();
    expect(screen.getByText("Waking Tailscale…")).toBeTruthy();
    expect(screen.getByTestId("home-connection-skeleton", HIDDEN)).toBeTruthy();
    // A wait is not an error: the failed-read notice stays out of the way.
    expect(screen.queryByText("Could not read the bots.")).toBeNull();
  });

  test("Tailscale up, the box not yet answering: reaching it", async () => {
    await setup([down], ["atlas"], [], "atlas", [], {
      ...attempt(4_000),
      tailscale: probe("connected"),
    });
    expect(screen.getByTestId("connection-path-reaching", HIDDEN)).toBeTruthy();
    expect(screen.getByLabelText("atlas, reaching atlas")).toBeTruthy();
    expect(screen.getByText("Tailscale is up · asking atlas…")).toBeTruthy();
  });

  test("past the grace with Tailscale down: says so and offers the fix", async () => {
    const retryConnection = jest.fn();
    await setup([down], ["atlas"], [], "atlas", [], {
      ...attempt(31_000),
      tailscale: probe("down"),
      retryConnection,
    });
    expect(screen.getByTestId("connection-path-no_tailscale", HIDDEN)).toBeTruthy();
    expect(screen.getByLabelText("atlas, no tailscale")).toBeTruthy();
    expect(screen.getByLabelText("Open Tailscale")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Try again"));
    expect(retryConnection).toHaveBeenCalledTimes(1);
  });

  test("past the grace with Tailscale up: the box is the one not answering, no Open Tailscale", async () => {
    await setup([down], ["atlas"], [], "atlas", [], {
      ...attempt(31_000),
      tailscale: probe("connected"),
    });
    expect(screen.getByTestId("connection-path-no_box", HIDDEN)).toBeTruthy();
    expect(screen.getByLabelText("atlas, not answering")).toBeTruthy();
    expect(screen.queryByLabelText("Open Tailscale")).toBeNull();
    expect(screen.getByLabelText("Try again")).toBeTruthy();
  });

  test("a box that answered this attempt draws no path", async () => {
    await setup(SWARMS, ["atlas", "corvid"], [], "atlas", [], {
      ...attempt(2_000),
      tailscale: probe("connected"),
    });
    expect(screen.queryByTestId(/connection-path-/, HIDDEN)).toBeNull();
  });
});
