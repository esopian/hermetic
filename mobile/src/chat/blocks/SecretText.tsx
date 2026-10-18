/**
 * The text secret card (`request_secret`, desktop `TextSecretCard` and
 * `SecretTextInput.tsx`): where the operator types or pastes a token, a
 * password or a whole `.env` block for an agent's tools.
 *
 * The value lives in a ref and in the native field, nowhere else — never React
 * state, props or context, so it cannot reach a render, a snapshot, the
 * conversation draft or a log. The field is uncontrolled. What *is* state is
 * the parse summary the card shows (format, a chip per key with its length,
 * the issues, and the masked view's line shape): key names and numbers, never
 * a value. The ref and the field are emptied on send and on unmount.
 *
 * The phone keeps it simple: one multi-line field whatever the key count, and
 * no "Treat as" or input-mode controls — every paste is read `auto`, as the
 * parser decides (one raw value, or `.env` lines), and the summary line says
 * which it found. A multi-line field cannot be a secure field on iOS, so its
 * glyphs are drawn transparent and a mask under it draws a dot per character
 * in the same monospace metrics, with the key names before `=` visible once
 * the parser reads them as requested keys (the desktop's overlay). The eye
 * button reveals it; 10 s without input hides it again.
 *
 * The parser is the box's own (`parseSecretEnv`), live: a paste the box would
 * refuse cannot be sent, and a warning has to be confirmed. From the phone the
 * secret always goes "just this once" into the box's tmpfs, with no choice to
 * make: storing one in SSM needs the desktop's credentials.
 */
import {
  parseSecretEnv,
  type SecretEnvChip,
  type SecretFormat,
  type SecretInputMode,
  secretTextSlug,
} from "@hermetic/core/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { fmtBytes } from "../../client/chat-logic.ts";
import { reasonOf } from "../../client/errors.ts";
import {
  deliveredLate,
  lifetimeLabel,
  requestOrigin,
  secretContinueMessage,
  shortSha,
  slotDelivered,
} from "../../client/file-request-logic.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { Text } from "../../ui/Text.tsx";
import { useChatScope } from "../ChatScope.tsx";
import {
  type CardProps,
  Facts,
  headRight,
  LateDelivery,
  OriginText,
  Purpose,
  Refusal,
  RequestShell,
  TagLine,
  useAgentName,
  useDecline,
} from "./request-parts.tsx";

export function SecretTextCard({ block, slot, files, now, session, refresh, notice }: CardProps) {
  const t = useTheme();
  const scope = useChatScope();
  const agent = useAgentName();
  const request_id = slot.request_id;
  const declining = useDecline(files, request_id, refresh);
  const live = slot.state === "open" || slot.state === "receiving";
  const keys = slot.keys ?? [];
  const optional = slot.optional_keys ?? [];
  const slug = slot.slug ?? secretTextSlug(keys);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxError = error ?? (live && slot.rejected ? slot.rejected.message : null);
  const done = slot.fulfilled;
  const storedKeys = done?.keys ?? keys;

  const submit = (text: string): void => {
    setSending(true);
    setError(null);
    files
      .secret(request_id, { text, as: "auto" })
      .then(
        () => haptic.success(),
        (e: unknown) => {
          haptic.error();
          setError(reasonOf(e).message);
        },
      )
      .finally(() => {
        setSending(false);
        refresh();
      });
  };

  return (
    <RequestShell
      testID={`file-request-${request_id}`}
      title="Secret requested · text"
      right={headRight(slot, now)}
      waiting={live}
    >
      {notice}
      <Purpose text={slot.purpose} />
      <Facts
        rows={[
          [
            "Keys",
            <View key="k" style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
              {keys.map((k) => (
                <Text key={k} variant="caption" mono>{`${k} required`}</Text>
              ))}
              {optional.map((k) => (
                <Text key={k} variant="caption" mono tone="fg2">{`${k} optional`}</Text>
              ))}
            </View>,
          ],
          [
            "Stored as",
            slot.durable && !done
              ? `${slug}.env · tmpfs · just this once from this phone; keeping it in SSM env-${slug} needs the desktop app`
              : done?.ssm_slot
                ? `SSM ${done.ssm_slot}`
                : `${slug}.env · tmpfs · just this once`,
          ],
          ["Agent gets", "the path and key names, never the value"],
          ["Request", <OriginText key="r" {...requestOrigin(slot, session)} />],
        ]}
      />
      {live ? (
        <SecretTextInput
          keys={keys}
          optional_keys={optional}
          disabled={declining.busy}
          busy={sending}
          boxError={boxError}
          onSubmit={submit}
          onDecline={declining.decline}
        />
      ) : null}
      {declining.error ? (
        <Text accessibilityRole="alert" variant="caption" tone="bad">
          {declining.error}
        </Text>
      ) : null}
      {done && slotDelivered(slot) ? (
        <TagLine tag="secret delivered" tone="acc">
          {`${storedKeys.join(" ")} → ${done.path} · ${done.format ?? "dotenv"} · ${storedKeys.length} ${storedKeys.length === 1 ? "key" : "keys"} · sha ${shortSha(done.sha256)} · value never shown`}
        </TagLine>
      ) : null}
      {slot.state === "declined" ? (
        <TagLine tag="declined">{`You declined. ${agent} was told.`}</TagLine>
      ) : null}
      {slot.state === "expired" ? (
        <TagLine tag="expired">{`No secret within ${lifetimeLabel(slot)}. Ask ${agent} to request again.`}</TagLine>
      ) : null}
      {done && deliveredLate(block, slot) ? (
        <LateDelivery
          instance={scope?.instance ?? ""}
          agent={agent}
          request_id={request_id}
          stoppedAt={slot.created_at}
          what="The secret"
          message={secretContinueMessage(request_id, done.path, storedKeys)}
        />
      ) : null}
    </RequestShell>
  );
}

