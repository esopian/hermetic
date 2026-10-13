/**
 * Buttons per `docs/ui-brief.md`: primary is fg fill / bg text / 900 uppercase
 * and turns accent when pressed; secondary is a 2px fg outline; destructive is
 * a bad outline that fills when pressed. Zero radius. 44pt tall minimum.
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
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme.tsx";
import type { Palette } from "../theme/tokens.ts";
import { haptic as tap } from "./haptics.ts";

export type ButtonVariant = "primary" | "secondary" | "destructive";

export interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  label: string;
  variant?: ButtonVariant;
  busy?: boolean;
  compact?: boolean;
  /** A light tap on press (default on). */
  haptic?: boolean;
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
  disabled,
  onPress,
  style,
  ...rest
}: ButtonProps) {
  const t = useTheme();
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
          variant === "destructive" ? t.c.bad : variant === "primary" ? primary.edge : t.c.fg;
        return [
          {
            minHeight: compact ? 32 : t.touch.min,
            paddingHorizontal: compact ? t.space.md : t.space.lg,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: t.space.sm,
            backgroundColor: fill,
            borderWidth: t.border.control,
            borderColor: edge,
            borderRadius: 0,
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
                : t.c.bad
              : t.c.fg;
        return (
          <>
            {busy ? <ActivityIndicator size="small" color={color} /> : null}
            {/* One line, centred, shrinking a little before it would wrap: a
                two-up row of buttons on a phone ("Approve once" beside "This
                session") otherwise breaks one label over two ragged lines. */}
            <RNText
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              style={{
                flexShrink: 1,
                textAlign: "center",
                color,
                fontFamily: t.sans(variant === "primary" ? 900 : 700),
                fontSize: compact ? 11 : 13,
                letterSpacing: 0.6,
                textTransform: "uppercase",
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
