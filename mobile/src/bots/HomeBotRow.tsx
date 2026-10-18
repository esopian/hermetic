/**
 * One bot on the home list (and in search results): its avatar, the
 * name (with a quiet suffix only when it is needed to tell two bots apart),
 * the time of the last message on the right, and a one-line preview under it.
 * The operator's own last word carries the outgoing glyph instead of a "You:"
 * prefix. At the row's right edge: a warn `!` badge when the bot needs you, an
 * accent square when it has unread messages, and a small red square when its
 * last turn failed. With no preview the name sits centred and the marks move up
 * beside the time. Rows within a section are parted by a 1px `line` rule.
 */
import type { Bot } from "@hermetic/core/chat-client";
import type { AvatarStyle } from "@hermetic/core/shared";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { homePreview, homeTime } from "../client/home-rows.ts";
import { usePrefs } from "../prefs/prefs.tsx";
import { useTheme } from "../theme/theme.tsx";
import { Avatar } from "../ui/avatar/Avatar.tsx";
import { Icon } from "../ui/IconButton.tsx";
import { Text } from "../ui/Text.tsx";

export interface HomeBotRowProps {
  bot: Bot;
  fleetId: string;
  now: number;
  /** `!` needs you (warn badge), a numeric string when unread (accent square), null for nothing. */
  badge: string | null;
  /** Said quietly after the name when the list needs it to tell bots apart. */
  suffix: string | null;
  reachable: boolean;
  failed?: boolean;
  /** The home section band supplies the edge after this row. */
  lastInSection?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}

export const HOME_ROW_HEIGHT = 84;
/** The row avatar's visible blob, in points. */
export const ROW_AVATAR = 56;

/**
 * How much of its box the blob fills: its points sit at 0.78–0.88 of the box's
 * half-width (`blobShape` in `@hermetic/core/shared`), so a box this much
 * larger than the wanted blob draws a blob of about that size.
 */
const BLOB_FILL = 0.8;
/**
 * How much of the frame a sigil or pixel face takes. They fill their own box
 * edge to edge, so drawn at the frame's size a corner badge would sit on a cell
 * and leave a sliver of it outside the badge's ring. Inset by about 8% per
 * side, the face leaves the frame's corners free for the badges.
 */
const FRAMED_FILL = 0.84;

/** The drawing box for an avatar seen in a `visible`-point frame. Pure, so it is testable. */
export function fittedBox(style: AvatarStyle, visible: number): number {
  return style === "blob" ? Math.round(visible / BLOB_FILL) : Math.round(visible * FRAMED_FILL);
}

/**
 * An avatar in a `visible`-sized square frame. A blob's larger drawing box
 * overflows the frame evenly, so its visible blob is the frame's size; a sigil
 * or pixel face is drawn inset, centred. Either way badges placed on the frame
 * by `badgeAt` clear the drawing.
 */
export function FittedAvatar({
  bot,
  fleetId,
  visible,
  reachable,
}: {
  bot: Bot;
  fleetId: string;
  visible: number;
  reachable: boolean;
}) {
  const { prefs } = usePrefs();
  const box = fittedBox(prefs.avatarStyle, visible);
  const offset = (visible - box) / 2;
  return (
    <View style={{ width: visible, height: visible }}>
      <View style={{ position: "absolute", left: offset, top: offset }}>
        {/* `stopped` is the avatar's own dim look for a box that is not answering. */}
        <Avatar
          fleet_id={fleetId}
          instance={bot.instance}
          bot={bot.name}
          size={box}
          status={reachable ? "ready" : "stopped"}
          activity={bot.muted ? "muted" : "idle"}
        />
      </View>
    </View>
  );
}

/**
 * Where a badge of `size` sits so its centre lands on a circle of diameter
 * `visible` at 45° (upper or lower right): the blob's edge, not the box's corner.
 */
export function edgeBadge(
  visible: number,
  size: number,
  corner: "top" | "bottom",
): { left: number; top: number } {
  const r = visible / 2;
  const d = r * Math.SQRT1_2;
  return {
    left: r + d - size / 2,
    top: (corner === "top" ? r - d : r + d) - size / 2,
  };
}

/**
 * Where a badge of `size` sits on a `visible`-point avatar frame drawn in
 * `style`: on a blob's edge at 45°, or flush with the frame's corner for the
 * inset square faces, so its ring covers the face's corner with no sliver past it.
 */
export function badgeAt(
  style: AvatarStyle,
  visible: number,
  size: number,
  corner: "top" | "bottom",
): { left: number; top: number } {
  if (style === "blob") return edgeBadge(visible, size, corner);
  return { left: visible - size, top: corner === "top" ? 0 : visible - size };
}

/** The warn `!` badge, square: the bot is waiting on the operator. */
export function NeedsPill({ size = 20 }: { size?: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        minWidth: size,
        height: size,
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
  const parts = [`${input.bot.title || input.bot.name}${input.suffix ? ` (${input.suffix})` : ""}`];
  if (input.badge === "!") parts.push("needs you");
  else if (input.badge) parts.push(`${input.badge} unread`);
  if (input.failed) parts.push("last turn failed");
  if (!input.reachable) parts.push("box not answering");
  return parts.join(", ");
}

/** The row's marks, right to left: needs-you badge or unread square, then the failed mark. */
function Marks({ needs, unread, failed }: { needs: boolean; unread: boolean; failed: boolean }) {
  const t = useTheme();
  if (!needs && !unread && !failed) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
      {failed ? (
        <View testID="row-failed" style={{ width: 8, height: 8, backgroundColor: t.c.bad }} />
      ) : null}
      {needs ? (
        <View testID="row-needs">
          <NeedsPill />
        </View>
      ) : unread ? (
        <View testID="row-unread" style={{ width: 10, height: 10, backgroundColor: t.c.acc }} />
      ) : null}
    </View>
  );
}

function HomeBotRowImpl({
  bot,
  fleetId,
  now,
  badge,
  suffix,
  reachable,
  failed = false,
  lastInSection = false,
  onPress,
  onLongPress,
}: HomeBotRowProps) {
  const t = useTheme();
  const needs = badge === "!";
  const unread = badge !== null && !needs;
  const preview = homePreview(bot);
  const time = homeTime(bot.last_message_at, now);
  const hot = unread || needs;
  const marks = <Marks needs={needs} unread={unread} failed={failed} />;
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
        borderBottomWidth: lastInSection ? 0 : t.border.row,
        borderBottomColor: t.c.line,
        opacity: reachable ? 1 : 0.6,
        backgroundColor: pressed ? t.c.sel : "transparent",
      })}
    >
      <FittedAvatar bot={bot} fleetId={fleetId} visible={ROW_AVATAR} reachable={reachable} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
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
            <Text mono variant="caption" tone={hot ? "fg2" : "fg3"}>
              {time}
            </Text>
          ) : null}
          {preview.text ? null : marks}
        </View>
        {preview.text ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
            {preview.sent ? <Icon name="sent" size={15} color={t.c.fg3} /> : null}
            <Text tone={hot ? "fg2" : "fg3"} numberOfLines={1} style={{ flex: 1 }}>
              {preview.text}
            </Text>
            {marks}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export const HomeBotRow = memo(HomeBotRowImpl);
