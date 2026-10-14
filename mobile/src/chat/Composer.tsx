/**
 * The composer (desktop `Composer.tsx` + `chat-queue.ts`), shaped for a thumb.
 *
 * - Idle: **Send** starts a turn.
 * - A turn running, nothing typed: **Stop** (the queue is parked, not dropped).
 * - A turn running, something typed: **Queue** adds it to this conversation's
 *   local queue (drained one at a time when the turn ends), and **Send now**
 *   steers it into the running turn — falling back to the head of the queue
 *   and a stop when the box will not take a steer. A line above the input says
 *   which is which (the desktop's footer hint, "Enter queues · ⌘Enter sends now").
 *   These three sit in a row under the input, so the input keeps the full
 *   width: Stop stays within reach as the same round button on the left (the
 *   desktop's Esc stops a turn whatever is typed, so a draft never hides the
 *   way out), Send now and Queue as soft pills on the right.
 * - Stop lives here and only here: the conversation header has none.
 * - Queued messages sit above the input, each with Send now and remove.
 * - Disabled, the placeholder says why (`composerState`).
 *
 * The input grows to six lines, then scrolls. It sizes itself: a multiline
 * input on iOS grows with its content between `minHeight` and `maxHeight`.
 * Feeding `onContentSizeChange` back into an explicit `height` does not work
 * there — the reported content size includes the padding, so every pass adds
 * the padding again and an empty input opens several lines tall.
 */
import { memo, useRef } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
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

/**
 * How long after a send a change event can still be iOS finishing the
 * autocorrection the user did not wait for, rather than new typing.
 */
export const ECHO_MS = 400;

/**
 * Whether a change arriving right after a send is iOS re-inserting the text
 * that was just taken. With an autocorrection pending ("summarise" →
 * "summarize"), UIKit applies it after the field was cleared and reports the
 * whole corrected text as an edit, which would put the sent message straight
 * back into the composer. The echo is the taken text, word for word, with at
 * most half its words corrected; real typing within `ECHO_MS` of a send is a
 * character or two, never the whole message again. Pure, so it is testable.
 */
export function isAutocorrectEcho(incoming: string, taken: string, elapsedMs: number): boolean {
  if (elapsedMs > ECHO_MS) return false;
  const words = (s: string) => s.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const a = words(incoming);
  const b = words(taken);
  if (a.length === 0 || a.length !== b.length) return false;
  // Autocorrection rewrites a word or two and keeps its first letter
  // ("teh" → "the", "summarise" → "summarize"); anything further apart is
  // the user typing something new.
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x === y) continue;
    if (x[0] !== y[0]) return false;
    changed++;
  }
  return changed <= Math.max(1, Math.floor(a.length / 2));
}

/** Drawn diameter of the round Send and Stop; the tap target is 44pt. */
const ROUND = 36;

/**
 * Send (accent, an up arrow) or Stop (a red square) as a round button at the
 * end of the input row, the shape of the app's other icon buttons. Disabled,
 * Send goes flat; stopping, Stop dims and says it is busy.
 */
function RoundAction({
  kind,
  label,
  disabled = false,
  busy = false,
  inline = false,
  onPress,
}: {
  kind: "send" | "stop";
  label: string;
  disabled?: boolean;
  busy?: boolean;
  /** In the queue actions row, centred on the row rather than levelled with the input's last line. */
  inline?: boolean;
  onPress(): void;
}) {
  const t = useTheme();
  const send = kind === "send";
  const fill = send ? (disabled ? t.c.bg3 : t.c.acc) : t.c.bg2;
  const glyph = send ? (disabled ? t.c.fg3 : t.c.accFg) : t.c.bad;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={(t.touch.min - ROUND) / 2}
      // Level with the input's last line, however tall it has grown.
      style={({ pressed }) => ({
        marginBottom: inline ? 0 : (LINE + PAD_Y - ROUND) / 2,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: ROUND,
          height: ROUND,
          borderRadius: ROUND / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: fill,
          borderWidth: send ? 0 : StyleSheet.hairlineWidth,
          borderColor: t.c.line2,
          opacity: busy ? 0.5 : 1,
        }}
      >
        {send ? (
          <Svg width={18} height={18} viewBox="0 0 24 24">
            <Path
              d="M12 19.5V5M5.5 11.5 12 5l6.5 6.5"
              stroke={glyph}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </Svg>
        ) : (
          <View style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: glyph }} />
        )}
      </View>
    </Pressable>
  );
}

/** A compact pill is 32pt drawn; the slop makes its tap target 44pt. */
const PILL_SLOP = 6;

/** One quiet line above the input; `warn` leads it with the needs-you dot. */
function Hint({ warn = false, children }: { warn?: boolean; children: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        paddingHorizontal: t.space.xs,
      }}
    >
      {warn ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.warn }} />
      ) : null}
      <Text
        variant="caption"
        tone={warn ? "fg2" : "fg3"}
        numberOfLines={warn ? 2 : 1}
        style={{ flexShrink: 1 }}
      >
        {children}
      </Text>
    </View>
  );
}

