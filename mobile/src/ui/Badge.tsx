/**
 * The unread pill. `!` (warn fill) when a bot needs the operator, else the
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
      accessibilityLabel={needs ? "needs you" : `${label} unread`}
      style={{
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
        borderRadius: 0,
      }}
    >
      <Text variant="caption" mono weight={700} style={{ color: t.c.bg, fontSize: 10, lineHeight: 12 }}>
        {label}
      </Text>
    </View>
  );
}
