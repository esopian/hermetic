/**
 * Settings, behind home's gear: a grouped list of everything admin. First the
 * fleet in front (its row opens the Fleets switcher), then Bots (the listened
 * instances), the fleet's agents (each opens its detail and browser), the
 * Tailscale status, notification delivery (push from the boxes, previews,
 * alerts on this phone, quiet hours), appearance (theme and avatar style) and
 * haptics, re-pairing and signing out, and about. Nothing
 * bridge-shaped: the phone talks to the boxes.
 *
 * `/settings?section=<id>` opens it scrolled to one group, the id being the
 * group's title kebab-cased (`fleet`, `bots`, `agents`, `tailscale`, `notifications`,
 * `appearance`, `this-phone`, `about`, `support`); an unknown id
 * leaves it at the top.
 */
import { AVATAR_STYLES, type AvatarStyle } from "@hermetic/core/shared";
import Constants from "expo-constants";
import { router, useLocalSearchParams } from "expo-router";
import {
  Children,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { railTime } from "../src/client/chat-logic.ts";
import { minutesOf } from "../src/client/inbox-logic.ts";
import { useFleetContext } from "../src/fleet/FleetProvider.tsx";
import { useFleetAgents, useFleetState } from "../src/fleet/hooks.ts";
import { isForbidden, type PushStatus } from "../src/fleet/push.ts";
import type { TailscaleStatus, TunnelState } from "../src/gateway/tailscale.ts";
import { usePrefs } from "../src/prefs/prefs.tsx";
import { supportReport } from "../src/support/diagnostics.ts";
import { type SchemePreference, useTheme } from "../src/theme/theme.tsx";
import { statusColor } from "../src/theme/tokens.ts";
import { haptic } from "../src/ui/haptics.ts";
import { Avatar, Icon, IconButton, Kicker, Screen, Text, ToggleSwitch } from "../src/ui/index.ts";
import { useNow } from "../src/ui/useNow.ts";

/* ── the grouped list ───────────────────────────────────────────────────── */

/**
 * A group's anchor for `/settings?section=<id>`: its title, kebab-cased
 * ("This phone" is `this-phone`). Pure, so it is testable.
 */
export function sectionId(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Told each titled group's y in the scroll content, so the screen can open at one. */
const SectionLayout = createContext<((id: string, y: number) => void) | null>(null);

/** One group: a kicker title, a square bordered card of rows (1px rules between), an optional note. */
function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  const t = useTheme();
  const onSection = useContext(SectionLayout);
  const rows = Children.toArray(children).filter(Boolean);
  const id = title ? sectionId(title) : null;
  return (
    <View
      testID={id ? `settings-section-${id}` : undefined}
      onLayout={id && onSection ? (e) => onSection(id, e.nativeEvent.layout.y) : undefined}
      style={{ paddingHorizontal: t.space.lg, marginTop: t.space.xl, gap: t.space.sm }}
    >
      {title ? <Kicker style={{ paddingHorizontal: t.space.xs }}>{title}</Kicker> : null}
      <View
        style={{
          backgroundColor: t.c.card,
          borderWidth: t.border.row,
          borderColor: t.c.cardEdge,
          overflow: "hidden",
        }}
      >
        {rows.map((row, i) => (
          // Rows are positional and never reorder.
          <View key={i}>
            {/* A full-width 1px rule between rows, the desktop's row border. */}
            {i === 0 ? null : <View style={{ height: t.border.row, backgroundColor: t.c.line }} />}
            {row}
          </View>
        ))}
      </View>
      {note ? <View style={{ paddingHorizontal: t.space.xs }}>{note}</View> : null}
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
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.5;
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "flex-start" : "center",
        gap: t.space.md,
        minHeight: 48,
        paddingVertical: t.space.sm,
        paddingLeft: t.space.lg,
        paddingRight: t.space.md,
        backgroundColor: pressed ? t.c.sel : "transparent",
      }}
    >
      {leading}
      <Text tone={tone} style={{ flexShrink: 1 }}>
        {label}
      </Text>
      {!stacked ? <View style={{ flex: 1 }} /> : null}
      {value ? (
        <Text
          tone="fg3"
          mono={mono}
          variant={mono ? "mono" : "body"}
          selectable={!onPress}
          style={{ flexShrink: 1, textAlign: stacked ? "left" : "right" }}
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
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.5;
  return (
    <View
      style={{
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "flex-start" : "center",
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

/** A segmented choice like the desktop's `.switch` (appearance, the fixture's Tailscale). */
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
  const { fontScale } = useWindowDimensions();
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: fontScale >= 1.5 ? "column" : "row",
        margin: t.space.sm,
        borderWidth: t.border.control,
        borderColor: t.c.fg,
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
              flex: fontScale >= 1.5 ? undefined : 1,
              minHeight: t.touch.min,
              paddingVertical: t.space.sm,
              paddingHorizontal: t.space.sm,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: on ? t.c.fg : "transparent",
            }}
          >
            <Text
              variant="caption"
              weight={800}
              uppercase
              style={{ color: on ? t.c.bg : t.c.fg2, letterSpacing: 0.5 }}
            >
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
      <Kicker>{label}</Kicker>
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
          minHeight: t.touch.min,
          paddingVertical: t.space.sm,
          borderWidth: t.border.row,
          borderColor: bad ? t.c.bad : t.c.line2,
          backgroundColor: t.c.bg,
          color: t.c.fg,
          fontFamily: t.mono(400),
          fontSize: 16,
          paddingHorizontal: t.space.md,
        }}
      />
    </View>
  );
}

