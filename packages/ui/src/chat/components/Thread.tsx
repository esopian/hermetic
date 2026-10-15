/**
 * The thread: header, thread-level band, transcript, composer.
 *
 * Every thread pane is here, and they are one component rather
 * than seven because they differ only in what the log is replaced by and
 * whether the composer accepts a message — both decided by `threadState()` in
 * `chat-logic.ts`, from the *fleet row* rather than from anything chat learned.
 * That ordering is the point: a box the fleet stream already says is stopped is
 * stopped, and telling the operator "reconnecting…" about it would be a worse
 * lie than saying nothing.
 *
 * The band under the header carries the *thread's* condition — stopped,
 * destroyed, reconnecting, unreachable. The band that restates a non-portal
 * destination is not here; it lives in the composer, above the input, because
 * it is a statement about what sending does and a banner at the top of a
 * scrolled transcript is not on screen at the moment that matters.
 */
import type { TurnActivity } from "../chat-activity.ts";
import { botLabel } from "../chat-presentation.ts";
import { RedactedText } from "./RedactedText.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MentionBot } from "../chat-mentions.ts";
import { recoveredDms } from "../bot-dm.ts";
import type { DmBot } from "../bot-dm.ts";
import type { AgentView, ChatMessageView, SessionView } from "../../api/index.ts";
import type { Observation } from "../chat-conversations.ts";
import { composerState, hasKnownOrigin, originClass, railTime } from "../chat-logic.ts";
import { turnRows } from "../chat-turns.ts";
import { latestContextReading, newerReading } from "../context-usage.ts";
import type { ContextReading } from "../context-usage.ts";
import { eventAnchors, processStarts, threadItems } from "../process-events.ts";
import { ProcessBurst, ProcessEventContext, ProcessEventRow } from "./blocks/ProcessEvent.tsx";
import { useNotifyIfAvailable } from "../../state/notify-state.tsx";
import { useOpenAgentSection } from "../agent-sections.ts";
import { useViewAck } from "../../nav/view-ack.ts";
import { pinToBottom, useStickToBottom } from "../stick-to-bottom.ts";
import type { Pin } from "../stick-to-bottom.ts";
import type { Destination, ThreadState } from "../chat-logic.ts";
import { Composer } from "./Composer.tsx";
import { Face } from "./Face.tsx";
import { BotTitleEdit } from "./BotTitleEdit.tsx";
import { BotDmContext } from "./BotDm.tsx";
import type { ExchangeRequest } from "./BotDm.tsx";
import { BotExchange } from "./BotExchange.tsx";
import { RowBoundary } from "./RowBoundary.tsx";
import { Message } from "./Message.tsx";
import { SubagentScope } from "./blocks/SubagentModal.tsx";
import { useChatIfAvailable } from "../chat-state.tsx";
import type { SentAttachment } from "../chat-attachments.ts";
import { useFileDrop } from "./AttachTray.tsx";

/** The avatar status for a thread, read off the fleet row rather than guessed. */
function faceStatus(agent: AgentView | null): Parameters<typeof Face>[0]["status"] {
  switch (agent?.display_status) {
    case "ready":
      return "ready";
    case "degraded":
      return "degraded";
    case "error":
      return "error";
    case "destroyed":
      return "destroyed";
    case "stopped":
    case "stopping":
      return "stopped";
    case undefined:
      return "pending";
    default:
      return "pending";
  }
}

const NO_TEAMMATES: readonly DmBot[] = [];

/**
 * Whether the header offers the box's Desktop and Terminal: only while the box
 * is up. Bootstrapping, ready and degraded have something to look at; error
 * and unreachable keep the links because the terminal and the console are how
 * such a box is debugged, and the section says what is not there. A box being
 * created, stopping, stopped, being destroyed or gone has neither, and a
 * thread with no fleet row has no agent to open them on.
 */
const LINKED_STATUSES: ReadonlySet<AgentView["display_status"]> = new Set<AgentView["display_status"]>([
  "bootstrapping",
  "ready",
  "degraded",
  "error",
  "unreachable",
]);

