/**
 * The bot avatar: the desktop's three styles (`sigil`, `pixel`, `blob`), drawn
 * in their still pose with react-native-svg.
 *
 * Seed, palette and geometry come from `@hermetic/core/shared`, the same code
 * the desktop draws from, so a bot wears the same face on both heads. Only the
 * drawing is here. Sigil and pixel are squares; blob is the one element allowed
 * a curve (`docs/ui-brief.md`). Activity reads as a gentle breathing scale while
 * a turn runs; there is no frame animation.
 */
import {
  type AvatarActivity,
  type AvatarMotion,
  type AvatarStatus,
  type AvatarStyle,
  avatarMotion,
  avatarPalette,
  avatarSeed,
  avatarSeeds,
  BLOB_VIEWBOX,
  type BlobFrame,
  blobFrame,
  blobShape,
  PIXEL_STILL,
  PIXEL_STOPPED,
  PIXEL_VIEWBOX,
  type PixelRect,
  pixelParts,
  SIGIL_VIEWBOX,
  sigilCells,
} from "@hermetic/core/shared";
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
import Svg, { Defs, G, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { usePrefs } from "../../prefs/prefs.tsx";
import { useTheme } from "../../theme/theme.tsx";
import { useAccessibilityPreferences } from "../AccessibilityPreferences.tsx";
import { svgColor } from "./color.ts";

export interface AvatarProps {
  fleet_id: string;
  instance: string;
  bot: string;
  size?: number;
  status?: AvatarStatus;
  activity?: AvatarActivity;
  /** Which style to draw. Defaults to this phone's preference (Settings › Appearance). */
  avatarStyle?: AvatarStyle;
  /** Hue shared by every bot on one instance (the desktop default). */
  family?: boolean;
  /**
   * Makes the avatar its own VoiceOver element ("<label> — <status>"). Leave
   * it out wherever the avatar sits inside a labelled row or button, or beside
   * the name it would repeat: unlabelled, the avatar is decoration and hidden.
   */
  label?: string;
}

/** One cell or run, already in viewBox units and hex. */
interface Cell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

export type BuiltAvatar =
  | { style: "sigil"; viewBox: string; cells: readonly Cell[] }
  | {
      style: "pixel";
      viewBox: string;
      base: readonly Cell[];
      /** Indexed by `PixelFrame.eye` / `.mouth`; only the still frame is drawn. */
      eyes: readonly (readonly Cell[])[];
      mouths: readonly (readonly Cell[])[];
    }
  | { style: "blob"; viewBox: string; a: string; b: string; glow: string; frame: BlobFrame };

/** The still frame every style is drawn in, as on the desktop's first paint. */
const FROZEN: AvatarMotion = avatarMotion("ready", "idle", true);

const runs = (rects: readonly PixelRect[]): Cell[] =>
  rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: 1, fill: svgColor(r.fill) }));

/**
 * Everything a seed decides, memoisable and pure. The draws happen in the
 * desktop's order (palette, then the style's geometry), so the same key gives
 * the same face on both heads.
 */
export function buildAvatar(
  key: string,
  style: AvatarStyle,
  light: boolean,
  family: boolean,
): BuiltAvatar {
  const { shape: rnd, hue } = avatarSeeds(key, family);
  const pal = avatarPalette(rnd, light, hue);
  if (style === "pixel") {
    const parts = pixelParts(rnd, pal);
    return {
      style,
      viewBox: PIXEL_VIEWBOX,
      base: runs(parts.base),
      eyes: parts.eyes.map(runs),
      mouths: parts.mouths.map(runs),
    };
  }
  if (style === "blob") {
    const shape = blobShape(rnd);
    return {
      style,
      viewBox: BLOB_VIEWBOX,
      a: svgColor(pal.a),
      b: svgColor(pal.b),
      glow: svgColor(pal.glow),
      frame: blobFrame(shape, 0, FROZEN),
    };
  }
  const cells = sigilCells(rnd).map((c) => ({
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    fill: svgColor(pal.tone(c.tone, 0, 0)),
  }));
  return { style: "sigil", viewBox: SIGIL_VIEWBOX, cells };
}

function Cells({ cells, prefix }: { cells: readonly Cell[]; prefix: string }) {
  return cells.map((c) => (
    <Rect key={`${prefix}${c.y}-${c.x}`} x={c.x} y={c.y} width={c.w} height={c.h} fill={c.fill} />
  ));
}

function Body({ built, gid, stopped }: { built: BuiltAvatar; gid: string; stopped: boolean }) {
  if (built.style === "sigil") return <Cells cells={built.cells} prefix="s" />;
  if (built.style === "pixel") {
    // A stopped box has its eyes shut; otherwise the resting face.
    const frame = stopped ? PIXEL_STOPPED : PIXEL_STILL;
    return (
      <>
        <Cells cells={built.base} prefix="b" />
        <Cells cells={built.eyes[frame.eye] ?? []} prefix="e" />
        <Cells cells={built.mouths[frame.mouth] ?? []} prefix="m" />
      </>
    );
  }
  return (
    <>
      <Defs>
        <LinearGradient id={`${gid}a`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={built.a} />
          <Stop offset="1" stopColor={built.b} />
        </LinearGradient>
        <LinearGradient id={`${gid}h`} x1="0.2" y1="0" x2="0.8" y2="1">
          <Stop offset="0" stopColor={built.glow} stopOpacity={0.85} />
          <Stop offset="1" stopColor={built.a} stopOpacity={0.15} />
        </LinearGradient>
      </Defs>
      <G rotation={-built.frame.rotation * 0.55} origin="50, 50">
        <Path d={built.frame.back} fill={`url(#${gid}h)`} opacity={0.55} />
      </G>
      <G rotation={built.frame.rotation} origin="50, 50">
        <Path d={built.frame.front} fill={`url(#${gid}a)`} />
      </G>
    </>
  );
}

function AvatarImpl({
  fleet_id,
  instance,
  bot,
  size = 32,
  status = "ready",
  activity = "idle",
  avatarStyle,
  family = true,
  label,
}: AvatarProps) {
  const theme = useTheme();
  const { prefs } = usePrefs();
  const { reduceMotion } = useAccessibilityPreferences();
  const style = avatarStyle ?? prefs.avatarStyle;
  const key = avatarSeed(fleet_id, instance, bot);
  const light = theme.scheme === "light";
  const built = useMemo(() => buildAvatar(key, style, light, family), [key, style, light, family]);
  // Reduced motion is handled below (no breathing); the motion numbers here
  // are only the status's opacity, the activity's scale and whether it runs.
  const look = avatarMotion(status, activity);
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
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: breathe.value }] }));

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
      <Animated.View style={animated}>
        <Svg width={size} height={size} viewBox={built.viewBox} testID={`avatar-${built.style}`}>
          <Body built={built} gid={gid} stopped={look.stopped} />
        </Svg>
      </Animated.View>
    </View>
  );
}

export const Avatar = memo(AvatarImpl);
