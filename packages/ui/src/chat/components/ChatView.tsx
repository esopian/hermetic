import { BotWorkspace } from "./BotWorkspace.tsx";
/**
 * `.ch-body` — rail, thread, context (§9.2).
 *
 * The app shell above this — `.header`, `.envstrip`, `.viewnav`, `.footer` — is
 * byte-identical to the fleet view's and is not re-implemented here. Brutalism
 * is right for a surface you *scan*; a transcript is a surface you *read*, and
 * the softening stops at the edge of this element. `data-skin` is on the body
 * because the stylesheet is scoped to it; one skin ships (`soft`) and the
 * attribute exists so the CSS has something to hang off, not as a setting.
 *
 * This component owns no state. It reads the store (`chat-state.tsx`), derives
 * the thread's condition from the *fleet* row (`chat-logic.ts`), and hands both
 * halves down. The one thing it decides is which agent row belongs to the
 * selected instance — which is a lookup, and the reason a `hermetic` block's
 * agent card and this panel can never disagree.
 */
import { useCallback, useEffect } from "react";
import { useListeningIfAvailable } from "../../state/listening-state.tsx";
import { useFleetIfAvailable } from "../../state/state.tsx";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { useChat } from "../chat-state.tsx";
import { chatHash, isChatHash } from "../chat-routing.ts";
import { threadState } from "../chat-logic.ts";
import { Context } from "./Context.tsx";
import { Rail } from "./Rail.tsx";
import { NoRoute, Thread } from "./Thread.tsx";

