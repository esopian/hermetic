/**
 * Settings, behind home's gear: a grouped list of everything admin. Bots (the
 * listened instances), the fleet's agents (each opens its
 * detail and browser), the Tailscale status, notification delivery (push from
 * the boxes, previews, alerts on this phone, quiet hours), appearance and
 * haptics, the paired fleet, re-pairing and signing out, and about. Nothing
 * bridge-shaped: the phone talks to the boxes.
 */
import Constants from "expo-constants";
import { router } from "expo-router";
import { Children, type ReactNode, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { railTime } from "../src/client/chat-logic.ts";
import { minutesOf } from "../src/client/inbox-logic.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState } from "../src/fleet/hooks.ts";
import { isForbidden, type PushStatus } from "../src/fleet/push.ts";
import type { TailscaleStatus } from "../src/gateway/tailscale.ts";
import { usePrefs } from "../src/prefs/prefs.tsx";
import { type SchemePreference, useTheme } from "../src/theme/theme.tsx";
import { statusColor } from "../src/theme/tokens.ts";
import { haptic } from "../src/ui/haptics.ts";
import { Icon, IconButton, Screen, Text, ToggleSwitch } from "../src/ui/index.ts";
import { useNow } from "../src/ui/useNow.ts";

/* ── the grouped list ───────────────────────────────────────────────────── */

const RADIUS = 14;

/** One group: a quiet title, a soft card of rows (inset hairlines between), an optional note. */
function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  const t = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={{ paddingHorizontal: t.space.lg, marginTop: t.space.xl, gap: t.space.sm }}>
      {title ? (
        <Text variant="bodySmall" weight={600} tone="fg3" style={{ paddingHorizontal: t.space.lg }}>
          {title}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: t.c.card,
          borderRadius: RADIUS,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.c.cardEdge,
          overflow: "hidden",
        }}
      >
        {rows.map((row, i) => (
          // Rows are positional and never reorder.
          <View key={i}>
            {/* Only the hairline is inset; the row itself spans the card, so every label lines up. */}
            {i === 0 ? null : (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: t.c.line,
                  marginLeft: t.space.lg,
                }}
              />
            )}
            {row}
          </View>
        ))}
      </View>
      {note ? <View style={{ paddingHorizontal: t.space.lg }}>{note}</View> : null}
    </View>
  );
}

/** A note under a group: small and muted. */
function Note({ children, tone = "fg3" }: { children: ReactNode; tone?: "fg3" | "warn" | "acc" }) {
  return (
    <Text variant="caption" tone={tone}>
      {children}
    </Text>
  );
}

/** A row: a label, an optional value on the right, a chevron when it navigates. */
function Item({
  label,
  value,
  onPress,
  chevron = !!onPress,
  tone = "fg",
  leading,
  mono = false,
  accessibilityLabel,
  testID,
}: {
  label: string;
  value?: string | null;
  onPress?: () => void;
  chevron?: boolean;
  tone?: "fg" | "bad" | "acc";
  leading?: ReactNode;
  mono?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const t = useTheme();
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        minHeight: 48,
        paddingVertical: t.space.sm,
        paddingLeft: t.space.lg,
        paddingRight: t.space.md,
        backgroundColor: pressed ? t.c.sel : "transparent",
      }}
    >
      {leading}
      <Text tone={tone} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Text>
      <View style={{ flex: 1 }} />
      {value ? (
        <Text
          tone="fg3"
          mono={mono}
          variant={mono ? "mono" : "body"}
          numberOfLines={1}
          selectable={!onPress}
          style={{ flexShrink: 1, textAlign: "right" }}
        >
          {value}
        </Text>
      ) : null}
      {chevron ? (
        <View style={{ transform: [{ rotate: "180deg" }] }}>
          <Icon name="back" size={14} color={t.c.fg3} />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (value ? `${label}, ${value}` : label)}
      testID={testID}
      onPress={() => {
        haptic.select();
        onPress();
      }}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
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
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        minHeight: 48,
        paddingVertical: t.space.sm,
        paddingLeft: t.space.lg,
        paddingRight: t.space.md,
      }}
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

