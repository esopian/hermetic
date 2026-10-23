/**
 * Status dot = square, 8–14px, no radius; busy states pulse (1.2 s).
 */
import { useEffect } from "react";
import type { ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "../theme/theme.tsx";
import { statusColor } from "../theme/tokens.ts";
import { useAccessibilityPreferences } from "./AccessibilityPreferences.tsx";

export function StatusSquare({
  status,
  size = 10,
  color,
  pulse,
  style: shape,
}: {
  status?: string;
  size?: number;
  /** Override the status mapping. */
  color?: string;
  pulse?: boolean;
  /** Another shape for the same mark (a task rail's cell). */
  style?: ViewStyle;
}) {
  const t = useTheme();
  const { reduceMotion } = useAccessibilityPreferences();
  const mapped = statusColor(t.c, status ?? "ready");
  const fill = color ?? mapped.color;
  const pulsing = pulse ?? (color ? false : mapped.pulse);
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (pulsing && !reduceMotion)
      opacity.value = withRepeat(withTiming(0.25, { duration: t.motion.pulse / 2 }), -1, true);
    else {
      cancelAnimation(opacity);
      opacity.value = 1;
    }
    return () => cancelAnimation(opacity);
  }, [pulsing, opacity, t.motion.pulse, reduceMotion]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityLabel={status}
      style={[{ width: size, height: size, backgroundColor: fill }, shape, animated]}
    />
  );
}
