/**
 * The small pieces every kanban surface draws: the status pill, the lane
 * track, the assignee tag and the CLI echo. Colour by meaning comes from
 * `kanbanTone` (`@hermetic/core/shared`), never chosen here.
 */
import { KANBAN_LANES, KANBAN_LANE_INDEX, kanbanStatusWord, kanbanTone } from "@hermetic/core/shared";
import type { KanbanTaskLike } from "@hermetic/core/shared";
import { relative } from "../chat/routine-schedule.ts";

/** `5 min. ago` for an upstream timestamp in seconds; `—` when there is none. */
export function ago(sec: number | null | undefined): string {
  return sec ? relative(sec * 1000, Date.now()) : "—";
}

export function Pill({ task, stale = false }: { task: KanbanTaskLike; stale?: boolean }) {
  const tone = kanbanTone(task);
  return (
    <span className={`wk-pill ${tone}`}>
      <span className={`sq ${tone}${task.status === "running" && !stale ? " pulse" : ""}`} />
      {kanbanStatusWord(task)}
    </span>
  );
}

/** Where the card sits in the lane order; `labels` names each lane under it. */
export function Track({ task, labels = false }: { task: KanbanTaskLike; labels?: boolean }) {
  const at = KANBAN_LANE_INDEX[task.status] ?? -1;
  const tone = kanbanTone(task);
  return (
    <div className="wk-track-wrap">
      <div className="wk-track" aria-hidden="true">
        {KANBAN_LANES.map((l, j) => (
          <span key={l.id} className={j < at ? "done" : j === at ? `cur ${tone}` : undefined} />
        ))}
      </div>
      {labels ? (
        <div className="wk-tracklbl">
          {KANBAN_LANES.map((l, j) => (
            <span key={l.id} className={j === at ? "cur" : undefined}>
              {l.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Who({ name }: { name: string | null }) {
  return name ? (
    <span className="wk-who">
      <i>{name[0]}</i>
      {name}
    </span>
  ) : (
    <span className="wk-who wk-warn">unassigned</span>
  );
}

/** A done card that ran in scratch: upstream deletes the workspace on completion, and its files with it. */
export function ScratchGone() {
  return (
    <>
      <b>The output is gone.</b> This ran in a scratch workspace, which is deleted on completion.
    </>
  );
}

/** The CLI command that does what the drawer just did. */
export function cliEcho(verb: string, input: Record<string, unknown>): string {
  return `$ hermetic kanban ${verb} --input '${JSON.stringify(input)}'`;
}
