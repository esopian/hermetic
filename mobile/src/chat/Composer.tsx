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
 *   width: Stop stays within reach as the same square button on the left (the
 *   desktop's Esc stops a turn whatever is typed, so a draft never hides the
 *   way out), Send now and Queue as square buttons on the right.
 * - The input row is the desktop's `.ch-input-box`: one square box in `bg2`
 *   with a `line2` border, the text field flush inside it and the square
 *   Send (accent fill) or Stop at its trailing edge. It is a horizontal row
 *   so a leading square `IconButton` (attach) can sit before the field.
 * - Stop lives here and only here: the conversation header has none.
 * - Queued messages sit above the input, each with Send now and remove.
 * - Disabled, the placeholder says why (`composerState`).
 * - Attach: a leading square button opens a sheet (Photo library, Take photo,
 *   Choose file). Picked files sit as chips above the input (`AttachTray`).
 *   A message with files and no text sends; while a file uploads, Send says
 *   "Uploading…" and waits; a failed file blocks Send until it is retried or
 *   removed. A box without a file service shows the button disabled, with a
 *   line saying why.
 * - Paste: while the pasteboard holds an image and the draft can take a file,
 *   a line above the input offers iOS's paste control (`ClipboardPasteButton`,
 *   `UIPasteControl`); its answer goes to the tray like a picked photo
 *   (`paste.ts`). The text field itself pastes text only, so a pasted picture
 *   has to come this way. Checking for an image (`hasImageAsync`) reads no
 *   contents, so it raises no paste prompt; the control's tap is the consent.
 *
 * The input grows to six lines, then scrolls. It sizes itself: a multiline
 * input on iOS grows with its content between `minHeight` and `maxHeight`.
 * Feeding `onContentSizeChange` back into an explicit `height` does not work
 * there — the reported content size includes the padding, so every pass adds
 * the padding again and an empty input opens several lines tall.
 */
import * as Clipboard from "expo-clipboard";
import { memo, useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { attachmentsSummary, type PendingAttachment, roomFor } from "../client/attachments.ts";
import type { QueuedMessage } from "../client/conversation-store.ts";
import { PASTE_IMAGE_OPTIONS, type PastePayload } from "../client/paste.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { haptic } from "../ui/haptics.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Kicker } from "../ui/Kicker.tsx";
import { multilineTint } from "../ui/tint.ts";
import { Text } from "../ui/Text.tsx";
import { AttachTray } from "./AttachTray.tsx";

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

/** Side of the square Send and Stop: the 44pt tap target, drawn whole. */
const ACTION = 44;

/**
 * Send (accent fill, an up arrow) or Stop (a red square glyph) as a square
 * button at the trailing edge of the input box, like the desktop's `.ch-send`.
 * Disabled, Send goes flat; stopping, Stop dims and says it is busy. `inline`
 * (the queue actions row) stands alone, so it draws its own border.
 */
function ActionButton({
  kind,
  label,
  disabled = false,
  busy = false,
  uploading = false,
  inline = false,
  onPress,
}: {
  kind: "send" | "stop";
  label: string;
  disabled?: boolean;
  busy?: boolean;
  /** Send, waiting on a file to reach the box: a spinner in place of the arrow. */
  uploading?: boolean;
  /** In the queue actions row, outside the input box: drawn with its own border. */
  inline?: boolean;
  onPress(): void;
}) {
  const t = useTheme();
  const send = kind === "send";
  const fill = send ? (disabled ? t.c.bg3 : t.c.acc) : "transparent";
  const glyph = send ? (disabled ? t.c.fg3 : t.c.accFg) : t.c.bad;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: ACTION,
          height: ACTION,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: fill,
          // In the box, Stop is parted from the field by the box's own rule;
          // standing alone, it is a bordered square like any control.
          borderWidth: inline ? t.border.row : 0,
          borderLeftWidth: inline || !send ? t.border.row : 0,
          borderColor: t.c.line2,
          opacity: busy ? 0.5 : 1,
        }}
      >
        {send && uploading ? (
          <ActivityIndicator size="small" color={t.c.fg2} />
        ) : send ? (
          <Svg width={18} height={18} viewBox="0 0 24 24">
            <Path
              d="M12 19.5V5M5.5 11.5 12 5l6.5 6.5"
              stroke={glyph}
              strokeWidth={2.4}
              strokeLinecap="square"
              strokeLinejoin="miter"
              fill="none"
            />
          </Svg>
        ) : (
          <View style={{ width: 12, height: 12, backgroundColor: glyph }} />
        )}
      </View>
    </Pressable>
  );
}

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
      {warn ? <View style={{ width: 6, height: 6, backgroundColor: t.c.warn }} /> : null}
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

