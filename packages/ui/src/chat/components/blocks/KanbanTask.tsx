/**
 * A `kanban_create` call (`render: "kanban_task"`): the card the agent filed,
 * drawn where the call sits in the thread, live and on a re-read alike. Keyed
 * on the result's `task_id`, read from the box's board (`kanban.task`) and
 * re-read every `POLL_MS` until the card is done, archived or deleted (§9.2).
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  KANBAN_LANE_INDEX,
  KANBAN_LANES,
  KANBAN_TASK_ID_RE,
  kanbanStatusWord,
  kanbanTone,
} from "@hermetic/core/shared";
import {
  ApiError,
  type ChatBlockOf,
  type ChatBlockView,
  type KanbanTaskDetailView,
  kanbanTask,
} from "../../../api/index.ts";
import { fmtDuration } from "../../../logic/format.ts";
import { isVisible } from "../../../lib/visibility.ts";
import { useOpenKanbanTask } from "../../../work/open-task.ts";
import { ago } from "../../../work/parts.tsx";
import { useProcessEvents } from "./ProcessEvent.tsx";

/** How often a card still moving is re-read: Hermes' own notice poll is 5 s. */
export const POLL_MS = 5_000;
/** How often a card the board would not hand over is retried. */
export const UNREADABLE_POLL_MS = 30_000;

/**
 * The card a `kanban_create` result names, or null. Upstream's result is JSON;
 * core keeps it parsed (an object), or as the string when it did not parse.
 */
export function readKanbanCreateResult(block: ChatBlockView): { task_id: string } | null {
  if (block.kind !== "tool" || block.render !== "kanban_task") return null;
  let value: unknown = block.result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const id = value && typeof value === "object" ? (value as { task_id?: unknown }).task_id : null;
  return typeof id === "string" && KANBAN_TASK_ID_RE.test(id) ? { task_id: id } : null;
}

/** A settled `kanban_create` that named its card: drawn as a card, not a tool step. */
export function isKanbanTaskTool(block: ChatBlockView | undefined): boolean {
  return block !== undefined && readKanbanCreateResult(block) !== null;
}

type Task = KanbanTaskDetailView["task"];

function workspace(t: Task): string {
  if (t.workspace_kind === "dir") return `folder ${t.workspace_path ?? ""}`.trim();
  if (t.workspace_kind === "worktree") return `worktree ${t.branch_name ?? ""}`.trim();
  return "scratch";
}

function Row({ sq, children }: { sq: string; children: ReactNode }) {
  return (
    <div className="ch-kt-row">
      <span className={`sq ${sq}`} />
      <span>{children}</span>
    </div>
  );
}

/** What is happening to the card now, in a line or two (the prototype's `live`). */
function Live({
  detail,
  instance,
  onOpen,
}: {
  detail: KanbanTaskDetailView;
  instance: string;
  onOpen: () => void;
}) {
  const t = detail.task;
  const tone = kanbanTone(t);
  switch (t.status) {
    case "triage":
      return <Row sq="acc pulse">The specifier is turning this into a spec.</Row>;
    case "todo":
      return <Row sq="">{`Waits on ${detail.links.parents[0]?.title ?? "another card"}.`}</Row>;
    case "ready":
      return t.assignee ? (
        <Row sq="">{`Waiting for a worker on ${instance} — the dispatcher ticks every 60s.`}</Row>
      ) : (
        <Row sq="warn">Parked: no assignee, so nothing will run it.</Row>
      );
    case "running":
      return (
        <>
          <Row sq="acc pulse">
            <b>{t.assignee ?? "A worker"}</b>
            {` is working${t.last_heartbeat_at ? ` · heartbeat ${ago(t.last_heartbeat_at)}` : ""}`}
            {t.started_at
              ? ` · running ${fmtDuration(Math.max(60_000, Date.now() - t.started_at * 1000))}`
              : ""}
          </Row>
          {t.latest_summary ? <div className="ch-kt-dim">{t.latest_summary}</div> : null}
        </>
      );
    case "blocked":
      return (
        <>
          <Row sq={tone}>
            <span className={`ch-kt-${tone}`}>
              {t.last_failure_error ?? t.latest_summary ?? "Waiting on you."}
            </span>
          </Row>
          <div>
            <button type="button" className="btn ch-kt-btn" onClick={onOpen}>
              {t.block_kind === "gave_up" ? "Open task" : "Answer on the task →"}
            </button>
          </div>
        </>
      );
    case "review":
      return <Row sq="acc pulse">A reviewer agent is checking the work.</Row>;
    case "done":
      // shortcut: the task row names no output files, so none are listed; add them if the detail ever carries them.
      return <Row sq="ok">{t.latest_summary ?? "Done."}</Row>;
    case "archived":
      return <Row sq="">Archived.</Row>;
    default:
      return <Row sq="">{KANBAN_LANES[KANBAN_LANE_INDEX[t.status] ?? 0]?.hint}</Row>;
  }
}

