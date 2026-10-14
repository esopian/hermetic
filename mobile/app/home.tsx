/**
 * Home: one open screen. A top bar of round buttons (Settings on the left,
 * Search and New chat on the right), a slim Tailscale strip only when the
 * probe says something is wrong, the operator's primary bot as a hero, and
 * every other listened bot in one flat list — pinned first, then needs-you,
 * unread, most recent, name (`homeRows`). Unread and needs-you live on the bots
 * themselves; there is no inbox screen. Long-press any bot for its menu.
 * Pull to refresh; polled every 60 s while in front.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { FlashList } from "@shopify/flash-list";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, View } from "react-native";
import { showBotMenu } from "../src/bots/botMenu.ts";
import { HOME_ROW_HEIGHT, HomeBotRow } from "../src/bots/HomeBotRow.tsx";
import { HERO_AVATAR, HomeHero } from "../src/bots/HomeHero.tsx";
import { failedBots, type HomeRow, homeRows } from "../src/client/home-rows.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState, useInbox, useRoster } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { TailscaleBanner } from "../src/ui/Banner.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, IconButton, Screen, Skeleton, Text } from "../src/ui/index.ts";
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

  const layout = useMemo(
    () =>
      homeRows({
        swarms: state?.swarms ?? [],
        listening: state?.listening ?? [],
        pinned: state?.prefs.pinned ?? [],
        primary: state?.prefs.primary ?? null,
        ...(client ? { unreadOf: client.inbox.unreadFor } : {}),
        failed: failedBots(inbox?.entries ?? []),
      }),
    [state, inbox, client],
  );

  const open = useCallback(
    (bot: Bot) => {
      haptic.select();
      client?.roster.markSeen(bot.instance, bot.name);
      router.push(chatHref(bot));
    },
    [client],
  );

  const heroKey = layout.hero?.key ?? null;
  const menu = useCallback(
    (row: HomeRow) => {
      const { bot } = row;
      showBotMenu(
        bot,
        { primary: row.key === heroKey, pinned: row.pinned, unread: row.badge !== null || row.failed },
        {
          makePrimary: () => {
            haptic.success();
            client?.roster.setPrimary(bot.instance, bot.name);
          },
          togglePin: () => {
            haptic.success();
            client?.roster.togglePinned(bot.instance, bot.name);
          },
          openBrowser: () => router.push(`/agent/${encodeURIComponent(bot.instance)}`),
          markRead: () => {
            client?.roster.markSeen(bot.instance, bot.name);
            client?.inbox.markThreadRead(bot.instance, bot.name);
          },
        },
      );
    },
    [client, heroKey],
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

  const renderItem = useCallback(
    ({ item }: { item: HomeRow }) => (
      <HomeBotRow
        bot={item.bot}
        fleetId={fleetId}
        now={now}
        badge={item.badge}
        suffix={item.suffix}
        reachable={item.reachable}
        failed={item.failed}
        onPress={() => open(item.bot)}
        onLongPress={() => menu(item)}
      />
    ),
    [fleetId, now, open, menu],
  );

  if (pairing === "unpaired") return <Redirect href="/pair" />;

  const listening = state?.listening.length ?? 0;
  // Never read yet (and not failed) is loading, so the empty state never flashes before the first read.
  const loading = !state?.readAt && !state?.error;
  const error = state?.readAt ? null : (state?.error ?? null);
  const banded = probe === "off" || probe === "unreachable";

  const hero = layout.hero;
  const heroStatus = (() => {
    if (!hero || hero.reachable) return null;
    const agent = agents.find((a) => a.name === hero.bot.instance);
    // The fleet view's word when it has a telling one ("stopped", "bootstrapping").
    const word = agent?.status;
    return word && word !== "ready" && word !== "degraded" && word !== "unreachable"
      ? `${hero.bot.instance} is ${word}`
      : `${hero.bot.instance} is not answering`;
  })();

  const header = hero ? (
    <HomeHero
      bot={hero.bot}
      fleetId={fleetId}
      badge={hero.badge}
      suffix={hero.suffix}
      reachable={hero.reachable}
      failed={hero.failed}
      status={heroStatus}
      onPress={() => open(hero.bot)}
      onLongPress={() => menu(hero)}
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
      <Button label="Try again" variant="secondary" onPress={onRefresh} />
    </View>
  ) : null;

  const footer =
    layout.down.length > 0 ? (
      <View style={{ paddingHorizontal: t.space.xl, paddingVertical: t.space.lg, gap: t.space.xs }}>
        {layout.down.map((d) => (
          <Text key={d.instance} variant="bodySmall" tone="fg3" style={{ textAlign: "center" }}>
            {`No answer from ${d.instance}. Its bots come back when it does.`}
          </Text>
        ))}
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
          paddingBottom: t.space.xs,
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
          data={layout.rows}
          keyExtractor={(row) => row.key}
          renderItem={renderItem}
          extraData={now}
          // A bot that just spoke moves up; without this the list holds the old
          // rows in place and the mover lands above the viewport.
          maintainVisibleContentPosition={{ disabled: true }}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={footer}
          contentContainerStyle={{ paddingBottom: t.space.xxl }}
          refreshControl={
            <RefreshControl tintColor={t.c.fg3} refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      )}
    </Screen>
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
        onPress={() => {
          haptic.select();
          router.push("/listening");
        }}
        style={{ marginTop: t.space.sm, alignSelf: "stretch" }}
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
        <Skeleton width={HERO_AVATAR} height={HERO_AVATAR} style={{ borderRadius: HERO_AVATAR / 2 }} />
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
          <Skeleton width={56} height={56} style={{ borderRadius: 28 }} />
          <View style={{ flex: 1, gap: t.space.sm }}>
            <Skeleton width="40%" height={12} style={{ borderRadius: 6 }} />
            <Skeleton width="80%" height={10} style={{ borderRadius: 5 }} />
          </View>
        </View>
      ))}
    </View>
  );
}
