/** Tool work is inspectable without taking the answer or composer off screen. */
import { useState } from "react";
import type { TurnActivity } from "../chat-activity.ts";
import type { ChatBlockOf, ChatBlockView } from "../../api/index.ts";
import { fmtMs, formatPayload, unknownName } from "../chat-logic.ts";
import { toolSummary } from "../chat-turns.ts";
import { backgroundProcessId, processDomId } from "../process-events.ts";
import type { BlockLike } from "../chat-logic.ts";
import { CodePane } from "./Card.tsx";
import { RedactedText } from "./RedactedText.tsx";
import { JumpLink, useProcessEvents } from "./blocks/ProcessEvent.tsx";
import { ToolBlock } from "./blocks/Tool.tsx";
import { SubagentGroup } from "./blocks/Subagent.tsx";
import { dispatchedOnly, isSubagent, subagentLayout } from "../chat-subagents.ts";

export function isActivity(block: ChatBlockView): boolean {
  return ["activity", "tool", "reasoning", "subagent", "unknown"].includes(block.kind);
}

/**
 * Categories that are transport snapshots rather than work the turn did:
 * dialling the socket, waiting for a slot, replaying the conversation, the
 * running token count (`hermes-chat-activity.ts`).
 *
 * `generation` is not one of them wholesale. That category carries both
 * `tool.generating`, which is a snapshot keyed `generation`, and every
 * `subagent.*` and `moa.*` frame, which are delegated work with a summary in
 * `detail` and a terminal `done`/`error` state. Those are steps: treating the
 * category as transport would make a finished subagent vanish, since a status
 * line only ever shows something that is still running.
 */
const STATUS_CATEGORIES = new Set(["connection", "queue", "history", "usage"]);

/**
 * A replaceable status snapshot: it says what is happening *now*, not what the
 * turn did.
 *
 * Upstream Desktop renders thinking as a status label rather than as content
 * (`apps/desktop/src/hooks/use-message-stream/message-stream.ts`), and the same
 * rule has to hold here: a step list that accretes "Connecting to Hermes — In
 * progress" beside a real tool call describes the transport, not the answer,
 * and none of those rows survive into the durable transcript the same turn
 * renders from a minute later. A `status.update` notice keys on `status:…`
 * (`hermesActivity`), which is the thinking/status label upstream sends.
 *
 * Core now mints a `role` field on every activity block it makes
 * (`packages/core/src/schema/chat.ts`) — when present, that is authoritative
 * and the guess below never runs. The category/key heuristic stays only as a
 * fallback for older stored payloads minted before the field existed, and it
 * is a hand-copy of core's rule: `defaultRole` in
 * `packages/core/src/hermes-chat-activity.ts`, plus the two reasoning
 * snapshots `hermes-chat-turn.ts` mints inline (`generation`/`reasoning`,
 * "Thinking…"/"Thinking complete") which are also status. Keep the two in
 * sync — `hermes-chat-activity-role-mirror.test.ts` fails if they drift.
 */
export function isStatusBlock(block: ChatBlockView): boolean {
  if (block.kind !== "activity") return false;
  if (block.role != null) return block.role === "status";
  if (STATUS_CATEGORIES.has(block.category)) return true;
  if (block.category === "generation")
    return block.key === "generation" || block.key === "model:aggregation" || block.key === "reasoning";
  if (block.category === "notice") return /^status(:|$)/.test(block.key);
  return false;
}

export function needsAttention(block: ChatBlockView): boolean {
  return (
    block.kind === "approval" ||
    block.kind === "question" ||
    (block.kind === "activity" && (block.state === "warning" || block.state === "error"))
  );
}

export function ActivityNotice({ block }: { block: ChatBlockOf<"activity"> }) {
  return (
    <div
      className={`ch-activity-notice ${block.state}`}
      role={block.state === "error" ? "alert" : "note"}
    >
      <strong>
        <RedactedText text={block.title} />
      </strong>
      {block.detail ? (
        <span>
          <RedactedText text={block.detail} />
        </span>
      ) : null}
      {block.payload !== undefined ? (
        <details>
          <summary>Details</summary>
          <CodePane text={formatPayload(block.payload)} />
        </details>
      ) : null}
    </div>
  );
}

