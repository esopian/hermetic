/**
 * `question` carrying `vault_code` — a site's one-time 2FA code the agent's
 * vault asked for (desktop `blocks/VaultCode.tsx`). A masked number field, the
 * hint when there is one, Submit and Skip, answered through `chat.respond` as
 * a single question (core sends it as the request's `value`).
 *
 * The code is a credential, so it is kept the way `SecretText.tsx` keeps a
 * secret: in a ref and the uncontrolled native field, never React state, and
 * emptied on send. The settled card never shows it.
 */
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import type { QuestionBlock } from "@hermetic/core/chat-client";
import { type ClosedRequest, GONE, SENT } from "../../client/chat-requests.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { Kicker } from "../../ui/Kicker.tsx";
import { Text } from "../../ui/Text.tsx";
import { useSubmit } from "./respond.ts";
import { NeedsDot, SoftCard } from "./SoftCard.tsx";

export function VaultCodeCard({
  block,
  now,
  closed,
  session,
  released = false,
  stale = false,
}: {
  block: QuestionBlock;
  now: number;
  closed?: ClosedRequest | undefined;
  session: string | null;
  released?: boolean;
  stale?: boolean;
}) {
  const t = useTheme();
  const { live, state, busy, submit, settled } = useSubmit(session);
  const code = useRef("");
  const field = useRef<TextInput>(null);
  const [filled, setFilled] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const site = block.vault_code?.site ?? null;
  const hint = block.vault_code?.hint ?? null;
  const request_id = block.request_id ?? null;
  const expired = !!block.expires_at && Date.parse(block.expires_at) < now;
  const shut = closed && closed.kind !== "answered";
  const done = settled || (released && !state);
  const open = live && !!request_id && !stale && !expired && !shut && !done;

  const send = (skip: boolean) => {
    const answer = code.current.trim();
    if (!request_id || busy || (!skip && !answer)) return;
    code.current = "";
    field.current?.clear();
    setFilled(false);
    setSkipped(skip);
    void submit(
      skip ? { request_id, kind: "question", skip: true } : { request_id, kind: "question", answer },
    );
  };

  const note = done
    ? state === GONE
      ? GONE
      : skipped
        ? "Skipped. No code sent."
        : "Code sent."
    : shut || expired
      ? "Request closed. No code sent."
      : !open
        ? "Respond in Hermes to enter the code."
        : null;

  return (
    <SoftCard testID={`vault-code-${request_id ?? "none"}`} edge={open ? t.c.warn : undefined}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        {open ? <NeedsDot /> : null}
        <Kicker tone="fg2" style={{ flex: 1 }}>
          Enter verification code
        </Kicker>
        {site ? (
          <Text variant="caption" tone="fg3">
            {site}
          </Text>
        ) : null}
      </View>
      <View style={{ gap: t.space.md }}>
        {note ? (
          <Text variant="bodySmall" tone="fg2">
            {note}
          </Text>
        ) : (
          <>
            {hint ? <Text tone="fg2">{hint}</Text> : null}
            <TextInput
              ref={field}
              secureTextEntry
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              keyboardAppearance={t.scheme}
              accessibilityLabel={site ? `Verification code for ${site}` : "Verification code"}
              selectionColor={t.c.acc}
              cursorColor={t.c.acc}
              placeholder="Code"
              placeholderTextColor={t.c.fg3}
              editable={!busy}
              onChangeText={(text) => {
                code.current = text;
                setFilled(!!text.trim());
              }}
              onSubmitEditing={() => send(false)}
              returnKeyType="done"
              style={{
                minHeight: t.touch.min,
                borderWidth: t.border.row,
                borderColor: filled ? t.c.acc : t.c.line2,
                backgroundColor: t.c.bg,
                color: t.c.fg,
                fontFamily: t.sans(400),
                fontSize: 14,
                paddingHorizontal: t.space.md,
              }}
            />
            <View style={{ flexDirection: "row", gap: t.space.sm }}>
              <Button
                label="Skip"
                variant="secondary"
                disabled={busy}
                style={{ flex: 1 }}
                onPress={() => send(true)}
              />
              <Button
                label="Submit"
                disabled={busy || !filled}
                busy={busy}
                style={{ flex: 2 }}
                onPress={() => send(false)}
              />
            </View>
          </>
        )}
        {state && state !== SENT && state !== GONE ? (
          <Text accessibilityRole="alert" variant="caption" tone="bad">
            {state}
          </Text>
        ) : null}
      </View>
    </SoftCard>
  );
}