/* ── the masked input ────────────────────────────────────────────────────── */

export interface SecretTextInputProps {
  /** Required env names from hermeticd's slot. */
  keys: readonly string[];
  optional_keys?: readonly string[];
  disabled?: boolean;
  /** A send is in flight. */
  busy?: boolean;
  /** hermeticd's refusal, shown under the field. */
  boxError?: string | null;
  /** Called with the text once; this component empties its ref and field right after. */
  onSubmit(text: string): void;
  onDecline(): void;
}

/** Above this the card suggests `request_file`. */
const LARGE_BYTES = 4 * 1024;
/** Revealed text hides again after this long without input. */
export const REVEAL_IDLE_MS = 10_000;
const MASK = "•";
/** The phone reads every paste as the parser decides: one raw value, or `.env` lines. */
const AS: SecretInputMode = "auto";

/**
 * One line of the masked view: a visible key prefix (`.env` only), then the
 * rest with every non-space character a dot and every space kept, so the mask
 * wraps where the field does.
 */
interface MaskLine {
  prefix: string;
  masked: string;
}

/** Everything the card shows about the text. Never the text. */
interface Summary {
  empty: boolean;
  ok: boolean;
  format: SecretFormat | null;
  chips: SecretEnvChip[];
  errors: string[];
  warnings: string[];
  lines: number;
  bytes: number;
  mask: MaskLine[];
}

const KEY_PREFIX_RE = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)/;
const NUM = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string): string => `${NUM(n)} ${n === 1 ? one : many}`;

/** `s` with each character but whitespace a dot, by code point. */
function maskOf(s: string): string {
  let out = "";
  for (const ch of s) out += /\s/.test(ch) ? ch : MASK;
  return out;
}

export function summarise(
  text: string,
  keys: readonly string[],
  optional: readonly string[],
  as: SecretInputMode,
): Summary {
  const physical = text === "" ? [] : text.replace(/\r\n?/g, "\n").split("\n");
  let result: ReturnType<typeof parseSecretEnv>;
  try {
    result = parseSecretEnv(text, { keys, optional_keys: optional }, as);
  } catch {
    // Only a malformed spec throws; the card cannot fix that, so it refuses.
    return {
      empty: text === "",
      ok: false,
      format: null,
      chips: [],
      errors: ["This request's key list is malformed; decline it and ask the agent again."],
      warnings: [],
      lines: physical.length,
      bytes: 0,
      mask: physical.map((l) => ({ prefix: "", masked: maskOf(l) })),
    };
  }
  // A key name is shown only when the parser read that line as an assignment
  // of a key it reports, so a `NAME=` inside a multi-line value stays masked.
  const found = new Set(result.chips.filter((c) => c.state !== "missing").map((c) => c.key));
  const mask = physical.map((line): MaskLine => {
    if (result.format === "dotenv") {
      const m = KEY_PREFIX_RE.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined && found.has(m[2])) {
        return { prefix: m[1], masked: maskOf(line.slice(m[1].length)) };
      }
    }
    return { prefix: "", masked: maskOf(line) };
  });
  return {
    empty: text === "",
    ok: result.ok,
    format: result.format,
    chips: result.chips,
    errors: result.ok ? [] : result.errors.map((e) => e.message),
    warnings: result.warnings.map((w) => w.message),
    lines: physical.length,
    bytes: result.bytes,
    mask,
  };
}

