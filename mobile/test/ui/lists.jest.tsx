import { fireEvent, screen } from "@testing-library/react-native";
import { botMenuItems } from "../../src/bots/botMenu.ts";
import { badgeAt, edgeBadge, fittedBox, HomeBotRow } from "../../src/bots/HomeBotRow.tsx";
import { HERO_MANY, HERO_SOLO, HomeHero, heroSize } from "../../src/bots/HomeHero.tsx";
import type { HomeRow } from "../../src/client/home-rows.ts";
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
    await renderUi(row({ badge: "!", failed: true, suffix: "scribe-2" }));
    expect(screen.getByTestId("row-needs")).toBeTruthy();
    expect(screen.queryByTestId("row-unread")).toBeNull();
    expect(screen.getByTestId("row-failed")).toBeTruthy();
    expect(screen.getByText(" · scribe-2")).toBeTruthy();
    expect(screen.getByLabelText("Scribe (scribe-2), needs you, last turn failed")).toBeTruthy();
  });

  test("no preview: one centred line, the marks beside the time", async () => {
    const quiet = bot({ name: "scribe", title: "", last_message_at: minutesAgo(5) });
    await renderUi(row({ bot: quiet, badge: "1" }));
    expect(screen.queryByText("No messages yet")).toBeNull();
    const time = screen.getByText(/^\d{1,2}:\d{2} [AP]M$/);
    const dot = screen.getByTestId("row-unread");
    // The dot shares the time's line rather than a second, empty one.
    expect(time.parent?.parent).toBe(dot.parent?.parent?.parent);
  });

  test("the operator's last word drops the You: prefix for the sent glyph", async () => {
    await renderUi(row({ bot: bot({ preview: "ship it", preview_role: "user" }) }));
    expect(screen.getByText("ship it")).toBeTruthy();
    expect(screen.queryByText(/^You:/)).toBeNull();
  });
});

describe("HomeHero", () => {
  const heroRow = (over: Partial<HomeRow> = {}): HomeRow => ({
    key: "atlas/ops",
    bot: bot({ name: "ops", title: "Ops" }),
    badge: null,
    suffix: null,
    reachable: true,
    failed: false,
    pinned: false,
    clearable: false,
    ...over,
  });

  test("unread and needs-you badges sit on the avatar; defaults carry no star", async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    await renderUi(
      <HomeHero
        rows={[heroRow({ badge: "2" })]}
        starred={false}
        fleetId="fxtr0001"
        onPress={onPress}
        onLongPress={onLongPress}
      />,
    );
    expect(screen.getByTestId("hero-unread")).toBeTruthy();
    expect(screen.queryByTestId("hero-star")).toBeNull();
    const ops = screen.getByLabelText("Default bot: Ops, 2 unread");
    await fireEvent.press(ops);
    expect(onPress).toHaveBeenCalledWith(expect.objectContaining({ key: "atlas/ops" }));
    await fireEvent(ops, "longPress");
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  test("pins: a star each; needs-you on one, a down box dimmed and said", async () => {
    await renderUi(
      <HomeHero
        rows={[
          heroRow({ badge: "!", pinned: true }),
          heroRow({
            key: "corvid/wren",
            bot: bot({ instance: "corvid", name: "wren", title: "Wren" }),
            reachable: false,
            pinned: true,
          }),
        ]}
        starred
        fleetId="fxtr0001"
        onPress={jest.fn()}
        onLongPress={jest.fn()}
      />,
    );
    expect(screen.getAllByTestId("hero-star")).toHaveLength(2);
    expect(screen.getByTestId("hero-needs")).toBeTruthy();
    expect(screen.queryByTestId("hero-unread")).toBeNull();
    expect(screen.getByLabelText("Pinned bot: Wren, box not answering")).toBeTruthy();
  });

  test("hero size: one is larger; three of the smaller fit a 393 pt phone", () => {
    expect(heroSize(1)).toBe(HERO_SOLO);
    expect(heroSize(3)).toBe(HERO_MANY);
    expect(HERO_SOLO).toBeGreaterThan(HERO_MANY);
    expect(3 * (HERO_MANY + 24) + 2 * 12).toBeLessThanOrEqual(393);
  });

  test("badges sit on the blob's edge at 45 degrees, not the box corner", () => {
    const { left, top } = edgeBadge(100, 20, "top");
    // Centre at (50 + 35.36, 50 - 35.36).
    expect(left + 10).toBeCloseTo(85.36, 1);
    expect(top + 10).toBeCloseTo(14.64, 1);
    expect(edgeBadge(100, 20, "bottom").top + 10).toBeCloseTo(85.36, 1);
  });

  test("sigil and pixel draw inset in the frame; their badges sit on the frame's corner", () => {
    expect(fittedBox("blob", 100)).toBe(125);
    expect(fittedBox("sigil", 100)).toBe(84);
    expect(fittedBox("pixel", 100)).toBe(84);
    expect(badgeAt("blob", 100, 20, "top")).toEqual(edgeBadge(100, 20, "top"));
    expect(badgeAt("sigil", 100, 26, "bottom")).toEqual({ left: 74, top: 74 });
    expect(badgeAt("pixel", 100, 20, "top")).toEqual({ left: 80, top: 0 });
    // The badge's outer edge clears the inset face's corner, so no cell shows past its ring.
    const face = (100 + fittedBox("sigil", 100)) / 2;
    expect(badgeAt("sigil", 100, 26, "bottom").left + 26).toBeGreaterThan(face);
  });
});

describe("botMenuItems", () => {
  test("pin or unpin, the browser, and mark read only when it clears something", () => {
    expect(botMenuItems({ pinned: false, clearable: true }).map((i) => i.label)).toEqual([
      "Pin",
      "Open agent browser",
      "Mark read",
    ]);
    expect(botMenuItems({ pinned: true, clearable: false }).map((i) => i.label)).toEqual([
      "Unpin",
      "Open agent browser",
    ]);
    expect(botMenuItems({ pinned: false, clearable: false }).map((i) => i.run)).not.toContain(
      "markRead",
    );
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