/**
 * The warning line while a question is open, short enough for one line on a
 * 393pt phone. A parked queue never drains on its own (the store's `drain`
 * returns while `parked`), so it says paused rather than queued. The count and
 * its word are joined by a no-break space so a wrap never strands the number.
 */
export function questionHint(queued: number, parked: boolean): string {
  if (queued === 0) return "A question is waiting above · Send now skips it";
  return parked
    ? `A question is waiting above · queue paused, ${queued}\u00a0waiting`
    : `A question is waiting above · ${queued}\u00a0queued behind it`;
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
  /** The files picked for the next message (`attachmentsReducer`'s state). */
  attachments?: readonly PendingAttachment[];
  /** Open a picker; the screen adds what comes back. */
  onAttach?(kind: AttachKind): void;
  onRemoveAttachment?(local_id: string): void;
  onRetryAttachment?(local_id: string): void;
  /** The paste control's answer (`paste.ts`); without it the composer offers no paste. */
  onPaste?(payload: PastePayload): void;
  /**
   * Whether the attach button shows: `true` (enabled), `false` (hidden), or
   * `"no-service"` (the box answered that it serves no files: disabled, with a
   * line saying so).
   */
  canAttach?: boolean | "no-service";
}

export type AttachKind = "library" | "camera" | "file";

const ATTACH_OPTIONS: readonly { label: string; kind: AttachKind }[] = [
  { label: "Photo library", kind: "library" },
  { label: "Take photo", kind: "camera" },
  { label: "Choose file", kind: "file" },
];

/** The attach sheet: the iOS action sheet, or an alert with the same choices elsewhere. */
export function openAttachSheet(onPick: (kind: AttachKind) => void): void {
  const labels = [...ATTACH_OPTIONS.map((o) => o.label), "Cancel"];
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: "Attach", options: labels, cancelButtonIndex: labels.length - 1 },
      (index) => {
        const option = ATTACH_OPTIONS[index];
        if (option) onPick(option.kind);
      },
    );
    return;
  }
  Alert.alert("Attach", undefined, [
    ...ATTACH_OPTIONS.map((o) => ({ text: o.label, onPress: () => onPick(o.kind) })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}

/**
 * Whether the pasteboard holds an image, while `active`: asked on mount, when
 * the app comes back to the foreground (another app may have copied one), and
 * on each change this app hears of. Asking reads no contents.
 */
function useClipboardImage(active: boolean): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!active) {
      setHas(false);
      return;
    }
    let live = true;
    const check = () => {
      Clipboard.hasImageAsync().then(
        (yes) => {
          if (live) setHas(yes);
        },
        () => {
          if (live) setHas(false);
        },
      );
    };
    check();
    const changes = Clipboard.addClipboardListener(({ contentTypes }) => {
      if (live) setHas(contentTypes.includes(Clipboard.ContentType.IMAGE));
    });
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      live = false;
      changes.remove();
      foreground.remove();
    };
  }, [active]);
  return has;
}

/**
 * The paste line: what is on the pasteboard and the system paste control
 * that pastes it (no prompt).
 */
