/**
 * Bots list (placeholder for the next phase): pinned block, then one bucket
 * per listened instance, ordered by the desktop's rail rules. Pull to refresh;
 * polled every 60 s while in front (`.context/mobile-protocol.md`).
 */
import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { useRoster } from "../../src/bridge/hooks.ts";
import { rosterFooter, unreadBadge } from "../../src/client/roster-store.ts";
import type { Bot } from "../../src/protocol/types.ts";
import { useTheme } from "../../src/theme/theme.tsx";
import { Avatar, Badge, Kicker, Screen, SkeletonRow, StatusSquare, Text } from "../../src/ui/index.ts";

type Row =
  | { kind: "head"; key: string; label: string; reachable: boolean }
  | { kind: "bot"; key: string; bot: Bot; pinned: boolean };

const POLL_MS = 60_000;

export default function Bots() {
  const t = useTheme();
  const { client, credentials, socketState } = useBridge();
  const { state, layout } = useRoster();
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      void client.roster.refresh();
      const timer = setInterval(() => void client.roster.refresh(), POLL_MS);
      return () => clearInterval(timer);
    }, [client]),
  );

  const rows = useMemo<Row[]>(() => {
    if (!layout) return [];
    const out: Row[] = [];
    if (layout.pinned.length > 0) {
      out.push({ kind: "head", key: "h:pinned", label: "★ Pinned", reachable: true });
      for (const bot of layout.pinned)
        out.push({ kind: "bot", key: `p:${bot.instance}/${bot.name}`, bot, pinned: true });
    }
    for (const bucket of layout.buckets) {
      out.push({
        kind: "head",
        key: `h:${bucket.instance}`,
        label: bucket.reachable
          ? bucket.instance
          : `${bucket.instance} · ${bucket.reason ?? "unreachable"}`,
        reachable: bucket.reachable,
      });
      if (!bucket.folded)
        for (const bot of bucket.bots)
          out.push({ kind: "bot", key: `b:${bot.instance}/${bot.name}`, bot, pinned: false });
    }
    return out;
  }, [layout]);

  const fleetId = credentials?.fleet.fleet_id ?? "";
  const loading = !state?.readAt && (state?.loading ?? true);

  return (
    <Screen>
      <View
        style={{
          paddingHorizontal: t.space.lg,
          paddingTop: t.space.md,
          paddingBottom: t.space.sm,
          gap: 4,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <StatusSquare
            size={8}
            color={socketState === "open" ? t.c.ok : t.c.warn}
            pulse={socketState !== "open"}
          />
          <Kicker>{credentials?.fleet.alias ?? fleetId}</Kicker>
        </View>
        <Text variant="heading">Bots</Text>
        {layout ? (
          <Text variant="caption" mono tone="fg3">
            {rosterFooter(layout).roster} · {rosterFooter(layout).attention}
          </Text>
        ) : null}
      </View>
      {loading ? (
        <View>
          {[0, 1, 2, 3, 4].map((i) => (
            <SkeletonRow key={i} />
          ))}
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.kind}
          refreshControl={
            <RefreshControl
              tintColor={t.c.fg3}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await client?.roster.refresh();
                setRefreshing(false);
              }}
            />
          }
          ListEmptyComponent={
            <View style={{ padding: t.space.xl, gap: t.space.sm }}>
              <Text tone="fg2">No listened instances.</Text>
              <Text variant="bodySmall" tone="fg3">
                Turn listening on for an instance in Settings to see its bots here.
              </Text>
            </View>
          }
          renderItem={({ item }) =>
            item.kind === "head" ? (
              <View
                style={{
                  paddingHorizontal: t.space.lg,
                  paddingVertical: t.space.sm,
                  backgroundColor: t.c.bg2,
                  borderBottomWidth: t.border.row,
                  borderBottomColor: t.c.line,
                }}
              >
                <Kicker tone={item.reachable ? "fg3" : "bad"}>{item.label}</Kicker>
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  client?.roster.markSeen(item.bot.instance, item.bot.name);
                  router.push(
                    `/chat/${encodeURIComponent(item.bot.instance)}/${encodeURIComponent(item.bot.name)}`,
                  );
                }}
                onLongPress={() => client?.roster.togglePinned(item.bot.instance, item.bot.name)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: t.space.md,
                  paddingHorizontal: t.space.lg,
                  minHeight: 60,
                  backgroundColor: pressed ? t.c.sel : t.c.bg,
                  borderBottomWidth: t.border.row,
                  borderBottomColor: t.c.line,
                })}
              >
                <Avatar fleet_id={fleetId} instance={item.bot.instance} bot={item.bot.name} size={34} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text weight={700} numberOfLines={1}>
                    {item.pinned ? `${item.bot.instance} / ` : ""}
                    {item.bot.title}
                  </Text>
                  <Text variant="bodySmall" tone="fg3" numberOfLines={1}>
                    {item.bot.preview ?? item.bot.description ?? item.bot.name}
                  </Text>
                </View>
                <Badge
                  label={unreadBadge(
                    item.bot,
                    client?.inbox.unreadFor(item.bot.instance, item.bot.name) ?? 0,
                  )}
                />
              </Pressable>
            )
          }
        />
      )}
    </Screen>
  );
}
