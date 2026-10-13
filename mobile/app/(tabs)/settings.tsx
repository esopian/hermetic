/**
 * Settings: the bridge and this device, the connection, listened instances,
 * notification delivery (push, previews, local alerts, quiet hours),
 * appearance, haptics, signing out, and about.
 */
import Constants from "expo-constants";
import { router } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { useBridge } from "../../src/bridge/BridgeProvider.tsx";
import { useRoster } from "../../src/bridge/hooks.ts";
import { easProjectId } from "../../src/bridge/notifications.ts";
import { minutesOf } from "../../src/client/inbox-logic.ts";
import { usePrefs } from "../../src/prefs/prefs.tsx";
import { MOBILE_PROTOCOL } from "../../src/protocol/constants.ts";
import { type SchemePreference, useTheme } from "../../src/theme/theme.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { Button, Kicker, Screen, StatusSquare, Text, ToggleSwitch } from "../../src/ui/index.ts";

function Section({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: t.space.lg,
        paddingVertical: t.space.lg,
        gap: t.space.md,
        borderBottomWidth: 1,
        borderBottomColor: t.c.line,
      }}
    >
      <Kicker>{title}</Kicker>
      {children}
    </View>
  );
}

function Row({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: t.space.md }}>
      <Text variant="bodySmall" tone="fg3" style={{ width: 92 }}>
        {label}
      </Text>
      <Text variant="bodySmall" mono={mono} selectable style={{ flex: 1 }} numberOfLines={2}>
        {value || "—"}
      </Text>
    </View>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: t.space.md, minHeight: t.touch.min }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text>{label}</Text>
        {hint ? (
          <Text variant="caption" tone="fg3">
            {hint}
          </Text>
        ) : null}
      </View>
      <ToggleSwitch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          haptic.select();
          onChange(v);
        }}
      />
    </View>
  );
}

function TimeField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit(v: string): void;
}) {
  const t = useTheme();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const bad = minutesOf(text) === null;
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text variant="caption" tone="fg3">
        {label}
      </Text>
      <TextInput
        keyboardAppearance={t.scheme}
        accessibilityLabel={`Quiet hours ${label}`}
        selectionColor={t.c.acc}
        cursorColor={t.c.acc}
        value={text}
        onChangeText={setText}
        onEndEditing={() => (bad ? setText(value) : onCommit(text.trim()))}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        style={{
          height: t.touch.min,
          borderWidth: t.border.control,
          borderColor: bad ? t.c.bad : t.c.line2,
          color: t.c.fg,
          fontFamily: t.mono(400),
          fontSize: 16,
          paddingHorizontal: t.space.md,
          borderRadius: 0,
        }}
      />
    </View>
  );
}

const SOCKET_WORDS: Record<string, string> = {
  idle: "not connected",
  connecting: "connecting…",
  authenticating: "authenticating…",
  open: "connected",
  reconnecting: "reconnecting…",
  unavailable: "laptop bridge unavailable — retrying",
  unauthorized: "refused — this phone was revoked or needs to pair again",
  mismatch: "protocol mismatch — update the app or the bridge",
  wrong_fleet: "the bridge serves another fleet now — re-pair",
};

