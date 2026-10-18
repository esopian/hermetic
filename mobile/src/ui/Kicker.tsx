/** Kicker label: 10px / 700 / 0.14em / uppercase / fg3 (`docs/ui-brief.md`). */
import { Text as RNText, type TextProps } from "react-native";
import { useTheme } from "../theme/theme.tsx";

export function Kicker({
  style,
  tone,
  ...rest
}: TextProps & { tone?: "fg3" | "warn" | "bad" | "acc" | "fg2" }) {
  const t = useTheme();
  return (
    <RNText
      {...rest}
      style={[
        {
          color: t.c[tone ?? "fg3"],
          fontFamily: t.sans(700),
          fontSize: t.type.kicker.size,
          letterSpacing: t.type.kicker.letterSpacing,
          textTransform: "uppercase",
        },
        style,
      ]}
    />
  );
}
