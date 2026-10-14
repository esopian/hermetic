/**
 * Home: one open screen. A top bar of round buttons (Settings on the left,
 * Search and New chat on the right), a slim Tailscale strip only when the
 * probe says something is wrong, the hero (every bot pinned on this phone, or
 * with none pinned the default bot of each listened instance), then one quiet
 * section per listened instance with the rest of its bots — needs-you, unread,
 * most recent, name (`homeRows`). Unread and needs-you live on the bots
 * themselves; there is no inbox screen. Long-press any bot for its menu; tap a
 * section header to fold it. Pull to refresh; polled every 60 s while in front.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { FlashList } from "@shopify/flash-list";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { showBotMenu } from "../src/bots/botMenu.ts";
import { HOME_ROW_HEIGHT, HomeBotRow, ROW_AVATAR } from "../src/bots/HomeBotRow.tsx";
import { HERO_SOLO, HomeHero } from "../src/bots/HomeHero.tsx";
import {
  failedBots,
  type HomeItem,
  type HomeRow,
  type HomeSection,
  homeItems,
  homeRows,
  needsBots,
  sectionState,
} from "../src/client/home-rows.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState, useInbox, useRoster } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { statusColor } from "../src/theme/tokens.ts";
import { TailscaleBanner } from "../src/ui/Banner.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Icon, IconButton, Screen, Skeleton, Text } from "../src/ui/index.ts";
import { useNow } from "../src/ui/useNow.ts";
import { usePullRefresh } from "../src/ui/usePullRefresh.ts";

const POLL_MS = 60_000;

const chatHref = (bot: Pick<Bot, "instance" | "name">) =>
  `/chat/${encodeURIComponent(bot.instance)}/${encodeURIComponent(bot.name)}` as const;

export default function Home() {
  const t = useTheme();
  const { client, status: pairing, tailscale, probing, probeTailscale, refresh } = useFleetContext();
  const fleet = useFleetState();
  const agents = useFleetAgents();
  const { state } = useRoster();
  const inbox = useInbox();
  const now = useNow();
  const fleetId = fleet.link?.payload.fleet_id ?? "";

  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      void client.roster.refresh();
      const timer = setInterval(() => void client.roster.refresh(), POLL_MS);
      return () => clearInterval(timer);
    }, [client]),
  );

  const layout = useMemo(() => {
    const entries = inbox?.entries ?? [];
    return homeRows({
      swarms: state?.swarms ?? [],
      listening: state?.listening ?? [],
      pinned: state?.prefs.pinned ?? [],
      folded: state?.prefs.folded ?? [],
      ...(client ? { unreadOf: client.inbox.unreadFor } : {}),
      failed: failedBots(entries),
      needs: needsBots(entries),
    });
  }, [state, inbox, client]);
  const items = useMemo(() => homeItems(layout.sections), [layout]);
  const agentStatus = useMemo(() => new Map(agents.map((a) => [a.name, a.status ?? null])), [agents]);

  const open = useCallback(
    (bot: Bot) => {
      haptic.select();
      client?.roster.markSeen(bot.instance, bot.name);
      router.push(chatHref(bot));
    },
    [client],
  );

  const menu = useCallback(
    (row: HomeRow) => {
      const { bot } = row;
      showBotMenu(
        bot,
        { pinned: row.pinned, clearable: row.clearable },
        {
          togglePin: () => {
            haptic.success();
            client?.roster.togglePinned(bot.instance, bot.name);
          },
          openBrowser: () => router.push(`/agent/${encodeURIComponent(bot.instance)}`),
          // Clears the roster's unread and every unread inbox entry of the bot:
          // the inbox-derived needs-you, unread and failed marks all go with them.
          markRead: () => {
            client?.roster.markSeen(bot.instance, bot.name);
            client?.inbox.markThreadRead(bot.instance, bot.name);
          },
        },
        t.c.fg,
      );
    },
    [client, t.c.fg],
  );

  const fold = useCallback(
    (instance: string) => {
      haptic.select();
      client?.roster.toggleFolded(instance);
    },
    [client],
  );

  const read = useCallback(() => {
    if (!client) return Promise.resolve();
    haptic.light();
    return refresh();
  }, [client, refresh]);
  const { refreshing, onRefresh } = usePullRefresh(client ? read : null);

  // The strip comes back whenever the probe's answer changes.
  const probe = tailscale?.status ?? null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (dismissed !== null && dismissed !== probe) setDismissed(null);
  }, [probe, dismissed]);

  // A hairline under the top bar, only once the list has scrolled under it.
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setScrolled(e.nativeEvent.contentOffset.y > 2);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: HomeItem }) =>
      item.type === "section" ? (
        <SectionHeader
          section={item.section}
          agentStatus={agentStatus.get(item.section.instance) ?? null}
          onToggle={fold}
        />
      ) : (
        <HomeBotRow
          bot={item.row.bot}
          fleetId={fleetId}
          now={now}
          badge={item.row.badge}
          suffix={item.row.suffix}
          reachable={item.row.reachable}
          failed={item.row.failed}
          onPress={() => open(item.row.bot)}
          onLongPress={() => menu(item.row)}
        />
      ),
    [fleetId, now, open, menu, fold, agentStatus],
  );

  if (pairing === "unpaired") return <Redirect href="/pair" />;

  const listening = state?.listening.length ?? 0;
  // Never read yet (and not failed) is loading, so the empty state never flashes before the first read.
  const loading = !state?.readAt && !state?.error;
  const error = state?.readAt ? null : (state?.error ?? null);
  // The strip explains a failed read only while it is on screen; once dismissed, the error does.
  const banded = (probe === "off" || probe === "unreachable") && dismissed !== probe;

  const header =
    layout.hero.length > 0 ? (
      <HomeHero
        rows={layout.hero}
        starred={layout.heroPinned}
        fleetId={fleetId}
        onPress={(row) => open(row.bot)}
        onLongPress={menu}
      />
    ) : loading ? (
      <HomeSkeleton />
    ) : null;

  const empty = loading ? null : error && !banded ? (
    <View style={{ paddingHorizontal: t.space.xl, paddingVertical: t.space.xl, gap: t.space.md }}>
      <Text weight={700} tone="bad">
        Could not read the bots.
      </Text>
      <Text variant="bodySmall" tone="fg2">
        {error}
      </Text>
      <Button label="Try again" variant="secondary" soft onPress={onRefresh} />
    </View>
  ) : null;

  return (
    <Screen>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: t.space.lg,
          paddingTop: t.space.sm,
          paddingBottom: t.space.sm,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: scrolled ? t.c.line : "transparent",
        }}
      >
        <IconButton icon="gear" label="Settings" onPress={() => router.push("/settings")} />
        <View style={{ flexDirection: "row", gap: t.space.md }}>
          <IconButton icon="search" label="Search" onPress={() => router.push("/search")} />
          <IconButton icon="plus" label="New chat" onPress={() => router.push("/new-chat")} />
        </View>
      </View>
      {dismissed === probe ? null : (
        <TailscaleBanner
          status={probe}
          busy={probing}
          onRetry={() => {
            haptic.light();
            void probeTailscale().then(() => client?.roster.refresh());
          }}
          onDismiss={() => setDismissed(probe)}
        />
      )}
      {state && listening === 0 && !loading ? (
        <EmptyHome />
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          renderItem={renderItem}
          extraData={now}
          // A bot that just spoke moves up; without this the list holds the old
          // rows in place and the mover lands above the viewport.
          maintainVisibleContentPosition={{ disabled: true }}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          contentContainerStyle={{ paddingBottom: t.space.xxl }}
          onScroll={onScroll}
          scrollEventThrottle={32}
          refreshControl={
            <RefreshControl tintColor={t.c.fg3} refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      )}
    </Screen>
  );
}

/**
 * A quiet header over one instance's bots: a status dot, the instance name in
 * small muted capitals, its state when its box is not answering, and (folded)
 * a dot when something inside is unread. Tap folds a reachable instance.
 */
