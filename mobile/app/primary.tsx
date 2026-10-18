/**
 * Pick the primary instance. Right after pairing the phone listens to
 * nothing, and this screen comes before home (`needsPrimary`): one agent of
 * the fleet, chosen here, is listened to first and home is built around it.
 * It cannot be dismissed then. Settings › Primary instance opens it again to
 * change the choice, and only then does it offer Cancel.
 */
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { errorCopy } from "../src/client/errors.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState } from "../src/fleet/hooks.ts";
import type { FleetAgent } from "../src/fleet/store.ts";
import { useTheme } from "../src/theme/theme.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { Button, Kicker, Screen, SkeletonRow, StatusSquare, Text } from "../src/ui/index.ts";

/** What a row says under the name: its status, and its version when the fleet view has one. */
export function agentLine(agent: Pick<FleetAgent, "status" | "version">): string {
  const status = agent.status ?? "status unknown";
  return agent.version ? `${status} · ${agent.version}` : status;
}

export default function Primary() {
  const t = useTheme();
  const { primary, setPrimary } = useFleetContext();
  const fleet = useFleetState();
  const agents = useFleetAgents();
  // Changing an existing choice (from Settings) may be cancelled; the first pick may not.
  const [changing] = useState(primary !== null);
  const [picked, setPicked] = useState<string | null>(primary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  const confirm = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setPrimary(picked);
      haptic.success();
      if (changing && router.canGoBack()) router.back();
      else router.replace("/home");
    } catch (e) {
      haptic.error();
      setError(errorCopy(e));
      setBusy(false);
    }
  };

  return (
    <Screen edges={["top", "bottom"]}>
      <FlatList
        data={agents}
        keyExtractor={(a) => a.name}
        contentContainerStyle={{ paddingBottom: t.space.xl }}
        ListHeaderComponent={
          <View style={{ padding: t.space.xl, gap: t.space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Kicker style={{ flex: 1 }}>{fleet.link?.label ?? "Hermetic"}</Kicker>
              {changing ? (
                <Button
                  label="Cancel"
                  variant="secondary"
                  compact
                  onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
                />
              ) : null}
            </View>
            <Text variant="display" accessibilityRole="header">
              Pick your primary instance
            </Text>
            <Text tone="fg2">
              The phone listens to this instance first. Add others later in Settings › Listening.
            </Text>
          </View>
        }
        ListEmptyComponent={
          fleet.refreshing ? (
            <View>
              {[0, 1, 2].map((i) => (
                <SkeletonRow key={i} />
              ))}
            </View>
          ) : (
            <Text tone="fg3" style={{ paddingHorizontal: t.space.xl }}>
              This fleet has no agents.
            </Text>
          )
        }
        renderItem={({ item, index }) => {
          const on = picked === item.name;
          return (
            <Pressable
              testID={`primary-${item.name}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, disabled: busy }}
              accessibilityLabel={`${item.name}, ${agentLine(item)}`}
              disabled={busy}
              onPress={() => {
                haptic.select();
                setPicked(item.name);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: t.space.md,
                minHeight: 60,
                marginHorizontal: t.space.lg,
                paddingHorizontal: t.space.lg,
                borderTopWidth: index === 0 ? t.border.row : 0,
                borderBottomWidth: t.border.row,
                borderLeftWidth: t.border.row,
                borderRightWidth: t.border.row,
                borderColor: t.c.line,
                backgroundColor: on ? t.c.sel : pressed ? t.c.bg2 : "transparent",
              })}
            >
              <StatusSquare
                status={item.status ?? undefined}
                color={item.status ? undefined : t.c.fg3}
              />
              <View style={{ flex: 1 }}>
                <Text weight={600}>{item.name}</Text>
                <Text mono variant="caption" tone="fg3">
                  {agentLine(item)}
                </Text>
              </View>
              {/* The single-select mark: a square, filled when picked. */}
              <View
                style={{
                  width: 20,
                  height: 20,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: t.border.control,
                  borderColor: on ? t.c.fg : t.c.line2,
                }}
              >
                {on ? <View style={{ width: 10, height: 10, backgroundColor: t.c.fg }} /> : null}
              </View>
            </Pressable>
          );
        }}
      />
      <View
        style={{
          paddingHorizontal: t.space.xl,
          paddingTop: t.space.md,
          paddingBottom: t.space.md,
          gap: t.space.md,
          borderTopWidth: t.border.row,
          borderTopColor: t.c.line2,
          backgroundColor: t.c.bg,
        }}
      >
        {error ? (
          <View
            accessibilityRole="alert"
            style={{
              borderLeftWidth: t.border.control,
              borderLeftColor: t.c.bad,
              paddingLeft: t.space.md,
              gap: 2,
            }}
          >
            <Text weight={700} tone="bad">
              {error.title}
            </Text>
            <Text variant="bodySmall" tone="fg2">
              {error.detail}
            </Text>
          </View>
        ) : null}
        <Button label="Continue" busy={busy} disabled={!picked} onPress={() => void confirm()} />
      </View>
    </Screen>
  );
}
