/**
 * The transcript's card shell (desktop `Card.tsx`, `.ch-card`): a head with a
 * label, an optional subject line and a right-hand note, a verdict-coloured
 * dot (none for a muted card), and a body that a settled card keeps shut until
 * tapped. Drawn soft, like the request cards: a rounded fill, no seam or box.
 */
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { type CardVerdict, startsCollapsed } from "../client/chat-logic.ts";
import { useTheme } from "../theme/theme.tsx";
import type { Palette } from "../theme/tokens.ts";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";

const RADIUS = 14;

export function verdictColor(c: Palette, verdict: CardVerdict | "warn" | "bad"): string {
  switch (verdict) {
    case "ok":
      return c.ok;
    case "warn":
      return c.warn;
    case "bad":
      return c.bad;
    case "acc":
      return c.acc;
    case "unknown":
      return c.fg3;
    default:
      return c.line2;
  }
}

export function Card({
  verdict,
  head,
  right,
  subject,
  collapsible = false,
  open: initiallyOpen,
  children,
  style,
  testID,
}: {
  verdict: CardVerdict;
  head: ReactNode;
  right?: ReactNode;
  subject?: string | null;
  collapsible?: boolean;
  /** Override the collapse rule (`startsCollapsed`). */
  open?: boolean;
  children?: ReactNode;
  style?: ViewStyle;
  testID?: string;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(initiallyOpen ?? !(collapsible && startsCollapsed(verdict)));
  const edge = verdictColor(t.c, verdict);
  const headRow = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        paddingHorizontal: t.space.md,
        paddingVertical: t.space.sm,
        minHeight: 36,
      }}
    >
      {collapsible ? (
        <Text mono variant="caption" tone="fg3" style={{ width: 10 }}>
          {open ? "▾" : "▸"}
        </Text>
      ) : null}
      {verdict === "muted" ? null : (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: edge }} />
      )}
      <View style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        {typeof head === "string" ? (
          <Text variant="bodySmall" weight={600} tone="fg2" numberOfLines={1}>
            {head}
          </Text>
        ) : (
          head
        )}
      </View>
      <View style={{ flex: 1 }} />
      {right !== undefined && right !== null && right !== "" ? (
        typeof right === "string" || typeof right === "number" ? (
          <Text mono variant="caption" tone="fg3" numberOfLines={1}>
            {String(right)}
          </Text>
        ) : (
          right
        )
      ) : null}
    </View>
  );
  return (
    <View
      testID={testID}
      style={[
        {
          borderRadius: RADIUS,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.c.cardEdge,
          backgroundColor: t.c.card,
          overflow: "hidden",
          marginVertical: t.space.xs,
        },
        style,
      ]}
    >
      {collapsible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => {
            haptic.select();
            setOpen((v) => !v);
          }}
          style={({ pressed }) => ({ backgroundColor: pressed ? t.c.sel : "transparent" })}
        >
          {headRow}
        </Pressable>
      ) : (
        headRow
      )}
      {subject ? (
        <Text
          mono
          variant="caption"
          tone="fg2"
          numberOfLines={open ? 4 : 1}
          style={{ paddingHorizontal: t.space.md, paddingBottom: t.space.sm, marginTop: -2 }}
        >
          {subject}
        </Text>
      ) : null}
      {open && children ? (
        <View
          style={{
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.c.line,
            padding: t.space.md,
            gap: t.space.sm,
          }}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}