export default function Settings() {
  const t = useTheme();
  const bridge = useBridge();
  const { credentials, socketState, hello, previews, push } = bridge;
  const { state } = useRoster();
  const { prefs, update } = usePrefs();
  const [pushBusy, setPushBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const live = socketState === "open";
  const fatal =
    socketState === "unauthorized" || socketState === "mismatch" || socketState === "wrong_fleet";
  const listening = state?.listening ?? [];

  const signOut = () => {
    haptic.warning();
    Alert.alert(
      "Sign out of this bridge?",
      "This phone forgets its token. Nothing on the laptop changes; run “hermetic mobile revoke” there if you want the device gone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void bridge.signOut().then(() => router.replace("/pair"));
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl }}>
        <View
          style={{ paddingHorizontal: t.space.lg, paddingTop: t.space.md, paddingBottom: t.space.sm }}
        >
          <Kicker>{credentials?.fleet.alias ?? credentials?.fleet.fleet_id ?? ""}</Kicker>
          <Text variant="display">Settings</Text>
        </View>

        <Section title="Bridge">
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
            <StatusSquare
              size={10}
              color={live ? t.c.ok : fatal ? t.c.bad : t.c.warn}
              pulse={!live && !fatal}
            />
            <Text weight={700} style={{ flex: 1 }}>
              {SOCKET_WORDS[socketState] ?? socketState}
            </Text>
            {socketState === "wrong_fleet" ? (
              <Button
                label="Re-pair"
                variant="secondary"
                compact
                onPress={() => void bridge.rePair()}
              />
            ) : null}
            <Button label="Reconnect" variant="secondary" compact onPress={bridge.reconnect} />
          </View>
          <Row label="Host" value={credentials?.baseUrl} />
          <Row
            label="Fleet"
            value={
              credentials ? `${credentials.fleet.alias ?? "—"} · ${credentials.fleet.fleet_id}` : null
            }
          />
          <Row
            label="Region"
            value={credentials ? `${credentials.fleet.region} · ${credentials.fleet.account_id}` : null}
          />
          <Row label="Device" value={hello?.device.name ?? credentials?.device_id} mono={!hello} />
          <Row
            label="Served by"
            value={
              hello
                ? `${hello.host.app} ${hello.host.version}${hello.host.fixture ? " · fixture" : ""}`
                : null
            }
          />
          <Row label="Protocol" value={String(hello?.protocol ?? MOBILE_PROTOCOL.PROTOCOL_VERSION)} />
          <Row label="Tailnet" value={credentials?.tailnet ?? null} />
        </Section>

        <Section title="Listening">
          <Text variant="bodySmall" tone="fg2">
            {listening.length === 0 ? "No instance is listened to." : listening.join(", ")}
          </Text>
          <Button
            label="Choose instances"
            variant="secondary"
            onPress={() => router.push("/listening")}
          />
        </Section>

        <Section title="Notifications">
          <Toggle
            label="Notifications"
            hint="Turn-finished, needs-you and inbox alerts, here and as push."
            value={prefs.notifications}
            onChange={(v) => {
              update({ notifications: v });
              void bridge.setPushEnabled(v).then((ok) => {
                if (!ok) setNote("The bridge did not take the change; it applies on this phone only.");
              });
            }}
          />
          <Toggle
            label="Show message previews"
            hint="Off: alerts say “Reply ready” or “Needs you” and nothing more."
            value={previews}
            onChange={(v) => void bridge.setPreviews(v)}
          />
          <Toggle
            label="Quiet hours"
            hint="No alerts on this phone in this window. The inbox still fills."
            value={prefs.quiet.enabled}
            onChange={(v) => update({ quiet: { ...prefs.quiet, enabled: v } })}
          />
          {prefs.quiet.enabled ? (
            <View style={{ flexDirection: "row", gap: t.space.md }}>
              <TimeField
                label="from"
                value={prefs.quiet.start}
                onCommit={(v) => update({ quiet: { ...prefs.quiet, start: v } })}
              />
              <TimeField
                label="until"
                value={prefs.quiet.end}
                onCommit={(v) => update({ quiet: { ...prefs.quiet, end: v } })}
              />
            </View>
          ) : null}
          <Button
            label={push?.ok ? "Push registered" : "Enable push"}
            variant="secondary"
            busy={pushBusy}
            disabled={!!push?.ok}
            onPress={() => {
              setPushBusy(true);
              void bridge
                .enablePush()
                .then((r) => (r?.ok ? haptic.success() : haptic.warning()))
                .finally(() => setPushBusy(false));
            }}
          />
          <Text variant="caption" tone="fg3">
            {push === null
              ? easProjectId()
                ? "Push is not registered yet."
                : "This build has no EAS project id: alerts arrive only while the app holds its connection."
              : push.ok
                ? "Push registered with the bridge."
                : push.reason === "simulator"
                  ? "Push needs a real device."
                  : push.reason === "denied"
                    ? "Notifications are off for Hermetic in iOS Settings."
                    : push.reason === "no-project-id"
                      ? "This build has no EAS project id."
                      : `Push failed: ${push.message ?? "unknown error"}`}
          </Text>
          {note ? (
            <Text variant="caption" tone="warn">
              {note}
            </Text>
          ) : null}
        </Section>

        <Section title="Appearance">
          <View accessibilityRole="radiogroup" style={{ flexDirection: "row" }}>
            {(["system", "dark", "light"] as SchemePreference[]).map((p) => {
              const on = t.preference === p;
              return (
                <Pressable
                  key={p}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => {
                    haptic.select();
                    t.setPreference(p);
                  }}
                  style={{
                    flex: 1,
                    height: t.touch.min,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: t.border.control,
                    borderColor: t.c.fg,
                    marginLeft: p === "system" ? 0 : -t.border.control,
                    backgroundColor: on ? t.c.fg : "transparent",
                  }}
                >
                  <Text
                    variant="caption"
                    weight={800}
                    uppercase
                    style={{ color: on ? t.c.bg : t.c.fg, letterSpacing: 1 }}
                  >
                    {p}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Toggle label="Haptics" value={prefs.haptics} onChange={(v) => update({ haptics: v })} />
        </Section>

        <Section title="This phone">
          <Button label="Sign out of this bridge" variant="destructive" onPress={signOut} />
          <Text variant="caption" tone="fg3">
            Signing out forgets the token on this phone only.
          </Text>
        </Section>

        <Section title="About">
          <Row
            label="App"
            value={`Hermetic ${Constants.expoConfig?.version ?? "0.0.0"}`}
            mono={false}
          />
          <Row label="Protocol" value={String(MOBILE_PROTOCOL.PROTOCOL_VERSION)} />
          <Text variant="caption" tone="fg3">
            A remote head for a Hermetic fleet. It talks only to the bridge on your laptop; the agent
            browser is loaded straight from the box over the tailnet.
          </Text>
        </Section>
      </ScrollView>
    </Screen>
  );
}
