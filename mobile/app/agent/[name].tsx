/**
 * Agent browser (placeholder for the next phase): the box's noVNC desktop in a
 * WebView, over the tailnet (the phone must be on it — the Tailscale app).
 * View-only toggle and reload; pinch-zoom is the WebView's own.
 */
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { noVncUrl } from "../../src/client/vnc.ts";
import type { AgentView } from "../../src/protocol/types.ts";
import { useTheme } from "../../src/theme/theme.tsx";
import { Button, Kicker, Text } from "../../src/ui/index.ts";

export default function AgentBrowser() {
  const t = useTheme();
  const { name } = useLocalSearchParams<{ name: string }>();
  const { client, credentials } = useBridge();
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewOnly, setViewOnly] = useState(true);
  const web = useRef<WebView>(null);

  useEffect(() => {
    if (!client || !name) return;
    client
      .rpc<AgentView>("agents.get", { name: String(name) })
      .then(setAgent)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, name]);

  const url = useMemo(
    () =>
      agent
        ? noVncUrl(agent, credentials?.tailnet ?? null, credentials?.fleet.fleet_id ?? null, {
            viewOnly,
            ...(agent.browsers[0] ? { servePath: agent.browsers[0].serve_path } : {}),
          })
        : null,
    [agent, credentials, viewOnly],
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <Stack.Screen options={{ title: String(name ?? "Browser") }} />
      <View
        style={{ flexDirection: "row", gap: t.space.sm, padding: t.space.sm, alignItems: "center" }}
      >
        <Kicker style={{ flex: 1 }}>{viewOnly ? "View only" : "Interactive"}</Kicker>
        <Button
          label={viewOnly ? "Take control" : "View only"}
          variant="secondary"
          compact
          onPress={() => setViewOnly((v) => !v)}
        />
        <Button label="Reload" variant="secondary" compact onPress={() => web.current?.reload()} />
      </View>
      {error ? (
        <Text tone="bad" style={{ padding: t.space.lg }}>
          {error}
        </Text>
      ) : url ? (
        <WebView
          ref={web}
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: t.c.bg }}
          allowsInlineMediaPlayback
          scalesPageToFit
          setSupportMultipleWindows={false}
          originWhitelist={["https://*"]}
        />
      ) : (
        <Text tone="fg3" style={{ padding: t.space.lg }}>
          {agent ? "This agent has no tailnet name yet." : "Loading…"}
        </Text>
      )}
    </View>
  );
}
