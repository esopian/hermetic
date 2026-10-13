/**
 * One inbox card: a run of rows about one conversation folded into one
 * (`groupNotifications`), unread if any member is (`isUnreadRow`, the rule
 * the header's count uses). Class colour on the left seam (grey once the
 * condition has cleared), an unread marker, needs-you in gold, the count of
 * what it folded, and the time. Swipe left to mark it read.
 */
import { memo, useRef } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { railTime } from "../client/chat-logic.ts";
import { groupRow, groupUnread, type NotificationGroup } from "../client/inbox-logic.ts";
import type { Notification } from "../protocol/types.ts";
import { useTheme } from "../theme/theme.tsx";
import { classColor } from "../theme/tokens.ts";
import { codeSpans } from "../ui/codeSpans.tsx";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";

function InboxRowImpl({
  group,
  now,
  onOpen,
  onAck,
}: {
  group: NotificationGroup<Notification>;
  now: number;
  onOpen(group: NotificationGroup<Notification>): void;
  onAck(group: NotificationGroup<Notification>): void;
}) {
  const t = useTheme();
  const swipe = useRef<SwipeableMethods>(null);
  const row = groupRow(group);
  // The marker and the header count read one rule (`isUnreadRow`); the class
  // colour is the left seam's job and says nothing about read state.
  const unread = groupUnread(group);
  const resolved = !!row.resolved_at;
  const needs = row.class === "needs_action" && !resolved;
  // A resolved row loses emphasis rather than gaining a colour (desktop
  // `NotificationRow`: tone `--line2` once the condition has cleared).
  const edge = resolved ? t.c.line2 : classColor(t.c, row.class);
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
        accessibilityLabel={`${needs ? "Needs you: " : unread ? "Unread: " : ""}${row.title}`}
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
              style={{ width: 8, height: 8, backgroundColor: needs ? t.c.warn : t.c.acc }}
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
              {row.title}
            </Text>
            <Text mono variant="caption" tone="fg3">
              {railTime(row.at, now)}
            </Text>
          </View>
          {row.detail ? (
            <Text variant="bodySmall" tone="fg2" numberOfLines={2}>
              {codeSpans(row.detail)}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            {needs ? (
              <Text mono variant="caption" weight={700} tone="warn">
                NEEDS YOU
              </Text>
            ) : null}
            {resolved ? (
              <Text mono variant="caption" tone="fg3">
                cleared
              </Text>
            ) : null}
            {group.count > 1 ? (
              <Text mono variant="caption" tone="fg3">{`${group.count} messages`}</Text>
            ) : null}
            {row.agent ? (
              <Text mono variant="caption" tone="fg3">
                {row.agent}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

export const InboxRow = memo(InboxRowImpl);