const LINE = 21;
const MAX_LINES = 6;
/** Vertical padding inside the input, top plus bottom. */
const PAD_Y = 22;

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
        paddingLeft: t.space.md,
        borderRadius: 14,
        backgroundColor: t.c.bg2,
      }}
    >
      <Text variant="caption" weight={600} tone="fg3">
        Queued
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
        style={{ paddingHorizontal: t.space.sm, minHeight: t.touch.min, justifyContent: "center" }}
      >
        <Text variant="bodySmall" weight={700} tone="acc">
          Send now
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
        style={{
          minWidth: t.touch.min,
          minHeight: t.touch.min,
          alignItems: "center",
          justifyContent: "center",
        }}
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
  const mode = composerMode({ enabled, sending, aborting, draft });
  const editable = enabled || sending;
  const input = useRef<TextInput>(null);
  const taken = useRef<{ text: string; at: number } | null>(null);
  const take = () => {
    const text = draft.trim();
    if (!text) return null;
    onDraft("");
    input.current?.clear();
    taken.current = { text, at: Date.now() };
    return text;
  };
  const onChange = (next: string) => {
    const last = taken.current;
    taken.current = null;
    if (last && isAutocorrectEcho(next, last.text, Date.now() - last.at)) {
      input.current?.clear();
      return;
    }
    onDraft(next);
  };

  return (
    <View style={{ gap: t.space.xs }}>
      {queue.length > 0 ? (
        <View style={{ gap: t.space.xs }}>
          {parked ? (
            <Hint warn>
              {`Queue paused · ${queue.length} waiting — send one now, or send a new message to resume`}
            </Hint>
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
        <Hint warn>A question is waiting above — Send now skips it, Queue waits behind it</Hint>
      ) : mode === "queue" ? (
        <Hint>Queue waits for the turn · Send now steers it</Hint>
      ) : null}
      {/* The input is always the first child of this row, in every mode, so
          switching modes never remounts it (focus and the keyboard stay). */}
      <View
        testID="composer-input-row"
        style={{ flexDirection: "row", alignItems: "flex-end", gap: t.space.sm }}
      >
        <TextInput
          keyboardAppearance={t.scheme}
          ref={input}
          accessibilityLabel="Message"
          value={draft}
          onChangeText={onChange}
          editable={editable}
          placeholder={sending ? "Queue a message, or steer this turn…" : placeholder}
          placeholderTextColor={t.c.fg3}
          multiline
          selectionColor={t.c.acc}
          cursorColor={t.c.acc}
          style={{
            flex: 1,
            minHeight: LINE + PAD_Y,
            maxHeight: LINE * MAX_LINES + PAD_Y,
            color: t.c.fg,
            fontFamily: t.sans(400),
            fontSize: 15,
            lineHeight: LINE,
            paddingHorizontal: t.space.md,
            paddingTop: PAD_Y / 2,
            paddingBottom: PAD_Y / 2,
            // A soft pill, filled rather than boxed.
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.c.line,
            backgroundColor: t.c.bg2,
            opacity: editable ? 1 : 0.6,
            borderRadius: (LINE + PAD_Y) / 2,
            textAlignVertical: "top",
          }}
        />
        {mode === "send" || mode === "disabled" ? (
          <RoundAction
            kind="send"
            label="Send"
            disabled={mode === "disabled" || !draft.trim()}
            onPress={() => {
              const text = take();
              if (!text) return;
              haptic.medium();
              props.onSend(text);
            }}
          />
        ) : mode === "stop" || mode === "stopping" ? (
          <RoundAction
            kind="stop"
            label="Stop turn"
            busy={mode === "stopping"}
            onPress={() => {
              haptic.warning();
              props.onStop();
            }}
          />
        ) : null}
      </View>
      {mode === "queue" ? (
        // Three targets beside the input left it a third of a phone's width,
        // so a draft wrapped at once; under it the input keeps the full row.
        // Stop sits apart on the left, the two ways to send on the right.
        <View
          testID="composer-queue-actions"
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <RoundAction
            kind="stop"
            label="Stop turn"
            inline
            onPress={() => {
              haptic.warning();
              props.onStop();
            }}
          />
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            <Button
              label="Send now"
              accessibilityLabel="Send now"
              accessibilityHint="Steers this message into the running turn"
              variant="secondary"
              soft
              compact
              hitSlop={PILL_SLOP}
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
              accessibilityHint="Sends this message when the running turn ends"
              soft
              compact
              hitSlop={PILL_SLOP}
              haptic={false}
              onPress={() => {
                const text = take();
                if (!text) return;
                haptic.select();
                props.onQueue(text);
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export const Composer = memo(ComposerImpl);
