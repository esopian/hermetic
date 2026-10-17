/** A fixed-duration brand handoff after native launch, once per root mount. */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useAccessibilityPreferences } from "./AccessibilityPreferences.tsx";
import { EntryMark } from "./EntryMark.tsx";

const ENTRY_DURATION_MS = 3000;
const VEIL_EXIT_MS = 300;
const READINESS_TIMEOUT_MS = 400;
const BACKGROUND = "#0e0e0d";

/** Routes mount beneath the veil; neither animation nor dismissal waits for the fleet. */
export function EntrySplash({
  children,
  onReady,
  onVisibilityChange,
}: {
  children: ReactNode;
  /** Resolve after the native splash has been hidden. */
  onReady(): void | Promise<void>;
  onVisibilityChange(visible: boolean): void;
}) {
  const { reduceMotion, screenReader } = useAccessibilityPreferences();
  const [phase, setPhase] = useState<"pending" | "playing" | "done">("pending");
  const [rootLaidOut, setRootLaidOut] = useState(false);
  const [markReady, setMarkReady] = useState(false);
  const [skip, setSkip] = useState(false);
  const handoff = useRef<Promise<void> | null>(null);
  const startedAt = useRef<number | null>(null);
  const clock = useSharedValue(0);
  const visible = phase !== "done";
  const bypass = skip || screenReader === true;

  useEffect(() => {
    if (phase !== "pending") return;
    // A failed image or stalled native query must never trap the app behind launch art.
    const fallback = setTimeout(() => setSkip(true), READINESS_TIMEOUT_MS);
    return () => clearTimeout(fallback);
  }, [phase]);

  useEffect(() => {
    if (phase !== "pending" || !rootLaidOut || (!bypass && (!markReady || screenReader !== false)))
      return;
    let live = true;
    handoff.current ??= Promise.resolve(onReady()).catch(() => {});
    void handoff.current.then(() => {
      if (live) setPhase(bypass ? "done" : "playing");
    });
    return () => {
      live = false;
    };
  }, [phase, rootLaidOut, bypass, markReady, screenReader, onReady]);

  useEffect(() => {
    if (phase === "playing" && screenReader === true) setPhase("done");
  }, [phase, screenReader]);

  useEffect(() => {
    onVisibilityChange(visible);
  }, [onVisibilityChange, visible]);

  useEffect(() => {
    if (phase !== "playing") return;
    startedAt.current ??= Date.now();
    const remaining = Math.max(0, ENTRY_DURATION_MS - (Date.now() - startedAt.current));
    clock.value = ENTRY_DURATION_MS - remaining;
    if (!reduceMotion) {
      // The live accessibility provider controls motion, including toggles during entry.
      clock.value = withTiming(ENTRY_DURATION_MS, {
        duration: remaining,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      });
    }
    const timer = setTimeout(() => setPhase("done"), remaining);
    const subscription = AppState.addEventListener("change", (state) => {
      if (
        state === "active" &&
        startedAt.current !== null &&
        Date.now() - startedAt.current >= ENTRY_DURATION_MS
      )
        setPhase("done");
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
      cancelAnimation(clock);
    };
  }, [phase, reduceMotion, clock]);

  const veilStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion
      ? 1
      : interpolate(
          clock.value,
          [ENTRY_DURATION_MS - VEIL_EXIT_MS, ENTRY_DURATION_MS],
          [1, 0],
          "clamp",
        ),
  }));

  return (
    <View testID="entry-root" onLayout={() => setRootLaidOut(true)} style={{ flex: 1 }}>
      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={visible}
        importantForAccessibility={visible ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {visible ? (
        <Animated.View
          testID="entry-veil"
          accessible
          accessibilityRole="image"
          accessibilityLabel="Hermetic"
          accessibilityViewIsModal
          pointerEvents="auto"
          style={[
            {
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: BACKGROUND,
            },
            veilStyle,
          ]}
        >
          <EntryMark
            clock={clock}
            animated={!reduceMotion}
            onLoad={() => setMarkReady(true)}
            onError={() => setSkip(true)}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
