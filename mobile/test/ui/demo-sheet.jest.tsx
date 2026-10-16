/**
 * The fixture's demo prompts (`src/chat/DemoSheet.tsx`, the overflow entry in
 * `conversationMenu`): the sheet lists the kit's prompts by group and sends the
 * one picked; the menu offers it only when the build has a list. The screen's
 * own wiring (`?demo=`, the entry absent without the fixture) is in
 * `conversation-screen.jest.tsx`.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { ActionSheetIOS } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { conversationMenu } from "../../src/chat/ChatHeader.tsx";
import { DemoSheet, demoGroups } from "../../src/chat/DemoSheet.tsx";
import type { DemoPrompt } from "../../src/fleet/FleetProvider.tsx";
import { FIXTURE_DEMO_PROMPTS } from "../../src/fixture/index.ts";
import { renderUi } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const PROMPTS: DemoPrompt[] = [
  { group: "Text", label: "Plain", prompt: "say something" },
  { group: "Errors", label: "rate limited", prompt: "fail slowly" },
  { group: "Text", label: "Rich", prompt: "say it with a table" },
];

async function drawSheet(prompts: readonly DemoPrompt[], visible = true) {
  const onPick = jest.fn();
  const onClose = jest.fn();
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <DemoSheet visible={visible} prompts={prompts} onPick={onPick} onClose={onClose} />
    </SafeAreaProvider>,
  );
  return { onPick, onClose };
}

describe("demoGroups", () => {
  test("groups in first-seen order, prompts in list order", () => {
    expect(demoGroups(PROMPTS).map((g) => [g.group, g.items.map((i) => i.label)])).toEqual([
      ["Text", ["Plain", "Rich"]],
      ["Errors", ["rate limited"]],
    ]);
  });
});

describe("DemoSheet", () => {
  test("lists every group with its count, and every prompt with its text", async () => {
    await drawSheet(PROMPTS);
    expect(screen.getByText("Text · 2")).toBeTruthy();
    expect(screen.getByText("Errors · 1")).toBeTruthy();
    for (const p of PROMPTS) {
      expect(screen.getByLabelText(`${p.group}: ${p.label}`)).toBeTruthy();
      expect(screen.getByText(p.prompt)).toBeTruthy();
    }
  });

  test("a tap closes the sheet and sends that prompt", async () => {
    const { onPick, onClose } = await drawSheet(PROMPTS);
    await fireEvent.press(screen.getByLabelText("Errors: rate limited"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("fail slowly");
  });

  test("draws the fixture kit's whole list", async () => {
    await drawSheet(FIXTURE_DEMO_PROMPTS);
    for (const group of new Set(FIXTURE_DEMO_PROMPTS.map((p) => p.group)))
      expect(screen.getByText(new RegExp(`^${group} · \\d+$`))).toBeTruthy();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(FIXTURE_DEMO_PROMPTS.length);
  });

  test("hidden, it draws nothing", async () => {
    await drawSheet(PROMPTS, false);
    expect(screen.queryByText("Demo prompts")).toBeNull();
  });
});

describe("conversationMenu", () => {
  const actions = { sessions: jest.fn(), browser: jest.fn(), markRead: jest.fn() };

  test("offers Demo prompts… only when the build has a list, and opens it", () => {
    let seen: string[] = [];
    let pick: ((i: number) => void) | null = null;
    const sheet = jest
      .spyOn(ActionSheetIOS, "showActionSheetWithOptions")
      .mockImplementation((o, cb) => {
        seen = o.options;
        pick = cb;
      });
    conversationMenu("scribe", "#fff", actions);
    expect(seen).toEqual(["Sessions", "Agent browser", "Mark read", "Cancel"]);
    const demo = jest.fn();
    conversationMenu("scribe", "#fff", { ...actions, demo });
    expect(seen).toEqual(["Sessions", "Agent browser", "Mark read", "Demo prompts…", "Cancel"]);
    (pick as unknown as (i: number) => void)(3);
    expect(demo).toHaveBeenCalledTimes(1);
    sheet.mockRestore();
  });
});
