/**
 * One kanban card (§9.2): an overlay drawer over any view (`TaskDrawer`), or
 * the queue's inline pane (`TaskPanel inline`). Header pill, lane track, then
 * Overview · Activity · Runs · Worker log, and a footer with the CLI echo and
 * Move / Archive / Delete. Every write re-reads the card and the board.
 */
import { useEffect, useId, useRef, useState } from "react";
import { KANBAN_LANES } from "@hermetic/core/shared";
import {
  kanbanArchive,
  kanbanAssign,
  kanbanComment,
  kanbanDelete,
  kanbanLog,
  kanbanMove,
  kanbanUnblock,
} from "../api/chat.ts";
import type { KanbanLogView, KanbanTaskDetailView } from "../api/chat.ts";
import { Drawer } from "../components/Drawer.tsx";
import { Popover } from "../components/Popover.tsx";
import { fmtDuration } from "../logic/format.ts";
import { CreateTaskDrawer } from "./CreateTaskDrawer.tsx";
import { Pill, ScratchGone, Track, ago, cliEcho } from "./parts.tsx";
import { useTaskDetail, useWork } from "./work-state.tsx";
import type { TaskRef } from "./work-state.tsx";

type Tab = "overview" | "activity" | "runs" | "log";
type Detail = KanbanTaskDetailView;
type Task = Detail["task"];
type MoveStatus = Parameters<typeof kanbanMove>[0]["status"];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The overlay drawers, drawn by `WorkProvider` after the page. */
export function WorkOverlays() {
  const work = useWork();
  if (work.create) return <CreateTaskDrawer instance={work.create.instance} />;
  return work.drawer ? <TaskDrawer taskRef={work.drawer} onClose={work.closeTask} /> : null;
}

/** The overlay: drawn at `App` level so a chat notice can raise it over any view. */
export function TaskDrawer({ taskRef, onClose }: { taskRef: TaskRef; onClose: () => void }) {
  const titleId = useId();
  return (
    <Drawer width={640} className="wk-drawer" onClose={onClose} labelledBy={titleId}>
      <TaskPanel
        key={`${taskRef.instance}/${taskRef.id}`}
        taskRef={taskRef}
        onClose={onClose}
        titleId={titleId}
      />
    </Drawer>
  );
}

