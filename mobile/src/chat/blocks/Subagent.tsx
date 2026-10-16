/**
 * `subagent` — one line per delegated child (desktop `.sa-line`): glyph,
 * goal, what it is doing or what it came back with, a timer, and Open, which
 * shows the child's run with Steer and Stop (`SubagentSheet`).
 */
import { memo, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { activityOf, dispatchedOnly, glyphOf, timeText } from "../../client/chat-activity.ts";
import type { SubagentBlock } from "@hermetic/core/chat-client";
import { useTheme } from "../../theme/theme.tsx";
import type { Palette } from "../../theme/tokens.ts";
import { haptic } from "../../ui/haptics.ts";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";

/** A one-second clock while something runs, else the wall clock once. */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

export function glyphColor(c: Palette, tone: "ok" | "bad" | "run" | "idle" | "warn"): string {
  return tone === "ok"
    ? c.ok
    : tone === "bad"
      ? c.bad
      : tone === "run"
        ? c.acc
        : tone === "warn"
          ? c.warn
          : c.fg3;
}

function SubagentLineImpl({ block }: { block: SubagentBlock }) {
  const t = useTheme();
  const scope = useChatScope();
  const live = block.verdict === "running" && !dispatchedOnly(block);
  const now = useTicker(live);
  const glyph = glyphOf(block);
  const act = activityOf(block);
  const goal = block.goal || "Subagent";
  const open = scope?.openSubagent;
  return (
    <Pressable
      accessibilityRole={open ? "button" : undefined}
      accessibilityLabel={`Subagent: ${goal}, ${glyph.word}`}
      disabled={!open}
      onPress={() => {
        haptic.select();
        open?.(block.subagent_id);
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        minHeight: 36,
        paddingVertical: 4,
        paddingLeft: (block.depth > 0 ? t.space.lg : t.space.xs) - t.border.control,
        paddingRight: t.space.xs,
        marginVertical: 1,
        // The desktop's `.sa-line`: a recessed strip whose 2px left rule shows
        // only for a verdict worth a glance (accent while live, bad on error).
        backgroundColor: pressed ? t.c.sel : t.c.bg2,
        borderLeftWidth: t.border.control,
        borderLeftColor: live ? t.c.acc : glyph.tone === "bad" ? t.c.bad : "transparent",
      })}
    >
      <Text mono weight={700} style={{ color: glyphColor(t.c, glyph.tone), width: 14 }}>
        {glyph.glyph}
      </Text>
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="bodySmall" weight={700} numberOfLines={1}>
          {goal}
        </Text>
        {act.kind === "none" ? null : (
          <Text mono variant="caption" tone={act.kind === "error" ? "bad" : "fg3"} numberOfLines={1}>
            {act.kind === "tool" ? `↳ ${act.name} ${act.text}` : act.text}
          </Text>
        )}
      </View>
      <Text mono variant="caption" tone={live ? "acc" : "fg3"}>
        {timeText(block, now)}
      </Text>
      {open ? (
        <View style={{ borderWidth: t.border.row, borderColor: t.c.line2, paddingHorizontal: 6 }}>
          <Text mono variant="caption" weight={700} tone="fg2" uppercase style={{ fontSize: 10 }}>
            Open
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export const SubagentLine = memo(SubagentLineImpl);
