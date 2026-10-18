/**
 * The unread badge, a square. `!` (warn fill) when a bot needs the operator, else the
 * count (fg fill). Mirrors the desktop's `.ch-unread` / `.needs-action`.
 */
import { View } from "react-native";
import { useTheme } from "../theme/theme.tsx";
import { Text } from "./Text.tsx";

export function Badge({
  label,
  tone = "fg",
}: {
  label: string | null;
  tone?: "fg" | "warn" | "bad" | "acc";
}) {
  const t = useTheme();
  if (!label) return null;
  const needs = label === "!";
  const bg = needs ? t.c.warn : t.c[tone];
  return (
    <View
      accessible
      accessibilityLabel={needs ? "needs you" : `${label} unread`}
      style={{
        minWidth: 18,
        minHeight: 18,
        paddingVertical: 3,
        paddingHorizontal: 5,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
      }}
    >
      <Text
        variant="caption"
        mono
        weight={700}
        style={{
          color:
            needs || tone === "warn" || tone === "acc"
              ? t.c.accFg
              : tone === "bad"
                ? t.c.dangerText
                : t.c.bg,
          fontSize: 10,
          lineHeight: 12,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