function label(block: ChatBlockView): string {
  switch (block.kind) {
    case "activity":
      return block.title;
    case "tool":
      return block.name;
    case "reasoning":
      return "Reasoning";
    case "subagent":
      return block.goal || "Subagent";
    default:
      return unknownName(block);
  }
}

function detail(block: ChatBlockView) {
  switch (block.kind) {
    case "tool":
      return (
        <>
          <div className="kicker">Arguments</div>
          <CodePane text={formatPayload(block.args)} />
          <div className="kicker">Result</div>
          <ToolBlock block={block} inline />
        </>
      );
    case "reasoning":
      return (
        <div className="ch-think">
          <RedactedText text={block.text} />
        </div>
      );
    case "activity":
      return (
        <>
          {block.detail ? (
            <p>
              <RedactedText text={block.detail} />
            </p>
          ) : null}
          {block.payload !== undefined ? <CodePane text={formatPayload(block.payload)} /> : null}
        </>
      );
    case "subagent":
      return block.summary ? (
        <p>
          <RedactedText text={block.summary} />
        </p>
      ) : (
        <CodePane text={formatPayload(block.tools)} />
      );
    default:
      return <CodePane text={formatPayload("payload" in block ? block.payload : block)} />;
  }
}

/** A status snapshot replaces its earlier snapshot, while actual tool calls keep their identity. */
export function activityRows(blocks: ChatBlockView[]): ChatBlockView[] {
  const rows: ChatBlockView[] = [];
  const keys = new Map<string, number>();
  for (const block of blocks) {
    const key =
      block.kind === "activity"
        ? `activity:${block.key}`
        : block.kind === "tool" && block.tool_id
          ? `tool:${block.tool_id}`
          : block.kind === "subagent"
            ? `subagent:${block.subagent_id}`
            : null;
    const previous = key === null ? undefined : keys.get(key);
    if (previous !== undefined) rows[previous] = block;
    else {
      if (key !== null) keys.set(key, rows.length);
      rows.push(block);
    }
  }
  return rows;
}

/** What a step says before it is opened: how it went, what it ran, how long. */
function stepStatus(
  block: ChatBlockView,
  streaming: boolean,
): { word: string; tone: "ok" | "bad" | "warn" | "run" | "idle"; glyph: string } {
  if (block.kind === "tool")
    switch (block.status) {
      case "ok":
        return { word: "Complete", tone: "ok", glyph: "\u2713" };
      case "bad":
        return { word: "Failed", tone: "bad", glyph: "\u2715" };
      case "warn":
        return { word: "Needs attention", tone: "warn", glyph: "!" };
      default:
        // Nothing is invented for a call that never came back: a stream that
        // stopped leaves the step unknown, not done.
        return streaming
          ? { word: "Running", tone: "run", glyph: "\u25CF" }
          : { word: "Stopped", tone: "idle", glyph: "\u25CB" };
    }
  if (block.kind === "activity") {
    if (block.state === "done") return { word: "Complete", tone: "ok", glyph: "\u2713" };
    if (block.state === "error") return { word: "Failed", tone: "bad", glyph: "\u2715" };
    if (block.state === "warning") return { word: "Needs attention", tone: "warn", glyph: "!" };
    return streaming
      ? { word: "In progress", tone: "run", glyph: "\u25CF" }
      : { word: "", tone: "idle", glyph: "\u25CB" };
  }
  if (block.kind === "subagent")
    switch (block.verdict) {
      case "done":
        return { word: "Complete", tone: "ok", glyph: "\u2713" };
      case "failed":
        return { word: "Failed", tone: "bad", glyph: "\u2715" };
      case "stopped":
        return { word: "Stopped", tone: "idle", glyph: "\u25CB" };
      case "running":
        return { word: "Running", tone: "run", glyph: "\u25CF" };
      default:
        return { word: "Unknown", tone: "idle", glyph: "?" };
    }
  return { word: "Details", tone: "idle", glyph: "\u00B7" };
}

