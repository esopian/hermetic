/**
 * The transcript's card shell (desktop `Card.tsx`, `.ch-card`): a head with a
 * label, an optional subject line and a right-hand note, a verdict-coloured
 * left seam, and a body that a settled card keeps shut until tapped.
 */
import { type ReactNode, useState } from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import { type CardVerdict, startsCollapsed } from "../client/chat-logic.ts";
import { useTheme } from "../theme/theme.tsx";
import type { Palette } from "../theme/tokens.ts";
import { haptic } from "../ui/haptics.ts";
import { Text } from "../ui/Text.tsx";

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
      <View style={{ flexShrink: 1, flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        {typeof head === "string" ? (
          <Text variant="caption" weight={700} uppercase style={{ letterSpacing: 1 }} numberOfLines={1}>
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
          borderWidth: 1,
          borderColor: t.c.line,
          borderLeftWidth: t.border.control,
          borderLeftColor: edge,
          backgroundColor: t.c.bg2,
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
          style={{ borderTopWidth: 1, borderTopColor: t.c.line, padding: t.space.md, gap: t.space.sm }}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}
