/**
 * Delegated children inline (WI-14, Option C): one line per child under the
 * `delegate_task` call that spawned it, and nothing else in the thread.
 *
 * A line is a status glyph, the goal, what the child is doing (its latest tool
 * call while it runs, the first line of its summary once done, its failure
 * text when it failed), a timer and an `OPEN ↗` button. The child's run — every
 * tool call, its progress and thinking, its result — is in the modal
 * (`SubagentModal.tsx`), and so are Steer and Stop: a dense list of lines is
 * no place for a destructive control, and the composer's Stop keeps its
 * turn-wide meaning. Grandchildren are flattened into the same list with a
 * `depth N` tag (Q3).
 *
 * A line fades in once: on the first render that ever drew its child, and
 * only for a live child. A re-mount — the thread re-read, the group re-keyed,
 * the conversation left and come back to — draws it still.
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { ChatBlockView } from "../../../api/index.ts";
import {
  activityOf,
  dispatchedOnly,
  elapsedOf,
  glyphOf,
  settled,
  spanText,
  clockText,
  timeText,
} from "../../chat-subagents.ts";
import type { SubagentView } from "../../chat-subagents.ts";
import { RedactedText } from "../RedactedText.tsx";

export interface SubagentScopeValue {
  /** Open a child's modal. `null` where no thread is around to hold one. */
  open: ((subagentId: string) => void) | null;
  /** The results turn of each background delegation, by delegation id (`delegationResults`). */
  results: ReadonlyMap<string, string>;
}

export const SubagentContext = createContext<SubagentScopeValue>({
  open: null,
  results: new Map(),
});

/** Every child id a line has been drawn for in this page, so a line enters once. */
const drawn = new Set<string>();
const DRAWN_MAX = 2048;

/**
 * Whether this mount is the first time `id` was ever drawn. Decided once per
 * mount in a pure initializer and recorded after commit, so a double render
 * agrees with itself and every later mount of the same child draws it still.
 */
function useFirstDraw(block: SubagentView): boolean {
  const [first] = useState(() => block.origin === "live" && !drawn.has(block.subagent_id));
  useEffect(() => {
    drawn.add(block.subagent_id);
    if (drawn.size > DRAWN_MAX) drawn.delete(drawn.values().next().value as string);
  }, [block.subagent_id]);
  return first;
}

/** Wall-clock time, re-read every second while `active`; for a running child's timer. */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

const running = (block: SubagentView): boolean => block.verdict === "running" && !dispatchedOnly(block);

/** Scroll to the results turn of a background delegation, and land focus on it. */
function jumpTo(messageId: string): void {
  const target = Array.from(
    document.querySelectorAll<HTMLElement>("[data-chat-ids], [data-chat-message]"),
  ).find(
    (el) =>
      el.dataset.chatMessage === messageId || (el.dataset.chatIds ?? "").split(" ").includes(messageId),
  );
  target?.scrollIntoView?.({ block: "center" });
  target?.focus?.({ preventScroll: true });
}

export function SubagentLine({ block }: { block: SubagentView }) {
  const { open, results } = useContext(SubagentContext);
  const first = useFirstDraw(block);
  const live = running(block);
  const now = useTicker(live);
  const glyph = glyphOf(block);
  const activity = activityOf(block);
  const result =
    dispatchedOnly(block) && block.delegation_id ? results.get(block.delegation_id) : undefined;
  const goal = block.goal || "Subagent";
  const className = [
    "sa-line",
    live ? "run" : "",
    block.verdict === "failed" ? "bad" : "",
    first ? "sa-enter" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} data-subagent-id={block.subagent_id} data-verdict={block.verdict}>
      <span className={`sa-glyph ch-activity-glyph ${glyph.tone}`} role="img" aria-label={glyph.word}>
        {glyph.glyph}
      </span>
      {block.depth > 0 ? <span className="sa-depth">{`depth ${block.depth + 1}`}</span> : null}
      <span className="sa-goal" title={goal}>
        <RedactedText text={goal} />
      </span>
      {activity.kind === "tool" ? (
        <span className="sa-act tool" title={`${activity.name} ${activity.text}`}>
          {"↳ "}
          <span className="tn">{activity.name}</span> <RedactedText text={activity.text} />
        </span>
      ) : (
        <span className={`sa-act ${activity.kind}`} title={activity.text}>
          <RedactedText text={activity.text} />
        </span>
      )}
      {result ? (
        <button type="button" className="ch-ev-jump sa-result-link" onClick={() => jumpTo(result)}>
          result ↓
        </button>
      ) : null}
      <span className={`sa-time${live ? " live" : ""}`}>{timeText(block, now)}</span>
      {open ? (
        <button
          type="button"
          className="sa-open"
          data-subagent-open={block.subagent_id}
          aria-label={`Open subagent: ${goal}`}
          aria-haspopup="dialog"
          onClick={() => open(block.subagent_id)}
        >
          OPEN ↗
        </button>
      ) : null}
    </div>
  );
}

/** How many tasks a delegation asked for: the call's own count, else the children drawn. */
export function taskCount(blocks: readonly SubagentView[]): number {
  const top = blocks.filter((b) => b.depth === 0);
  return Math.max(top.length, ...top.map((b) => b.task_count), 1);
}

/** `k of N done`, and the delegation's elapsed time: the longest child's. */
export function delegationFacts(blocks: readonly SubagentView[], now: number) {
  const top = blocks.filter((b) => b.depth === 0);
  const total = taskCount(blocks);
  const done = top.filter(settled).length;
  const live = blocks.some(running);
  const longest = Math.max(0, ...blocks.map((b) => elapsedOf(b, now) ?? 0));
  return { total, done, live, elapsed: live ? clockText(longest) : longest ? spanText(longest) : "" };
}

/**
 * One delegation's children. More than one task gets the one-line header
 * "Delegated N tasks · k of N done · elapsed"; a single child is its line.
 */
export function SubagentGroup({ blocks }: { blocks: readonly SubagentView[] }) {
  const live = blocks.some(running);
  const now = useTicker(live);
  if (blocks.length === 0) return null;
  const facts = delegationFacts(blocks, now);
  return (
    <div className="sa-group">
      {facts.total > 1 ? (
        <div className="sa-head">
          <span className="sa-head-t">{`Delegated ${facts.total} tasks`}</span>
          <span className="sa-head-f">
            {[`${facts.done} of ${facts.total} done`, facts.elapsed].filter(Boolean).join(" · ")}
          </span>
        </div>
      ) : null}
      {blocks.map((block) => (
        <SubagentLine key={block.subagent_id} block={block} />
      ))}
    </div>
  );
}

/** A child drawn outside any run group: the generic block switch's case. */
export function SubagentBlock({ block }: { block: ChatBlockView }) {
  return block.kind === "subagent" ? <SubagentGroup blocks={[block]} /> : null;
}
