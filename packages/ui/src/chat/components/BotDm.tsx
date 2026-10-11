/**
 * The two ends of a bot-to-bot DM in a thread (`bot-dm.ts`), and the context
 * that lets either open the exchange (`BotExchange.tsx`).
 *
 * The sender's `message_agent` call is a compact right-aligned "Messaged
 * <face> <bot>" line between the turn's prose instead of a tool step; the
 * receiver's delivery row is drawn by `Message.tsx` as the sending bot
 * speaking, with the "Message from <bot> ⇄" marker below.
 */
import { createContext, useContext } from "react";
import { dmBotName, resolveDmBot } from "../bot-dm.ts";
import type { DmBot, MessageAgentCall } from "../bot-dm.ts";
import { processDomId } from "../process-events.ts";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { Face } from "./Face.tsx";
import { RedactedText } from "./RedactedText.tsx";

/** What a marker asks the thread to open. */
export type ExchangeRequest =
  | { side: "sender"; call: MessageAgentCall; at: string }
  | { side: "receiver"; deliveryId: string };

export interface BotDmContextValue {
  /** Every bot on the thread's instance, the thread's own included. */
  teammates: readonly DmBot[];
  /** Opens an exchange. Null where there is no thread to open it over — the exchange itself. */
  open: ((request: ExchangeRequest) => void) | null;
}

export const BotDmContext = createContext<BotDmContextValue>({ teammates: [], open: null });

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
}

export function party(bot: DmBot | null, fallback: string): Party {
  return { bot: bot?.name ?? null, name: dmBotName(bot, fallback) };
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
  const { teammates, open } = useBotDm();
  const target = resolveDmBot([call.to, call.target], teammates);
  const who = party(target, call.target);
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
  if (call.state === "failed") {
    return (
      <details className="ch-dm-mark failed" id={anchor}>
        <summary>
          <RedactedText text={`Couldn't message ${who.name} · ${call.reason ?? "failed"}`} />
        </summary>
        <p>
          <RedactedText text={call.error ?? ""} />
        </p>
      </details>
    );
  }
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
