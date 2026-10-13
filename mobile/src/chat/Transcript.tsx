/**
 * The transcript list: day dividers and turn rows in a FlashList that starts
 * at the bottom and stays there while new content arrives (unless the reader
 * scrolled up), a "jump to latest" pill when they have, and the keyboard
 * lifting the content with the composer (`KeyboardChatScrollView`).
 */
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import type React from "react";
import {
  forwardRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  type ScrollView,
  type ScrollViewProps,
  View,
} from "react-native";
import { KeyboardChatScrollView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type TurnRow as TurnRowType, turnRows } from "../client/chat-turns.ts";
import type { TurnActivity } from "../client/turn-reducer.ts";
import type { ChatMessage } from "../protocol/types.ts";
import { useTheme } from "../theme/theme.tsx";
import type { AvatarStatus } from "../ui/avatar/avatar-seed.ts";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";
import { TurnRow } from "./TurnRow.tsx";

export type TranscriptItem =
  | { kind: "divider"; key: string; label: string }
  | { kind: "turn"; key: string; row: TurnRowType; streaming: boolean; mine: boolean };

/** Rows → list items: a divider before each row that opens a day. */
export function transcriptItems(
  messages: readonly ChatMessage[],
  live: ChatMessage | null,
  sending: boolean,
  now: number,
): TranscriptItem[] {
  const all = live && !messages.some((m) => m.id === live.id) ? [...messages, live] : messages;
  const rows = turnRows(all, now, { breakBefore: live?.id ?? null });
  const items: TranscriptItem[] = [];
  for (const row of rows) {
    const key = row.ids[0] ?? row.message.id;
    if (row.divider) items.push({ kind: "divider", key: `d:${key}`, label: row.divider });
    items.push({
      kind: "turn",
      key,
      row,
      streaming: sending && !!live && row.ids.includes(live.id),
      mine: row.message.role === "user" && !row.message.from_bot,
    });
  }
  return items;
}

const AWAY_PX = 320;

const ChatScroll = forwardRef<ScrollView, ScrollViewProps>(function ChatScroll(props, ref) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardChatScrollView
      // The chat scroll view is an Animated.ScrollView; FlashList only calls ScrollView methods on it.
      ref={ref as unknown as React.Ref<React.ComponentRef<typeof KeyboardChatScrollView>>}
      {...props}
      offset={insets.bottom}
      keyboardLiftBehavior="whenAtEnd"
    />
  );
});

export function Transcript({
  items,
  fleetId,
  instance,
  bot,
  botTitle,
  status,
  now,
  activity,
  released,
  header,
  empty,
  onRefresh,
  refreshing = false,
}: {
  items: TranscriptItem[];
  fleetId: string;
  instance: string;
  bot: string;
  botTitle: string | null;
  status: AvatarStatus;
  now: number;
  activity: TurnActivity;
  released: readonly string[];
  header?: ReactElement | null;
  empty?: ReactElement | null;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const t = useTheme();
  const list = useRef<FlashListRef<TranscriptItem>>(null);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const lastKey = items[items.length - 1]?.key ?? null;
  const seenKey = useRef(lastKey);

  useEffect(() => {
    if (!away) seenKey.current = lastKey;
    else if (lastKey !== seenKey.current) setUnseen(true);
  }, [lastKey, away]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const fromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const next = fromBottom > AWAY_PX;
    setAway((was) => {
      if (was && !next) setUnseen(false);
      return next;
    });
  }, []);

  const jump = useCallback(() => {
    haptic.light();
    list.current?.scrollToEnd({ animated: true });
    setUnseen(false);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: TranscriptItem }) =>
      item.kind === "divider" ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: t.space.sm,
            marginVertical: t.space.md,
          }}
        >
          <View style={{ flex: 1, height: 1, backgroundColor: t.c.line }} />
          <Text mono variant="caption" tone="fg3">
            {item.label}
          </Text>
          <View style={{ flex: 1, height: 1, backgroundColor: t.c.line }} />
        </View>
      ) : (
        <TurnRow
          row={item.row}
          fleetId={fleetId}
          instance={instance}
          bot={bot}
          botTitle={botTitle}
          status={status}
          now={now}
          streaming={item.streaming}
          activity={item.streaming ? activity : "idle"}
          released={released}
        />
      ),
    [t, fleetId, instance, bot, botTitle, status, now, activity, released],
  );

  const extra = useMemo(() => ({ now, activity, released, status }), [now, activity, released, status]);

  return (
    <View style={{ flex: 1 }}>
      <FlashList
        ref={list}
        data={items}
        extraData={extra}
        keyExtractor={(item) => item.key}
        getItemType={(item) => (item.kind === "divider" ? "divider" : item.mine ? "mine" : "turn")}
        renderItem={renderItem}
        renderScrollComponent={ChatScroll}
        maintainVisibleContentPosition={{
          startRenderingFromBottom: true,
          autoscrollToBottomThreshold: 0.15,
          animateAutoScrollToBottom: true,
        }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: t.space.lg,
          paddingTop: t.space.sm,
          paddingBottom: t.space.lg,
        }}
        ListHeaderComponent={header ?? null}
        ListEmptyComponent={empty ?? null}
        {...(onRefresh ? { onRefresh, refreshing } : {})}
      />
      {away ? (
        <Animated.View
          entering={FadeIn.duration(t.motion.fade)}
          exiting={FadeOut.duration(t.motion.fade)}
          style={{ position: "absolute", bottom: t.space.md, alignSelf: "center" }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to latest"
            onPress={jump}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: t.space.xs,
              paddingHorizontal: t.space.md,
              paddingVertical: t.space.sm,
              backgroundColor: pressed ? t.c.acc : unseen ? t.c.acc : t.c.fg,
              borderWidth: t.border.control,
              borderColor: unseen ? t.c.acc : t.c.fg,
            })}
          >
            <Text mono variant="caption" weight={700} style={{ color: unseen ? t.c.accFg : t.c.bg }}>
              {unseen ? "↓ NEW · LATEST" : "↓ LATEST"}
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}
