/**
 * The primary picker: every agent of the fleet as a single-select list,
 * Continue off until one is picked, then `setPrimary` and on to home. The
 * first pick (no primary yet) has no Cancel; changing an existing one does.
 */
import { act, fireEvent, screen } from "@testing-library/react-native";
import Primary, { agentLine } from "../../app/primary.tsx";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import type { FleetAgent } from "../../src/fleet/store.ts";
import { flush } from "../helpers/fakes.ts";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { renderUi } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const mockRouter = {
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
};
// Delegating: the factory runs when the screen is imported, before `mockRouter` is set.
jest.mock("expo-router", () => ({
  router: {
    replace: (href: string) => mockRouter.replace(href),
    back: () => mockRouter.back(),
    canGoBack: () => mockRouter.canGoBack(),
  },
}));

const agent = (over: Partial<FleetAgent>): FleetAgent => ({
  name: "atlas",
  host: "atlas.hermetic.ts.net",
  status: "ready",
  tailscale_ip: null,
  version: "0.4.2",
  health: null,
  live: true,
  ...over,
});

const AGENTS = [
  agent({ name: "atlas" }),
  agent({ name: "corvid", status: "degraded", version: null }),
  agent({ name: "heron", status: null, version: null, live: false }),
];

async function setup(primary: string | null, setPrimary = jest.fn(async () => {})) {
  // One object: `useSyncExternalStore` loops on a snapshot that changes every read.
  const state = { link: { label: "main" }, refreshing: false };
  const ctx = {
    primary,
    needsPrimary: primary === null,
    setPrimary,
    fleet: { subscribe: () => () => {}, getState: () => state, agents: () => AGENTS },
  } as unknown as FleetContextValue;
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <FleetContext.Provider value={ctx}>
        <Primary />
      </FleetContext.Provider>
    </SafeAreaProvider>,
  );
  return setPrimary;
}

beforeEach(() => {
  mockRouter.replace.mockClear();
  mockRouter.back.mockClear();
});

test("agentLine: status and version, or what is known", () => {
  expect(agentLine({ status: "ready", version: "0.4.2" })).toBe("ready · 0.4.2");
  expect(agentLine({ status: null, version: null })).toBe("status unknown");
});

test("first pick: every agent listed, Continue off until one is picked, then home", async () => {
  const setPrimary = await setup(null);
  expect(screen.getByText("Pick your primary instance")).toBeTruthy();
  expect(screen.getByText(/listens to this instance first/)).toBeTruthy();
  expect(screen.getByLabelText("atlas, ready · 0.4.2")).toBeTruthy();
  expect(screen.getByLabelText("corvid, degraded")).toBeTruthy();
  expect(screen.getByLabelText("heron, status unknown")).toBeTruthy();
  // Not dismissible on the first pick.
  expect(screen.queryByLabelText("Cancel")).toBeNull();

  const cont = screen.getByLabelText("Continue");
  expect(cont.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(cont);
  expect(setPrimary).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId("primary-corvid"));
  expect(screen.getByTestId("primary-corvid").props.accessibilityState.checked).toBe(true);
  expect(screen.getByLabelText("Continue").props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(screen.getByLabelText("Continue"));
  await act(flush);
  expect(setPrimary).toHaveBeenCalledWith("corvid");
  expect(mockRouter.replace).toHaveBeenCalledWith("/home");
});

test("a refused pick stays on the screen and says why", async () => {
  const setPrimary = jest.fn(async () => {
    throw new Error("heron is not an agent in this fleet");
  });
  await setup(null, setPrimary);
  await fireEvent.press(screen.getByTestId("primary-heron"));
  await fireEvent.press(screen.getByLabelText("Continue"));
  await act(flush);
  expect(screen.getByText("heron is not an agent in this fleet")).toBeTruthy();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test("changing the primary: the current one is preselected, Cancel goes back", async () => {
  const setPrimary = await setup("atlas");
  expect(screen.getByTestId("primary-atlas").props.accessibilityState.checked).toBe(true);
  await fireEvent.press(screen.getByLabelText("Cancel"));
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId("primary-corvid"));
  await fireEvent.press(screen.getByLabelText("Continue"));
  await act(flush);
  expect(setPrimary).toHaveBeenCalledWith("corvid");
  // Back to Settings, not a second home on the stack.
  expect(mockRouter.back).toHaveBeenCalledTimes(2);
  expect(mockRouter.replace).not.toHaveBeenCalled();
});
