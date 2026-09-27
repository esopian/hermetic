/**
 * The fan-in envelope: every observed conversation over one channel.
 *
 * ## Why one channel
 *
 * A subscription per conversation is a connection per conversation, and a page
 * watching a dozen bots would spend every one it is allowed on chat alone,
 * starving the rest of the dashboard — the fleet stream, the op streams, every
 * ordinary request. This is the same events, multiplexed: one subscription,
 * every conversation the head owns (`chat-owner.ts`), each event carrying the
 * conversation it belongs to.
 *
 * ## Why not the fleet stream
 *
 * The fleet stream was the other candidate and it is the wrong one. It is the
 * *poller's* stream: it is refused when the head was built without a poller,
 * its first frame is a fleet snapshot, and its event names (`snapshot` among
 * them) would collide with the observation union's. Folding chat into it would
 * tie a chat watch to a fleet poll, hand chat events to every reader that only
 * wanted agent rows, and make two independently reconnecting concerns share one
 * channel's fate.
 *
 * The pump itself is `chat.subscribe` in `handlers/chat.ts`; what lives here is
 * the shape it writes and the bound it writes it under.
 */
import type { OwnedChatEvent } from "./chat-owner.ts";

/**
 * How many events may queue for a reader that has stopped reading. The same
 * bound and the same announcement the fleet stream and the op buffer use: the
 * oldest go, and the gap is reported rather than hidden.
 */
export const CHAT_STREAM_MAX_QUEUED = 1000;

/**
 * One frame of the fan-in, as it goes on the wire.
 *
 * The frame's event name is the observation event's own `type`, so a reader
 * listens for `snapshot`/`message`/`reconnect`/`error` here exactly as it does
 * on a single-conversation subscription. `conversation` is what a single
 * conversation did not have to carry: `<instance>/<bot>/<session>`, with
 * `session` null for the bot's canonical one — the key a reader routes on,
 * rather than one it reconstructs from the payload.
 */
export interface ChatStreamFrame {
  conversation: OwnedChatEvent["conversation"];
  event: OwnedChatEvent["event"];
}