function PasteLine({ onPaste }: { onPaste(payload: PastePayload): void }) {
  const t = useTheme();
  return (
    <View
      testID="composer-paste"
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: t.space.sm,
        paddingLeft: t.space.xs,
      }}
    >
      <Text variant="caption" tone="fg3" numberOfLines={1} style={{ flexShrink: 1 }}>
        Image on the clipboard
      </Text>
      <Clipboard.ClipboardPasteButton
        testID="composer-paste-button"
        acceptedContentTypes={["image"]}
        imageOptions={PASTE_IMAGE_OPTIONS}
        displayMode="iconAndLabel"
        cornerStyle="fixed"
        backgroundColor={t.c.bg2}
        foregroundColor={t.c.fg}
        style={{ width: 104, height: 32 }}
        onPress={(payload) => {
          haptic.select();
          onPaste(payload);
        }}
      />
    </View>
  );
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
        backgroundColor: t.c.bg2,
        borderWidth: t.border.row,
        borderColor: t.c.line,
      }}
    >
      <Kicker>Queued</Kicker>
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
  const attachments = props.attachments ?? [];
  const canAttach = props.canAttach ?? false;
  const files = attachmentsSummary(attachments);
  const hasFiles = attachments.length > 0;
  const mode = composerMode({ enabled, sending, aborting, draft });
  const editable = enabled || sending;
  const pasteOn =
    !!props.onPaste &&
    canAttach === true &&
    editable &&
    files.staging === 0 &&
    roomFor(attachments) > 0;
  const clipboardImage = useClipboardImage(pasteOn);
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
          {parked && !props.questionOpen ? (
            <Hint warn>
              {`Queue paused · ${queue.length}\u00a0waiting — send one now, or send a new message to resume`}
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
      {/* One warning line at most: an open question is why the queue waits, so
          it wins over the paused-queue line and carries the queue's count. */}
      {props.questionOpen ? (
        <Hint warn>{questionHint(queue.length, parked)}</Hint>
      ) : mode === "queue" ? (
        <Hint>
          {hasFiles
            ? "Files wait for the running turn to finish · Send now steers with the text only"
            : "Queue waits for the turn · Send now steers it"}
        </Hint>
      ) : files.failed > 0 ? (
        <Hint warn>Retry or remove the file that did not upload</Hint>
      ) : canAttach === "no-service" ? (
        <Hint>This instance has no file service</Hint>
      ) : null}
      {pasteOn && clipboardImage && props.onPaste ? <PasteLine onPaste={props.onPaste} /> : null}
      <AttachTray
        items={attachments}
        onRemove={(id) => props.onRemoveAttachment?.(id)}
        onRetry={(id) => props.onRetryAttachment?.(id)}
      />
      {/* The input is always the first child of this row, in every mode, so
          switching modes never remounts it (focus and the keyboard stay). */}
      <View
        testID="composer-input-row"
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          borderWidth: t.border.row,
          borderColor: t.c.line2,
          backgroundColor: t.c.bg2,
          opacity: editable ? 1 : 0.6,
        }}
      >
        {canAttach ? (
          // The leading slot: parted from the field by the box's own rule.
          <View style={{ borderRightWidth: t.border.row, borderColor: t.c.line2 }}>
            <IconButton
              icon="plus"
              label="Attach"
              ring={false}
              testID="composer-attach"
              disabled={canAttach === "no-service" || !editable || files.staging > 0}
              onPress={() => {
                haptic.select();
                openAttachSheet((kind) => props.onAttach?.(kind));
              }}
            />
          </View>
        ) : null}
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
          selectionColor={multilineTint(t.c.acc)}
          cursorColor={t.c.acc}
          style={{
            flex: 1,
            minHeight: ACTION,
            maxHeight: LINE * MAX_LINES + PAD_Y,
            color: t.c.fg,
            fontFamily: t.sans(400),
            fontSize: 15,
            lineHeight: LINE,
            paddingHorizontal: t.space.md,
            paddingTop: PAD_Y / 2,
            paddingBottom: PAD_Y / 2,
            // The box around it draws the border and fill; the field is flush.
            textAlignVertical: "top",
          }}
        />
        {mode === "send" || mode === "disabled" ? (
          <ActionButton
            kind="send"
            label={files.staging > 0 ? "Uploading…" : "Send"}
            uploading={files.staging > 0}
            disabled={
              mode === "disabled" ||
              (!draft.trim() && !hasFiles) ||
              files.staging > 0 ||
              files.failed > 0
            }
            onPress={() => {
              // Files with no text still send: the message is the files.
              const text = take() ?? "";
              if (!text && !hasFiles) return;
              haptic.medium();
              props.onSend(text);
            }}
          />
        ) : mode === "stop" || mode === "stopping" ? (
          <ActionButton
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
          <ActionButton
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
              compact
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
              compact
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
