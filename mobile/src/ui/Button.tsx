/**
 * Buttons per `docs/ui-brief.md`: primary is fg fill / bg text / 900 uppercase
 * and turns accent when pressed; secondary is a 2px fg outline; destructive is
 * a bad outline that fills when pressed. Zero radius. 44pt tall minimum.
 *
 * `soft` is the app's chrome look (home, Settings, sheets, and the chat's
 * cards and composer): the same colours in a rounded pill with a
 * sentence-case label, and a thin outline for the secondary and destructive
 * variants. The square slab is the desktop's and the pairing screen's.
 *
 * A disabled primary (Send with an empty draft) is drawn in its own colours,
 * not faded: fading the fg fill left a grey block whose label fell under 3:1
 * in the light scheme. `primaryColors` is the one place that decides.
 */
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  Text as RNText,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme.tsx";
import type { Palette } from "../theme/tokens.ts";
import { haptic as tap } from "./haptics.ts";
import { textColor } from "./text-colors.ts";

export type ButtonVariant = "primary" | "secondary" | "destructive";

export interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  label: string;
  variant?: ButtonVariant;
  busy?: boolean;
  compact?: boolean;
  /** A light tap on press (default on). */
  haptic?: boolean;
  /** Rounded pill, sentence-case label (home, Settings, sheets). */
  soft?: boolean;
  style?: ViewStyle;
}

/** A primary button's fill, edge and label colour. Disabled reads as a quiet, legible slab. */
export function primaryColors(
  c: Pick<Palette, "fg" | "fg2" | "bg" | "bg3" | "line2" | "acc" | "accFg">,
  state: { pressed: boolean; disabled: boolean },
): { fill: string; edge: string; text: string } {
  if (state.disabled) return { fill: c.bg3, edge: c.line2, text: c.fg2 };
  if (state.pressed) return { fill: c.acc, edge: c.acc, text: c.accFg };
  return { fill: c.fg, edge: c.fg, text: c.bg };
}

export function Button({
  label,
  variant = "primary",
  busy = false,
  compact = false,
  haptic = true,
  soft = false,
  disabled,
  onPress,
  style,
  ...rest
}: ButtonProps) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale > 1;
  const off = !!disabled || busy;
  // Busy keeps the live colours (faded); only a plain disabled primary is redrawn.
  const quiet = !!disabled && !busy && variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={(e) => {
        if (haptic) tap.select();
        onPress?.(e);
      }}
      {...rest}
      style={({ pressed }) => {
        const primary = primaryColors(t.c, { pressed, disabled: quiet });
        const fill =
          variant === "primary"
            ? primary.fill
            : variant === "destructive" && pressed
              ? t.c.bad
              : "transparent";
        const edge =
          variant === "destructive"
            ? t.c.bad
            : variant === "primary"
              ? primary.edge
              : soft
                ? t.c.line2
                : t.c.fg;
        const height = t.touch.min;
        return [
          {
            minHeight: height,
            paddingHorizontal: compact ? t.space.md : t.space.lg,
            paddingVertical: t.space.xs,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: t.space.sm,
            backgroundColor: fill,
            borderWidth: soft && variant !== "primary" ? 1 : t.border.control,
            borderColor: edge,
            borderRadius: soft ? height / 2 : 0,
            opacity: off && !quiet ? 0.45 : 1,
          } satisfies ViewStyle,
          style,
        ];
      }}
    >
      {({ pressed }) => {
        const color =
          variant === "primary"
            ? primaryColors(t.c, { pressed, disabled: quiet }).text
            : variant === "destructive"
              ? pressed
                ? t.c.dangerText
                : textColor(t.c, t.scheme, "bad")
              : t.c.fg;
        return (
          <>
            {busy ? <ActivityIndicator size="small" color={color} /> : null}
            {/* Normal text can fit compact paired actions. Larger text wraps
                and grows the button instead of undoing the user's text size. */}
            <RNText
              numberOfLines={largeText ? undefined : 1}
              adjustsFontSizeToFit={!largeText}
              minimumFontScale={0.75}
              style={{
                flexShrink: 1,
                textAlign: "center",
                color,
                ...(soft
                  ? { fontFamily: t.sans(600), fontSize: compact ? 13 : 16 }
                  : {
                      fontFamily: t.sans(variant === "primary" ? 900 : 700),
                      fontSize: compact ? 11 : 13,
                      letterSpacing: 0.6,
                      textTransform: "uppercase" as const,
                    }),
              }}
            >
              {label}
            </RNText>
          </>
        );
      }}
    </Pressable>
  );
}
