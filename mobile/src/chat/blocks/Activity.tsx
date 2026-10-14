/**
 * One turn's work as one collapsible group (desktop `ActivityGroup`): a head
 * that says what the run is doing ("Thinking…", "● terminal ls") or did
 * ("Tools complete · 3 tools"), and under it one step per tool, reasoning
 * pass or notice, each opening to its own detail. Delegated children are
 * their one-liners, and a group with children starts open.
 */
import { useState } from "react";
import { Pressable, View } from "react-native";
import { groupSummary, type StepTone, stepLabel, stepStatus } from "../../client/chat-activity.ts";
import { fmtMs, formatPayload } from "../../client/chat-logic.ts";
import { toolSummary } from "../../client/chat-turns.ts";
import type { ChatBlock } from "@hermetic/core/chat-client";
import type { TurnActivity } from "../../client/turn-reducer.ts";
import { useTheme } from "../../theme/theme.tsx";
import { haptic } from "../../ui/haptics.ts";
import { StatusSquare } from "../../ui/StatusSquare.tsx";
import { Text } from "../../ui/Text.tsx";
import { CodePane } from "../CodePane.tsx";
import { Label } from "./SoftCard.tsx";
import { glyphColor, SubagentLine } from "./Subagent.tsx";
import { ToolResult } from "./Tool.tsx";

function StepDetail({ block }: { block: ChatBlock }) {
  const t = useTheme();
  switch (block.kind) {
    case "tool":
      return (
        <View style={{ gap: t.space.xs }}>
          <Label>Arguments</Label>
          <CodePane text={formatPayload(block.args)} lang="json" />
          <Label>Result</Label>
          {block.status === "running" ? (
            <Text mono variant="caption" tone="fg3">
              running on the box
            </Text>
          ) : (
            <ToolResult block={block} />
          )}
        </View>
      );
    case "reasoning":
      return (
        <Text selectable variant="bodySmall" tone="fg2" style={{ fontStyle: "italic" }}>
          {block.text}
        </Text>
      );
    case "activity":
      return (
        <View style={{ gap: t.space.xs }}>
          {block.detail ? (
            <Text selectable variant="bodySmall" tone="fg2">
              {block.detail}
            </Text>
          ) : null}
          {block.payload !== undefined ? <CodePane text={formatPayload(block.payload)} /> : null}
        </View>
      );
    default:
      return <CodePane text={formatPayload("payload" in block ? block.payload : block)} />;
  }
}

function toneColor(t: ReturnType<typeof useTheme>, tone: StepTone) {
  return tone === "warn" ? t.c.warn : glyphColor(t.c, tone);
}

function Step({ block, streaming }: { block: ChatBlock; streaming: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const state = stepStatus(block, streaming);
  const target = block.kind === "tool" ? toolSummary(block) : "";
  const duration = "duration_ms" in block ? fmtMs(block.duration_ms) : "";
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${stepLabel(block)} ${state.word}`}
        onPress={() => {
          haptic.select();
          setOpen((v) => !v);
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: t.space.sm,
          minHeight: 34,
          backgroundColor: pressed ? t.c.sel : "transparent",
        })}
      >
        <Text mono weight={700} style={{ color: toneColor(t, state.tone), width: 14 }}>
          {state.glyph}
        </Text>
        <Text
          mono
          variant="caption"
          weight={700}
          numberOfLines={1}
          style={{ flexShrink: 0, maxWidth: "45%" }}
        >
          {stepLabel(block)}
        </Text>
        <Text mono variant="caption" tone="fg3" numberOfLines={1} style={{ flex: 1 }}>
          {target}
        </Text>
        <Text mono variant="caption" tone="fg3">
          {[state.word, duration].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ paddingLeft: 22, paddingBottom: t.space.sm }}>
          <StepDetail block={block} />
        </View>
      ) : null}
    </View>
  );
}

export function ActivityGroup({
  blocks,
  streaming,
  waiting = false,
  activity,
  turnRunning = false,
}: {
  blocks: ChatBlock[];
  streaming: boolean;
  waiting?: boolean;
  activity?: TurnActivity;
  /** The turn this group is in has not settled (it may not be the live group). */
  turnRunning?: boolean;
}) {
  const t = useTheme();
  const summary = groupSummary(blocks, streaming, activity, waiting, turnRunning);
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? summary.kids.length > 0;
  if (summary.steps.length === 0 && summary.kids.length === 0 && !streaming) return null;
  const edge = summary.tone === "bad" ? t.c.bad : summary.tone === "warn" ? t.c.warn : t.c.line2;
  return (
    <View
      style={{
        borderLeftWidth: t.border.control,
        borderLeftColor: edge,
        paddingLeft: t.space.md,
        marginVertical: t.space.xs,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${summary.status}, ${summary.count}`}
        onPress={() => {
          haptic.select();
          setChoice(!open);
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: t.space.sm,
          minHeight: 36,
          backgroundColor: pressed ? t.c.sel : "transparent",
        })}
      >
        <StatusSquare
          size={8}
          color={streaming ? t.c.acc : summary.tone === "bad" ? t.c.bad : t.c.fg3}
          pulse={streaming}
        />
        <Text
          variant="bodySmall"
          weight={700}
          tone={summary.tone === "bad" ? "bad" : "fg"}
          style={{ flexShrink: 1 }}
          numberOfLines={1}
        >
          {summary.status}
        </Text>
        <Text mono variant="caption" tone="fg3" style={{ flex: 1 }} numberOfLines={1}>
          {summary.count}
        </Text>
        {summary.usage ? (
          <Text mono variant="caption" tone="fg3" numberOfLines={1}>
            {summary.usage}
          </Text>
        ) : null}
        <Text mono variant="caption" tone="fg3">
          {open ? "▾" : "▸"}
        </Text>
      </Pressable>
      {open ? (
        <View>
          {summary.steps.map((block, i) => (
            <Step key={`${block.kind}:${i}`} block={block} streaming={streaming} />
          ))}
          {summary.kids.map((kid) => (
            <SubagentLine key={kid.subagent_id} block={kid} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
