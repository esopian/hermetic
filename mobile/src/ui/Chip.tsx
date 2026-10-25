import { Pressable } from "react-native";
import { useTheme } from "../theme/theme.tsx";
import { Text } from "./Text.tsx";

/** A square toggle chip, 44pt tall. */
export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress(): void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: t.touch.min,
        minWidth: t.touch.min,
        paddingHorizontal: t.space.md,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: t.border.control,
        borderColor: on ? t.c.fg : t.c.line2,
        backgroundColor: on ? t.c.fg : "transparent",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text weight={600} style={{ color: on ? t.c.bg : t.c.fg }}>
        {label}
      </Text>
    </Pressable>
  );
}
