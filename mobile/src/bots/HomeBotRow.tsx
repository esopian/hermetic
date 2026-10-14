/**
 * One bot on the home list (and in search results): a round blob avatar, the
 * name with a quiet `· instance` suffix when one is needed, the time of the
 * last message on the right, and a one-line preview under it. The operator's
 * own last word carries the outgoing glyph instead of a "You:" prefix. At the
 * row's right edge: a gold `!` pill when the bot needs you, an accent dot when
 * it has unread messages, and a small red mark when its last turn failed.
 * No borders and no separators: whitespace does the separating.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { homePreview, homeTime } from "../client/home-rows.ts";
import { useTheme } from "../theme/theme.tsx";
import { Avatar } from "../ui/avatar/Avatar.tsx";
import { Icon } from "../ui/IconButton.tsx";
import { Text } from "../ui/Text.tsx";

export interface HomeBotRowProps {
  bot: Bot;
  fleetId: string;
  now: number;
  /** `!` needs you (gold pill), a numeric string when unread (accent dot), null for nothing. */
  badge: string | null;
  /** The instance, said after the name when the list needs it to tell bots apart. */
  suffix: string | null;
  reachable: boolean;
  failed?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}

export const HOME_ROW_HEIGHT = 84;
const AVATAR = 56;

/** The gold `!` pill: the bot is waiting on the operator. */
export function NeedsPill({ size = 20 }: { size?: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        minWidth: size,
        height: size,
        borderRadius: size / 2,
        paddingHorizontal: 5,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: t.c.warn,
      }}
    >
      <Text weight={800} style={{ color: t.c.bg, fontSize: size * 0.6, lineHeight: size * 0.8 }}>
        !
      </Text>
    </View>
  );
}

/** What the row says to VoiceOver, state first-class rather than drawn-only. */
export function homeRowLabel(input: {
  bot: Pick<Bot, "title" | "name">;
  suffix: string | null;
  badge: string | null;
  failed?: boolean;
  reachable: boolean;
}): string {
  const parts = [`${input.bot.title || input.bot.name}${input.suffix ? ` on ${input.suffix}` : ""}`];
  if (input.badge === "!") parts.push("needs you");
  else if (input.badge) parts.push(`${input.badge} unread`);
  if (input.failed) parts.push("last turn failed");
  if (!input.reachable) parts.push("box not answering");
  return parts.join(", ");
}

function HomeBotRowImpl({
  bot,
  fleetId,
  now,
  badge,
  suffix,
  reachable,
  failed = false,
  onPress,
  onLongPress,
}: HomeBotRowProps) {
  const t = useTheme();
  const needs = badge === "!";
  const unread = badge !== null && !needs;
  const preview = homePreview(bot);
  const time = homeTime(bot.last_message_at, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={homeRowLabel({ bot, suffix, badge, failed, reachable })}
      accessibilityHint={onLongPress ? "Long-press for more" : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.lg,
        paddingHorizontal: t.space.lg + t.space.xs,
        minHeight: HOME_ROW_HEIGHT,
        backgroundColor: pressed ? t.c.sel : "transparent",
      })}
    >
      {/* `stopped` is the avatar's own dim look for a box that is not answering. */}
      <Avatar
        fleet_id={fleetId}
        instance={bot.instance}
        bot={bot.name}
        size={AVATAR}
        status={reachable ? "ready" : "stopped"}
        activity={bot.muted ? "muted" : "idle"}
        label={bot.title || bot.name}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: t.space.sm }}>
          <Text weight={600} numberOfLines={1} style={{ flexShrink: 1, fontSize: 17, lineHeight: 22 }}>
            {bot.title || bot.name}
            {suffix ? (
              <Text tone="fg3" style={{ fontSize: 15 }}>
                {` · ${suffix}`}
              </Text>
            ) : null}
          </Text>
          <View style={{ flex: 1 }} />
          {time ? (
            <Text variant="bodySmall" tone={unread || needs ? "fg2" : "fg3"}>
              {time}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          {preview.sent ? <Icon name="sent" size={15} color={t.c.fg3} /> : null}
          <Text tone={unread || needs ? "fg2" : "fg3"} numberOfLines={1} style={{ flex: 1 }}>
            {preview.text}
          </Text>
          {failed ? (
            <View
              testID="row-failed"
              style={{ width: 8, height: 8, borderRadius: 1, backgroundColor: t.c.bad }}
            />
          ) : null}
          {needs ? (
            <View testID="row-needs">
              <NeedsPill />
            </View>
          ) : unread ? (
            <View
              testID="row-unread"
              style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.c.acc }}
            />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export const HomeBotRow = memo(HomeBotRowImpl);
