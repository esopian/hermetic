/**
 * The Pair screen's typed half: paste the `hermetic://pair?…` link, or type
 * host, port and the 8-character code. Validates before it lets you press
 * Pair; the bridge's answer comes back as `error` (`pairErrorCopy`).
 */
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { normalisePairCode, parsePairLink } from "../client/http.ts";
import { type PairErrorCopy, validHost, validPort } from "../client/pairing.ts";
import { MOBILE_PROTOCOL } from "../protocol/constants.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { codeSpans } from "../ui/codeSpans.tsx";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";

export interface PairTarget {
  host: string;
  port: number;
  code: string;
}

export function PairForm({
  initial,
  busy,
  error,
  onSubmit,
}: {
  initial?: Partial<PairTarget> | null;
  busy: boolean;
  error: PairErrorCopy | null;
  onSubmit(target: PairTarget): void;
}) {
  const t = useTheme();
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? MOBILE_PROTOCOL.DEFAULT_PORT));
  const [code, setCode] = useState(initial?.code ?? "");

  useEffect(() => {
    if (!initial) return;
    if (initial.host) setHost(initial.host);
    if (initial.port) setPort(String(initial.port));
    if (initial.code) setCode(initial.code);
  }, [initial?.host, initial?.port, initial?.code]);

  const normalised = normalisePairCode(code);
  const codeOk = normalised.length === MOBILE_PROTOCOL.PAIR_CODE_LENGTH;
  const ready = validHost(host) && validPort(port) && codeOk;

  const input = {
    borderWidth: t.border.control,
    borderColor: t.c.line2,
    color: t.c.fg,
    fontFamily: t.mono(400),
    fontSize: 16,
    paddingHorizontal: t.space.md,
    minHeight: t.touch.min + 4,
    borderRadius: 0,
  } as const;
  const caret = { selectionColor: t.c.acc, cursorColor: t.c.acc } as const;

  const fromLink = (text: string) => {
    const parsed = parsePairLink(text);
    if (!parsed) {
      setLinkError("That is not a hermetic://pair link.");
      return;
    }
    setLinkError(null);
    setHost(parsed.host);
    setPort(String(parsed.port));
    setCode(parsed.code);
    onSubmit({ host: parsed.host, port: parsed.port, code: parsed.code });
  };

  return (
    <View style={{ gap: t.space.md }}>
      <Kicker>Paste the link</Kicker>
      <TextInput
        accessibilityLabel="Pairing link"
        value={link}
        onChangeText={(v) => {
          setLink(v);
          setLinkError(null);
          if (/^hermetic:\/\/pair/i.test(v.trim()) && parsePairLink(v)) fromLink(v);
        }}
        placeholder="hermetic://pair?host=…"
        {...caret}
        placeholderTextColor={t.c.fg3}
        autoCapitalize="none"
        autoCorrect={false}
        style={input}
        onSubmitEditing={() => fromLink(link)}
      />
      {linkError ? (
        <Text variant="caption" tone="bad">
          {linkError}
        </Text>
      ) : null}
      <Kicker>Or enter it by hand</Kicker>
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <TextInput
          accessibilityLabel="Host"
          value={host}
          onChangeText={setHost}
          placeholder="100.x.y.z"
          {...caret}
          placeholderTextColor={t.c.fg3}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          style={[input, { flex: 1, borderColor: host && !validHost(host) ? t.c.bad : t.c.line2 }]}
        />
        <TextInput
          accessibilityLabel="Port"
          value={port}
          onChangeText={(v) => setPort(v.replace(/[^0-9]/g, ""))}
          keyboardType="number-pad"
          maxLength={5}
          {...caret}
          style={[input, { width: 96, borderColor: validPort(port) ? t.c.line2 : t.c.bad }]}
        />
      </View>
      <TextInput
        accessibilityLabel="Pairing code"
        value={code}
        onChangeText={(v) => setCode(v.toUpperCase())}
        placeholder="XXXX-XXXX"
        {...caret}
        placeholderTextColor={t.c.fg3}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={12}
        onSubmitEditing={() =>
          ready && onSubmit({ host: host.trim(), port: Number(port), code: normalised })
        }
        style={[input, { letterSpacing: 4, fontSize: 20, textAlign: "center" }]}
      />
      <Text mono variant="caption" tone={code && !codeOk ? "warn" : "fg3"}>
        {`${normalised.length} of ${MOBILE_PROTOCOL.PAIR_CODE_LENGTH} characters`}
      </Text>
      {error ? (
        <View
          accessibilityRole="alert"
          style={{
            borderLeftWidth: t.border.control,
            borderLeftColor: t.c.bad,
            paddingLeft: t.space.md,
            gap: 2,
          }}
        >
          <Text weight={700} tone="bad">
            {error.title}
          </Text>
          <Text variant="bodySmall" tone="fg2">
            {codeSpans(error.detail)}
          </Text>
        </View>
      ) : null}
      <Button
        label="Pair"
        busy={busy}
        disabled={!ready}
        onPress={() => onSubmit({ host: host.trim(), port: Number(port), code: normalised })}
      />
    </View>
  );
}
