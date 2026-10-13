/**
 * The product's on/off switch: a native `Switch` in the accent colour, inside
 * a plain view.
 *
 * The wrapper is load-bearing. Fabric lays a bare `Switch` (a measured leaf)
 * out at the top of a row whose height comes from `minHeight`, even under
 * `alignItems: "center"`; a wrapping view is an ordinary flex child and is
 * centred like the rest of the row.
 */
import { Switch, type SwitchProps, View } from "react-native";
import { useTheme } from "../theme/theme.tsx";

export function ToggleSwitch(props: Omit<SwitchProps, "trackColor" | "ios_backgroundColor">) {
  const t = useTheme();
  return (
    <View>
      <Switch
        {...props}
        trackColor={{ true: t.c.acc, false: t.c.line2 }}
        ios_backgroundColor={t.c.line2}
      />
    </View>
  );
}
