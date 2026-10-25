/**
 * New / edit routine, inside the Routines sheet: the desktop's routine drawer
 * (`packages/ui/src/chat/components/RoutineDrawer.tsx`) at phone size, on the
 * same picker helpers (`@hermetic/core/shared`). What it does, when (the
 * schedule kinds, plain text fields for date and time), where results go, the
 * run cap and continuity; then a preview of the next three runs, and for a
 * saved job its recent runs.
 */
import {
  KINDS,
  defaultPicker,
  describeSchedule,
  dayLabel,
  formatStamp,
  formatTime,
  fromSchedule,
  nextRuns,
  runTone,
  scheduleProblem,
  toSchedule,
  withKind,
  type SchedulePicker,
} from "@hermetic/core/shared";
import type { BotRoutine, BotRoutineRun } from "@hermetic/core/schema";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PhoneRoutines } from "../client/routines.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";
import { ToggleSwitch } from "../ui/ToggleSwitch.tsx";
import { multilineTint } from "../ui/tint.ts";

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UNITS = [
  ["m", "minutes"],
  ["h", "hours"],
  ["d", "days"],
] as const;

function Row({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm, alignItems: "center" }}>
      {children}
    </View>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.sm }}>
      <Kicker>{label}</Kicker>
      {children}
      {note ? (
        <Text variant="caption" tone="fg3">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

export function RoutineEditor({
  instance,
  bot,
  title,
  job,
  zone,
  routines,
  onDone,
}: {
  instance: string;
  bot: string;
  title: string;
  /** null creates. */
  job: BotRoutine | null;
  zone: string;
  routines: PhoneRoutines;
  /** `changed` when the job was saved or deleted. */
  onDone(changed: boolean): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [now] = useState(Date.now);
  const [name, setName] = useState(job?.name ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [picker, setPickerState] = useState<SchedulePicker>(() =>
    job ? fromSchedule(job.schedule, zone, now) : defaultPicker(zone, now),
  );
  // An edit that never touched the schedule sends none: a schedule this form
  // cannot read (a sixth cron field, a named weekday) survives a rename.
  const [touched, setTouched] = useState(!job);
  const [deliver, setDeliver] = useState<"local" | "bot" | "other">(job?.deliver ?? "local");
  const [repeat, setRepeat] = useState(job?.repeat.times ? String(job.repeat.times) : "");
  const [continuity, setContinuity] = useState(job?.continuity ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<BotRoutineRun[] | null>(null);

  useEffect(() => {
    if (!job) return;
    let live = true;
    routines
      .history({ instance, bot, id: job.id, limit: 5 })
      .then((r) => live && setHistory(r.runs))
      .catch(() => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [routines, instance, bot, job]);

  const setPicker = (p: SchedulePicker) => {
    setPickerState(p);
    setTouched(true);
  };
  const schedule = touched ? toSchedule(picker) : (job?.schedule ?? "");
  const problem = touched ? scheduleProblem(picker, zone, now) : "";
  const oneShot = picker.kind === "once" || picker.kind === "at";
  const cap = repeat.trim() ? Number(repeat) : null;
  const capBad = cap !== null && !(Number.isInteger(cap) && cap >= 1);
  const missing = !name.trim()
    ? "Name the job."
    : !prompt.trim()
      ? "Write the instructions."
      : problem || (capBad ? "Stop after takes a whole number of runs." : "");
  const runs = problem ? [] : nextRuns(schedule, zone, 3, now);

  async function save() {
    if (missing || busy) return;
    setBusy(true);
    setError("");
    const ref = { instance, bot };
    const runCap = oneShot ? null : cap;
    try {
      if (!job)
        await routines.create({
          ...ref,
          name: name.trim(),
          prompt,
          schedule,
          deliver: deliver === "bot" ? "bot" : "local",
          ...(runCap ? { repeat: runCap } : {}),
          ...(continuity ? { continuity } : {}),
        });
      else
        await routines.update({
          ...ref,
          id: job.id,
          ...(name.trim() !== job.name ? { name: name.trim() } : {}),
          ...(prompt !== job.prompt ? { prompt } : {}),
          ...(touched && schedule !== job.schedule ? { schedule } : {}),
          ...(deliver !== "other" && deliver !== job.deliver ? { deliver } : {}),
          ...(runCap !== job.repeat.times && !oneShot ? { repeat: runCap } : {}),
          ...(continuity !== job.continuity ? { continuity } : {}),
        });
      onDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function remove() {
    if (!job) return;
    Alert.alert(`Delete “${job.name}”?`, "It stops running. Its run history goes with it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          routines
            .delete({ instance, bot, id: job.id, confirm: true })
            .then(() => onDone(true))
            .catch((e: unknown) => {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            });
        },
      },
    ]);
  }

  const field = {
    borderWidth: t.border.row,
    borderColor: t.c.line2,
    backgroundColor: t.c.bg2,
    color: t.c.fg,
    fontFamily: t.sans(400),
    fontSize: 16,
    paddingHorizontal: t.space.md,
    paddingVertical: t.space.sm,
    minHeight: t.touch.min,
  } as const;
  const inputProps = {
    keyboardAppearance: t.scheme,
    selectionColor: multilineTint(t.c.acc),
    cursorColor: t.c.acc,
    placeholderTextColor: t.c.fg3,
    editable: !busy,
  } as const;
  const text = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <TextInput
      {...inputProps}
      accessibilityLabel={label}
      value={value}
      onChangeText={set}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      style={{ ...field, fontFamily: t.mono(400) }}
    />
  );
  const count = (key: "n" | "minute" | "dom", label: string) => (
    <TextInput
      {...inputProps}
      accessibilityLabel={label}
      keyboardType="number-pad"
      value={Number.isNaN(picker[key]) ? "" : String(picker[key])}
      onChangeText={(v) => setPicker({ ...picker, [key]: v === "" ? Number.NaN : Number(v) })}
      style={{ ...field, width: 88 }}
    />
  );
  const time = text("Time", picker.time, (v) => setPicker({ ...picker, time: v }), "08:00");
  const units = (
    <View style={{ flexDirection: "row", gap: t.space.sm }}>
      {UNITS.map(([u, label]) => (
        <Chip
          key={u}
          label={label}
          on={picker.unit === u}
          onPress={() => setPicker({ ...picker, unit: u })}
        />
      ))}
    </View>
  );
  const sub: Record<SchedulePicker["kind"], ReactNode> = {
    once: (
      <Field label="Run once, in">
        <Row>
          {count("n", "Amount")}
          {units}
        </Row>
      </Field>
    ),
    at: (
      <Field label="On" note={`YYYY-MM-DD and HH:MM, 24-hour, in ${zone}.`}>
        <Row>
          {text("Date", picker.date, (v) => setPicker({ ...picker, date: v }), "2026-10-30")}
          {time}
        </Row>
      </Field>
    ),
    hourly: (
      <Field label="At minute" note="past every hour">
        {count("minute", "Minute")}
      </Field>
    ),
    daily: (
      <Field label="At" note="HH:MM, 24-hour.">
        {time}
      </Field>
    ),
    weekdays: (
      <Field label="At" note="HH:MM, 24-hour.">
        {time}
      </Field>
    ),
    weekly: (
      <>
        <Field label="On">
          <Row>
            {DAYS.map((d) => (
              <Chip
                key={d}
                label={DAY_NAMES[d] ?? ""}
                on={picker.days.includes(d)}
                onPress={() =>
                  setPicker({
                    ...picker,
                    days: picker.days.includes(d)
                      ? picker.days.filter((x) => x !== d)
                      : [...picker.days, d],
                  })
                }
              />
            ))}
          </Row>
        </Field>
        <Field label="At" note="HH:MM, 24-hour.">
          {time}
        </Field>
      </>
    ),
    monthly: (
      <Field
        label="On day, at"
        note={picker.dom > 28 ? "Months without that day are skipped." : "HH:MM, 24-hour."}
      >
        <Row>
          {count("dom", "Day of month")}
          {time}
        </Row>
      </Field>
    ),
    interval: (
      <Field label="Every" note="Counted from when the job is saved.">
        <Row>
          {count("n", "Amount")}
          {units}
        </Row>
      </Field>
    ),
    cron: (
      <Field label="Cron expression" note="minute · hour · day of month · month · weekday">
        {text("Cron expression", picker.expr, (v) => setPicker({ ...picker, expr: v }), "0 8 * * 1-5")}
      </Field>
    ),
  };

  return (
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
        <Text variant="heading" style={{ flex: 1 }} accessibilityRole="header" numberOfLines={1}>
          {job ? "Edit routine" : "New routine"}
        </Text>
        <Button label="Cancel" variant="secondary" compact onPress={() => onDone(false)} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          gap: t.space.lg,
          padding: t.space.lg,
          paddingBottom: insets.bottom + t.space.xl,
        }}
      >
        <Field label="Job name">
          <TextInput
            {...inputProps}
            accessibilityLabel="Job name"
            value={name}
            onChangeText={setName}
            maxLength={120}
            style={field}
          />
        </Field>
        <Field label="Instructions">
          <TextInput
            {...inputProps}
            accessibilityLabel="Instructions"
            value={prompt}
            onChangeText={setPrompt}
            placeholder={`What should ${title} do each time?`}
            multiline
            textAlignVertical="top"
            style={{ ...field, minHeight: 120 }}
          />
        </Field>
        <Field label="When">
          <Row>
            {KINDS.map(([k, label]) => (
              <Chip
                key={k}
                label={label}
                on={picker.kind === k}
                onPress={() => setPicker(withKind(picker, k))}
              />
            ))}
          </Row>
        </Field>
        {sub[picker.kind]}
        <Field label="Where results go">
          <Row>
            {job?.deliver === "other" ? (
              <Chip
                label="Keep existing destination"
                on={deliver === "other"}
                onPress={() => setDeliver("other")}
              />
            ) : null}
            <Chip
              label="Run history only"
              on={deliver === "local"}
              onPress={() => setDeliver("local")}
            />
            <Chip label={`${title}’s chat`} on={deliver === "bot"} onPress={() => setDeliver("bot")} />
          </Row>
        </Field>
        <Field
          label="Stop after"
          note={
            oneShot
              ? "A one-off job runs once."
              : job?.repeat.times
                ? `runs · ${job.repeat.completed} so far`
                : "runs (blank runs forever)"
          }
        >
          <TextInput
            {...inputProps}
            accessibilityLabel="Stop after runs"
            keyboardType="number-pad"
            placeholder="forever"
            editable={!busy && !oneShot}
            value={oneShot ? "" : repeat}
            onChangeText={setRepeat}
            style={{ ...field, width: 120 }}
          />
        </Field>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.md }}>
          <View style={{ flex: 1 }}>
            <Text weight={600}>Continue from the last run</Text>
            <Text variant="caption" tone="fg3">
              Each run sees the previous run’s output.
            </Text>
          </View>
          <ToggleSwitch
            value={continuity}
            onValueChange={setContinuity}
            accessibilityLabel="Continue from the last run"
          />
        </View>
        <View
          style={{
            gap: t.space.sm,
            paddingTop: t.space.md,
            borderTopWidth: t.border.row,
            borderTopColor: t.c.line,
          }}
        >
          <Kicker>Preview</Kicker>
          {problem ? (
            <Text tone="bad" accessibilityRole="alert">
              {problem}
            </Text>
          ) : (
            <>
              <Text weight={600}>{describeSchedule(schedule, zone)}</Text>
              <Text mono variant="caption" tone="fg3">
                {schedule}
              </Text>
              {runs.length ? (
                runs.map((r) => (
                  <Text key={r} variant="bodySmall" tone="fg2">
                    {`${dayLabel(r, zone, now)} ${formatTime(r, zone)}`}
                  </Text>
                ))
              ) : (
                <Text variant="bodySmall" tone="fg2">
                  No upcoming runs this phone can work out.
                </Text>
              )}
            </>
          )}
        </View>
        {job && history?.length ? (
          <View style={{ gap: t.space.sm }}>
            <Kicker>Recent runs</Kicker>
            {history.map((run) => {
              const tone = runTone(run.status);
              const at = run.started_at ? Date.parse(run.started_at) : null;
              return (
                <View key={run.id} style={{ gap: 2 }}>
                  <Text
                    variant="bodySmall"
                    tone={tone === "bad" ? "bad" : tone === "ok" ? "ok" : "fg2"}
                  >{`${run.status}${at ? ` · ${formatStamp(at, zone)}` : ""}`}</Text>
                  {run.error || run.text ? (
                    <Text variant="caption" tone="fg3" numberOfLines={3}>
                      {run.error ?? run.text}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}
        {error ? (
          <Text tone="bad" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {missing && !problem ? (
          <Text variant="caption" tone="fg3">
            {missing}
          </Text>
        ) : null}
        <Button
          label={job ? "Save" : "Create"}
          busy={busy}
          disabled={!!missing}
          onPress={() => void save()}
        />
        {job ? <Button label="Delete" variant="destructive" disabled={busy} onPress={remove} /> : null}
      </ScrollView>
    </>
  );
}
