/**
 * Bots (home): the listened instances' bots, grouped and ordered by the
 * desktop rail's rules — pinned block on top, one collapsible bucket per
 * instance, needs-you first. Pull to refresh (`chat.swarms`); polled every
 * 60 s while in front. "Listening" opens the instance picker.
 */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { BotsList } from "../../src/bots/BotsList.tsx";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { useRoster } from "../../src/bridge/hooks.ts";
import { SocketBand } from "../../src/chat/Bands.tsx";
import { BANDED_SOCKET_STATES, rosterRows } from "../../src/client/roster-rows.ts";
import type { Bot } from "../../src/protocol/types.ts";
import { useTheme } from "../../src/theme/theme.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { usePullRefresh } from "../../src/ui/usePullRefresh.ts";
import { Kicker, Screen, StatusSquare, Text } from "../../src/ui/index.ts";
import { useNow } from "../../src/ui/useNow.ts";

const POLL_MS = 60_000;

/** What the header says while the socket is not open; anything unlisted is "connecting". */
const KICKER_STATE: Record<string, string> = {
  unavailable: " · bridge unavailable",
  unauthorized: " · refused",
  mismatch: " · version mismatch",
  wrong_fleet: " · bridge serves another fleet",
};

export default function Bots() {
  const t = useTheme();
  const { client, credentials, socketState, reconnect, servedFleet, rePair } = useBridge();
  const { state, layout } = useRoster();
  const now = useNow();

  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      void client.roster.refresh();
      const timer = setInterval(() => void client.roster.refresh(), POLL_MS);
      return () => clearInterval(timer);
    }, [client]),
  );

  const rows = useMemo(() => {
    if (!layout || !client) return [];
    const reachable = new Map((state?.swarms ?? []).map((s) => [s.instance, s.reachable]));
    return rosterRows(layout, client.inbox.unreadFor, (i) => reachable.get(i) ?? true);
  }, [layout, client, state?.swarms]);

  const onOpen = useCallback(
    (bot: Bot) => {
      haptic.select();
      client?.roster.markSeen(bot.instance, bot.name);
      router.push(`/chat/${encodeURIComponent(bot.instance)}/${encodeURIComponent(bot.name)}`);
    },
    [client],
  );

  const onMenu = useCallback(
    (bot: Bot, pinned: boolean) => {
      haptic.medium();
      const toggle = () => {
        haptic.success();
        client?.roster.togglePinned(bot.instance, bot.name);
      };
      const pinLabel = pinned ? "Unpin" : "Pin to top";
      const title = `${bot.title || bot.name} · ${bot.instance}`;
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          { title, options: [pinLabel, "Open browser", "Cancel"], cancelButtonIndex: 2 },
          (index) => {
            if (index === 0) toggle();
            else if (index === 1) router.push(`/agent/${encodeURIComponent(bot.instance)}`);
          },
        );
      } else {
        Alert.alert(title, undefined, [
          { text: pinLabel, onPress: toggle },
          {
            text: "Open browser",
            onPress: () => router.push(`/agent/${encodeURIComponent(bot.instance)}`),
          },
          { text: "Cancel", style: "cancel" },
        ]);
      }
    },
    [client],
  );

  const read = useCallback(() => {
    if (!client) return Promise.resolve();
    haptic.light();
    return Promise.all([client.roster.refresh(), client.inbox.refresh()]);
  }, [client]);
  const { refreshing, onRefresh } = usePullRefresh(client ? read : null);

  const live = socketState === "open";
  const banded = BANDED_SOCKET_STATES.has(socketState);
  const loading = !state?.readAt && (state?.loading ?? true) && !state?.error;

  return (
    <Screen>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          paddingHorizontal: t.space.lg,
          paddingTop: t.space.md,
          paddingBottom: t.space.md,
          // The list scrolls up to this rule, not under the title.
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: t.c.line2,
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
            <StatusSquare size={8} color={live ? t.c.ok : t.c.warn} pulse={!live} />
            <Kicker numberOfLines={1}>
              {`${credentials?.fleet.alias ?? credentials?.fleet.fleet_id ?? ""}${live ? "" : (KICKER_STATE[socketState] ?? " · connecting")}`}
            </Kicker>
          </View>
          <Text variant="display">Bots</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Listening: choose instances"
          // 36pt drawn, 44pt to the thumb.
          hitSlop={{ top: 4, bottom: 4 }}
          onPress={() => {
            haptic.select();
            router.push("/listening");
          }}
          style={({ pressed }) => ({
            borderWidth: t.border.control,
            borderColor: t.c.fg,
            paddingHorizontal: t.space.md,
            height: 36,
            justifyContent: "center",
            backgroundColor: pressed ? t.c.sel : "transparent",
          })}
        >
          <Text variant="caption" weight={800} uppercase style={{ letterSpacing: 1 }}>
            {`Listening · ${state?.listening.length ?? 0}`}
          </Text>
        </Pressable>
      </View>
      {/* Only the states that last: "connecting" flickers by on every resume. */}
      {banded ? (
        <SocketBand
          state={socketState}
          onRetry={reconnect}
          servedFleet={servedFleet}
          pairedFleet={credentials?.fleet ?? null}
          onRePair={() => void rePair()}
        />
      ) : null}
      <BotsList
        rows={rows}
        loading={loading}
        error={state?.readAt ? null : (state?.error ?? null)}
        banded={banded}
        query={state?.query ?? ""}
        filter={state?.filter ?? "all"}
        needs={layout?.needsYou ?? 0}
        listening={state?.listening.length ?? 0}
        fleetId={credentials?.fleet.fleet_id ?? ""}
        now={now}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onQuery={(q) => client?.roster.setQuery(q)}
        onFilter={(f) => client?.roster.setFilter(f)}
        onOpen={onOpen}
        onMenu={onMenu}
        onToggle={(instance) => client?.roster.toggleFolded(instance)}
        onPickInstances={() => router.push("/listening")}
      />
    </Screen>
  );
}