export function TaskPanel({
  taskRef,
  onClose,
  inline = false,
  titleId,
}: {
  taskRef: TaskRef;
  /** Closes the overlay, or clears the queue's selection once the card is gone. */
  onClose: () => void;
  inline?: boolean;
  titleId?: string;
}) {
  const work = useWork();
  const { detail, error, reload } = useTaskDetail(taskRef);
  const { instance, id } = taskRef;
  const inst = work.board?.instances.find((i) => i.instance === instance) ?? null;
  const [tab, setTab] = useState<Tab>("overview");
  const [cli, setCli] = useState(cliEcho("task", { instance, id }));
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** One write: echo it, send it, re-read the card (or close when it is gone) and the board. */
  async function run<I extends object>(
    verb: string,
    call: (input: I) => Promise<unknown>,
    input: I,
    gone = false,
  ): Promise<boolean> {
    setBusy(true);
    setActError(null);
    setCli(cliEcho(verb, input as Record<string, unknown>));
    try {
      await call(input);
      if (gone) onClose();
      else await reload();
      await work.refresh();
      return true;
    } catch (e) {
      setActError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <div className="wk-dh">
      <div className="wk-dh-l1">
        {detail ? <Pill task={detail.task} stale={detail.stale_since !== null} /> : null}
        <span className="mono dim">{id}</span>
        <span className="wk-chip">{instance}</span>
        {detail?.task.goal_mode ? <span className="wk-chip">◎ goal mode</span> : null}
      </div>
      {inline ? null : (
        <button type="button" className="btn btn-box wk-dh-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      )}
      <h2 className="wk-dh-title" id={titleId}>
        {detail?.task.title ?? (error ? "Could not read this card" : "Reading…")}
      </h2>
      {detail ? <Track task={detail.task} labels /> : null}
    </div>
  );
  if (!detail) {
    return (
      <>
        {head}
        <div className="drawer-body wk-dbody">
          {error ? (
            <div className="callout bad">{error}</div>
          ) : (
            <p className="dim">Reading the card…</p>
          )}
        </div>
      </>
    );
  }

  const t = detail.task;
  const stale = detail.stale_since !== null || inst?.state === "unreachable";
  const off = stale || busy;
  const ref = { instance, id };
  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ["activity", `Activity · ${detail.events.length}`],
    ["runs", `Runs · ${detail.runs.length}`],
    ["log", "Worker log"],
  ];

  return (
    <>
      {head}
      <div className="wk-dtabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="drawer-body wk-dbody">
        {actError ? (
          <div className="callout bad" role="alert">
            {actError}
          </div>
        ) : null}
        {tab === "overview" ? (
          <Overview
            detail={detail}
            stale={stale}
            busy={busy}
            profiles={inst?.profiles ?? []}
            onTab={setTab}
            onOpen={work.openTask}
            unblock={(answer) => run("unblock", kanbanUnblock, answer ? { ...ref, answer } : ref)}
            assign={(profile) => run("assign", kanbanAssign, { ...ref, profile })}
            comment={(body) => run("comment", kanbanComment, { ...ref, body })}
          />
        ) : tab === "activity" ? (
          <Activity detail={detail} />
        ) : tab === "runs" ? (
          <Runs detail={detail} />
        ) : (
          <WorkerLog taskRef={taskRef} />
        )}
      </div>
      <div className="drawer-foot wk-dfoot">
        {confirmDelete ? (
          <div className="wk-cfm">
            <b>Delete {id}?</b> Its comments, activity, runs and worker log are deleted on {instance}.
            Archive hides the card and keeps them.
            <div className="wk-row">
              <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={off}
                onClick={() => void run("archive", kanbanArchive, ref, true)}
              >
                Archive instead
              </button>
              <span className="wk-sp" />
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={off}
                onClick={() =>
                  void run("delete", kanbanDelete, { ...ref, confirm: true as const }, true)
                }
              >
                Delete task
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="mono wk-cli">{cli}</span>
            <div className="wk-row">
              <MoveMenu
                current={t.status}
                disabled={off}
                onMove={(status) => void run("move", kanbanMove, { ...ref, status })}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={off}
                onClick={() => void run("archive", kanbanArchive, ref, true)}
              >
                Archive
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={off}
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function MoveMenu({
  current,
  disabled,
  onMove,
}: {
  current: string;
  disabled: boolean;
  onMove: (status: MoveStatus) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Move to ▾
      </button>
      {open ? (
        <Popover anchor={anchor} onClose={() => setOpen(false)} maxWidth={260} label="Move to">
          <div className="wk-menu">
            {KANBAN_LANES.filter((l) => l.id !== "running").map((l) => (
              <button
                key={l.id}
                type="button"
                disabled={l.id === current}
                onClick={() => {
                  setOpen(false);
                  onMove(l.id as MoveStatus);
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** What the worker asked, from the newest `blocked` event; the summary when it said nothing. */
function blockReason(detail: Detail): string {
  for (const e of [...detail.events].reverse())
    if (e.kind === "blocked" && typeof e.payload.reason === "string") return e.payload.reason;
  return detail.task.latest_summary ?? "";
}

function Overview({
  detail,
  stale,
  busy,
  profiles,
  onTab,
  onOpen,
  unblock,
  assign,
  comment,
}: {
  detail: Detail;
  stale: boolean;
  busy: boolean;
  profiles: string[];
  onTab: (tab: Tab) => void;
  onOpen: (instance: string, id: string) => void;
  unblock: (answer?: string) => Promise<boolean>;
  assign: (profile: string | null) => Promise<boolean>;
  comment: (body: string) => Promise<boolean>;
}) {
  const t = detail.task;
  const [answer, setAnswer] = useState("");
  const [note, setNote] = useState("");
  const off = stale || busy;
  const model = t.model_override
    ? [t.provider_override, t.model_override].filter(Boolean).join(" · ")
    : "profile default";
  return (
    <>
      <StateCallout
        detail={detail}
        stale={stale}
        off={off}
        profiles={profiles}
        answer={answer}
        setAnswer={setAnswer}
        onTab={onTab}
        unblock={async (a) => {
          if (await unblock(a)) setAnswer("");
        }}
        assign={assign}
      />
      <div className="kv wk-kv">
        <span className="k">Assignee</span>
        <span className="v">{t.assignee ?? <span className="wk-warn">unassigned · parked</span>}</span>
        <span className="k">Workspace</span>
        <span className="v">
          {t.workspace_kind}
          {t.workspace_path ? ` · ${t.workspace_path}` : ""}
          {t.branch_name ? ` · ${t.branch_name}` : ""}
          <span className="dim"> — {WORKSPACE_RULE[t.workspace_kind]}</span>
        </span>
        <span className="k">Priority</span>
        <span className="v">
          {t.priority} <span className="dim">— higher runs first</span>
        </span>
        <span className="k">Skills</span>
        <span className="v">{t.skills?.length ? t.skills.join(", ") : "profile default"}</span>
        <span className="k">Model</span>
        <span className="v">{model}</span>
        <span className="k">Goal mode</span>
        <span className="v">
          {t.goal_mode ? `on${t.goal_max_turns ? ` · up to ${t.goal_max_turns} turns` : ""}` : "off"}
        </span>
        <span className="k">Created by</span>
        <span className="v">{t.created_by ?? "—"}</span>
        <span className="k">Created</span>
        <span className="v">{ago(t.created_at)}</span>
      </div>
      <section className="wk-blk">
        <div className="kicker">Description</div>
        <p className="wk-prose">
          {t.body ?? (
            <span className="dim">No description yet — the specifier writes one in Triage.</span>
          )}
        </p>
      </section>
      {t.latest_summary ? (
        <section className="wk-blk">
          <div className="kicker">Latest summary</div>
          <p className="wk-prose">{t.latest_summary}</p>
        </section>
      ) : null}
      {detail.links.children.length ? (
        <section className="wk-blk">
          <div className="kicker">Subtasks · {detail.links.children.length}</div>
          {detail.links.children.map((c) => (
            <button
              key={c.id}
              type="button"
              className="wk-ev wk-link"
              onClick={() => onOpen(detail.instance, c.id)}
            >
              <span className={`sq ${c.status === "done" ? "ok" : "none"}`} />
              <span>
                {c.title} <span className="dim mono">{c.id}</span>
              </span>
              <span className="mono dim">{c.status}</span>
            </button>
          ))}
        </section>
      ) : null}
      <section className="wk-blk">
        <div className="kicker">Comments · {detail.comments.length}</div>
        {detail.comments.map((c) => (
          <div key={c.id} className="wk-comment">
            <div className="mono dim">
              {c.author || "—"} · {ago(c.created_at)}
            </div>
            <p className="wk-prose">{c.body}</p>
          </div>
        ))}
        <form
          className="wk-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            void comment(note.trim()).then((ok) => ok && setNote(""));
          }}
        >
          <input
            className="wiz-input wk-grow"
            value={note}
            disabled={off}
            aria-label="Add a comment"
            placeholder="Add a comment — the worker sees it on its next turn"
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={off || !note.trim()}>
            Comment
          </button>
        </form>
      </section>
    </>
  );
}

const WORKSPACE_RULE: Record<Task["workspace_kind"], string> = {
  dir: "always kept",
  worktree: "kept unless clean and pushed",
  scratch: "deleted on completion",
};

/** What the card is waiting on, by status; the actions here are the ones that unstick it. */
function StateCallout({
  detail,
  stale,
  off,
  profiles,
  answer,
  setAnswer,
  onTab,
  unblock,
  assign,
}: {
  detail: Detail;
  stale: boolean;
  off: boolean;
  profiles: string[];
  answer: string;
  setAnswer: (v: string) => void;
  onTab: (tab: Tab) => void;
  unblock: (answer?: string) => Promise<void>;
  assign: (profile: string | null) => Promise<boolean>;
}) {
  const t = detail.task;
  const inst = detail.instance;
  if (stale)
    return (
      <div className="callout warn">
        Last read {ago(detail.stale_since)} — {inst} is not answering. Read-only until it is back.
      </div>
    );
  switch (t.status) {
    case "blocked":
      if (t.block_kind === "gave_up")
        return (
          <div className="callout bad">
            <b>Gave up after {t.consecutive_failures || "repeated"} crashes.</b> {t.last_failure_error}
            <div className="wk-row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={off}
                onClick={() => void unblock()}
              >
                Retry
              </button>
              <button type="button" className="btn btn-sm" onClick={() => onTab("log")}>
                Worker log
              </button>
            </div>
          </div>
        );
      return (
        <div className="callout warn">
          <b>{t.assignee ?? "The worker"} is asking:</b> {blockReason(detail)}
          <textarea
            className="wiz-input wk-answer"
            value={answer}
            disabled={off}
            aria-label="Your answer"
            placeholder="Your answer — posted as a comment, then the card goes back to Ready"
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="wk-row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={off || !answer.trim()}
              onClick={() => void unblock(answer.trim())}
            >
              Answer &amp; unblock
            </button>
            <button type="button" className="btn btn-sm" disabled={off} onClick={() => void unblock()}>
              Unblock without answering
            </button>
          </div>
        </div>
      );
    case "ready":
      if (!t.assignee)
        return (
          <div className="callout warn">
            <b>Parked — no assignee, so nothing will run it.</b> Pick a profile on {inst}:
            <div className="wk-row">
              {profiles.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="btn btn-sm"
                  disabled={off}
                  onClick={() => void assign(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        );
      return (
        <div className="callout info">
          Waiting for a worker. The dispatcher on {inst} ticks every 60s.
        </div>
      );
    case "triage":
      return (
        <div className="callout info">
          The specifier is rewriting this into a spec, then promotes it to Todo.
        </div>
      );
    case "todo": {
      const parent = detail.links.parents[0];
      return (
        <div className="callout info">
          {parent ? (
            <>
              Waits on <span className="mono">{parent.id}</span> · {parent.title}.
            </>
          ) : (
            "Waits on the cards it depends on."
          )}{" "}
          It moves to Ready when that is done.
        </div>
      );
    }
    case "scheduled": {
      const why = [...detail.events].reverse().find((e) => e.kind === "scheduled")?.payload.reason;
      return (
        <div className="callout info">
          {typeof why === "string" ? `${why}.` : "Waiting on time, not on anyone."}
        </div>
      );
    }
    case "running":
      return (
        <div className="callout">
          <span className="sq acc pulse" />
          Running for {t.started_at ? fmtDuration(Date.now() - t.started_at * 1000) : "—"} · last
          heartbeat {ago(t.last_heartbeat_at)}
          {t.goal_mode && t.goal_max_turns ? ` · goal mode, up to ${t.goal_max_turns} turns` : ""}.
        </div>
      );
    case "review":
      return <div className="callout">A reviewer agent is checking the work.</div>;
    case "done":
      if (t.workspace_kind === "scratch")
        return (
          <div className="callout warn">
            <ScratchGone />
          </div>
        );
      return (
        <div className="callout ok">
          Done {ago(t.completed_at)}. Output kept in{" "}
          <span className="mono">{t.workspace_path ?? "its workspace"}</span>.
        </div>
      );
  }
  return null;
}

const EVENT_TONE: Record<string, string> = {
  crashed: "bad",
  gave_up: "bad",
  blocked: "warn",
  completed: "ok",
  claimed: "acc",
  worker_started: "acc",
};

function eventDetail(payload: Record<string, unknown>): string {
  for (const k of ["detail", "reason", "status", "assignee", "author"])
    if (typeof payload[k] === "string") return payload[k];
  return "";
}

function Activity({ detail }: { detail: Detail }) {
  if (!detail.events.length) return <p className="dim">No activity yet.</p>;
  return (
    <>
      {[...detail.events].reverse().map((e) => (
        <div key={e.id} className="wk-ev">
          <span className={`sq ${EVENT_TONE[e.kind] ?? "none"}`} />
          <span>
            {e.kind.replaceAll("_", " ")} <span className="dim">{eventDetail(e.payload)}</span>
          </span>
          <span className="mono dim">{ago(e.created_at)}</span>
        </div>
      ))}
    </>
  );
}

function Runs({ detail }: { detail: Detail }) {
  if (!detail.runs.length)
    return <p className="dim">No runs yet. A run starts when a worker claims the card.</p>;
  return (
    <>
      {detail.runs.map((r) => (
        <div key={r.id} className="wk-run">
          <span className="mono dim">#{r.id}</span>
          <span className="mono">{r.outcome ?? r.status}</span>
          <span className="mono">
            {r.profile ?? "—"}
            {r.started_at && r.ended_at ? ` · ${fmtDuration((r.ended_at - r.started_at) * 1000)}` : ""}
          </span>
          <span className="mono dim">{ago(r.started_at)}</span>
          {r.summary ? <div className="wk-run-x">{r.summary}</div> : null}
          {r.error ? <div className="wk-run-x mono wk-bad">{r.error}</div> : null}
        </div>
      ))}
    </>
  );
}

function WorkerLog({ taskRef }: { taskRef: TaskRef }) {
  const [log, setLog] = useState<KanbanLogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { instance, id } = taskRef;
  useEffect(() => {
    const controller = new AbortController();
    kanbanLog({ instance, id }, controller.signal)
      .then((l) => !controller.signal.aborted && setLog(l))
      .catch((e) => !controller.signal.aborted && setError(message(e)));
    return () => controller.abort();
  }, [instance, id]);
  if (error) return <div className="callout bad">{error}</div>;
  if (!log) return <p className="dim">Reading the worker log…</p>;
  if (!log.exists) return <p className="dim">No worker has run yet.</p>;
  return (
    <>
      <div className="kicker">
        {id}.log{log.truncated ? " · tail" : ""}
      </div>
      <pre className="logpane wk-log">{log.content}</pre>
    </>
  );
}
