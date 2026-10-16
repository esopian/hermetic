/**
 * Settings' deep-link anchor: `/settings?section=<id>` scrolls the list to the
 * group whose kebab-cased title is `<id>`, once, at the y its layout reports;
 * an unknown id leaves the list at the top.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { ScrollView } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Settings, { sectionId } from "../../app/settings.tsx";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { renderUi } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));

// The jest preset's ScrollView mock shares one `scrollTo` mock across instances.
const scrollTo = (ScrollView as unknown as { prototype: { scrollTo: jest.Mock } }).prototype.scrollTo;

async function setup(params: Record<string, string>) {
  mockParams = params;
  // One object: `useSyncExternalStore` loops on a snapshot that changes every read.
  const state = {
    link: null,
    refreshing: false,
    stale: false,
    error: null,
    fromBoxes: false,
    refreshed_at: null,
  };
  const ctx = {
    primary: "atlas",
    tailscale: null,
    probing: false,
    previews: true,
    push: { state: "off" },
    pushWanted: false,
    fixture: null,
    fleet: {
      subscribe: () => () => {},
      getState: () => state,
      agents: () => [],
      listened: () => ["atlas"],
    },
  } as unknown as FleetContextValue;
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <FleetContext.Provider value={ctx}>
        <Settings />
      </FleetContext.Provider>
    </SafeAreaProvider>,
  );
}

const layout = (y: number) => ({
  nativeEvent: { layout: { x: 0, y, width: 393, height: 120 } },
});

beforeEach(() => scrollTo.mockClear());

test("section ids are the group titles, kebab-cased", () => {
  expect(sectionId("Appearance")).toBe("appearance");
  expect(sectionId("This phone")).toBe("this-phone");
});

test("?section=appearance scrolls to the Appearance group's measured y, once", async () => {
  await setup({ section: "appearance" });
  await fireEvent(screen.getByTestId("settings-section-bots"), "layout", layout(0));
  expect(scrollTo).not.toHaveBeenCalled();
  await fireEvent(screen.getByTestId("settings-section-appearance"), "layout", layout(812));
  expect(scrollTo).toHaveBeenCalledWith({ y: 812, animated: false });
  await fireEvent(screen.getByTestId("settings-section-appearance"), "layout", layout(900));
  expect(scrollTo).toHaveBeenCalledTimes(1);
});

test("an unknown or missing section leaves the list at the top", async () => {
  await setup({ section: "account" });
  await fireEvent(screen.getByTestId("settings-section-appearance"), "layout", layout(812));
  expect(scrollTo).not.toHaveBeenCalled();
});
