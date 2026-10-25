/**
 * The fleet switcher (a sheet opened from Settings' Fleet row): every fleet this phone is paired with, the one in front marked, and
 * "Add a fleet" to scan another code. Tapping another fleet brings it to the
 * front: the app remounts at that fleet's home, like switching accounts in a
 * multi-account app. A fleet on another tailnet says so: the Tailscale app
 * must be signed in to it for the phone to reach that fleet.
 */
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetState } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Screen, Text } from "../src/ui/index.ts";

export default function Fleets() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { fleets, switchFleet } = useFleetContext();
  const current = useFleetState().link;
  const activeId = current?.payload.fleet_id ?? null;
  const activeTailnet = current?.payload.tailnet ?? null;
  const [error, setError] = useState<string | null>(null);

  const choose = (fleetId: string) => {
    if (fleetId === activeId) return router.back();
    haptic.select();
    setError(null);
    void switchFleet(fleetId).catch((e: unknown) => {
      haptic.error();
      setError(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <Screen edges={["top"]} background={t.c.bg2}>
      <ScrollView
        style={{ flex: 1, backgroundColor: t.c.bg2 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + t.space.xl }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: t.space.xl,
            paddingTop: t.space.xl,
            paddingBottom: t.space.md,
            borderBottomWidth: t.border.row,
            borderBottomColor: t.c.line,
          }}
        >
          <Text variant="title" weight={700} style={{ flex: 1 }}>
            Fleets
          </Text>
          <Button label="Done" variant="secondary" compact onPress={() => router.back()} />
        </View>
        {fleets.map((f, index) => {
          const active = f.fleet_id === activeId;
          const otherNet = !!activeTailnet && f.tailnet.toLowerCase() !== activeTailnet.toLowerCase();
          return (
            <View key={f.fleet_id}>
              {index === 0 ? null : (
                <View style={{ height: t.border.row, backgroundColor: t.c.line }} />
              )}
              <Pressable
                testID={`fleet-${f.fleet_id}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${f.label}${active ? ", current fleet" : ""}${otherNet ? `, on tailnet ${f.tailnet}` : ""}`}
                onPress={() => choose(f.fleet_id)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: t.space.md,
                  paddingHorizontal: t.space.xl,
                  minHeight: 60,
                  backgroundColor: pressed ? t.c.bg3 : "transparent",
                })}
              >
                <View style={{ flex: 1, gap: 2, paddingVertical: t.space.sm }}>
                  <Text weight={active ? 700 : 500} numberOfLines={1}>
                    {f.label}
                  </Text>
                  <Text mono variant="caption" tone={otherNet ? "warn" : "fg3"} numberOfLines={1}>
                    {otherNet ? `${f.tailnet} · another tailnet` : f.tailnet}
                  </Text>
                </View>
                {active ? (
                  <Text mono variant="caption" tone="acc" style={{ letterSpacing: 1 }}>
                    CURRENT
                  </Text>
                ) : null}
              </Pressable>
            </View>
          );
        })}
        <View style={{ padding: t.space.lg, gap: t.space.sm }}>
          {error ? (
            <Text variant="bodySmall" tone="bad" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Button
            label="Add a fleet"
            variant="secondary"
            onPress={() => {
              router.back();
              router.push("/pair");
            }}
          />
          <Text variant="bodySmall" tone="fg3">
            Scan another fleet's code to add it here. One fleet is in front at a time; its bots, alerts
            and push follow it.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
