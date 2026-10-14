/**
 * Home's hero: a row of big round avatars at the top. They are the bots pinned
 * on this phone (each with a small star on its lower-right edge), or, with
 * nothing pinned, the default bot of each listened instance (no star). Centred
 * when they fit, scrolling sideways when they do not. Each carries its name in
 * muted text underneath; a gold `!` on the upper-right edge when it needs you,
 * else an accent dot when it has unread messages; a small red mark beside the
 * name when its last turn failed; and a dimmed avatar when its box is not
 * answering. Tap opens its chat; long-press opens the bot menu.
 */
import { memo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { HomeRow } from "../client/home-rows.ts";
import { useTheme } from "../theme/theme.tsx";
import { Icon } from "../ui/IconButton.tsx";
import { Text } from "../ui/Text.tsx";
import { edgeBadge, FittedAvatar, homeRowLabel, NeedsPill } from "./HomeBotRow.tsx";

/** The visible blob of a lone hero, and of each when there are several (three fit across a 393 pt phone). */
export const HERO_SOLO = 112;
export const HERO_MANY = 88;

export const heroSize = (count: number): number => (count <= 1 ? HERO_SOLO : HERO_MANY);

function HeroBot({
  row,
  fleetId,
  size,
  starred,
  onPress,
  onLongPress,
}: {
  row: HomeRow;
  fleetId: string;
  size: number;
  starred: boolean;
  onPress: (row: HomeRow) => void;
  onLongPress: (row: HomeRow) => void;
}) {
  const t = useTheme();
  const { bot, badge, reachable, failed, suffix } = row;
  const needs = badge === "!";
  const unread = badge !== null && !needs;
  const star = Math.round(size * 0.26);
  const pill = Math.round(size * 0.24);
  const dot = Math.round(size * 0.17);
  const ring = 3;
  const name = bot.title || bot.name;
  return (
    <Pressable
      testID={`home-hero-${row.key}`}
      accessibilityRole="button"
      accessibilityLabel={`${starred ? "Pinned" : "Default"} bot: ${homeRowLabel({ bot, suffix, badge, failed, reachable })}`}
      accessibilityHint="Long-press for more"
      onPress={() => onPress(row)}
      onLongPress={() => onLongPress(row)}
      delayLongPress={350}
      style={({ pressed }) => ({
        alignItems: "center",
        gap: t.space.sm,
        width: size + t.space.xl,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ width: size, height: size }}>
        <FittedAvatar bot={bot} fleetId={fleetId} visible={size} reachable={reachable} />
        {starred ? (
          <View
            testID="hero-star"
            style={{
              position: "absolute",
              ...edgeBadge(size, star, "bottom"),
              width: star,
              height: star,
              borderRadius: star / 2,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: t.c.warn,
              borderWidth: ring,
              borderColor: t.c.bg,
            }}
          >
            <Icon name="star" size={star * 0.45} color={t.c.bg} />
          </View>
        ) : null}
        {needs ? (
          <View
            testID="hero-needs"
            style={{
              position: "absolute",
              ...edgeBadge(size, pill + ring * 2, "top"),
              borderRadius: pill,
              borderWidth: ring,
              borderColor: t.c.bg,
            }}
          >
            <NeedsPill size={pill} />
          </View>
        ) : unread ? (
          <View
            testID="hero-unread"
            style={{
              position: "absolute",
              ...edgeBadge(size, dot, "top"),
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: t.c.acc,
              borderWidth: ring,
              borderColor: t.c.bg,
            }}
          />
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs, maxWidth: "100%" }}>
        {failed ? (
          <View
            testID="hero-failed"
            style={{ width: 8, height: 8, borderRadius: 1, backgroundColor: t.c.bad }}
          />
        ) : null}
        <Text
          tone={reachable ? "fg2" : "fg3"}
          weight={500}
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: size >= HERO_SOLO ? 17 : 15, lineHeight: 20 }}
        >
          {name}
        </Text>
      </View>
    </Pressable>
  );
}

function HomeHeroImpl({
  rows,
  starred,
  fleetId,
  onPress,
  onLongPress,
}: {
  rows: readonly HomeRow[];
  /** The rows are the operator's pins (starred), not the instances' defaults. */
  starred: boolean;
  fleetId: string;
  onPress: (row: HomeRow) => void;
  onLongPress: (row: HomeRow) => void;
}) {
  const t = useTheme();
  if (rows.length === 0) return null;
  const size = heroSize(rows.length);
  return (
    <ScrollView
      testID="home-hero"
      horizontal
      showsHorizontalScrollIndicator={false}
      // Centred while they fit; once they overflow, the content is wider than the view and scrolls.
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: t.space.md,
        paddingTop: t.space.lg,
        paddingBottom: t.space.xl,
      }}
    >
      {rows.map((row) => (
        <HeroBot
          key={row.key}
          row={row}
          fleetId={fleetId}
          size={size}
          starred={starred}
          onPress={onPress}
          onLongPress={onLongPress}
        />
      ))}
    </ScrollView>
  );
}

export const HomeHero = memo(HomeHeroImpl);
