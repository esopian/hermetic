/**
 * The mini connection path in an instance's home header: this phone →
 * Tailscale → the box (`src/client/connection.ts` says which step it is on).
 *
 * - `waking`: packets travel the first line toward a pulsing Tailscale diamond.
 * - `reaching`: the first line fills green, the diamond pops green, and the
 *   packets and pulse move on to the box.
 * - `connected`: the second line fills and the box goes green.
 * - `no_tailscale` / `no_box`: a red cross where the path stopped, one shake.
 *
 * Motion is transform and opacity only. With Reduce Motion on, every step is
 * drawn at once, with no packets, pulses or shake.
 */
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import type { ConnectionShown } from "../client/connection.ts";
import { useTheme } from "../theme/theme.tsx";
import { useAccessibilityPreferences } from "./AccessibilityPreferences.tsx";

/** One line's length between two marks. */
const SEG = 30;
const PACKET = 4;
const NODE = 10;
const TRAVEL_MS = 1_200;
const RIPPLE_MS = 1_400;
const FILL_MS = 450;
const EASE = Easing.bezier(0.2, 0.7, 0.2, 1);

type Step = Exclude<ConnectionShown, null>;

export function ConnectionPath({ shown }: { shown: Step }) {
  const t = useTheme();
  const { reduceMotion } = useAccessibilityPreferences();
  const tunnelDone = shown === "reaching" || shown === "connected" || shown === "no_box";
  const shake = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion || (shown !== "no_tailscale" && shown !== "no_box")) return;
    shake.value = withSequence(
      withTiming(-2, { duration: 60 }),
      withTiming(2, { duration: 80 }),
      withTiming(-1, { duration: 80 }),
      withTiming(0, { duration: 80 }),
    );
  }, [shown, reduceMotion, shake]);
  const shaking = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  return (
    <Animated.View
      testID={`connection-path-${shown}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ flexDirection: "row", alignItems: "center" }, shaking]}
    >
      <View style={{ width: 8, height: 12, borderWidth: 1.5, borderColor: t.c.ok, borderRadius: 2 }} />
      <Line
        filled={tunnelDone}
        travelling={shown === "waking"}
        dashed={false}
        reduceMotion={reduceMotion}
      />
      <Diamond shown={shown} reduceMotion={reduceMotion} />
      <Line
        filled={shown === "connected"}
        travelling={shown === "reaching"}
        dashed={shown === "no_tailscale"}
        reduceMotion={reduceMotion}
      />
      <BoxMark shown={shown} reduceMotion={reduceMotion} />
    </Animated.View>
  );
}

/** A line between two marks: grey, filling green left to right, optionally carrying packets. */
function Line({
  filled,
  travelling,
  dashed,
  reduceMotion,
}: {
  filled: boolean;
  travelling: boolean;
  dashed: boolean;
  reduceMotion: boolean;
}) {
  const t = useTheme();
  const fill = useSharedValue(filled ? 1 : 0);
  useEffect(() => {
    fill.value = reduceMotion
      ? filled
        ? 1
        : 0
      : withTiming(filled ? 1 : 0, { duration: FILL_MS, easing: EASE });
  }, [filled, reduceMotion, fill]);
  const fillStyle = useAnimatedStyle(() => ({ width: SEG * fill.value }));
  return (
    <View style={{ width: SEG, height: 2, marginHorizontal: 5 }}>
      {dashed ? (
        <View style={{ height: 0, borderTopWidth: 2, borderColor: t.c.line, borderStyle: "dashed" }} />
      ) : (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 2,
            backgroundColor: t.c.line,
          }}
        />
      )}
      <Animated.View
        style={[
          { position: "absolute", left: 0, top: 0, height: 2, backgroundColor: t.c.ok },
          fillStyle,
        ]}
      />
      {travelling && !reduceMotion ? (
        <>
          <Packet delay={0} />
          <Packet delay={TRAVEL_MS / 3} />
          <Packet delay={(TRAVEL_MS * 2) / 3} />
        </>
      ) : null}
    </View>
  );
}

/** One packet crossing its line, fading in and out at the ends. */
function Packet({ delay }: { delay: number }) {
  const t = useTheme();
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: TRAVEL_MS, easing: Easing.inOut(Easing.quad) }), -1, false),
    );
    return () => cancelAnimation(p);
  }, [delay, p]);
  const style = useAnimatedStyle(() => {
    const v = p.value;
    const opacity = v < 0.15 ? v / 0.15 : v > 0.85 ? (1 - v) / 0.15 : 1;
    return { opacity, transform: [{ translateX: -PACKET + v * (SEG + PACKET) }] };
  });
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: 0,
          top: -1,
          width: PACKET,
          height: PACKET,
          backgroundColor: t.c.acc,
        },
        style,
      ]}
    />
  );
}

/** Two rings swelling out of a mark that is being waited on. */
function Ripples({ color }: { color: string }) {
  return (
    <>
      <Ripple color={color} delay={0} />
      <Ripple color={color} delay={RIPPLE_MS / 2} />
    </>
  );
}

function Ripple({ color, delay }: { color: string; delay: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(
      delay,
      withRepeat(
        withTiming(1, { duration: RIPPLE_MS, easing: Easing.bezier(0.2, 0.6, 0.3, 1) }),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(p);
  }, [delay, p]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.7 * (1 - p.value),
    transform: [{ scale: 1 + 1.8 * p.value }],
  }));
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: 0,
          top: 0,
          width: NODE,
          height: NODE,
          borderWidth: 1,
          borderColor: color,
        },
        style,
      ]}
    />
  );
}

/** A small pop when a mark turns green. */
function usePop(on: boolean, reduceMotion: boolean) {
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!on || reduceMotion) return;
    scale.value = withSequence(withTiming(1.25, { duration: 140 }), withTiming(1, { duration: 220 }));
  }, [on, reduceMotion, scale]);
  return useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
}

function Cross() {
  const t = useTheme();
  return (
    <Svg width={NODE} height={NODE} viewBox="0 0 10 10">
      <Path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke={t.c.bad} strokeWidth={1.8} />
    </Svg>
  );
}

/** Tailscale: a diamond. */
function Diamond({ shown, reduceMotion }: { shown: Step; reduceMotion: boolean }) {
  const t = useTheme();
  const up = shown === "reaching" || shown === "connected" || shown === "no_box";
  const pop = usePop(up, reduceMotion);
  if (shown === "no_tailscale") return <Cross />;
  return (
    <View style={{ width: NODE, height: NODE }}>
      {shown === "waking" && !reduceMotion ? <Ripples color={t.c.acc} /> : null}
      <Animated.View
        style={[{ width: NODE, height: NODE, alignItems: "center", justifyContent: "center" }, pop]}
      >
        <View
          style={{
            width: 7.5,
            height: 7.5,
            transform: [{ rotate: "45deg" }],
            borderWidth: 1.5,
            borderColor: up ? t.c.ok : t.c.acc,
            backgroundColor: up ? t.c.ok : "transparent",
          }}
        />
      </Animated.View>
    </View>
  );
}

/** The box: a square. */
function BoxMark({ shown, reduceMotion }: { shown: Step; reduceMotion: boolean }) {
  const t = useTheme();
  const pop = usePop(shown === "connected", reduceMotion);
  if (shown === "no_box") return <Cross />;
  const color =
    shown === "connected"
      ? t.c.ok
      : shown === "reaching"
        ? t.c.acc
        : shown === "no_tailscale"
          ? t.c.line2
          : t.c.fg3;
  return (
    <View style={{ width: NODE, height: NODE }}>
      {shown === "reaching" && !reduceMotion ? <Ripples color={t.c.acc} /> : null}
      <Animated.View
        style={[
          {
            width: NODE,
            height: NODE,
            borderWidth: 1.5,
            borderColor: color,
            backgroundColor: shown === "connected" ? t.c.ok : "transparent",
          },
          pop,
        ]}
      />
    </View>
  );
}
