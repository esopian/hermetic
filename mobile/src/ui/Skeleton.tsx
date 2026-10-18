/** A loading placeholder bar: bg3 block that breathes. Rows are positional, so no keys to speak of. */
import { useEffect } from "react";
import type { DimensionValue, ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "../theme/theme.tsx";
import { useAccessibilityPreferences } from "./AccessibilityPreferences.tsx";

export function Skeleton({
  width = "100%",
  height = 12,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const { reduceMotion } = useAccessibilityPreferences();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(o);
      o.value = 1;
    } else o.value = withRepeat(withTiming(0.45, { duration: 700 }), -1, true);
    return () => cancelAnimation(o);
  }, [o, reduceMotion]);
  const animated = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, backgroundColor: t.c.bg3 }, animated, style]}
    />
  );
}

/** A skeleton chat row: avatar square + two lines. */
export function SkeletonRow() {
  const t = useTheme();
  return (
    <Animated.View
      style={{ flexDirection: "row", gap: t.space.md, padding: t.space.lg, alignItems: "center" }}
    >
      <Skeleton width={32} height={32} />
      <Animated.View style={{ flex: 1, gap: t.space.sm }}>
        <Skeleton width="45%" height={11} />
        <Skeleton width="80%" height={10} />
      </Animated.View>
    </Animated.View>
  );
}
