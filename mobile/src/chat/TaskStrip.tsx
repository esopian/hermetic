/**
 * The task list pinned under the conversation bar (§9.4). Running, it opens to
 * the counts, the segment rail, a five-row window around the running item and
 * "All N tasks ›"; tapping its head folds it. Every other state, and a folded
 * running one, is one line (status square, fraction, the item, a paused list's
 * meta and Hide, a chevron) over the rail. A paused or finished line opens the
 * Tasks sheet. With nothing pinned, `TasksChip` under the last turn does.
 *
 * The strip's text scales with Dynamic Type up to `STRIP_TEXT_CAP`, past which
 * its one line would no longer hold the fraction and the item side by side.
 */
import type { TodoFound, TodoPhase, TodoSnapshotLike } from "@hermetic/core/shared";
import { todoFraction } from "@hermetic/core/shared";
import { Pressable, useWindowDimensions, View } from "react-native";
import {
  type TaskCell,
  type TaskRow,
  type TaskStripState,
  taskCells,
  taskWindow,
} from "../client/task-list.ts";
import { useTheme } from "../theme/theme.tsx";
import { haptic } from "../ui/haptics.ts";
import { Kicker } from "../ui/Kicker.tsx";
import { StatusSquare } from "../ui/StatusSquare.tsx";
import { Text } from "../ui/Text.tsx";

export const STRIP_TEXT_CAP = 1.4;

/** Past this text size the paused line drops its meta, which its label still says. */
const META_FONT_SCALE = 1.2;

/** An item's square: done ✓, running (pulsing while live), open, cancelled ×. */
export function TaskGlyph({
  status,
  pulse,
  size = 12,
}: {
  status: string;
  pulse: boolean;
  size?: number;
}) {
  const t = useTheme();
  if (status === "active" && pulse) return <StatusSquare size={size} color={t.c.acc} pulse />;
  const filled = status === "done";
  const edge = status === "active" ? t.c.fg2 : t.c.line2;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: filled ? t.c.ok : "transparent",
        borderWidth: filled ? 0 : t.border.control,
        borderColor: edge,
      }}
    >
      {filled || status === "cancelled" ? (
        <Text
          weight={800}
          maxFontSizeMultiplier={1}
          style={{ fontSize: 9, lineHeight: 10, color: filled ? t.c.bg : t.c.fg2 }}
        >
          {filled ? "✓" : "×"}
        </Text>
      ) : null}
    </View>
  );
}

/** The segment rail: one cell per item not cancelled; the running one pulses while live. */
export function TaskRail({ cells }: { cells: readonly TaskCell[] }) {
  const t = useTheme();
  const color = (cell: TaskCell) =>
    cell === "done" ? t.c.ok : cell === "run" ? t.c.acc : cell === "still" ? t.c.fg2 : t.c.line2;
  return (
    <View style={{ flexDirection: "row", gap: 2 }} importantForAccessibility="no-hide-descendants">
      {cells.map((cell, i) => (
        // Cells have no identity beyond their place in the list.
        <StatusSquare
          key={i}
          color={color(cell)}
          pulse={cell === "run"}
          style={{ flex: 1, width: undefined, height: 4 }}
        />
      ))}
    </View>
  );
}

const STATE: Record<string, string> = {
  done: "Done",
  active: "Running",
  pending: "Open",
  cancelled: "Cancelled",
};

/** One row of the list, in the strip's window or the sheet. */
export function TaskItemRow({
  row,
  pulse,
  large = false,
}: {
  row: TaskRow;
  pulse: boolean;
  large?: boolean;
}) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const { item, depth, folded } = row;
  const settled = item.status === "done" || item.status === "cancelled";
  const line = large ? t.type.body.lineHeight : t.type.bodySmall.lineHeight;
  // The glyph's box follows the text's first line as Dynamic Type grows it.
  const box = line * (large ? fontScale : Math.min(fontScale, STRIP_TEXT_CAP));
  return (
    <View
      accessible
      accessibilityLabel={`${STATE[item.status] ?? item.status}: ${item.content}${folded ? `, subtasks ${folded}` : ""}`}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingVertical: large ? (depth > 0 ? 6 : t.space.sm) : t.space.xs,
        marginLeft: depth > 0 ? 6 + (depth - 1) * 22 : 0,
        paddingLeft: depth > 0 ? t.space.lg : 0,
        borderLeftWidth: depth > 0 ? t.border.row : 0,
        borderLeftColor: t.c.line2,
      }}
    >
      <View style={{ height: box, justifyContent: "center" }}>
        <TaskGlyph status={item.status} pulse={pulse} />
      </View>
      <Text
        variant={large ? "body" : "bodySmall"}
        weight={item.status === "active" ? 700 : 400}
        tone={settled ? "fg3" : "fg"}
        maxFontSizeMultiplier={large ? undefined : STRIP_TEXT_CAP}
        style={[
          { flex: 1 },
          item.status === "cancelled" ? { textDecorationLine: "line-through" } : null,
        ]}
      >
        {item.content}
      </Text>
      {folded ? (
        <Text mono variant="caption" tone="fg3" style={{ lineHeight: line }}>
          {folded}
        </Text>
      ) : null}
    </View>
  );
}

