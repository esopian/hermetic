import type { ChatCommand } from "@hermetic/core/schema";
import { fireEvent, screen } from "@testing-library/react-native";
import { resetSlashCatalogs, SlashPicker } from "../../src/chat/SlashPicker.tsx";
import { renderUi } from "../helpers/render.tsx";

const command = (name: string, extra: Partial<ChatCommand> = {}): ChatCommand => ({
  name,
  description: `${name} does a thing`,
  category: "Session",
  argument_mode: "text",
  desktop: null,
  skill: null,
  ...extra,
});

const CATALOG = [command("/help"), command("/theme"), command("/skin", { desktop: "terminal" })];

beforeEach(() => resetSlashCatalogs());

describe("slash picker", () => {
  test("lists matching commands once a name is typed, fetched once per bot", async () => {
    const load = jest.fn(async () => ({ commands: CATALOG }));
    const onPick = jest.fn();
    const source = { key: "f/atlas/scribe", load };
    const view = await renderUi(<SlashPicker text="/he" source={source} onPick={onPick} />);
    const rows = await screen.findAllByRole("menuitem");
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
      "/help, /help does a thing",
      "/theme, /theme does a thing",
    ]);
    await fireEvent.press(rows[0]!);
    expect(onPick).toHaveBeenCalledWith("/help ");

    await view.rerender(<SlashPicker text="/sk" source={source} onPick={onPick} />);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    await view.rerender(<SlashPicker text="hello" source={source} onPick={onPick} />);
    expect(screen.queryByLabelText("Slash commands")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("a failed fetch shows nothing and is asked again next time", async () => {
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error("UNSUPPORTED"))
      .mockResolvedValue({ commands: CATALOG });
    const source = { key: "f/atlas/scribe", load };
    const view = await renderUi(<SlashPicker text="/" source={source} onPick={jest.fn()} />);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    await view.unmount();
    await renderUi(<SlashPicker text="/" source={source} onPick={jest.fn()} />);
    expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
