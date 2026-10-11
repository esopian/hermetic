import { useEffect, useRef, useState } from "react";
import { botHandle } from "@hermetic/core/shared";
import {
  ApiError,
  roomsGet,
  roomsHistory,
  roomsSend,
  roomsControl,
  roomsRename,
  roomsDelete,
  roomsRespond,
} from "../../api/index.ts";
import type { HostedRoomView, RoomEventView } from "../../api/index.ts";
import { HERMETIC_GATES } from "../bot-capabilities.ts";
import { useChatIfAvailable } from "../chat-state.tsx";
import { botLabel } from "../chat-presentation.ts";
import { SILENT_LABEL, isSilentPreview, silentTitle } from "../chat-silence.ts";
import { threadTime } from "../chat-logic.ts";
import { BotModeDialog, BotField } from "./BotModeDialog.tsx";
import { GatedNote } from "./CapabilityNote.tsx";
import { Face } from "./Face.tsx";
import { MentionList, useMentionPicker } from "./MentionPicker.tsx";
import { RedactedText } from "./RedactedText.tsx";
import { RowBoundary } from "./RowBoundary.tsx";
import { isVisible, onReturnVisible, RETURN_READ_MIN_AGE_MS } from "../../lib/visibility.ts";

/**
 * A submission whose delivery is not yet known: the text as it was sent and the
 * `event_id` the gateway deduplicates on. It is held by the workspace rather
 * than by this component because this component unmounts on every room switch,
 * and an unknown delivery is not permission to replay — a retry has to carry
 * the identity the first attempt carried, however the operator got back here.
 */
export type PendingSend = { text: string; id: string };

/** One page of room history; the gateway's own ceiling for `rooms.history`. */
const HISTORY_PAGE = 500;
/** Pages the first read may walk before it shows what it has and says so. */
const INITIAL_PAGES = 20;
/**
 * Pages a poll tick may walk. A tick normally reads one page and finds it
 * nearly empty; the extra pages only matter while the view is catching up with
 * a room whose history outran the initial bound. Either way the work a tick
 * does is capped, so it does not grow with the size of the transcript.
 */
const POLL_PAGES = 4;
/**
 * How far back from the room's high-water mark the first read starts.
 *
 * The hosted-room protocol has no tail read — no reverse flag, no `before_seq`,
 * no negative offset — so the only way to open at the recent end is to compute
 * `since_seq = latest_seq - N` from the mark the gateway reports. Reading from
 * seq 0 instead painted a long-lived room's oldest events first and crawled
 * forward over three-second ticks, showing stale history where the operator
 * expects the conversation they are in.
 *
 * 200 is core's own default page for `rooms.history`, so the window is one read
 * rather than a walk, and it is deep enough to be a real scrollback: a room
 * holds at most six members, so one operator turn appends at most seven events
 * and 200 covers roughly thirty full exchanges. What falls below the window is
 * not loaded and is said to be, not quietly dropped.
 */
const TAIL_WINDOW = 200;

/**
 * Appends the events the log has not shown yet. The gateway may replay a page
 * across polls — an overlapping `since_seq`, a retried read — and `event_id` is
 * the identity that survives that, so it is what dedupes here.
 */
function mergeEvents(shown: RoomEventView[], incoming: RoomEventView[]): RoomEventView[] {
  const seen = new Set(shown.map((event) => event.event_id));
  const added: RoomEventView[] = [];
  for (const event of incoming) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    added.push(event);
  }
  return added.length ? [...shown, ...added] : shown;
}

/**
 * What to call a room member.
 *
 * The room payload's own `display_name` is the gateway's capitalisation of the
 * profile id — `default` becomes "Default", `clown` becomes "Clown" — so a room
 * called two bots by names that appear nowhere else in the app, while the rail
 * two hundred pixels to the left called the same bots by their Hermes titles.
 * The roster is the same source the rail reads, so the two agree; the room's
 * own name is the fallback for a member whose profile this instance's roster
 * does not carry, and the raw id is the last resort.
 */
export function memberName(
  instance: string,
  profile: string | null | undefined,
  roomName: string | null | undefined,
  roster: ReadonlyMap<string, string | null | undefined>,
): string {
  if (profile && roster.has(profile)) return botLabel(instance, profile, roster.get(profile));
  const named = roomName?.trim();
  return named || profile || "";
}

