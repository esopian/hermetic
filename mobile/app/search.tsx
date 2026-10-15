/**
 * Search, on demand from the home bar: an autofocused field over the listened
 * bots (name, title, description, instance and the last message's preview,
 * `searchBots`), results drawn as home rows. A tap opens the bot's chat; back
 * from it returns here with the query kept. Cancel returns home.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, TextInput, useWindowDimensions, View } from "react-native";
import { HomeBotRow } from "../src/bots/HomeBotRow.tsx";
import { quietSuffix } from "../src/bots/suffix.ts";
import { failedBots, type HomeRow, homeRowsByKey, needsBots } from "../src/client/home-rows.ts";
import { botKey } from "../src/client/roster-store.ts";
import { searchBots } from "../src/client/search.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetState, useInbox, useRoster } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Icon, IconButton, Screen, Text } from "../src/ui/index.ts";
import { useNow } from "../src/ui/useNow.ts";

export default function Search() {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const fieldHeight = Math.max(t.touch.min, Math.ceil(20 + 20 * fontScale));
  const { client } = useFleetContext();
  const fleet = useFleetState();
  const { state } = useRoster();
  const inbox = useInbox();
  const now = useNow();
  const [query, setQuery] = useState("");
  const fleetId = fleet.link?.payload.fleet_id ?? "";
  // Focused a frame after mount rather than with `autoFocus`: a field that is
  // first responder before its tint lands keeps the system-blue caret on iOS.
  const field = useRef<TextInput>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // Every listened bot as a home row (badge, reachability, failure), so a
  // result is drawn by the home's own rules.
  const { bots, rowsByKey, many } = useMemo(() => {
    const swarms = state?.swarms ?? [];
    const listening = state?.listening ?? [];
    const entries = inbox?.entries ?? [];
    const listened = new Set(listening);
    return {
      bots: swarms.filter((s) => listened.has(s.instance)).flatMap((s) => s.bots),
      rowsByKey: homeRowsByKey({
        swarms,
        listening,
        ...(client ? { unreadOf: client.inbox.unreadFor } : {}),
        failed: failedBots(entries),
        needs: needsBots(entries),
      }),
      many: listening.length > 1,
    };
  }, [state?.swarms, state?.listening, client, inbox?.entries]);

  const results = useMemo(
    () =>
      searchBots(bots, query)
        .map((b) => rowsByKey.get(botKey(b.instance, b.name)))
        .filter((r): r is HomeRow => r !== undefined),
    [bots, rowsByKey, query],
  );

  const onOpen = useCallback(
    (bot: Bot) => {
      haptic.select();
      client?.roster.markSeen(bot.instance, bot.name);
      router.push(`/chat/${encodeURIComponent(bot.instance)}/${encodeURIComponent(bot.name)}`);
    },
    [client],
  );

  const searching = query.trim() !== "";
  const listening = state?.listening.length ?? 0;
  const hint = !searching
    ? listening === 0
      ? "Listen to an instance in Settings to search its bots."
      : "Search bots by name, instance or what was said last."
    : results.length === 0
      ? "No bots match."
      : null;

  return (
    <Screen edges={["top", "bottom"]}>
      <View
        style={{
          flexDirection: fontScale > 1.5 ? "column" : "row",
          alignItems: "stretch",
          gap: t.space.sm,
          paddingLeft: t.space.lg,
          paddingRight: t.space.sm,
          paddingVertical: t.space.sm,
        }}
      >
        <View
          style={{
            flexGrow: 1,
            flexShrink: 1,
            flexDirection: "row",
            alignItems: "center",
            minHeight: fieldHeight,
            borderRadius: 22,
            backgroundColor: t.c.bg2,
            paddingLeft: t.space.md,
            gap: t.space.sm,
          }}
        >
          <Icon name="search" size={18} color={t.c.fg3} />
          <TextInput
            ref={field}
            value={query}
            onChangeText={setQuery}
            placeholder="Search bots"
            placeholderTextColor={t.c.fg2}
            accessibilityLabel="Search bots"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="never"
            returnKeyType="search"
            keyboardAppearance={t.scheme === "dark" ? "dark" : "light"}
            selectionColor={t.c.acc}
            cursorColor={t.c.acc}
            style={{
              flex: 1,
              minHeight: fieldHeight,
              color: t.c.fg,
              fontFamily: t.sans(400),
              fontSize: 16,
              paddingVertical: 0,
            }}
          />
          {query ? (
            <IconButton
              icon="close"
              label="Clear search"
              size={44}
              ring={false}
              onPress={() => {
                haptic.select();
                setQuery("");
              }}
            />
          ) : (
            <View style={{ width: t.space.sm }} />
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel search"
          onPress={() => router.back()}
          style={({ pressed }) => ({
            minHeight: t.touch.min,
            paddingHorizontal: t.space.sm,
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontSize: 16 }}>Cancel</Text>
        </Pressable>
      </View>
      <FlatList
        data={results}
        keyExtractor={(r) => r.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: t.space.sm, paddingBottom: t.space.xxl }}
        ListHeaderComponent={
          hint ? (
            <Text
              tone="fg3"
              style={{ textAlign: "center", paddingHorizontal: t.space.xl, paddingTop: t.space.xxl }}
            >
              {hint}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <HomeBotRow
            bot={item.bot}
            fleetId={fleetId}
            now={now}
            badge={item.badge}
            // Results mix instances with no section headers, so the instance is said
            // here, after the bot's name when its title is shared; neither when it
            // only repeats the title ("atlas · atlas").
            suffix={quietSuffix(
              item.bot.title || item.bot.name,
              item.suffix,
              many ? item.bot.instance : null,
            )}
            reachable={item.reachable}
            failed={item.failed}
            onPress={() => onOpen(item.bot)}
          />
        )}
      />
    </Screen>
  );
}
