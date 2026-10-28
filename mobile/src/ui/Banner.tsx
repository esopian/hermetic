/**
 * Banners: the in-app alert (a square bordered card at the top while the app is in front;
 * tap opens, close or a swipe up dismisses; under VoiceOver a Dismiss action
 * and the escape scrub), and the way to the Tailscale app.
 */
import { useEffect, useMemo, useRef } from "react";
import { Linking, Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  FadeInUp,
  FadeOutUp,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Alert } from "../client/client.ts";
import { useTheme } from "../theme/theme.tsx";
import { useAccessibilityPreferences } from "./AccessibilityPreferences.tsx";
import { Avatar } from "./avatar/Avatar.tsx";
import { Icon } from "./IconButton.tsx";
import { Text } from "./Text.tsx";

/** How long an arrival stays up. */
export const BANNER_DWELL_MS = 4000;
/**
 * How long a "needs you" or "turn failed" alert stays up. Longer than an
 * arrival, but not until dismissed: the card sits over home's gear, search and
 * `+`, and the bot's row keeps its needs-you and failed marks after it goes.
 */
export const BANNER_STICKY_DWELL_MS = 10000;
/** An upward drag past this (pt), or a flick, dismisses the card. */
export const BANNER_SWIPE_PT = 24;
const SWIPE_VELOCITY = 500;

const AVATAR = 40;

/** The small coloured word beside the title, for the alerts that are not plain arrivals. */
function alertTag(kind: Alert["data"]["kind"]): { label: string; tone: "warn" | "bad" } | null {
  if (kind === "needs_action") return { label: "Needs you", tone: "warn" };
  if (kind === "turn.error") return { label: "Turn failed", tone: "bad" };
  return null;
}

export function Banner({
  alert,
  onOpen,
  onDismiss,
}: {
  alert: Alert | null;
  onOpen(alert: Alert): void;
  onDismiss(): void;
}) {
  const t = useTheme();
  const { reduceMotion, screenReader } = useAccessibilityPreferences();
  const insets = useSafeAreaInsets();
  const sticky = alert?.data.kind === "needs_action" || alert?.data.kind === "turn.error";
  const lift = useSharedValue(0);
  // The gesture is built once and reads the live alert and `onDismiss`
  // through refs. A pan belongs to the alert that was up when it started
  // (`grabbed`): if a new alert replaces the card mid-swipe, the rest of that
  // pan neither moves nor dismisses the new one.
  const current = useRef(alert);
  current.current = alert;
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const grabbed = useRef<Alert | null>(null);
  // Upward only: the card follows the finger up, resists a pull down, and
  // either leaves or springs back. A tap still reaches the Pressable, since
  // the pan only activates after a few points of vertical travel.
  const swipe = useMemo(() => {
    const mine = () => grabbed.current !== null && grabbed.current === current.current;
    return Gesture.Pan()
      .withTestId("banner-swipe")
      .runOnJS(true)
      .activeOffsetY([-8, 8])
      .onStart(() => {
        grabbed.current = current.current;
      })
      .onUpdate((e) => {
        if (!mine()) return;
        lift.value = e.translationY < 0 ? e.translationY : e.translationY / 6;
      })
      .onEnd((e) => {
        if (!mine()) return;
        if (e.translationY < -BANNER_SWIPE_PT || e.velocityY < -SWIPE_VELOCITY) dismiss.current();
        else lift.value = reduceMotion ? 0 : withSpring(0);
      })
      .onFinalize(() => {
        grabbed.current = null;
      });
  }, [lift, reduceMotion]);
  useEffect(() => {
    if (!alert) return;
    lift.value = 0;
    // VoiceOver users need time to find the card and its Dismiss rotor action.
    if (screenReader !== false) return;
    const timer = setTimeout(onDismiss, sticky ? BANNER_STICKY_DWELL_MS : BANNER_DWELL_MS);
    return () => clearTimeout(timer);
  }, [alert, sticky, onDismiss, lift, screenReader]);
  const dragged = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));
  if (!alert) return null;
  const tag = alertTag(alert.data.kind);
  return (
    <GestureDetector gesture={swipe}>
      <Animated.View
        testID="alert-banner"
        entering={reduceMotion ? undefined : FadeInUp.duration(t.motion.slide)}
        exiting={reduceMotion ? undefined : FadeOutUp.duration(t.motion.fade)}
        style={{
          position: "absolute",
          top: insets.top + t.space.xs,
          left: t.space.md,
          right: t.space.md,
          zIndex: 100,
        }}
      >
        {/* The drag rides on an inner view, so it never fights the entering
            and exiting animations for the outer view's transform. */}
        <Animated.View
          style={[
            {
              // Flat and square: a step up from the page (bg2) with a `line2`
              // border doing the structure, and a 3px left rule in the alert's
              // tone when it needs the operator (the desktop card's verdict edge).
              backgroundColor: t.c.bg2,
              borderWidth: t.border.row,
              borderColor: t.c.line2,
              borderLeftWidth: tag ? t.border.seam : t.border.row,
              borderLeftColor: tag ? t.c[tag.tone] : t.c.line2,
            },
            dragged,
          ]}
        >
          {/* VoiceOver reads the card as one button, so it cannot reach the
              close button inside it, nor swipe: dismissing is a custom action
              (the actions rotor) and the two-finger scrub (escape). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[alert.title, tag?.label, alert.body].filter(Boolean).join(". ")}
            accessibilityHint="Opens the conversation."
            accessibilityActions={[{ name: "activate" }, { name: "dismiss", label: "Dismiss" }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === "dismiss") onDismiss();
              else if (e.nativeEvent.actionName === "activate") onOpen(alert);
            }}
            onAccessibilityEscape={onDismiss}
            onPress={() => onOpen(alert)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: t.space.md,
              paddingLeft: t.space.md,
              paddingVertical: t.space.md,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Avatar
              fleet_id={alert.data.fleet_id}
              instance={alert.data.instance}
              bot={alert.data.bot}
              size={AVATAR}
            />
            <View style={{ flex: 1, gap: t.space.xxs }}>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: t.space.sm,
                }}
              >
                <Text weight={600} style={{ flexShrink: 1 }}>
                  {alert.title}
                </Text>
                {tag ? (
                  <Text variant="caption" weight={600} tone={tag.tone}>
                    {tag.label}
                  </Text>
                ) : null}
              </View>
              {alert.body ? (
                <Text variant="bodySmall" tone="fg2" numberOfLines={2}>
                  {alert.body}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={onDismiss}
              style={{
                alignSelf: "flex-start",
                width: t.touch.min,
                height: t.touch.min,
                marginTop: -t.space.sm,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="close" size={14} color={t.c.fg3} />
            </Pressable>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

/* ── Tailscale ──────────────────────────────────────────────────────────── */

export const TAILSCALE_URL = "tailscale://";
export const TAILSCALE_APP_STORE_URL = "https://apps.apple.com/app/tailscale/id1470499037";

/** Open the Tailscale app when iOS lets us ask for it (`LSApplicationQueriesSchemes`), else its App Store page. */
export async function openTailscale(
  linking: Pick<typeof Linking, "canOpenURL" | "openURL"> = Linking,
): Promise<void> {
  const installed = await linking.canOpenURL(TAILSCALE_URL).catch(() => false);
  await linking.openURL(installed ? TAILSCALE_URL : TAILSCALE_APP_STORE_URL).catch(() => {});
}
