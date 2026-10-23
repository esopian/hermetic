/**
 * The whole task list, over the top of the thread (§9.2 Task list): the tree of
 * items with a status square each, and where the list came from. It overlays
 * the transcript rather than pushing it, so opening it never moves the reader.
 */
import type { TodoFound, TodoItemLike, TodoLifecycle } from "@hermetic/core/shared";
import { todoTree } from "../task-list.ts";
import { jumpToMessage } from "../thread-jump.ts";
import { RedactedText } from "./RedactedText.tsx";

const CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const STAMP = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const MARK: Record<string, string> = { done: "✓", cancelled: "×" };
const STATE: Record<string, string> = {
  done: "done",
  active: "in progress",
  pending: "pending",
  cancelled: "cancelled",
};

function stamp(format: Intl.DateTimeFormat, iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "—" : format.format(at);
}

function Items({
  items,
  tree,
  pulse,
  sub = false,
}: {
  items: readonly TodoItemLike[];
  tree: ReadonlyMap<string, TodoItemLike[]>;
  pulse: boolean;
  sub?: boolean;
}) {
  return (
    <ul className={sub ? "tl-tree tl-sub" : "tl-tree"}>
      {items.map((item) => {
        const kids = tree.get(item.id);
        return (
          <li key={item.id}>
            <div className={`tl-item ${item.status}`}>
              <i className={`tl-sq ${item.status}${pulse ? " live" : ""}`} aria-hidden="true">
                {MARK[item.status] ?? ""}
              </i>
              <span className="tl-text">
                <span className="sr-only">{STATE[item.status] ?? item.status}: </span>
                <RedactedText text={item.content} />
              </span>
            </div>
            {kids ? <Items items={kids} tree={tree} pulse={pulse} sub /> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function TaskSheet({
  found,
  life,
  onClose,
}: {
  found: TodoFound;
  life: TodoLifecycle;
  onClose: () => void;
}) {
  const todos = found.snapshot.todos;
  const { roots, children } = todoTree(todos);
  const rev = found.snapshot.revision;
  return (
    <section className="tl-sheet" aria-label="Task list">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll from the keyboard */}
      <div className="tl-sheet-body" role="region" aria-label="Task list items" tabIndex={0}>
        <Items items={roots} tree={children} pulse={life.pulse} />
      </div>
      <div className="tl-sheet-foot mono">
        <span>
          {life.pulse
            ? ["live", rev === null ? null : `rev ${rev}`, stamp(CLOCK, found.at)]
                .filter(Boolean)
                .join(" · ")
            : `last known · from history · ${stamp(STAMP, found.at)}`}
        </span>
        <button
          type="button"
          className="tl-link"
          onClick={() => {
            onClose();
            void jumpToMessage(found.first_message_id, { block: "center" });
          }}
        >
          Jump to where it was planned ↑
        </button>
        <button type="button" className="tl-link tl-close" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