const AVATAR_STYLE_WORDS: Record<AvatarStyle, string> = {
  sigil: "Sigil",
  pixel: "Pixel",
  blob: "Blob",
};

/**
 * The avatar style: one square cell per style, each showing the same face in
 * that style, so the choice is made by looking. Square on purpose; the blob
 * inside is the only curve.
 */
function AvatarStyles({ value, onChange }: { value: AvatarStyle; onChange(style: AvatarStyle): void }) {
  const t = useTheme();
  return (
    <View style={{ paddingVertical: t.space.sm, paddingHorizontal: t.space.lg, gap: t.space.sm }}>
      <Text>Avatar style</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Avatar style"
        style={{ flexDirection: "row", gap: t.space.sm }}
      >
        {AVATAR_STYLES.map((style) => {
          const on = style === value;
          return (
            <Pressable
              key={style}
              testID={`avatar-style-${style}`}
              accessibilityRole="radio"
              accessibilityLabel={`${AVATAR_STYLE_WORDS[style]} avatar style`}
              accessibilityState={{ checked: on }}
              onPress={() => {
                haptic.select();
                onChange(style);
              }}
              style={({ pressed }) => ({
                flex: 1,
                aspectRatio: 1,
                minHeight: t.touch.min,
                alignItems: "center",
                justifyContent: "center",
                gap: t.space.xs,
                borderWidth: on ? t.border.control : t.border.row,
                borderColor: on ? t.c.fg : t.c.line,
                backgroundColor: pressed ? t.c.sel : on ? t.c.bg : t.c.bg3,
              })}
            >
              <Avatar fleet_id="preview" instance="hermetic" bot="" size={40} avatarStyle={style} />
              <Text variant="bodySmall" weight={on ? 700 : 500} tone={on ? "fg" : "fg2"}>
                {AVATAR_STYLE_WORDS[style]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A status square for a row's leading edge. */
function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, backgroundColor: color }} />;
}

/* ── words ──────────────────────────────────────────────────────────────── */

/** The Tailscale probe's answer, worded as the heuristic it is. */
const TAILSCALE_WORDS: Record<TailscaleStatus, string> = {
  ok: "Looks connected",
  off: "Off or not signed in",
  unreachable: "On the tailnet, no box answers",
  unknown: "Not checked",
};

/** The Tailscale client's own answer (`probeTunnel`), as a line under the guess. */
const TUNNEL_WORDS: Record<TunnelState, string> = {
  connected: "Tailscale on this phone: connected",
  no_netmap: "Tailscale on this phone: running, not connected yet",
  down: "Tailscale on this phone: not answering",
  unknown: "Tailscale on this phone: did not say",
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

const FIXTURE_TAILSCALE = ["ok", "off", "unreachable", "waking"] as const;
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
  // `?section=<id>` opens the screen at that group, once; an unknown id leaves it at the top.
  const { section } = useLocalSearchParams<{ section?: string }>();
  const scroll = useRef<ScrollView>(null);
  const anchored = useRef(false);
  const onSection = useCallback(
    (id: string, y: number) => {
      if (anchored.current || !section || id !== section) return;
      anchored.current = true;
      scroll.current?.scrollTo({ y, animated: false });
    },
    [section],
  );
  const link = fleet.link;
  const listening = ctx.fleet.listened();
  const status = tailscale?.status ?? null;

  const shareDiagnostics = () => {
    const report = supportReport({
      version: Constants.expoConfig?.version ?? "unknown",
      build: Constants.nativeBuildVersion ?? "unknown",
      osVersion: String(Platform.Version),
      fixture: !!fixture,
      paired: !!link,
      tailnetStatus: status,
      fleetStale: fleet.stale,
      fleetErrorCode: fleet.error?.code ?? null,
      listeningCount: listening.length,
      pushState: push.state,
      pushRegistered: push.state === "on" ? push.boxes.filter((box) => box.ok).length : 0,
      pushFailed: push.state === "on" ? push.boxes.filter((box) => !box.ok).length : 0,
    });
    Alert.alert("Support report", report, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Share…",
        onPress: () => {
          void Share.share({ message: report, title: "Hermetic support report" }).catch(() => {
            Alert.alert("Could not share", "Please try sharing the support report again.");
          });
        },
      },
    ]);
  };

  const signOut = () => {
    haptic.warning();
    Alert.alert(
      "Sign out of this fleet?",
      "This phone forgets this fleet's pairing and what it has been told, and asks the agents it listens to to stop pushing to it. Any other paired fleet stays. To cut a phone off for good, remove it from the tailnet.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            // The app remounts at its entry route: the next fleet's home, or Pair when none is left.
            void ctx.signOut();
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
      <SectionLayout.Provider value={onSection}>
        <ScrollView ref={scroll} contentContainerStyle={{ paddingBottom: t.space.xxl * 2 }}>
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
            {/* The fleet switcher: every paired fleet, and "Add a fleet". */}
            <Item
              label="Fleet"
              mono
              testID="settings-fleet"
              accessibilityLabel={`Fleet: ${link?.label ?? "none"}. Switch or add a fleet`}
              onPress={() => router.push("/fleets")}
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
            title="Bots"
            note={
              <Note>
                Listened instances show their bots on home and raise notifications. Home is built around
                the primary instance.
              </Note>
            }
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
            <Item
              label="Primary instance"
              value={ctx.primary ?? "None"}
              mono={!!ctx.primary}
              testID="settings-primary"
              onPress={() => router.push("/primary")}
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
                  A guess from asking up to three listened agents and Tailscale’s own status page on
                  this phone: iOS does not let an app ask the Tailscale app directly.
                </Note>
              </View>
            }
          >
            <Item
              label={status ? TAILSCALE_WORDS[status] : "Checking…"}
              leading={<Dot color={tailscaleColor} />}
            />
            {tailscale ? <Item label={TUNNEL_WORDS[tailscale.tunnel]} /> : null}
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
            <AvatarStyles
              value={prefs.avatarStyle}
              onChange={(avatarStyle) => update({ avatarStyle })}
            />
            <Toggle label="Haptics" value={prefs.haptics} onChange={(v) => update({ haptics: v })} />
          </Group>

          <Group
            title="This phone"
            note={
              <Note>
                Signing out forgets this fleet's pairing on this phone; other paired fleets stay.
                Nothing on the laptop or the boxes changes beyond this phone's push registration.
              </Note>
            }
          >
            <Item label="Re-pair or add a fleet" onPress={() => router.push("/pair")} />
            <Item label="Sign out" tone="bad" chevron={false} onPress={signOut} />
          </Group>

          <Group
            title="About"
            note={
              <Note>
                A remote head for a Hermetic fleet. It talks to the agents directly over your tailnet:
                chat with each box's Hermes gateway, the fleet list and push registration with
                hermeticd, and the agent browser from the box.
              </Note>
            }
          >
            <Item
              label="Version"
              value={`Hermetic ${Constants.expoConfig?.version ?? "0.0.0"} (${Constants.nativeBuildVersion ?? "dev"})${fixture ? " · fixture" : ""}`}
            />
          </Group>
          <Group
            title="Support"
            note={
              <Note>
                Review app, iOS and connection status before sharing. The report excludes messages,
                agent names, addresses, pairing details and push tokens. Nothing is sent automatically.
              </Note>
            }
          >
            <Item label="Review support report" onPress={shareDiagnostics} />
          </Group>
        </ScrollView>
      </SectionLayout.Provider>
    </Screen>
  );
}
