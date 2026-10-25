/**
 * Board: the kanban cards of every listened instance in one list, the phone's
 * form of the desktop Work view's queue layout (the lane matrix stays on the
 * desktop). Lenses (needs you · open · all) and a filter over the groups the
 * desktop draws (`KANBAN_QUEUE_GROUPS`); tapping a card opens its sheet
 * (detail, comment, unblock), and "New task" files one. Each box is read
 * through its own dashboard (`readKanbanBoard`), again every 10 s while the
 * screen is in front. A box that stops answering keeps its last cards, marked
 * stale; one whose plugin is off says how to turn it on.
 */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { AppState, Pressable, RefreshControl, SectionList, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type BoardCard,
  type BoardLens,
  boardCards,
  boardSections,
  lensCounts,
} from "../src/client/board-list.ts";
import { type InstanceBoard, KANBAN_ENABLE_HINT, readKanbanBoard } from "../src/client/kanban.ts";
import { KanbanSheet, Status } from "../src/chat/blocks/KanbanCard.tsx";
import { chatTime } from "../src/chat/time.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetState } from "../src/fleet/hooks.ts";
import { NewTaskSheet } from "../src/kanban/NewTaskSheet.tsx";
import { useTheme } from "../src/theme/theme.tsx";
import { Chip } from "../src/ui/Chip.tsx";
import { IconButton, Kicker, Screen, Text } from "../src/ui/index.ts";
import { useNow } from "../src/ui/useNow.ts";

/** How often the board is read again while the screen is in front. */
export const BOARD_POLL_MS = 10_000;

const LENSES: [BoardLens, string][] = [
  ["you", "need you"],
  ["open", "open"],
  ["all", "all"],
];

