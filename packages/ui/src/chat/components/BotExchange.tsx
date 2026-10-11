/**
 * A bot-to-bot DM in the thread (`bot-dm.ts`), from either end.
 *
 * On the sender's thread the `message_agent` call is a compact right-aligned
 * "Messaged <face> <bot>" line instead of a tool step; on the receiver's, the
 * delivery is drawn as the sending bot speaking (`Message.tsx`) with a "Message
 * from <bot> ⇄" marker. Either marker opens the exchange: the sender's message
 * and the target's reply, side by side in one panel over the thread.
 *
 * Hermes Desktop has no click-through here — it draws the delivery as a
 * centred notice and collapses the reply. This goes further on purpose: the
 * two halves of a DM live in two transcripts, and reading one without the
 * other is how a reply gets missed.
 *
 * The reply comes from the target's canonical Bot Chat, read through the same
 * `chat.history` the thread uses, and is matched to the delivery by the
 * sender's handle and the message body. When the box has not run the delivery
 * yet the panel says so, and falls back to the reply the delivery's completion
 * notice carried back into the sender's own transcript.
 */
import { useEffect, useRef, useState } from "react";
import { fetchHistory } from "../../api/index.ts";
import type { ChatMessageView } from "../../api/index.ts";
import { useFocusTrap } from "../../lib/focus.ts";
import { findExchange, noticeReply, resolveDmBot } from "../bot-dm.ts";
import type { DmBot } from "../bot-dm.ts";
import { chatHash } from "../chat-routing.ts";
import { turnRows } from "../chat-turns.ts";
import type { AvatarStatus } from "./avatar/Avatar.tsx";
import { BotDmContext, PartyFace, party } from "./BotDm.tsx";
import type { ExchangeRequest, Party } from "./BotDm.tsx";
import { Message } from "./Message.tsx";
import { RedactedText } from "./RedactedText.tsx";

