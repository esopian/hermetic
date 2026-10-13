import { fireEvent, screen } from "@testing-library/react-native";
import { SocketBand, ThreadBand } from "../../src/chat/Bands.tsx";
import { ThemeProvider } from "../../src/theme/theme.tsx";
import { renderUi } from "../helpers/render.tsx";

const main = { fleet_id: "fxtr0001", alias: "main" };

describe("SocketBand — wrong fleet", () => {
  test("names the fleet the bridge serves now and offers a re-pair, not a retry", async () => {
    const onRePair = jest.fn();
    const onRetry = jest.fn();
    await renderUi(
      <SocketBand
        state="wrong_fleet"
        servedFleet={{ fleet_id: "sg7k2m4p", alias: "staging" }}
        pairedFleet={main}
        onRetry={onRetry}
        onRePair={onRePair}
      />,
    );
    expect(screen.getByText("This bridge now serves staging; re-pair to use it.")).toBeTruthy();
    expect(screen.getByText(/paired with main/)).toBeTruthy();
    expect(screen.queryByLabelText("Retry")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Re-pair"));
    expect(onRePair).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("an unaliased fleet reads as its id; a bare refusal says another fleet", async () => {
    const { rerender } = await renderUi(
      <SocketBand
        state="wrong_fleet"
        servedFleet={{ fleet_id: "sg7k2m4p", alias: null }}
        pairedFleet={main}
      />,
    );
    expect(screen.getByText("This bridge now serves sg7k2m4p; re-pair to use it.")).toBeTruthy();
    await rerender(
      <ThemeProvider>
        <SocketBand state="wrong_fleet" servedFleet={null} pairedFleet={main} />
      </ThemeProvider>,
    );
    expect(screen.getByText(/serves another fleet; re-pair/)).toBeTruthy();
  });

  test("an unauthorized phone still reads as revoked", async () => {
    await renderUi(<SocketBand state="unauthorized" />);
    expect(screen.getByText("The bridge no longer knows this phone.")).toBeTruthy();
    expect(screen.getByText(/never re-paired after a laptop upgrade/)).toBeTruthy();
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
