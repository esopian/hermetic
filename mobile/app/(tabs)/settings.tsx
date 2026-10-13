/**
 * Settings (placeholder for the next phase): bridge and device, watched
 * instances, notifications, appearance, sign out.
 */
import { useEffect, useState } from "react";
import { ScrollView, Switch, View } from "react-native";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { useRoster } from "../../src/bridge/hooks.ts";
import { easProjectId } from "../../src/bridge/notifications.ts";
import type { AgentView } from "../../src/protocol/types.ts";
import { type SchemePreference, useTheme } from "../../src/theme/theme.tsx";
import { Button, Kicker, Screen, StatusSquare, Text } from "../../src/ui/index.ts";
import { router } from "expo-router";

export default function Settings() {
  const t = useTheme();
  const { client, credentials, socketState, signOut, previews, setPreviews, push, enablePush } =
    useBridge();
  const { state } = useRoster();
  const [agents, setAgents] = useState<AgentView[]>([]);

  useEffect(() => {
    if (!client) return;
    void client
      .rpc<AgentView[]>("agents.list", {})
      .then((list) => setAgents(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [client]);

  const listening = new Set(state?.listening ?? []);
  const section = {
    padding: t.space.lg,
    gap: t.space.md,
    borderBottomWidth: t.border.row,
    borderBottomColor: t.c.line,
  } as const;

  return (
    <Screen>
      <ScrollView>
        <View style={{ padding: t.space.lg }}>
          <Text variant="heading">Settings</Text>
        </View>

        <View style={section}>
          <Kicker>Bridge</Kicker>
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
            <StatusSquare
              size={10}
              color={socketState === "open" ? t.c.ok : t.c.warn}
              pulse={socketState !== "open"}
            />
            <Text mono>{socketState}</Text>
          </View>
          <Text variant="mono" tone="fg2">
            {credentials?.baseUrl}
          </Text>
          <Text variant="mono" tone="fg3">
            fleet {credentials?.fleet.alias ?? credentials?.fleet.fleet_id} · device{" "}
            {credentials?.device_id}
          </Text>
        </View>

        <View style={section}>
          <Kicker>Watched instances</Kicker>
          {agents.length === 0 ? (
            <Text tone="fg3" variant="bodySmall">
              No agents.
            </Text>
          ) : (
            agents.map((agent) => (
              <View
                key={agent.name}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: t.space.md,
                  minHeight: t.touch.min,
                }}
              >
                <StatusSquare status={agent.display_status} />
                <Text mono style={{ flex: 1 }}>
                  {agent.name}
                </Text>
                <Button
                  label="Browser"
                  variant="secondary"
                  compact
                  onPress={() => router.push(`/agent/${encodeURIComponent(agent.name)}`)}
                />
                <Switch
                  accessibilityLabel={`Listen to ${agent.name}`}
                  value={listening.has(agent.name)}
                  trackColor={{ true: t.c.acc, false: t.c.line2 }}
                  onValueChange={(on) => void client?.roster.listen(agent.name, on).catch(() => {})}
                />
              </View>
            ))
          )}
        </View>

        <View style={section}>
          <Kicker>Notifications</Kicker>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text>Show message previews</Text>
            <Switch
              value={previews}
              trackColor={{ true: t.c.acc, false: t.c.line2 }}
              onValueChange={(v) => void setPreviews(v)}
            />
          </View>
          <Button label="Enable push" variant="secondary" onPress={() => void enablePush()} />
          <Text variant="caption" tone="fg3">
            {push === null
              ? easProjectId()
                ? "Push not registered yet."
                : "No EAS project id in this build: alerts arrive only while the app keeps its connection."
              : push.ok
                ? "Push registered."
                : `Push unavailable: ${push.reason}`}
          </Text>
        </View>

        <View style={section}>
          <Kicker>Appearance</Kicker>
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            {(["system", "dark", "light"] as SchemePreference[]).map((p) => (
              <Button
                key={p}
                label={p}
                compact
                variant={t.preference === p ? "primary" : "secondary"}
                onPress={() => t.setPreference(p)}
              />
            ))}
          </View>
        </View>

        <View style={section}>
          <Button
            label="Sign out of this bridge"
            variant="destructive"
            onPress={() => void signOut()}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
