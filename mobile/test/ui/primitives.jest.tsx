import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactNative from "react-native";
import { Appearance } from "react-native";
import { buildTheme, ThemeProvider } from "../../src/theme/theme.tsx";
import { palettes, statusColor } from "../../src/theme/tokens.ts";
import { buildBlob } from "../../src/ui/avatar/Avatar.tsx";
import { avatarPalette, avatarSeed, hslHex, rngFor } from "../../src/ui/avatar/avatar-seed.ts";
import { primaryColors } from "../../src/ui/Button.tsx";
import { codeSpans } from "../../src/ui/codeSpans.tsx";
import { Avatar, Badge, Button, Kicker, Text, ToggleSwitch } from "../../src/ui/index.ts";

describe("theme", () => {
  test("tokens are the desktop's, verbatim", () => {
    expect(palettes.dark).toMatchObject({
      bg: "#0e0e0d",
      fg: "#f1efe9",
      acc: "#ff5a1f",
      warn: "#e8b03a",
    });
    expect(palettes.light).toMatchObject({
      bg: "#f1efe9",
      fg: "#111110",
      ok: "#188a55",
      sel: "#e3e0d7",
    });
  });

  test("status colours follow the ui-brief mapping", () => {
    const p = palettes.dark;
    expect(statusColor(p, "ready")).toEqual({ color: p.ok, pulse: false });
    expect(statusColor(p, "unreachable").color).toBe(p.bad);
    expect(statusColor(p, "stopped").color).toBe(p.fg3);
    expect(statusColor(p, "bootstrapping")).toEqual({ color: p.acc, pulse: true });
  });

  test("buildTheme picks the palette", () => {
    expect(buildTheme("light").c.bg).toBe("#f1efe9");
  });

  test("native chrome follows the app's scheme, and the system's when the app defers", async () => {
    const set = jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
    await render(<ThemeProvider initial="light">{null}</ThemeProvider>);
    expect(set).toHaveBeenLastCalledWith("light");
    await render(<ThemeProvider initial="system">{null}</ThemeProvider>);
    expect(set).toHaveBeenLastCalledWith("unspecified");
    set.mockRestore();
  });
});

describe("avatar identity", () => {
  test("seeded from fleet/instance/bot, same as the desktop", () => {
    expect(avatarSeed("fxtr0001", "atlas", "scribe")).toBe("fxtr0001/atlas/scribe");
    expect(avatarSeed("", "", "x")).toBe("_/_/x");
  });

  test("deterministic: the same key builds the same face; another key does not", () => {
    const a = buildBlob("fxtr0001/atlas/scribe", false, true);
    expect(buildBlob("fxtr0001/atlas/scribe", false, true)).toEqual(a);
    expect(buildBlob("fxtr0001/atlas/other", false, true).frame.front).not.toBe(a.frame.front);
    expect(a.frame.front.startsWith("M")).toBe(true);
  });

  test("the palette never lands in the accent's reserved hue band", () => {
    for (let i = 0; i < 200; i++) {
      const p = avatarPalette(rngFor(`k${i}`), false);
      expect(p.h > 14 && p.h < 40).toBe(false);
    }
  });

  test("hslHex", () => {
    expect(hslHex(0, 100, 50)).toBe("#ff0000");
    expect(hslHex(120, 100, 25)).toBe("#008000");
    expect(hslHex(0, 0, 100)).toBe("#ffffff");
  });
});

describe("primitives render", () => {
  test("Text, Kicker, Badge", async () => {
    await render(
      <ThemeProvider>
        <Text>hello</Text>
        <Kicker>section</Kicker>
        <Badge label="!" />
        <Badge label="3" />
        <Badge label={null} />
      </ThemeProvider>,
    );
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("section")).toBeTruthy();
    expect(screen.getByLabelText("needs you")).toBeTruthy();
    expect(screen.getByLabelText("3 unread")).toBeTruthy();
  });

  test("Button presses, and not when disabled", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Button label="Send" onPress={onPress} haptic={false} />
        <Button label="Nope" onPress={onPress} disabled haptic={false} />
      </ThemeProvider>,
    );
    await fireEvent.press(screen.getByLabelText("Send"));
    await fireEvent.press(screen.getByLabelText("Nope"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("a disabled primary (Send, empty draft) keeps a legible label in both schemes", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const scheme of ["light", "dark"] as const) {
      const c = palettes[scheme];
      const off = primaryColors(c, { pressed: false, disabled: true });
      expect(contrast(off.text, off.fill)).toBeGreaterThanOrEqual(4.5);
      // And it still reads as not the live button.
      expect(off.fill).not.toBe(primaryColors(c, { pressed: false, disabled: false }).fill);
    }
  });

  test("Avatar is its own element only when given a label", async () => {
    await render(
      <ThemeProvider>
        <Avatar fleet_id="fxtr0001" instance="atlas" bot="scribe" activity="thinking" label="Scribe" />
        <Avatar fleet_id="fxtr0001" instance="atlas" bot="quill" />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("Scribe — ready")).toBeTruthy();
    // Unlabelled (inside a row or button that names the bot), it is decoration.
    expect(screen.queryByLabelText(/quill/)).toBeNull();
  });

  test("a button label stays on one centred line at the default text size", async () => {
    const previous = ReactNative.Dimensions.get("window");
    ReactNative.Dimensions.set({ window: { ...previous, fontScale: 1 } });
    await render(
      <ThemeProvider>
        <Button label="Approve once" onPress={() => {}} haptic={false} />
      </ThemeProvider>,
    );
    const label = screen.getByText("Approve once");
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    await screen.unmount();
    ReactNative.Dimensions.set({ window: previous });
  });

  test("ToggleSwitch is a themed Switch", async () => {
    const onValueChange = jest.fn();
    await render(
      <ThemeProvider>
        <ToggleSwitch
          accessibilityLabel="Listen to atlas"
          value={false}
          onValueChange={onValueChange}
        />
      </ThemeProvider>,
    );
    await fireEvent(screen.getByLabelText("Listen to atlas"), "valueChange", true);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  test("codeSpans shows backticked runs in mono and leaves the rest", async () => {
    expect(codeSpans("no code here")).toBe("no code here");
    expect(codeSpans("one ` stray")).toBe("one ` stray");
    await render(
      <ThemeProvider>
        <Text>{codeSpans("Run `hermetic mobile pair` on the laptop.")}</Text>
      </ThemeProvider>,
    );
    expect(screen.getByText("hermetic mobile pair")).toBeTruthy();
    expect(screen.queryByText(/`/)).toBeNull();
  });
});
