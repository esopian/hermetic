/**
 * One delegated child's run (desktop `SubagentModal.tsx`): its goal and state,
 * the tools it called in order, its progress and thinking, and — once it
 * settles — what it came back with. While it runs, Steer sends words to the
 * child at its next tool call (`chat.steer` with `subagent_id`) and Stop ends
 * the child but not the turn (`chat.abort` with `subagent_id`).
 */
import { useState } from "react";
import { Modal, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  controllable,
  costOf,
  DISPATCHED_TEXT,
  dispatchedOnly,
  GONE_TEXT,
  glyphOf,
  rollupOf,
  subagentSettled,
  timeText,
  UNOBSERVED_TEXT,
} from "../client/chat-activity.ts";
import type { SubagentBlock } from "../protocol/types.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { haptic } from "../ui/haptics.ts";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";
import { glyphColor, useTicker } from "./blocks/Subagent.tsx";

export interface SubagentControl {
  steer(text: string): Promise<"queued" | "rejected" | string>;
  stop(): Promise<boolean>;
}

type Note = { tone: "fg2" | "bad" | "ok"; text: string } | null;

export function SubagentSheet({
  block,
  control,
  onClose,
}: {
  block: SubagentBlock | null;
  control: SubagentControl | null;
  onClose(): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"steer" | "stop" | null>(null);
  const [note, setNote] = useState<Note>(null);
  const live = !!block && block.verdict === "running" && !dispatchedOnly(block);
  const now = useTicker(live);
  if (!block) return null;
  const glyph = glyphOf(block);
  const canControl = !!control && controllable(block);
  const reason = block.result?.failure_reason ?? block.result?.error;
  const cost = costOf(block);

  const steer = async () => {
    const text = draft.trim();
    if (!text || !control) return;
    setBusy("steer");
    setNote({ tone: "fg2", text: "Sending steer…" });
    try {
      const status = await control.steer(text);
      setDraft("");
      if (status === "queued") {
        haptic.success();
        setNote({ tone: "ok", text: "Queued · applied at the child's next tool call" });
      } else {
        haptic.warning();
        setNote({ tone: "bad", text: `Not delivered — ${GONE_TEXT}` });
      }
    } catch (e) {
      haptic.error();
      setNote({ tone: "bad", text: `Steer not sent — ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!control) return;
    setBusy("stop");
    try {
      const delivered = await control.stop();
      if (delivered) {
        haptic.success();
        setNote({ tone: "fg2", text: "Stop requested" });
      } else {
        haptic.warning();
        setNote({ tone: "bad", text: `Not found — ${GONE_TEXT}` });
      }
    } catch (e) {
      haptic.error();
      setNote({ tone: "bad", text: `Stop not sent — ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.c.bg }}>
        <View
          style={{
            padding: t.space.lg,
            gap: t.space.xs,
            borderBottomWidth: t.border.control,
            borderBottomColor: t.c.fg,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
            <Text mono weight={700} style={{ color: glyphColor(t.c, glyph.tone) }}>
              {glyph.glyph}
            </Text>
            <Kicker style={{ flex: 1 }}>
              {[
                `subagent ${block.task_index + 1} of ${Math.max(block.task_count, 1)}`,
                glyph.word,
                timeText(block, now),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Kicker>
            <Button label="Done" variant="secondary" compact onPress={onClose} />
          </View>
          <Text variant="title">{block.goal || "Subagent"}</Text>
          <Text mono variant="caption" tone="fg3">
            {["started", block.model, `depth ${block.depth + 1}`].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.md }}>
          <Kicker>Run</Kicker>
          {block.tools.length === 0 ? (
            <Text variant="caption" tone="fg3">
              No tool calls yet.
            </Text>
          ) : (
            block.tools.map((tool, i) => {
              const latest = live && i === block.tools.length - 1;
              return (
                <View key={i} style={{ flexDirection: "row", gap: t.space.sm }}>
                  <Text mono tone={tool.is_error ? "bad" : latest ? "acc" : "fg3"}>
                    {latest ? "●" : "›"}
                  </Text>
                  <Text mono variant="caption" weight={700}>
                    {tool.name}
                  </Text>
                  <Text mono variant="caption" tone="fg2" style={{ flex: 1 }} numberOfLines={3}>
                    {tool.preview}
                  </Text>
                </View>
              );
            })
          )}
          {block.thinking ? (
            <Text
              variant="caption"
              tone="fg2"
              style={{ fontStyle: "italic" }}
            >{`thinking · ${block.thinking}`}</Text>
          ) : null}
          {block.progress ? (
            <Text variant="caption" tone="fg2">{`progress · ${block.progress}`}</Text>
          ) : null}
          {dispatchedOnly(block) ? <Text tone="fg3">{`${DISPATCHED_TEXT}.`}</Text> : null}
          {block.verdict === "unknown" ? <Text tone="fg3">{`${UNOBSERVED_TEXT}.`}</Text> : null}
          {subagentSettled(block) ? (
            <View
              style={{
                gap: t.space.sm,
                borderTopWidth: 1,
                borderTopColor: t.c.line,
                paddingTop: t.space.md,
              }}
            >
              <Kicker tone={block.verdict === "failed" ? "bad" : "fg3"}>{glyph.word}</Kicker>
              {block.summary ? <Text selectable>{block.summary}</Text> : null}
              {reason ? (
                <Text selectable tone="bad" variant="bodySmall">
                  {reason}
                </Text>
              ) : null}
              <Text mono variant="caption" tone="fg3">
                {[rollupOf(block), cost].filter(Boolean).join(" · ")}
              </Text>
            </View>
          ) : null}
        </ScrollView>
        {canControl ? (
          <View
            style={{
              padding: t.space.md,
              paddingBottom: insets.bottom + t.space.md,
              gap: t.space.sm,
              borderTopWidth: t.border.control,
              borderTopColor: t.c.fg,
            }}
          >
            {note ? (
              <Text variant="caption" tone={note.tone}>
                {note.text}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-end" }}>
              <TextInput
                accessibilityLabel="Steer this subagent"
                value={draft}
                onChangeText={setDraft}
                placeholder="Steer this subagent…"
                placeholderTextColor={t.c.fg3}
                multiline
                style={{
                  flex: 1,
                  minHeight: t.touch.min,
                  maxHeight: 120,
                  color: t.c.fg,
                  fontFamily: t.sans(400),
                  fontSize: 15,
                  paddingHorizontal: t.space.md,
                  paddingTop: 11,
                  borderWidth: t.border.control,
                  borderColor: t.c.line2,
                  borderRadius: 0,
                }}
              />
              <Button
                label="Steer"
                busy={busy === "steer"}
                disabled={!draft.trim() || !!busy}
                onPress={() => void steer()}
              />
            </View>
            <Button
              label="Stop subagent"
              variant="destructive"
              busy={busy === "stop"}
              disabled={!!busy}
              onPress={() => void stop()}
            />
          </View>
        ) : note ? (
          <Text variant="caption" tone={note.tone} style={{ padding: t.space.lg }}>
            {note.text}
          </Text>
        ) : null}
      </View>
    </Modal>
  );
}
