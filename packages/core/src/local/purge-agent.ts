/**
 * What this laptop forgets when an agent's name is released (§6.7).
 *
 * A destroy deletes the agent's row and frees its name, so a later `create` can
 * hand the same name to a different box. Everything the laptop keyed on
 * `(fleet_id, name)` would then describe the wrong machine: a health watermark
 * that raises a transition nothing performed, a "listening" opt-in the operator
 * never made for the new box, a chat fence deferring its first roster reads, a
 * session id the new box happens to reuse read as one this laptop opened. The
 * release (`agents/lifecycle/release-name.ts`) calls this last, after the row
 * is gone.
 *
 * What is purged, for `fleet` + `name`:
 *
 * - `agent_status_seen`: the health watermark (`name`) and every chat
 *   watermark (`chat:<name>/<bot>`), the second by literal prefix;
 * - `instance_listening`: the opt-in to monitor the box;
 * - `chat_turn_fence`: any claim on the instance's bots, whoever holds it;
 * - `chat_local_sessions`: the sessions this laptop opened on the instance;
 * - open `notifications` about the agent: *resolved*, not deleted. They are
 *   history, and the inbox's own retention removes them in time; resolving
 *   only stops the badge counting a box that no longer exists;
 * - the `agent:<name>` mute.
 *
 * The mute is the one entry with no fleet in its key (`notification_mutes`
 * is keyed on the target alone), so releasing `alpha` in one fleet also lifts
 * a mute set on an `alpha` in another. That errs toward showing a row the
 * operator muted rather than hiding one they never did.
 *
 * Deliberately left alone: `runs`, `runs_archive` (the audit log of what was
 * done to the name) and `pending_ops` (an op's own lifecycle, not the agent's).
 *
 * Each step runs even when an earlier one threw, so one unwritable table does
 * not leave the rest behind; the first failure is rethrown afterwards and the
 * release reports it as a warning.
 */
import type { LocalChatSessions } from "../chat/chat.ts";
import type { ChatFenceStore } from "../chat/chat-fence.ts";
import type { InstanceListeningStore } from "../chat/instance-listening.ts";
import { chatSeenSubject, type NotificationStore } from "../chat/notifications.ts";
import { agentMuteTarget } from "../schema/index.ts";

export interface LocalAgentPurgeDeps {
  notifications: NotificationStore;
  instanceListening: InstanceListeningStore;
  localSessions: LocalChatSessions;
  chatFence: ChatFenceStore;
}

export function createLocalAgentPurge(deps: LocalAgentPurgeDeps) {
  return async function purgeLocalAgent(fleetId: string, name: string): Promise<void> {
    const steps: Array<() => void> = [
      () => deps.notifications.forgetSeen(fleetId, name),
      // `chatSeenSubject(name, "")` is `chat:<name>/`: the `/` keeps `alpha`
      // from taking `alphabet`'s watermarks with it.
      () => deps.notifications.forgetSeenPrefix(fleetId, chatSeenSubject(name, "")),
      () => deps.instanceListening.set(fleetId, name, false),
      () => deps.chatFence.forgetInstance(fleetId, name),
      () => deps.localSessions.forgetInstance(fleetId, name),
      () => deps.notifications.resolveAgent(fleetId, name),
      () => deps.notifications.unmute(agentMuteTarget(name)),
    ];
    const failures: unknown[] = [];
    for (const step of steps) {
      try {
        step();
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length > 0) throw failures[0];
  };
}
