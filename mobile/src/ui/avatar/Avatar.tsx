/**
 * The bot avatar: the desktop's `blob` style, drawn once in its still pose
 * with react-native-svg. The one element allowed a curve (`docs/ui-brief.md`).
 * Activity reads as a gentle breathing scale while a turn runs.
 */
import { memo, useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, G, LinearGradient, Path, Stop } from "react-native-svg";
import { useTheme } from "../../theme/theme.tsx";
import { useAccessibilityPreferences } from "../AccessibilityPreferences.tsx";
import {
  type AvatarActivity,
  type AvatarStatus,
  avatarLook,
  avatarPalette,
  avatarSeed,
  avatarSeeds,
} from "./avatar-seed.ts";
import { BLOB_VIEWBOX, blobFrame, blobShape } from "./blob.ts";

export interface AvatarProps {
  fleet_id: string;
  instance: string;
  bot: string;
  size?: number;
  status?: AvatarStatus;
  activity?: AvatarActivity;
  /** Hue shared by every bot on one instance (the desktop default). */
  family?: boolean;
  /**
   * Makes the avatar its own VoiceOver element ("<label> — <status>"). Leave
   * it out wherever the avatar sits inside a labelled row or button, or beside
   * the name it would repeat: unlabelled, the avatar is decoration and hidden.
   */
  label?: string;
}

/** Everything a seed decides, memoisable and pure. */
export function buildBlob(key: string, light: boolean, family: boolean) {
  const { shape: rnd, hue } = avatarSeeds(key, family);
  const pal = avatarPalette(rnd, light, hue);
  const shape = blobShape(rnd);
  return { pal, frame: blobFrame(shape, 0) };
}

function AvatarImpl({
  fleet_id,
  instance,
  bot,
  size = 32,
  status = "ready",
  activity = "idle",
  family = true,
  label,
}: AvatarProps) {
  const theme = useTheme();
  const { reduceMotion } = useAccessibilityPreferences();
  const key = avatarSeed(fleet_id, instance, bot);
  const light = theme.scheme === "light";
  const built = useMemo(() => buildBlob(key, light, family), [key, light, family]);
  const look = avatarLook(status, activity);
  const gid = `hav${key.replace(/[^A-Za-z0-9]/g, "")}`;

  const breathe = useSharedValue(1);
  useEffect(() => {
    if (!reduceMotion && look.alive && (activity === "thinking" || activity === "streaming")) {
      breathe.value = withRepeat(
        withTiming(look.scale, {
          duration: activity === "streaming" ? 520 : 780,
          easing: Easing.inOut(Easing.sin),
        }),
        -1,
        true,
      );
    } else {
      cancelAnimation(breathe);
      breathe.value = reduceMotion ? 1 : withTiming(look.scale, { duration: 160 });
    }
    return () => cancelAnimation(breathe);
  }, [activity, look.alive, look.scale, breathe, reduceMotion]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: breathe.value }] }));

  return (
    <View
      {...(label
        ? {
            accessible: true,
            accessibilityRole: "image" as const,
            accessibilityLabel: `${label} — ${status}`,
          }
        : {
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: "no-hide-descendants" as const,
          })}
      style={{ width: size, height: size, opacity: look.opacity }}
    >
      <Animated.View style={style}>
        <Svg width={size} height={size} viewBox={BLOB_VIEWBOX}>
          <Defs>
            <LinearGradient id={`${gid}a`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={built.pal.a} />
              <Stop offset="1" stopColor={built.pal.b} />
            </LinearGradient>
            <LinearGradient id={`${gid}h`} x1="0.2" y1="0" x2="0.8" y2="1">
              <Stop offset="0" stopColor={built.pal.glow} stopOpacity={0.85} />
              <Stop offset="1" stopColor={built.pal.a} stopOpacity={0.15} />
            </LinearGradient>
          </Defs>
          <G rotation={-built.frame.rotation * 0.55} origin="50, 50">
            <Path d={built.frame.back} fill={`url(#${gid}h)`} opacity={0.55} />
          </G>
          <G rotation={built.frame.rotation} origin="50, 50">
            <Path d={built.frame.front} fill={`url(#${gid}a)`} />
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}

export const Avatar = memo(AvatarImpl);
