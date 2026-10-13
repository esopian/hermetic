/**
 * One delegated child's run, in a modal (WI-14, Option C).
 *
 * The left column lists the delegation's children (↑/↓ switch); the right is
 * the selected child's run as a small thread: who delegated what, when it
 * started, each tool call with its offset, the PROGRESS and THINKING lines in
 * the order they came, a live "working" ticker, and once it ends the summary,
 * the one-line rollup (Q2), the cost when history knows it (Q1) and its last
 * tool outputs. While the child's last known state is running (D25 — whether
 * or not its parent turn still is) the footer carries a steer field, STEER and
 * a small STOP; a finished child, or one read from history, is read-only.
 *
 * Nothing here holds a copy of a child. The modal reads the same block the
 * inline line draws, out of the transcript the thread renders, so it moves
 * when the line does. What it adds is the per-child record the store keeps
 * (`chat-subagent-control.ts`): the unsent steer, which survives closing, and
 * what became of a steer or a stop.
 *
 * The parent thread is hidden while this is open, so the header says how the
 * parent is doing. Escape (or ×) closes it — and only it: the dialog sits on
 * the shared focus stack, so the shell's "Escape stops the turn" stands aside
 * — and focus goes back to the child's own OPEN button.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import type { ChatBlockView } from "../../../api/index.ts";
import { Dialog } from "../../../components/Dialog.tsx";
import type { SubagentControls } from "../../chat-subagent-control.ts";
import {
  clockText,
  controllable,
  costOf,
  delegationResults,
  dispatchedOnly,
  glyphOf,
  rollupOf,
  settled,
  steerLabel,
  stopLabel,
  subagentPlaces,
  timeText,
  toolsSeen,
  UNOBSERVED_TEXT,
  DISPATCHED_TEXT,
} from "../../chat-subagents.ts";
import type { SubagentPlace, SubagentTrail, SubagentView } from "../../chat-subagents.ts";
import { fmtClock } from "../../../logic/format.ts";
import { pinToBottom, useStickToBottom } from "../../stick-to-bottom.ts";
import type { Pin } from "../../stick-to-bottom.ts";
import { RedactedText } from "../RedactedText.tsx";
import { SubagentContext, delegationFacts, useTicker } from "./Subagent.tsx";

/** `+0:12` from the child's start, when both stamps are known. */
function offset(at: number | undefined, started: number): string {
  return at === undefined || !Number.isFinite(started)
    ? ""
    : `+${clockText(Math.max(0, at - started))}`;
}

const shortSession = (id: string | undefined): string =>
  id && id.length > 24 ? `${id.slice(0, 24)}…` : (id ?? "");

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="sa-kv-i">
      <b>{k}</b>
      <span>{children}</span>
    </span>
  );
}

/** The child's run, oldest first: tool calls with their notes threaded between them. */
function RunLog({
  block,
  trail,
  now,
}: {
  block: SubagentView;
  trail: SubagentTrail | undefined;
  now: number;
}) {
  const started = block.started_at ? Date.parse(block.started_at) : Number.NaN;
  const base = toolsSeen(block) - block.tools.length;
  const notes = trail?.notes ?? [];
  const live = block.verdict === "running" && !dispatchedOnly(block);
  const rows: ReactNode[] = [];
  const noteRow = (note: { kind: "progress" | "thinking"; text: string; at?: number }, key: string) => (
    <div key={key} className={`sa-t ${note.kind}`}>
      <span className="rel">{offset(note.at, started)}</span>
      <span className="gl">·</span>
      <span className="b">
        <span className="k">{note.kind}</span>
        <RedactedText text={note.text} />
      </span>
    </div>
  );
  // Notes from before the oldest call still held, then each call and the notes after it.
  notes.forEach((note, i) => {
    if (note.afterTool <= base && (base > 0 || note.afterTool === 0)) rows.push(noteRow(note, `n${i}`));
  });
  block.tools.forEach((tool, i) => {
    const index = base + i;
    const latest = live && i === block.tools.length - 1;
    rows.push(
      <div
        key={`t${index}`}
        className={`sa-t tool${latest ? " cur" : ""}${tool.is_error ? " err" : ""}`}
      >
        <span className="rel">{offset(trail?.tools.get(index), started)}</span>
        <span className="gl">{latest ? "●" : "›"}</span>
        <span className="b">
          <span className="tn">{tool.name}</span>
          <span className="pv">
            <RedactedText text={tool.preview} />
          </span>
        </span>
      </div>,
    );
    notes.forEach((note, n) => {
      if (note.afterTool === index + 1) rows.push(noteRow(note, `n${n}`));
    });
  });
  // A child this head never watched has its latest notes only.
  if (notes.length === 0) {
    if (block.thinking) rows.push(noteRow({ kind: "thinking", text: block.thinking }, "thinking"));
    if (block.progress) rows.push(noteRow({ kind: "progress", text: block.progress }, "progress"));
  }
  return (
    <>
      <div className="sa-t started">
        <span className="rel">{Number.isFinite(started) ? "+0:00" : ""}</span>
        <span className="gl">·</span>
        <span className="b">
          {["started", block.model, `depth ${block.depth + 1}`].filter(Boolean).join(" · ")}
        </span>
      </div>
      {rows}
      {live ? (
        <div className="sa-working" aria-live="off">
          <span className="ch-activity-dot busy" />
          <span>{`working · ${timeText(block, now)}`}</span>
        </div>
      ) : null}
    </>
  );
}

