/**
 * The step between "a pairing link arrived" and "this phone keeps it": which
 * fleet, which tailnet, how many agents. Nothing pairs without a tap here,
 * whether the link came from a QR code, a deep link or a paste.
 */
import { View } from "react-native";
import { cleanLabel, type PairedLink, pairConfirmLines } from "../fleet/pairing.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";

function Line({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ gap: 2 }}>
      <Text variant="caption" tone="fg3" uppercase style={{ letterSpacing: 1 }}>
        {label}
      </Text>
      <Text mono={mono} weight={700} selectable>
        {value}
      </Text>
    </View>
  );
}

/**
 * The "different tailnet" warning, or `null` when the code is for the tailnet
 * this phone is paired with (or it is not paired). Labels are cleaned, never raw.
 */
export function tailnetChange(
  link: PairedLink,
  currentTailnet: string | null | undefined,
): { from: string; to: string; line: string } | null {
  if (!currentTailnet) return null;
  const from = cleanLabel(currentTailnet);
  const to = cleanLabel(link.payload.tailnet);
  if (from.toLowerCase() === to.toLowerCase()) return null;
  return { from, to, line: `This code is for a different tailnet: ${from} → ${to}` };
}

export function PairConfirm({
  link,
  replacing,
  currentTailnet = null,
  busy,
  onConfirm,
  onCancel,
}: {
  link: PairedLink;
  /** This phone is already paired: confirming asks once more before replacing it. */
  replacing: boolean;
  /** The tailnet of the pairing this would replace, if any. */
  currentTailnet?: string | null;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useTheme();
  // Cleaned in `pairConfirmLines`: a link's labels are never shown raw.
  const lines = pairConfirmLines(link);
  const change = replacing ? tailnetChange(link, currentTailnet) : null;
  return (
    <View
      accessibilityRole="summary"
      testID="pair-confirm"
      style={{
        borderWidth: t.border.control,
        borderColor: t.c.acc,
        padding: t.space.lg,
        gap: t.space.md,
      }}
    >
      <Kicker>Confirm pairing</Kicker>
      <Line label="Fleet" value={lines.fleet} mono />
      <Line label="Tailnet" value={lines.tailnet} mono />
      {change ? (
        <Text variant="bodySmall" tone="warn" weight={700} testID="pair-tailnet-change">
          {change.line}
        </Text>
      ) : null}
      <Line label="Agents" value={lines.agents} />
      <Text variant="bodySmall" tone="fg2">
        There is no secret in this code: it names the fleet and its agents. This phone reaches them only
        through Tailscale, signed in to that tailnet.
      </Text>
      {replacing ? (
        <Text variant="bodySmall" tone="warn">
          This replaces the current pairing; you will be asked once more.
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <View style={{ flex: 1 }}>
          <Button label="Cancel" variant="secondary" onPress={onCancel} disabled={busy} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label={change ? "Switch tailnet" : replacing ? "Replace…" : "Pair"}
            busy={busy}
            onPress={onConfirm}
          />
        </View>
      </View>
    </View>
  );
}
