/**
 * The rail: scope, search, filters, roster .
 *
 * One switcher at the top decides the *shape* of everything under it (§9.2).
 * **All instances** is the default and draws one collapsible `.ch-bucket` per
 * box, with the operator's sections nested inside. **One instance** drops the
 * bucket entirely and promotes that box's own `.ch-section`s to the top level.
 * Both filter identically — that is what makes the switcher a switch rather
 * than a second rail — and `railBuckets()` in `chat-logic.ts` is where the
 * difference actually lives, so it is tested without mounting this.
 *
 * **An unreachable box keeps its bucket.** It is drawn `.offline` — striped,
 * not clickable, carrying what was last known — rather than vanishing. A box
 * that is off the tailnet is the box an operator is most likely to be looking
 * for, and a rail that quietly drops it answers "where did ember go" with
 * silence.
 *
 * The three warm-slot squares are in the bucket header for the reason §11 Risk
 * 9 gives: upstream keeps ~3 backends warm per gateway and *fails* an open
 * after thirty seconds of waiting for one. On a laptop that is a pause; on
 * thirteen unattended boxes it is a dead click. The queue has to be visible
 * from the first second rather than the thirtieth.
 */
import { activityFor } from "../chat-activity.ts";
import type { ConversationActivity, TurnActivity } from "../chat-activity.ts";
import { botLabel } from "../chat-presentation.ts";
import { RedactedText } from "./RedactedText.tsx";
import { SILENT_LABEL, isSilentPreview } from "../chat-silence.ts";
import { useState } from "react";
import type { BotView, SessionView, SwarmView } from "../../api/index.ts";
import {
  railBuckets,
  railFooter,
  railTime,
  railUnread,
  unreadBadge,
  warmSlots,
} from "../chat-logic.ts";
import type { RailBucket, RailFilter, RailScope } from "../chat-logic.ts";
import { useUnreadChatByConversation } from "../../state/notify-state.tsx";
import type { ChatSelection } from "../chat-state.tsx";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { Face } from "./Face.tsx";

const FILTERS: { id: RailFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "needs", label: "Needs you" },
];

function Conv({
  bot,
  inboxUnread,
  fleetId,
  /** The box's own state, from the fleet row. Never assumed — see `Rail`'s prop. */
  status,
  activity,
  nested,
  current,
  now,
  onSelect,
}: {
  bot: BotView;
  /** Unread `chat.*` rows this laptop holds for the bot, on top of the roster's. */
  inboxUnread: number;
  fleetId: string;
  status: AvatarStatus;
  activity: TurnActivity;
  /** `in-bucket` under an instance header, `in-section` under one of the operator's. */
  nested: "in-bucket" | "in-section";
  current: boolean;
  now: number;
  onSelect: () => void;
}) {
  const badge = unreadBadge(bot, inboxUnread);
  return (
    <button
      type="button"
      className={`ch-conv ${nested}`}
      aria-current={current ? true : undefined}
      data-unread={railUnread(bot, inboxUnread) > 0 || bot.needs_action ? "true" : undefined}
      onClick={onSelect}
    >
      <Face
        fleetId={fleetId}
        instance={bot.instance}
        bot={bot.name}
        size={30}
        status={status}
        activity={bot.muted ? "muted" : activity}
      />
      <span className="ch-conv-main">
        <span className="ch-conv-name">
          <b>
            <RedactedText text={botLabel(bot.instance, bot.name, bot.title)} />
          </b>
          {bot.is_default ? <span className="ch-default">default</span> : null}
          {/* A bot with no warm slot is queued, and the wait is stated rather
              than left to look like a hung click. */}
          {!bot.warm && bot.needs_action ? <span className="ch-chip static warn">no slot</span> : null}
        </span>
        {/*
          The design puts the last message here. The roster read does not carry
          one — `Bot` has no preview field, and inventing one would mean a
          history read per bot on every rail paint, which is thirteen boxes'
          worth of fan-out for one line of grey text. The bot's own description
          is what there is, and it is at least always true. `||` rather than
          `??`, because a box can send an empty string for either.
        */}
        <span className="ch-conv-prev">
          {isSilentPreview(bot.preview) ? (
            <span className="ch-conv-silent">{SILENT_LABEL}</span>
          ) : (
            bot.preview || bot.description || botLabel(bot.instance, bot.name, bot.title)
          )}
        </span>
      </span>
      <span className="ch-conv-right">
        <span className="ch-time">{railTime(bot.last_message_at, now)}</span>
        {badge ? (
          <span className={bot.needs_action ? "ch-unread needs-action" : "ch-unread"}>{badge}</span>
        ) : null}
        {bot.muted ? <span className="ch-muted-icon">⊘</span> : null}
      </span>
    </button>
  );
}