function linksSections(agent: AgentView | null): boolean {
  return agent !== null && LINKED_STATUSES.has(agent.display_status);
}

/** A watch that is working — what a surface with no observation of its own passes. */
const LIVE_OBSERVATION: Observation = { state: "live", attempt: 0, error: null };

/**
 * The observation band (§9.2): what the portal's continuous watch
 * on *this* conversation is doing, when it is doing anything worth saying.
 *
 * Two states and two voices. A reconnect is the server retrying its own
 * upstream read, so it is a `status` in the same warn band the transcript
 * re-read uses — the operator is told, not alarmed. A terminal error is an
 * `alert`, because the subscription is gone: nothing sent from Hermes Desktop,
 * the CLI or a routine will appear here until somebody asks for the watch back,
 * and asking is a button rather than a retry loop running out of sight.
 */
function ObservationBand({
  observation,
  onResume,
}: {
  observation: Observation;
  onResume?: (() => void) | undefined;
}) {
  if (observation.state === "reconnecting") {
    return (
      <div className="ch-band warn" role="status">
        <i className="dot" />
        <span>Reconnecting to this conversation…</span>
        <span className="sub">
          {observation.attempt > 0 ? `attempt ${observation.attempt} · ` : ""}
          Messages sent from elsewhere may arrive late until the watch is back.
        </span>
      </div>
    );
  }
  if (observation.state !== "failed") return null;
  return (
    <div className="ch-band bad" role="alert">
      <i className="dot" />
      <span>This conversation is no longer being watched.</span>
      <span className="sub">
        {observation.error?.message ?? "The observation ended."} Messages sent from Hermes Desktop, the
        CLI or a routine will not appear here until it is watched again.
      </span>
      {onResume ? (
        <>
          <span className="spacer" />
          <button type="button" className="ch-chip" onClick={onResume}>
            Watch again
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * What a refused turn's band says. A refusal never reached the box, so the
 * message the operator typed is not in the transcript the re-read brings back;
 * the band is the only record that it was not sent. `FLEET_MISMATCH` is a
 * window left open across a fleet switch (§4.7), and `NO_TARGET` a window that
 * never learned its fleet: both are fixed by reloading, which the head's own
 * message says.
 */
export function turnErrorHeadline(code: string): string {
  switch (code) {
    case "ABORT_FAILED":
      return "The turn could not be stopped.";
    case "FLEET_MISMATCH":
    case "NO_TARGET":
      return "Not sent: this window is showing a fleet the app is no longer serving.";
    default:
      return "The message was not sent.";
  }
}

/** The thread-level band: one condition, stated, with no way to dismiss it. */
function Band({
  state,
  instance,
  agent,
  now,
  reconnectAttempt = 0,
  tailnetDetail = null,
}: {
  state: ThreadState;
  instance: string;
  agent: AgentView | null;
  now: number;
  /** Which re-read is in flight, for the band that draws it as `attempt 3`. */
  reconnectAttempt?: number;
  /** What `doctor` says is wrong with *this machine's* tailscale, in its words. */
  tailnetDetail?: string | null;
}) {
  switch (state) {
    case "stopped":
      // Neutral: a stopped box is a state, not something that needs attention.
      return (
        <div className="ch-band mute" role="note">
          <i className="dot" />
          <span>{`${instance} is stopped.`}</span>
          <span className="sub">Its transcript is on the data volume and comes back with it.</span>
        </div>
      );
    case "destroyed":
      // Warn: the box is gone and its kept volume is a decision left to make.
      return (
        <div className="ch-band warn" role="note">
          <i className="dot" />
          <span>{`${instance} is gone, but its memory is not.`}</span>
          <span className="sub">
            {agent?.volume_id ? `${agent.volume_id} · kept` : "The data volume was kept, if one was."}
          </span>
        </div>
      );
    case "dropped":
      return (
        <div className="ch-band warn" role="status">
          <i className="dot" />
          <span>{`Reconnecting to ${instance}…`}</span>
          <span className="sub">
            {reconnectAttempt > 1 ? `attempt ${reconnectAttempt} · ` : ""}
            The transcript is being re-read from the box, which is the copy that is true.
          </span>
        </div>
      );
    case "unreachable":
      return (
        <div className="ch-band bad" role="note">
          <i className="dot" />
          <span>{`No answer from ${instance}.`}</span>
          <span className="sub">
            {`Last heard from ${railTime(agent?.last_heartbeat ?? null, now)}. Chat reaches a box over Tailscale Serve and nothing else.`}
          </span>
        </div>
      );
    case "no_tailnet":
      return (
        <div className="ch-band bad" role="note">
          <i className="dot" />
          <span>No route to the tailnet.</span>
          <span className="sub">
            {/*
              `doctor`'s own words about this machine when there are any —
              "tailscale is installed but stopped; run `tailscale up`" — because
              the whole value of telling the two apart is telling the operator
              which one to fix, and a sentence about the architecture does not.
            */}
            {tailnetDetail ??
              "Chat reaches an agent over Tailscale Serve and nothing else — the boxes bind loopback only."}{" "}
            The fleet view, volumes and every lifecycle operation keep working; they go through AWS.
          </span>
        </div>
      );
    default:
      return null;
  }
}

/**
 * The off-tailnet pane, the important one — this laptop has no tailnet path.
 *
 * Its own component, exported, because it is the one pane that has to render
 * with *no thread selected*: a portal opened while the laptop is off the
 * tailnet reads every roster as unreachable, so nothing is ever selected and
 * the thread this normally lives inside is never drawn. `ChatView` renders it
 * in that case, and one copy of the words is the point of pulling it out.
 *
 * `detail` is `doctor`'s reading of *this machine's* tailscale, which is the
 * only sentence here that says which thing to fix. Without it the pane is still
 * correct and still useless: "can't reach the agents" is what the operator
 * already knew.
 */
export function NoRoute({ detail }: { detail?: string | null }) {
  return (
    <div className="ch-empty">
      <div>
        <h2>Can't reach the agents</h2>
        {detail ? (
          <p>
            <code>tailscale status</code> on this machine: {detail}
          </p>
        ) : null}
        <p>
          No box in this fleet answered. Chat, the desktop link and <code>hermetic logs</code> are the
          only surfaces that need a tailnet path — everything else in the portal goes through AWS APIs
          and is unaffected.
        </p>
        <div className="ch-prompts">
          <span className="ch-prompt">
            <b>fix</b>
            <code className="mono">tailscale up</code> — this pane reconnects on its own
          </span>
          <span className="ch-prompt">
            <b>or</b>
            <code className="mono">hermetic doctor</code> — checks the ACL and the node's tags
          </span>
        </div>
      </div>
    </div>
  );
}

/** What fills the log when there is no transcript to draw. */
function Empty({
  state,
  instance,
  bot,
  tailnetDetail = null,
}: {
  state: ThreadState;
  instance: string;
  bot: string;
  tailnetDetail?: string | null;
}) {
  if (state === "bootstrapping") {
    return (
      <div className="ch-empty">
        <div>
          <h2>Not listening yet</h2>
          <p>
            {`${instance} is still bootstrapping. Hermes starts at stage 5, so there is nothing behind the gateway until the box finishes.`}
          </p>
          <p>You can type now — it sends the moment the gateway answers.</p>
        </div>
      </div>
    );
  }
  if (state === "no_tailnet") {
    return <NoRoute detail={tailnetDetail} />;
  }
  if (state === "unreachable") {
    return (
      <div className="ch-empty">
        <div>
          <h2>{`${instance} did not answer`}</h2>
          <p>
            The box is in the fleet and its roster could not be read. Nothing here is stale — there is
            simply nothing to show.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="ch-empty">
      <div>
        <h2>Nothing said yet</h2>
        <p>{`${bot}@${instance} has no history in this session. Say something and it starts one.`}</p>
      </div>
    </div>
  );
}

export function Thread({
  fleetId,
  instance,
  bot,
  /** The bot's display name. The identity is `bot`; this is what is shown. */
  botTitle,
  isDefault = false,
  agent,
  session,
  destination,
  state,
  messages,
  live,
  context: contextHeld = null,
  sending,
  remoteBusy = null,
  activity = sending ? "thinking" : "idle",
  historyError,
  turnError = null,
  now,
  fixture = false,
  reconnectAttempt = 0,
  observation = LIVE_OBSERVATION,
  onResumeObservation,
  tailnetDetail = null,
  onSend,
  onAbort,
  actions,
  onRename,
  mentions,
  mentionHint,
  teammates = NO_TEAMMATES,
  sessions = [],
  onChooseSession,
}: {
  fleetId: string;
  instance: string;
  bot: string;
  botTitle?: string | null;
  isDefault?: boolean;
  agent: AgentView | null;
  session: SessionView | null;
  destination: Destination;
  state: ThreadState;
  messages: ChatMessageView[];
  live: ChatMessageView | null;
  /** The conversation's held context-window figure (`Chat.context`). */
  context?: ContextReading | null;
  sending: boolean;
  /**
   * The box's word on a turn running here, whoever started it (`Chat.remoteBusy`).
   * The composer queues behind it, and a tool call at the transcript's tail
   * reads as running, stopped or unknown by it.
   */
  remoteBusy?: boolean | null;
  activity?: TurnActivity;
  historyError: string | null;
  /**
   * Why the last turn was refused before it reached the box, or why stopping
   * it failed. Cleared by the next send.
   */
  turnError?: { code: string; message: string } | null;
  now: number;
  fixture?: boolean;
  reconnectAttempt?: number;
  /** What the portal's continuous watch on this conversation is doing (§9.2). */
  observation?: Observation;
  /** Ask a terminated watch back. Absent means this surface cannot, so it does not offer to. */
  onResumeObservation?: () => void;
  tailnetDetail?: string | null;
  onSend: (text: string, attachments?: readonly SentAttachment[]) => unknown;
  onAbort: () => void;
  actions?: ReactNode;
  /**
   * Rename the bot's friendly title (`null` resets it). Absent means this
   * surface cannot, so the header offers no pencil.
   */
  onRename?: (title: string | null) => Promise<void>;
  mentions?: readonly MentionBot[];
  mentionHint?: string;
  /**
   * Every bot on this instance, this one included: who a `message_agent` call
   * or a DM delivery names (`bot-dm.ts`). Not `mentions`, which leaves this
   * bot out and is empty in a named session.
   */
  teammates?: readonly DmBot[];
  /**
   * This bot's sessions, offered as chips when the destination is `unchosen`.
   * Passed by the surface that owns the rail, with the same select the rail's
   * Sessions tab performs, so a chip and a rail row land in the same place.
   */
  sessions?: readonly SessionView[];
  onChooseSession?: (session: string) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  // One turn is one row: a durable read hands back an assistant row per tool
  // call, and the operator asked for one grouping (`chat-turns.ts`). The live
  // message never folds into the turn above it.
  const all = live ? [...messages, live] : messages;
  const rows = turnRows(all, now, { breakBefore: live?.id });
  // The window as of the newest turn or live tick, for the composer's meter:
  // the newer of what these rows carry and what the conversation's record holds
  // (`Conversation.context`), since the box's stored rows carry none.
  const context = useMemo(
    () =>
      newerReading(latestContextReading(live ? [...messages, live] : messages), contextHeld)?.usage ??
      null,
    [messages, live, contextHeld],
  );
  // Background-process events (§9.2): folded into bursts and linked to the
  // calls that started them. One rendering, with no viewer switch: every event
  // row keeps its output collapsed, and a failure is already drawn in red.
  const items = threadItems(rows);
  // The newest bot turn, unless it is this tab's own streaming one: the turn
  // whose unfinished tool call the box's busy state speaks for.
  const tail = items.findLast((item) => item.kind === "turn" && item.row.message.role !== "user");
  const tailId = tail?.kind === "turn" && tail.row.message.id !== live?.id ? tail.row.message.id : null;
  const working = sending || remoteBusy === true;
  const scoped = useChatIfAvailable();
  const subagents = scoped?.subagents ?? null;
  // This pane's own drop target: a dock pane is its own scope, so a file
  // dropped here lands on this conversation and no other.
  // Only into a composer that can send: the same gate as its ⊕ (`Composer`).
  const composer = composerState(state, destination);
  const drop = useFileDrop(scoped?.selection ? scoped.attachments : null, instance, composer.enabled);
  const starts = useMemo(() => processStarts(live ? [...messages, live] : messages), [messages, live]);
  // Refused DMs a later call already sent again, and the ones Retry was asked
  // for (`BotDm.tsx`): both outlive any one marker. Keyed by content, so a
  // streaming turn that changes neither does not re-render every marker.
  const recoveredKey = useMemo(
    () => [...recoveredDms(live ? [...messages, live] : messages, teammates)].sort().join("\n"),
    [messages, live, teammates],
  );
  const recovered = useMemo(() => new Set(recoveredKey.split("\n")), [recoveredKey]);
  const askedDms = useRef(new Set<string>());
  // One predicate for the header badge and the composer band: an empty
  // canonical Bot Chat has no origin to name (`hasKnownOrigin`).
  const knownOrigin = hasKnownOrigin(session, messages.length);
  const status = faceStatus(agent);
  const processContext = {
    fleetId,
    instance,
    bot,
    botTitle,
    status,
    starts,
    anchors: eventAnchors(items),
  };

  const notify = useNotifyIfAvailable();
  const openSection = useOpenAgentSection();
  /**
   * Whether the reader is at the live end of the transcript.
   *
   * It is a ref rather than state, and it is read *before* the rows change
   * rather than after: a turn that just appended is taller than it was, so
   * asking the node after the paint always answers "no" and the log would stop
   * following the first message it drew.
   */
  const pin = useRef<Pin>({ following: true, pinnedTop: null });
  // Re-pins on every late resize of a row (an image arriving, a card opening)
  // while the reader is following — see `stick-to-bottom.ts`.
  useStickToBottom(log, pin);

  // Opening a conversation lands at its latest message, whatever the previous
  // one was scrolled to — the pane is re-used across records, so without this
  // a switch inherits the old scroll offset and shows the middle of a
  // transcript nobody asked for.
  useEffect(() => {
    const node = log.current;
    pin.current.following = true;
    if (node) pinToBottom(node, pin.current);
  }, [instance, bot, session?.id]);

  // A bot-to-bot DM opened from its marker (`BotDm.tsx`), drawn over the log.
  // It belongs to the conversation it was opened from and closes with it.
  const [exchange, setExchange] = useState<ExchangeRequest | null>(null);
  useEffect(() => setExchange(null), [instance, bot, session?.id]);
  // A refused DM's Retry asks this bot through the composer's own path
  // (`BotDm.tsx`), so only where the composer could send it. `message_agent`
  // runs only in the canonical Bot Chat, so a refusal is only ever drawn in
  // the thread whose composer sends there. A ref keeps the context stable
  // across renders while still calling the newest `send`.
  const sendRef = useRef<(text: string) => void>(() => {});
  const retrySender = composer.enabled ? botLabel(instance, bot, botTitle) : null;
  const dm = useMemo(
    () => ({
      teammates,
      open: setExchange,
      retry:
        retrySender === null
          ? null
          : { send: (text: string) => sendRef.current(text), sender: retrySender },
      recovered,
      asked: askedDms.current,
    }),
    [teammates, retrySender, recovered],
  );

  // The log follows the bottom while a turn is arriving, and only then: a
  // reader who scrolled up into older turns is reading those, and yanking them
  // back down is the one thing a transcript must not do to them.
  useEffect(() => {
    const node = log.current;
    if (node && pin.current.following) pinToBottom(node, pin.current);
  }, [rows.length, live]);

  // Sending is the reader asking to be at the live end: their own message and
  // the reply to it land at the bottom even if they had scrolled up to quote.
  const send = (text: string, attachments?: readonly SentAttachment[]) => {
    pin.current.following = true;
    const node = log.current;
    if (node) pinToBottom(node, pin.current);
    return onSend(text, attachments);
  };
  sendRef.current = send;

  // Looking at a conversation is what marks its messages read (see `view-ack`).
  useViewAck({
    scroller: log,
    instance,
    bot,
    items: notify?.items,
    ackMany: notify?.ackMany,
    active: notify !== null,
  });

  const originText =
    destination.state === "known"
      ? (destination.detail ?? destination.origin)
      : destination.state === "pending"
        ? "reading…"
        : "unknown";

  return (
    <section className="ch-thread" {...drop.handlers}>
      {drop.overlay}
      <div className="ch-thead">
        <Face
          fleetId={fleetId}
          instance={instance}
          bot={bot}
          size={44}
          status={status}
          activity={activity === "idle" && remoteBusy === true ? "thinking" : activity}
          large
        />
        <div>
          <div className="ch-thead-name">
            {onRename ? (
              <BotTitleEdit
                label={botLabel(instance, bot, botTitle)}
                title={botTitle?.trim() && botTitle.trim() !== bot ? botTitle.trim() : null}
                fallback={botLabel(instance, bot, null)}
                onSave={onRename}
              />
            ) : (
              <span className="ch-thead-label" title={botLabel(instance, bot, botTitle)}>
                <RedactedText text={botLabel(instance, bot, botTitle)} />
              </span>
            )}
            {bot !== "default" ? (
              <span className="mono" title={`@ ${instance}`}>{`@ ${instance}`}</span>
            ) : null}
            {isDefault ? <span className="ch-default">default bot</span> : null}
          </div>
          <div className="ch-thead-sub">
            {/*
              The header's badge reads the same `Destination` the composer
              does. It must not fall back to `portal` for a session that
              has not been read — a badge saying `portal` is the same claim the
              band exists to stop the UI from making.
            */}
            {knownOrigin ? (
              <>
                <span className={`ch-origin ${originClass(destination)}`} title={originText}>
                  <i />
                  {originText}
                </span>
                <span>·</span>
              </>
            ) : null}
            <span className="ch-thead-fit" title={session?.title ?? "canonical Bot Chat"}>
              {session?.title ?? "canonical Bot Chat"}
            </span>
            <span>·</span>
            <span className="mono ch-thead-fit" title={agent?.tailscale_dns_name ?? instance}>
              {agent?.tailscale_dns_name ?? instance}
            </span>
          </div>
        </div>
        <div className="ch-thead-actions">
          {actions}
          {openSection && linksSections(agent) ? (
            <>
              <button
                type="button"
                className="ch-chip"
                title={`Open ${instance}'s desktop over this conversation`}
                onClick={() => openSection(instance, "desktop")}
              >
                Desktop
              </button>
              <button
                type="button"
                className="ch-chip"
                title={`Open a terminal on ${instance} over this conversation`}
                onClick={() => openSection(instance, "terminal")}
              >
                Terminal
              </button>
            </>
          ) : null}
          {fixture ? <span className="ch-chip static">canned</span> : null}
          {agent ? <span className="ch-chip static">{agent.display_status}</span> : null}
        </div>
      </div>

      <Band
        state={state}
        instance={instance}
        agent={agent}
        now={now}
        reconnectAttempt={reconnectAttempt}
        tailnetDetail={tailnetDetail}
      />

      <ObservationBand observation={observation} onResume={onResumeObservation} />

      {historyError ? (
        <div className="ch-band bad" role="alert">
          <i className="dot" />
          <span>The transcript could not be read.</span>
          <span className="sub">{historyError}</span>
        </div>
      ) : null}

      {turnError && !(all[all.length - 1]?.failure || all[all.length - 1]?.error) ? (
        // A failure the box reported is drawn on the turn itself, with what to
        // do about it (`FailureCard`); the band is for a turn refused before
        // it got there, which has no message to carry it.
        <div className="ch-band bad" role="alert">
          <i className="dot" />
          <span>{turnErrorHeadline(turnError.code)}</span>
          <span className="sub">{turnError.message}</span>
        </div>
      ) : null}

      <SubagentScope
        groups={rows.map((row) => ({ id: row.message.id, blocks: row.message.blocks }))}
        messages={all}
        liveId={live?.id ?? null}
        sending={sending}
        controls={subagents}
      >
        <div className="ch-log" ref={log} data-autoscroll>
          <BotDmContext.Provider value={dm}>
            <ProcessEventContext.Provider value={processContext}>
              {rows.length === 0 ? (
                <Empty state={state} instance={instance} bot={bot} tailnetDetail={tailnetDetail} />
              ) : (
                items.map((item) => {
                  // Keyed on the row's *first* source id: the merged row is named by
                  // its last one, which moves every time the turn takes another row,
                  // and a key that moves remounts the article — losing the group the
                  // reader closed and the step they opened mid-turn. A burst is keyed
                  // the same way, on its first event.
                  const key =
                    item.kind === "burst" ? item.key : (item.row.ids[0] ?? item.row.message.id);
                  const divider = item.kind === "burst" ? item.divider : item.row.divider;
                  const ids =
                    item.kind === "burst"
                      ? item.entries.map((entry) => entry.row.message.id)
                      : item.row.ids;
                  return (
                    <div key={key}>
                      {divider ? (
                        <div className="ch-divider">
                          <hr />
                          <span>{divider}</span>
                          <hr />
                        </div>
                      ) : null}
                      <RowBoundary
                        resetKey={`${ids.join(",")}:${item.kind === "turn" ? (item.row.message.blocks?.length ?? 0) : item.kind}`}
                        label={item.kind === "burst" ? item.key : item.row.message.id}
                      >
                        {item.kind === "burst" ? (
                          <ProcessBurst entries={item.entries} />
                        ) : item.kind === "event" ? (
                          <ProcessEventRow entry={item} />
                        ) : (
                          <Message
                            row={item.row}
                            fleetId={fleetId}
                            instance={instance}
                            bot={bot}
                            botTitle={botTitle}
                            status={status}
                            now={now}
                            streaming={sending && live !== null && item.row.message.id === live.id}
                            activity={
                              live !== null && item.row.message.id === live.id ? activity : "idle"
                            }
                            inReply={item.inReply}
                            remoteBusy={item.row.message.id === tailId ? remoteBusy : undefined}
                          />
                        )}
                      </RowBoundary>
                    </div>
                  );
                })
              )}
            </ProcessEventContext.Provider>
          </BotDmContext.Provider>
        </div>
      </SubagentScope>

      {exchange ? (
        <BotExchange
          request={exchange}
          fleetId={fleetId}
          instance={instance}
          bot={bot}
          botTitle={botTitle}
          status={status}
          transcript={all}
          teammates={teammates}
          now={now}
          onClose={() => setExchange(null)}
        />
      ) : null}

      <Composer
        destination={destination}
        choices={sessions}
        onChoose={onChooseSession}
        placeholder={
          composer.placeholder === "Message…"
            ? `Message ${botLabel(instance, bot, botTitle)}…`
            : composer.placeholder
        }
        enabled={composer.enabled}
        editable={composer.enabled || (destination.state === "pending" && composerState(state).enabled)}
        sending={sending}
        working={working}
        where={agent?.tailscale_dns_name ?? null}
        onSend={send}
        onAbort={onAbort}
        mentions={mentions}
        mentionHint={mentionHint}
        context={context}
      />
    </section>
  );
}
