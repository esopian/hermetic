/**
 * Opening a new, separate session from a conversation screen (the session
 * switcher, a failure card's "New session", `?fresh=1`), apart from what the
 * screen draws around it.
 *
 * The prompt, when there is one, is sent whether or not the screen is still
 * there when the box answers: the operator asked for it, and leaving while the
 * session opened does not take that back. Only the screen's own reaction (the
 * route replace, the haptic) waits on it being shown; a screen that is gone
 * does not watch the new session either, so nothing is left observing it.
 */
import type { SendAttachments } from "./chat-types.ts";
import type { ConversationTarget } from "./conversation-store.ts";

export interface NewSessionClient {
  gateway: {
    open(input: {
      instance: string;
      bot: string;
      new_session: true;
    }): Promise<{ instance: string; bot: string; session: string }>;
  };
  chat: {
    open(target: ConversationTarget): void;
    sendMessage(
      target: ConversationTarget,
      text: string,
      attachments?: SendAttachments | null,
    ): boolean;
  };
}

/**
 * Open a new session of `target`'s bot and send `prompt` (and `attachments`,
 * files already staged on the box) into it. Answers the
 * new session's target while `shown()` still holds, else `null` (the screen
 * left: it replaces nothing). A refusal to open throws.
 */
export async function openSeparateSession(
  client: NewSessionClient,
  target: { instance: string; bot: string },
  prompt: string | undefined,
  shown: () => boolean,
  attachments?: SendAttachments | null,
): Promise<{ instance: string; bot: string; session: string } | null> {
  const opened = await client.gateway.open({
    instance: target.instance,
    bot: target.bot,
    new_session: true,
  });
  const next = { instance: opened.instance, bot: opened.bot, session: opened.session };
  const onScreen = shown();
  if (prompt || attachments) {
    if (onScreen) client.chat.open(next);
    client.chat.sendMessage(next, prompt ?? "", attachments ?? null);
  }
  return onScreen ? next : null;
}