export function ChatView({
  withContext = true,
  withRail = true,
}: {
  withContext?: boolean;
  withRail?: boolean;
}) {
  const chat = useChat();
  const listening = useListeningIfAvailable();
  useEffect(() => chat.showThread(), [chat.showThread]);
  const fleet = useFleetIfAvailable();
  const fleetId = fleet?.meta?.config?.fleet_id ?? "";
  const fixture = fleet?.meta?.fixture === true;

  const selection = chat.selection;
  const agent = selection ? (fleet?.byName.get(selection.instance) ?? null) : null;
  const swarm = selection ? chat.swarms.find((s) => s.instance === selection.instance) : undefined;
  const bot = selection ? swarm?.bots.find((b) => b.name === selection.bot) : undefined;

  /**
   * A box's state, from the fleet row, with `pending` for a box this tree has
   * no row for. Shared by the rail and the thread so one face cannot disagree
   * with another about the same box.
   */
  const statusOf = useCallback(
    (name: string): AvatarStatus => {
      const status = fleet?.byName.get(name)?.display_status;
      switch (status) {
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
        default:
          return "pending";
      }
    },
    [fleet],
  );

  const state = threadState({
    status: agent?.display_status ?? null,
    // A swarm this read has not produced yet is not an unreachable one. Absence
    // reads as reachable so a thread does not flash "no answer" while the
    // fleet-wide roster fan-out is still in flight.
    reachable: swarm ? swarm.reachable : true,
    reconnecting: chat.reconnecting,
    empty: chat.historyRead && chat.messages.length === 0 && chat.live === null,
    /**
     * `offTailnet`, not `fleetUnreachable`. Every box failing to answer is the
     * symptom; this is the diagnosis, and it is only true once `doctor` has
     * read *this machine's* tailscale and found it unusable. Until then — and
     * for a fleet that really is just switched off — the thread reports the box
     * it is looking at as unreachable, which is the honest answer and the one
     * with a different fix.
     */
    fleetUnreachable: chat.offTailnet,
  });

  if (withRail) return <BotWorkspace withContext={withContext} />;

  /** The rail's select, shared with the composer's session chips. */
  const select = (where: string, name: string, session: string | null = null) => {
    if (chat.select(where, name, session) && isChatHash(window.location.hash))
      window.location.hash = chatHash({ instance: where, bot: name, session });
  };

  return (
    <div
      className={!withRail ? "ch-body ch-compact" : withContext ? "ch-body with-context" : "ch-body"}
      data-skin="soft"
    >
      {withRail ? (
        <Rail
          swarms={chat.swarms}
          turnActivities={chat.turnActivities}
          fleetId={fleetId}
          statusOf={statusOf}
          sessions={chat.sessions}
          scope={chat.scope}
          onScope={chat.setScope}
          filter={chat.filter}
          onFilter={chat.setFilter}
          query={chat.query}
          onQuery={chat.setQuery}
          selection={selection}
          onSelect={select}
          now={chat.now}
        />
      ) : null}

      {listening && !listening.loading && listening.instances.length === 0 ? (
        <section className="ch-thread">
          <div className="ch-empty">
            <div>
              <h2>No instances watched</h2>
              <p>
                Choose Listen on an instance in the fleet screen to see its bots, open chat, and receive
                alerts.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  window.location.hash = "";
                }}
              >
                Go to fleet
              </button>
            </div>
          </div>
        </section>
      ) : selection ? (
        <Thread
          fleetId={fleetId}
          instance={selection.instance}
          bot={selection.bot}
          botTitle={bot?.title ?? null}
          isDefault={bot?.is_default ?? false}
          agent={agent}
          session={chat.session}
          destination={chat.destination}
          state={state}
          messages={chat.messages}
          live={chat.live}
          sending={chat.sending}
          activity={chat.activity}
          historyError={chat.historyError}
          now={chat.now}
          fixture={fixture}
          reconnectAttempt={chat.reconnectAttempt}
          observation={chat.observation}
          onResumeObservation={() => void chat.resumeObservation()}
          tailnetDetail={chat.tailnetDetail}
          onSend={chat.send}
          onAbort={chat.abort}
          teammates={swarm?.bots}
          sessions={chat.sessions}
          onChooseSession={(session) => select(selection.instance, selection.bot, session)}
        />
      ) : chat.offTailnet ? (
        /*
          The off-tailnet pane with nothing selected, which is the ordinary case
          rather than an edge one: a portal opened while this laptop is off the
          tailnet reads every roster as unreachable, so the rail never lands the
          operator on a bot and the thread that normally carries this pane is
          never drawn. Without this branch the surface that is supposed to
          explain the outage says "reading every box's roster" forever.
        */
        <section className="ch-thread">
          <NoRoute detail={chat.tailnetDetail} />
        </section>
      ) : chat.fleetUnreachable ? (
        /*
          Every box silent, and this laptop's tailscale is fine — so the fleet
          is switched off, or its boxes are. Without this branch the pane says
          "no box in this fleet has a bot to talk to yet", which describes a
          fleet that was never set up rather than one that is not running, and
          sends the operator looking for the wrong thing.
        */
        <section className="ch-thread">
          <div className="ch-empty">
            <div>
              <h2>No box answered</h2>
              <p>
                Every watched instance in this fleet was asked for its roster and none of them replied.
                This laptop's tailscale is working, so the boxes are stopped, still bootstrapping, or
                otherwise not serving — the fleet view says which.
              </p>
              <div className="ch-prompts">
                {/*
                  The fleet view is this portal's own first page rather than a
                  hash-addressed one, so leaving `#chat` is how it is reached —
                  which is exactly what the view nav above this does, and why
                  this restates the destination rather than offering a second
                  control for it.
                */}
                <span className="ch-prompt">
                  <b>go</b>Fleet — the status of every box, read over AWS
                </span>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="ch-thread">
          <div className="ch-empty">
            <div>
              <h2>Nothing said yet</h2>
              <p>
                {chat.swarmsError
                  ? chat.swarmsError
                  : chat.swarmsLoading || chat.swarms.length === 0
                    ? "Reading watched instances’ bot rosters. This may take a moment."
                    : "No box in this fleet has a bot to talk to yet."}
              </p>
            </div>
          </div>
        </section>
      )}

      {withContext && selection ? (
        <Context
          agent={agent}
          instance={selection.instance}
          bot={selection.bot}
          messages={chat.messages}
        />
      ) : null}
    </div>
  );
}
