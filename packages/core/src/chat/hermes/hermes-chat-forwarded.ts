/**
 * A prompt the gateway forwarded to the FIFO that owns its chat
 * (`tui_gateway/owner_forward.py` at v0.23.1): it runs on the owner, after the
 * owner's own turn, and its `message.start`/`message.complete` come back on
 * this session through a relay that strips `admission_id` (`_payload_for`).
 *
 * Nothing here can withdraw it: it does not run on this session, so an
 * interrupt has nothing to stop. A Stop therefore ends the hold instead
 * (`stopped`): left held, the relay would deliver this reply into the next
 * turn on the same session, which cannot tell it from its own. Closed, the
 * gateway reaps the session after its orphan grace, and the relay of a
 * finalized session exits without a word (`_Relay._relay`).
 */
import type { ChatBlock } from "../../schema/index.ts";
import type { TurnPump } from "./hermes-chat-resume.ts";

/** The line a stopped forwarded turn ends on. */
export const FORWARDED_STILL_QUEUED: ChatBlock = {
  kind: "activity",
  category: "notice",
  key: "forwarded",
  title: "Still queued on the box",
  detail:
    "Hermes runs this message after its own turn in this chat; Stop cannot withdraw it. The reply lands in the chat history.",
  state: "warning",
  role: "work",
};

/** `pump` for a forwarded prompt: its interrupt only records that the turn was stopped. */
export function forwardedPump(pump: TurnPump, stopped: () => void): TurnPump {
  return {
    ...pump,
    interrupt: async () => {
      stopped();
    },
  };
}