export default function Board() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { client, fleet } = useFleetContext();
  const label = useFleetState().link?.label ?? "";
  const rest = client?.gateway.rest ?? null;
  const now = useNow(30_000);
  const [boards, setBoards] = useState<InstanceBoard[] | null>(null);
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [lens, setLens] = useState<BoardLens>("open");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ instance: string; id: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const last = useRef<InstanceBoard[] | null>(null);

  const load = useCallback(async () => {
    if (!rest) return;
    const read = await Promise.all(fleet.listened().map((i) => readKanbanBoard(rest, i)));
    // A box that did not answer keeps the cards it last listed, marked stale.
    const before = new Map((last.current ?? []).map((b) => [b.instance, b]));
    const next = read.map((b) =>
      b.state === "unreachable" ? { ...b, tasks: before.get(b.instance)?.tasks ?? [] } : b,
    );
    last.current = next;
    setBoards(next);
    setStale(new Set(next.filter((b) => b.state === "unreachable").map((b) => b.instance)));
  }, [rest, fleet]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void load();
      }, BOARD_POLL_MS);
      return () => clearInterval(timer);
    }, [load]),
  );

  const cards = useMemo(() => boardCards(boards ?? []), [boards]);
  const counts = lensCounts(cards);
  const sections = boardSections(cards, lens, query);
  const quiet = (boards ?? []).filter((b) => b.state !== "on");
  const writable = (boards ?? []).filter((b) => b.state === "on").map((b) => b.instance);

  return (
    <Screen edges={["top"]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: t.space.md,
          paddingHorizontal: t.space.lg,
          paddingVertical: t.space.sm,
          borderBottomWidth: t.border.row,
          borderBottomColor: t.c.line,
        }}
      >
        <IconButton icon="back" label="Back" onPress={() => router.back()} />
        <View style={{ flex: 1 }}>
          <Text variant="title" weight={700}>
            Board
          </Text>
          <Text mono variant="caption" tone="fg3" numberOfLines={1}>
            {`${label} · ${fleet.listened().length} instances`}
          </Text>
        </View>
        <IconButton
          icon="plus"
          label="New task"
          disabled={writable.length === 0}
          onPress={() => setCreating(true)}
        />
      </View>
      <View style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.md, gap: t.space.sm }}>
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          {LENSES.map(([k, word]) => (
            <Chip
              key={k}
              label={`${boards ? counts[k] : "…"} ${word}`}
              on={lens === k}
              onPress={() => setLens(k)}
            />
          ))}
        </View>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Filter by title, id, instance, assignee"
          placeholderTextColor={t.c.fg3}
          accessibilityLabel="Filter cards"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={{
            minHeight: t.touch.min,
            paddingHorizontal: t.space.md,
            borderWidth: t.border.control,
            borderColor: t.c.line2,
            color: t.c.fg,
            fontFamily: t.sans(400),
            fontSize: 15,
          }}
        />
      </View>
      <SectionList
        sections={boards ? sections : []}
        keyExtractor={(c) => `${c.instance}/${c.id}`}
        stickySectionHeadersEnabled={false}
        // Headers and footers count against the window: a screenful of cards draws at once.
        initialNumToRender={24}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + t.space.xl }}
        refreshControl={
          <RefreshControl
            tintColor={t.c.fg3}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        renderSectionHeader={({ section }) => (
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              gap: t.space.sm,
              paddingHorizontal: t.space.lg,
              paddingTop: t.space.xl,
              paddingBottom: t.space.sm,
            }}
          >
            <Kicker style={{ color: section.tone === "none" ? t.c.fg2 : t.c[section.tone] }}>
              {section.label}
            </Kicker>
            <Text mono variant="caption" tone="fg2">
              {section.data.length}
            </Text>
            <Text variant="caption" tone="fg3" numberOfLines={1} style={{ flexShrink: 1 }}>
              {section.hint}
            </Text>
          </View>
        )}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 ? (
            <Text variant="bodySmall" tone="fg3" style={{ paddingHorizontal: t.space.lg }}>
              Nothing needs you.
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <CardRow
            card={item}
            stale={stale.has(item.instance)}
            now={now}
            onPress={() => setPicked({ instance: item.instance, id: item.id })}
          />
        )}
        ListEmptyComponent={
          <Text tone="fg3" style={{ padding: t.space.lg }}>
            {fleet.listened().length === 0
              ? "Listen to an instance to see its board."
              : "Reading the boards…"}
          </Text>
        }
        ListFooterComponent={
          quiet.length ? (
            <View style={{ padding: t.space.lg, gap: t.space.sm }}>
              {quiet.map((b) => (
                <View key={b.instance} style={{ gap: 2 }}>
                  <Text variant="bodySmall" tone={b.state === "unreachable" ? "warn" : "fg3"}>
                    {b.state === "unreachable"
                      ? `${b.instance} is not answering; its cards are as last read.`
                      : b.reason}
                  </Text>
                  {b.state === "off" ? (
                    <Text mono variant="caption" tone="fg3">
                      {KANBAN_ENABLE_HINT}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null
        }
      />
      {picked ? (
        <KanbanSheet
          id={picked.id}
          instance={picked.instance}
          onClose={() => {
            setPicked(null);
            void load();
          }}
        />
      ) : null}
      {creating && rest ? (
        <NewTaskSheet
          rest={rest}
          instances={writable}
          onClose={() => setCreating(false)}
          onCreated={(instance, id) => {
            setCreating(false);
            setPicked({ instance, id });
            void load();
          }}
        />
      ) : null}
    </Screen>
  );
}

function CardRow({
  card,
  stale,
  now,
  onPress,
}: {
  card: BoardCard;
  stale: boolean;
  now: number;
  onPress(): void;
}) {
  const t = useTheme();
  const blocked = card.status === "blocked";
  const line = blocked
    ? (card.last_failure_error ?? card.latest_summary ?? "")
    : (card.latest_summary ?? card.body ?? "");
  const stamp = card.status === "running" ? card.last_heartbeat_at : card.created_at;
  return (
    <Pressable
      testID={`board-card-${card.instance}-${card.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}, ${card.instance}`}
      accessibilityHint="Opens the card"
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: t.space.lg,
        marginBottom: t.space.sm,
        padding: t.space.md,
        gap: t.space.xs,
        borderWidth: t.border.row,
        borderColor: t.c.line,
        backgroundColor: pressed ? t.c.bg3 : t.c.bg2,
        opacity: stale ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm }}>
        <Text weight={700} numberOfLines={2} style={{ flex: 1 }}>
          {card.title}
        </Text>
        <Status task={card} />
      </View>
      {line ? (
        <Text variant="bodySmall" tone={blocked ? "warn" : "fg2"} numberOfLines={2}>
          {line}
        </Text>
      ) : null}
      <Text mono variant="caption" tone="fg3" numberOfLines={1}>
        {`${card.instance} · ${card.assignee ? `@${card.assignee}` : "nobody"} · ${card.id}${
          stamp ? ` · ${chatTime(new Date(stamp * 1000).toISOString(), now)}` : ""
        }`}
      </Text>
    </Pressable>
  );
}
