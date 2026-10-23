/**
 * A todo call in the transcript (§9.4): one line saying what it changed in the
 * list (`Tasks ✓ Unit tests · ▶ Flow tests  2/9`, `todoDiff`), which opens the
 * Tasks sheet with those items flashed. Drawn on its own while the turn runs,
 * and inside the run's group once it settles.
 */
import type { ChatBlock } from "@hermetic/core/chat-client";
import { todoDiff, todoFraction } from "@hermetic/core/shared";
import { Pressable, View } from "react-native";
import { diffParts, spokenDiff, todoStepKey } from "../../client/task-list.ts";
import { useTheme } from "../../theme/theme.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";

const MARKS = { "✓": "ok", "▶": "acc", "×": "fg3" } as const;

/** The diff with its status glyphs in their colours. */
export function DiffText({ text }: { text: string }) {
  return (
    <>
      {text.split(/([✓▶×])/).map((part, i) =>
        part in MARKS ? (
          // Pieces have no identity beyond their place in the line.
          // Regular mono lacks ▶ (a fallback font draws it taller than the row); the bold
          // face has it, as in the strip. U+FE0E keeps it a text glyph, never iOS's emoji.
          <Text key={i} mono weight={700} variant="caption" tone={MARKS[part as keyof typeof MARKS]}>
            {`${part}\uFE0E`}
          </Text>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * `nested`: inside a run's group, in its steps' column; on its own it lines up
 * with a group head instead.
 */
export function TaskChange({ block, nested = false }: { block: ChatBlock; nested?: boolean }) {
  const t = useTheme();
  const scope = useChatScope();
  if (block.kind !== "tool" || !block.todos) return null;
  const todos = block.todos;
  const diff = todoDiff(scope?.tasks?.prevOf.get(todoStepKey(block)) ?? null, todos);
  const { rest, running } = diffParts(diff);
  const { done, total } = todoFraction(todos);
  const open = scope?.tasks?.open;
  const height = nested ? 34 : 36;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Tasks: ${spokenDiff(diff)}, ${done} of ${total} done`}
      accessibilityHint={open ? "Opens the task list" : undefined}
      disabled={!open}
      onPress={() => {
        haptic.select();
        open?.(block);
      }}
      // Nested rows abut their neighbours' targets, so only the standalone row grows to 44pt.
      hitSlop={nested ? undefined : { top: 4, bottom: 4 }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        minHeight: height,
        backgroundColor: pressed ? t.c.sel : "transparent",
      })}
    >
      <View style={{ width: nested ? 14 : 8, alignItems: "center" }}>
        <Text mono variant="caption" tone="fg2">
          ≡
        </Text>
      </View>
      <Text variant="caption" weight={700}>
        Tasks
      </Text>
      {/* What settled gives way first, but keeps a quarter of the room. */}
      <View style={{ flex: 1, flexDirection: "row" }}>
        {rest ? (
          <Text
            mono
            variant="caption"
            tone="fg3"
            numberOfLines={1}
            style={{ flexShrink: 4, minWidth: "25%" }}
          >
            <DiffText text={rest} />
          </Text>
        ) : null}
        {running ? (
          <Text mono variant="caption" tone="fg3" numberOfLines={1} style={{ flexShrink: 1 }}>
            <DiffText text={`${rest ? " · " : ""}${running}`} />
          </Text>
        ) : null}
      </View>
      <Text mono variant="caption" tone="fg3">
        {`${done}/${total}`}
      </Text>
    </Pressable>
  );
}
