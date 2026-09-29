/**
 * `process_event` — something a background process did, drawn as an event.
 *
 * Hermes stores these as the user's turn; nobody typed them. So they are not
 * messages here at all: no name, no bubble, no "You". Each is one mono line on
 * a dashed rule in the avatar gutter — kind, status, exit code, the command cut
 * to fit, how long it ran, when — and the output stays folded until somebody
 * asks for it. Every process row opens shut, failures included: the line
 * already says it failed, in red, and the last line of output rides along in
 * the fold's label, which is usually the line that says why.
 *
 * Three rows are shaped differently because they say different things:
 *
 * - a **watch match** opens by default, with the pattern marked in the lines
 *   that matched, because being told is what the watch was for;
 * - a **DM reply** is another bot talking, so it is drawn as that bot — its
 *   face, its name, its reply as markdown — with the delivery details as a
 *   header, the tool warnings split off below, and a link to its own thread;
 * - an **async delegation** is a count of subagents and one folded line each.
 *
 * Nothing on a row is estimated. A duration is shown only when upstream stated
 * one (a delegation) or when the call that started the process is in the
 * loaded transcript and its stamp can be subtracted from the event's.
 */
import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { shortCommand } from "@hermetic/core/shared";
import { fmtClock } from "../../../logic/format.ts";
import { chatHash } from "../../chat-routing.ts";
import { botLabel } from "../../chat-presentation.ts";
import {
  FAILURE_TAIL_LINES,
  OUTPUT_TAIL_LINES,
  burstParts,
  eventKind,
  eventStatus,
  eventTone,
  fmtSpan,
  highlightParts,
  lastLine,
  outputLines,
  processDomId,
  shortProcessId,
  spanMs,
} from "../../process-events.ts";
import type { EventEntry, ProcessEventView } from "../../process-events.ts";
import { Face } from "../Face.tsx";
import { RedactedText } from "../RedactedText.tsx";
import { TextBlock } from "./Text.tsx";

/* ── what an event row needs to know about the thread around it ──────────── */

export interface ProcessEventContextValue {
  fleetId: string;
  instance: string;
  /** The bot whose thread this is, and what it is called. */
  bot: string;
  botTitle?: string | null;
  status: Parameters<typeof Face>[0]["status"];
  /** Background starts in the loaded transcript, by process id (`processStarts`). */
  starts: ReadonlyMap<string, { at: string }>;
  /** The drawn event row each process id lands on (`eventAnchors`). */
  anchors: ReadonlyMap<string, string>;
}

const EMPTY: ProcessEventContextValue = {
  fleetId: "",
  instance: "",
  bot: "default",
  status: "pending",
  starts: new Map(),
  anchors: new Map(),
};

/**
 * Provided by `Thread`. A surface that draws a block without it — the generic
 * block switch, a test — gets no links and no durations, which is correct:
 * with no transcript around the row there is nothing to link to.
 */
export const ProcessEventContext = createContext<ProcessEventContextValue>(EMPTY);

export function useProcessEvents(): ProcessEventContextValue {
  return useContext(ProcessEventContext);
}

/**
 * Scroll to one end of a process's pair and make it visible: every closed
 * disclosure around it — the burst it was folded into, the tool group it sits
 * in — is opened first, since a row inside a shut `<details>` has nowhere to
 * scroll to.
 */
export function jumpToProcess(end: "event" | "start", processId: string): void {
  const target = document.getElementById(processDomId(end, processId));
  if (!target) return;
  for (let node = target.parentElement; node; node = node.parentElement)
    if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
  target.scrollIntoView?.({ block: "center" });
  target.focus?.({ preventScroll: true });
}

/**
 * A link to the other end of a process. A button, because it scrolls rather
 * than navigates, and it stops the click there — it sits inside `<summary>`
 * lines, where a click that bubbled would also fold or unfold the row.
 */
export function JumpLink({
  end,
  processId,
  children,
}: {
  end: "event" | "start";
  processId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="ch-ev-jump"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        jumpToProcess(end, processId);
      }}
    >
      {children}
    </button>
  );
}

/** Put text on the clipboard, and say so on the button that did it. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <button type="button" className="ch-ev-jump" onClick={() => void copy()}>
      {state === "copied" ? "copied" : state === "failed" ? "clipboard unavailable" : label}
    </button>
  );
}

/* ── the line ─────────────────────────────────────────────────────────────── */

