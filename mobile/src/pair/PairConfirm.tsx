/**
 * The step between "a pairing link arrived" and "this phone holds a token":
 * which bridge, which fleet, and the name this phone will give itself. Nothing
 * pairs without a tap here, whether the values came from a QR code, a deep
 * link, a pasted link or the form.
 */
import { View } from "react-native";
import { pairConfirmLabels } from "../client/pairing.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";
import type { PairTarget } from "./PairForm.tsx";

function Line({
  label,
  value,
  mono,
  unknown = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** A placeholder for a value not known yet: muted, not bold. */
  unknown?: boolean;
}) {
  return (
    <View style={{ gap: 2 }}>
      <Text variant="caption" tone="fg3" uppercase style={{ letterSpacing: 1 }}>
        {label}
      </Text>
      <Text mono={mono} weight={unknown ? 400 : 700} tone={unknown ? "fg2" : undefined} selectable>
        {value}
      </Text>
    </View>
  );
}

export function PairConfirm({
  target,
  deviceName,
  replacing,
  busy,
  onConfirm,
  onCancel,
}: {
  target: PairTarget;
  deviceName: string;
  /** This phone is already paired: confirming asks once more before replacing it. */
  replacing: boolean;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useTheme();
  // Cleaned here as well as in `pairProposal`: a link's name is never shown raw.
  const { bridge, fleet } = pairConfirmLabels(target);
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
      <Line label="Bridge" value={bridge} mono />
      <Line label="Fleet" value={fleet ?? "Shown once paired"} mono={!!fleet} unknown={!fleet} />
      <Line label="This phone will be called" value={deviceName} />
      <Text variant="bodySmall" tone="fg2">
        Only pair with a bridge you started. It will be able to send this phone notifications, and this
        phone will be able to chat with every agent in that fleet.
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
          <Button label={replacing ? "Replace…" : "Pair"} busy={busy} onPress={onConfirm} />
        </View>
      </View>
    </View>
  );
}
