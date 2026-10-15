/**
 * Banners: the in-app alert (a soft card at the top while the app is in front;
 * tap opens, close or a swipe up dismisses; under VoiceOver a Dismiss action
 * and the escape scrub) and home's Tailscale strip.
 */
import { useEffect, useMemo, useRef } from "react";
import { Linking, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
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
import type { TailscaleStatus } from "../gateway/tailscale.ts";
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

const RADIUS = 18;
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
  const dark = t.scheme === "dark";
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
              borderRadius: RADIUS,
              // Dark lifts the card a step (bg3) over the page it floats on,
              // and a hairline gives it the edge a shadow cannot on black;
              // light keeps its own card fill and ring.
              backgroundColor: dark ? t.c.bg3 : t.c.card,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: dark ? t.c.line : t.c.cardEdge,
              shadowColor: "#000",
              shadowOpacity: dark ? 0.45 : 0.12,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
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
              borderRadius: RADIUS,
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

/**
 * Home's Tailscale strip, for the two probe answers worth a word
 * (`src/gateway/tailscale.ts`): `off` — no listened box's name resolved — and
 * `unreachable` — names resolve but no box answered. One slim line under the
 * top bar with quiet text actions: both offer "Open Tailscale", `unreachable`
 * also keeps "Retry", and the strip can be dismissed (it comes back when the
 * status changes). The probe is a heuristic, and the hint says "looks".
 */
export function TailscaleBanner({
  status,
  busy = false,
  onRetry,
  onOpenTailscale = () => void openTailscale(),
  onDismiss,
}: {
  status: TailscaleStatus | null;
  busy?: boolean;
  onRetry(): void;
  onOpenTailscale?: () => void;
  onDismiss?: () => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 390 || fontScale > 1;
  if (status !== "off" && status !== "unreachable") return null;
  const off = status === "off";
  const color = off ? t.c.bad : t.c.warn;
  return (
    <View
      testID="band-tailscale"
      accessibilityRole="alert"
      accessibilityHint={
        off
          ? "The fleet's names did not resolve. It looks like Tailscale is not connected on this phone."
          : "The boxes you listen to did not answer. They may be stopped, or still starting."
      }
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: t.space.sm,
        marginHorizontal: t.space.lg,
        marginTop: t.space.xs,
        paddingHorizontal: t.space.md,
        paddingVertical: stacked ? t.space.xs : 0,
        minHeight: t.touch.min,
        borderRadius: t.touch.min / 2,
        backgroundColor: t.c.bg2,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text
        variant="bodySmall"
        weight={600}
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: stacked ? "85%" : 0 }}
      >
        {off ? "Tailscale is off or not signed in" : "On the tailnet, but no box answers"}
      </Text>
      {off ? null : <StripAction label="Retry" busyLabel="Retrying" busy={busy} onPress={onRetry} />}
      <StripAction label="Open Tailscale" onPress={onOpenTailscale} />
      {onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          onPress={onDismiss}
          style={{
            width: t.touch.min,
            height: t.touch.min,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="close" size={16} color={t.c.fg3} />
        </Pressable>
      ) : (
        <View style={{ width: t.space.sm }} />
      )}
    </View>
  );
}

/** A text-only action inside the strip: 44pt tall, accent label. */
function StripAction({
  label,
  busyLabel,
  busy = false,
  onPress,
}: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  onPress(): void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: t.touch.min,
        maxWidth: "100%",
        flexShrink: 1,
        paddingHorizontal: t.space.xs,
        justifyContent: "center",
        opacity: pressed || busy ? 0.6 : 1,
      })}
    >
      <Text variant="bodySmall" weight={700} tone="acc">
        {busy && busyLabel ? `${busyLabel}…` : label}
      </Text>
    </Pressable>
  );
}
