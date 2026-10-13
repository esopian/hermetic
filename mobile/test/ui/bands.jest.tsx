import { fireEvent, screen } from "@testing-library/react-native";
import { RemoteBand, ThreadBand } from "../../src/chat/Bands.tsx";
import { remoteTurnView } from "../../src/client/chat-logic.ts";
import {
  openTailscale,
  TAILSCALE_APP_STORE_URL,
  TAILSCALE_URL,
  TailscaleBanner,
} from "../../src/ui/Banner.tsx";
import { renderUi } from "../helpers/render.tsx";

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
