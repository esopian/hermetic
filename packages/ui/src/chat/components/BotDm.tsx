/**
 * The two ends of a bot-to-bot DM in a thread (`bot-dm.ts`), and the context
 * that lets either open the exchange (`BotExchange.tsx`).
 *
 * The sender's `message_agent` call is a compact right-aligned "Messaged
 * <face> <bot>" line between the turn's prose instead of a tool step; the
 * receiver's delivery row is drawn by `Message.tsx` as the sending bot
 * speaking, with the "Message from <bot> ⇄" marker below.
 */
import { createContext, useContext, useState } from "react";
import { dmBotName, dmTarget } from "../bot-dm.ts";
import type { DmBot, MessageAgentCall } from "../bot-dm.ts";
import { dmFailureReason } from "../bot-dm-reasons.ts";
import { processDomId } from "../process-events.ts";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { Face } from "./Face.tsx";
import { RedactedText } from "./RedactedText.tsx";

/** What a marker asks the thread to open. */
export type ExchangeRequest =
  | { side: "sender"; call: MessageAgentCall; at: string }
  | { side: "receiver"; deliveryId: string };

/**
 * Asking the thread's own bot to send a refused DM again. `send` is the
 * thread's composer path, so the request is an ordinary operator message —
 * queued behind a running turn exactly as typed text would be.
 */
export interface DmRetry {
  send: (text: string) => void;
  /** The thread's bot as the thread names it: who was asked. */
  sender: string;
}

export interface BotDmContextValue {
  /** Every bot on the thread's instance, the thread's own included. */
  teammates: readonly DmBot[];
  /** Opens an exchange. Null where there is no thread to open it over — the exchange itself. */
  open: ((request: ExchangeRequest) => void) | null;
  /** Null where nothing can be sent from — a composer that cannot send, the exchange. */
  retry?: DmRetry | null;
}

export const BotDmContext = createContext<BotDmContextValue>({
  teammates: [],
  open: null,
  retry: null,
});

export function useBotDm(): BotDmContextValue {
  return useContext(BotDmContext);
}

/**
 * A bot as the exchange draws it: a roster row on this instance, or only the
 * name a call or a signature gave — which gets no face and no link, because
 * there is no bot here to seed one from or open.
 */
export interface Party {
  /** The profile id a face and a link are keyed on, when the bot is on the roster. */
  bot: string | null;
  name: string;
  /** The other machine a bot is on — a connection, a peer — when it is not on this one. */
  elsewhere?: string | null;
}

export function party(bot: DmBot | null, fallback: string): Party {
  return { bot: bot?.name ?? null, name: dmBotName(bot, fallback) };
}

/** The bot a call messaged (`dmTarget`), named "<handle> on <machine>" when it is on another one. */
export function targetParty(call: MessageAgentCall, teammates: readonly DmBot[]): Party {
  const target = dmTarget(call, teammates);
  if (!target.elsewhere) return party(target.bot, target.name);
  return {
    bot: null,
    name: `${target.name.replace(/^@+/, "")} on ${target.elsewhere}`,
    elsewhere: target.elsewhere,
  };
}

/** A party's face, or nothing for a bot that is not on this instance's roster. */
export function PartyFace({
  fleetId,
  instance,
  who,
  size,
  status,
}: {
  fleetId: string;
  instance: string;
  who: Party;
  size: number;
  status: AvatarStatus;
}) {
  if (!who.bot) return null;
  // Decorative: the name is always beside it, and the avatar's own label
  // would otherwise read into the marker's accessible name.
  return (
    <span className="ch-dm-face" aria-hidden="true">
      <Face
        fleetId={fleetId}
        instance={instance}
        bot={who.bot}
        size={size}
        status={status}
        square={false}
      />
    </span>
  );
}

/**
 * The sender's `message_agent` call, as a line between the turn's prose.
 * Pending while the call runs, warn-coloured when upstream refused it or could
 * not confirm it — those expand to upstream's own sentence rather than opening
 * an exchange that never happened, or may not have.
 */
