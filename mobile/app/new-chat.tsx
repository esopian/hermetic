/**
 * New chat (the home bar's `+`, a form sheet): every listened bot; a tap
 * starts a separate session with it (`/chat/<instance>/<bot>?fresh=1`, which
 * the conversation opens with `new_session`), leaving its Bot Chat as it was.
 * The last row opens the instance picker. Listening to nothing, the sheet
 * says so and offers only that.
 */
import { router } from "expo-router";
import { useMemo } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { freshChatPath, newChatBots } from "../src/chat/new-chat.ts";
import { useFleetState, useRoster } from "../src/fleet/hooks.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Avatar, Icon, Text } from "../src/ui/index.ts";

/** Close the sheet, then go: pushed from inside it, a screen lands in the sheet's context. */
function leaveTo(href: string) {
  router.back();
  router.push(href as never);
}

const ROW_HEIGHT = 60;
const ADD = "add-instance";

export default function NewChat() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const fleet = useFleetState();
  const { state } = useRoster();
  const fleetId = fleet.link?.payload.fleet_id ?? "";
  const listening = state?.listening ?? [];
  const bots = useMemo(
    () => newChatBots(state?.swarms ?? [], state?.listening ?? []),
    [state?.swarms, state?.listening],
  );
  const many = new Set(bots.map((b) => b.instance)).size > 1;
  const none = listening.length === 0;

  const addRow = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add instance"
      accessibilityHint="Choose which instances this phone listens to"
      onPress={() => {
        haptic.select();
        leaveTo("/listening");
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.lg,
        minHeight: ROW_HEIGHT,
        paddingHorizontal: t.space.lg + t.space.xs,
        backgroundColor: pressed ? t.c.sel : "transparent",
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: t.c.line2,
        }}
      >
        <Icon name="plus" size={18} color={t.c.fg2} />
      </View>
      <Text tone="fg2" style={{ fontSize: 17 }}>
        Add instance…
      </Text>
    </Pressable>
  );

  // The list is the sheet's root view (see `listening.tsx`): a form sheet
  // sizes its first scroll view, and a header laid out beside it overlaps.
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: t.c.bg }}
      data={
        none
          ? []
          : [...bots.map((b) => ({ key: `${b.instance}/${b.name}`, bot: b })), { key: ADD, bot: null }]
      }
      keyExtractor={(r) => r.key}
      contentContainerStyle={{ paddingBottom: insets.bottom + t.space.xl }}
      ListHeaderComponent={
        <View
          style={{
            paddingHorizontal: t.space.lg + t.space.xs,
            paddingTop: t.space.xl,
            paddingBottom: t.space.md,
            gap: 4,
          }}
        >
          <Text variant="heading" accessibilityRole="header">
            New chat
          </Text>
          {none ? null : (
            <Text variant="bodySmall" tone="fg3">
              A separate session. The Bot Chat stays as it is.
            </Text>
          )}
        </View>
      }
      ListEmptyComponent={
        <View style={{ gap: t.space.md }}>
          <Text
            tone="fg3"
            style={{ paddingHorizontal: t.space.lg + t.space.xs, paddingVertical: t.space.sm }}
          >
            This phone listens to no instance yet. Add one to chat with its bots.
          </Text>
          {addRow}
        </View>
      }
      renderItem={({ item }) => {
        const bot = item.bot;
        if (!bot) return addRow;
        const name = bot.title || bot.name;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`New chat with ${name}${many ? ` on ${bot.instance}` : ""}`}
            onPress={() => {
              haptic.select();
              leaveTo(freshChatPath(bot));
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: t.space.lg,
              minHeight: ROW_HEIGHT,
              paddingHorizontal: t.space.lg + t.space.xs,
              backgroundColor: pressed ? t.c.sel : "transparent",
            })}
          >
            <Avatar fleet_id={fleetId} instance={bot.instance} bot={bot.name} size={40} label={name} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 17 }}>
              <Text weight={600} style={{ fontSize: 17 }}>
                {name}
              </Text>
              {many ? <Text tone="fg3" style={{ fontSize: 15 }}>{` · ${bot.instance}`}</Text> : null}
            </Text>
          </Pressable>
        );
      }}
    />
  );
}
