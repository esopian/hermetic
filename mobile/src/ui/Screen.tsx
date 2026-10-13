/** A themed screen body with safe-area padding. */
import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme.tsx";

export function Screen({
  children,
  edges = ["top"],
  style,
}: {
  children: ReactNode;
  edges?: ("top" | "bottom" | "left" | "right")[];
  style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </SafeAreaView>
  );
}