/** A soft segmented choice (appearance, the fixture's Tailscale). */
function Segments<T extends string>({
  options,
  value,
  label,
  onChange,
}: {
  options: readonly T[];
  value: T | null;
  label: (option: T) => string;
  onChange(option: T): void;
}) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: "row",
        margin: t.space.sm,
        padding: 3,
        borderRadius: RADIUS - 4,
        backgroundColor: t.c.bg3,
      }}
    >
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o}
            accessibilityRole="radio"
            accessibilityLabel={label(o)}
            accessibilityState={{ checked: on }}
            onPress={() => {
              haptic.select();
              onChange(o);
            }}
            style={{
              flex: 1,
              minHeight: 38,
              borderRadius: RADIUS - 6,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: on ? t.c.bg : "transparent",
            }}
          >
            <Text variant="bodySmall" weight={on ? 700 : 500} tone={on ? "fg" : "fg2"}>
              {o.charAt(0).toUpperCase() + o.slice(1)}
            </Text>
          </Pressable>
        );
      })}
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
          borderRadius: RADIUS - 6,
          borderWidth: bad ? 1 : 0,
          borderColor: t.c.bad,
          backgroundColor: t.c.bg3,
          color: t.c.fg,
          fontFamily: t.mono(400),
          fontSize: 16,
          paddingHorizontal: t.space.md,
        }}
      />
    </View>
  );
}

/** A round status dot for a row's leading edge. */
function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

/* ── words ──────────────────────────────────────────────────────────────── */

/** The Tailscale probe's answer, worded as the heuristic it is. */
const TAILSCALE_WORDS: Record<TailscaleStatus, string> = {
  ok: "Looks connected",
  off: "Off or not signed in",
  unreachable: "On the tailnet, no box answers",
  unknown: "Not checked",
};

