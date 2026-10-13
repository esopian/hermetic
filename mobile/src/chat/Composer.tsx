/**
 * The composer (desktop `Composer.tsx` + `chat-queue.ts`), shaped for a thumb.
 *
 * - Idle: **Send** starts a turn.
 * - A turn running, nothing typed: **Stop** (the queue is parked, not dropped).
 * - A turn running, something typed: **Queue** adds it to this conversation's
 *   local queue (drained one at a time when the turn ends), and **Now** steers
 *   it into the running turn — falling back to the head of the queue and a
 *   stop when the box will not take a steer.
 * - Queued messages sit above the input, each with Send now and remove.
 * - Disabled, the placeholder says why (`composerState`).
 *
 * The input grows to six lines, then scrolls.
 */
import { memo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import type { QueuedMessage } from "../client/conversation-store.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";

export type ComposerMode = "disabled" | "send" | "queue" | "stop" | "stopping";

/** Which controls the composer shows. Pure, so the state table is testable. */
export function composerMode(input: {
  enabled: boolean;
  sending: boolean;
  aborting: boolean;
  draft: string;
}): ComposerMode {
  if (input.aborting) return "stopping";
  if (input.sending) return input.draft.trim() ? "queue" : "stop";
  if (!input.enabled) return "disabled";
  return "send";
}

const LINE = 21;
const MAX_LINES = 6;

export interface ComposerProps {
  draft: string;
  onDraft(text: string): void;
  enabled: boolean;
  placeholder: string;
  sending: boolean;
  aborting: boolean;
  queue: readonly QueuedMessage[];
  parked: boolean;
  /** A clarify is waiting in this turn: say so, since a queued message waits behind it. */
  questionOpen?: boolean;
  onSend(text: string): void;
  onQueue(text: string): void;
  onSendNow(text: string, queuedId?: string): void;
  onStop(): void;
  onUnqueue(id: string): void;
}

function QueuedRow({
  row,
  onSendNow,
  onRemove,
}: {
  row: QueuedMessage;
  onSendNow(): void;
  onRemove(): void;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        paddingLeft: t.space.sm,
        borderWidth: 1,
        borderColor: t.c.line,
        backgroundColor: t.c.bg2,
      }}
    >
      <Text mono variant="caption" tone="fg3">
        queued
      </Text>
      <Text variant="bodySmall" numberOfLines={1} style={{ flex: 1 }}>
        {row.text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Send now: ${row.text}`}
        hitSlop={6}
        onPress={() => {
          haptic.medium();
          onSendNow();
        }}
        style={{ paddingHorizontal: t.space.sm, paddingVertical: t.space.sm }}
      >
        <Text mono variant="caption" weight={700} tone="acc">
          SEND NOW
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove queued: ${row.text}`}
        hitSlop={6}
        onPress={() => {
          haptic.select();
          onRemove();
        }}
        style={{ paddingHorizontal: t.space.sm, paddingVertical: t.space.sm }}
      >
        <Text mono tone="fg3">
          ✕
        </Text>
      </Pressable>
    </View>
  );
}

function ComposerImpl(props: ComposerProps) {
  const t = useTheme();
  const { draft, onDraft, enabled, placeholder, sending, aborting, queue, parked } = props;
  const [height, setHeight] = useState(LINE);
  const mode = composerMode({ enabled, sending, aborting, draft });
  const editable = enabled || sending;
  const take = () => {
    const text = draft.trim();
    if (!text) return null;
    onDraft("");
    setHeight(LINE);
    return text;
  };

  return (
    <View style={{ gap: t.space.xs }}>
      {queue.length > 0 ? (
        <View style={{ gap: t.space.xs }}>
          {parked ? (
            <Text mono variant="caption" tone="warn">
              {`queue paused · ${queue.length} waiting — send one now, or send a new message to resume`}
            </Text>
          ) : null}
          {queue.map((row) => (
            <QueuedRow
              key={row.id}
              row={row}
              onSendNow={() => props.onSendNow(row.text, row.id)}
              onRemove={() => props.onUnqueue(row.id)}
            />
          ))}
        </View>
      ) : null}
      {props.questionOpen ? (
        <Text mono variant="caption" tone="warn">
          a question is waiting above — Now skips it, Queue waits behind it
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: t.space.sm }}>
        <TextInput
          accessibilityLabel="Message"
          value={draft}
          onChangeText={onDraft}
          editable={editable}
          placeholder={sending ? "Queue a message, or steer with Now…" : placeholder}
          placeholderTextColor={t.c.fg3}
          multiline
          scrollEnabled={height >= LINE * MAX_LINES}
          onContentSizeChange={(e) =>
            setHeight(Math.min(LINE * MAX_LINES, Math.max(LINE, e.nativeEvent.contentSize.height)))
          }
          style={{
            flex: 1,
            height: height + 22,
            maxHeight: LINE * MAX_LINES + 22,
            color: t.c.fg,
            fontFamily: t.sans(400),
            fontSize: 15,
            lineHeight: LINE,
            paddingHorizontal: t.space.md,
            paddingTop: 11,
            paddingBottom: 11,
            borderWidth: t.border.control,
            borderColor: editable ? t.c.line2 : t.c.line,
            backgroundColor: editable ? t.c.bg : t.c.bg2,
            borderRadius: 0,
            textAlignVertical: "top",
          }}
        />
        {mode === "send" || mode === "disabled" ? (
          <Button
            label="Send"
            accessibilityLabel="Send"
            disabled={mode === "disabled" || !draft.trim()}
            haptic={false}
            onPress={() => {
              const text = take();
              if (!text) return;
              haptic.medium();
              props.onSend(text);
            }}
          />
        ) : mode === "queue" ? (
          <View style={{ flexDirection: "row", gap: t.space.xs }}>
            <Button
              label="Now"
              accessibilityLabel="Send now"
              variant="secondary"
              haptic={false}
              onPress={() => {
                const text = take();
                if (!text) return;
                haptic.medium();
                props.onSendNow(text);
              }}
            />
            <Button
              label="Queue"
              accessibilityLabel="Queue"
              haptic={false}
              onPress={() => {
                const text = take();
                if (!text) return;
                haptic.select();
                props.onQueue(text);
              }}
            />
          </View>
        ) : (
          <Button
            label={mode === "stopping" ? "Stopping" : "Stop"}
            accessibilityLabel="Stop turn"
            variant="destructive"
            busy={mode === "stopping"}
            haptic={false}
            onPress={() => {
              haptic.warning();
              props.onStop();
            }}
          />
        )}
      </View>
    </View>
  );
}

export const Composer = memo(ComposerImpl);
