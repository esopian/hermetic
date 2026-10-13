/**
 * Inbox: the phone's own last 200 events (`src/inbox/store.ts`) — pushes
 * from the boxes and what this phone's sockets saw — newest first, runs about
 * one conversation folded into one card. Tap opens the conversation; swipe
 * marks read; "Mark all read" clears the lot. The app icon badge follows the
 * unread count.
 */
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  groupCondition,
  groupEntries,
  type NotificationGroup,
  rowDestination,
  unackedIds,
} from "../../src/client/inbox-logic.ts";
import { useFleetContext } from "../../src/fleet/FleetProvider.tsx";
import { useInbox, useRoster } from "../../src/fleet/hooks.ts";
import { InboxRow } from "../../src/inbox/InboxRow.tsx";
import type { InboxEntry } from "../../src/inbox/store.ts";
import { useTheme } from "../../src/theme/theme.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { Kicker, Screen, Text } from "../../src/ui/index.ts";
import { useNow } from "../../src/ui/useNow.ts";

export default function Inbox() {
  const t = useTheme();
  const { client } = useFleetContext();
  const inbox = useInbox();
  const now = useNow();
  const entries = inbox?.entries ?? [];
  const groups = useMemo(() => groupEntries(entries), [entries]);
  const roster = useRoster().state;
  // Bot display titles, so a card says "Marshall" where the entry says "scribe · atlas".
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const swarm of roster?.swarms ?? [])
      for (const bot of swarm.bots) if (bot.title) map.set(`${swarm.instance} ${bot.name}`, bot.title);
    return map;
  }, [roster]);
  // Keyed on the store's state too, so every store change repaints the rows.
  const extra = useMemo(() => ({ now, titles, inbox }), [now, titles, inbox]);
  const unread = inbox?.unread ?? 0;
  // Cards still waiting on the operator: an unread needs-you entry in the run.
  // Read ones (opened, swiped, or answered from the conversation) do not count,
  // and a folded run counts once, as the gold markers below it do.
  const needs = useMemo(() => groups.filter((g) => groupCondition(g).needsUnread).length, [groups]);

  const onOpen = useCallback(
    (group: NotificationGroup<InboxEntry>) => {
      haptic.select();
      const ids = unackedIds(group.rows);
      if (ids.length) client?.inbox.markRead(ids);
      const where = rowDestination(group.latest);
      const session = where.session ? `?session=${encodeURIComponent(where.session)}` : "";
      router.push(
        `/chat/${encodeURIComponent(where.instance)}/${encodeURIComponent(where.bot)}${session}` as never,
      );
    },
    [client],
  );

  const onAck = useCallback(
    (group: NotificationGroup<InboxEntry>) => {
      const ids = unackedIds(group.rows);
      if (ids.length) {
        haptic.success();
        client?.inbox.markRead(ids);
      }
    },
    [client],
  );

  const markAll = () => {
    if (unread === 0) return;
    haptic.success();
    client?.inbox.markAllRead();
  };

  return (
    <Screen>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          paddingHorizontal: t.space.lg,
          paddingTop: t.space.md,
          paddingBottom: t.space.md,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: t.c.line2,
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
          // 36pt drawn, 44pt to the thumb.
          hitSlop={{ top: 4, bottom: 4 }}
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
        extraData={extra}
        // FlashList holds the visible rows in place by default, so an entry filed
        // at the top landed above the viewport and showed only after a scroll.
        // Newest-first wants the new row in view.
        maintainVisibleContentPosition={{ disabled: true }}
        renderItem={({ item }) => (
          <InboxRow
            group={item}
            label={titles.get(`${item.latest.instance} ${item.latest.bot}`) ?? null}
            now={now}
            onOpen={onOpen}
            onAck={onAck}
          />
        )}
        ListEmptyComponent={
          <View style={{ padding: t.space.xl, gap: t.space.sm, alignItems: "center", marginTop: 60 }}>
            <Text variant="title">Nothing waiting.</Text>
            <Text variant="bodySmall" tone="fg3" style={{ textAlign: "center" }}>
              Replies, approvals and questions from listened instances land here. The inbox lives on
              this phone: the last 200 events.
            </Text>
          </View>
        }
      />
    </Screen>
  );
}
