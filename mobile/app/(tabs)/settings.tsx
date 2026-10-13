/**
 * Settings: the paired fleet and its tailnet, the Tailscale status, listened
 * instances, notification delivery (push from the boxes, previews, alerts on
 * this phone, quiet hours), the inbox, appearance, haptics, re-pairing and
 * signing out, and about. Nothing bridge-shaped: the phone talks to the boxes.
 */
import Constants from "expo-constants";
import { router } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { railTime } from "../../src/client/chat-logic.ts";
import { minutesOf } from "../../src/client/inbox-logic.ts";
import { useFleetContext } from "../../src/fleet/FleetProvider.tsx";
import { useFleetState, useInbox } from "../../src/fleet/hooks.ts";
import type { PushStatus } from "../../src/fleet/push.ts";
import type { TailscaleStatus } from "../../src/gateway/tailscale.ts";
import { INBOX_LIMIT } from "../../src/inbox/store.ts";
import { usePrefs } from "../../src/prefs/prefs.tsx";
import { type SchemePreference, useTheme } from "../../src/theme/theme.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { Button, Kicker, Screen, StatusSquare, Text, ToggleSwitch } from "../../src/ui/index.ts";
import { useNow } from "../../src/ui/useNow.ts";

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

/** The Tailscale probe's answer, worded as the heuristic it is. */
const TAILSCALE_WORDS: Record<TailscaleStatus, string> = {
  ok: "Tailscale looks connected",
  off: "Tailscale is off or not signed in",
  unreachable: "On the tailnet, but no box answers",
  unknown: "Not checked: no listened agent to ask",
};

/** What Settings says about push. */
export function pushLine(push: PushStatus, wanted: boolean): string {
  if (push.state === "on") {
    const failed = push.boxes.filter((b) => !b.ok);
    const n = push.boxes.length;
    if (n === 0) return "Push is on; no listened agent to register with.";
    if (failed.length === 0) return `Registered with ${n} agent${n === 1 ? "" : "s"}.`;
    return `Registered with ${n - failed.length} of ${n}; not with ${failed.map((b) => b.instance).join(", ")}.`;
  }
  if (push.state === "unavailable") {
    if (push.reason === "simulator") return "Push needs a real device.";
    if (push.reason === "denied") return "Notifications are off for Hermetic in iOS Settings.";
    if (push.reason === "no-project-id")
      return "This build has no EAS project id: alerts arrive only while the app holds its connections.";
    return `Push failed: ${push.message ?? "unknown error"}`;
  }
  return wanted ? "Registering…" : "Off: alerts arrive only while the app holds its connections.";
}

/**
 * What Settings says when no box served `/fleet` and each box's own `/healthz`
 * stands in (`FleetStore`'s fallback). `FLEET_LIST_UNAVAILABLE` is a fleet
 * whose foundation predates the agents' table scan.
 */
export function fleetViewLine(code: string | null): string {
  return code === "FLEET_LIST_UNAVAILABLE"
    ? "Fleet view: from boxes (foundation update pending)"
    : "Fleet view: from boxes (no box answered /fleet)";
}

const FIXTURE_TAILSCALE = ["ok", "off", "unreachable"] as const;

