/**
 * Whether the box is running a turn in a conversation, whoever started it.
 *
 * `sending` only knows about a turn this tab started. A turn started from
 * Hermes Desktop, the CLI, a routine or another window runs on the same box
 * and the same session, and until now this tab read it as idle: Enter fired a
 * second `prompt.submit` at a busy session, and the queue drained into it. The
 * observation carries the box's own answer as a `busy` event (core probes the
 * session every few seconds), and the record keeps the latest one as
 * `remoteBusy`: `true` a turn is running or waiting on a person, `false` none,
 * `null` not known. Core re-emits `true` on every probe while it holds, so a
 * value this tab set by itself — `false` when its own turn ends — is corrected
 * within one probe if the box is still working.
 */
import { sessionOf } from "./chat-conversation-record.ts";
import type { Conversation } from "./chat-conversation-record.ts";

/** The part of an observed `busy` event this store reads. */
export interface BusyEvent {
  session: string | null;
  busy: boolean | null;
}

/**
 * Fold one `busy` event into the record. Answers whether the value moved, so a
 * probe repeating what is already held does not re-render the thread.
 *
 * An event naming a session the record no longer addresses is a late probe of
 * a conversation that rolled over, and says nothing about this one.
 */
export function noteBusy(record: Conversation, event: BusyEvent): boolean {
  const session = sessionOf(record);
  if (event.session && session && event.session !== session) return false;
  if (record.remoteBusy === event.busy) return false;
  record.remoteBusy = event.busy;
  return true;
}

/** A turn is running in the conversation: this tab's own, or one the box reports. */
export function isWorking(sending: boolean, remoteBusy: boolean | null): boolean {
  return sending || remoteBusy === true;
}
