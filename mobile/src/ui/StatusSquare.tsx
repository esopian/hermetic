/** Status dot = square, 8–14px, no radius; busy states pulse (1.2 s). */
import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "../theme/theme.tsx";
import { statusColor } from "../theme/tokens.ts";

export function StatusSquare({
  status,
  size = 10,
  color,
  pulse,
}: {
  status?: string;
  size?: number;
  /** Override the status mapping. */
  color?: string;
  pulse?: boolean;
}) {
  const t = useTheme();
  const mapped = statusColor(t.c, status ?? "ready");
  const fill = color ?? mapped.color;
  const pulsing = pulse ?? (color ? false : mapped.pulse);
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (pulsing)
      opacity.value = withRepeat(withTiming(0.25, { duration: t.motion.pulse / 2 }), -1, true);
    else {
      cancelAnimation(opacity);
      opacity.value = 1;
    }
    return () => cancelAnimation(opacity);
  }, [pulsing, opacity, t.motion.pulse]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityLabel={status}
      style={[{ width: size, height: size, backgroundColor: fill, borderRadius: 0 }, style]}
    />
  );
}
