/**
 * The instance picker (a sheet over Bots and Settings): every agent in the
 * fleet (`agents.list`) with its status, and a switch per row that listens or
 * stops listening (`chat.listen`). Only listened instances show bots and
 * raise chat notifications — on this phone and on the laptop alike.
 */
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBridge } from "../src/bridge/BridgeProvider.tsx";
import { useRoster } from "../src/bridge/hooks.ts";
import type { AgentView } from "../src/protocol/types.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Kicker, SkeletonRow, StatusSquare, Text } from "../src/ui/index.ts";

export default function Listening() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { client } = useBridge();
  const { state } = useRoster();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const list = await client.rpc<AgentView[]>("agents.list", {});
      setAgents(Array.isArray(list) ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const listening = new Set(state?.listening ?? []);

  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          padding: t.space.lg,
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
      <FlatList
        data={agents ?? []}
        keyExtractor={(a) => a.name}
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
          <Text variant="bodySmall" tone="fg2" style={{ padding: t.space.lg }}>
            Listened instances show their bots on the Bots tab and raise chat notifications. The choice
            is shared with the laptop.
          </Text>
        }
        ListEmptyComponent={
          agents === null && !error ? (
            <View>
              {[0, 1, 2, 3].map((i) => (
                <SkeletonRow key={i} />
              ))}
            </View>
          ) : (
            <View style={{ padding: t.space.lg, gap: t.space.sm }}>
              <Text tone={error ? "bad" : "fg3"}>{error ?? "This fleet has no agents."}</Text>
              {error ? (
                <Button label="Try again" variant="secondary" onPress={() => void load()} />
              ) : null}
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
              <StatusSquare status={item.display_status} />
              <View style={{ flex: 1 }}>
                <Text mono weight={700}>
                  {item.name}
                </Text>
                <Text mono variant="caption" tone="fg3">
                  {item.display_status}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.name}'s browser`}
                hitSlop={8}
                onPress={() => router.push(`/agent/${encodeURIComponent(item.name)}`)}
                style={{ paddingHorizontal: t.space.sm }}
              >
                <Text mono tone="fg2">
                  ◫
                </Text>
              </Pressable>
              <Switch
                accessibilityLabel={`Listen to ${item.name}`}
                value={on}
                disabled={pending === item.name}
                trackColor={{ true: t.c.acc, false: t.c.line2 }}
                onValueChange={(next) => {
                  haptic.select();
                  setPending(item.name);
                  void client?.roster
                    .listen(item.name, next)
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
    </View>
  );
}
