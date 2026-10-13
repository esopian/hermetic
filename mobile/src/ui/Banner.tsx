/** The in-app alert: a slim bar at the top while the app is in front. Tap opens, swipe/close dismisses. */
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Alert } from "../client/client.ts";
import { useTheme } from "../theme/theme.tsx";
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
