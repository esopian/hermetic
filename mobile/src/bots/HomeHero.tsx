/**
 * Home's hero: the operator's primary bot, large and centred, with a star
 * badge on its lower right and its name in muted text underneath. A gold `!`
 * on the avatar's upper right when it needs you, else an accent dot when it
 * has unread messages; a small red mark beside the name when its last turn
 * failed. When its box is not answering the avatar dims and a small status
 * line says why. Tap opens its chat; long-press opens the row menu.
 */
import type { Bot } from "@hermetic/core/chat-client";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "../theme/theme.tsx";
import { Avatar } from "../ui/avatar/Avatar.tsx";
import { Icon } from "../ui/IconButton.tsx";
import { Text } from "../ui/Text.tsx";
import { homeRowLabel, NeedsPill } from "./HomeBotRow.tsx";

export const HERO_AVATAR = 112;

function HomeHeroImpl({
  bot,
  fleetId,
  badge,
  suffix,
  reachable,
  failed = false,
  status,
  onPress,
  onLongPress,
}: {
  bot: Bot;
  fleetId: string;
  badge: string | null;
  suffix: string | null;
  reachable: boolean;
  failed?: boolean;
  /** What to say under the name when the box is not answering ("stopped", "not answering"). */
  status: string | null;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const t = useTheme();
  const needs = badge === "!";
  const unread = badge !== null && !needs;
  const star = HERO_AVATAR * 0.3;
  return (
    <View style={{ alignItems: "center", paddingTop: t.space.xl, paddingBottom: t.space.xl }}>
      <Pressable
        testID="home-hero"
        accessibilityRole="button"
        accessibilityLabel={`Primary bot: ${homeRowLabel({ bot, suffix, badge, failed, reachable })}`}
        accessibilityHint={onLongPress ? "Long-press for more" : undefined}
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({ pressed }) => ({
          alignItems: "center",
          gap: t.space.sm,
          paddingHorizontal: t.space.xl,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <View style={{ width: HERO_AVATAR, height: HERO_AVATAR }}>
          <Avatar
            fleet_id={fleetId}
            instance={bot.instance}
            bot={bot.name}
            size={HERO_AVATAR}
            status={reachable ? "ready" : "stopped"}
            activity={bot.muted ? "muted" : "idle"}
            label={bot.title || bot.name}
          />
          <View
            style={{
              position: "absolute",
              right: 2,
              bottom: 4,
              width: star,
              height: star,
              borderRadius: star / 2,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: t.c.warn,
              borderWidth: 3,
              borderColor: t.c.bg,
            }}
          >
            <Icon name="star" size={star * 0.5} color={t.c.bg} />
          </View>
          {needs ? (
            <View
              testID="hero-needs"
              style={{
                position: "absolute",
                right: 0,
                top: 2,
                borderRadius: 14,
                borderWidth: 3,
                borderColor: t.c.bg,
              }}
            >
              <NeedsPill size={24} />
            </View>
          ) : unread ? (
            <View
              testID="hero-unread"
              style={{
                position: "absolute",
                right: 6,
                top: 6,
                width: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: t.c.acc,
                borderWidth: 3,
                borderColor: t.c.bg,
              }}
            />
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs }}>
          {failed ? (
            <View
              testID="hero-failed"
              style={{ width: 8, height: 8, borderRadius: 1, backgroundColor: t.c.bad }}
            />
          ) : null}
          <Text tone="fg2" weight={500} numberOfLines={1} style={{ fontSize: 17, lineHeight: 22 }}>
            {bot.title || bot.name}
            {suffix ? <Text tone="fg3" style={{ fontSize: 15 }}>{` · ${suffix}`}</Text> : null}
          </Text>
        </View>
        {status ? (
          <Text variant="caption" tone="fg3" numberOfLines={1}>
            {status}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

export const HomeHero = memo(HomeHeroImpl);
