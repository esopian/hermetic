import { fireEvent, render, screen } from "@testing-library/react-native";
import { RemoteBand, ThreadBand } from "../../src/chat/Bands.tsx";
import { remoteTurnView } from "../../src/client/chat-logic.ts";
import type { Alert } from "../../src/client/client.ts";
import {
  BANNER_DWELL_MS,
  BANNER_STICKY_DWELL_MS,
  Banner,
  openTailscale,
  TAILSCALE_APP_STORE_URL,
  TAILSCALE_URL,
} from "../../src/ui/Banner.tsx";
import type { ReactElement } from "react";
import type { PanGesture } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider } from "../../src/theme/theme.tsx";
import { renderUi } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
const renderTop = (ui: ReactElement) =>
  renderUi(<SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>);

const alert = (kind: Alert["data"]["kind"]): Alert => ({
  decision: "banner",
  title: "Clio",
  body: "Done: the volume is mounted at /data.",
  data: { fleet_id: "fxtr0001", instance: "atlas", bot: "clio", session: "s-1", kind, dedupe: "d-1" },
  category: null,
});

describe("Banner", () => {
  afterEach(() => jest.useRealTimers());

  test("tap opens, the close button dismisses, and nothing is drawn without an alert", async () => {
    const onOpen = jest.fn();
    const onDismiss = jest.fn();
    const a = alert("turn.done");
    await renderTop(<Banner alert={a} onOpen={onOpen} onDismiss={onDismiss} />);
    expect(screen.getByText("Clio")).toBeTruthy();
    expect(screen.getByText("Done: the volume is mounted at /data.")).toBeTruthy();
    await fireEvent.press(screen.getByText("Clio"));
    expect(onOpen).toHaveBeenCalledWith(a);
    await fireEvent.press(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await renderTop(<Banner alert={null} onOpen={onOpen} onDismiss={onDismiss} />);
    expect(screen.queryByTestId("alert-banner")).toBeNull();
  });

  test("an arrival leaves on its own; needs-you stays longer, tagged, but not for good", async () => {
    jest.useFakeTimers();
    const onDismiss = jest.fn();
    await renderTop(<Banner alert={alert("turn.done")} onOpen={jest.fn()} onDismiss={onDismiss} />);
    jest.advanceTimersByTime(BANNER_DWELL_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const sticky = jest.fn();
    await renderTop(<Banner alert={alert("needs_action")} onOpen={jest.fn()} onDismiss={sticky} />);
    expect(screen.getByText("Needs you")).toBeTruthy();
    jest.advanceTimersByTime(BANNER_DWELL_MS);
    expect(sticky).not.toHaveBeenCalled();
    jest.advanceTimersByTime(BANNER_STICKY_DWELL_MS - BANNER_DWELL_MS);
    expect(sticky).toHaveBeenCalledTimes(1);
  });
});

describe("Banner gestures and VoiceOver", () => {
  test("a swipe up dismisses; a short pull springs back", async () => {
    const onDismiss = jest.fn();
    await renderTop(<Banner alert={alert("turn.done")} onOpen={jest.fn()} onDismiss={onDismiss} />);
    const pan = getByGestureTestId("banner-swipe");
    fireGestureHandler(pan, [{ translationY: -4 }, { translationY: -10, velocityY: 0 }]);
    expect(onDismiss).not.toHaveBeenCalled();
    fireGestureHandler(pan, [{ translationY: -10 }, { translationY: -40, velocityY: 0 }]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("a pan that started on one alert neither moves nor dismisses the alert that replaced it", async () => {
    // `fireGestureHandler` runs a whole gesture in one call, so nothing can
    // re-render between its start and its end; the pan's own callbacks are
    // called instead, with the new alert rendered in between.
    const onDismiss = jest.fn();
    const tree = (a: Alert) => (
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={METRICS}>
          <Banner alert={a} onOpen={jest.fn()} onDismiss={onDismiss} />
        </SafeAreaProvider>
      </ThemeProvider>
    );
    const first = alert("turn.done");
    const view = await render(tree(first));
    const pan = getByGestureTestId("banner-swipe") as PanGesture;
    const { onStart, onEnd, onFinalize } = pan.handlers;
    const up = { translationY: -40, velocityY: 0 } as never;
    // The control: start and end on one alert dismisses it.
    onStart?.(up);
    onEnd?.(up, true);
    onFinalize?.(up, true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Replaced mid-swipe: the rest of that pan is not the new card's.
    onStart?.(up);
    await view.rerender(tree({ ...alert("needs_action"), body: "Approve rm -rf build?" }));
    onEnd?.(up, true);
    onFinalize?.(up, true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("the card offers Dismiss as an action and to the escape scrub, and activate opens", async () => {
    const onOpen = jest.fn();
    const onDismiss = jest.fn();
    const a = alert("needs_action");
    await renderTop(<Banner alert={a} onOpen={onOpen} onDismiss={onDismiss} />);
    const card = screen.getByHintText("Opens the conversation.");
    expect(card.props.accessibilityActions).toEqual([
      { name: "activate" },
      { name: "dismiss", label: "Dismiss" },
    ]);
    await fireEvent(card, "accessibilityAction", { nativeEvent: { actionName: "dismiss" } });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await fireEvent(card, "accessibilityEscape");
    expect(onDismiss).toHaveBeenCalledTimes(2);
    await fireEvent(card, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    expect(onOpen).toHaveBeenCalledWith(a);
  });
});

describe("openTailscale", () => {
  test("Open Tailscale uses the app when iOS says it can, else the App Store", async () => {
    const opened: string[] = [];
    const linking = (can: boolean) => ({
      canOpenURL: async () => can,
      openURL: async (url: string) => {
        opened.push(url);
        return true;
      },
    });
    await openTailscale(linking(true));
    await openTailscale(linking(false));
    expect(opened).toEqual([TAILSCALE_URL, TAILSCALE_APP_STORE_URL]);
  });
});

describe("ThreadBand — missing bot", () => {
  test("names the instance and the bot, once", async () => {
    await renderUi(<ThreadBand state="missing" instance="atlas" bot="ghost" />);
    expect(screen.getByText("atlas has no bot named ghost.")).toBeTruthy();
    expect(screen.getByText(/link may be out of date/)).toBeTruthy();
  });

  test("a missing session says so instead", async () => {
    await renderUi(<ThreadBand state="missing" instance="atlas" bot="scribe" session="s-9" />);
    expect(screen.getByText("scribe on atlas has no such session.")).toBeTruthy();
  });
});

describe("RemoteBand", () => {
  test("a turn still running on the box says so; nothing when there is none", async () => {
    await renderUi(<RemoteBand remote={remoteTurnView("working")} />);
    expect(screen.getByTestId("band-remote")).toBeTruthy();
    expect(screen.getByText("Still running on the box.")).toBeTruthy();
    await renderUi(<RemoteBand remote={null} />);
    expect(screen.queryByTestId("band-remote")).toBeNull();
  });

  test("waiting sends the operator to the desktop, or to Stop", async () => {
    await renderUi(<RemoteBand remote={remoteTurnView("waiting")} />);
    expect(screen.getByText("Still running on the box — waiting on you.")).toBeTruthy();
    expect(
      screen.getByText(/^Waiting on you — answer from the desktop, or stop the turn here\./),
    ).toBeTruthy();
    expect(screen.queryByText(/Open the request from history/)).toBeNull();
  });
});
