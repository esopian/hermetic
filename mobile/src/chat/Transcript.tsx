/**
 * The transcript list: day dividers and turn rows in a FlashList that starts
 * at the bottom and stays there while new content arrives and rows grow
 * (unless the reader scrolled up — `follow.ts`, the desktop's rule), a "jump
 * to latest" pill when they have, and the keyboard lifting the content with
 * the composer (`KeyboardChatScrollView`).
 */
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import type React from "react";
import {
  forwardRef,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type LayoutChangeEvent,
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
import { AT_BOTTOM_SLACK, endOffset, fromBottom, nextFollowing } from "./follow.ts";
import { TurnRow } from "./TurnRow.tsx";

export type TranscriptItem =
  | { kind: "divider"; key: string; label: string }
  | {
      kind: "turn";
      key: string;
      row: TurnRowType;
      streaming: boolean;
      mine: boolean;
      /** Mine, and an agent turn follows it: no longer "sending…". */
      answered: boolean;
    };

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
      answered: false,
    });
  }
  let replied = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "turn") continue;
    if (item.mine) item.answered = replied;
    else if (item.row.message.role === "bot") replied = true;
  }
  return items;
}

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

function TranscriptImpl({
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
  pinSignal = 0,
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
  /** Bumped on each own send: the reader asked to be at the live end. */
  pinSignal?: number;
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

  // Following state lives in a ref: it changes on every scroll event, and only
  // its edge (following ↔ not) is drawn, as the pill.
  const pin = useRef<{ following: boolean; pinnedY: number | null }>({
    following: true,
    pinnedY: null,
  });
  const size = useRef({ content: 0, viewport: 0 });

  const setFollowing = useCallback((following: boolean) => {
    pin.current.following = following;
    if (!following) pin.current.pinnedY = null;
    setAway(!following);
    if (following) setUnseen(false);
  }, []);

  const touch = useRef({ dragging: false, momentum: false });

  // An explicit offset from the measured content, not `scrollToEnd`: inside
  // `onContentSizeChange` FlashList's own layout has not caught up with the
  // new height yet, so its idea of "the end" is the old one.
  const pinToEnd = useCallback((animated: boolean) => {
    const y = endOffset(size.current.content, size.current.viewport);
    list.current?.scrollToOffset({ offset: y, animated });
    pin.current.pinnedY = y;
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const gap = fromBottom({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
      const next = nextFollowing({
        following: pin.current.following,
        atBottom: gap <= AT_BOTTOM_SLACK,
        offsetY: contentOffset.y,
        pinnedY: pin.current.pinnedY,
      });
      // Only the reader's own drag or fling ends following: a programmatic
      // pin, a layout pass or the list opening at the bottom raise scroll
      // events too, at offsets the content has already outgrown.
      const reader = touch.current.dragging || touch.current.momentum;
      if (next !== pin.current.following && (next || reader)) setFollowing(next);
    },
    [setFollowing],
  );

  // A streaming reply grows its row without adding one; re-pin on every growth
  // while following, without animation, so the text runs on like a terminal
  // instead of lagging and catching up in jumps.
  const onContentSizeChange = useCallback(
    (_w: number, h: number) => {
      size.current.content = h;
      if (pin.current.following) pinToEnd(false);
    },
    [pinToEnd],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    size.current.viewport = e.nativeEvent.layout.height;
  }, []);

  useEffect(() => {
    if (pinSignal === 0) return;
    setFollowing(true);
    pinToEnd(true);
  }, [pinSignal, setFollowing, pinToEnd]);

  const jump = useCallback(() => {
    haptic.light();
    setFollowing(true);
    pinToEnd(true);
  }, [setFollowing, pinToEnd]);

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
          answered={item.answered}
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
        // Following the end is ours (`onContentSizeChange`); FlashList only
        // opens the list at the bottom and keeps older rows steady above.
        maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        onScrollBeginDrag={() => {
          touch.current.dragging = true;
        }}
        onScrollEndDrag={() => {
          touch.current.dragging = false;
        }}
        onMomentumScrollBegin={() => {
          touch.current.momentum = true;
        }}
        onMomentumScrollEnd={() => {
          touch.current.momentum = false;
        }}
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
            // About 32pt drawn; the slop makes it a 44pt target.
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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

export const Transcript = memo(TranscriptImpl);
