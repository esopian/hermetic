import { fireEvent, screen } from "@testing-library/react-native";
import { botMenuItems } from "../../src/bots/botMenu.ts";
import { HomeBotRow } from "../../src/bots/HomeBotRow.tsx";
import { HomeHero } from "../../src/bots/HomeHero.tsx";
import { inQuietHours } from "../../src/client/inbox-logic.ts";
import { previewLine } from "../../src/client/roster-rows.ts";
import { palettes } from "../../src/theme/tokens.ts";
import { bot } from "../helpers/fixtures.ts";
import { NOW, renderUi } from "../helpers/render.tsx";

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("previewLine", () => {
  test("the operator's own last word reads 'You:'", () => {
    expect(previewLine(bot({ preview: "ship it", preview_role: "user" }))).toBe("You: ship it");
    expect(previewLine(bot({ preview: "done\nnext", preview_role: "bot" }))).toBe("done next");
    expect(previewLine(bot({}))).toBe("No messages yet");
  });

  test("a last message with nothing to quote falls back to description, then name", () => {
    const empty = bot({ name: "fresh" });
    expect(previewLine(empty)).toBe("No messages yet");
    const quoted = bot({ name: "scribe", title: "Digest writer", last_message_at: minutesAgo(5) });
    expect(previewLine(quoted)).toBe("scribe");
    expect(previewLine({ ...quoted, description: "Writes the digest." })).toBe("Writes the digest.");
    expect(previewLine({ ...empty, description: "Writes the digest." })).toBe("Writes the digest.");
  });

  test("the name fallback is dropped when the row already shows the name", () => {
    const at = minutesAgo(5);
    expect(previewLine(bot({ name: "scribe", title: "", last_message_at: at }))).toBe("");
    expect(
      previewLine(bot({ name: "default", title: "ember", is_default: true, last_message_at: at })),
    ).toBe("");
    expect(previewLine(bot({ name: "magpie", title: "Magpie", last_message_at: at }))).toBe("");
    expect(
      previewLine(bot({ name: "ops", title: "ember", is_default: true, last_message_at: at })),
    ).toBe("ops");
  });
});

describe("HomeBotRow", () => {
  const row = (over: Partial<Parameters<typeof HomeBotRow>[0]> = {}) => (
    <HomeBotRow
      bot={bot({ name: "scribe", title: "Scribe" })}
      fleetId="fxtr0001"
      now={NOW}
      badge={null}
      suffix={null}
      reachable
      onPress={jest.fn()}
      {...over}
    />
  );

  test("a bot with no messages shows no time and no marker", async () => {
    await renderUi(row());
    expect(screen.getByText("No messages yet")).toBeTruthy();
    expect(screen.queryByTestId("row-unread")).toBeNull();
    expect(screen.queryByTestId("row-needs")).toBeNull();
    expect(screen.queryByTestId("row-failed")).toBeNull();
  });

  test("unread: an accent dot, the time, the preview; press and long-press", async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const b = bot({
      name: "scribe",
      title: "Scribe",
      unread: 3,
      preview: "the draft is ready",
      last_message_at: minutesAgo(5),
    });
    await renderUi(row({ bot: b, badge: "3", onPress, onLongPress }));
    expect(screen.getByText("the draft is ready")).toBeTruthy();
    expect(screen.getByText(/^\d{1,2}:\d{2} [AP]M$/)).toBeTruthy();
    const dot = screen.getByTestId("row-unread").props.style.backgroundColor;
    expect([palettes.dark.acc, palettes.light.acc]).toContain(dot);
    const pressable = screen.getByLabelText("Scribe, 3 unread");
    await fireEvent.press(pressable);
    expect(onPress).toHaveBeenCalledTimes(1);
    await fireEvent(pressable, "longPress");
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  test("needs you: the gold pill instead of the dot; failed: the red mark; suffix", async () => {
    await renderUi(row({ badge: "!", failed: true, suffix: "corvid" }));
    expect(screen.getByTestId("row-needs")).toBeTruthy();
    expect(screen.queryByTestId("row-unread")).toBeNull();
    expect(screen.getByTestId("row-failed")).toBeTruthy();
    expect(screen.getByText(" · corvid")).toBeTruthy();
    expect(screen.getByLabelText("Scribe on corvid, needs you, last turn failed")).toBeTruthy();
  });

  test("the operator's last word drops the You: prefix for the sent glyph", async () => {
    await renderUi(row({ bot: bot({ preview: "ship it", preview_role: "user" }) }));
    expect(screen.getByText("ship it")).toBeTruthy();
    expect(screen.queryByText(/^You:/)).toBeNull();
  });
});

describe("HomeHero", () => {
  test("unread and needs-you badges sit on the avatar; a down box says so", async () => {
    const onPress = jest.fn();
    await renderUi(
      <HomeHero
        bot={bot({ name: "ops", title: "Ops" })}
        fleetId="fxtr0001"
        badge="2"
        suffix={null}
        reachable
        status={null}
        onPress={onPress}
      />,
    );
    expect(screen.getByTestId("hero-unread")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Primary bot: Ops, 2 unread"));
    expect(onPress).toHaveBeenCalledTimes(1);

    await renderUi(
      <HomeHero
        bot={bot({ name: "ops", title: "Ops" })}
        fleetId="fxtr0001"
        badge="!"
        suffix={null}
        reachable={false}
        status="corvid is stopped"
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByTestId("hero-needs")).toBeTruthy();
    expect(screen.queryByTestId("hero-unread")).toBeNull();
    expect(screen.getByText("corvid is stopped")).toBeTruthy();
  });
});

describe("botMenuItems", () => {
  test("make primary, pin or unpin, the browser, and mark read only when there is something", () => {
    expect(botMenuItems({ primary: false, pinned: false, unread: true }).map((i) => i.label)).toEqual([
      "Make primary",
      "Pin",
      "Open agent browser",
      "Mark read",
    ]);
    expect(botMenuItems({ primary: false, pinned: true, unread: false }).map((i) => i.label)).toEqual([
      "Make primary",
      "Unpin",
      "Open agent browser",
    ]);
    expect(botMenuItems({ primary: true, pinned: false, unread: true }).map((i) => i.run)).toEqual([
      "openBrowser",
      "markRead",
    ]);
  });
});

describe("quiet hours", () => {
  test("they cross midnight, and equal ends are off", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m);
    const q = { enabled: true, start: "22:00", end: "07:00" };
    expect(inQuietHours(at(23), q)).toBe(true);
    expect(inQuietHours(at(6, 59), q)).toBe(true);
    expect(inQuietHours(at(7), q)).toBe(false);
    expect(inQuietHours(at(23), { ...q, end: "22:00" })).toBe(false);
    expect(inQuietHours(at(23), { ...q, enabled: false })).toBe(false);
  });
});