export function TaskStrip({
  state,
  snapshot,
  pulse,
  onToggle,
  onOpen,
  onHide,
}: {
  state: TaskStripState;
  snapshot: TodoSnapshotLike;
  pulse: boolean;
  /** Fold or unfold a running strip. */
  onToggle: () => void;
  onOpen: () => void;
  onHide: () => void;
}) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  if (state.kind === "none") return null;
  const shell = {
    backgroundColor: t.c.bg2,
    borderBottomWidth: t.border.row,
    borderBottomColor: t.c.line,
    paddingHorizontal: t.space.lg,
  } as const;
  const cells = taskCells(snapshot, pulse);
  if (state.kind === "expanded") {
    const window = taskWindow(snapshot);
    const rev = snapshot.revision === null ? null : `rev ${snapshot.revision}`;
    return (
      <View style={shell} testID="task-strip">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={state.label}
          accessibilityState={{ expanded: true }}
          accessibilityHint="Folds the task list"
          onPress={() => {
            haptic.select();
            onToggle();
          }}
          style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, minHeight: 44 }}
        >
          <Kicker maxFontSizeMultiplier={STRIP_TEXT_CAP}>Tasks</Kicker>
          <Text mono weight={700} variant="bodySmall" maxFontSizeMultiplier={STRIP_TEXT_CAP}>
            {state.fraction}
          </Text>
          <Text
            variant="caption"
            tone="fg3"
            numberOfLines={1}
            maxFontSizeMultiplier={STRIP_TEXT_CAP}
            style={{ flex: 1 }}
          >
            {state.summary}
          </Text>
          <Text mono variant="caption" tone="fg3" maxFontSizeMultiplier={STRIP_TEXT_CAP}>
            ▴
          </Text>
        </Pressable>
        <TaskRail cells={cells} />
        <View style={{ paddingTop: t.space.xs }}>
          {window.rows.map((row) => (
            <TaskItemRow key={row.item.id} row={row} pulse={pulse} />
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`All ${snapshot.todos.length} tasks`}
          onPress={() => {
            haptic.select();
            onOpen();
          }}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: t.space.sm,
            minHeight: 44,
            borderTopWidth: t.border.row,
            borderTopColor: t.c.line,
            backgroundColor: pressed ? t.c.sel : "transparent",
          })}
        >
          <Text
            variant="bodySmall"
            weight={700}
            maxFontSizeMultiplier={STRIP_TEXT_CAP}
            style={{ flex: 1 }}
          >
            {`All ${snapshot.todos.length} tasks`}
          </Text>
          <Text mono variant="caption" tone="fg3" maxFontSizeMultiplier={STRIP_TEXT_CAP}>
            {[window.rest ? `${window.rest} more` : null, rev].filter(Boolean).join(" · ")} ›
          </Text>
        </Pressable>
      </View>
    );
  }
  const running = state.tone === "run";
  const mark = state.tone === "done" ? t.c.ok : running ? t.c.acc : t.c.fg3;
  const press = () => {
    haptic.select();
    if (running) onToggle();
    else onOpen();
  };
  const hide = () => {
    haptic.select();
    onHide();
  };
  return (
    <Pressable
      testID="task-strip"
      accessibilityRole="button"
      accessibilityLabel={state.label}
      accessibilityState={running ? { expanded: false } : undefined}
      accessibilityHint={running ? "Shows the task list" : "Opens the task list"}
      // One VoiceOver element, so Hide inside it is reached as an action.
      accessibilityActions={
        state.hide
          ? [
              { name: "activate", label: "Open the task list" },
              { name: "hide", label: "Hide the task list" },
            ]
          : undefined
      }
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "hide") hide();
        else if (e.nativeEvent.actionName === "activate") press();
      }}
      onPress={press}
      style={({ pressed }) => ({
        ...shell,
        minHeight: 44,
        justifyContent: "center",
        gap: t.space.xs,
        paddingVertical: 6,
        backgroundColor: pressed ? t.c.sel : t.c.bg2,
      })}
    >
      {/* Every state's line is 24pt, Hide's height, so the strip keeps one height. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, minHeight: 24 }}>
        <StatusSquare size={8} color={mark} pulse={running && pulse} />
        <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline", gap: t.space.sm }}>
          <Text
            mono
            weight={700}
            variant="bodySmall"
            tone={state.tone === "done" ? "ok" : "fg"}
            maxFontSizeMultiplier={STRIP_TEXT_CAP}
          >
            {/* Drawn apart, like the item's glyph: a fallback font draws ✓ thin. */}
            {state.tone === "done" ? "✓\uFE0E " : ""}
            {state.fraction}
          </Text>
          <Text
            variant={state.now ? "bodySmall" : "caption"}
            weight={state.now ? 700 : 400}
            tone={state.now ? "fg" : "fg3"}
            numberOfLines={1}
            maxFontSizeMultiplier={STRIP_TEXT_CAP}
            style={{ flex: 1, minWidth: 96 }}
          >
            {state.now ? (
              <>
                {/* Archivo has no ▶ or ▷; the mono face does. U+FE0E keeps it off the emoji font. */}
                <Text mono weight={700} variant="bodySmall" maxFontSizeMultiplier={STRIP_TEXT_CAP}>
                  {`${state.now.glyph}\uFE0E`}
                </Text>
                {` ${state.now.text}`}
              </>
            ) : state.tone === "done" ? (
              "clears when you send"
            ) : (
              ""
            )}
          </Text>
          {state.meta && fontScale <= META_FONT_SCALE ? (
            // Shrinks before the item does (the item keeps 96pt), but not to nothing.
            <Text
              mono
              variant="caption"
              tone="fg3"
              numberOfLines={1}
              maxFontSizeMultiplier={STRIP_TEXT_CAP}
              style={{ flexShrink: 1, minWidth: 40 }}
            >
              {state.meta}
            </Text>
          ) : null}
        </View>
        {state.hide ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hide the task list"
            accessibilityHint="On this phone only, until the list changes"
            // 24pt drawn; the slop makes it a 44pt target, kept inside the strip (6pt of
            // padding above the line; 4pt gap + 4pt rail + 6pt padding below it).
            hitSlop={{ top: 6, bottom: 14, left: 4, right: 4 }}
            onPress={hide}
            style={({ pressed }) => ({
              minHeight: 24,
              justifyContent: "center",
              paddingHorizontal: t.space.sm,
              borderWidth: t.border.control,
              borderColor: t.c.fg,
              backgroundColor: pressed ? t.c.sel : "transparent",
            })}
          >
            <Text variant="caption" weight={700} uppercase maxFontSizeMultiplier={STRIP_TEXT_CAP}>
              Hide
            </Text>
          </Pressable>
        ) : null}
        <Text mono variant="caption" tone="fg3" maxFontSizeMultiplier={STRIP_TEXT_CAP}>
          {running ? "▾" : "›"}
        </Text>
      </View>
      <TaskRail cells={cells} />
    </Pressable>
  );
}

