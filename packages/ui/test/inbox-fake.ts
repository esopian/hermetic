/**
 * A stateful in-memory inbox behind `NotifyProvider`'s injectable `api`, for
 * DOM tests of the Inbox v2 verbs.
 *
 * Stateful because the provider re-reads after every verb settles: a fake that
 * answered every `list` with the seed would put a cleared row straight back,
 * and the test would be about the fake. The rules are core's, in miniature —
 * the inbox view hides cleared and actively snoozed rows, clearing also reads,
 * restoring lifts a snooze, and neither count includes a resolved, cleared or
 * snoozed row — and every write is recorded in order, so "undo sent these
 * requests, in this order" is assertable.
 */
import type { NotificationView } from "../src/api/index.ts";
import type { NotifyApi } from "../src/state/notify-state.tsx";

export interface FakeCall {
  method: string;
  input: Record<string, unknown>;
}

export function notification(
  over: Partial<Omit<NotificationView, "kind">> & { kind?: string } = {},
): NotificationView {
  return {
    id: "n1",
    at: new Date().toISOString(),
    source: "operation",
    kind: "operation.done",
    class: "ok",
    title: "oriole finished bootstrapping",
    detail: "6 stages · 7m41s · ready.",
    agent: "oriole",
    fleet_id: "fxtr0001",
    ref: null,
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    cleared_at: null,
    snoozed_until: null,
    muted: false,
    ...over,
  } as unknown as NotificationView;
}

export function fakeInbox(seed: NotificationView[]) {
  let rows = seed.map((r) => ({ ...r }));
  const calls: FakeCall[] = [];
  const now = () => Date.now();
  const snoozed = (r: NotificationView) => !!r.snoozed_until && Date.parse(r.snoozed_until) > now();
  const inInbox = (r: NotificationView) => !r.cleared_at && !snoozed(r);
  const patch = (ids: readonly string[], fn: (r: NotificationView) => NotificationView) => {
    const set = new Set(ids);
    rows = rows.map((r) => (set.has(r.id) ? fn(r) : r));
    return set.size;
  };
  const stamp = () => new Date().toISOString();

  const api: NotifyApi = {
    fetchNotifications: (input = {}) => {
      calls.push({ method: "notifications.list", input: { ...input } });
      const view = input.view ?? "inbox";
      const list =
        view === "all"
          ? rows
          : view === "snoozed"
            ? rows.filter((r) => !r.cleared_at && snoozed(r))
            : view === "history"
              ? rows.filter((r) => !!r.cleared_at || !!r.resolved_at)
              : rows.filter(inInbox);
      const live = rows.filter((r) => inInbox(r) && !r.resolved_at);
      return Promise.resolve({
        notifications: list.map((r) => ({ ...r })),
        unread: live.filter((r) => !r.read_at).length,
        needs_action: live.filter((r) => r.class === "needs_action").length,
        snoozed: rows.filter((r) => !r.cleared_at && snoozed(r)).length,
        history: rows.filter((r) => !!r.cleared_at || !!r.resolved_at).length,
        next_snooze_at: null,
        mutes: [],
      } as never);
    },
    ackNotification: (input) => {
      calls.push({ method: "notifications.ack", input: { ...input } });
      const i = input as { id?: string; ids?: string[]; all?: true; unread?: boolean };
      const ids = i.all ? rows.map((r) => r.id) : (i.ids ?? (i.id ? [i.id] : []));
      const n = patch(ids, (r) => ({ ...r, read_at: i.unread ? null : (r.read_at ?? stamp()) }));
      return Promise.resolve({ acked: n } as never);
    },
    clearNotifications: (input) => {
      calls.push({ method: "notifications.clear", input: { ...input } });
      const i = input as { ids?: string[]; restore?: boolean };
      const n = patch(i.ids ?? [], (r) =>
        i.restore
          ? { ...r, cleared_at: null, snoozed_until: null }
          : { ...r, cleared_at: stamp(), read_at: r.read_at ?? stamp() },
      );
      return Promise.resolve({ cleared: n } as never);
    },
    snoozeNotifications: (input) => {
      calls.push({ method: "notifications.snooze", input: { ...input } });
      const i = input as { ids: string[]; until?: string; clear?: boolean };
      const n = patch(i.ids, (r) => ({ ...r, snoozed_until: i.clear ? null : (i.until ?? null) }));
      return Promise.resolve({ snoozed: n } as never);
    },
    notificationSettings: (input = {}) => {
      calls.push({ method: "notifications.settings", input: { ...input } });
      return Promise.resolve({
        auto_clear_read: "7d",
        clear_resolved_on_read: true,
        ...input,
      } as never);
    },
    muteNotification: (input) => {
      calls.push({ method: "notifications.mute", input: { ...input } });
      return Promise.resolve({ mutes: [] } as never);
    },
  };

  return {
    api,
    calls,
    /** The writes only, in order — what a verb or an undo actually sent. */
    writes: () =>
      calls.filter((c) => c.method !== "notifications.list" && c.method !== "notifications.settings"),
    row: (id: string) => rows.find((r) => r.id === id),
  };
}
