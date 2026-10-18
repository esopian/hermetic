/**
 * The Pair screen with a proposal pending: the confirm buttons sit outside the
 * scroll view, pinned to the bottom of the screen, so a long card (the
 * switch-tailnet variant) never pushes them below the fold. Confirming a link
 * that carries prefs applies them to the phone's own preferences, and a kept
 * pairing goes on to the primary picker.
 */
import { encodeMobileLink } from "@hermetic/core/shared";
import { fireEvent, screen } from "@testing-library/react-native";
import Pair from "../../app/pair.tsx";
import { type FleetContextValue, FleetContext } from "../../src/fleet/FleetProvider.tsx";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { memoryKv } from "../../src/fleet/store.ts";
import { PrefsProvider } from "../../src/prefs/prefs.tsx";
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

const link = (tailnet: string, prefs = {}) =>
  encodeMobileLink({
    fleet_id: "fxtr0001",
    alias: "main",
    account_id: "123456789012",
    region: "us-west-2",
    tailnet,
    agents: [{ name: "atlas" }, { name: "corvid" }],
    prefs,
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

test("confirming a link that carries an avatar style applies it to the phone's prefs", async () => {
  const pair = jest.fn(async () => {});
  // One object: `useSyncExternalStore` loops on a snapshot that changes every read.
  const state = { link: null };
  const ctx = {
    pair,
    status: "unpaired",
    operatorTailnet: null,
    fixture: { link: link("hermetic.ts.net", { avatar_style: "pixel" }) },
    fleet: { subscribe: () => () => {}, getState: () => state },
  } as unknown as FleetContextValue;
  const storage = memoryKv();
  await renderUi(
    <PrefsProvider storage={storage}>
      <FleetContext.Provider value={ctx}>
        <Pair />
      </FleetContext.Provider>
    </PrefsProvider>,
  );
  await fireEvent.press(screen.getByLabelText("Use fixture fleet"));
  expect(screen.getByText("Avatar style")).toBeTruthy();
  // Nothing is applied before the tap.
  expect(storage.map.size).toBe(0);
  await fireEvent.press(screen.getByLabelText("Pair"));
  expect(pair).toHaveBeenCalledTimes(1);
  // A new pairing has no primary instance: the picker comes before home.
  expect(
    jest.requireMock<{ router: { replace: jest.Mock } }>("expo-router").router.replace,
  ).toHaveBeenCalledWith("/primary");
  const stored = JSON.parse(storage.map.get("hermetic.prefs.v1") ?? "{}") as { avatarStyle?: string };
  expect(stored.avatarStyle).toBe("pixel");
});