export default function Settings() {
  const t = useTheme();
  const ctx = useFleetContext();
  const { tailscale, probing, previews, push, pushWanted, fixture } = ctx;
  const fleet = useFleetState();
  const inbox = useInbox();
  const { prefs, update } = usePrefs();
  const now = useNow();
  const [pushBusy, setPushBusy] = useState(false);
  const link = fleet.link;
  const listening = ctx.fleet.listened();
  const status = tailscale?.status ?? null;

  const signOut = () => {
    haptic.warning();
    Alert.alert(
      "Sign out of this fleet?",
      "This phone forgets the pairing and its inbox, and asks the agents it listens to to stop pushing to it. To cut a phone off for good, remove it from the tailnet.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void ctx.signOut().then(() => router.replace("/pair"));
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
          <Kicker>{link?.label ?? ""}</Kicker>
          <Text variant="display">Settings</Text>
        </View>

        <Section title="Fleet">
          <Row
            label="Fleet"
            value={
              link
                ? link.payload.alias && link.payload.alias !== link.payload.fleet_id
                  ? `${link.label} · ${link.payload.fleet_id}`
                  : link.payload.fleet_id
                : null
            }
          />
          <Row label="Tailnet" value={link?.payload.tailnet} />
          <Row
            label="Region"
            value={link ? `${link.payload.region} · ${link.payload.account_id}` : null}
          />
          <Row
            label="Agents"
            value={`${ctx.fleet.agents().length}${fleet.stale ? " · list from pairing" : ""}`}
          />
          <Row
            label="Fleet list"
            value={fleet.refreshed_at ? `read ${railTime(fleet.refreshed_at, now)}` : "not read yet"}
          />
          {fleet.fromBoxes ? (
            <Text variant="caption" tone="warn" testID="fleet-view-source">
              {fleetViewLine(fleet.error?.code ?? null)}
            </Text>
          ) : null}
          {fleet.error ? (
            <Text variant="caption" tone="warn">
              {fleet.error.message}
            </Text>
          ) : null}
        </Section>

        <Section title="Tailscale">
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
            <StatusSquare
              size={10}
              color={
                status === "ok"
                  ? t.c.ok
                  : status === "off"
                    ? t.c.bad
                    : status === "unreachable"
                      ? t.c.warn
                      : t.c.fg3
              }
              pulse={probing}
            />
            <Text weight={700} style={{ flex: 1 }}>
              {status ? TAILSCALE_WORDS[status] : "Checking…"}
            </Text>
            <Button
              label="Check again"
              variant="secondary"
              compact
              busy={probing}
              onPress={() => void ctx.probeTailscale()}
            />
          </View>
          {tailscale && tailscale.failing.length > 0 && status === "ok" ? (
            <Text variant="caption" tone="warn">
              {`Did not answer: ${tailscale.failing.join(", ")}`}
            </Text>
          ) : null}
          <Text variant="caption" tone="fg3">
            A guess from asking up to three listened agents: iOS does not let an app ask the Tailscale
            app directly.
          </Text>
          {fixture ? (
            <View style={{ gap: t.space.xs }}>
              <Text variant="caption" tone="acc">
                Fixture build: pick what the probe sees.
              </Text>
              <View accessibilityRole="radiogroup" style={{ flexDirection: "row" }}>
                {FIXTURE_TAILSCALE.map((s, i) => {
                  const on = fixture.tailscale.get() === s;
                  return (
                    <Pressable
                      key={s}
                      accessibilityRole="radio"
                      accessibilityLabel={`Fixture Tailscale ${s}`}
                      accessibilityState={{ checked: on }}
                      onPress={() => {
                        haptic.select();
                        fixture.setTailscale(s);
                      }}
                      style={{
                        flex: 1,
                        height: t.touch.min,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: t.border.control,
                        borderColor: t.c.fg,
                        marginLeft: i === 0 ? 0 : -t.border.control,
                        backgroundColor: on ? t.c.fg : "transparent",
                      }}
                    >
                      <Text
                        variant="caption"
                        weight={800}
                        uppercase
                        style={{ color: on ? t.c.bg : t.c.fg, letterSpacing: 1 }}
                      >
                        {s}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
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
            label="Push from the agents"
            hint="Each listened agent sends turn-finished, failed, needs-you and new-message pushes to this phone."
            value={pushWanted}
            disabled={pushBusy}
            onChange={(v) => {
              setPushBusy(true);
              void ctx
                .setPushEnabled(v)
                .then((r) => (r.state === "unavailable" ? haptic.warning() : haptic.success()))
                .finally(() => setPushBusy(false));
            }}
          />
          <Text variant="caption" tone={push.state === "unavailable" ? "warn" : "fg3"}>
            {pushLine(push, pushWanted)}
          </Text>
          <Toggle
            label="Alerts on this phone"
            hint="Banners and notifications for what this phone sees on its own connections."
            value={prefs.notifications}
            onChange={(v) => update({ notifications: v })}
          />
          <Toggle
            label="Show message previews"
            hint="On: notifications quote the reply or question, and the agents' pushes carry that text through Apple's and Expo's push services. Off: they say “Reply ready” or “Needs you” and nothing more."
            value={previews}
            onChange={(v) => void ctx.setPreviews(v)}
          />
          <Toggle
            label="Quiet hours"
            hint="No alerts from this phone's own connections in this window; the inbox still fills. Pushes from the agents still arrive: silence them with iOS Focus, or turn push off."
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
        </Section>

        <Section title="Inbox">
          <Row
            label="Kept"
            value={`${inbox?.entries.length ?? 0} of ${INBOX_LIMIT} · ${inbox?.unread ?? 0} unread`}
          />
          <Text variant="caption" tone="fg3">
            The inbox lives on this phone only: pushes it received and events its own connections saw.
          </Text>
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
          <Button
            label="Re-pair (scan again)"
            variant="secondary"
            onPress={() => router.push("/pair")}
          />
          <Button label="Sign out" variant="destructive" onPress={signOut} />
          <Text variant="caption" tone="fg3">
            Signing out forgets the pairing on this phone. Nothing on the laptop or the boxes changes
            beyond this phone's push registration.
          </Text>
        </Section>

        <Section title="About">
          <Row
            label="App"
            value={`Hermetic ${Constants.expoConfig?.version ?? "0.0.0"}${fixture ? " · fixture" : ""}`}
            mono={false}
          />
          <Text variant="caption" tone="fg3">
            A remote head for a Hermetic fleet. It talks to the agents directly over your tailnet: chat
            with each box's Hermes gateway, the fleet list and push registration with hermeticd, and the
            agent browser from the box.
          </Text>
        </Section>
      </ScrollView>
    </Screen>
  );
}
