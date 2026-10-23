/**
 * The Tasks sheet (§9.4): the whole list in a page sheet, presented the way
 * Sessions is (`SessionSheet`: native slide-up, drag to dismiss). The big
 * fraction, the counts, the rail and where the list came from, then the full
 * tree, then a note that the list is the agent's and read-only here.
 *
 * Everything it draws is handed in, so its content is there on the first
 * frame of the slide; while it slides away it keeps the last list it showed.
 * Opened from a Tasks row, the items that revision changed flash once (a fade,
 * or a plain highlight that ends without motion under Reduce Motion).
 */
import type { TodoFound, TodoLifecycle } from "@hermetic/core/shared";
import { todoFraction } from "@hermetic/core/shared";
import { useEffect, useRef } from "react";
import { Modal, ScrollView, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { taskCells, taskCounts, taskRows, taskSource } from "../client/task-list.ts";
import { useTheme } from "../theme/theme.tsx";
import { useAccessibilityPreferences } from "../ui/AccessibilityPreferences.tsx";
import { Button } from "../ui/Button.tsx";
import { Text } from "../ui/Text.tsx";
import { TaskItemRow, TaskRail } from "./TaskStrip.tsx";
import { chatTime } from "./time.ts";

/** A changed row's highlight, fading out once. */
function Flash() {
  const t = useTheme();
  const { reduceMotion } = useAccessibilityPreferences();
  const opacity = useSharedValue(0.28);
  useEffect(() => {
    opacity.value = reduceMotion
      ? withDelay(1800, withTiming(0, { duration: 0 }))
      : withDelay(400, withTiming(0, { duration: 1400 }));
  }, [opacity, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", top: 0, bottom: 0, left: -8, right: -8, backgroundColor: t.c.acc },
        style,
      ]}
    />
  );
}

export function TaskSheet({
  visible,
  found,
  life,
  observing,
  now,
  flash,
  onClose,
}: {
  visible: boolean;
  found: TodoFound | null;
  life: TodoLifecycle;
  observing: boolean;
  now: number;
  /** The items to flash, and a key that changes with each opening that asks for it. */
  flash: { ids: ReadonlySet<string>; key: number } | null;
  onClose(): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // The last list shown, so a list that goes away mid-slide does not empty the sheet.
  const held = useRef<{ found: TodoFound; life: TodoLifecycle } | null>(null);
  if (found) held.current = { found, life };
  const shown = held.current;
  return (
    <Modal
      visible={visible && !!shown}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {shown ? (
        <View style={{ flex: 1, backgroundColor: t.c.bg }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              padding: t.space.lg,
              borderBottomWidth: t.border.control,
              borderBottomColor: t.c.fg,
            }}
          >
            <Text variant="heading" style={{ flex: 1 }} accessibilityRole="header">
              Tasks
            </Text>
            <Button label="Done" variant="secondary" compact onPress={onClose} />
          </View>
          <View
            style={{
              gap: t.space.sm,
              padding: t.space.lg,
              borderBottomWidth: t.border.row,
              borderBottomColor: t.c.line,
            }}
          >
            {(() => {
              const { done, total } = todoFraction(shown.found.snapshot);
              const finished = shown.life.phase === "finished";
              return (
                <View
                  accessible
                  style={{ flexDirection: "row", alignItems: "baseline", gap: t.space.sm }}
                >
                  <Text variant="display" weight={800} accessibilityLabel={`${done} of ${total}`}>
                    {`${done}/${total}`}
                  </Text>
                  <Text tone={finished ? "ok" : "fg2"} style={{ flexShrink: 1 }}>
                    {taskCounts(shown.found.snapshot, shown.life)}
                  </Text>
                </View>
              );
            })()}
            <TaskRail cells={taskCells(shown.found.snapshot, shown.life.pulse)} />
            <Text mono variant="caption" tone="fg3">
              {taskSource(shown.found, shown.life, observing, chatTime(shown.found.at, now))}
            </Text>
          </View>
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: t.space.lg,
              paddingBottom: insets.bottom + t.space.xl,
            }}
          >
            {taskRows(shown.found.snapshot.todos).map((row, i) => (
              <View
                key={row.item.id}
                style={{
                  borderTopWidth: i > 0 && row.depth === 0 ? t.border.row : 0,
                  borderTopColor: t.c.line,
                }}
              >
                {flash?.ids.has(row.item.id) ? <Flash key={flash.key} /> : null}
                <TaskItemRow row={row} pulse={shown.life.pulse} large />
              </View>
            ))}
            <Text
              variant="caption"
              tone="fg3"
              style={{
                marginTop: t.space.md,
                paddingTop: t.space.md,
                borderTopWidth: t.border.row,
                borderTopColor: t.c.line,
              }}
            >
              {`In priority order, as Hermes keeps it. Read-only: Hermetic shows the agent's list and cannot change it.${shown.life.phase === "paused" ? " Hide on the bar only clears this phone's view." : ""}`}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </Modal>
  );
}