/** How long the process ran: stated by upstream, or read off the two stamps, or nothing. */
function useSpan(event: ProcessEventView, at: string | null): string | null {
  const { starts } = useProcessEvents();
  if (event.duration_s != null) return fmtSpan(event.duration_s * 1000);
  if (!at || !event.process_id) return null;
  const ms = spanMs(starts.get(event.process_id)?.at, at);
  return ms === null ? null : fmtSpan(ms);
}

/** "started ↑", when the call that started this process is in the loaded transcript. */
function StartLink({ event, label = "started ↑" }: { event: ProcessEventView; label?: string }) {
  const { starts } = useProcessEvents();
  if (!event.process_id || !starts.has(event.process_id)) return null;
  return (
    <JumpLink end="start" processId={event.process_id}>
      {label}
    </JumpLink>
  );
}

function Command({ command }: { command: string | null | undefined }) {
  if (!command) return null;
  return (
    <span className="cmd" title={command}>
      <RedactedText text={shortCommand(command)} />
    </span>
  );
}

function Stamp({ at }: { at: string | null }) {
  return at ? <span className="t">{fmtClock(at)}</span> : null;
}

/** The first line of a notice, which is all a one-line row has room for. */
function firstLine(text: string | null | undefined): string {
  return (
    (text ?? "")
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function Raw({ raw, label = "raw notification" }: { raw: string; label?: string }) {
  return (
    <details className="ch-ev-more">
      <summary>{label}</summary>
      <pre className="ch-ev-tail">
        <RedactedText text={raw} />
      </pre>
    </details>
  );
}

/* ── output: folded, with the last line as the hint ───────────────────────── */

function Output({ event }: { event: ProcessEventView }) {
  const [all, setAll] = useState(false);
  const lines = outputLines(event.output_tail);
  if (lines.length === 0) return null;
  const failed = event.outcome === "failed";
  const total = event.output_lines ?? lines.length;
  const keep = failed ? FAILURE_TAIL_LINES : OUTPUT_TAIL_LINES;
  const shown = all ? lines : lines.slice(-keep);
  const above = lines.length - shown.length;
  return (
    <details className="ch-ev-more">
      <summary>
        {`output · ${total} line${total === 1 ? "" : "s"} · last line: `}
        <span className={failed ? "ch-ev-last bad" : "ch-ev-last"}>
          <RedactedText text={lastLine(lines)} />
        </span>
      </summary>
      <pre className={`ch-ev-tail${failed ? " bad" : ""}`}>
        {above > 0 ? (
          <span className="dim">{`… ${above} line${above === 1 ? "" : "s"} above\n`}</span>
        ) : null}
        <RedactedText text={shown.join("\n")} />
      </pre>
      <div className="ch-ev-actions">
        {above > 0 ? (
          <button type="button" className="ch-ev-jump" onClick={() => setAll(true)}>
            {`show all ${lines.length} lines`}
          </button>
        ) : null}
        <CopyButton text={lines.join("\n")} label="copy output" />
        {event.command ? <CopyButton text={event.command} label="copy command" /> : null}
      </div>
    </details>
  );
}

/* ── the rows, by kind ────────────────────────────────────────────────────── */

function Completion({ event, at }: { event: ProcessEventView; at: string | null }) {
  const span = useSpan(event, at);
  const tone = eventTone(event);
  return (
    <>
      <div className="ch-ev-line">
        <span className="k">{eventKind(event)}</span>
        <span className={`st ${tone}`}>
          <RedactedText text={eventStatus(event)} />
        </span>
        {event.exit_code != null ? <span>{`exit ${event.exit_code}`}</span> : null}
        {event.signal ? <span>{event.signal}</span> : null}
        <Command command={event.command} />
        {span ? <span>{`· ${span}`}</span> : null}
        <StartLink event={event} />
        <Stamp at={at} />
      </div>
      <Output event={event} />
    </>
  );
}

function WatchMatch({ event, at }: { event: ProcessEventView; at: string | null }) {
  const pattern = event.watch?.pattern ?? null;
  const lines = outputLines(event.output_tail);
  const suppressed = event.watch?.suppressed ?? 0;
  return (
    <>
      <div className="ch-ev-line">
        <span className="k">watch</span>
        <span className="st warn">{pattern ? `matched “${pattern}”` : "matched"}</span>
        <Command command={event.command} />
        <span>· still running</span>
        <StartLink event={event} />
        <Stamp at={at} />
      </div>
      {lines.length > 0 || suppressed > 0 ? (
        <details className="ch-ev-more" open>
          <summary>matched output</summary>
          <pre className="ch-ev-tail warn">
            {lines.map((line, index) => (
              <span key={index}>
                {highlightParts(line, pattern).map((part, at) =>
                  part.hit ? (
                    <mark key={at} className="hl">
                      {part.text}
                    </mark>
                  ) : (
                    <RedactedText key={at} text={part.text} />
                  ),
                )}
                {"\n"}
              </span>
            ))}
            {suppressed > 0 ? (
              <span className="dim">{`(${suppressed} earlier match${suppressed === 1 ? "" : "es"} suppressed by rate limit)`}</span>
            ) : null}
          </pre>
        </details>
      ) : null}
    </>
  );
}

function Delegation({ event, at }: { event: ProcessEventView; at: string | null }) {
  const d = event.delegation;
  const span = useSpan(event, at);
  const tone = eventTone(event);
  const facts = [d?.id ?? null, span, d?.api_calls != null ? `${d.api_calls} calls` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <div className="ch-ev-line">
        <span className="k">subagents</span>
        <span className={`st ${tone}`}>{d ? `${d.succeeded} of ${d.total} finished` : "finished"}</span>
        {facts ? <span>{facts}</span> : null}
        <Stamp at={at} />
      </div>
      {d && (d.tasks.length > 0 || d.error) ? (
        <details className="ch-ev-more">
          <summary>results</summary>
          <div className="ch-ev-tail">
            {d.tasks.map((task) => (
              <div key={task.index} className="ch-ev-task">
                <b className={task.ok ? "ok" : "bad"}>{task.ok ? "✓" : "✗"}</b>{" "}
                <b>
                  <RedactedText text={task.goal ?? `Task ${task.index}`} />
                </b>
                {task.summary ? (
                  <>
                    {" — "}
                    <RedactedText text={task.summary} />
                  </>
                ) : task.ok ? null : (
                  <span className="dim">{` — ${task.status}`}</span>
                )}
              </div>
            ))}
            {d.error ? (
              <div className="ch-ev-task bad">
                <RedactedText text={d.error} />
              </div>
            ) : null}
          </div>
        </details>
      ) : (
        <Raw raw={event.raw} />
      )}
    </>
  );
}

/** MCP reload and watch disabled: one muted line. */
function Notice({ event, at }: { event: ProcessEventView; at: string | null }) {
  const text = firstLine(event.message) || firstLine(event.raw);
  return (
    <div className="ch-ev-line">
      <span className="k">{eventKind(event)}</span>
      <span className="st mute">
        <RedactedText text={text} />
      </span>
      <Stamp at={at} />
    </div>
  );
}

/** A reply from the bot a DM went to, drawn as that bot talking. */
function DmReply({ event, at }: { event: ProcessEventView; at: string | null }) {
  const context = useProcessEvents();
  const dm = event.dm!;
  const span = useSpan(event, at);
  const to = dm.to_profile;
  const replier = botLabel(context.instance, to, null);
  const delivery = [
    event.process_id ? `delivered by ${event.process_id}` : null,
    event.exit_code != null ? `exit ${event.exit_code}` : null,
    span,
  ]
    .filter(Boolean)
    .join(" · ");
  const warnings = dm.warnings.length;
  return (
    <div className="ch-ev-dm">
      <div className="ch-ev-dm-head">
        <span className="k">↩ DM reply</span>
        <span>{`${replier} → ${botLabel(context.instance, context.bot, context.botTitle)}`}</span>
        {delivery ? <span className="dim">{`· ${delivery}`}</span> : null}
        <StartLink event={event} label="sent ↑" />
        <Stamp at={at} />
      </div>
      <div className="ch-ev-dm-body">
        {context.fleetId ? (
          <Face
            fleetId={context.fleetId}
            instance={context.instance}
            bot={to}
            size={30}
            status={context.status}
            square={false}
          />
        ) : (
          <span />
        )}
        <div>
          <div className="ch-ev-dm-who">
            <span className="ch-msg-who">
              <RedactedText text={replier} />
            </span>
            {context.instance ? (
              <span className="ch-msg-meta">{`${context.instance}/${to}`}</span>
            ) : null}
          </div>
          <div className="ch-msg-body ch-ev-dm-reply">
            <TextBlock block={{ kind: "text", markdown: dm.reply }} />
          </div>
        </div>
      </div>
      <div className="ch-ev-dm-foot">
        {warnings > 0 ? (
          <details className="ch-ev-more">
            <summary className="warnline">{`⚠ ${warnings} tool warning${warnings === 1 ? "" : "s"}`}</summary>
            <pre className="ch-ev-tail warn">
              <RedactedText text={dm.warnings.join("\n")} />
            </pre>
          </details>
        ) : null}
        <Raw raw={event.raw} />
        {context.instance ? (
          <a
            className="ch-ev-jump"
            href={chatHash({ instance: context.instance, bot: to, session: null })}
          >
            {`open ${replier}'s thread →`}
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** One event's content, without the gutter: what the generic block switch draws. */
export function ProcessEventBlock({
  block,
  at = null,
}: {
  block: ProcessEventView;
  at?: string | null;
}) {
  if (block.dm) return <DmReply event={block} at={at} />;
  switch (block.event) {
    case "completion":
      return <Completion event={block} at={at} />;
    case "watch_match":
      return <WatchMatch event={block} at={at} />;
    case "delegation":
      return <Delegation event={block} at={at} />;
    default:
      return <Notice event={block} at={at} />;
  }
}

/* ── rows in the thread ───────────────────────────────────────────────────── */

/**
 * One event in the gutter. It carries the process's jump anchor only when it is
 * the row `eventAnchors` chose, so a process that matched a watch twice and
 * then exited has one "result ↓" target, not three elements with one id.
 */
export function ProcessEventRow({
  entry,
  sub = false,
}: {
  entry: Pick<EventEntry, "event"> & { row: { message: { id: string; at: string } } };
  sub?: boolean;
}) {
  const { anchors } = useProcessEvents();
  const { event } = entry;
  const message = entry.row.message;
  const pid = event.process_id;
  const anchor = pid && anchors.get(pid) === message.id ? processDomId("event", pid) : undefined;
  return (
    <div
      className={`ch-ev${sub ? " sub" : ""}`}
      id={anchor}
      tabIndex={anchor ? -1 : undefined}
      data-chat-message={message.id}
      data-process-event={event.event}
      data-outcome={event.outcome}
    >
      <div className="ch-ev-gut">
        <i className={`ch-ev-sq ${eventTone(event)}`} aria-hidden="true" />
      </div>
      <div className="ch-ev-main">
        <ProcessEventBlock block={event} at={message.at} />
      </div>
    </div>
  );
}

/**
 * Two or more routine events with nothing said between them, as one line:
 * `4 events · 3 completed · 1 watch match · proc_51c0, … · 00:26:04–00:26:40`.
 * The members are rendered inside the fold even while it is shut, so a
 * "result ↓" aimed at one of them has an element to open and land on.
 */
export function ProcessBurst({ entries }: { entries: readonly EventEntry[] }) {
  const [open, setOpen] = useState(false);
  const ids = entries.flatMap((entry) => (entry.event.process_id ? [entry.event.process_id] : []));
  const first = entries[0]!.row.message.at;
  const last = entries[entries.length - 1]!.row.message.at;
  const range =
    fmtClock(first) === fmtClock(last) ? fmtClock(first) : `${fmtClock(first)}–${fmtClock(last)}`;
  return (
    <div className="ch-ev burst" data-process-burst={ids.join(" ")}>
      <div className="ch-ev-gut">
        <i className="ch-ev-sq mute" aria-hidden="true" />
      </div>
      <details className="ch-ev-burst" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <div className="ch-ev-line">
            <span className="k">{`${entries.length} events`}</span>
            {burstParts(entries.map((entry) => entry.event)).map((part) => (
              <span key={part.text} className={`st ${part.tone}`}>
                {part.text}
              </span>
            ))}
            {ids.length > 0 ? (
              <span className="dim" title={ids.join(", ")}>
                {`· ${ids.map(shortProcessId).join(", ")}`}
              </span>
            ) : null}
            <span className="t">{range}</span>
          </div>
        </summary>
        <div className="ch-ev-inner">
          {entries.map((entry) => (
            <ProcessEventRow key={entry.row.message.id} entry={entry} sub />
          ))}
        </div>
      </details>
    </div>
  );
}
