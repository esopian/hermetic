/**
 * One inbox card: a run of entries about one conversation and kind folded
 * into one (`groupEntries`), unread if any member is, and needing you when any
 * member is a needs-you event (`groupCondition`). Kind colour on the left seam
 * (gold for needs-you, red for a failed turn, grey once read), an unread
 * marker (gold only when an unread member needs you, the header's need rule),
 * the count of what it folded, the agent, and the time. Swipe left to mark it
 * read.
 */
import { memo, useRef } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { railTime } from "../client/chat-logic.ts";
import {
  groupCondition,
  groupRow,
  groupUnread,
  type NotificationGroup,
} from "../client/inbox-logic.ts";
import { useTheme } from "../theme/theme.tsx";
import { classColor } from "../theme/tokens.ts";
import { codeSpans } from "../ui/codeSpans.tsx";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";
import type { InboxEntry } from "./store.ts";

/** The seam colour's class for an entry kind. */
const KIND_CLASS: Record<InboxEntry["kind"], string> = {
  needs_action: "needs_action",
  "turn.error": "bad",
  "turn.done": "ok",
  message: "info",
};

function InboxRowImpl({
  group,
  label,
  now,
  onOpen,
  onAck,
}: {
  group: NotificationGroup<InboxEntry>;
  /**
   * The bot's display title from the roster, when the phone has it. The entry's
   * own title is `<bot name> · <instance>` (a push names the bot by its slug),
   * and the instance is already on the card's last line.
   */
  label?: string | null;
  now: number;
  onOpen(group: NotificationGroup<InboxEntry>): void;
  onAck(group: NotificationGroup<InboxEntry>): void;
}) {
  const t = useTheme();
  const swipe = useRef<SwipeableMethods>(null);
  const row = groupRow(group);
  const title = label || row.title;
  // The marker and the header count read one rule (`isUnreadRow`); the class
  // colour is the left seam's job and says nothing about read state.
  const unread = groupUnread(group);
  // `needs` stays on for a read needs-you member; the marker's gold follows
  // `needsUnread`, the header's need count, instead.
  const { needs, needsUnread } = groupCondition(group);
  // A read card loses emphasis rather than keeping its colour.
  const edge = unread ? classColor(t.c, needs ? "needs_action" : KIND_CLASS[row.kind]) : t.c.line2;
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={2}
      rightThreshold={56}
      overshootRight={false}
      enabled={unread}
      onSwipeableWillOpen={() => haptic.light()}
      onSwipeableOpen={() => {
        onAck(group);
        swipe.current?.close();
      }}
      renderRightActions={() => (
        <View
          style={{
            width: 112,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: t.c.ok,
          }}
        >
          <Text variant="caption" weight={800} uppercase style={{ color: t.c.bg, letterSpacing: 1 }}>
            Mark read
          </Text>
        </View>
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${needs ? "Needs you: " : unread ? "Unread: " : ""}${title}`}
        accessibilityHint={unread ? "Swipe left to mark read" : undefined}
        onPress={() => onOpen(group)}
        style={({ pressed }) => ({
          flexDirection: "row",
          gap: t.space.md,
          paddingVertical: t.space.md,
          paddingRight: t.space.lg,
          paddingLeft: t.space.lg - t.border.seam,
          borderLeftWidth: t.border.seam,
          borderLeftColor: edge,
          backgroundColor: pressed ? t.c.sel : t.c.bg,
          borderBottomWidth: 1,
          borderBottomColor: t.c.line,
        })}
      >
        <View style={{ width: 8, paddingTop: 7 }}>
          {unread ? (
            <View
              accessibilityLabel="unread"
              style={{ width: 8, height: 8, backgroundColor: needsUnread ? t.c.warn : t.c.acc }}
            />
          ) : null}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: t.space.sm }}>
            <Text
              weight={unread ? 800 : 500}
              numberOfLines={1}
              style={{ flex: 1 }}
              tone={unread ? "fg" : "fg2"}
            >
              {title}
            </Text>
            <Text mono variant="caption" tone="fg3">
              {railTime(row.at, now)}
            </Text>
          </View>
          {row.body ? (
            <Text variant="bodySmall" tone="fg2" numberOfLines={2}>
              {codeSpans(row.body)}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            {needs ? (
              <Text mono variant="caption" weight={700} tone="warn">
                NEEDS YOU
              </Text>
            ) : null}
            {row.kind === "turn.error" ? (
              <Text mono variant="caption" weight={700} tone="bad">
                FAILED
              </Text>
            ) : null}
            {group.count > 1 ? (
              <Text mono variant="caption" tone="fg3">{`${group.count} events`}</Text>
            ) : null}
            <Text mono variant="caption" tone="fg3">
              {row.instance}
            </Text>
          </View>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

export const InboxRow = memo(InboxRowImpl);
