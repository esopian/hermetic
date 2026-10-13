/**
 * Buttons per `docs/ui-brief.md`: primary is fg fill / bg text / 900 uppercase
 * and turns accent when pressed; secondary is a 2px fg outline; destructive is
 * a bad outline that fills when pressed. Zero radius. 44pt tall minimum.
 */
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  Text as RNText,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme.tsx";
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
        const fill =
          variant === "primary"
            ? pressed
              ? t.c.acc
              : t.c.fg
            : variant === "destructive" && pressed
              ? t.c.bad
              : "transparent";
        const edge =
          variant === "destructive" ? t.c.bad : pressed && variant === "primary" ? t.c.acc : t.c.fg;
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
            opacity: off ? 0.45 : 1,
          } satisfies ViewStyle,
          style,
        ];
      }}
    >
      {({ pressed }) => {
        const color =
          variant === "primary"
            ? pressed
              ? t.c.accFg
              : t.c.bg
            : variant === "destructive"
              ? pressed
                ? t.c.dangerText
                : t.c.bad
              : t.c.fg;
        return (
          <>
            {busy ? <ActivityIndicator size="small" color={color} /> : null}
            <RNText
              style={{
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
