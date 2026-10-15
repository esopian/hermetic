/**
 * Text in the product's two families. `variant` picks size and family;
 * `weight` picks the static face (never `fontWeight`, see `theme/fonts.ts`).
 */
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import type { Weight } from "../theme/fonts.ts";
import { useTheme } from "../theme/theme.tsx";
import { textColor, type TextTone } from "./text-colors.ts";

export type TextVariant = "body" | "bodySmall" | "caption" | "mono" | "title" | "heading" | "display";
export type { TextTone } from "./text-colors.ts";

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  weight?: Weight;
  tone?: TextTone;
  /** Force mono (identifiers, IPs, timestamps). `variant="mono"` implies it. */
  mono?: boolean;
  uppercase?: boolean;
}

export function Text({
  variant = "body",
  weight,
  tone = "fg",
  mono,
  uppercase,
  style,
  ...rest
}: TextProps) {
  const t = useTheme();
  const scale = t.type[variant];
  const isMono = mono || variant === "mono";
  const w: Weight =
    weight ?? (variant === "display" || variant === "heading" ? 800 : variant === "title" ? 700 : 400);
  const base: TextStyle = {
    color: textColor(t.c, t.scheme, tone),
    fontFamily: isMono ? t.mono(w) : t.sans(w),
    fontSize: scale.size,
    ...("lineHeight" in scale ? { lineHeight: scale.lineHeight } : {}),
    ...("letterSpacing" in scale ? { letterSpacing: scale.letterSpacing } : {}),
    ...(uppercase ? { textTransform: "uppercase" } : {}),
  };
  return <RNText {...rest} style={[base, style]} />;
}
