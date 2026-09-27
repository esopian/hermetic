/** Bot identity and ordinary sessions have separate entry points. */
import { useState } from "react";
import type { RoomView, SessionView, SwarmView } from "../../api/index.ts";
import type { ChatSelection } from "../chat-state.tsx";
import { railTime, railUnread } from "../chat-logic.ts";
import { useUnreadChatByConversation } from "../../state/notify-state.tsx";
import { activityFor } from "../chat-activity.ts";
import type { ConversationActivity } from "../chat-activity.ts";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { Face } from "./Face.tsx";
import { RedactedText } from "./RedactedText.tsx";

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
  const [activeOnly, setActiveOnly] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread" | "needs">("all");
  const [scoped, setScoped] = useState(false);
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
  const ordinary = sessions.filter(
    (session) => session.kind !== "canonical" && session.id !== canonicalId,
  );
  return (
    <aside className="ch-rail bm-rail" aria-label="Bots and sessions">
      <button
        type="button"
        className="ch-scope bm-scope"
        onClick={() => setScoped((v) => !v)}
        aria-label="Change instance scope"
      >
        <span className="ch-scope-all">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="lbl">
          <b>{scoped ? (selection?.instance ?? "Watched instance") : "Watched instances"}</b>
          <span>
            {swarms.length} instances · {bots.length} profiles
          </span>
        </span>
      </button>
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
        {tab === "bots" ? (
          <label className="bm-active">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(event) => setActiveOnly(event.target.checked)}
            />{" "}
            Active now
          </label>
        ) : (
          <span className="bm-active">
            {selection ? `${selection.bot} @ ${selection.instance}` : "Select a bot first"}
          </span>
        )}
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
            {swarms
              .filter((s) => !scoped || s.instance === selection?.instance)
              .map((swarm) => {
                const rows = swarm.bots.filter(
                  (bot) =>
                    matches(`${bot.title} ${bot.name} ${swarm.instance}`) &&
                    (filter === "all" ||
                      (filter === "needs" && bot.needs_action) ||
                      (filter === "unread" &&
                        railUnread(bot, unreadOf(swarm.instance, bot.name)) > 0)) &&
                    (!activeOnly || activityFor(activities, swarm.instance, bot.name) !== "idle"),
                );
                if (!rows.length && swarm.reachable) return null;
                return (
                  <div key={swarm.instance}>
                    <div
                      className={`ch-group${scoped ? "" : " ch-bucket"}${swarm.reachable ? "" : " offline"}`}
                    >
                      <Face
                        fleetId={fleetId}
                        instance={swarm.instance}
                        bot="default"
                        size={22}
                        status={statusOf(swarm.instance)}
                        activity={
                          activities.find((a) => a.instance === swarm.instance)?.activity ?? "idle"
                        }
                      />
                      <span className="kicker">{swarm.instance}</span>
                      {/* One line, ellipsized, full text on hover: the header is a
                          fixed-height grid row, and a wrapped sentence spills over
                          the rows below it. */}
                      {!swarm.reachable ? (
                        <span
                          className="bm-offline-reason"
                          title={swarm.unreachable_reason ?? undefined}
                        >
                          {swarm.unreachable_reason ?? "did not answer"}
                        </span>
                      ) : null}
                      <span className="ch-time">
                        {swarm.reachable ? `${rows.length} bots` : "last known · unreachable"}
                      </span>
                    </div>
                    {scoped
                      ? swarm.sections.map((section) => (
                          <div className="ch-section" key={section}>
                            {section}
                          </div>
                        ))
                      : null}
                    {rows.map((bot) => (
                      <button
                        type="button"
                        className="ch-conv in-bucket"
                        key={bot.name}
                        // The rail highlights the bot that *owns* the open
                        // thread. Opening one of its additional sessions is
                        // still that bot's conversation, and dropping the
                        // highlight left the rail claiming nothing was open.
                        aria-current={
                          !room && selection?.instance === bot.instance && selection.bot === bot.name
                            ? true
                            : undefined
                        }
                        data-unread={
                          railUnread(bot, unreadOf(bot.instance, bot.name)) > 0 || bot.needs_action
                            ? "true"
                            : undefined
                        }
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
                            <RedactedText text={bot.preview ?? bot.description ?? bot.name} />
                          </span>
                        </span>
                        <span className="ch-conv-right">
                          <span className="ch-time">{railTime(bot.last_message_at, now)}</span>
                          {bot.needs_action || railUnread(bot, unreadOf(bot.instance, bot.name)) > 0 ? (
                            <span className={`ch-unread${bot.needs_action ? " needs-action" : ""}`}>
                              {bot.needs_action
                                ? "!"
                                : railUnread(bot, unreadOf(bot.instance, bot.name))}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
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
