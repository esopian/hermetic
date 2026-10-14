/**
 * The soft shell the chat's request and failure cards share, in the app's
 * Grok-like chrome: a rounded `card` fill, a hairline ring only where the
 * scheme needs one (`cardEdge`), no boxed head or seam. What a card is about
 * is said by its first row; what needs the operator is a small dot.
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../../theme/theme.tsx";
import { Text } from "../../ui/Text.tsx";

/** The card's corner radius. */
export const CARD_RADIUS = 16;
/** The radius of a row or field inside a card (choices, the "Other" input). */
export const ROW_RADIUS = 12;

export function SoftCard({ testID, children }: { testID?: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: t.c.card,
        borderRadius: CARD_RADIUS,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.c.cardEdge,
        padding: t.space.md + t.space.xs,
        gap: t.space.md,
        marginVertical: t.space.xs,
      }}
    >
      {children}
    </View>
  );
}

/** A small round mark leading a card's first row: warn gold for "needs you" unless told otherwise. */
export function NeedsDot({ color }: { color?: string }) {
  const t = useTheme();
  return (
    <View
      accessible={false}
      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color ?? t.c.warn }}
    />
  );
}

/** A section label inside an opened card ("Arguments", "Result"): quiet sentence case, not a kicker. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <Text variant="caption" weight={600} tone="fg3">
      {children}
    </Text>
  );
}
