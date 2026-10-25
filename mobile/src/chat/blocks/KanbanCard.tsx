/**
 * Kanban in the conversation (desktop `blocks/KanbanTask.tsx` and
 * `ProcessEvent.tsx` `KanbanNotice`), sized for the phone: the card a
 * `kanban_create` call filed, live from the box's board; the notice row Hermes
 * posts when a subscribed card moves; and the sheet either one opens — the
 * card's detail, comments and runs, and, while it is blocked, an answer and
 * Unblock.
 */
import type { ProcessEventBlock, ToolBlock } from "@hermetic/core/chat-client";
import type { KanbanTaskDetail } from "@hermetic/core/schema";
import {
  KANBAN_LANE_INDEX,
  KANBAN_LANES,
  type KanbanTaskLike,
  type KanbanTone,
  kanbanNoticeWhat,
  kanbanStatusWord,
  kanbanTone,
  readKanbanCreateResult,
} from "@hermetic/core/shared";
import { type ReactNode, useState } from "react";
import { Modal, ScrollView, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { reasonOf } from "../../client/errors.ts";
import { commentKanbanTask, unblockKanbanTask } from "../../client/kanban.ts";
import type { Palette } from "../../theme/tokens.ts";
import { useTheme } from "../../theme/theme.tsx";
import { Button } from "../../ui/Button.tsx";
import { haptic } from "../../ui/haptics.ts";
import { Kicker } from "../../ui/Kicker.tsx";
import { StatusSquare } from "../../ui/StatusSquare.tsx";
import { Text } from "../../ui/Text.tsx";
import { multilineTint } from "../../ui/tint.ts";
import { useChatScope } from "../ChatScope.tsx";
import { chatTime } from "../time.ts";
import { UNREADABLE, useKanbanTask } from "./use-kanban-task.ts";

type Task = KanbanTaskDetail["task"];

function toneColor(c: Palette, tone: KanbanTone): string {
  return tone === "none" ? c.line2 : c[tone];
}

/** A board timestamp (seconds) as the transcript's clock reads it. */
function at(sec: number | null | undefined, now: number): string {
  return sec ? chatTime(new Date(sec * 1000).toISOString(), now) : "—";
}

/** What is happening to the card now, in a line. */
function liveLine(detail: KanbanTaskDetail): string {
  const t = detail.task;
  switch (t.status) {
    case "triage":
      return "The specifier is turning this into a spec.";
    case "todo":
      return `Waits on ${detail.links.parents[0]?.title ?? "another card"}.`;
    case "ready":
      return t.assignee
        ? `Waiting for a worker on ${detail.instance} — the dispatcher ticks every 60s.`
        : "Parked: no assignee, so nothing will run it.";
    case "running":
      return t.latest_summary ?? `${t.assignee ?? "A worker"} is working.`;
    case "blocked":
      return t.last_failure_error ?? t.latest_summary ?? "Waiting on you.";
    case "review":
      return "A reviewer agent is checking the work.";
    case "done":
      return t.latest_summary ?? "Done.";
    case "archived":
      return "Archived.";
    default:
      return KANBAN_LANES[KANBAN_LANE_INDEX[t.status] ?? 0]?.hint ?? "";
  }
}

export function Status({ task }: { task: KanbanTaskLike }) {
  const t = useTheme();
  const tone = kanbanTone(task);
  const word = kanbanStatusWord(task);
  return (
    <View
      accessible
      accessibilityLabel={`Status ${word}`}
      style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs }}
    >
      <StatusSquare size={8} color={toneColor(t.c, tone)} pulse={task.status === "running"} />
      <Text mono variant="caption" tone={tone === "none" ? "fg3" : tone}>
        {word}
      </Text>
    </View>
  );
}

/** The eight lanes as cells, the current one in the card's tone, and its name under them. */
function LaneTrack({ task }: { task: Task }) {
  const t = useTheme();
  const lane = KANBAN_LANE_INDEX[task.status] ?? -1;
  const tone = toneColor(t.c, kanbanTone(task));
  return (
    <View style={{ gap: t.space.xs }}>
      <View style={{ flexDirection: "row", gap: 2 }}>
        {KANBAN_LANES.map((l, j) => (
          <View
            key={l.id}
            style={{
              flex: 1,
              height: 4,
              backgroundColor: j < lane ? t.c.fg3 : j === lane ? tone : t.c.line,
            }}
          />
        ))}
      </View>
      <Text mono variant="caption" tone="fg3">
        {lane >= 0
          ? `${KANBAN_LANES[lane]?.label} · ${lane + 1} of ${KANBAN_LANES.length}`
          : task.status}
      </Text>
    </View>
  );
}

