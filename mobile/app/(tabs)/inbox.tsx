/**
 * Inbox: `notifications.list` rows, newest first, runs about one conversation
 * folded into one card. Live `notification` frames land on top. Tap opens the
 * conversation (or the agent's browser); swipe marks read; "Mark all read"
 * clears the lot. The app icon badge follows the unread count.
 */
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { useInbox } from "../../src/bridge/hooks.ts";
import {
  groupNotifications,
  type NotificationGroup,
  rowDestination,
} from "../../src/client/inbox-logic.ts";
import { InboxRow } from "../../src/inbox/InboxRow.tsx";
import type { Notification } from "../../src/protocol/types.ts";
import { useTheme } from "../../src/theme/theme.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { Kicker, Screen, SkeletonRow, Text } from "../../src/ui/index.ts";
import { useNow } from "../../src/ui/useNow.ts";

export default function Inbox() {
  const t = useTheme();
  const { client } = useBridge();
  const inbox = useInbox();
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);
  const rows = inbox?.rows ?? [];
  const groups = useMemo(() => groupNotifications(rows), [rows]);
  const unread = inbox?.counts.unread ?? 0;
  const needs = inbox?.counts.needs_action ?? 0;

  const onOpen = useCallback(
    (group: NotificationGroup<Notification>) => {
      haptic.select();
      const ids = group.rows.filter((r) => !r.read_at).map((r) => r.id);
      if (ids.length) void client?.inbox.ack(ids);
      const where = rowDestination(group.latest);
      if (where?.kind === "chat")
        router.push(`/chat/${encodeURIComponent(where.instance)}/${encodeURIComponent(where.bot)}`);
      else if (where?.kind === "agent") router.push(`/agent/${encodeURIComponent(where.name)}`);
    },
    [client],
  );

  const onAck = useCallback(
    (group: NotificationGroup<Notification>) => {
      const ids = group.rows.filter((r) => !r.read_at).map((r) => r.id);
      if (ids.length) {
        haptic.success();
        void client?.inbox.ack(ids);
      }
    },
    [client],
  );

  const markAll = () => {
    const ids = rows.filter((r) => !r.read_at).map((r) => r.id);
    if (!ids.length) return;
    haptic.success();
    void client?.inbox.ack(ids);
  };

  const loading = !!inbox?.loading && rows.length === 0;

  return (
    <Screen>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          paddingHorizontal: t.space.lg,
          paddingTop: t.space.md,
          paddingBottom: t.space.md,
          borderBottomWidth: 1,
          borderBottomColor: t.c.line,
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <Kicker tone={needs > 0 ? "warn" : "fg3"}>{`${needs} need you · ${unread} unread`}</Kicker>
          <Text variant="display">Inbox</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Mark all read"
          accessibilityState={{ disabled: unread === 0 }}
          disabled={unread === 0}
          onPress={markAll}
          style={({ pressed }) => ({
            borderWidth: t.border.control,
            borderColor: unread === 0 ? t.c.line2 : t.c.fg,
            paddingHorizontal: t.space.md,
            height: 36,
            justifyContent: "center",
            opacity: unread === 0 ? 0.45 : 1,
            backgroundColor: pressed ? t.c.sel : "transparent",
          })}
        >
          <Text variant="caption" weight={800} uppercase style={{ letterSpacing: 1 }}>
            Mark all read
          </Text>
        </Pressable>
      </View>
      <FlashList
        data={groups}
        keyExtractor={(g) => g.key}
        extraData={now}
        renderItem={({ item }) => <InboxRow group={item} now={now} onOpen={onOpen} onAck={onAck} />}
        refreshControl={
          <RefreshControl
            tintColor={t.c.fg3}
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              haptic.light();
              await client?.inbox.refresh();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          loading ? (
            <View>
              {[0, 1, 2, 3].map((i) => (
                <SkeletonRow key={i} />
              ))}
            </View>
          ) : inbox?.error ? (
            <View style={{ padding: t.space.xl, gap: t.space.sm }}>
              <Text tone="bad" weight={700}>
                Could not read the inbox.
              </Text>
              <Text variant="bodySmall" tone="fg2">
                {inbox.error}
              </Text>
            </View>
          ) : (
            <View style={{ padding: t.space.xl, gap: t.space.sm, alignItems: "center", marginTop: 60 }}>
              <Text variant="title">Nothing waiting.</Text>
              <Text variant="bodySmall" tone="fg3" style={{ textAlign: "center" }}>
                Replies, approvals and questions from listened instances land here.
              </Text>
            </View>
          )
        }
      />
    </Screen>
  );
}
