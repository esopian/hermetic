/**
 * The Routines sheet: the bot's scheduled jobs (Hermes cron), the desktop's
 * Scheduled jobs rail at phone size. Each row reads its schedule in words, its
 * next run and its last run's tone, with Run now and Pause/Resume; a tap edits
 * it (`RoutineEditor`, drawn in the same sheet so no second modal stacks).
 * Times are on the profile's clock, as the desktop draws them.
 */
import { describeSchedule, dayLabel, formatTime, runTone } from "@hermetic/core/shared";
import type { BotRoutine } from "@hermetic/core/schema";
import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PhoneRoutines } from "../client/routines.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { StatusSquare } from "../ui/StatusSquare.tsx";
import { Text } from "../ui/Text.tsx";
import { RoutineEditor } from "./RoutineEditor.tsx";

export function RoutinesSheet({
  visible,
  instance,
  bot,
  title,
  routines,
  refreshKey,
  now,
  onClose,
}: {
  visible: boolean;
  instance: string;
  bot: string;
  /** The bot's display name. */
  title: string;
  routines: PhoneRoutines | null;
  /** Changes when the list should be read again (a cron tool call finished). */
  refreshKey: number;
  now: number;
  onClose(): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [jobs, setJobs] = useState<BotRoutine[] | null>(null);
  // shortcut: a profile with no `timezone` runs on the box's clock, assumed UTC
  // (the EC2 image default), as the desktop assumes.
  const [zone, setZone] = useState("UTC");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<BotRoutine | "new" | null>(null);

  const load = useCallback(async () => {
    if (!routines) return;
    try {
      const r = await routines.list({ instance, bot });
      setJobs(r.jobs);
      setZone(r.timezone ?? "UTC");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [routines, instance, bot]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load, refreshKey]); // refreshKey: a finished cron tool call asks for a re-read.

  async function act(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const close = () => {
    setEditing(null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: t.c.bg }}>
        {editing && routines ? (
          <RoutineEditor
            instance={instance}
            bot={bot}
            title={title}
            job={editing === "new" ? null : editing}
            zone={zone}
            routines={routines}
            onDone={(changed) => {
              setEditing(null);
              if (changed) void load();
            }}
          />
        ) : (
          <>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: t.space.sm,
                padding: t.space.lg,
                borderBottomWidth: t.border.control,
                borderBottomColor: t.c.fg,
              }}
            >
              <Text variant="heading" style={{ flex: 1 }} accessibilityRole="header">
                Routines
              </Text>
              <Button
                label="New"
                variant="secondary"
                compact
                disabled={!routines}
                onPress={() => setEditing("new")}
              />
              <Button label="Done" variant="secondary" compact onPress={close} />
            </View>
            <ScrollView
              contentContainerStyle={{
                paddingHorizontal: t.space.lg,
                paddingBottom: insets.bottom + t.space.xl,
              }}
            >
              {error ? (
                <Text tone="bad" accessibilityRole="alert" style={{ marginTop: t.space.md }}>
                  {error}
                </Text>
              ) : null}
              {jobs === null && !error ? (
                <Text tone="fg2" style={{ marginTop: t.space.md }}>
                  Loading…
                </Text>
              ) : null}
              {jobs?.length === 0 ? (
                <Text tone="fg2" style={{ marginTop: t.space.md }}>
                  {`No scheduled jobs. ${title} runs one on a schedule you set, or when you ask it to in chat.`}
                </Text>
              ) : null}
              {jobs?.map((job, i) => (
                <RoutineRow
                  key={job.id}
                  job={job}
                  zone={zone}
                  now={now}
                  first={i === 0}
                  busy={busy === job.id}
                  onEdit={() => setEditing(job)}
                  onRun={() =>
                    void act(job.id, async () => routines?.run({ instance, bot, id: job.id }))
                  }
                  onPause={() =>
                    void act(job.id, async () =>
                      routines?.update({ instance, bot, id: job.id, paused: !job.paused }),
                    )
                  }
                />
              ))}
              <Text
                variant="caption"
                tone="fg3"
                style={{
                  marginTop: t.space.md,
                  paddingTop: t.space.md,
                  borderTopWidth: t.border.row,
                  borderTopColor: t.c.line,
                }}
              >
                {`Jobs run on the instance, even with this phone closed. Times are in the instance's timezone (${zone}).`}
              </Text>
            </ScrollView>
          </>
        )}
      </View>
    </Modal>
  );
}

function RoutineRow({
  job,
  zone,
  now,
  first,
  busy,
  onEdit,
  onRun,
  onPause,
}: {
  job: BotRoutine;
  zone: string;
  now: number;
  first: boolean;
  busy: boolean;
  onEdit(): void;
  onRun(): void;
  onPause(): void;
}) {
  const t = useTheme();
  const next = !job.paused && job.next_run_at ? Date.parse(job.next_run_at) : null;
  const tone = job.paused ? "paused" : job.last_run_at ? runTone(job.last_status) : "idle";
  const color =
    tone === "ok"
      ? t.c.ok
      : tone === "bad"
        ? t.c.bad
        : tone === "run"
          ? t.c.acc
          : tone === "paused"
            ? t.c.line2
            : t.c.fg3;
  const schedule = describeSchedule(job.schedule, zone);
  const when = job.paused
    ? "Paused"
    : next
      ? `Next: ${dayLabel(next, zone, now)}, ${formatTime(next, zone)}`
      : "Not scheduled";
  return (
    <View
      style={{
        paddingVertical: t.space.md,
        gap: t.space.sm,
        borderTopWidth: first ? 0 : t.border.row,
        borderTopColor: t.c.line,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${job.name}, ${schedule}, ${when}. Edit`}
        onPress={onEdit}
        style={({ pressed }) => ({ minHeight: t.touch.min, opacity: pressed ? 0.6 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <StatusSquare color={color} pulse={tone === "run"} />
          <Text weight={600} numberOfLines={1} style={{ flex: 1 }}>
            {job.name}
          </Text>
        </View>
        <Text tone="fg2" variant="bodySmall">
          {schedule}
        </Text>
        <Text tone="fg3" variant="caption" mono>
          {when}
        </Text>
      </Pressable>
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button label="Run now" variant="secondary" compact busy={busy} onPress={onRun} />
        <Button
          label={job.paused ? "Resume" : "Pause"}
          variant="secondary"
          compact
          disabled={busy}
          onPress={onPause}
        />
      </View>
    </View>
  );
}
