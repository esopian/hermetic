/** Bots · Inbox · Settings. */
import { Redirect, Tabs } from "expo-router";
import { type ColorValue, Text } from "react-native";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { useInbox } from "../../src/bridge/hooks.ts";
import { useTheme } from "../../src/theme/theme.tsx";

export default function TabsLayout() {
  const t = useTheme();
  const { status } = useBridge();
  const inbox = useInbox();
  if (status === "unpaired") return <Redirect href="/pair" />;
  const glyph =
    (g: string) =>
    ({ color }: { color: ColorValue }) => (
      <Text style={{ color, fontFamily: t.mono(700), fontSize: 16 }}>{g}</Text>
    );
  const needs = inbox?.counts.needs_action ?? 0;
  const unread = inbox?.counts.unread ?? 0;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: t.c.bg,
          borderTopColor: t.c.line,
          borderTopWidth: t.border.row,
        },
        tabBarActiveTintColor: t.c.fg,
        tabBarInactiveTintColor: t.c.fg3,
        tabBarLabelStyle: {
          fontFamily: t.sans(700),
          fontSize: 10,
          letterSpacing: 1,
          textTransform: "uppercase",
        },
        tabBarBadgeStyle: {
          backgroundColor: needs > 0 ? t.c.warn : t.c.fg,
          color: t.c.bg,
          borderRadius: 0,
          fontFamily: t.mono(700),
          fontSize: 11,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Bots", tabBarIcon: glyph("◆") }} />
      <Tabs.Screen
        name="inbox"
        options={{
          title: "Inbox",
          tabBarIcon: glyph("▤"),
          ...(needs > 0 ? { tabBarBadge: "!" } : unread > 0 ? { tabBarBadge: unread } : {}),
        }}
      />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: glyph("≡") }} />
    </Tabs>
  );
}