export function RoomConversation({
  instance,
  id,
  fleetId,
  initialDraft = "",
  initialPending = null,
  pollMs = 3000,
  returnReadMinAgeMs = RETURN_READ_MIN_AGE_MS,
  onDraft,
  onPending,
  onClosed,
  onChanged,
}: {
  instance: string;
  id: string;
  fleetId: string;
  initialDraft?: string;
  initialPending?: PendingSend | null;
  /** Timing seams keep integration tests real-time without waiting production intervals. */
  pollMs?: number;
  returnReadMinAgeMs?: number;
  onDraft: (text: string) => void;
  onPending: (entry: PendingSend | null) => void;
  onClosed: () => void;
  onChanged: () => void;
}) {
  const [room, setRoom] = useState<HostedRoomView | null>(null),
    [events, setEvents] = useState<RoomEventView[]>([]),
    [error, setError] = useState(""),
    [draft, setDraft] = useState(initialDraft),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0),
    [truncated, setTruncated] = useState(false),
    /** How many events precede the window this pane opened on, and were not read. */
    [earlier, setEarlier] = useState(0),
    [notice, setNotice] = useState(""),
    [edit, setEdit] = useState(false),
    [remove, setRemove] = useState(false);
  const log = useRef<HTMLDivElement>(null),
    pending = useRef<PendingSend | null>(initialPending),
    /**
     * How far the log has been read. A poll asks only for what comes after it,
     * so a tick costs one small page however long the room has been running.
     * The workspace unmounts this component on a room switch and the transcript
     * goes with it, so the cursor deliberately starts over on remount: a cursor
     * without the events it names would show an empty room. Where it starts is
     * the first read's business — `TAIL_WINDOW` back from the room's own mark.
     */
    cursor = useRef(0),
    /** The `version` the room detail was last read at; `-1` is "never". */
    detailAt = useRef(-1),
    loaded = useRef(false),
    /** When the last history poll completed; shared with `onReturnVisible`. */
    lastReadAt = useRef(0);
  const chat = useChatIfAvailable();
  /** `profile → title`, from the same roster the rail draws its names from. */
  const roster = new Map<string, string | null | undefined>(
    (chat?.swarms.find((swarm) => swarm.instance === instance)?.bots ?? []).map((b) => [
      b.name,
      b.title,
    ]),
  );
  /** The clock every stamp in this pane is rendered against, shared with the rail. */
  const now = chat?.now ?? Date.now();
  const input = useRef<HTMLTextAreaElement>(null);
  const write = (text: string) => {
    setDraft(text);
    onDraft(text);
  };
  /**
   * Members as the gateway addresses them: it matches `@handle` against the
   * room's frozen roster (`hosted_room_discussion.resolve_mentions`), so the
   * handle is what is inserted, never a friendly slug it would not know.
   */
  const picker = useMentionPicker({
    text: draft,
    setText: write,
    input,
    candidates: (room?.members ?? []).map((member) => ({
      key: member.member_id,
      tag: member.handle,
      display: memberName(instance, member.profile, member.display_name, roster),
      forms: [botHandle(member.profile)],
      instance,
      bot: member.profile,
    })),
  });
  const memberOf = (id_: string | null | undefined) =>
    room?.members.find((m) => m.member_id === id_) ?? null;
  const target = { instance, room: id };
  /**
   * The room's own detail is read once, and again only when this pane changes
   * something (`version`). It carries the name, the roster, the working/blocked
   * flags and `latest_seq`, none of which a three-second tick was learning
   * anything new about — the transcript is what moves, and `rooms.history` from
   * a cursor is what reads it. Two RPCs per tick per open room, forever, was
   * the cost of not separating them.
   *
   * The tick also stops while the page is hidden and resumes with an immediate
   * read when it comes back, because a background tab polling a gateway over
   * the tailnet is work nobody is looking at. A tick never overlaps its
   * predecessor (`running`), and unmount aborts whatever is in flight.
   */
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let stopped = false;

    /** One page-walk from the cursor. `budget` is wider on the first read. */
    async function readHistory(budget: number) {
      const fresh: RoomEventView[] = [];
      let more = false;
      for (let page = 0; page < budget; page++) {
        const batch = await roomsHistory(
          { instance, room: id, since_seq: cursor.current, limit: HISTORY_PAGE },
          controller.signal,
        );
        fresh.push(...batch.events);
        more = batch.has_more;
        // `cursor` is what the gateway says it answered up to; the highest seq
        // in the page is the floor under it, so a gateway that reports a
        // cursor it has already passed still cannot stall the read.
        const reached = batch.events.reduce((seq, event) => Math.max(seq, event.seq), batch.cursor);
        if (reached <= cursor.current) break;
        cursor.current = reached;
        if (!more) break;
      }
      if (controller.signal.aborted) return;
      setEvents((shown) => mergeEvents(shown, fresh));
      setTruncated(more);
      setError("");
      // A tick that just ran makes an immediate return read redundant; stamping
      // here (not just on the return read itself) is what lets `onReturnVisible`
      // suppress a return that lands right after a normal tick.
      lastReadAt.current = Date.now();
    }

    async function refresh() {
      if (running) return;
      running = true;
      try {
        const first = !loaded.current;
        // The detail is re-read on the first tick of a version — the mount, and
        // every mutation this pane makes — and on no other.
        if (first || detailAt.current !== version) {
          const detail = await roomsGet({ instance, room: id }, controller.signal);
          if (controller.signal.aborted) return;
          if (first) {
            // Open at the recent end. `latest_seq` is the room's high-water
            // mark and the only tail signal the protocol gives; everything
            // below the window is deliberately not read, and the note above the
            // log says so rather than passing a partial transcript off as the
            // whole room. A gateway that reports no mark leaves this at 0,
            // which is the old walk-from-the-top read, bounded by
            // `INITIAL_PAGES` as before.
            cursor.current = Math.max(0, detail.latest_seq - TAIL_WINDOW);
            setEarlier(cursor.current);
          }
          setRoom(detail);
          detailAt.current = version;
        }
        loaded.current = true;
        await readHistory(first ? INITIAL_PAGES : POLL_PAGES);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        running = false;
        schedule();
      }
    }

    function schedule() {
      clearTimeout(timer);
      if (stopped || controller.signal.aborted) return;
      if (!isVisible()) return;
      timer = setTimeout(() => void refresh(), pollMs);
    }

    const hidden = () => {
      if (!isVisible()) clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", hidden);
    const unsubscribe = onReturnVisible(() => void refresh(), {
      minAgeMs: returnReadMinAgeMs,
      lastReadAt,
    });
    void refresh();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hidden);
      unsubscribe();
    };
  }, [instance, id, version, pollMs, returnReadMinAgeMs]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [events.length]);
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!draft.trim() || busy) return;
    const text = draft.trim();
    // A retry of the same text keeps the identity the first attempt used, so
    // the gateway can recognise the duplicate; a different message is a
    // different submission and gets its own. The workspace holds the entry, so
    // both rules survive navigating away from the room and back.
    if (!pending.current || pending.current.text !== text) {
      pending.current = { text, id: crypto.randomUUID() };
      onPending(pending.current);
    }
    const event_id = pending.current.id;
    await act(async () => {
      let receipt: Awaited<ReturnType<typeof roomsSend>>;
      try {
        receipt = await roomsSend({ ...target, text, event_id });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "CONFLICT") throw e;
        // The gateway already holds different text under this id, so this id
        // can never deliver this message however often it is retried. Retiring
        // it makes the next attempt a new submission rather than a second
        // conflict, and the wording says what happened — a transport error here
        // would invite exactly the retry that cannot work.
        pending.current = null;
        onPending(null);
        throw new Error(
          "This message id already carries different text in this room. The message posted under it stands; send again to post this text as a new message.",
        );
      }
      // Delivery is confirmed: the identity has done its job and is dropped, so
      // a later message with the same text is not posted under it.
      pending.current = null;
      onPending(null);
      setDraft("");
      onDraft("");
      // A retry the gateway recognised reconciled with the message already in
      // the room; it did not post a second one, and it must not read as if it
      // had.
      if (receipt.duplicate)
        setNotice("Already delivered — the gateway recognised this message and kept the original.");
    });
  }
  return (
    <>
      <section className="ch-thread">
        <div className="ch-thead bm-room-head">
          <span className="bm-room-icon">▣</span>
          {/*
            The identity is its own block so the header has exactly three: icon,
            identity, actions. Under 700px `.ch-thead` drops to two columns and
            the actions move to a row of their own beneath the title — see the
            `.bm-room-head` rules at the tail of chat.css.
          */}
          <div className="ch-thead-id">
            <div className="ch-thead-name">
              {room?.name ?? "Group room"}
              <span className="ch-chip">Group room</span>
            </div>
            <div className="ch-thead-sub">
              {room?.members.length ?? 0} members · {instance}
            </div>
          </div>
          <div className="ch-thead-actions">
            <button type="button" className="btn-mini" onClick={() => setEdit(true)}>
              Manage
            </button>
            <button
              type="button"
              className="btn-mini"
              disabled={busy}
              onClick={() => void act(() => roomsControl({ ...target, action: "stop" }))}
            >
              Stop
            </button>
          </div>
        </div>
        <div className="bm-strip">
          Shared room · hosted on this instance ·{" "}
          {room?.working ? "Working" : room?.blocked ? "Needs you" : "Ready"}
        </div>
        {error ? (
          <p role="alert" className="bm-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="bm-note">
            {notice}
          </p>
        ) : null}
        <div className="ch-log" ref={log}>
          {earlier || truncated ? (
            <p className="bm-note">
              {earlier
                ? `This room opens at its recent end; ${earlier} earlier ${
                    earlier === 1 ? "event was" : "events were"
                  } not loaded. Open the complete log in Hermes.`
                : "History truncated for display; open the complete log in Hermes."}
              {truncated ? " This view keeps catching up." : ""}
            </p>
          ) : null}
          {events
            .filter((e) => e.text)
            .map((event) => {
              const bot = event.actor.kind !== "user";
              const who = event.member_id ?? event.actor.id;
              const member = memberOf(who);
              const name = bot
                ? memberName(instance, member?.profile ?? who, member?.display_name, roster)
                : "You";
              // A member's post that is only a Hermes silence token is the same
              // muted marker the bot thread draws (`chat-silence.ts`). The
              // operator's own words and any non-message event stay literal.
              if (bot && event.kind.startsWith("message") && isSilentPreview(event.text)) {
                return (
                  <RowBoundary key={`${event.seq}-${event.event_id}`} label={event.event_id}>
                    <article className="ch-silent" title={silentTitle(event.text ?? "")}>
                      <span className="ch-silent-gut">
                        <Face
                          fleetId={fleetId}
                          instance={instance}
                          bot={who}
                          size={20}
                          status="ready"
                          square={false}
                        />
                      </span>
                      <span className="ch-silent-line">
                        <b>{name}</b> {SILENT_LABEL}
                        <span className="ch-silent-at">{threadTime(event.created_at, now)}</span>
                      </span>
                    </article>
                  </RowBoundary>
                );
              }
              return (
                <RowBoundary key={`${event.seq}-${event.event_id}`} label={event.event_id}>
                  <article className="ch-msg">
                    {bot ? (
                      <Face
                        fleetId={fleetId}
                        instance={instance}
                        bot={who}
                        size={36}
                        status="ready"
                        square={false}
                      />
                    ) : (
                      <div className="ch-avatar me">ME</div>
                    )}
                    <div className="ch-msg-body">
                      <div className="ch-msg-head">
                        <b>{name}</b>
                        {/* One formatter for every stamp in the app; see `threadTime`. */}
                        <time>{threadTime(event.created_at, now)}</time>
                      </div>
                      <p className="bm-pre">
                        <RedactedText text={event.text ?? ""} />
                      </p>
                    </div>
                  </article>
                </RowBoundary>
              );
            })}
          {!events.length ? (
            <p className="bm-note">Start a shared conversation with these bots.</p>
          ) : null}
          {room?.pending_actions.map((action) => (
            <div className="ch-approve" key={action.task_id}>
              <p>{action.text ?? "A room member needs attention"}</p>
              {action.kind === "approval" &&
              action.member_id &&
              action.request_id &&
              action.execution_generation !== undefined ? (
                (["once", "session", "always", "deny"] as const).map((choice) => (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    key={choice}
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        roomsRespond({
                          ...target,
                          member_id: action.member_id!,
                          request_id: action.request_id!,
                          task_id: action.task_id,
                          execution_generation: action.execution_generation!,
                          choice,
                        }),
                      )
                    }
                  >
                    {choice}
                  </button>
                ))
              ) : action.kind === "retry" ? (
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      roomsControl({ ...target, action: "retry", task_id: action.task_id }),
                    )
                  }
                >
                  Retry task
                </button>
              ) : (
                <p>Respond in Hermes.</p>
              )}
            </div>
          ))}
        </div>
        <div className="ch-composer">
          <div className="ch-input-wrap bm-input-wrap">
            <MentionList picker={picker} fleetId={fleetId} label="Mention a room member" />
            <textarea
              ref={input}
              className="ch-input"
              aria-label="Message the room"
              placeholder="Message the room…"
              value={draft}
              {...picker.inputProps}
              onChange={(e) => {
                write(e.target.value);
                picker.track(e.target);
              }}
              onSelect={(e) => picker.track(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || picker.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="ch-send"
              type="button"
              disabled={busy || !draft.trim() || !room}
              onClick={() => void send()}
            >
              Send ↑
            </button>
          </div>
          <div className="ch-composer-foot">
            @everyone or @member · a new message continues a stopped discussion
          </div>
        </div>
      </section>
      <aside className="ch-ctx bm-jobs">
        <div className="ch-ctx-head">Room members</div>
        <div className="ch-ctx-body">
          <div className="ch-ctx-sec">
            {room?.members.map((member) => (
              <div className="bm-member" key={member.member_id}>
                <Face
                  fleetId={fleetId}
                  instance={instance}
                  bot={member.profile}
                  size={30}
                  status="ready"
                />
                <div>
                  <b>{memberName(instance, member.profile, member.display_name, roster)}</b>
                  <p className="bm-note">
                    {member.profile} · {instance}
                  </p>
                </div>
              </div>
            ))}
            <button className="btn btn-secondary bm-wide" type="button" onClick={() => setEdit(true)}>
              Manage room
            </button>
          </div>
          {/*
           * Why the roster cannot be edited, attributed to whoever actually
           * withholds it. The capability probe reports the hosted-room feature
           * set this gateway advertises; `membership_edit` is false because
           * Hermetic has not implemented and qualified that behaviour, not
           * because the gateway or the Hermes version refused it. Saying "this
           * Hermes version" here blamed the box for a decision made in this
           * repo — and the members panel is also the one place that names each
           * member's instance, so it is where "can this room reach a bot on
           * another box" gets asked and answered.
           */}
          <div className="ch-ctx-sec">
            <p className="bm-note">
              Hosted on {instance}. Discussion continues with this browser closed.
            </p>
            <GatedNote>{HERMETIC_GATES.membership_edit}</GatedNote>
            <GatedNote>{HERMETIC_GATES.cross_instance_relay}</GatedNote>
          </div>
        </div>
      </aside>
      {edit ? (
        <BotModeDialog
          title="Manage room"
          onClose={() => setEdit(false)}
          onSubmit={async (data) => {
            await roomsRename({
              ...target,
              name: String(data.get("name")),
              event_id: crypto.randomUUID(),
            });
            onChanged();
            setVersion((v) => v + 1);
          }}
        >
          <BotField label="Room name" name="name" value={room?.name} required />
          {/*
           * Same gate, same words as the create dialog and the members panel.
           * This dialog previously credited the gateway with "fixed
           * membership"; the gateway advertises the room feature set, and it is
           * Hermetic that has not shipped member editing.
           */}
          <GatedNote>{HERMETIC_GATES.membership_edit}</GatedNote>
          <p className="bm-note">To change members, create another room; this history is preserved.</p>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setEdit(false);
              setRemove(true);
            }}
          >
            Disband room
          </button>
        </BotModeDialog>
      ) : null}
      {remove ? (
        <BotModeDialog
          title="Disband room"
          submit="Disband room"
          onClose={() => setRemove(false)}
          onSubmit={async () => {
            await roomsDelete({ ...target, confirm: true });
            onChanged();
            onClosed();
          }}
        >
          <p>Stop this room and revoke its member routes? This room cannot be reopened.</p>
        </BotModeDialog>
      ) : null}
    </>
  );
}
