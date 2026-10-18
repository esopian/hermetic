/**
 * The thread's bands (desktop `Thread.tsx` `Band` / `ObservationBand` / turn
 * error band): one condition each, stated, above the transcript or the
 * composer. A band never hides content and is never dismissed by a timer.
 */
import { View } from "react-native";
import type { RemoteTurnView, ThreadState } from "../client/chat-logic.ts";
import { turnErrorHeadline } from "../client/chat-logic.ts";
import type { Failure, ObserveState } from "../client/conversation-store.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { StatusSquare } from "../ui/StatusSquare.tsx";
import { Text } from "../ui/Text.tsx";

type Tone = "acc" | "warn" | "bad";

export function BandShell({
  tone,
  title,
  sub,
  action,
  pulse = false,
  testID,
}: {
  tone: Tone;
  title: string;
  sub?: string | null;
  action?: { label: string; onPress(): void } | null;
  pulse?: boolean;
  testID?: string;
}) {
  const t = useTheme();
  const color = t.c[tone];
  return (
    <View
      testID={testID}
      accessibilityRole={tone === "bad" ? "alert" : "text"}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: t.space.sm,
        paddingHorizontal: t.space.lg,
        paddingVertical: t.space.sm,
        backgroundColor: t.c.bg2,
        borderBottomWidth: 1,
        borderBottomColor: color,
      }}
    >
      {/* The square sits on the title's line, not the middle of a wrapped sub. */}
      <View style={{ height: t.type.bodySmall.lineHeight, justifyContent: "center" }}>
        <StatusSquare size={8} color={color} pulse={pulse} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="bodySmall" weight={700}>
          {title}
        </Text>
        {sub ? (
          <Text variant="caption" tone="fg2">
            {sub}
          </Text>
        ) : null}
      </View>
      {action ? (
        <Button
          label={action.label}
          variant="secondary"
          compact
          onPress={action.onPress}
          style={{ alignSelf: "center" }}
        />
      ) : null}
    </View>
  );
}

/** The thread-level band for `threadState`, or nothing for a ready thread. */
export function ThreadBand({
  state,
  instance,
  bot,
  session = null,
  reconnectAttempt = 0,
}: {
  state: ThreadState;
  instance: string;
  bot: string;
  session?: string | null;
  reconnectAttempt?: number;
}) {
  switch (state) {
    case "missing":
      return (
        <BandShell
          tone="bad"
          testID="band-missing"
          title={
            session
              ? `${bot} on ${instance} has no such session.`
              : `${instance} has no bot named ${bot}.`
          }
          sub="The link may be out of date, or the bot was removed. Pull down to check again."
        />
      );
    case "stopped":
      return (
        <BandShell
          tone="warn"
          title={`${instance} is stopped.`}
          sub="Its transcript is on the data volume and comes back with it."
        />
      );
    case "destroyed":
      return (
        <BandShell
          tone="acc"
          title={`${instance} is gone, but its memory is not.`}
          sub="The data volume was kept, if one was."
        />
      );
    case "dropped":
      return (
        <BandShell
          tone="warn"
          pulse
          testID="band-dropped"
          title={`Reconnecting to ${instance}…`}
          sub={`${reconnectAttempt > 1 ? `attempt ${reconnectAttempt} · ` : ""}The transcript is being re-read from the box, which is the copy that is true.`}
        />
      );
    case "unreachable":
      return (
        <BandShell
          tone="bad"
          testID="band-unreachable"
          title={`No answer from ${instance}.`}
          sub="Chat reaches a box over Tailscale Serve and nothing else."
        />
      );
    case "no_tailnet":
      return (
        <BandShell
          tone="bad"
          title="No route to the tailnet."
          sub="Chat reaches an agent over Tailscale Serve and nothing else."
        />
      );
    case "bootstrapping":
      return (
        <BandShell
          tone="acc"
          pulse
          title={`${instance} is starting.`}
          sub="A message sent now waits until the gateway answers."
        />
      );
    default:
      return null;
  }
}

/** This phone's live watch on this conversation: reconnecting, or gone with a way back. */
export function ObservationBand({
  state,
  error,
  onResume,
}: {
  state: ObserveState;
  error: Failure | null;
  onResume?: () => void;
}) {
  if (state === "reconnecting")
    return (
      <BandShell
        tone="warn"
        pulse
        testID="band-reconnecting"
        title="Reconnecting to this conversation…"
        sub="Messages sent from elsewhere may arrive late until the watch is back."
      />
    );
  if (state !== "failed") return null;
  return (
    <BandShell
      tone="bad"
      testID="band-unwatched"
      title="This conversation is no longer being watched."
      sub={`${error?.message ?? "The observation ended."} Messages sent from Hermes Desktop, the CLI or a routine will not appear here until it is watched again.`}
      action={onResume ? { label: "Watch again", onPress: onResume } : null}
    />
  );
}

/** A turn the box refused, or one stopped with no reply: the band is its only record. */
export function TurnErrorBand({ error }: { error: Failure }) {
  return (
    <BandShell
      tone="bad"
      testID="band-turn-error"
      title={turnErrorHeadline(error.code)}
      sub={`${error.code} · ${error.message}`}
    />
  );
}

/** The last turn ended without a `done`: what is shown may be incomplete. */
export function DroppedBand() {
  return (
    <BandShell
      tone="warn"
      title="The reply stopped arriving."
      sub="The transcript is re-read from the box when the turn ends — that copy is complete."
    />
  );
}

/**
 * The turn this phone stopped following while it was away is still running
 * on the box (`ConversationView.remote`). The composer offers Steer and Stop
 * meanwhile, and a plain send is queued until the box says the turn is over.
 */
export function RemoteBand({ remote }: { remote: RemoteTurnView | null }) {
  if (!remote) return null;
  return (
    <BandShell
      tone={remote.status === "waiting" ? "warn" : "acc"}
      pulse
      testID="band-remote"
      title={remote.title}
      sub={remote.sub}
    />
  );
}
