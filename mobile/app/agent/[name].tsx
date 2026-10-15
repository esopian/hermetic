/**
 * Agent: what the fleet says about one box (status, Hermes version, host,
 * health, from `GET /fleet` merged with the pairing link), and its browser —
 * the box's noVNC desktop in a WebView, loaded straight from the box over the
 * tailnet (`vnc.ts`, the phone's checked mirror of core's
 * `agentDesktopClientUrl`), so Tailscale must be connected. View-only by
 * default; Fit / 1:1 switches noVNC's scaling; pinch-zoom is the WebView's own.
 */
import { Stack, useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import {
  noVncOrigin,
  noVncRefusalText,
  noVncTarget,
  type VncScale as Scale,
  vncNavigationAllowed,
  vncScaleScript as scaleScript,
} from "../../src/client/vnc.ts";
import { useFleetContext } from "../../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState } from "../../src/fleet/hooks.ts";
import type { FleetAgent } from "../../src/fleet/store.ts";
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
        minHeight: t.touch.min,
        paddingVertical: t.space.xs,
        flexShrink: 1,
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

/** The health block as one line: what is down, else "healthy". */
export function healthLine(health: FleetAgent["health"]): string {
  if (!health) return "no heartbeat yet";
  const down = (["hermes", "tailscale", "disk", "dashboard"] as const).filter(
    (k) => health[k] === false,
  );
  return down.length === 0 ? "healthy" : `${down.join(", ")} down`;
}

function Fact({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View style={{ flexDirection: fontScale > 1.2 ? "column" : "row", gap: t.space.sm }}>
      <Text variant="caption" tone="fg3" uppercase style={{ minWidth: 64, letterSpacing: 0.8 }}>
        {label}
      </Text>
      <Text mono variant="caption" selectable style={{ flexShrink: 1 }}>
        {value}
      </Text>
    </View>
  );
}

export default function AgentBrowser() {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { name } = useLocalSearchParams<{ name: string }>();
  const { fleet } = useFleetContext();
  const fleetState = useFleetState();
  const agents = useFleetAgents();
  // The paired tailnet: a box's reported name must sit under it to be loaded.
  const tailnet = fleetState.link?.payload.tailnet ?? null;
  const fleetId = fleetState.link?.payload.fleet_id ?? null;
  const agent = agents.find((a) => a.name === String(name)) ?? null;
  const [viewOnly, setViewOnly] = useState(true);
  const [scale, setScale] = useState<Scale>("fit");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const web = useRef<WebView>(null);

  const host = agent?.host ?? null;
  const vnc = useMemo(
    () =>
      agent
        ? noVncTarget({ name: agent.name, tailscale_dns_name: host }, tailnet, fleetId, { viewOnly })
        : null,
    [agent, host, tailnet, fleetId, viewOnly],
  );
  const status = agent?.status ?? null;
  const url = vnc?.ok ? vnc.url : null;

  // The one origin the WebView may load; every other navigation goes to the OS.
  const origin = useMemo(() => (url ? noVncOrigin(url) : null), [url]);

  const reconnect = useCallback(() => {
    haptic.light();
    setLoadError(null);
    setLoading(true);
    setGeneration((g) => g + 1);
    void fleet.refresh();
  }, [fleet]);

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
          flexWrap: "wrap",
          alignItems: "center",
          gap: t.space.sm,
          paddingHorizontal: t.space.md,
          paddingVertical: t.space.sm,
          borderBottomWidth: 1,
          borderBottomColor: t.c.line,
        }}
      >
        {status ? <StatusSquare status={status} size={8} /> : <StatusSquare size={8} color={t.c.fg3} />}
        {/* The status only: the View only chip beside it already says the mode. */}
        <Kicker style={{ flexGrow: 1, flexShrink: 1, ...(fontScale > 1 ? { flexBasis: "85%" } : {}) }}>
          {status ?? "status unknown"}
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
          onPress={reconnect}
          style={{
            minHeight: t.touch.min,
            minWidth: t.touch.min,
            paddingHorizontal: t.space.sm,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text mono weight={700}>
            ↻
          </Text>
        </Pressable>
      </View>
      {agent ? (
        <ScrollView
          style={{ maxHeight: "35%", flexGrow: 0 }}
          contentContainerStyle={{
            gap: 2,
            paddingHorizontal: t.space.md,
            paddingVertical: t.space.sm,
            borderBottomWidth: 1,
            borderBottomColor: t.c.line,
          }}
        >
          <Fact label="Hermes" value={agent.version ?? "unknown"} />
          <Fact
            label="Host"
            value={agent.tailscale_ip ? `${agent.host} · ${agent.tailscale_ip}` : agent.host}
          />
          <Fact
            label="Health"
            value={agent.live ? healthLine(agent.health) : "not in the last fleet list"}
          />
        </ScrollView>
      ) : null}
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
            originWhitelist={origin ? [origin] : []}
            onShouldStartLoadWithRequest={(req) => !!origin && vncNavigationAllowed(req.url, origin)}
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
        {!agent
          ? overlay(
              <>
                <Text tone="bad" weight={700}>
                  {`${String(name)} is not an agent of the paired fleet.`}
                </Text>
                <Button label="Try again" variant="secondary" onPress={reconnect} />
              </>,
            )
          : !url
            ? overlay(
                <Text tone="fg2" style={{ textAlign: "center" }}>
                  {noVncRefusalText(
                    vnc && !vnc.ok ? vnc.reason : "no_name",
                    vnc?.host ?? host,
                    tailnet,
                  )}
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
