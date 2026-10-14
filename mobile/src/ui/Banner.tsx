/**
 * Banners: the in-app alert (a slim bar at the top while the app is in front;
 * tap opens, close dismisses) and home's Tailscale strip.
 */
import { useEffect } from "react";
import { Linking, Pressable, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Alert } from "../client/client.ts";
import type { TailscaleStatus } from "../gateway/tailscale.ts";
import { useTheme } from "../theme/theme.tsx";
import { Icon } from "./IconButton.tsx";
import { Kicker } from "./Kicker.tsx";
import { Text } from "./Text.tsx";

export const BANNER_DWELL_MS = 4000;

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
  const insets = useSafeAreaInsets();
  const sticky = alert?.data.kind === "needs_action" || alert?.data.kind === "turn.error";
  useEffect(() => {
    if (!alert || sticky) return;
    const timer = setTimeout(onDismiss, BANNER_DWELL_MS);
    return () => clearTimeout(timer);
  }, [alert, sticky, onDismiss]);
  if (!alert) return null;
  const edge =
    alert.data.kind === "needs_action" ? t.c.warn : alert.data.kind === "turn.error" ? t.c.bad : t.c.fg;
  return (
    <Animated.View
      entering={FadeInUp.duration(t.motion.slide)}
      exiting={FadeOutUp.duration(t.motion.fade)}
      style={{ position: "absolute", top: insets.top + 4, left: 8, right: 8, zIndex: 100 }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => onOpen(alert)}
        style={{
          backgroundColor: t.c.bg2,
          borderWidth: t.border.control,
          borderColor: edge,
          padding: t.space.md,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Kicker tone={alert.data.kind === "needs_action" ? "warn" : "fg3"}>
            {alert.data.kind === "needs_action"
              ? "Needs you"
              : alert.data.kind === "turn.error"
                ? "Turn failed"
                : "Hermetic"}
          </Kicker>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={12}
            onPress={onDismiss}
          >
            <Text variant="mono" tone="fg3">
              ✕
            </Text>
          </Pressable>
        </View>
        <Text variant="title" numberOfLines={1}>
          {alert.title}
        </Text>
        {alert.body ? (
          <Text variant="bodySmall" tone="fg2" numberOfLines={2}>
            {alert.body}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
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
        alignItems: "center",
        gap: t.space.sm,
        marginHorizontal: t.space.lg,
        marginTop: t.space.xs,
        paddingLeft: t.space.md,
        minHeight: t.touch.min,
        borderRadius: t.touch.min / 2,
        backgroundColor: t.c.bg2,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text variant="bodySmall" weight={600} numberOfLines={1} style={{ flex: 1 }}>
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