function SectionHeader({
  section,
  agentStatus,
  onToggle,
}: {
  section: HomeSection;
  agentStatus: string | null;
  onToggle: (instance: string) => void;
}) {
  const t = useTheme();
  const { word, status } = sectionState(section.reachable, agentStatus);
  const hidden = section.folded && (section.needs || section.unread > 0);
  return (
    <Pressable
      testID={`home-section-${section.instance}`}
      accessibilityRole="header"
      accessibilityLabel={[
        section.instance,
        word,
        section.folded ? "folded" : null,
        section.needs ? "a bot needs you" : section.unread > 0 ? `${section.unread} unread` : null,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={
        section.reachable ? (section.folded ? "Tap to show" : "Tap to fold") : undefined
      }
      disabled={!section.reachable}
      onPress={() => onToggle(section.instance)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        paddingHorizontal: t.space.lg + t.space.xs,
        paddingTop: t.space.lg,
        paddingBottom: t.space.xs,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: statusColor(t.c, status).color,
        }}
      />
      <Text
        variant="caption"
        weight={600}
        tone="fg3"
        numberOfLines={1}
        style={{ textTransform: "uppercase", letterSpacing: 0.8, flexShrink: 1 }}
      >
        {section.instance}
      </Text>
      {word ? (
        <Text variant="caption" tone="fg3" numberOfLines={1}>
          {`· ${word}`}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      {hidden ? (
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 3.5,
            backgroundColor: section.needs ? t.c.warn : t.c.acc,
          }}
        />
      ) : null}
      {section.reachable ? (
        <View style={{ transform: [{ rotate: section.folded ? "180deg" : "-90deg" }] }}>
          <Icon name="back" size={12} color={t.c.fg3} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Nothing listened to: one centred prompt and the way to fix it. */
function EmptyHome() {
  const t = useTheme();
  return (
    <View
      testID="home-empty"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: t.space.xxl,
        gap: t.space.md,
        paddingBottom: t.space.xxl * 2,
      }}
    >
      <Text variant="heading" weight={700} style={{ textAlign: "center" }}>
        No bots yet
      </Text>
      <Text tone="fg2" style={{ textAlign: "center" }}>
        Listen to an instance and its bots show up here. Only listened instances raise notifications.
      </Text>
      <Button
        label="Choose instances"
        soft
        onPress={() => {
          haptic.select();
          router.push("/listening");
        }}
        style={{ marginTop: t.space.sm, paddingHorizontal: t.space.xl }}
      />
    </View>
  );
}

/** The first read is still out: a hero circle and a few row shapes. */
function HomeSkeleton() {
  const t = useTheme();
  return (
    <View testID="home-loading">
      <View style={{ alignItems: "center", paddingVertical: t.space.xl, gap: t.space.sm }}>
        <Skeleton width={HERO_SOLO} height={HERO_SOLO} style={{ borderRadius: HERO_SOLO / 2 }} />
        <Skeleton width={90} height={12} style={{ borderRadius: 6 }} />
      </View>
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: t.space.lg,
            paddingHorizontal: t.space.lg + t.space.xs,
            height: HOME_ROW_HEIGHT,
          }}
        >
          <Skeleton width={ROW_AVATAR} height={ROW_AVATAR} style={{ borderRadius: ROW_AVATAR / 2 }} />
          <View style={{ flex: 1, gap: t.space.sm }}>
            <Skeleton width="40%" height={12} style={{ borderRadius: 6 }} />
            <Skeleton width="80%" height={10} style={{ borderRadius: 5 }} />
          </View>
        </View>
      ))}
    </View>
  );
}