/** "dotenv detected · 2 keys · 2 lines · 41 B", "raw value detected · 1 line · 20 B". */
function formatLine(s: Summary): string {
  if (s.empty) return "waiting for a paste";
  if (s.format === null) return "not read";
  const shape = `${plural(s.lines, "line", "lines")} · ${fmtBytes(s.bytes)}`;
  if (s.format === "raw") return `raw value detected · ${shape}`;
  const keys = plural(s.chips.filter((c) => c.state !== "missing").length, "key", "keys");
  return `dotenv detected · ${keys} · ${shape}`;
}

/** What a screen reader speaks for the field: its shape, never the value. */
function spokenValue(s: Summary, revealed: boolean): string {
  if (s.empty) return "empty";
  return `masked${revealed ? " (shown on screen)" : ""} · ${formatLine(s)}`;
}

/** A key chip: the key and a length, never a value. */
function chipText(c: SecretEnvChip): string {
  const opt = c.optional ? " (optional)" : "";
  if (c.state === "ok")
    return `✓ ${c.key}${opt} · ${MASK.repeat(4)} · ${plural(c.length ?? 0, "char", "chars")}`;
  if (c.state === "unrequested") return `✗ ${c.key} · not requested`;
  return `○ ${c.key}${opt} · missing`;
}

