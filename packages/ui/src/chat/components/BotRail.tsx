/** Bot identity and ordinary sessions have separate entry points. */
import { useState } from "react";
import type { BotView, RoomView, SessionView, SwarmView } from "../../api/index.ts";
import type { ChatSelection } from "../chat-state.tsx";
import { railTime, railUnread } from "../chat-logic.ts";
import {
  bucketSignal,
  railKey,
  toggleCollapsed,
  togglePinned,
  useRailPrefs,
} from "../chat-rail-prefs.ts";
import { useUnreadChatByConversation } from "../../state/notify-state.tsx";
import { activityFor } from "../chat-activity.ts";
import type { ConversationActivity } from "../chat-activity.ts";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { Face } from "./Face.tsx";
import { RedactedText } from "./RedactedText.tsx";
import { SILENT_LABEL, isSilentPreview } from "../chat-silence.ts";

export function BotRail({
  swarms,
  sessions,
  selection,
  room,
  fleetId,
  now,
  query,
  onQuery,
  onSelect,
  onRoom,
  onCreateBot,
  onCreateRoom,
  onNewSession,
  statusOf,
  activities,
  canonicalId,
}: {
  swarms: SwarmView[];
  sessions: SessionView[];
  selection: ChatSelection | null;
  room: RoomView | null;
  fleetId: string;
  now: number;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (instance: string, bot: string, session?: string | null) => void;
  onRoom: (room: RoomView) => void;
  onCreateBot: () => void;
  onCreateRoom: () => void;
  onNewSession: () => void;
  statusOf: (instance: string) => AvatarStatus;
  activities: readonly ConversationActivity[];
  canonicalId?: string | null;
}) {
  const [tab, setTab] = useState<"bots" | "sessions">("bots");
  const [filter, setFilter] = useState<"all" | "unread" | "needs">("all");
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase());
  const bots = swarms.flatMap((swarm) => swarm.bots);
  /**
   * The inbox's unread `chat.*` rows, added to the roster's own count: the two
   * go out of step, and an Unread filter that empties while the bell is lit
   * about those bots is the shape that takes.
   */
  const inbox = useUnreadChatByConversation();
  const unreadOf = (instance: string, name: string) => inbox.get(`${instance}/${name}`) ?? 0;
  /**
   * Rooms obey the filter the bots obey. A room is *needs you* when it has a
   * pending approval and *unread* when this laptop holds unread rows for it;
   * under either filter, a room that is neither is not an exception to the
   * question the operator asked.
   */
  const rooms = swarms
    .flatMap((swarm) => swarm.rooms)
    .filter(
      (item) =>
        filter === "all" ||
        (filter === "needs" && item.needs_action) ||
        (filter === "unread" && unreadOf(item.instance, item.id) > 0),
    );
  const searching = query.trim() !== "";
  const prefs = useRailPrefs(fleetId);
  const pinned = new Set(prefs.pinned);
  const collapsed = new Set(prefs.collapsed);
  const shown = (bot: BotView) =>
    matches(`${bot.title} ${bot.name} ${bot.instance}`) &&
    (filter === "all" ||
      (filter === "needs" && bot.needs_action) ||
      (filter === "unread" && railUnread(bot, unreadOf(bot.instance, bot.name)) > 0));
  /**
   * Pinned bots in the order they were pinned, lifted out of their buckets the
   * way Slack's starred channels leave their section: one row per bot, so an
   * unread count is never drawn twice. A pin whose bot is gone from the roster
   * draws nothing and stays stored — a box that is briefly unreachable still
   * reports its last-known bots, and a bot that comes back keeps its place.
   */
  const byKey = new Map(
    swarms.flatMap((swarm) => swarm.bots.map((bot) => [railKey(bot.instance, bot.name), bot] as const)),
  );
  const pinnedRows = prefs.pinned
    .map((key) => byKey.get(key))
    .filter((bot): bot is BotView => bot !== undefined && shown(bot));
  const row = (bot: BotView, inPinned: boolean) => {
    const unread = railUnread(bot, unreadOf(bot.instance, bot.name));
    const isPinned = pinned.has(railKey(bot.instance, bot.name));
    return (
      <div className="bm-row" key={`${bot.instance}/${bot.name}`}>
        <button
          type="button"
          className="ch-conv in-bucket"
          // The rail highlights the bot that *owns* the open thread. Opening
          // one of its additional sessions is still that bot's conversation,
          // and dropping the highlight left the rail claiming nothing was open.
          aria-current={
            !room && selection?.instance === bot.instance && selection.bot === bot.name
              ? true
              : undefined
          }
          data-unread={unread > 0 || bot.needs_action ? "true" : undefined}
          onClick={() => onSelect(bot.instance, bot.name)}
        >
          <Face
            fleetId={fleetId}
            instance={bot.instance}
            bot={bot.name}
            size={30}
            status={statusOf(bot.instance)}
            activity={activityFor(activities, bot.instance, bot.name)}
          />
          <span className="ch-conv-main">
            <span className="ch-conv-name">
              <b>
                <RedactedText text={bot.title} />
              </b>
            </span>
            <span className="ch-conv-prev">
              {/* Out of its bucket, a pinned row names its box itself. */}
              {inPinned ? <span className="bm-pin-where">{bot.instance} · </span> : null}
              {/* `||`, not `??`: a box can send an empty description, and an empty
                  string would leave the row blank under the name. */}
              {/* A bare `NO_REPLY` is the bot choosing not to answer, not its words. */}
              {isSilentPreview(bot.preview, bot.preview_role) ? (
                <span className="ch-conv-silent">{SILENT_LABEL}</span>
              ) : (
                <RedactedText text={bot.preview || bot.description || bot.name} />
              )}
            </span>
          </span>
          <span className="ch-conv-right">
            <span className="ch-time">{railTime(bot.last_message_at, now)}</span>
            {bot.needs_action || unread > 0 ? (
              <span className={`ch-unread${bot.needs_action ? " needs-action" : ""}`}>
                {bot.needs_action ? "!" : unread}
              </span>
            ) : null}
          </span>
        </button>
        {/* A sibling, not a child: a button inside a button is not a button. */}
        <button
          type="button"
          className="bm-pin"
          aria-pressed={isPinned}
          aria-label={`${isPinned ? "Unpin" : "Pin"} ${bot.title} @ ${bot.instance}`}
          title={isPinned ? "Unpin" : "Pin to top"}
          onClick={() => togglePinned(fleetId, bot.instance, bot.name)}
        >
          {isPinned ? "★" : "☆"}
        </button>
      </div>
    );
  };
  const ordinary = sessions.filter(
    (session) => session.kind !== "canonical" && session.id !== canonicalId,
  );
  return (
    <aside className="ch-rail bm-rail" aria-label="Bots and sessions">
      <div
        className="ch-filters"
        role="tablist"
        aria-label="Conversation type"
        onKeyDown={(event) => {
          // Two tabs, so ArrowLeft/ArrowRight both just flip which one is
          // active — the `tablist` role promises arrow-key movement between
          // tabs, and a plain `<button>` only gives Enter/Space for free.
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = tab === "bots" ? "sessions" : "bots";
          setTab(next);
          (
            event.currentTarget.querySelector(
              `[role="tab"]:nth-child(${next === "bots" ? 1 : 2})`,
            ) as HTMLElement | null
          )?.focus();
        }}
      >
        <button type="button" role="tab" aria-selected={tab === "bots"} onClick={() => setTab("bots")}>
          Bots · {bots.length}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sessions"}
          onClick={() => setTab("sessions")}
        >
          Sessions
        </button>
      </div>
      <div className="ch-rail-top">
        <input
          className="ch-search"
          aria-label="Search conversations"
          placeholder="Search conversations…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        <button
          type="button"
          className="ch-newchat"
          aria-label={tab === "bots" ? "Create bot" : "New separate session"}
          disabled={tab === "sessions" && !selection}
          onClick={tab === "bots" ? onCreateBot : onNewSession}
        >
          +
        </button>
        {tab === "sessions" ? (
          <span className="bm-active">
            {selection ? `${selection.bot} @ ${selection.instance}` : "Select a bot first"}
          </span>
        ) : null}
      </div>
      {tab === "bots" ? (
        <div className="ch-filters">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </button>
          <button type="button" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>
            Unread
          </button>
          <button type="button" aria-pressed={filter === "needs"} onClick={() => setFilter("needs")}>
            Needs you
          </button>
        </div>
      ) : null}
      <div className="ch-list">
        {tab === "bots" ? (
          <>
            {pinnedRows.length > 0 ? (
              <div className="bm-pinned">
                <div className="ch-group bm-pinned-head">
                  <span className="kicker">★ Pinned</span>
                  <span className="ch-time">{pinnedRows.length}</span>
                </div>
                {pinnedRows.map((bot) => row(bot, true))}
              </div>
            ) : null}
            {swarms.map((swarm) => {
              const rows = swarm.bots.filter(
                (bot) => shown(bot) && !pinned.has(railKey(bot.instance, bot.name)),
              );
              // A bucket whose every match is pinned has said all it has to
              // say in the Pinned group; an empty header under it is noise.
              if (!rows.length && swarm.reachable) return null;
              // Folding is a reachable bucket's only; an offline one is a label
              // (the Rail rule: a control that does nothing is worse than none).
              // Search opens every bucket — a match the operator typed for and
              // cannot see is a search that failed.
              const foldable = swarm.reachable;
              const folded = foldable && !searching && collapsed.has(swarm.instance);
              const drawn = folded
                ? rows.filter(
                    (bot) =>
                      !room && selection?.instance === bot.instance && selection.bot === bot.name,
                  )
                : rows;
              const signal = bucketSignal(rows, (bot) =>
                railUnread(bot, unreadOf(bot.instance, bot.name)),
              );
              const headClass = `ch-group ch-bucket bm-inst${swarm.reachable ? "" : " offline"}`;
              const head = (
                <>
                  {/* The slot is drawn on an offline header too, empty, so every
                      instance name starts at the same x. The header carries no
                      face: it is a heading over bots, not one of them. */}
                  <span className="tw" aria-hidden="true">
                    {foldable ? (folded ? "▸" : "▾") : ""}
                  </span>
                  <span className="kicker">{swarm.instance}</span>
                  {/* The instance's turn activity, without a face: a dot that
                      pulses while any of its bots is thinking or streaming, so
                      a folded instance still shows it is working. */}
                  <i
                    className="bm-inst-activity"
                    aria-hidden="true"
                    data-avatar-activity={
                      activities.find((a) => a.instance === swarm.instance)?.activity ?? "idle"
                    }
                  />
                  {/* One line, ellipsized, full text on hover: the header is a
                      fixed-height grid row, and a wrapped sentence spills over
                      the rows below it. */}
                  {!swarm.reachable ? (
                    <span className="bm-offline-reason" title={swarm.unreachable_reason ?? undefined}>
                      {swarm.unreachable_reason ?? "did not answer"}
                    </span>
                  ) : null}
                  <span className="ch-time">
                    {swarm.reachable
                      ? `${rows.length} bot${rows.length === 1 ? "" : "s"}`
                      : "last known · unreachable"}
                  </span>
                  {/* Folded is not muted: what the hidden rows would have said
                      stays on the header, so an instance you are not reading
                      can still ask for you. */}
                  {folded && (signal.needs > 0 || signal.unread > 0) ? (
                    <span className={`ch-unread${signal.needs > 0 ? " needs-action" : ""}`}>
                      {signal.needs > 0 ? "!" : signal.unread}
                    </span>
                  ) : null}
                </>
              );
              return (
                <div key={swarm.instance}>
                  {foldable ? (
                    <button
                      type="button"
                      className={headClass}
                      aria-expanded={!folded}
                      aria-label={`${folded ? "Expand" : "Collapse"} ${swarm.instance}`}
                      title={searching ? "Clear the search to collapse" : undefined}
                      disabled={searching}
                      onClick={() => toggleCollapsed(fleetId, swarm.instance)}
                    >
                      {head}
                    </button>
                  ) : (
                    <div className={headClass}>{head}</div>
                  )}
                  {drawn.map((bot) => row(bot, false))}
                </div>
              );
            })}
            <div className="ch-group">
              <span className="kicker">Group rooms</span>
              <button
                type="button"
                className="btn-mini"
                onClick={onCreateRoom}
                aria-label="New group room"
              >
                +
              </button>
            </div>
            {rooms
              .filter((item) => matches(`${item.name} ${item.instance}`))
              .map((item) => (
                <button
                  type="button"
                  key={`${item.instance}/${item.id}`}
                  className="ch-conv"
                  aria-current={
                    room?.id === item.id && room.instance === item.instance ? true : undefined
                  }
                  onClick={() => onRoom(item)}
                >
                  <span className="bm-room-icon" aria-hidden="true">
                    ▣
                  </span>
                  <span className="ch-conv-main">
                    <span className="ch-conv-name">
                      <b>{item.name}</b>
                    </span>
                    <span className="ch-conv-prev">
                      {item.members.length} members · {item.instance}
                    </span>
                  </span>
                  {item.needs_action ? <span className="ch-unread needs-action">!</span> : null}
                </button>
              ))}
            {rooms.length === 0 ? (
              <p className="bm-note">
                {filter === "all" ? "No rooms on watched instances." : "No rooms match this filter."}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="ch-group">
              <span className="kicker">Additional chats</span>
              <span className="ch-time">{ordinary.length}</span>
            </div>
            {ordinary
              .filter((session) => matches(`${session.title} ${session.origin}`))
              .map((session) => (
                <button
                  type="button"
                  className="ch-conv"
                  key={session.id}
                  aria-current={!room && selection?.session === session.id ? true : undefined}
                  onClick={() => onSelect(session.instance, session.bot, session.id)}
                >
                  <span className="ch-conv-main">
                    <span className="ch-conv-name">
                      <b>{session.title}</b>
                    </span>
                    <span className="ch-conv-prev">
                      {session.origin_detail ?? session.origin} · {session.turn_count} turns
                    </span>
                  </span>
                  <span className="ch-time">{railTime(session.last_message_at, now)}</span>
                </button>
              ))}
            {ordinary.length === 0 ? (
              <p className="bm-note">
                No additional sessions for this bot. Its Bot Chat remains in Bots.
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="ch-rail-foot bm-rail-foot">
        <button type="button" className="btn btn-primary" onClick={onCreateBot}>
          + New bot
        </button>
        <span>One home for every bot.</span>
      </div>
    </aside>
  );
}
