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
import type { ChatMessage } from "@hermetic/core/chat-client";
import { useTheme } from "../theme/theme.tsx";
import type { AvatarStatus } from "../ui/avatar/avatar-seed.ts";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";
import { PinController } from "./follow.ts";
import { TurnRow } from "./TurnRow.tsx";

export type TranscriptItem =
  | { kind: "divider"; key: string; label: string }
  | {
      kind: "turn";
      key: string;
      row: TurnRowType;
      /** The source messages the row was built from, for reusing it unchanged. */
      sources: readonly ChatMessage[];
      streaming: boolean;
      mine: boolean;
      /** Mine, and an agent turn directly follows its run: no longer "sending…". */
      answered: boolean;
      /** The turn this phone follows, not running on its box unfollowed: its requests can be answered. */
      answerable: boolean;
    };

const sameList = <T,>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether `next` draws exactly what `prev` drew, so `prev` (and its row) can stand. */
function sameItem(prev: TranscriptItem | undefined, next: TranscriptItem): boolean {
  if (!prev || prev.kind !== next.kind || prev.key !== next.key) return false;
  if (prev.kind === "divider" || next.kind === "divider")
    return prev.kind === "divider" && next.kind === "divider" && prev.label === next.label;
  return (
    prev.streaming === next.streaming &&
    prev.answerable === next.answerable &&
    prev.mine === next.mine &&
    prev.answered === next.answered &&
    prev.row.continuation === next.row.continuation &&
    prev.row.divider === next.row.divider &&
    sameList(prev.sources, next.sources)
  );
}

/**
 * Rows → list items: a divider before each row that opens a day.
 *
 * `previous` is the last call's answer. `turnRows` builds every row afresh, so
 * without it each streamed delta handed every visible row a new object and the
 * memoised `TurnRow` redrew them all; an item whose source messages (by
 * identity) and placement are unchanged is handed back as the same object.
 *
 * `remote`: the turn runs on its box unfollowed (`ConversationView.remote`),
 * so the streaming row's requests cannot be answered from here.
 */
export function transcriptItems(
  messages: readonly ChatMessage[],
  live: ChatMessage | null,
  sending: boolean,
  now: number,
  previous: readonly TranscriptItem[] = [],
  remote = false,
): TranscriptItem[] {
  const all = live && !messages.some((m) => m.id === live.id) ? [...messages, live] : messages;
  const byId = new Map(all.map((m) => [m.id, m]));
  const rows = turnRows(all, now, { breakBefore: live?.id ?? null });
  const items: TranscriptItem[] = [];
  for (const row of rows) {
    const key = row.ids[0] ?? row.message.id;
    if (row.divider) items.push({ kind: "divider", key: `d:${key}`, label: row.divider });
    const streaming = sending && !!live && row.ids.includes(live.id);
    items.push({
      kind: "turn",
      key,
      row,
      sources: row.ids.flatMap((id) => {
        const m = byId.get(id);
        return m ? [m] : [];
      }),
      streaming,
      answerable: streaming && !remote,
      mine: row.message.role === "user" && !row.message.from_bot,
      answered: false,
    });
  }
  // An own run is answered by an agent turn directly after it: anything else
  // in between (a system row, another bot's message) means this one has not
  // been taken up yet.
  let replied = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "turn") continue;
    if (item.mine) item.answered = replied;
    else replied = item.row.message.role === "bot";
  }
  const before = new Map(previous.map((item) => [item.key, item]));
  return items.map((item) => {
    const prev = before.get(item.key);
    return prev && sameItem(prev, item) ? prev : item;
  });
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

  // Following state lives in a controller (`PinController`, `follow.ts`): it
  // changes on every scroll event, and only its edge (following ↔ not) is
  // drawn, as the pill. Its size includes the scroll view's bottom content
  // inset: the keyboard's height while it is up (`KeyboardChatScrollView` adds
  // it on iOS), so the live end sits above the keyboard rather than under it.
  // Pins use an explicit offset from the measured content, not `scrollToEnd`:
  // inside `onContentSizeChange` FlashList's own layout has not caught up with
  // the new height yet, so its idea of "the end" is the old one.
  const [pin] = useState(
    () =>
      new PinController({
        scrollTo: (offset, animated) => list.current?.scrollToOffset({ offset, animated }),
        onFollowing: (following) => {
          setAway(!following);
          if (following) setUnseen(false);
        },
      }),
  );
  useEffect(() => () => pin.dispose(), [pin]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement, contentInset } = e.nativeEvent;
      pin.onScroll({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
        ...(contentInset ? { insetBottom: contentInset.bottom } : {}),
      });
    },
    [pin],
  );

  // A streaming reply grows its row without adding one; re-pin on every growth
  // while following, without animation, so the text runs on like a terminal
  // instead of lagging and catching up in jumps. Not under the reader's finger
  // or fling: the drag decides (`onScroll`), and a growth it skipped is caught
  // up when the touch ends still following.
  const onContentSizeChange = useCallback((_w: number, h: number) => pin.onContentSize(h), [pin]);

  // The keyboard moving changes the inset, and with it where the end is. It
  // reports every animation frame; the controller re-pins once it settles,
  // leaving the frames in between to the native `whenAtEnd` lift.
  const scrollOverrides = useMemo(
    () => ({ onContentInsetChange: (insets: { bottom: number }) => pin.onInset(insets.bottom) }),
    [pin],
  );

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => pin.onViewport(e.nativeEvent.layout.height),
    [pin],
  );

  useEffect(() => {
    if (pinSignal === 0) return;
    pin.setFollowing(true);
    pin.pinToEnd(true);
  }, [pinSignal, pin]);

  const jump = useCallback(() => {
    haptic.light();
    pin.setFollowing(true);
    pin.pinToEnd(true);
  }, [pin]);

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
          answerable={item.answerable}
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
        onScrollBeginDrag={() => pin.dragBegin()}
        // A release with no fling ends the touch here; a fling ends it at momentum end.
        onScrollEndDrag={(e) => pin.dragEnd(e.nativeEvent.velocity?.y)}
        onMomentumScrollBegin={() => pin.momentumBegin()}
        onMomentumScrollEnd={() => pin.momentumEnd()}
        // Reaches `ChatScroll` (FlashList passes these to its scroll component).
        overrideProps={scrollOverrides}
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