export function DmSentMarker({
  call,
  at,
  fleetId,
  instance,
  status,
}: {
  call: MessageAgentCall;
  /** When the call's turn was written, which the exchange stamps the sent message with. */
  at: string;
  fleetId: string;
  instance: string;
  status: AvatarStatus;
}) {
  const { teammates, open, retry } = useBotDm();
  const who = targetParty(call, teammates);
  const anchor = call.processId ? processDomId("start", call.processId) : undefined;
  if (call.state === "ambiguous") {
    // Not "Couldn't message": upstream does not know, and says not to resend.
    return (
      <details className="ch-dm-mark unsure" id={anchor}>
        <summary>
          <RedactedText text={`Message to ${who.name} may not have been delivered`} />
        </summary>
        {call.error ? (
          <p>
            <RedactedText text={call.error} />
          </p>
        ) : null}
      </details>
    );
  }
  if (call.state === "failed")
    return <DmFailedMarker call={call} who={who} anchor={anchor} retry={retry ?? null} />;
  const body = (
    <>
      <span>{call.state === "pending" ? "Messaging" : "Messaged"}</span>
      <PartyFace fleetId={fleetId} instance={instance} who={who} size={16} status={status} />
      <b>
        <RedactedText text={who.name} />
      </b>
      {call.state === "pending" ? <span>…</span> : null}
    </>
  );
  return (
    <div className={`ch-dm-mark${call.state === "pending" ? " pending" : ""}`} id={anchor}>
      {open ? (
        <button type="button" onClick={() => open({ side: "sender", call, at })}>
          {body}
        </button>
      ) : (
        <span className="ch-dm-mark-static">{body}</span>
      )}
    </div>
  );
}

/** Upstream's list of valid targets on a refusal, as a line; null when it sent none. */
function validTargets(label: string, names: readonly string[] | null): string | null {
  return names?.length ? `${label}: ${names.map((name) => `@${name}`).join(", ")}` : null;
}

/**
 * A refused `message_agent` call: the reason's label in the summary, and
 * behind it the guidance, upstream's own sentence and, when upstream sent
 * them, the targets it would have taken (`bot-dm-reasons.ts`).
 *
 * Retry is offered only for a reason a second send can fix, and only where
 * the thread can send. It does not re-run the tool: upstream's tool never
 * retries itself, and its delivery runner has already retried a transient
 * failure once (`tools/bot_mode_dm.py:428`). What the operator can do is what
 * upstream's own sentence tells the sender bot to do — try again — so Retry
 * asks the sender, through the composer's send path, and the bot makes a fresh
 * `message_agent` call of its own. One ask per marker: the button is disabled
 * once clicked, so a double click is not two messages.
 */
function DmFailedMarker({
  call,
  who,
  anchor,
  retry,
}: {
  call: MessageAgentCall;
  who: Party;
  anchor: string | undefined;
  retry: DmRetry | null;
}) {
  const [asked, setAsked] = useState(false);
  const reason = dmFailureReason(call.reason);
  const handle = call.target.replace(/^@+/, "");
  const ask = () => {
    if (asked || !retry) return;
    setAsked(true);
    retry.send(
      `Please retry your message_agent delivery to @${handle} — it failed with ${call.reason}.`,
    );
  };
  const lists = [validTargets("Teammates", call.teammates), validTargets("Peers", call.peers)];
  return (
    <div className="ch-dm-mark failed" id={anchor}>
      <details>
        <summary>
          <RedactedText text={`Couldn't message ${who.name} · ${reason.label}`} />
        </summary>
        <p className="ch-dm-why">{reason.guidance}</p>
        {call.error ? (
          <p>
            <RedactedText text={call.error} />
          </p>
        ) : null}
        {lists.map((line) =>
          line ? (
            <p key={line}>
              <RedactedText text={line} />
            </p>
          ) : null,
        )}
      </details>
      {reason.retry && retry ? (
        <span className="ch-dm-retry">
          <button type="button" className="ch-chip" disabled={asked} onClick={ask}>
            Retry
          </button>
          {asked ? <RedactedText text={`Asked ${retry.sender} to retry`} /> : null}
        </span>
      ) : null}
    </div>
  );
}
