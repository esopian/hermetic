/**
 * The shell the chat's request and failure cards share, drawn like the
 * desktop's `.ch-card`: square, a `bg2` fill, a 1px `line` border, and a 3px
 * left rule in the card's tone (warn while it needs the operator). What a card
 * is about is said by its first row, a kicker; what needs the operator is a
 * small square mark.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "../../theme/theme.tsx";
import { Kicker } from "../../ui/Kicker.tsx";

export function SoftCard({
  testID,
  edge,
  children,
}: {
  testID?: string;
  /** The left rule's colour; the card's border colour when absent. */
  edge?: string;
  children: ReactNode;
}) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: t.c.card,
        borderWidth: t.border.row,
        borderColor: t.c.cardEdge,
        borderLeftWidth: edge ? t.border.seam : t.border.row,
        borderLeftColor: edge ?? t.c.cardEdge,
        padding: t.space.md,
        gap: t.space.md,
        marginVertical: t.space.xs,
      }}
    >
      {children}
    </View>
  );
}

/** A small square mark leading a card's first row: warn for "needs you" unless told otherwise. */
export function NeedsDot({ color }: { color?: string }) {
  const t = useTheme();
  return (
    <View accessible={false} style={{ width: 8, height: 8, backgroundColor: color ?? t.c.warn }} />
  );
}

/** A section label inside an opened card ("Arguments", "Result"): a kicker, as on the desktop. */
export function Label({ children }: { children: ReactNode }) {
  return <Kicker>{children}</Kicker>;
}