function Bucket({
  bucket,
  fleetId,
  status,
  activity,
  collapsed,
  onToggle,
  children,
  now,
}: {
  bucket: RailBucket<BotView>;
  fleetId: string;
  status: AvatarStatus;
  activity: TurnActivity;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  now: number;
}) {
  const offline = !bucket.reachable;
  const slots =
    bucket.warmTotal === null
      ? []
      : warmSlots(bucket.warmUsed, bucket.warmTotal, bucket.warmUsed >= bucket.warmTotal);
  // An offline bucket is a `div` and not a `button`: it is read-only, and a
  // control that looks pressable and does nothing is worse than a label.
  const Header = offline ? "div" : "button";
  return (
    <>
      <Header
        {...(offline
          ? {}
          : { type: "button" as const, onClick: onToggle, "aria-expanded": !collapsed })}
        className={offline ? "ch-bucket offline" : "ch-bucket"}
      >
        <span className="tw">{collapsed ? "▸" : "▾"}</span>
        <Face
          fleetId={fleetId}
          instance={bucket.instance}
          bot={bucket.instance}
          size={18}
          activity={activity}
          status={status}
          square={false}
        />
        <b>{bucket.instance}</b>
        <span className="meta">
          {offline ? (
            // The whole of what an offline bucket says: why, and how stale.
            <>
              {bucket.reason ?? "unreachable"} · last known {railTime(bucket.lastAt, now)}
            </>
          ) : (
            <>
              <span className="ch-slots">
                {slots.map((cls, i) => (
                  // A slot is identified by its position.
                  <i key={i} className={cls} />
                ))}
              </span>{" "}
              {`${bucket.botCount} bot${bucket.botCount === 1 ? "" : "s"}`}
            </>
          )}
        </span>
      </Header>
      {collapsed ? null : children}
    </>
  );
}

