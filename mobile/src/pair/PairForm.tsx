/**
 * The Pair screen's typed half: paste the `hermetic://fleet?v=2&…` link that
 * `hermetic mobile pair` prints. A whole link is read as soon as it lands;
 * what comes back (a refusal from `readPairingLink`) is shown as `error`.
 */
import { MOBILE_LINK_PREFIX } from "@hermetic/core/shared";
import { useState } from "react";
import { TextInput, View } from "react-native";
import type { PairErrorCopy } from "../fleet/pairing.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { codeSpans } from "../ui/codeSpans.tsx";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";
import { multilineTint } from "../ui/tint.ts";

export function PairForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: PairErrorCopy | null;
  /** The pasted text, untrimmed: `readPairingLink` decides what it is. */
  onSubmit(link: string): void;
}) {
  const t = useTheme();
  const [link, setLink] = useState("");
  const looksWhole = (v: string) =>
    v.trim().startsWith(`${MOBILE_LINK_PREFIX}?`) && /[?&]agents=/.test(v);

  const input = {
    borderWidth: t.border.control,
    borderColor: t.c.line2,
    color: t.c.fg,
    fontFamily: t.mono(400),
    fontSize: 14,
    paddingHorizontal: t.space.md,
    paddingVertical: t.space.sm,
    minHeight: t.touch.min + 4,
    borderRadius: 0,
  } as const;

  return (
    <View style={{ gap: t.space.md }}>
      <Kicker>Or paste the link</Kicker>
      <TextInput
        keyboardAppearance={t.scheme}
        accessibilityLabel="Pairing link"
        value={link}
        onChangeText={(v) => {
          setLink(v);
          // A pasted link arrives in one change: read it at once.
          if (looksWhole(v) && v.length - link.length > 8) onSubmit(v);
        }}
        placeholder="hermetic://fleet?v=2&…"
        selectionColor={multilineTint(t.c.acc)}
        cursorColor={t.c.acc}
        placeholderTextColor={t.c.fg3}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        style={input}
        onSubmitEditing={() => onSubmit(link)}
      />
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
        label="Read link"
        variant="secondary"
        busy={busy}
        disabled={link.trim().length === 0}
        onPress={() => onSubmit(link)}
      />
    </View>
  );
}
