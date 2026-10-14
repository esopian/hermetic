import { fireEvent, screen } from "@testing-library/react-native";
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
  TailscaleBanner,
} from "../../src/ui/Banner.tsx";
import type { ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
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

describe("TailscaleBanner", () => {
  test("off: says so and opens Tailscale, not a retry", async () => {
    const onRetry = jest.fn();
    const onOpenTailscale = jest.fn();
    await renderUi(
      <TailscaleBanner status="off" onRetry={onRetry} onOpenTailscale={onOpenTailscale} />,
    );
    expect(screen.getByText("Tailscale is off or not signed in")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Open Tailscale"));
    expect(onOpenTailscale).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("unreachable: on the tailnet, no box answers, with a retry and Open Tailscale", async () => {
    const onRetry = jest.fn();
    const onOpenTailscale = jest.fn();
    await renderUi(
      <TailscaleBanner status="unreachable" onRetry={onRetry} onOpenTailscale={onOpenTailscale} />,
    );
    expect(screen.getByText("On the tailnet, but no box answers")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText("Open Tailscale"));
    expect(onOpenTailscale).toHaveBeenCalledTimes(1);
  });

  test("the strip can be dismissed when the screen offers it", async () => {
    const onDismiss = jest.fn();
    await renderUi(<TailscaleBanner status="off" onRetry={jest.fn()} onDismiss={onDismiss} />);
    await fireEvent.press(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await renderUi(<TailscaleBanner status="off" onRetry={jest.fn()} />);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });

  test("ok, unknown and not-yet-probed draw nothing", async () => {
    for (const status of ["ok", "unknown", null] as const) {
      await renderUi(<TailscaleBanner status={status} onRetry={jest.fn()} />);
      expect(screen.queryByTestId("band-tailscale")).toBeNull();
    }
  });

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
