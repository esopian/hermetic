/**
 * The fixture-only control surface (§9.2).
 *
 * Continuous conversation observation's headline
 * acceptance criterion is that "an external Desktop/CLI/routine message arrives
 * without a two-minute wait". Demonstrating that needs a message that *this*
 * process did not send, arriving in a conversation somebody is watching — and
 * in fixture mode there is no gateway to produce one. These are the shapes that
 * let a human or a QA script stage it against `bun run dev:fixture`.
 *
 * They are deliberately not in `requests.ts`: nothing here is a §9 command,
 * nothing here has a CLI verb, and the only method behind them exists on a
 * `Hermetic` built with `fixture: true`. A real-mode `Hermetic` has no
 * `fixture` namespace at all, so there is no input these schemas could validate
 * that would reach an AWS account.
 */
import { z } from "zod";
import { ChatMessage } from "./chat.ts";
import { AgentName, BotName } from "./requests.ts";

/**
 * Stage a message that arrived from somewhere other than this portal.
 *
 * `markdown` is the whole of what the caller controls about the message body,
 * because the fixture is not pretending to be upstream: this appends a `user`
 * row to the box's durable transcript and announces it, which is exactly what
 * Hermes Desktop, another operator's CLI or a cron routine leaves behind. It
 * runs no model, allocates no backend and produces no reply.
 *
 * `id` is settable so a caller can make the *same durable row* arrive twice,
 * which is what an upstream replay after a dropped stream looks like from here
 * — the observation's cursor is supposed to swallow the second one.
 */
export const FixtureChatInjectInput = z.object({
  instance: AgentName,
  /** Omitted means the box's default bot, which is what the rail opens on. */
  bot: BotName.default("default"),
  /** Omitted means the bot's canonical conversation. */
  session: z.string().min(1).optional(),
  markdown: z.string().min(1).max(16_384),
  /** Reuse a previous arrival's id to stage an upstream replay. */
  id: z.string().min(1).optional(),
});
export type FixtureChatInjectInput = z.infer<typeof FixtureChatInjectInput>;

/**
 * Announce without appending: "something happened over there", for a row the
 * transcript already holds.
 *
 * It is the other half of what a real gateway's hint stream does, and the only
 * way to make an observation re-read *now* rather than at its poll floor — so a
 * locally sent turn can be reconciled in a demo without waiting five seconds
 * for the tick.
 */
export const FixtureChatHintInput = z.object({
  instance: AgentName,
  bot: BotName.default("default"),
  session: z.string().min(1).optional(),
});
export type FixtureChatHintInput = z.infer<typeof FixtureChatHintInput>;

/**
 * `watchers` is how many hint streams were open for that bot when the message
 * landed. Zero is not a failure — the arrival is in the transcript either way,
 * and the next read will find it — but it is the difference between "the portal
 * was watching and should have drawn it" and "nothing was listening", which is
 * the first thing to check when a demo does not move.
 */
export const FixtureChatInjectResult = z.object({
  message: ChatMessage,
  watchers: z.number().int().nonnegative(),
});
export type FixtureChatInjectResult = z.infer<typeof FixtureChatInjectResult>;
