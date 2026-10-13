/** Inbox (placeholder for the next phase): rows newest first, tap opens the thread. */
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { useInbox } from "../../src/bridge/hooks.ts";
import { chatThreadOf } from "../../src/client/notifications-store.ts";
import { useTheme } from "../../src/theme/theme.tsx";
import { classColor } from "../../src/theme/tokens.ts";
import { Kicker, Screen, StatusSquare, Text } from "../../src/ui/index.ts";

export default function Inbox() {
  const t = useTheme();
  const { client } = useBridge();
  const inbox = useInbox();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Screen>
      <View style={{ padding: t.space.lg, gap: 4 }}>
        <Kicker>
          {inbox?.counts.needs_action ?? 0} need you · {inbox?.counts.unread ?? 0} unread
        </Kicker>
        <Text variant="heading">Inbox</Text>
      </View>
      <FlashList
        data={inbox?.rows ?? []}
        keyExtractor={(row) => row.id}
        refreshControl={
          <RefreshControl
            tintColor={t.c.fg3}
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await client?.inbox.refresh();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          <Text tone="fg3" style={{ padding: t.space.xl }}>
            Nothing waiting.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void client?.inbox.ack([item.id]);
              const thread = chatThreadOf(item);
              if (thread)
                router.push(
                  `/chat/${encodeURIComponent(thread.instance)}/${encodeURIComponent(thread.bot)}`,
                );
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              gap: t.space.md,
              padding: t.space.lg,
              backgroundColor: pressed ? t.c.sel : t.c.bg,
              borderBottomWidth: t.border.row,
              borderBottomColor: t.c.line,
              opacity: item.read_at ? 0.6 : 1,
            })}
          >
            <View style={{ paddingTop: 5 }}>
              <StatusSquare size={8} color={classColor(t.c, item.class)} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text weight={item.read_at ? 400 : 700} numberOfLines={1}>
                {item.title}
              </Text>
              {item.detail ? (
                <Text variant="bodySmall" tone="fg2" numberOfLines={2}>
                  {item.detail}
                </Text>
              ) : null}
              <Text variant="caption" mono tone="fg3">
                {new Date(item.at).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}