/** Reads one bot's canonical Bot Chat, once per open. */
function useBotChat(instance: string, bot: string | null) {
  const [read, setRead] = useState<
    | { state: "loading" }
    | { state: "done"; messages: ChatMessageView[] }
    | { state: "failed"; error: string }
  >({ state: "loading" });
  useEffect(() => {
    if (!bot) {
      setRead({ state: "done", messages: [] });
      return;
    }
    const controller = new AbortController();
    setRead({ state: "loading" });
    fetchHistory(instance, bot, {}, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setRead({ state: "done", messages: result.messages });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRead({ state: "failed", error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [instance, bot]);
  return read;
}

/** A row the exchange draws, attributed to one party. */
function Said({
  rows,
  who,
  fleetId,
  instance,
  status,
  now,
}: {
  rows: readonly ChatMessageView[];
  who: Party;
  fleetId: string;
  instance: string;
  status: AvatarStatus;
  now: number;
}) {
  const bot = who.bot ?? who.name;
  return (
    <>
      {turnRows(rows, now).map((row) => (
        <Message
          key={row.ids[0] ?? row.message.id}
          row={row}
          fleetId={fleetId}
          instance={instance}
          bot={bot}
          botTitle={who.name}
          status={status}
          now={now}
        />
      ))}
    </>
  );
}

/** A synthetic bot row carrying one message, attributed to `who`. */
function spoken(
  id: string,
  at: string,
  who: Party,
  instance: string,
  markdown: string,
): ChatMessageView {
  return {
    id,
    session: id,
    role: "bot",
    author: { instance, bot: who.bot ?? who.name },
    at,
    blocks: [{ kind: "text", markdown }],
  } as ChatMessageView;
}

export function BotExchange({
  request,
  fleetId,
  instance,
  bot,
  botTitle,
  status,
  transcript,
  teammates,
  now,
  onClose,
}: {
  request: ExchangeRequest;
  fleetId: string;
  instance: string;
  /** The thread's own bot: the sender on the sender side, the target on the receiver side. */
  bot: string;
  botTitle?: string | null;
  status: AvatarStatus;
  /** The thread's loaded transcript. */
  transcript: readonly ChatMessageView[];
  teammates: readonly DmBot[];
  now: number;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const self: DmBot = teammates.find((b) => b.name === bot) ?? {
    instance,
    name: bot,
    title: botTitle ?? null,
  };

  let sender: Party;
  let target: Party;
  let message: string;
  let at: string;
  /** The target's side of the exchange, when it is in the thread's own transcript. */
  let local: { delivery: ChatMessageView; replies: ChatMessageView[] } | null = null;
  if (request.side === "sender") {
    sender = party(self, bot);
    target = party(
      resolveDmBot([request.call.to, request.call.target], teammates),
      request.call.target,
    );
    message = request.call.message;
    at = request.at;
  } else {
    const index = transcript.findIndex((m) => m.id === request.deliveryId);
    const delivery = transcript[index];
    const from = delivery?.from_bot ?? null;
    sender = party(
      from ? resolveDmBot([from.handle, from.name], teammates) : null,
      from?.name ?? "another bot",
    );
    target = party(self, bot);
    message = delivery
      ? delivery.blocks.map((b) => (b.kind === "text" ? b.markdown : "")).join("")
      : "";
    at = delivery?.at ?? new Date(now).toISOString();
    if (delivery) {
      const replies: ChatMessageView[] = [];
      for (const row of transcript.slice(index + 1)) {
        if (row.role === "user") break;
        replies.push(row);
      }
      local = { delivery, replies };
    }
  }

  // The sender side reads the target's Bot Chat; the receiver side already has it.
  const read = useBotChat(instance, request.side === "sender" ? target.bot : null);
  const found =
    request.side === "receiver"
      ? local
      : read.state === "done"
        ? findExchange(read.messages, bot, message)
        : null;
  const replies = (found?.replies ?? []).filter((m) => m.role === "bot");
  // The reply the delivery's completion notice carried back, for a target
  // transcript that does not show one (not delivered yet, or rolled over).
  const fallback =
    request.side === "sender" && replies.length === 0
      ? noticeReply(transcript, request.call.processId)
      : null;
  const title = `${sender.name} ⇄ ${target.name}`;
  const other = request.side === "sender" ? target : sender;
  const go = (who: Party, message: string | null) => {
    if (!who.bot) return;
    onClose();
    window.location.hash = chatHash({ instance, bot: who.bot, session: null }, message);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click outside the panel is the pointer path; Escape and the close button are the keyboard one
    <div className="ch-dm-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="ch-dm-panel" role="dialog" aria-label={title} tabIndex={-1}>
        <div className="ch-dm-head">
          <span className="ch-dm-pill">
            <PartyFace fleetId={fleetId} instance={instance} who={sender} size={20} status={status} />
            <b>
              <RedactedText text={sender.name} />
            </b>
            <span className="ch-dm-swap" aria-hidden="true">
              ⇄
            </span>
            <PartyFace fleetId={fleetId} instance={instance} who={target} size={20} status={status} />
            <b>
              <RedactedText text={target.name} />
            </b>
          </span>
          <button type="button" className="ch-dm-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="ch-dm-body">
          {/* Nothing drawn in here opens a second exchange over this one. */}
          <BotDmContext.Provider value={{ teammates, open: null }}>
            <Said
              rows={[spoken("dm-sent", at, sender, instance, message)]}
              who={sender}
              fleetId={fleetId}
              instance={instance}
              status={status}
              now={now}
            />
            {replies.length ? (
              <Said
                rows={replies}
                who={target}
                fleetId={fleetId}
                instance={instance}
                status={status}
                now={now}
              />
            ) : request.side === "sender" && read.state === "loading" ? (
              <p className="ch-dm-note">{`Reading ${target.name}'s Bot Chat…`}</p>
            ) : (
              <>
                <p className="ch-dm-note">
                  {read.state === "failed" ? (
                    <RedactedText text={`Couldn't read ${target.name}'s Bot Chat: ${read.error}`} />
                  ) : found ? (
                    `${target.name} has not replied yet.`
                  ) : (
                    `Not in ${target.name}'s Bot Chat yet.`
                  )}
                </p>
                {fallback ? (
                  <Said
                    rows={[spoken("dm-reply", at, target, instance, fallback)]}
                    who={target}
                    fleetId={fleetId}
                    instance={instance}
                    status={status}
                    now={now}
                  />
                ) : null}
              </>
            )}
          </BotDmContext.Provider>
        </div>
        {other.bot ? (
          <div className="ch-dm-foot">
            <button
              type="button"
              className="ch-chip"
              onClick={() => go(other, request.side === "sender" ? (found?.delivery.id ?? null) : null)}
            >
              <RedactedText text={`Open ${other.name}'s Bot Chat`} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