export function KanbanTaskBlock({
  block,
  instance: given,
}: {
  block: ChatBlockOf<"tool">;
  instance?: string;
}) {
  const { open } = useOpenKanbanTask();
  const context = useProcessEvents().instance;
  const instance = given || context;
  const card = readKanbanCreateResult(block);
  const id = card?.task_id ?? null;
  const [detail, setDetail] = useState<KanbanTaskDetailView | null>(null);
  /** When the last good read landed (s), and how the latest one failed; the last good detail stays drawn. */
  const [readAt, setReadAt] = useState<number | null>(null);
  const [failed, setFailed] = useState<null | "unanswered" | "unreadable">(null);
  /** The board said this task is not found: the card was deleted, and nothing will bring it back. */
  const [gone, setGone] = useState(false);
  const settled = gone || detail?.task.status === "done" || detail?.task.status === "archived";

  useEffect(() => {
    if (!id || !instance || settled) return;
    const ctl = new AbortController();
    // One read at a time: core's deadline outlasts the poll, and overlapping reads land out of order.
    let busy = false;
    /** No read before this (ms): a card the board would not hand over is retried at the slow rate. */
    let notBefore = 0;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        setDetail(await kanbanTask({ instance, id }, ctl.signal));
        setReadAt(Date.now() / 1000);
        setFailed(null);
        notBefore = 0;
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (!(e instanceof ApiError && e.code === "NOT_FOUND")) setFailed("unanswered");
        // Only the task's own 404 (`task <id> not found`) is a deletion; a plugin turned
        // off, a destroyed box or another board answer NOT_FOUND too, and may come back.
        else if (e.message.includes(`task ${id} not found`)) setGone(true);
        else {
          setFailed("unreadable");
          notBefore = Date.now() + UNREADABLE_POLL_MS;
        }
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(() => {
      if (isVisible() && Date.now() >= notBefore) void read();
    }, POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(timer);
    };
  }, [id, instance, settled]);

  if (!card) return null;
  const onOpen = () => {
    if (instance) open(instance, card.task_id);
  };
  const t = detail?.task ?? null;
  const argTitle = (block.args as { title?: unknown } | null)?.title;
  const title = t?.title ?? (typeof argTitle === "string" ? argTitle : "");
  const tone = t ? kanbanTone(t) : "none";
  const lane = t ? (KANBAN_LANE_INDEX[t.status] ?? -1) : -1;
  // A box that stopped answering: core answered from its cache, or our own read failed.
  const staleSince = detail?.stale_since ?? (failed ? readAt : null);
  const stale = !gone && (failed !== null || (detail?.stale_since ?? null) !== null);
  const updated = gone
    ? ""
    : t
      ? t.status === "done" && t.completed_at
        ? `completed ${ago(t.completed_at)}`
        : `updated ${ago(t.last_heartbeat_at ?? t.started_at ?? t.created_at)}`
      : "";

  return (
    <section
      className={`ch-kt ${tone}${stale ? " stale" : ""}`}
      data-task-id={card.task_id}
      aria-label={`Task ${card.task_id}`}
    >
      <div className="ch-kt-h">
        <span className="kicker">Task</span>
        <span className="ch-kt-id">{card.task_id}</span>
        {t ? (
          <span className={`ch-kt-st ${tone}`}>
            <span className={`sq ${tone}${t.status === "running" && !stale ? " pulse" : ""}`} />
            {kanbanStatusWord(t)}
          </span>
        ) : null}
        {instance ? (
          <button type="button" className="btn ch-kt-btn ch-kt-open" onClick={onOpen}>
            Open
          </button>
        ) : null}
      </div>
      {title ? <div className="ch-kt-t">{title}</div> : null}
      {t ? (
        <div className="ch-kt-meta">
          <span>{t.assignee ? `@${t.assignee}` : "unassigned"}</span>
          <span>{workspace(t)}</span>
          {t.priority > 0 ? <span>{`P${t.priority}`}</span> : null}
          <span>{`${detail?.runs.length ?? 0} run${detail?.runs.length === 1 ? "" : "s"}`}</span>
        </div>
      ) : null}
      {t ? (
        <div className="ch-kt-track">
          <div className="ch-kt-cells">
            {KANBAN_LANES.map((l, j) => (
              <span key={l.id} className={j < lane ? "done" : j === lane ? `cur ${tone}` : undefined} />
            ))}
          </div>
          <div className="ch-kt-labels">
            {KANBAN_LANES.map((l, j) => (
              <span key={l.id} className={j === lane ? "cur" : undefined}>
                {l.label}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="ch-kt-live">
        {failed === "unreadable" ? (
          <Row sq="warn">{`This card is not readable on ${instance} — its board may be off or elsewhere.`}</Row>
        ) : stale ? (
          <Row sq="warn">
            {`${instance} is not answering${staleSince !== null ? ` — last read ${ago(staleSince)}` : ""}.`}
          </Row>
        ) : null}
        {gone ? (
          <Row sq="">This card was deleted from the board.</Row>
        ) : detail ? (
          <Live detail={detail} instance={instance} onOpen={onOpen} />
        ) : stale ? null : (
          <Row sq="">Reading the card…</Row>
        )}
      </div>
      <div className="ch-kt-f">
        {/* shortcut: the detail does not name its board, so this assumes the default one; read it from the detail once it carries the slug. */}
        <span>{`${instance} · board default`}</span>
        <span>{updated}</span>
      </div>
    </section>
  );
}
