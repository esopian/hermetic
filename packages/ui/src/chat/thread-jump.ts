/**
 * Jumping to one message in a transcript, wherever it is drawn.
 *
 * A virtualized transcript (`virtual/VirtualLog.tsx`) mounts only the rows near
 * its viewport, so a `#message=` link or a subagent's "results turn" link
 * cannot simply query `[data-chat-message]`: the row it names may not be in the
 * DOM. Each mounted thread registers a jump here instead, which maps the
 * message id to its row, scrolls that row into view (mounting it) and answers
 * with the message's element. A thread that does not hold the id answers null,
 * and the next one is asked.
 *
 * Registrations are module-level because the asking surfaces (`ChatShell`'s
 * hash, a `SubagentLine`) are not inside the thread that holds the message.
 *
 * Which thread answers: the newest one mounted in the main view, and a thread
 * in the chat dock only when none there holds the id. The dock can show the
 * conversation the main view shows, and a link is about the conversation the
 * reader is looking at, not the side panel opened last. A thread says it is
 * docked through `secondary`, asked at jump time because a pane can move.
 */

export type JumpBlock = "start" | "center" | "end";

export interface JumpOptions {
  block?: JumpBlock;
}

/**
 * One thread's jump: null when it does not hold `messageId`, else a promise
 * of the message's element once it is mounted and scrolled to (null when it
 * could not be reached after all).
 */
export type ThreadJump = (
  messageId: string,
  options: { block: JumpBlock },
) => Promise<HTMLElement | null> | null;

export interface ThreadJumpOptions {
  /** True while the thread is a side surface (the chat dock): asked last. */
  secondary?: () => boolean;
}

interface Registration {
  jump: ThreadJump;
  secondary: () => boolean;
}

const jumps: Registration[] = [];

const primary = () => false;

/** Register a thread's jump; the returned function removes it. */
export function registerThreadJump(jump: ThreadJump, options: ThreadJumpOptions = {}): () => void {
  const entry: Registration = { jump, secondary: options.secondary ?? primary };
  jumps.push(entry);
  return () => {
    const at = jumps.lastIndexOf(entry);
    if (at >= 0) jumps.splice(at, 1);
  };
}

/** The order threads are asked in: main-view threads newest first, then docked ones. */
function askingOrder(): ThreadJump[] {
  const newest = [...jumps].reverse();
  const docked = newest.map((entry) => entry.secondary());
  return [
    ...newest.filter((_, i) => !docked[i]).map((entry) => entry.jump),
    ...newest.filter((_, i) => docked[i]).map((entry) => entry.jump),
  ];
}

/**
 * The element drawing `messageId` under `root`. A turn is one article built
 * from several source rows (`chat-turns.ts`), and a link names whichever row
 * the box wrote, so an article answers to its own id and to every id folded
 * into it (`data-chat-ids`).
 */
export function findMessage(root: ParentNode, messageId: string): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-chat-message], [data-chat-ids]")).find(
      (el) =>
        el.dataset.chatMessage === messageId ||
        (el.dataset.chatIds ?? "").split(" ").includes(messageId),
    ) ?? null
  );
}

/**
 * Scroll to `messageId` and resolve with its element, for the caller to focus.
 * Registered threads are asked in `askingOrder`; when none holds the id, or
 * the one that does could not reach it, the mounted DOM is searched as before.
 */
export async function jumpToMessage(
  messageId: string,
  options: JumpOptions = {},
): Promise<HTMLElement | null> {
  const block = options.block ?? "center";
  for (const jump of askingOrder()) {
    const pending = jump(messageId, { block });
    if (!pending) continue;
    const found = await pending;
    if (found) return found;
    break;
  }
  const node = findMessage(document, messageId);
  node?.scrollIntoView?.({ block });
  return node;
}

/** Test seam: how many threads are registered. */
export function registeredThreadJumps(): number {
  return jumps.length;
}
