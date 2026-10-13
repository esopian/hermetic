/**
 * The instance picker (a sheet over Bots and Settings): every agent of the
 * paired fleet (the pairing link's, merged with `GET /fleet`) with its status,
 * and a switch per row that listens or stops listening. The choice is this
 * phone's own (`FleetStore.setListening`): only listened instances show bots,
 * raise alerts, and are asked to push to this phone.
 */
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Kicker, SkeletonRow, StatusSquare, Text, ToggleSwitch } from "../src/ui/index.ts";

export default function Listening() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { client, fleet } = useFleetContext();
  const fleetState = useFleetState();
  const agents = useFleetAgents();
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const load = () => fleet.refresh();
  const listening = new Set(fleet.listened());

  // The list is the sheet's root view: a form sheet sizes its first scroll
  // view to the sheet, and anything laid out beside it (a header row) gets
  // flattened and overlaps the list. The header rides inside the list as its
  // sticky first row instead.
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: t.c.bg }}
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
            paddingHorizontal: t.space.lg,
            paddingTop: t.space.xl,
            paddingBottom: t.space.lg,
            backgroundColor: t.c.bg,
            borderBottomWidth: t.border.control,
            borderBottomColor: t.c.fg,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Kicker>{`${listening.size} listened`}</Kicker>
            <Text variant="heading">Listening</Text>
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
              Listened instances show their bots on the Bots tab, raise alerts, and push to this phone.
              The choice is kept on this phone only.
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
      renderItem={({ item }) => {
        const on = listening.has(item.name);
        return (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: t.space.md,
              paddingHorizontal: t.space.lg,
              minHeight: 60,
              borderBottomWidth: 1,
              borderBottomColor: t.c.line,
            }}
          >
            {item.status ? <StatusSquare status={item.status} /> : <StatusSquare color={t.c.fg3} />}
            <View style={{ flex: 1 }}>
              <Text mono weight={700}>
                {item.name}
              </Text>
              <Text mono variant="caption" tone="fg3">
                {item.status ?? "status unknown"}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              onPress={() => {
                // Close the sheet first: pushed from inside it, the browser
                // lands in the sheet's own context with no back button.
                router.back();
                router.push(`/agent/${encodeURIComponent(item.name)}`);
              }}
              // A 44pt target around a one-glyph label.
              style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}
            >
              <Text mono tone="fg2">
                ◫
              </Text>
            </Pressable>
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
        );
      }}
    />
  );
}
