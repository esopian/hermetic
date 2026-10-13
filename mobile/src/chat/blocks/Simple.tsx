/**
 * The small block renderers: reasoning, activity notices, attachments,
 * sources, `hermetic` cards, background process events, and the `unknown`
 * fallthrough that keeps a version bump from blanking a transcript.
 */
import { Linking, Pressable, View } from "react-native";
import {
  fmtBytes,
  fmtCount,
  fmtMs,
  formatPayload,
  openableHref,
  unknownName,
  unknownPayload,
} from "../../client/chat-logic.ts";
import type {
  ActivityBlock,
  AttachmentBlock as AttachmentBlockType,
  ChatBlock,
  HermeticBlock as HermeticBlockType,
  ProcessEventBlock as ProcessEventBlockType,
  ReasoningBlock as ReasoningBlockType,
  SourcesBlock as SourcesBlockType,
} from "@hermetic/core/chat-client";
import { useTheme } from "../../theme/theme.tsx";
import { Kicker } from "../../ui/Kicker.tsx";
import { Text } from "../../ui/Text.tsx";
import { Card } from "../Card.tsx";
import { CodePane } from "../CodePane.tsx";

/** `reasoning` — a muted card, shut by default: "thought for Xs · N tokens", or "live". */
export function ReasoningBlock({ block }: { block: ReasoningBlockType }) {
  const cost = [
    block.duration_ms ? `thought for ${fmtMs(block.duration_ms)}` : null,
    block.tokens ? `${fmtCount(block.tokens)} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card verdict="muted" head="Reasoning" right={cost || "live"} collapsible>
      <Text selectable variant="bodySmall" tone="fg2" style={{ fontStyle: "italic" }}>
        {block.text}
      </Text>
    </Card>
  );
}

/** A warning or error the box raised about the run: drawn where it happened, never folded. */
export function ActivityNotice({ block }: { block: ActivityBlock }) {
  const t = useTheme();
  const tone = block.state === "error" ? t.c.bad : t.c.warn;
  return (
    <View
      accessibilityRole={block.state === "error" ? "alert" : "text"}
      style={{
        borderLeftWidth: t.border.control,
        borderLeftColor: tone,
        backgroundColor: t.c.bg2,
        padding: t.space.md,
        gap: t.space.xs,
        marginVertical: t.space.xs,
      }}
    >
      <Text weight={700} variant="bodySmall" tone={block.state === "error" ? "bad" : "warn"}>
        {block.title}
      </Text>
      {block.detail ? (
        <Text selectable variant="bodySmall" tone="fg2">
          {block.detail}
        </Text>
      ) : null}
      {block.payload !== undefined ? (
        <Card verdict="muted" head="Details" collapsible open={false}>
          <CodePane text={formatPayload(block.payload)} />
        </Card>
      ) : null}
    </View>
  );
}

export function typeTag(mime: string, name: string): string {
  const sub = (typeof mime === "string" ? mime : "").split("/")[1] ?? "";
  const cleaned = sub.split("+")[0] ?? "";
  if (cleaned && cleaned.length <= 4) return cleaned.toUpperCase();
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return (ext || cleaned || "file").slice(0, 4).toUpperCase();
}

/** `attachment` — the file's tag, name, size and type; opens only an absolute https link. */
export function AttachmentBlock({ block }: { block: AttachmentBlockType }) {
  const t = useTheme();
  const href = openableHref(block.href);
  return (
    <Pressable
      accessibilityRole={href ? "link" : undefined}
      disabled={!href}
      onPress={() => href && void Linking.openURL(href).catch(() => {})}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        padding: t.space.sm,
        borderWidth: 1,
        borderColor: t.c.line,
        backgroundColor: pressed ? t.c.sel : t.c.bg2,
        marginVertical: t.space.xs,
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.c.bg3,
        }}
      >
        <Text mono variant="caption" weight={700}>
          {typeTag(block.mime, block.name)}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text weight={700} variant="bodySmall" numberOfLines={1}>
          {block.name}
        </Text>
        <Text mono variant="caption" tone="fg3" numberOfLines={1}>
          {`${fmtBytes(block.bytes)} · ${block.mime}`}
        </Text>
      </View>
    </Pressable>
  );
}

/** `sources` — numbered citations; a row opens only when its link is safe to hand the OS. */
export function SourcesBlock({ block }: { block: SourcesBlockType }) {
  const t = useTheme();
  const items = Array.isArray(block.items) ? block.items : [];
  return (
    <Card verdict="muted" head="Sources" right={String(items.length)} collapsible>
      {items.map((item, i) => {
        const href = openableHref(item.href);
        return (
          <Pressable
            key={i}
            accessibilityRole={href ? "link" : undefined}
            disabled={!href}
            onPress={() => href && void Linking.openURL(href).catch(() => {})}
            style={{ flexDirection: "row", gap: t.space.sm }}
          >
            <Text mono variant="caption" tone="acc" style={{ width: 18 }}>
              {i + 1}
            </Text>
            <View style={{ flex: 1 }}>
              <Text variant="bodySmall" weight={700} numberOfLines={2}>
                {item.title}
              </Text>
              <Text mono variant="caption" tone="fg3" numberOfLines={1}>
                {item.href}
              </Text>
              {item.snippet ? (
                <Text variant="caption" tone="fg2" numberOfLines={2}>
                  {item.snippet}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </Card>
  );
}

/** `hermetic` — a reference to an agent, op, plan or fleet: named, never acted on from here. */
export function HermeticBlock({ block }: { block: HermeticBlockType }) {
  return (
    <Card verdict="muted" head={block.card} right={block.ref}>
      <Text variant="caption" tone="fg3">
        Open the desktop app for the live card.
      </Text>
    </Card>
  );
}

const PROCESS_WORD: Record<string, string> = {
  completion: "process finished",
  watch_match: "watch matched",
  watch_disabled: "watch disabled",
  delegation: "delegation finished",
  mcp_reload: "MCP servers reloaded",
};

/** A background event Hermes woke the bot with: one line, output on tap. */
export function ProcessEventBlock({ block }: { block: ProcessEventBlockType }) {
  const verdict =
    block.outcome === "ok"
      ? "ok"
      : block.outcome === "failed"
        ? "bad"
        : block.outcome === "terminated"
          ? "warn"
          : "muted";
  const right = [
    block.exit_code !== null && block.exit_code !== undefined ? `exit ${block.exit_code}` : null,
    block.duration_s ? `${block.duration_s}s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const subject =
    block.command ??
    block.message ??
    (block.delegation
      ? `${block.delegation.succeeded} of ${block.delegation.total} tasks succeeded`
      : null);
  return (
    <Card
      verdict={verdict}
      head={PROCESS_WORD[block.event] ?? block.event}
      right={right}
      subject={subject}
      collapsible
    >
      {block.output_tail ? <CodePane text={block.output_tail} lang="output" /> : null}
      {block.delegation?.tasks.map((task) => (
        <Text key={task.index} variant="caption" tone={task.ok ? "fg2" : "bad"}>
          {`${task.ok ? "✓" : "✕"} ${task.goal ?? `task ${task.index + 1}`}${task.summary ? ` — ${task.summary}` : ""}`}
        </Text>
      ))}
      {!block.output_tail && !block.delegation ? <CodePane text={block.raw} /> : null}
    </Card>
  );
}

/** The fallthrough: name and payload, open, because the operator is the renderer. */
export function UnknownBlock({ block }: { block: ChatBlock }) {
  const payload = unknownPayload(block);
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const args = record && "args" in record ? record.args : undefined;
  const result = record && "result" in record ? record.result : undefined;
  return (
    <Card verdict="unknown" head="Additional activity" right={unknownName(block)} collapsible>
      {args !== undefined || result !== undefined ? (
        <>
          <Kicker>Arguments</Kicker>
          <CodePane text={formatPayload(args)} />
          <Kicker>Result</Kicker>
          <CodePane text={formatPayload(result)} />
        </>
      ) : (
        <CodePane text={formatPayload(payload)} />
      )}
    </Card>
  );
}
