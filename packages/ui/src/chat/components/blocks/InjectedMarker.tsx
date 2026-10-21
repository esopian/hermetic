/**
 * An injected event drawn as a marker between turns (`isMarkerEvent`): a cron
 * or webhook delivery, a heartbeat, a `/loop` wakeup, a handoff, a resumed
 * turn, a compaction, a carried-over task list, a model switch.
 *
 * Hermes stores each as the user's row; nobody typed it, and it is not work
 * the bot did either, so it is neither a message nor a gutter row. It is a
 * boundary in the conversation: a centred `ch-divider`-style line — what
 * happened, a qualifier, when — with its payload one click away in a centred
 * fold under it. The bot's reply after it names it in its own header
 * (`re: …`, `threadItems`).
 */
import type { ReactNode } from "react";
import { fmtClock } from "../../../logic/format.ts";
import { markerView } from "../../process-events.ts";
import type { EventEntry, ProcessEventView } from "../../process-events.ts";
import { RedactedText } from "../RedactedText.tsx";
import { Output } from "./ProcessEvent.tsx";

type Task = NonNullable<NonNullable<ProcessEventView["notice"]>["tasks"]>[number];

const GLYPH: Record<Task["status"], string> = {
  done: "✓",
  active: "▶",
  pending: "○",
  cancelled: "⊘",
  unknown: "?",
};

/** A carried-over task list as a checklist card, nested by depth, the active item highlighted. */
function TaskList({ tasks }: { tasks: readonly Task[] }) {
  return (
    <ul className="ch-tasks">
      {tasks.map((task, index) => (
        <li
          key={index}
          className={`st-${task.status}`}
          data-status={task.status}
          style={{ paddingLeft: 8 + task.depth * 18 }}
        >
          <span className="g" role="img" aria-label={task.status}>
            {GLYPH[task.status]}
          </span>
          <span className="tx">
            <RedactedText text={task.text} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Fold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="ch-ev-more">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

/** The payload under the marker, folded; null when the notice carried none. */
function MarkerFold({ event }: { event: ProcessEventView }) {
  const body = event.notice?.body;
  const tasks = event.notice?.tasks;
  if (event.event === "todo" && tasks && tasks.length > 0)
    return (
      <Fold label="view tasks">
        <div className="ch-taskcard">
          <TaskList tasks={tasks} />
        </div>
      </Fold>
    );
  if (event.output_tail) return <Output event={event} />;
  if (body)
    return (
      <Fold label={event.event === "compaction" ? "view summary" : "show"}>
        <pre className="ch-ev-tail">
          <RedactedText text={body} />
        </pre>
      </Fold>
    );
  return null;
}

export function InjectedMarker({
  entry,
}: {
  entry: Pick<EventEntry, "event"> & { row: { message: { id: string; at: string } } };
}) {
  const { event } = entry;
  const message = entry.row.message;
  const view = markerView(event);
  return (
    <div
      className="ch-marker-row"
      data-chat-message={message.id}
      data-process-event={event.event}
      data-outcome={event.outcome}
    >
      <div className={`ch-divider ch-marker${view.tone ? ` ${view.tone}` : ""}`}>
        <hr />
        <span>
          <RedactedText text={view.text} />
          {view.sub ? (
            <span className="ch-marker-sub">
              {" · "}
              <RedactedText text={view.sub} />
            </span>
          ) : null}
          {` · ${fmtClock(message.at)}`}
        </span>
        <hr />
      </div>
      <div className="ch-marker-more">
        <MarkerFold event={event} />
      </div>
    </div>
  );
}