/** A `kanban_create` call that named its card: the card, live from the board. */
export function KanbanCard({ block }: { block: ToolBlock }) {
  const t = useTheme();
  const now = useChatScope()?.now ?? Date.now();
  const id = readKanbanCreateResult(block)?.task_id ?? null;
  const { instance, detail, failed, gone } = useKanbanTask(id);
  const [open, setOpen] = useState(false);
  if (!id) return null;
  const task = detail?.task ?? null;
  const argTitle = (block.args as { title?: unknown } | null)?.title;
  const title = task?.title ?? (typeof argTitle === "string" ? argTitle : "");
  const tone = task ? kanbanTone(task) : "none";
  return (
    <View
      testID={`kanban-${id}`}
      accessibilityLabel={`Task ${id}`}
      style={{
        borderWidth: t.border.row,
        borderColor: t.c.cardEdge,
        borderLeftWidth: t.border.seam,
        borderLeftColor: toneColor(t.c, tone),
        backgroundColor: t.c.card,
        padding: t.space.sm,
        gap: t.space.sm,
        marginVertical: t.space.xs,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <Kicker>Task</Kicker>
        <Text mono variant="caption" tone="fg2" style={{ flex: 1 }} numberOfLines={1}>
          {id}
        </Text>
        {task ? <Status task={task} /> : null}
        {instance ? (
          <Button
            label="Open"
            variant="secondary"
            compact
            accessibilityLabel={`Open task ${id}`}
            onPress={() => setOpen(true)}
          />
        ) : null}
      </View>
      {title ? (
        <Text weight={700} variant="bodySmall">
          {title}
        </Text>
      ) : null}
      {task ? (
        <Text mono variant="caption" tone="fg3" numberOfLines={1}>
          {[
            task.assignee ? `@${task.assignee}` : "unassigned",
            task.priority > 0 ? `P${task.priority}` : null,
            `${detail?.runs.length ?? 0} run${detail?.runs.length === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
      {task ? <LaneTrack task={task} /> : null}
      <Text
        variant="caption"
        tone={
          gone ? "fg3" : failed ? "warn" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "fg2"
        }
        numberOfLines={3}
      >
        {gone
          ? "This card was deleted from the board."
          : failed === UNREADABLE
            ? `This card is not readable on ${instance ?? "this box"}: its board may be off or elsewhere.`
            : failed && !detail
              ? `${instance ?? "The box"} is not answering.`
              : detail
                ? liveLine(detail)
                : instance
                  ? "Reading the card…"
                  : "Open this chat on its bot to follow the card."}
      </Text>
      {task ? (
        <Text mono variant="caption" tone="fg3">
          {task.status === "done" && task.completed_at
            ? `completed ${at(task.completed_at, now)}`
            : `updated ${at(task.last_heartbeat_at ?? task.started_at ?? task.created_at, now)}${failed && failed !== UNREADABLE ? " · not answering" : ""}`}
        </Text>
      ) : null}
      {open ? <KanbanSheet id={id} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

/** Hermes' notice that a card this chat follows moved: what happened, and Open. */
export function KanbanNotice({ block }: { block: ProcessEventBlock }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const instance = useChatScope()?.instance ?? null;
  const n = block.notice;
  const taskId = n?.task_id ?? null;
  const bad = block.outcome === "failed";
  const head = [
    `${Array.from(block.raw)[0] ?? ""} Kanban ${taskId ?? ""}`.trim(),
    n?.assignee ? `@${n.assignee}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <View
      accessibilityRole="text"
      style={{
        borderWidth: t.border.row,
        borderColor: t.c.cardEdge,
        backgroundColor: t.c.card,
        padding: t.space.sm,
        gap: t.space.xs,
        marginVertical: t.space.xs,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <Text mono variant="caption" weight={700} style={{ flex: 1 }} numberOfLines={1}>
          {head}
        </Text>
        {taskId && instance ? (
          <Button
            label="Open"
            variant="secondary"
            compact
            accessibilityLabel={`Open task ${taskId}`}
            onPress={() => setOpen(true)}
          />
        ) : null}
      </View>
      <Text variant="bodySmall" tone={bad ? "bad" : "fg2"} selectable>
        {n ? kanbanNoticeWhat(n) : (block.raw.split("\n")[0] ?? "")}
      </Text>
      {n?.body ? (
        <Text variant="caption" tone="fg3" selectable>
          {n.body}
        </Text>
      ) : null}
      {open && taskId ? <KanbanSheet id={taskId} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        gap: t.space.sm,
        paddingTop: t.space.md,
        borderTopWidth: t.border.row,
        borderTopColor: t.c.line,
      }}
    >
      <Kicker>{title}</Kicker>
      {children}
    </View>
  );
}

/**
 * The card's detail in a page sheet (`TaskSheet`'s presentation): status and
 * lanes, the body, comments and runs, mounted (and read) only while open. A blocked card
 * takes an answer: Comment posts it, Unblock posts it and moves the card to
 * Ready, where a worker picks it up.
 */
export function KanbanSheet({
  id,
  instance: on,
  onClose,
}: {
  id: string;
  /** The card's box, where no conversation says (the board screen). */
  instance?: string;
  onClose(): void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const now = useChatScope()?.now ?? Date.now();
  const { instance, rest, detail, failed, gone, reload } = useKanbanTask(id, on);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"comment" | "unblock" | null>(null);
  const [note, setNote] = useState<{ tone: "bad" | "ok"; text: string } | null>(null);
  const task = detail?.task ?? null;

  const act = async (kind: "comment" | "unblock") => {
    if (!rest || !instance || busy) return;
    setBusy(kind);
    setNote(null);
    try {
      if (kind === "comment") await commentKanbanTask(rest, instance, id, draft.trim());
      else await unblockKanbanTask(rest, instance, id, draft);
      haptic.success();
      setDraft("");
      setNote({
        tone: "ok",
        text: kind === "comment" ? "Comment posted." : "Unblocked: back to Ready.",
      });
      reload();
    } catch (e) {
      haptic.error();
      setNote({ tone: "bad", text: reasonOf(e).message });
    } finally {
      setBusy(null);
    }
  };

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
          <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }} numberOfLines={1}>
            {`Task ${id}`}
          </Text>
          <Button label="Done" variant="secondary" compact onPress={onClose} />
        </View>
        <ScrollView
          contentContainerStyle={{
            padding: t.space.lg,
            gap: t.space.md,
            paddingBottom: insets.bottom + t.space.xl,
          }}
        >
          {task ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                <Status task={task} />
                <Text mono variant="caption" tone="fg3" style={{ flex: 1 }} numberOfLines={1}>
                  {[task.assignee ? `@${task.assignee}` : "unassigned", instance]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Text variant="title" weight={700} selectable>
                {task.title}
              </Text>
              <LaneTrack task={task} />
              <Text variant="bodySmall" tone="fg2" selectable>
                {liveLine(detail as KanbanTaskDetail)}
              </Text>
              {task.body ? (
                <Section title="Spec">
                  <Text variant="bodySmall" selectable>
                    {task.body}
                  </Text>
                </Section>
              ) : null}
              <Section title={`Comments · ${detail?.comments.length ?? 0}`}>
                {detail?.comments.length ? (
                  detail.comments.map((c) => (
                    <View key={String(c.id)} style={{ gap: 2 }}>
                      <Text mono variant="caption" tone="fg3">
                        {`${c.author || "someone"} · ${at(c.created_at, now)}`}
                      </Text>
                      <Text variant="bodySmall" selectable>
                        {c.body}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text variant="caption" tone="fg3">
                    No comments.
                  </Text>
                )}
              </Section>
              <Section title={`Runs · ${detail?.runs.length ?? 0}`}>
                {detail?.runs.length ? (
                  detail.runs.map((r) => (
                    <View key={String(r.id)} style={{ gap: 2 }}>
                      <Text mono variant="caption" tone={r.error ? "bad" : "fg3"}>
                        {[
                          r.profile ? `@${r.profile}` : null,
                          r.outcome ?? r.status,
                          at(r.started_at, now),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                      {r.summary || r.error ? (
                        <Text variant="bodySmall" tone={r.error ? "bad" : "fg2"} selectable>
                          {r.error ?? r.summary}
                        </Text>
                      ) : null}
                    </View>
                  ))
                ) : (
                  <Text variant="caption" tone="fg3">
                    No runs yet.
                  </Text>
                )}
              </Section>
            </>
          ) : (
            <Text variant="bodySmall" tone={failed ? "warn" : "fg3"}>
              {gone
                ? "This card was deleted from the board."
                : failed === UNREADABLE
                  ? `This card is not readable on ${instance ?? "this box"}: its board may be off or elsewhere.`
                  : failed
                    ? `${instance ?? "The box"} is not answering: ${failed}`
                    : "Reading the card…"}
            </Text>
          )}
        </ScrollView>
        {task?.status === "blocked" && rest && instance ? (
          <View
            style={{
              padding: t.space.md,
              paddingBottom: insets.bottom + t.space.md,
              gap: t.space.sm,
              borderTopWidth: t.border.control,
              borderTopColor: t.c.fg,
            }}
          >
            {note ? (
              <Text
                variant="caption"
                tone={note.tone}
                accessibilityRole={note.tone === "bad" ? "alert" : "text"}
              >
                {note.text}
              </Text>
            ) : null}
            <TextInput
              keyboardAppearance={t.scheme}
              accessibilityLabel={`Answer on task ${id}`}
              selectionColor={multilineTint(t.c.acc)}
              cursorColor={t.c.acc}
              value={draft}
              onChangeText={setDraft}
              placeholder="Answer the question on the card…"
              placeholderTextColor={t.c.fg3}
              multiline
              style={{
                minHeight: t.touch.min,
                maxHeight: 120,
                color: t.c.fg,
                fontFamily: t.sans(400),
                fontSize: 15,
                paddingHorizontal: t.space.md,
                paddingTop: 11,
                borderWidth: t.border.control,
                borderColor: t.c.line2,
              }}
            />
            <View style={{ flexDirection: "row", gap: t.space.sm }}>
              <Button
                label="Comment"
                variant="secondary"
                busy={busy === "comment"}
                disabled={!draft.trim() || !!busy}
                onPress={() => void act("comment")}
              />
              <Button
                label="Unblock"
                busy={busy === "unblock"}
                disabled={!!busy}
                onPress={() => void act("unblock")}
              />
            </View>
          </View>
        ) : note ? (
          <Text variant="caption" tone={note.tone} style={{ padding: t.space.lg }}>
            {note.text}
          </Text>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}
