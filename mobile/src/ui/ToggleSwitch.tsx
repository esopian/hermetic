/**
 * The product's on/off switch, drawn square like the desktop's listening
 * toggle (`packages/ui/src/styles/listening.css`): a bordered track in `bg2`
 * with a square thumb that slides to the right when on. Off, the thumb is
 * `line2` on a `line2` border; on, both take the accent. The tap target is
 * 44pt tall even though the track is drawn smaller.
 *
 * It replaces the native `Switch`, whose track and knob are round. The props
 * are the subset of `Switch`'s that the app uses, so call sites read the same.
 */
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/theme.tsx";
import { useAccessibilityPreferences } from "./AccessibilityPreferences.tsx";

const TRACK_W = 50;
const TRACK_H = 28;
const INSET = 3;

export interface ToggleSwitchProps {
  value: boolean;
  onValueChange?: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function ToggleSwitch({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  testID,
}: ToggleSwitchProps) {
  const t = useTheme();
  const { reduceMotion } = useAccessibilityPreferences();
  const thumb = TRACK_H - 2 * t.border.row - 2 * INSET;
  const travel = TRACK_W - 2 * t.border.row - 2 * INSET - thumb;
  const x = useSharedValue(value ? travel : 0);
  useEffect(() => {
    const to = value ? travel : 0;
    x.value = reduceMotion ? to : withTiming(to, { duration: t.motion.slide });
  }, [value, travel, reduceMotion, x, t.motion.slide]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const slop = Math.max(0, (t.touch.min - TRACK_H) / 2);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      hitSlop={{ top: slop, bottom: slop, left: 4, right: 4 }}
      onPress={() => onValueChange?.(!value)}
      testID={testID}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <View
        style={{
          width: TRACK_W,
          height: TRACK_H,
          padding: INSET,
          borderWidth: t.border.row,
          borderColor: value ? t.c.acc : t.c.line2,
          backgroundColor: t.c.bg2,
          justifyContent: "center",
        }}
      >
        <Animated.View
          style={[{ width: thumb, height: thumb, backgroundColor: value ? t.c.acc : t.c.line2 }, slide]}
        />
      </View>
    </Pressable>
  );
}