/** With nothing pinned: the way back to the last list, under the last turn. */
export function TasksChip({
  found,
  phase,
  onPress,
}: {
  found: TodoFound;
  phase: TodoPhase;
  onPress: () => void;
}) {
  const t = useTheme();
  const { done, total } = todoFraction(found.snapshot);
  const finished = phase === "finished";
  const note = phase === "paused" ? "hidden from the bar" : "last list";
  return (
    <Pressable
      testID="tasks-chip"
      accessibilityRole="button"
      accessibilityLabel={`Tasks ${done} of ${total}${finished ? " done" : ""}, ${note}`}
      accessibilityHint="Opens the task list"
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: t.space.sm,
        minHeight: 44,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderWidth: t.border.row,
          borderColor: t.c.line2,
          paddingHorizontal: t.space.sm,
          paddingVertical: 3,
        }}
      >
        <Text mono variant="caption" tone="fg2">
          ≡
        </Text>
        <Text mono variant="caption" weight={700}>
          Tasks
        </Text>
        <Text mono variant="caption" weight={700} tone={finished ? "ok" : "fg3"}>
          {`${finished ? "✓ " : ""}${done}/${total}`}
        </Text>
        <Text mono variant="caption" tone="fg3">
          ›
        </Text>
      </View>
      <Text variant="caption" tone="fg3">
        {note}
      </Text>
    </Pressable>
  );
}