export function Rail({
  swarms,
  turnActivities = [],
  fleetId,
  statusOf,
  sessions,
  scope,
  onScope,
  filter,
  onFilter,
  query,
  onQuery,
  selection,
  onSelect,
  now,
}: {
  swarms: SwarmView[];
  turnActivities?: readonly ConversationActivity[];
  fleetId: string;
  /**
   * The fleet row's state for one box, which is the only honest source for it.
   * The roster read says whether a *gateway* answered; whether the box is
   * degraded, stopped or destroyed is the fleet stream's to say, and a rail that
   * painted every face green was making a claim it had not checked.
   */
  statusOf: (instance: string) => AvatarStatus;
  /** The selected bot's sessions, so a foreign one can be reached at all. */
  sessions: SessionView[];
  scope: RailScope;
  onScope: (scope: RailScope) => void;
  filter: RailFilter;
  onFilter: (filter: RailFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  selection: ChatSelection | null;
  onSelect: (instance: string, bot: string, session?: string | null) => void;
  now: number;
}) {
  /** Which buckets the operator has folded shut. Offline ones start shut. */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  /**
   * The inbox's own unread rows, added to the roster's count. Without an inbox
   * provider this is empty and the rail behaves exactly as it did.
   */
  const inbox = useUnreadChatByConversation();
  const unreadOf = (instance: string, bot: string) => inbox.get(`${instance}/${bot}`) ?? 0;
  const buckets = railBuckets<BotView>(swarms, { scope, filter, query, unreadOf });
  const foot = railFooter(buckets);
  const one = scope.kind === "instance";

  const toggle = (instance: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(instance)) next.delete(instance);
      else next.add(instance);
      return next;
    });

  return (
    <aside className="ch-rail">
      {/*
        The scope switcher. A popover listing every instance would be the obvious
        design; this is the same two states reached by one button, because the
        popover's list and the rail's list are the same list and the rail is
        already on screen. Scoping to the thread you are in is the move the
        popover exists to make.
      */}
      <button
        type="button"
        className="ch-scope"
        onClick={() =>
          onScope(
            one || !selection ? { kind: "all" } : { kind: "instance", instance: selection.instance },
          )
        }
      >
        <span className="ch-scope-all">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="lbl">
          <b>{one && scope.kind === "instance" ? scope.instance : "All instances"}</b>
          <span>{`${foot.roster}${one ? "" : " · every swarm, grouped by box"}`}</span>
        </span>
        <span className="caret">▾</span>
      </button>

      <div className="ch-rail-top">
        <input
          className="ch-search"
          placeholder="jump to bot, instance, message…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>

      <div className="ch-filters" data-pressgroup>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => onFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="ch-list">
        {buckets.map((bucket) => {
          const rows = bucket.sections.map((section) => (
            <div key={section.name ?? "_none"}>
              {/* A section header is drawn whenever the operator named one. In
                  one-instance scope these are the top level; in all-instances
                  scope they are nested under the bucket. */}
              {section.name ? (
                <div className="ch-section">
                  {section.name} <span className="count">{section.bots.length}</span>
                </div>
              ) : null}
              {section.bots.map((bot) => {
                const open = selection?.instance === bot.instance && selection.bot === bot.name;
                return (
                  <div key={`${bot.instance}/${bot.name}`}>
                    <Conv
                      bot={bot}
                      inboxUnread={unreadOf(bot.instance, bot.name)}
                      fleetId={fleetId}
                      status={statusOf(bot.instance)}
                      activity={activityFor(turnActivities, bot.instance, bot.name)}
                      nested={section.name ? "in-section" : "in-bucket"}
                      current={open}
                      now={now}
                      onSelect={() => onSelect(bot.instance, bot.name, null)}
                    />
                    {/*
                      The selected bot's sessions, and the reason they are drawn
                      at all: a bot's conversations are where the origins live,
                      and without a row to click, every `cli`, `routine`, `peer`,
                      `room` and `channel` session on the fleet is unreachable —
                      which would make the composer's destination restatement
                      (send label and footer) a feature that almost never fires. Only the selected bot's, because the
                      session list is read one bot at a time.
                    */}
                    {open && sessions.length > 0 ? (
                      <details className="ch-additional-chats">
                        <summary>
                          Additional chats <span>{sessions.length}</span>
                        </summary>
                        {sessions.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className="ch-conv in-section"
                            aria-current={selection?.session === s.id ? true : undefined}
                            data-unread={s.unread > 0 ? "true" : undefined}
                            onClick={() => onSelect(bot.instance, bot.name, s.id)}
                          >
                            <span className="ch-conv-main">
                              <span className="ch-conv-name">
                                <b>
                                  <RedactedText text={s.title} />
                                </b>
                                <span className={`ch-origin ${s.origin}`}>
                                  <i />
                                  {s.origin_detail ?? s.origin}
                                </span>
                              </span>
                              <span className="ch-conv-prev">{`${s.turn_count} turns`}</span>
                            </span>
                            <span className="ch-conv-right">
                              <span className="ch-time">{railTime(s.last_message_at, now)}</span>
                              {s.unread > 0 ? <span className="ch-unread">{s.unread}</span> : null}
                            </span>
                          </button>
                        ))}
                      </details>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ));

          // One-instance scope drops the bucket: the operator already said which
          // box they mean, and a header repeating it is a row of the rail spent
          // on a fact that is in the switcher above.
          if (one) return <div key={bucket.instance}>{rows}</div>;

          return (
            <Bucket
              key={bucket.instance}
              bucket={bucket}
              fleetId={fleetId}
              status={statusOf(bucket.instance)}
              activity={activityFor(turnActivities, bucket.instance)}
              collapsed={!bucket.reachable || folded.has(bucket.instance)}
              onToggle={() => toggle(bucket.instance)}
              now={now}
            >
              {rows}
            </Bucket>
          );
        })}
        {buckets.length === 0 ? (
          <div className="ch-section">
            {swarms.length === 0 ? "reading the fleet's rosters…" : "nothing matches"}
          </div>
        ) : null}
      </div>

      <div className="ch-rail-foot">
        <span>{foot.roster}</span>
        <span>{foot.attention}</span>
      </div>
    </aside>
  );
}