function Outcome({ block }: { block: SubagentView }) {
  if (dispatchedOnly(block)) return <p className="sa-closed">{DISPATCHED_TEXT}.</p>;
  if (block.verdict === "unknown") return <p className="sa-closed">{`${UNOBSERVED_TEXT}.`}</p>;
  if (!settled(block)) return null;
  const glyph = glyphOf(block);
  const cost = costOf(block);
  const reason = block.result?.failure_reason ?? block.result?.error;
  return (
    <section className={`sa-result ${block.verdict}`} aria-label="Result">
      <div className="kicker">{glyph.word}</div>
      {block.summary ? (
        <div className="sa-summary">
          <RedactedText text={block.summary} />
        </div>
      ) : null}
      {reason ? (
        <div className="sa-reason">
          <RedactedText text={reason} />
        </div>
      ) : null}
      <div className="sa-rollup">
        {rollupOf(block)}
        {cost ? <span className="sa-cost">{` · ${cost}`}</span> : null}
      </div>
      {block.output_tail?.length ? (
        <>
          <div className="kicker">Last tools</div>
          <ul className="sa-tail">
            {block.output_tail.map((row, i) => (
              <li key={i} className={row.is_error ? "err" : undefined}>
                <span className="gl">{row.is_error ? "✕" : "✓"}</span>
                <span className="tn">{row.name}</span>
                <RedactedText text={row.preview} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function SubagentModal({
  place,
  places,
  parentWorking,
  controls,
  onSelect,
  onClose,
}: {
  place: SubagentPlace;
  places: ReadonlyMap<string, SubagentPlace>;
  parentWorking: boolean;
  controls: SubagentControls | null;
  onSelect: (subagentId: string) => void;
  onClose: () => void;
}) {
  const block = place.block;
  const siblings = place.siblings.map((s) => places.get(s.subagent_id)?.block ?? s);
  const index = Math.max(
    0,
    siblings.findIndex((s) => s.subagent_id === block.subagent_id),
  );
  const live = siblings.some((s) => s.verdict === "running" && !dispatchedOnly(s));
  const now = useTicker(live);
  const facts = delegationFacts(siblings, now);
  const glyph = glyphOf(block);
  const control = controls?.control.get(block.subagent_id);
  const canSteer = controls !== null && controllable(block);
  const stopping = control?.stop?.state === "sending" || control?.stop?.state === "requested";
  const steerNote = steerLabel(control, block);
  const stopNote = stopLabel(control, block);
  const draft = controls?.drafts.get(block.subagent_id) ?? "";
  const step = useCallback(
    (by: number) => {
      const next = siblings[index + by];
      if (next) onSelect(next.subagent_id);
    },
    [index, onSelect, siblings],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    // A field keeps its own arrows: the caret, not the sibling, moves there.
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return;
    event.preventDefault();
    step(event.key === "ArrowUp" ? -1 : 1);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (controls && draft.trim()) void controls.steer(block.subagent_id, draft);
  };

  // The log follows its live end unless the operator scrolled up, and starts
  // at the end again on every child they switch to.
  const log = useRef<HTMLDivElement>(null);
  const pin = useRef<Pin>({ following: true, pinnedTop: null });
  useStickToBottom(log, pin);
  useLayoutEffect(() => {
    pin.current = { following: true, pinnedTop: null };
  }, [block.subagent_id]);
  useLayoutEffect(() => {
    if (log.current && pin.current.following) pinToBottom(log.current, pin.current);
  });

  const parent = parentWorking
    ? `parent: working · ${facts.done} of ${facts.total} done`
    : "parent: done";
  const stoppedAt = control?.stop ? fmtClock(new Date(control.stop.at).toISOString()) : "";
  return (
    <Dialog
      className="sa-modal"
      modal
      label={`Subagent ${index + 1} of ${siblings.length}: ${block.goal}`}
      onDismiss={onClose}
      backdrop={{ className: "sa-backdrop", onClose }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: ↑/↓ anywhere in the dialog but a text field switch the child, as the sibling list's hint says. */}
      <div className="sa-frame" onKeyDown={onKeyDown}>
        <aside className="sa-side">
          <div className="sa-side-h">
            <div className="kicker">delegate_task</div>
            <b>{`${facts.total} task${facts.total === 1 ? "" : "s"}`}</b>
            <small>
              {[`${facts.done} of ${facts.total} done`, facts.elapsed].filter(Boolean).join(" · ")}
            </small>
          </div>
          <div className="sa-sibs" role="list" aria-label="Subagents in this delegation">
            {siblings.map((s) => {
              const g = glyphOf(s);
              const on = s.subagent_id === block.subagent_id;
              return (
                <div role="listitem" key={s.subagent_id}>
                  <button
                    type="button"
                    className={`sa-sib${on ? " on" : ""}`}
                    aria-current={on ? "true" : undefined}
                    data-sibling={s.subagent_id}
                    onClick={() => onSelect(s.subagent_id)}
                  >
                    <span className={`ch-activity-glyph ${g.tone}`} aria-hidden="true">
                      {g.glyph}
                    </span>
                    <span>
                      <span className="g">
                        {s.depth > 0 ? (
                          <span className="sa-depth">{`depth ${s.depth + 1}`}</span>
                        ) : null}
                        <RedactedText text={s.goal || "Subagent"} />
                      </span>
                      <span className="s">
                        {[g.word, timeText(s, now)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="sa-side-f">
            <kbd>↑</kbd> <kbd>↓</kbd> switch subagent · <kbd>Esc</kbd> close
          </div>
        </aside>
        <div className="sa-main">
          <header className="sa-mhead">
            <div className="t">
              <div className="kicker">{`Subagent ${index + 1} of ${siblings.length} · ${glyph.word}`}</div>
              <h3 title={block.goal}>
                <RedactedText text={block.goal || "Subagent"} />
              </h3>
              <div className="sa-parent">{parent}</div>
            </div>
            <div className="nav">
              <button
                type="button"
                aria-label="Previous subagent"
                disabled={index === 0}
                onClick={() => step(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Next subagent"
                disabled={index >= siblings.length - 1}
                onClick={() => step(1)}
              >
                ›
              </button>
              <button
                type="button"
                className="sa-close"
                aria-label="Close"
                onClick={onClose}
                {...(canSteer ? {} : { "data-autofocus": true })}
              >
                ×
              </button>
            </div>
          </header>
          <div className="sa-kv">
            <Kv k="status">{block.status}</Kv>
            {block.model ? <Kv k="model">{block.model}</Kv> : null}
            <Kv k="depth">{block.depth + 1}</Kv>
            {block.child_session_id ? (
              <Kv k="session">{shortSession(block.child_session_id)}</Kv>
            ) : null}
            <Kv k="tools">{toolsSeen(block)}</Kv>
            {timeText(block, now) ? <Kv k="elapsed">{timeText(block, now)}</Kv> : null}
          </div>
          <div className="sa-log" ref={log}>
            <div className="sa-prompt">
              <div className="sa-prompt-h">
                <b>delegated</b>
                {block.started_at ? fmtClock(block.started_at) : null}
              </div>
              <div className="sa-prompt-b">
                <RedactedText text={block.goal} />
              </div>
              <div className="sa-prompt-c">
                {`delegate_task · task ${block.task_index + 1} of ${block.task_count}`}
              </div>
            </div>
            {dispatchedOnly(block) ? null : (
              <RunLog block={block} trail={controls?.trail.get(block.subagent_id)} now={now} />
            )}
            {control?.steer ? (
              <div className="sa-t you">
                <span className="rel" />
                <span className="gl">■</span>
                <span className="b">
                  <span className="k">you · steer</span>
                  <RedactedText text={control.steer.text} />
                </span>
              </div>
            ) : null}
            {control?.stop && control.stop.state !== "failed" && control.stop.state !== "not_found" ? (
              <div className="sa-t you stop">
                <span className="rel" />
                <span className="gl">■</span>
                <span className="b">
                  <span className="k">you · stop</span>
                  {`requested at ${stoppedAt}`}
                </span>
              </div>
            ) : null}
            <Outcome block={block} />
          </div>
          <footer className="sa-foot">
            {canSteer ? (
              <form className="sa-ctl" onSubmit={submit}>
                <input
                  className="in"
                  type="text"
                  aria-label="Steer this subagent"
                  placeholder="Steer this subagent…"
                  value={draft}
                  data-autofocus
                  onChange={(event) => controls?.setDraft(block.subagent_id, event.currentTarget.value)}
                />
                <button type="submit" className="btn-mini" disabled={!draft.trim()}>
                  STEER
                </button>
                <button
                  type="button"
                  className="btn-mini danger sa-stop"
                  disabled={stopping}
                  onClick={() => void controls?.stop(block.subagent_id)}
                >
                  STOP
                </button>
              </form>
            ) : (
              <p className="sa-closed">
                {block.origin === "history"
                  ? "Read from the transcript. This subagent cannot be steered from here."
                  : block.status === "interrupted"
                    ? "This subagent was stopped. Steering is closed."
                    : settled(block)
                      ? "This subagent has finished. Steering is closed."
                      : "Steering is not available for this subagent."}
              </p>
            )}
            {steerNote || stopNote ? (
              <div className="sa-ack" role="status">
                {[steerNote, stopNote].filter(Boolean).join(" · ")}
              </div>
            ) : null}
            {canSteer ? (
              <div className="sa-hint">
                <kbd>Enter</kbd> steer · applied at the subagent's next tool call · Stop ends this
                subagent only; the turn continues · <kbd>Esc</kbd> close
              </div>
            ) : null}
          </footer>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The thread's subagent scope: the context the inline lines read (how to open
 * a child, the results turns), and the modal when one is open.
 * `groups` are the thread's presented turns, so a child's siblings are the
 * ones its line is drawn with.
 */
export function SubagentScope({
  groups,
  messages,
  liveId,
  sending,
  controls,
  children,
}: {
  groups: readonly { id: string; blocks: readonly ChatBlockView[] }[];
  messages: Parameters<typeof delegationResults>[0];
  liveId: string | null;
  sending: boolean;
  controls: SubagentControls | null;
  children: ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const returnTo = useRef<string | null>(null);
  const places = useMemo(() => subagentPlaces(groups), [groups]);
  const results = useMemo(() => delegationResults(messages), [messages]);
  const shown = useRef(openId);
  shown.current = openId;
  const open = useCallback((id: string) => setOpenId(id), []);
  const close = useCallback(() => {
    returnTo.current = shown.current;
    setOpenId(null);
  }, []);
  const place = openId ? places.get(openId) : undefined;
  // A child that left the transcript (a rollover, a re-read that dropped it)
  // takes its modal with it rather than leaving an empty frame open.
  useEffect(() => {
    if (openId && !place) close();
  }, [close, openId, place]);
  // Back to the OPEN button of the child last shown, wherever its line is now.
  useEffect(() => {
    if (openId !== null || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    const button = Array.from(document.querySelectorAll<HTMLElement>("[data-subagent-open]")).find(
      (el) => el.dataset.subagentOpen === id,
    );
    button?.focus({ preventScroll: true });
  }, [openId]);
  const value = useMemo(() => ({ open, results }), [open, results]);
  return (
    <SubagentContext.Provider value={value}>
      {children}
      {place ? (
        <SubagentModal
          place={place}
          places={places}
          parentWorking={sending && liveId !== null && place.message === liveId}
          controls={controls}
          onSelect={setOpenId}
          onClose={close}
        />
      ) : null}
    </SubagentContext.Provider>
  );
}