/**
 * One row of the run.
 *
 * `open` is state rather than a bare attribute so that a reader who closed a
 * step — or opened one — keeps that choice when the turn's next block arrives
 * and re-renders the group around them.
 *
 * Every step starts shut, failures included: the red glyph and the status
 * word already say a call failed, and a turn that retries past a failed call
 * should not push its own prose down under that call's output. The reader
 * opens the ones they want, and nothing reopens or shuts one behind them.
 */
function Step({ block, streaming }: { block: ChatBlockView; streaming: boolean }) {
  const state = stepStatus(block, streaming);
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? false;
  const setOpen = (next: boolean) => setChoice(next);
  const target = block.kind === "tool" ? toolSummary(block) : "";
  const duration = "duration_ms" in block ? fmtMs(block.duration_ms) : "";
  // A call that started a background process links down to the event that
  // reported it, when that event is drawn in the loaded transcript. The step is
  // the anchor the event's "started ↑" comes back to either way.
  const { anchors } = useProcessEvents();
  const pid = backgroundProcessId(block as unknown as BlockLike);
  return (
    <details
      className="ch-activity-step"
      id={pid ? processDomId("start", pid) : undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={`ch-activity-glyph ${state.tone}`} aria-hidden="true">
          {state.glyph}
        </span>
        <span className="ch-activity-name">
          <RedactedText text={label(block)} />
        </span>
        {target ? (
          <span className="ch-activity-target">
            <RedactedText text={target} />
          </span>
        ) : null}
        <span>{[state.word, duration].filter(Boolean).join(" \u00B7 ")}</span>
        {pid && anchors.has(pid) ? (
          <JumpLink end="event" processId={pid}>
            result ↓
          </JumpLink>
        ) : null}
      </summary>
      <div className="ch-activity-detail">{detail(block)}</div>
    </details>
  );
}

export function ActivityGroup({
  blocks,
  streaming,
  waiting = false,
  activity,
}: {
  blocks: ChatBlockView[];
  streaming: boolean;
  waiting?: boolean;
  activity?: TurnActivity;
}) {
  // The run stays on screen after it finishes, collapsed: the summary carries
  // what is happening now, and the reader opens it for the steps. A failed call
  // marks the summary rather than opening the group; see `Step`.
  const [choice, setChoice] = useState<boolean | null>(null);
  const rows = activityRows(blocks);
  if (rows.length === 0) return null;
  // The steps are the work: tool calls, reasoning, anything this build did not
  // recognise. Status snapshots are drawn once, as the line under them.
  // Delegated children are not steps of their own: each is a line under the
  // `delegate_task` call that spawned it (`subagentLayout`), the loose ones at
  // the end of the list.
  const all = rows.filter((block) => !isStatusBlock(block));
  const steps = all.filter((block) => block.kind !== "subagent");
  const kids = all.filter(isSubagent);
  const layout = subagentLayout(all);
  const kidsRunning = kids.filter((kid) => kid.verdict === "running" && !dispatchedOnly(kid)).length;
  const kidsFailed = kids.some((kid) => kid.verdict === "failed");
  const tools = steps.filter((block) => block.kind === "tool");
  // Whether the run's last step is still going. Its name is not read from here
  // — the step itself names it, and so does the status line under the list.
  const latest = steps[steps.length - 1];
  const working =
    !!latest &&
    ((latest.kind === "activity" && latest.state === "running") ||
      (latest.kind === "tool" && latest.status === "running"));
  const usage = [...rows]
    .reverse()
    .find((block) => block.kind === "activity" && block.category === "usage");
  // Never the usage snapshot: usage is the turn's meter, not something that is
  // happening. A live group shows what is happening now; a group that finished
  // shows nothing, so that it is exactly what the durable transcript will draw
  // — unless the snapshot is all the turn has, and dropping it would render an
  // empty group where core's own words were.
  const snapshots = rows.filter(
    (block) => isStatusBlock(block) && block.kind === "activity" && block.category !== "usage",
  );
  const statusLine =
    (streaming
      ? [...snapshots].reverse().find((block) => block.kind === "activity" && block.state === "running")
      : undefined) ?? (steps.length === 0 ? snapshots[snapshots.length - 1] : undefined);
  const failed = tools.some((block) => block.kind === "tool" && block.status === "bad");
  const warning = tools.some((block) => block.kind === "tool" && block.status === "warn");
  // A run that delegated starts open: its children's lines are the one place
  // their progress shows, live or after the turn (Option C). The reader's own
  // choice still wins either way.
  const open = choice ?? kids.length > 0;
  const setOpen = (next: boolean) => setChoice(next);
  // Collapsed and live, the summary says what the turn is doing right now: the
  // running step by name and target, else the latest status snapshot.
  const current =
    !open && streaming && !waiting && activity !== "streaming"
      ? working && latest
        ? [
            stepStatus(latest, streaming).glyph,
            label(latest),
            latest.kind === "tool" ? toolSummary(latest) : "",
          ]
            .filter(Boolean)
            .join(" ")
        : statusLine?.kind === "activity"
          ? statusLine.title
          : undefined
      : undefined;
  const status = failed
    ? "Tool failed"
    : warning
      ? "Needs attention"
      : streaming && waiting
        ? "Waiting for your response"
        : kidsRunning
          ? `Waiting on ${kidsRunning} of ${kids.length} subagent${kids.length === 1 ? "" : "s"}`
          : kidsFailed
            ? "Subagent failed"
            : streaming
              ? activity === "streaming"
                ? tools.length && tools.every((block) => block.status !== "running")
                  ? "Tools complete"
                  : "Responding…"
                : (current ??
                  (working
                    ? "Working…"
                    : activity === "thinking"
                      ? "Thinking…"
                      : tools.length
                        ? "Tools complete"
                        : "Thinking…"))
              : tools.some((block) => block.kind === "tool" && block.status === "running")
                ? "Activity stopped"
                : tools.length
                  ? "Tools complete"
                  : "Activity complete";
  return (
    <details
      className={`ch-activity${failed || (kidsFailed && !kidsRunning) ? " failed" : warning ? " warning" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={streaming ? "ch-activity-dot busy" : "ch-activity-dot"} />
        <span>
          <RedactedText text={status} />
        </span>
        <span className="ch-activity-count">
          {[
            tools.length
              ? `${tools.length} tool${tools.length === 1 ? "" : "s"}`
              : steps.length || !kids.length
                ? `${steps.length} step${steps.length === 1 ? "" : "s"}`
                : null,
            kids.length ? `${kids.length} subagent${kids.length === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {usage?.kind === "activity" && usage.detail ? (
          <span className="ch-activity-usage">
            <RedactedText text={usage.detail} />
          </span>
        ) : null}
      </summary>
      <ol className="ch-activity-list">
        {steps.flatMap((block, index) => {
          // A tool call keeps its identity across renders, so its step keeps
          // whatever the reader opened; only a block with no identity at all
          // falls back to its position.
          const key =
            block.kind === "activity"
              ? `activity:${block.key}`
              : block.kind === "tool" && block.tool_id
                ? `tool:${block.tool_id}`
                : `row:${index}`;
          const children =
            block.kind === "tool" && block.tool_id ? layout.byTool.get(block.tool_id) : undefined;
          return [
            <li key={key}>
              <Step block={block} streaming={streaming} />
            </li>,
            ...(children
              ? [
                  <li key={`${key}:subagents`} className="sa-li">
                    <SubagentGroup blocks={children} />
                  </li>,
                ]
              : []),
          ];
        })}
        {layout.loose.length ? (
          <li key="subagents:loose" className="sa-li">
            <SubagentGroup blocks={layout.loose} />
          </li>
        ) : null}
      </ol>
      {statusLine?.kind === "activity" ? (
        <div className="ch-activity-status" aria-live="polite">
          <span className="ch-activity-glyph run" aria-hidden="true">
            {"●"}
          </span>
          <span className="ch-activity-name">
            <RedactedText text={statusLine.title} />
          </span>
          {statusLine.detail ? (
            <span>
              <RedactedText text={statusLine.detail} />
            </span>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
