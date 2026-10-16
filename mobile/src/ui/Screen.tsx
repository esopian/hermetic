/**
 * A themed screen body with safe-area padding. The padding is measured by the
 * native view from where it actually sits, so a screen presented as a form
 * sheet (below the status bar) gets no top padding, and the same screen pushed
 * full-screen clears the status bar.
 */
import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme.tsx";

export function Screen({
  children,
  edges = ["top"],
  style,
  background,
}: {
  children: ReactNode;
  edges?: ("top" | "bottom" | "left" | "right")[];
  style?: ViewStyle;
  /** The surface behind the screen and its insets; the page colour by default. */
  background?: string;
}) {
  const t = useTheme();
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: background ?? t.c.bg }}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </SafeAreaView>
  );
}
