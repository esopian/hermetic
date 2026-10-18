/**
 * The instance picker (a sheet over home and Settings): every agent of the
 * paired fleet (the pairing link's, merged with `GET /fleet`) with its status,
 * and a switch per row that listens or stops listening. The choice is this
 * phone's own (`FleetStore.setListening`): only listened instances show bots,
 * raise alerts, and are asked to push to this phone.
 *
 * The primary instance carries a bordered PRIMARY tag. Long-pressing any other
 * row offers "Make primary" (`setPrimary`, which also listens to it).
 */
import { router } from "expo-router";
import { useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { statusColor } from "../src/theme/tokens.ts";
import { Button, Screen, SkeletonRow, Text, ToggleSwitch } from "../src/ui/index.ts";

/** The long-press menu of a row that is not the primary: Make primary · Cancel. */
function showRowMenu(name: string, makePrimary: () => void, tint: string) {
  haptic.medium();
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: name, options: ["Make primary", "Cancel"], cancelButtonIndex: 1, tintColor: tint },
      (index) => {
        if (index === 0) makePrimary();
      },
    );
    return;
  }
  Alert.alert(name, undefined, [
    { text: "Make primary", onPress: makePrimary },
    { text: "Cancel", style: "cancel" },
  ]);
}

/** A small bordered tag beside the primary instance's name. */
function PrimaryTag() {
  const t = useTheme();
  return (
    <View
      testID="primary-tag"
      style={{
        borderWidth: t.border.row,
        borderColor: t.c.fg2,
        paddingHorizontal: 4,
        paddingVertical: 1,
      }}
    >
      <Text mono variant="caption" tone="fg2" style={{ fontSize: 10, letterSpacing: 1 }}>
        PRIMARY
      </Text>
    </View>
  );
}

export default function Listening() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { client, fleet, primary, setPrimary } = useFleetContext();
  const fleetState = useFleetState();
  const agents = useFleetAgents();
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const load = () => fleet.refresh();
  const listening = new Set(fleet.listened());
  const makePrimary = (name: string) => {
    setPending(name);
    setError(null);
    void setPrimary(name)
      .then(() => haptic.success())
      .catch((e: unknown) => {
        haptic.error();
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPending(null));
  };

  // The list is the sheet's root view: a form sheet sizes its first scroll
  // view to the sheet, and anything laid out beside it (a header row) gets
  // flattened and overlaps the list. The header rides inside the list as its
  // sticky first row instead.
  return (
    // Clears the status bar when pushed full-screen; a form sheet measures no top inset.
    <Screen edges={["top"]} background={t.c.bg2}>
      <FlatList
        style={{ flex: 1, backgroundColor: t.c.bg2 }}
        data={agents}
        keyExtractor={(a) => a.name}
        stickyHeaderIndices={[0]}
        contentContainerStyle={{ paddingBottom: insets.bottom + t.space.xl }}
        refreshControl={
          <RefreshControl
            tintColor={t.c.fg3}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: t.space.xl,
              paddingTop: t.space.xl,
              paddingBottom: t.space.md,
              backgroundColor: t.c.bg2,
              borderBottomWidth: t.border.row,
              borderBottomColor: t.c.line,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="title" weight={700}>
                Listening
              </Text>
              <Text variant="bodySmall" tone="fg3">
                {listening.size === 0 ? "None yet" : `${listening.size} of ${agents.length} instances`}
              </Text>
            </View>
            <Button label="Done" variant="secondary" compact onPress={() => router.back()} />
          </View>
        }
        ListFooterComponent={
          agents.length > 0 ? (
            <View style={{ padding: t.space.lg, gap: t.space.sm }}>
              {/* A failed switch lands here: the list is not empty, so the
                empty state that shows a load error is not on screen. */}
              {error ? (
                <Text variant="bodySmall" tone="bad" accessibilityRole="alert">
                  {error}
                </Text>
              ) : null}
              {fleetState.stale ? (
                <Text variant="bodySmall" tone="warn">
                  No box answered for the fleet list: statuses are from the last answer, or unknown.
                </Text>
              ) : null}
              <Text variant="bodySmall" tone="fg3">
                Listened instances show their bots on home, raise alerts, and push to this phone. The
                choice is kept on this phone only.
              </Text>
              <Text variant="bodySmall" tone="fg3">
                Home is built around the primary instance. Long-press another instance to make it
                primary.
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          fleetState.refreshing ? (
            <View>
              {[0, 1, 2, 3].map((i) => (
                <SkeletonRow key={i} />
              ))}
            </View>
          ) : (
            <View style={{ padding: t.space.lg, gap: t.space.sm }}>
              <Text tone="fg3">This fleet has no agents.</Text>
              <Button label="Try again" variant="secondary" onPress={() => void load()} />
            </View>
          )
        }
        renderItem={({ item, index }) => {
          const on = listening.has(item.name);
          const isPrimary = item.name === primary;
          return (
            <View>
              {/* A full-width 1px rule between rows; no rule above the first. */}
              {index === 0 ? null : (
                <View style={{ height: t.border.row, backgroundColor: t.c.line }} />
              )}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: t.space.md,
                  paddingLeft: t.space.xl,
                  paddingRight: t.space.lg,
                  minHeight: 60,
                }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    backgroundColor: item.status ? statusColor(t.c, item.status).color : t.c.fg3,
                  }}
                />
                <Pressable
                  testID={`listening-row-${item.name}`}
                  style={{ flex: 1, justifyContent: "center", minHeight: t.touch.min }}
                  accessibilityLabel={`${item.name}${isPrimary ? ", primary" : ""}, ${item.status ?? "status unknown"}`}
                  {...(isPrimary
                    ? {}
                    : {
                        accessibilityHint: "Long-press to make it primary",
                        accessibilityActions: [{ name: "makePrimary", label: "Make primary" }],
                        onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
                          if (e.nativeEvent.actionName === "makePrimary") makePrimary(item.name);
                        },
                        onLongPress: () => showRowMenu(item.name, () => makePrimary(item.name), t.c.fg),
                        delayLongPress: 350,
                      })}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                    <Text weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
                      {item.name}
                    </Text>
                    {isPrimary ? <PrimaryTag /> : null}
                  </View>
                  <Text mono variant="caption" tone="fg3">
                    {item.status ?? "status unknown"}
                  </Text>
                </Pressable>
                {/* The switch is the row's control; the agent's page (its browser) is
                  a named, secondary button, not a chevron that reads as the row's tap. */}
                <Button
                  label="Browser"
                  accessibilityLabel={`Open ${item.name} browser`}
                  variant="secondary"
                  compact
                  hitSlop={6}
                  onPress={() => {
                    // Close the sheet first: pushed from inside it, the browser
                    // lands in the sheet's own context with no back button.
                    router.back();
                    router.push(`/agent/${encodeURIComponent(item.name)}`);
                  }}
                />
                <ToggleSwitch
                  accessibilityLabel={`Listen to ${item.name}`}
                  value={on}
                  disabled={pending === item.name}
                  onValueChange={(next) => {
                    haptic.select();
                    setPending(item.name);
                    setError(null);
                    const change = client
                      ? client.roster.listen(item.name, next)
                      : fleet.setListening(item.name, next);
                    void change
                      .catch((e: unknown) => {
                        haptic.error();
                        setError(e instanceof Error ? e.message : String(e));
                      })
                      .finally(() => setPending(null));
                  }}
                />
              </View>
            </View>
          );
        }}
      />
    </Screen>
  );
}
