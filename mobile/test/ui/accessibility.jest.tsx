import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactNative from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { palettes } from "../../src/theme/tokens.ts";
import {
  AccessibilityPreferencesProvider,
  useAccessibilityPreferences,
} from "../../src/ui/AccessibilityPreferences.tsx";
import { Banner } from "../../src/ui/Banner.tsx";
import { Button } from "../../src/ui/Button.tsx";
import { textColor, type TextTone } from "../../src/ui/text-colors.ts";

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function Preferences() {
  const value = useAccessibilityPreferences();
  return <ReactNative.Text>{JSON.stringify(value)}</ReactNative.Text>;
}

test("accessibility settings update live; a late initial read cannot overwrite a newer event", async () => {
  let resolveMotion: (enabled: boolean) => void = () => {};
  const listeners = new Map<string, (enabled: boolean) => void>();
  const remove = jest.fn();
  jest.spyOn(ReactNative.AccessibilityInfo, "isReduceMotionEnabled").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveMotion = resolve;
      }),
  );
  jest.spyOn(ReactNative.AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(false);
  jest.spyOn(ReactNative.AccessibilityInfo, "addEventListener").mockImplementation((name, handler) => {
    listeners.set(name, handler as unknown as (enabled: boolean) => void);
    return { remove } as unknown as ReturnType<typeof ReactNative.AccessibilityInfo.addEventListener>;
  });
  const view = await render(
    <AccessibilityPreferencesProvider>
      <Preferences />
    </AccessibilityPreferencesProvider>,
  );
  await act(async () => {
    listeners.get("reduceMotionChanged")?.(true);
    listeners.get("screenReaderChanged")?.(true);
    resolveMotion(false);
  });
  expect(screen.getByText('{"reduceMotion":true,"screenReader":true}')).toBeTruthy();
  await act(async () => listeners.get("reduceMotionChanged")?.(false));
  expect(screen.getByText('{"reduceMotion":false,"screenReader":true}')).toBeTruthy();
  await view.unmount();
  expect(remove).toHaveBeenCalledTimes(2);
});

test("VoiceOver keeps an alert available until its Dismiss action is used", async () => {
  jest.useFakeTimers();
  jest.spyOn(ReactNative.AccessibilityInfo, "isScreenReaderEnabled").mockResolvedValue(true);
  jest.spyOn(ReactNative.AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  const onDismiss = jest.fn();
  await render(
    <AccessibilityPreferencesProvider>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 320, height: 568 },
          insets: { top: 20, bottom: 0, left: 0, right: 0 },
        }}
      >
        <Banner
          alert={{
            decision: "banner",
            title: "Clio",
            body: "Finished",
            category: null,
            data: {
              fleet_id: "fxtr0001",
              instance: "atlas",
              bot: "clio",
              session: "s-1",
              kind: "turn.done",
              dedupe: "d-1",
            },
          }}
          onOpen={jest.fn()}
          onDismiss={onDismiss}
        />
      </SafeAreaProvider>
    </AccessibilityPreferencesProvider>,
  );
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(onDismiss).not.toHaveBeenCalled();
  await fireEvent(screen.getByLabelText("Clio. Finished"), "accessibilityAction", {
    nativeEvent: { actionName: "dismiss" },
  });
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("large Dynamic Type wraps action labels and keeps compact actions at least 44pt", async () => {
  const previous = ReactNative.Dimensions.get("window");
  ReactNative.Dimensions.set({ window: { width: 320, height: 568, scale: 2, fontScale: 2 } });
  await render(<Button compact label="Approve this session" haptic={false} />);
  const label = screen.getByText("Approve this session");
  expect(label.props.numberOfLines).toBeUndefined();
  expect(label.props.adjustsFontSizeToFit).toBe(false);
  expect(
    ReactNative.StyleSheet.flatten(screen.getByRole("button").props.style).minHeight,
  ).toBeGreaterThanOrEqual(44);
  await screen.unmount();
  ReactNative.Dimensions.set({ window: previous });
});

test("semantic text tones meet 4.5:1 on every standard reading surface in both schemes", () => {
  const luminance = (hex: string) => {
    const values = [1, 3, 5].map((i) => {
      const value = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (values[0] ?? 0) + 0.7152 * (values[1] ?? 0) + 0.0722 * (values[2] ?? 0);
  };
  for (const scheme of ["dark", "light"] as const) {
    const palette = palettes[scheme];
    for (const tone of ["fg", "fg2", "fg3", "acc", "ok", "warn", "bad"] satisfies TextTone[]) {
      for (const surface of [palette.bg, palette.bg2, palette.bg3, palette.card, palette.sel]) {
        const a = luminance(textColor(palette, scheme, tone));
        const b = luminance(surface);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