/** What Settings says about push. */
export function pushLine(push: PushStatus, wanted: boolean): string {
  if (push.state === "on") {
    const failed = push.boxes.filter((b) => !b.ok);
    const n = push.boxes.length;
    if (n === 0) return "Push is on; no listened agent to register with.";
    if (failed.length === 0) return `Registered with ${n} agent${n === 1 ? "" : "s"}.`;
    // A 403 is the box's whois gate refusing this login (transient, or a tagged node).
    const names = failed.map((b) =>
      isForbidden(b) ? `${b.instance} (refused this login)` : b.instance,
    );
    return `Registered with ${n - failed.length} of ${n}; not with ${names.join(", ")}.`;
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
const SCHEMES: readonly SchemePreference[] = ["system", "dark", "light"];

/* ── the screen ─────────────────────────────────────────────────────────── */

export default function Settings() {
  const t = useTheme();
  const ctx = useFleetContext();
  const { tailscale, probing, previews, push, pushWanted, fixture } = ctx;
  const fleet = useFleetState();
  const agents = useFleetAgents();
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
      "This phone forgets the pairing and what it has been told, and asks the agents it listens to to stop pushing to it. To cut a phone off for good, remove it from the tailnet.",
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

  const tailscaleColor =
    status === "ok"
      ? t.c.ok
      : status === "off"
        ? t.c.bad
        : status === "unreachable"
          ? t.c.warn
          : t.c.fg3;

  return (
    <Screen>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: t.space.sm,
          paddingHorizontal: t.space.lg,
          paddingTop: t.space.sm,
          paddingBottom: t.space.xs,
        }}
      >
        <IconButton icon="back" label="Back" onPress={() => router.back()} />
        <Text variant="title" weight={700} style={{ flex: 1, textAlign: "center" }}>
          Settings
        </Text>
        {/* Balances the back button so the title sits centred. */}
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl * 2 }}>
        <Group
          title="Bots"
          note={<Note>Listened instances show their bots on home and raise notifications.</Note>}
        >
          <Item
            label="Listening"
            value={
              listening.length === 0
                ? "None"
                : `${listening.length} instance${listening.length === 1 ? "" : "s"}`
            }
            onPress={() => router.push("/listening")}
          />
        </Group>

        <Group title="Agents">
          {agents.length === 0 ? (
            <Item label="No agents in this fleet" />
          ) : (
            agents.map((a) => (
              <Item
                key={a.name}
                label={a.name}
                value={a.status ?? "unknown"}
                leading={<Dot color={a.status ? statusColor(t.c, a.status).color : t.c.fg3} />}
                accessibilityLabel={`Open ${a.name}, ${a.status ?? "status unknown"}`}
                onPress={() => router.push(`/agent/${encodeURIComponent(a.name)}`)}
              />
            ))
          )}
        </Group>

        <Group
          title="Tailscale"
          note={
            <View style={{ gap: t.space.xs }}>
              {tailscale && tailscale.failing.length > 0 && status === "ok" ? (
                <Note tone="warn">{`Did not answer: ${tailscale.failing.join(", ")}`}</Note>
              ) : null}
              <Note>
                A guess from asking up to three listened agents: iOS does not let an app ask the
                Tailscale app directly.
              </Note>
            </View>
          }
        >
          <Item
            label={status ? TAILSCALE_WORDS[status] : "Checking…"}
            leading={<Dot color={tailscaleColor} />}
          />
          <Item
            label={probing ? "Checking…" : "Check again"}
            tone="acc"
            chevron={false}
            onPress={() => void ctx.probeTailscale()}
          />
          {fixture ? (
            <View style={{ paddingTop: t.space.sm }}>
              <Text variant="caption" tone="acc" style={{ paddingHorizontal: t.space.lg }}>
                Fixture build: pick what the probe sees.
              </Text>
              <Segments
                options={FIXTURE_TAILSCALE}
                value={fixture.tailscale.get()}
                label={(s) => `Fixture Tailscale ${s}`}
                onChange={(s) => fixture.setTailscale(s)}
              />
            </View>
          ) : null}
        </Group>

        <Group
          title="Notifications"
          note={
            <Note tone={push.state === "unavailable" ? "warn" : "fg3"}>
              {pushLine(push, pushWanted)}
            </Note>
          }
        >
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
            hint="No alerts from this phone's own connections in this window; unread still shows on home. Pushes from the agents still arrive: silence them with iOS Focus, or turn push off."
            value={prefs.quiet.enabled}
            onChange={(v) => update({ quiet: { ...prefs.quiet, enabled: v } })}
          />
          {prefs.quiet.enabled ? (
            <View
              style={{
                flexDirection: "row",
                gap: t.space.md,
                paddingHorizontal: t.space.lg,
                paddingVertical: t.space.md,
              }}
            >
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
        </Group>

        <Group title="Appearance">
          <Segments
            options={SCHEMES}
            value={t.preference}
            label={(p) => p}
            onChange={(p) => t.setPreference(p)}
          />
          <Toggle label="Haptics" value={prefs.haptics} onChange={(v) => update({ haptics: v })} />
        </Group>

        <Group
          title="Fleet"
          note={
            fleet.fromBoxes || fleet.error ? (
              <View style={{ gap: t.space.xs }}>
                {fleet.fromBoxes ? (
                  <Text variant="caption" tone="warn" testID="fleet-view-source">
                    {fleetViewLine(fleet.error?.code ?? null)}
                  </Text>
                ) : null}
                {fleet.error ? <Note tone="warn">{fleet.error.message}</Note> : null}
              </View>
            ) : null
          }
        >
          <Item
            label="Fleet"
            mono
            value={
              link
                ? link.payload.alias && link.payload.alias !== link.payload.fleet_id
                  ? `${link.label} · ${link.payload.fleet_id}`
                  : link.payload.fleet_id
                : null
            }
          />
          <Item label="Tailnet" mono value={link?.payload.tailnet} />
          <Item
            label="Region"
            mono
            value={link ? `${link.payload.region} · ${link.payload.account_id}` : null}
          />
          <Item
            label="Fleet list"
            value={
              fleet.refreshed_at
                ? `read ${railTime(fleet.refreshed_at, now)}${fleet.stale ? " · from pairing" : ""}`
                : "not read yet"
            }
          />
        </Group>

        <Group
          title="This phone"
          note={
            <Note>
              Signing out forgets the pairing on this phone. Nothing on the laptop or the boxes changes
              beyond this phone's push registration.
            </Note>
          }
        >
          <Item label="Re-pair (scan again)" onPress={() => router.push("/pair")} />
          <Item label="Sign out" tone="bad" chevron={false} onPress={signOut} />
        </Group>

        <Group
          title="About"
          note={
            <Note>
              A remote head for a Hermetic fleet. It talks to the agents directly over your tailnet:
              chat with each box's Hermes gateway, the fleet list and push registration with hermeticd,
              and the agent browser from the box.
            </Note>
          }
        >
          <Item
            label="Version"
            value={`Hermetic ${Constants.expoConfig?.version ?? "0.0.0"}${fixture ? " · fixture" : ""}`}
          />
        </Group>
      </ScrollView>
    </Screen>
  );
}
