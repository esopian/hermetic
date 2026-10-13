/**
 * Agent browser: the box's noVNC desktop in a WebView, loaded straight from
 * the box over the tailnet (`vnc.ts`) — the one thing the phone does not go
 * through the bridge for, so the phone must be on the tailnet (Tailscale app
 * connected). View-only by default; Fit / 1:1 switches noVNC's scaling;
 * pinch-zoom is the WebView's own.
 */
import { Stack, useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import {
  noVncUrl,
  type VncScale as Scale,
  vncScaleScript as scaleScript,
} from "../../src/client/vnc.ts";
import type { AgentView } from "../../src/protocol/types.ts";
import { useTheme } from "../../src/theme/theme.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { Button, Kicker, StatusSquare, Text } from "../../src/ui/index.ts";

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress(): void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={{
        height: 32,
        paddingHorizontal: t.space.md,
        justifyContent: "center",
        borderWidth: t.border.control,
        borderColor: on ? t.c.fg : t.c.line2,
        backgroundColor: on ? t.c.fg : "transparent",
      }}
    >
      <Text
        variant="caption"
        weight={800}
        uppercase
        style={{ color: on ? t.c.bg : t.c.fg2, letterSpacing: 0.8 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function AgentBrowser() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { name } = useLocalSearchParams<{ name: string }>();
  const { client, credentials } = useBridge();
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewOnly, setViewOnly] = useState(true);
  const [scale, setScale] = useState<Scale>("fit");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const web = useRef<WebView>(null);

  useEffect(() => {
    if (!client || !name) return;
    let live = true;
    client
      .rpc<AgentView>("agents.get", { name: String(name) })
      .then((a) => live && setAgent(a))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
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

  const reconnect = useCallback(() => {
    haptic.light();
    setLoadError(null);
    setLoading(true);
    setGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    web.current?.injectJavaScript(scaleScript(scale));
  }, [scale]);

  const overlay = (body: ReactNode) => (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center",
        justifyContent: "center",
        padding: t.space.xl,
        gap: t.space.md,
        backgroundColor: t.c.bg,
      }}
    >
      {body}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <Stack.Screen options={{ title: String(name ?? "Browser") }} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: t.space.sm,
          paddingHorizontal: t.space.md,
          paddingVertical: t.space.sm,
          borderBottomWidth: 1,
          borderBottomColor: t.c.line,
        }}
      >
        <StatusSquare status={agent?.display_status ?? "pending"} size={8} />
        <Kicker style={{ flex: 1 }} numberOfLines={1}>
          {viewOnly ? "view only" : "interactive"}
        </Kicker>
        <Chip label="View only" on={viewOnly} onPress={() => setViewOnly((v) => !v)} />
        <Chip
          label={scale === "fit" ? "Fit" : "1:1"}
          on={scale === "fit"}
          onPress={() => setScale((s) => (s === "fit" ? "actual" : "fit"))}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reconnect"
          hitSlop={8}
          onPress={reconnect}
          style={{ height: 32, paddingHorizontal: t.space.sm, justifyContent: "center" }}
        >
          <Text mono weight={700}>
            ↻
          </Text>
        </Pressable>
      </View>
      <View style={{ flex: 1 }}>
        {url ? (
          <WebView
            key={`${url}#${generation}`}
            ref={web}
            source={{ uri: url }}
            style={{ flex: 1, backgroundColor: t.c.bg }}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            scalesPageToFit
            setBuiltInZoomControls
            setDisplayZoomControls={false}
            bounces={false}
            setSupportMultipleWindows={false}
            originWhitelist={["https://*"]}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => {
              setLoading(false);
              web.current?.injectJavaScript(scaleScript(scale));
            }}
            onError={(e) => {
              setLoading(false);
              setLoadError(e.nativeEvent.description || "The page did not load.");
            }}
            onHttpError={(e) => {
              setLoading(false);
              setLoadError(`The box answered ${e.nativeEvent.statusCode}.`);
            }}
          />
        ) : null}
        {error
          ? overlay(
              <>
                <Text tone="bad" weight={700}>
                  Could not read this agent.
                </Text>
                <Text variant="bodySmall" tone="fg2" style={{ textAlign: "center" }}>
                  {error}
                </Text>
              </>,
            )
          : !agent
            ? overlay(<ActivityIndicator color={t.c.fg3} />)
            : !url
              ? overlay(
                  <Text tone="fg2" style={{ textAlign: "center" }}>
                    This agent has no tailnet name yet. Its browser is reachable once it has joined the
                    tailnet.
                  </Text>,
                )
              : loadError
                ? overlay(
                    <>
                      <Text weight={800} variant="title">
                        The browser did not load.
                      </Text>
                      <Text variant="bodySmall" tone="fg2" style={{ textAlign: "center" }}>
                        {loadError}
                      </Text>
                      <Text variant="bodySmall" tone="fg3" style={{ textAlign: "center" }}>
                        The desktop is served from the box over the tailnet: this phone must be on it,
                        with the Tailscale app connected.
                      </Text>
                      <Button label="Reconnect" onPress={reconnect} />
                      <Button
                        label="Open in Safari"
                        variant="secondary"
                        onPress={() => void Linking.openURL(url).catch(() => {})}
                      />
                    </>,
                  )
                : loading
                  ? overlay(
                      <>
                        <ActivityIndicator color={t.c.fg3} />
                        <Text mono variant="caption" tone="fg3">
                          connecting over the tailnet…
                        </Text>
                      </>,
                    )
                  : null}
      </View>
      <View style={{ height: insets.bottom, backgroundColor: t.c.bg }} />
    </View>
  );
}
