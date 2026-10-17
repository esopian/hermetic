import { fireEvent, screen } from "@testing-library/react-native";
import { ActionSheetIOS } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChatHeader, conversationMenu } from "../../src/chat/ChatHeader.tsx";
import { renderUi } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

async function header(over: Partial<Parameters<typeof ChatHeader>[0]> = {}) {
  const props = {
    fleetId: "fxtr0001",
    instance: "atlas",
    bot: "scribe",
    title: "Scribe",
    session: null,
    status: "ready" as const,
    activity: "idle" as const,
    onBack: jest.fn(),
    onSessions: jest.fn(),
    onMore: jest.fn(),
    ...over,
  };
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ChatHeader {...props} />
    </SafeAreaProvider>,
  );
  return props;
}

describe("conversation header", () => {
  test("back, the title (session switcher) and one overflow, each labelled", async () => {
    const props = await header();
    await fireEvent.press(screen.getByLabelText("Back"));
    await fireEvent.press(screen.getByLabelText("Scribe, Bot Chat. Switch session"));
    await fireEvent.press(screen.getByLabelText("More"));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(props.onSessions).toHaveBeenCalledTimes(1);
    expect(props.onMore).toHaveBeenCalledTimes(1);
    // The avatar is not a second VoiceOver element beside the title button.
    expect(screen.queryByLabelText(/— ready/)).toBeNull();
  });

  test("a separate session names itself under the title; the Bot Chat says nothing", async () => {
    await header({ session: "Release notes" });
    expect(screen.getByText("Release notes")).toBeTruthy();
    expect(screen.getByLabelText("Scribe, Release notes. Switch session")).toBeTruthy();
  });

  test("the overflow menu runs the picked action and nothing on cancel", () => {
    const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions");
    const actions = { sessions: jest.fn(), browser: jest.fn(), markRead: jest.fn() };
    for (const pick of [0, 1, 2, 3]) {
      sheet.mockImplementationOnce((_options, callback) => callback(pick));
      conversationMenu("Scribe", "#f1efe9", actions);
    }
    expect(sheet.mock.calls[0]?.[0]).toMatchObject({
      title: "Scribe",
      options: ["Sessions", "Agent browser", "Mark read", "Cancel"],
      cancelButtonIndex: 3,
      tintColor: "#f1efe9",
    });
    expect(actions.sessions).toHaveBeenCalledTimes(1);
    expect(actions.browser).toHaveBeenCalledTimes(1);
    expect(actions.markRead).toHaveBeenCalledTimes(1);
    sheet.mockRestore();
  });
});
