/**
 * One row of the Bots list: avatar with the instance's status square, title
 * (a pinned row names its instance first), the last message's preview, its
 * relative time, and the badge — `!` when the bot needs you, else the unread
 * count. Long-press opens the row's menu (pin / unpin).
 */
import { memo } from "react";
import { Pressable, View } from "react-native";
import { railTime } from "../client/chat-logic.ts";
import { previewLine } from "../client/roster-rows.ts";
import type { Bot } from "../protocol/types.ts";
import { useTheme } from "../theme/theme.tsx";
import { Avatar } from "../ui/avatar/Avatar.tsx";
import { Badge } from "../ui/Badge.tsx";
import { StatusSquare } from "../ui/StatusSquare.tsx";
import { Text } from "../ui/Text.tsx";

function BotRowImpl({
  bot,
  fleetId,
  pinned,
  badge,
  reachable,
  now,
  onPress,
  onLongPress,
}: {
  bot: Bot;
  fleetId: string;
  pinned: boolean;
  badge: string | null;
  reachable: boolean;
  now: number;
  onPress(bot: Bot): void;
  onLongPress(bot: Bot, pinned: boolean): void;
}) {
  const t = useTheme();
  const needs = badge === "!";
  const unread = !!badge;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.title || bot.name} on ${bot.instance}${needs ? ", needs you" : unread ? `, ${badge} unread` : ""}`}
      accessibilityHint="Long-press for pin options"
      onPress={() => onPress(bot)}
      onLongPress={() => onLongPress(bot, pinned)}
      delayLongPress={350}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        paddingLeft: t.space.lg,
        paddingRight: t.space.lg,
        minHeight: 68,
        backgroundColor: pressed ? t.c.sel : t.c.bg,
        borderBottomWidth: 1,
        borderBottomColor: t.c.line,
        borderLeftWidth: t.border.seam,
        borderLeftColor: needs ? t.c.warn : "transparent",
      })}
    >
      <View>
        <Avatar
          fleet_id={fleetId}
          instance={bot.instance}
          bot={bot.name}
          size={40}
          status={reachable ? "ready" : "error"}
          activity={bot.muted ? "muted" : "idle"}
          label={bot.title || bot.name}
        />
        <View
          style={{ position: "absolute", right: -2, bottom: -2, padding: 2, backgroundColor: t.c.bg }}
        >
          <StatusSquare size={8} status={reachable ? (bot.warm ? "ready" : "stopped") : "error"} />
        </View>
      </View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: t.space.sm }}>
          <Text weight={unread ? 800 : 600} numberOfLines={1} style={{ flexShrink: 1 }}>
            {pinned ? <Text mono variant="caption" tone="fg3">{`${bot.instance} / `}</Text> : null}
            {bot.title || bot.name}
          </Text>
          {bot.is_default ? (
            <Text mono variant="caption" tone="fg3">
              default
            </Text>
          ) : null}
          <View style={{ flex: 1 }} />
          <Text mono variant="caption" tone={unread ? "fg" : "fg3"}>
            {bot.last_message_at ? railTime(bot.last_message_at, now) : ""}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <Text variant="bodySmall" tone={unread ? "fg2" : "fg3"} numberOfLines={1} style={{ flex: 1 }}>
            {previewLine(bot)}
          </Text>
          <Badge label={badge} />
        </View>
      </View>
    </Pressable>
  );
}

export const BotRow = memo(BotRowImpl);
