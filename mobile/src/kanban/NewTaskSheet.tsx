/**
 * File a kanban card from the board screen, the phone's form of the desktop's
 * create drawer: which instance's board, a title, notes, who works it (one of
 * the box's profiles, or nobody: parked), whether a specifier sees it first
 * (triage), and a priority. Workspace, skills and goal mode stay on the
 * desktop; upstream's defaults apply.
 */
import { useEffect, useState } from "react";
import { Modal, ScrollView, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { reasonOf } from "../client/errors.ts";
import { createKanbanTask, type KanbanRest, readKanbanProfiles } from "../client/kanban.ts";
import { useTheme } from "../theme/theme.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { haptic } from "../ui/haptics.ts";
import { Kicker } from "../ui/Kicker.tsx";
import { Text } from "../ui/Text.tsx";
import { multilineTint } from "../ui/tint.ts";

const PRIORITIES = [0, 1, 2, 3] as const;

export function NewTaskSheet({
  rest,
  instances,
  onClose,
  onCreated,
}: {
  rest: KanbanRest;
  /** The listened instances whose board answered. */
  instances: readonly string[];
  onClose(): void;
  onCreated(instance: string, id: string): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [instance, setInstance] = useState(instances[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [profiles, setProfiles] = useState<string[] | null>(null);
  /** `null` is nobody; `undefined` leaves upstream's default assignee. */
  const [assignee, setAssignee] = useState<string | null | undefined>(undefined);
  const [triage, setTriage] = useState(false);
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setProfiles(null);
    setAssignee(undefined);
    void readKanbanProfiles(rest, instance).then((p) => {
      if (live) setProfiles(p);
    });
    return () => {
      live = false;
    };
  }, [rest, instance]);

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createKanbanTask(rest, {
        instance,
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        start: triage ? "triage" : "ready",
        priority,
      });
      haptic.success();
      onCreated(instance, id);
    } catch (e) {
      haptic.error();
      setError(reasonOf(e).message);
    } finally {
      setBusy(false);
    }
  };

  const field = {
    borderWidth: t.border.control,
    borderColor: t.c.line2,
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
  const row = { flexDirection: "row", flexWrap: "wrap", gap: t.space.sm } as const;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {/* A page sheet does not move for the keyboard by itself; this measures the sheet's real frame. */}
      <KeyboardAvoidingView
        behavior="padding"
        automaticOffset
        style={{ flex: 1, backgroundColor: t.c.bg }}
      >
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
          <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
            New task
          </Text>
          <Button label="Cancel" variant="secondary" compact onPress={onClose} />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            padding: t.space.lg,
            gap: t.space.lg,
            paddingBottom: insets.bottom + t.space.xl,
          }}
        >
          {instances.length > 1 ? (
            <View style={{ gap: t.space.sm }}>
              <Kicker>Board</Kicker>
              <View style={row}>
                {instances.map((i) => (
                  <Chip key={i} label={i} on={instance === i} onPress={() => setInstance(i)} />
                ))}
              </View>
            </View>
          ) : null}
          <View style={{ gap: t.space.sm }}>
            <Kicker>Title</Kicker>
            <TextInput
              {...inputProps}
              accessibilityLabel="Title"
              value={title}
              onChangeText={setTitle}
              placeholder="What should get done?"
              maxLength={500}
              returnKeyType="done"
              style={field}
            />
          </View>
          <View style={{ gap: t.space.sm }}>
            <Kicker>Notes</Kicker>
            <TextInput
              {...inputProps}
              accessibilityLabel="Notes"
              value={body}
              onChangeText={setBody}
              placeholder="Context for whoever picks it up"
              multiline
              style={{ ...field, minHeight: 120, textAlignVertical: "top" }}
            />
          </View>
          <View style={{ gap: t.space.sm }}>
            <Kicker>Assignee</Kicker>
            <View style={row}>
              {(profiles ?? []).map((p) => (
                <Chip key={p} label={`@${p}`} on={assignee === p} onPress={() => setAssignee(p)} />
              ))}
              <Chip label="Nobody" on={assignee === null} onPress={() => setAssignee(null)} />
            </View>
            <Text variant="caption" tone="fg3">
              {profiles === null
                ? "Reading the profiles…"
                : assignee === null
                  ? "Parked: nothing runs until someone takes it."
                  : assignee === undefined
                    ? "None picked: the board's default applies."
                    : `${assignee} works it.`}
            </Text>
          </View>
          <View style={{ gap: t.space.sm }}>
            <Kicker>Start</Kicker>
            <View style={row}>
              <Chip label="Ready" on={!triage} onPress={() => setTriage(false)} />
              <Chip label="Triage first" on={triage} onPress={() => setTriage(true)} />
            </View>
            <Text variant="caption" tone="fg3">
              {triage ? "A specifier turns the idea into a spec first." : "A worker can claim it now."}
            </Text>
          </View>
          <View style={{ gap: t.space.sm }}>
            <Kicker>Priority</Kicker>
            <View style={row}>
              {PRIORITIES.map((p) => (
                <Chip key={p} label={`P${p}`} on={priority === p} onPress={() => setPriority(p)} />
              ))}
            </View>
          </View>
          {error ? (
            <Text variant="bodySmall" tone="bad" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Button
            label={busy ? "Creating…" : "Create task"}
            busy={busy}
            disabled={!title.trim() || !instance}
            onPress={() => void create()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