export function SecretTextInput(props: SecretTextInputProps) {
  const { keys, optional_keys, disabled = false, busy = false, boxError, onSubmit, onDecline } = props;
  const t = useTheme();
  const keysSig = keys.join(",");
  const optionalSig = (optional_keys ?? []).join(",");
  // Keyed on the lists' contents, not their identity.
  const spec = useMemo(
    () => ({ keys: [...keys], optional: [...(optional_keys ?? [])] }),
    [keysSig, optionalSig],
  );

  /** The secret. Never copied into state. */
  const valueRef = useRef("");
  const fieldRef = useRef<TextInput | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [summary, setSummary] = useState<Summary>(() => summarise("", spec.keys, spec.optional, AS));
  const [armed, setArmed] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const hide = useCallback(() => {
    if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    revealTimer.current = null;
    setRevealed(false);
  }, []);

  const armRevealTimer = useCallback(() => {
    if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(hide, REVEAL_IDLE_MS);
  }, [hide]);

  const clear = useCallback(() => {
    valueRef.current = "";
    fieldRef.current?.clear();
    setSummary(summarise("", spec.keys, spec.optional, AS));
    setArmed(false);
    hide();
  }, [spec, hide]);

  // Unmount: the secret leaves with the card.
  useEffect(
    () => () => {
      valueRef.current = "";
      fieldRef.current?.clear();
      if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    },
    [],
  );

  const onChangeText = (text: string): void => {
    valueRef.current = text;
    setArmed(false);
    setSummary(summarise(text, spec.keys, spec.optional, AS));
    if (revealed) armRevealTimer();
  };

  const inert = disabled || busy;
  const submit = (): void => {
    if (inert) return;
    // Re-read, rather than trust the last render's summary.
    const now = summarise(valueRef.current, spec.keys, spec.optional, AS);
    if (now.empty || !now.ok) return;
    if (now.warnings.length > 0 && !armed) {
      setArmed(true);
      return;
    }
    const text = valueRef.current;
    onSubmit(text);
    clear();
  };

  const toggleReveal = (): void => {
    if (revealed) hide();
    else {
      setRevealed(true);
      armRevealTimer();
    }
  };

  const canSubmit = !inert && !summary.empty && summary.ok;
  const label = `Secret value for ${keys.join(", ") || (optional_keys ?? []).join(", ")}`;
  const line = t.type.mono.lineHeight;
  const fieldStyle = {
    fontFamily: t.mono(400),
    fontSize: t.type.mono.size,
    lineHeight: line,
    paddingHorizontal: t.space.md,
    paddingVertical: t.space.sm,
  } as const;

  return (
    <View testID="secret-text-input" style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: t.space.sm }}>
        <View
          style={{
            flex: 1,
            minHeight: t.touch.min,
            overflow: "hidden",
            borderWidth: t.border.row,
            borderColor: !summary.empty && !summary.ok ? t.c.bad : t.c.line2,
            backgroundColor: t.c.bg,
          }}
        >
          {/* The mask: one dot per character, key names visible once parsed. */}
          <View
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={{ position: "absolute", top: 0, left: 0, right: 0, ...fieldStyle }}
          >
            {revealed ? null : summary.mask.length === 0 ? (
              <Text mono variant="mono" tone="fg3">
                Paste the secret, or KEY=value lines
              </Text>
            ) : (
              summary.mask.map((l, i) => (
                // No line limit: a long value wraps over as many rows as the
                // field gives it. An empty line is a space, so it keeps its row.
                <Text key={i} mono variant="mono" testID="secret-mask-line">
                  {l.prefix ? (
                    <Text mono variant="mono" tone="acc">
                      {l.prefix}
                    </Text>
                  ) : null}
                  {l.masked === "" && l.prefix === "" ? " " : l.masked}
                </Text>
              ))
            )}
          </View>
          {/* Multi-line on iOS cannot be a secure field: the real glyphs are
              drawn only when revealed, and the mask stands in for them. */}
          <TextInput
            ref={fieldRef}
            testID="secret-text-field"
            multiline
            scrollEnabled={false}
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            importantForAutofill="no"
            textContentType="none"
            keyboardAppearance={t.scheme}
            selectionColor={t.c.acc}
            cursorColor={t.c.acc}
            editable={!inert}
            accessibilityLabel={label}
            // The glyphs are transparent, not gone: what VoiceOver speaks as
            // the field's value is the masked summary, never the text.
            accessibilityValue={{ text: spokenValue(summary, revealed) }}
            onChangeText={onChangeText}
            style={{
              ...fieldStyle,
              minHeight: line * 3 + t.space.sm * 2,
              color: revealed ? t.c.fg : "transparent",
              textAlignVertical: "top",
            }}
          />
        </View>
        <IconButton
          icon={revealed ? "eyeOff" : "eye"}
          label={revealed ? "Hide value" : "Show value"}
          disabled={disabled}
          onPress={toggleReveal}
        />
      </View>

      <View style={{ gap: t.space.xs }}>
        <Text variant="caption" mono tone="fg2">
          {formatLine(summary)}
        </Text>
        {summary.chips.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
            {summary.chips.map((c) => (
              <View
                key={c.key}
                style={{
                  borderWidth: t.border.row,
                  borderColor:
                    c.state === "ok" ? t.c.ok : c.state === "unrequested" ? t.c.bad : t.c.line2,
                  paddingHorizontal: t.space.sm,
                  paddingVertical: t.space.xxs,
                }}
              >
                <Text
                  variant="caption"
                  mono
                  tone={c.state === "ok" ? "ok" : c.state === "unrequested" ? "bad" : "fg2"}
                >
                  {chipText(c)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {!summary.empty
          ? summary.errors.map((m) => (
              <Text key={`e:${m}`} variant="caption" tone="bad">
                {m}
              </Text>
            ))
          : null}
        {summary.ok
          ? summary.warnings.map((m) => (
              <Text key={`w:${m}`} variant="caption" tone="warn">
                {armed ? `${m} Send anyway?` : m}
              </Text>
            ))
          : null}
        {summary.bytes > LARGE_BYTES ? (
          <Text variant="caption" tone="warn">
            Over 4 KB — ask the agent to use request_file for large keys.
          </Text>
        ) : null}
        {boxError ? <Refusal message={boxError} what="Check the value and send it again." /> : null}
      </View>

      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button
          label={armed ? "Send anyway?" : "Send securely"}
          busy={busy}
          disabled={!canSubmit}
          style={{ flex: 1 }}
          onPress={submit}
        />
        <Button label="Decline" variant="destructive" disabled={inert} onPress={onDecline} />
      </View>
    </View>
  );
}
