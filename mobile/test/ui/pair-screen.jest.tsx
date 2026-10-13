/**
 * The Pair screen with a proposal pending: the confirm buttons sit outside the
 * scroll view, pinned to the bottom of the screen, so a long card (the
 * switch-tailnet variant) never pushes them below the fold.
 */
import { encodeMobileLink } from "@hermetic/core/shared";
import { fireEvent, screen } from "@testing-library/react-native";
import Pair from "../../app/pair.tsx";
import { type FleetContextValue, FleetContext } from "../../src/fleet/FleetProvider.tsx";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { renderUi } from "../helpers/render.tsx";

jest.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: false }, async () => ({ granted: false })],
}));
jest.mock("expo-router", () => ({
  router: { canGoBack: () => false, canDismiss: () => false, back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock("react-native-keyboard-controller", () => {
  const { forwardRef } = require("react");
  const { ScrollView } = require("react-native");
  return {
    KeyboardAwareScrollView: forwardRef((props: object, ref: unknown) => (
      <ScrollView ref={ref} testID="pair-scroll" {...props} />
    )),
  };
});

const link = (tailnet: string) =>
  encodeMobileLink({
    fleet_id: "fxtr0001",
    alias: "main",
    account_id: "123456789012",
    region: "us-west-2",
    tailnet,
    agents: [{ name: "atlas" }, { name: "corvid" }],
  });

function context(): FleetContextValue {
  const read = readPairingLink(link("old-net.ts.net"));
  if (!read.ok) throw new Error(read.error.title);
  const state = { link: read.link };
  return {
    pair: jest.fn(),
    status: "paired",
    operatorTailnet: null,
    fixture: { link: link("hermetic.ts.net") },
    fleet: { subscribe: () => () => {}, getState: () => state },
  } as unknown as FleetContextValue;
}

test("switch tailnet: Cancel and Switch are pinned outside the scroll view", async () => {
  await renderUi(
    <FleetContext.Provider value={context()}>
      <Pair />
    </FleetContext.Provider>,
  );
  await fireEvent.press(screen.getByLabelText("Use fixture fleet"));
  expect(screen.getByTestId("pair-tailnet-change")).toBeTruthy();
  const actions = screen.getByTestId("pair-confirm-actions");
  const scroll = screen.getByTestId("pair-scroll");
  // Not a descendant of the scroll view: on screen whatever the card's length.
  expect(scroll.queryAll((n) => n === actions)).toEqual([]);
  // The card itself scrolls.
  const card = screen.getByTestId("pair-confirm");
  expect(scroll.queryAll((n) => n === card)).toHaveLength(1);
  expect(screen.getByLabelText("Switch tailnet")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Cancel"));
  expect(screen.queryByTestId("pair-confirm-actions")).toBeNull();
});
