/**
 * The task list pinned under the thread header (§9.2 Task list): one fixed-height
 * strip whatever the list's length. Once the work is paused or finished it folds
 * to one line (status square, fraction, the next item or `✓ done`) over the
 * segmented bar. Clicking it opens `TaskSheet` over the top of the transcript.
 */
import type { KeyboardEvent } from "react";
import { todoFraction, todoRunning, todoSummary } from "@hermetic/core/shared";
import type { TodoItemLike, TodoLifecycle, TodoSnapshotLike } from "@hermetic/core/shared";
import { taskCells, taskNow, taskTitle } from "../task-list.ts";
import type { TaskList } from "../task-list.ts";
import { RedactedText } from "./RedactedText.tsx";
import { TaskSheet } from "./TaskSheet.tsx";

/** The segmented bar: one cell per item not cancelled. `pulse` animates the running cell. */
export function TaskBar({
  snapshot,
  pulse,
  className = "tl-bar",
}: {
  snapshot: TodoSnapshotLike;
  pulse: boolean;
  className?: string;
}) {
  return (
    <span className={`${className}${pulse ? " live" : ""}`} aria-hidden="true">
      {taskCells(snapshot).map((status, i) => (
        // Cells have no identity beyond their place in the list.
        <i key={i} className={status} />
      ))}
    </span>
  );
}

/** The item a strip names, `parent › item` for a subtask, ellipsised. */
function NowItem({
  now,
  glyph,
}: {
  now: { item: TodoItemLike; parent: TodoItemLike | null };
  glyph: string;
}) {
  return (
    <span className="tl-now">
      {glyph}
      {now.parent ? (
        <span className="tl-parent">
          <RedactedText text={now.parent.content} />
          {" › "}
        </span>
      ) : null}
      <RedactedText text={now.item.content} />
    </span>
  );
}

export function TaskStrip({ tasks }: { tasks: TaskList }) {
  const { found, life, open, setOpen, hide } = tasks;
  if (!found || (!life.strip && !open)) return null;
  const snapshot = found.snapshot;
  const { done, total } = todoFraction(snapshot);
  const summary = todoSummary(snapshot.todos);
  const counts = `${done} of ${total} done`;
  const running = todoRunning(snapshot);
  // The name says what the line shows, so a screen reader hears the state too.
  const label =
    life.strip === "full"
      ? `Task list, ${counts}, ${running ? `working on ${running.item.content}` : summary}`
      : life.strip === "paused"
        ? `Task list, ${counts}, ${summary}, paused${life.aged ? `, untouched ${life.aged}` : ""}`
        : `Task list finished, ${counts}${life.cancelled ? `, ${life.cancelled} cancelled` : ""}`;
  const toggle = () => setOpen(!open);
  // Esc anywhere in the strip or the sheet closes it, before the composer's Esc (Stop) sees it.
  const closeOnEsc = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
  };
  const caret = <span className="tl-caret">{open ? "▴" : "▾"}</span>;
  let strip = null;
  if (life.strip === "full") {
    strip = (
      <button
        type="button"
        className="tl-strip"
        aria-expanded={open}
        aria-label={label}
        onClick={toggle}
      >
        <span className="kicker">Tasks</span>
        <span className="tl-frac mono">{`${done}/${total}`}</span>
        <span className="tl-mid">
          <TaskBar snapshot={snapshot} pulse={life.pulse} />
          {running ? (
            <NowItem now={running} glyph={life.pulse ? "▶ " : "▷ "} />
          ) : (
            <span className="tl-now idle">{summary}</span>
          )}
        </span>
        <span className="tl-sum mono">
          {summary} {caret}
        </span>
      </button>
    );
  } else if (life.strip) {
    // Folded: one line over the bar, which carries the counts the full strip spells out.
    const paused = life.strip === "paused";
    const next = paused ? taskNow(snapshot) : null;
    strip = (
      <div className={`tl-strip folded ${life.strip}`}>
        <div className="tl-fold">
          <button
            type="button"
            className="tl-line"
            aria-expanded={open}
            aria-label={label}
            onClick={toggle}
          >
            <i className="tl-mark" aria-hidden="true" />
            {paused ? (
              <>
                <span className="tl-frac mono">{`${done}/${total}`}</span>
                {next ? <NowItem now={next} glyph="▷ " /> : <span className="tl-now" />}
                <span className="tl-meta mono">
                  {["paused", life.aged].filter(Boolean).join(" · ")}
                </span>
              </>
            ) : (
              <>
                <span className="tl-frac mono tl-ok">{`✓ ${done}/${total} done`}</span>
                <span className="tl-note">clears when you send</span>
              </>
            )}
          </button>
          {paused ? (
            <button type="button" className="ch-chip tl-hide" onClick={hide}>
              Hide
            </button>
          ) : null}
          {/* After Hide, at the right edge; the stretched line button takes its clicks. */}
          <span className="tl-caret" aria-hidden="true">
            {open ? "▴" : "▾"}
          </span>
        </div>
        <TaskBar snapshot={snapshot} pulse={false} />
      </div>
    );
  }
  return (
    <div className="tl-pin" role="group" aria-label="Tasks" onKeyDown={closeOnEsc}>
      {strip}
      {open ? <TaskSheet found={found} life={life} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** A rail row's progress: a 3px bar along its bottom edge, its counts in the title. */
export function RailTaskBar({ snapshot, life }: { snapshot: TodoSnapshotLike; life: TodoLifecycle }) {
  return (
    <span className={`tl-rail ${life.rail}`} title={taskTitle(snapshot, life)}>
      <TaskBar snapshot={snapshot} pulse={life.pulse} className="tl-rail-bar" />
      {/* The row is a button named from its content; a title alone is not read. */}
      <span className="sr-only">, tasks {taskTitle(snapshot, life)}</span>
    </span>
  );
}
