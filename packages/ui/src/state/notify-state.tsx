/**
 * The inbox, held once for the whole page (§4.9).
 *
 * Three things live here and nowhere else: the rows themselves (seeded by one
 * `notifications.list` and kept current by the `notification` frame on the
 * *existing* fleet stream — §6's preferred option, one subscription per
 * window),
 * the local delivery preferences (`localStorage`, beside `hermetic.theme` —
 * §4.9), and the transient toast stack.
 *
 * The rules are not here. They are in `notification-logic.ts`, pure, so "gold
 * outranks orange" and "approvals ignore quiet hours" are testable without
 * mounting a provider.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { hiddenByListening } from "@hermetic/core/shared";
import {
  ackNotification,
  clearNotifications,
  fetchNotifications,
  muteNotification,
  notificationSettings,
  snoozeNotifications,
} from "../api/index.ts";
import type {
  NotificationMuteView,
  NotificationSettingsView,
  NotificationSourceView,
  NotificationView,
  NotificationsResult,
} from "../api/index.ts";
import {
  affectedRows,
  applyVerb,
  chunkIds,
  countDelta,
  inInbox,
  isCleared,
  isSnoozed,
  restoreWrites,
  verbLabel,
  verbWrites,
} from "../logic/inbox-logic.ts";
import type { DrawerView, InboxVerb, InboxWrite } from "../logic/inbox-logic.ts";
import {
  TOAST_STACK_MAX,
  defaultPrefs,
  isResolved,
  streamCountDelta,
  loadNotificationPrefs,
  saveNotificationPrefs,
  shouldDesktop,
  shouldToast,
  toastDwellMs,
  unreadChatByConversation,
} from "../logic/notification-logic.ts";
import type { NotificationPrefs, WatchedThread } from "../logic/notification-logic.ts";
import { transport } from "../api/transport.ts";
import { isVisible } from "../lib/visibility.ts";
import { useListeningIfAvailable } from "./listening-state.tsx";
import { useFleetIfAvailable } from "./state.tsx";

/**
 * How many rows the first read asks for; the stream keeps it current after.
 *
 * Exported because a surface drawing this list has to be able to say whether it
 * is showing the whole inbox or the latest page of one.
 */
export const INBOX_PAGE = 100;

export interface Toast {
  /** Unique per *appearance*: one row can be re-toasted after being dismissed. */
  key: string;
  notification: NotificationView;
  /** `null` is sticky — needs-you and failures stay until dismissed. */
  dwellMs: number | null;
}

/**
 * What the Notifications section says about OS banners.
 *
 * The app answers "granted" and nothing else — it holds the OS permission and
 * raises on the page's behalf — but the union is kept whole because the section
 * renders every arm, and a head that one day cannot raise a banner has a word
 * for it here already.
 */
export type DesktopPermission = "unsupported" | "default" | "granted" | "denied";

/**
 * What a mute names: one agent, one source, or both. `source` is the enum the
 * route accepts rather than a bare string — a mute for a source core has never
 * heard of is a request that can only fail, and this is the one place the UI
 * can still say so at compile time.
 */
export interface MuteTarget {
  agent?: string;
  source?: NotificationSourceView;
}

export interface Notify {
  items: NotificationView[];
  unread: number;
  needsAction: number;
  mutes: NotificationMuteView[];
  prefs: NotificationPrefs;
  setPrefs: (prefs: NotificationPrefs) => void;
  /** The centre's open state, held here so the desktop rule can read it. */
  centerOpen: boolean;
  setCenterOpen: (open: boolean) => void;
  /**
   * The conversation this browser is showing, when it is showing one.
   *
   * Written by `ChatProvider`, which is the only thing that knows; read by the
   * toast gate, so a reply into the thread already on screen does not interrupt
   * the person reading it. `null` whenever the chat view is closed, which is
   * the state every other view is in.
   */
  watching: WatchedThread | null;
  setWatching: (watched: WatchedThread | null) => void;
  ack: (id: string) => Promise<void>;
  /**
   * Marks several rows read as one gesture, in one batch write (`{ ids }`).
   *
   * Not undoable, on purpose: this is what reading does (opening a row, the
   * chat view catching up, a toast's `mark read`), not a verb the operator
   * chose from the inbox. The undoable verbs go through `act`.
   */
  ackMany: (ids: readonly string[]) => Promise<void>;
  ackAll: () => Promise<void>;
  mute: (target: MuteTarget, options?: { undoable?: boolean }) => Promise<void>;
  unmute: (target: MuteTarget, options?: { undoable?: boolean }) => Promise<void>;
  /**
   * One undoable inbox verb over `rows` — read, unread, clear, restore, snooze,
   * unsnooze. Applied optimistically, written in batches, and recorded with an
   * inverse built from the rows' state *before* it (`restoreWrites`), so undo
   * puts back exactly what was there: a clear of unread rows restores them and
   * marks them unread again.
   */
  act: (verb: InboxVerb, rows: readonly NotificationView[]) => Promise<void>;
  /** The undo bar's line, while it is showing; `null` otherwise. */
  undo: UndoBar | null;
  /** Undoes the most recent verb (`z`). */
  undoLast: () => Promise<void>;
  dismissUndo: () => void;
  /** Server totals for the drawer rail: active snoozes and History rows. */
  snoozed: number;
  history: number;
  /** The rows of the drawer's own views, once `loadView` has read them. */
  views: { snoozed: NotificationView[] | null; history: NotificationView[] | null };
  loadView: (view: "snoozed" | "history") => Promise<void>;
  /** The full inbox drawer (`⇧I`, `Full inbox →`, Settings' `Open inbox`). */
  drawerOpen: boolean;
  drawerView: DrawerView;
  openDrawer: (view?: DrawerView) => void;
  closeDrawer: () => void;
  /** Core's auto-clear rule; `null` until `loadSettings` has read it. */
  settings: NotificationSettingsView | null;
  loadSettings: () => Promise<void>;
  saveSettings: (patch: Partial<NotificationSettingsView>) => Promise<void>;
  toasts: Toast[];
  dismissToast: (key: string) => void;
  refresh: () => Promise<void>;
  /**
   * Whether the *first* read came back a full page, i.e. the inbox is larger
   * than the rows held here. Read from that answer rather than from the current
   * length: the stream appends past the initial page, so a list that has grown
   * to `INBOX_PAGE` rows is not thereby a truncated view of anything.
   */
  truncated: boolean;
  /** The last failed read or write, cleared by the next good one. */
  error: string | null;
  loading: boolean;
  desktopPermission: DesktopPermission;
  requestDesktop: () => Promise<void>;
  /** Raises one toast (and one desktop notification, if allowed) about nothing. */
  sendTest: () => void;
}

/**
 * The three calls, injectable so a DOM test can drive the provider without a
 * fetch stub. Production passes nothing and gets `api.ts`.
 */
export interface NotifyApi {
  fetchNotifications: typeof fetchNotifications;
  ackNotification: typeof ackNotification;
  muteNotification: typeof muteNotification;
  /** Optional so a test about reading and acking need not fake the Inbox v2 writes. */
  clearNotifications?: typeof clearNotifications;
  snoozeNotifications?: typeof snoozeNotifications;
  notificationSettings?: typeof notificationSettings;
}

const LIVE_API: NotifyApi = {
  fetchNotifications,
  ackNotification,
  muteNotification,
  clearNotifications,
  snoozeNotifications,
  notificationSettings,
};

/** How long the undo bar stays up after a verb. */
export const UNDO_BAR_MS = 6000;

/** The undo bar's line: `Cleared 4 notifications · kept in History for 30 days`. */
export interface UndoBar {
  /** Unique per verb, so the bar's life animation restarts on the next one. */
  key: number;
  label: string;
  sub: string;
}

/** One entry on the undo stack: the bar's words and the way back. */
type UndoEntry =
  | {
      key: number;
      label: string;
      sub: string;
      kind: "rows";
      prior: NotificationView[];
      after: NotificationView[];
    }
  | { key: number; label: string; sub: string; kind: "mute"; target: MuteTarget; clear: boolean };

/** An entry before the stack numbers it; distributive, so each arm keeps its own fields. */
type NewUndoEntry = UndoEntry extends infer E ? (E extends UndoEntry ? Omit<E, "key"> : never) : never;

/** Deep enough to walk back a flurry of verbs, shallow enough not to matter. */
const UNDO_DEPTH = 20;

/** The longest `setTimeout` a browser honours; a later snooze is re-armed on the next read. */
const MAX_TIMER_MS = 2_147_483_647;

const NotifyContext = createContext<Notify | null>(null);

/** `agent:<name>` / `source:<source>`, spelled the way core spells them. */
function muteTargets(input: MuteTarget): string[] {
  const targets: string[] = [];
  if (input.agent) targets.push(`agent:${input.agent}`);
  if (input.source) targets.push(`source:${input.source}`);
  return targets;
}

/**
 * `muted` is derived, never stored (§9.2): a mute applies to every row an agent
 * or a source has ever raised, so a local write has to re-derive the flag
 * across the whole list rather than patch the row that happened to be on screen.
 */
function applyMutes(
  items: readonly NotificationView[],
  mutes: readonly NotificationMuteView[],
): NotificationView[] {
  const targets = new Set(mutes.map((m) => m.target));
  return items.map((n) => {
    const muted = (!!n.agent && targets.has(`agent:${n.agent}`)) || targets.has(`source:${n.source}`);
    return n.muted === muted ? n : { ...n, muted };
  });
}

export function NotifyProvider({ children, api = LIVE_API }: { children: ReactNode; api?: NotifyApi }) {
  const fleet = useFleetIfAvailable();
  const listening = useListeningIfAvailable();
  const instances = listening?.instances;
  const listeningRef = useRef(listening);
  listeningRef.current = listening;
  const accepts = useCallback(
    (n: NotificationView) =>
      !listeningRef.current || !hiddenByListening(n, listeningRef.current.instances),
    [],
  );
  const refreshGeneration = useRef(0);
  const [items, setItems] = useState<NotificationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [needsAction, setNeedsAction] = useState(0);
  const [mutes, setMutes] = useState<NotificationMuteView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [centerOpenState, setCenterOpenState] = useState(false);
  const centerOpen = centerOpenState;
  const [watching, setWatching] = useState<WatchedThread | null>(null);
  const [snoozed, setSnoozed] = useState(0);
  const [history, setHistory] = useState(0);
  const [nextSnoozeAt, setNextSnoozeAt] = useState<string | null>(null);
  const [views, setViews] = useState<Notify["views"]>({ snoozed: null, history: null });
  /** Which drawer views have been read, so a settled write re-reads exactly those. */
  const loadedViews = useRef<Set<"snoozed" | "history">>(new Set());
  /** Led by a ref for the same reason `items` is (`writeItems` below). */
  const viewsRef = useRef(views);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerView, setDrawerView] = useState<DrawerView>("inbox");
  const [settings, setSettings] = useState<NotificationSettingsView | null>(null);
  const [undo, setUndo] = useState<UndoBar | null>(null);
  const undoStack = useRef<UndoEntry[]>([]);
  const undoSeq = useRef(0);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Inbox writes in flight, and a counter bumped as each one starts. A read that
   * began before a write and lands after it would put the pre-write rows back
   * over the optimistic ones, so it is dropped — the write's own settle re-reads.
   */
  const writesInFlight = useRef(0);
  const writeEpoch = useRef(0);
  const setCenterOpen = useCallback((open: boolean) => {
    setCenterOpenState(open);
    if (open) setDrawerOpen(false);
  }, []);
  /**
   * There is no browser permission to hold: the app owns the OS one and raises
   * on the page's behalf (`app.notify`), so the page is always allowed and the
   * permission band has nothing to ask for.
   *
   * Kept as state rather than a constant because `DesktopPermission` is the
   * shape the Notifications section renders, and "granted" is an answer to its
   * question rather than the absence of one.
   */
  const [desktopPermission] = useState<DesktopPermission>("granted");
  const [prefs, setPrefsState] = useState<NotificationPrefs>(() => {
    try {
      return loadNotificationPrefs();
    } catch {
      return defaultPrefs();
    }
  });

  const setPrefs = useCallback((next: NotificationPrefs) => {
    setPrefsState(next);
    saveNotificationPrefs(next);
  }, []);

  /**
   * The stream handler is registered once and has to see live preferences and
   * live centre state without re-registering (a re-register is cheap, but the
   * `useEffect` that owns it would then run on every keystroke in the settings
   * section). Refs, read at delivery time.
   */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const centerRef = useRef(centerOpen);
  centerRef.current = centerOpen;
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  /**
   * The rows this provider already holds, read at delivery time. A streamed row
   * may be one the last fetch already returned and already counted, and the
   * server only re-sends the authoritative counts when they change — so a blind
   * optimistic bump for such a row leaves the badge one too high indefinitely.
   */
  const itemsRef = useRef(items);
  /**
   * The one way rows change, and the reason `itemsRef` is not assigned during
   * render.
   *
   * It used to be (`itemsRef.current = items`), which made the ref a copy of
   * the last *committed* state rather than of the rows this provider holds. A
   * render landing between a streamed row and its commit — any other state
   * this provider sets, a parent re-render — put the pre-row list back in the
   * ref, and the same row arriving again was counted a second time: the badge
   * sat one too high until the server next sent authoritative counts.
   *
   * So the ref leads and the state follows. Every write goes through here, the
   * ref is the list a delivery reads, and no render can move it.
   */
  const writeItems = useCallback(
    (next: NotificationView[] | ((prev: NotificationView[]) => NotificationView[])): void => {
      const rows = typeof next === "function" ? next(itemsRef.current) : next;
      itemsRef.current = rows;
      setItems(rows);
    },
    [],
  );

  const dismissToast = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  const toastSeq = useRef(0);
  const pushToast = useCallback((notification: NotificationView) => {
    const toast: Toast = {
      key: `${notification.id}:${++toastSeq.current}`,
      notification,
      dwellMs: toastDwellMs(notification),
    };
    setToasts((prev) => {
      const next = [...prev, toast];
      while (next.length > TOAST_STACK_MAX) {
        // The oldest one that would have left on its own goes first; a sticky
        // toast is only evicted when there is nothing else to give up.
        const i = next.findIndex((t) => t.dwellMs !== null);
        next.splice(i === -1 ? 0 : i, 1);
      }
      return next;
    });
  }, []);

  /**
   * The last step of every desktop notification, once the rules above have
   * already said one is owed.
   *
   * The page raises none of them itself. `views://` grants no notification
   * permission, and there is nothing to ask for: the app owns the OS one, so
   * the page asks it through `app.notify`.
   */
  const raiseDesktop = useCallback(
    ({ title, body, tag }: { title: string; body?: string | null; tag?: string }) => {
      // Fire and forget: the banner is an escalation of a toast that has
      // already been raised, so an app that refused it must not take the
      // in-page half of the delivery down with it.
      void transport()
        .request("app.notify", { title, body: body ?? "", ...(tag ? { tag } : {}) })
        .catch(() => {});
    },
    [],
  );

  /**
   * A desktop notification fires only when the app is not the thing the
   * operator is already looking at: the window is not on screen, or the centre
   * is shut.
   * Otherwise the row is on screen and an OS banner is a second copy of it.
   */
  const maybeDesktop = useCallback(
    (n: NotificationView) => {
      if (!shouldDesktop(n, prefsRef.current, prefsRef.current.quiet, new Date(), watchingRef.current))
        return;
      if (isVisible() && centerRef.current) return;
      raiseDesktop({ title: n.title, body: n.detail, tag: n.id });
    },
    [raiseDesktop],
  );

  const refresh = useCallback(async () => {
    if (listeningRef.current?.pending.length || listeningRef.current?.loading) return;
    const gen = ++refreshGeneration.current;
    const epoch = writeEpoch.current;
    setLoading(true);
    try {
      const result: NotificationsResult = await api.fetchNotifications({ limit: INBOX_PAGE });
      if (gen !== refreshGeneration.current) return;
      // A verb started while this read was out: its rows are newer than the
      // answer, and its settle is already going to read again.
      if (epoch !== writeEpoch.current) return;
      // The page the server returned, before this laptop's listening filter:
      // whether the inbox is bigger than one page is the server's fact.
      setTruncated(result.notifications.length >= INBOX_PAGE);
      writeItems(result.notifications.filter(accepts));
      // Counts cover the entire inbox. Never estimate them from this limited
      // page while a listening write is pending; re-read after it commits.
      setUnread(result.unread);
      setNeedsAction(result.needs_action);
      // Inbox v2's totals and the next snooze to wake up; tolerant of a head
      // that predates them.
      setSnoozed(typeof result.snoozed === "number" ? result.snoozed : 0);
      setHistory(typeof result.history === "number" ? result.history : 0);
      setNextSnoozeAt(result.next_snooze_at ?? null);
      setMutes(result.mutes);
      setError(null);
    } catch (e: unknown) {
      if (gen === refreshGeneration.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === refreshGeneration.current) setLoading(false);
    }
  }, [api, accepts, writeItems]);

  useEffect(() => {
    setToasts((previous) => previous.filter((t) => accepts(t.notification)));
    writeItems((previous) => previous.filter(accepts));
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, accepts, instances, listening?.pending, listening?.loading, writeItems]);

  // The stream, borrowed from `FleetProvider` rather than opened again (§6).
  useEffect(() => {
    if (!fleet) return;
    return fleet.subscribeNotifications({
      onNotification: (n) => {
        if (!accepts(n)) return;
        // The delta is read against the rows already held, before they grow:
        // a row the last fetch already counted must not be counted again (see
        // `streamCountDelta`). The bump is replaced by the server's number on
        // the next count frame, and the two must not disagree in between about
        // how much of the inbox is outstanding.
        const delta = streamCountDelta(itemsRef.current, n);
        writeItems((prev) => (prev.some((p) => p.id === n.id) ? prev : [n, ...prev]));
        if (delta.unread) setUnread((u) => u + delta.unread);
        if (delta.needs_action) setNeedsAction((c) => c + delta.needs_action);
        if (shouldToast(n, prefsRef.current, prefsRef.current.quiet, new Date(), watchingRef.current))
          pushToast(n);
        maybeDesktop(n);
      },
      onCounts: (counts) => {
        if (listeningRef.current?.pending.length || listeningRef.current?.loading) return;
        setUnread(counts.unread);
        setNeedsAction(counts.needs_action);
      },
    });
  }, [fleet, pushToast, maybeDesktop, accepts, writeItems]);

  const writeMute = useCallback(
    async (input: MuteTarget, clear: boolean) => {
      try {
        const result = await api.muteNotification({ ...input, ...(clear ? { clear: true } : {}) });
        setMutes(result.mutes);
        writeItems((prev) => applyMutes(prev, result.mutes));
        const v = viewsRef.current;
        const next = {
          snoozed: v.snoozed ? applyMutes(v.snoozed, result.mutes) : null,
          history: v.history ? applyMutes(v.history, result.mutes) : null,
        };
        viewsRef.current = next;
        setViews(next);
        setError(null);
        // A newly muted target stops toasting, including anything of its own
        // already on screen: the operator asked for silence, not for silence
        // starting with the next one.
        if (!clear) {
          const targets = new Set(muteTargets(input));
          setToasts((prev) =>
            prev.filter(
              (t) =>
                !(
                  (!!t.notification.agent && targets.has(`agent:${t.notification.agent}`)) ||
                  targets.has(`source:${t.notification.source}`)
                ),
            ),
          );
        }
        return true;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [api, writeItems],
  );

  /* ── the undo stack ──────────────────────────────────────────────────── */

  const dismissUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setUndo(null);
  }, []);

  const pushUndo = useCallback((entry: NewUndoEntry) => {
    const key = ++undoSeq.current;
    undoStack.current = [...undoStack.current, { ...entry, key } as UndoEntry].slice(-UNDO_DEPTH);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ key, label: entry.label, sub: entry.sub });
    undoTimer.current = setTimeout(() => {
      undoTimer.current = null;
      setUndo(null);
    }, UNDO_BAR_MS);
  }, []);

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const mute = useCallback(
    async (target: MuteTarget, options: { undoable?: boolean } = {}) => {
      const ok = await writeMute(target, false);
      if (ok && options.undoable)
        pushUndo({
          kind: "mute",
          target,
          clear: false,
          label: `Muted ${target.agent ? `agent ${target.agent}` : `source ${target.source}`}`,
          sub: "rows still land, silently",
        });
    },
    [writeMute, pushUndo],
  );
  const unmute = useCallback(
    async (target: MuteTarget, options: { undoable?: boolean } = {}) => {
      const ok = await writeMute(target, true);
      if (ok && options.undoable)
        pushUndo({
          kind: "mute",
          target,
          clear: true,
          label: `Unmuted ${target.agent ?? target.source}`,
          sub: "",
        });
    },
    [writeMute, pushUndo],
  );

  /* ── the drawer's own views ──────────────────────────────────────────── */

  const writeViews = useCallback((next: Notify["views"]) => {
    viewsRef.current = next;
    setViews(next);
  }, []);

  const loadView = useCallback(
    async (view: "snoozed" | "history") => {
      loadedViews.current.add(view);
      try {
        const result = await api.fetchNotifications({ limit: INBOX_PAGE, view });
        writeViews({ ...viewsRef.current, [view]: result.notifications.filter(accepts) });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [api, accepts, writeViews],
  );

  /**
   * After the last write of a burst settles, read again: the counts, the
   * History total and anything core's auto-clear sweep moved are the server's
   * facts, and only a read carries them.
   */
  const settle = useCallback(() => {
    if (writesInFlight.current > 0) return;
    void refresh();
    for (const view of loadedViews.current) void loadView(view);
  }, [refresh, loadView]);

  /** One write, sent through the injected api. */
  const send = useCallback(
    async (write: InboxWrite) => {
      if (write.method === "notifications.ack") {
        await api.ackNotification(write.input);
        return;
      }
      if (write.method === "notifications.clear") {
        await (api.clearNotifications ?? clearNotifications)(write.input);
        return;
      }
      await (api.snoozeNotifications ?? snoozeNotifications)(write.input);
    },
    [api],
  );

  const runWrites = useCallback(
    async (writes: readonly InboxWrite[]) => {
      if (writes.length === 0) return;
      writesInFlight.current += 1;
      writeEpoch.current += 1;
      try {
        for (const write of writes) await send(write);
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        writesInFlight.current -= 1;
        settle();
      }
    },
    [send, settle],
  );

  /**
   * A read, bracketed like every other inbox write. Reading can trigger core's
   * auto-clear sweep (a resolved row read is cleared), which only a fresh read
   * shows, so it settles afterwards. It also bumps `writeEpoch`, so a refresh
   * already in flight cannot answer with the row still unread and flip the
   * optimistic write back. A failed read puts the error on screen rather than
   * silently leaving a row the operator believes they read; the settle's read
   * then puts the row back as the server has it.
   */
  const readWrite = useCallback(
    async (write: () => Promise<unknown>) => {
      writesInFlight.current += 1;
      writeEpoch.current += 1;
      try {
        await write();
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        writesInFlight.current -= 1;
        settle();
      }
    },
    [settle],
  );

  const ack = useCallback(
    async (id: string) => {
      // Optimistic: the row goes read here, and the server's count replaces the
      // local decrement when it answers. A failed ack puts the error on screen
      // rather than silently leaving a row the operator believes they cleared.
      const at = new Date().toISOString();
      let wasUnread = false;
      writeItems((prev) =>
        prev.map((n) => {
          if (n.id !== id || n.read_at) return n;
          // The row goes read either way; the *count* only moves for a row core
          // was counting, and core does not count a resolved one.
          if (!isResolved(n)) wasUnread = true;
          return { ...n, read_at: at };
        }),
      );
      if (wasUnread) setUnread((u) => Math.max(0, u - 1));
      await readWrite(() => api.ackNotification({ id }));
    },
    [api, readWrite, writeItems],
  );

  const ackMany = useCallback(
    async (ids: readonly string[]) => {
      const wanted = new Set(ids);
      if (wanted.size === 0) return;
      const at = new Date().toISOString();
      // Counted from the rows this provider holds, *before* the write and
      // outside the mapper: a tally kept inside an updater is one re-entrant
      // call away from decrementing the badge twice for the same rows.
      const unreadCleared = itemsRef.current.filter(
        (n) => wanted.has(n.id) && !n.read_at && !isResolved(n),
      ).length;
      writeItems((prev) =>
        prev.map((n) => (wanted.has(n.id) && !n.read_at ? { ...n, read_at: at } : n)),
      );
      if (unreadCleared) setUnread((u) => Math.max(0, u - unreadCleared));
      // One write per batch, not one per row: a coalesced card of forty
      // messages is one gesture and one request (`{ ids }`, 1..500).
      await readWrite(async () => {
        for (const ids of chunkIds([...wanted])) await api.ackNotification({ ids });
      });
    },
    [api, readWrite, writeItems],
  );

  const ackAll = useCallback(async () => {
    const at = new Date().toISOString();
    writeItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: at })));
    setUnread(0);
    await readWrite(() => api.ackNotification({ all: true }));
  }, [api, readWrite, writeItems]);

  /**
   * Puts `next` into every list that holds these rows, moving each between the
   * inbox, the snoozed view and History as its new state says, and moves the
   * badge by what that changed.
   */
  const placeRows = useCallback(
    (next: readonly NotificationView[], now: number) => {
      const byId = new Map(next.map((n) => [n.id, n]));
      const before = itemsRef.current.filter((n) => byId.has(n.id));
      // A row that was not held in the inbox (it came from a drawer view) has
      // its own prior copy in the views; count against that one.
      const heldIds = new Set(before.map((n) => n.id));
      const v = viewsRef.current;
      for (const n of [...(v.snoozed ?? []), ...(v.history ?? [])])
        if (byId.has(n.id) && !heldIds.has(n.id)) {
          before.push(n);
          heldIds.add(n.id);
        }
      const delta = countDelta(before, next, now);
      writeItems((prev) => {
        const replaced = prev.map((n) => byId.get(n.id) ?? n);
        const have = new Set(prev.map((n) => n.id));
        const added = next.filter((n) => !have.has(n.id) && inInbox(n, now));
        if (added.length === 0) return replaced;
        return [...replaced, ...added].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      });
      const place = (
        list: NotificationView[] | null,
        belongs: (n: NotificationView) => boolean,
      ): NotificationView[] | null => {
        if (list === null) return null;
        const have = new Set(list.map((n) => n.id));
        const kept = list.map((n) => byId.get(n.id) ?? n).filter(belongs);
        const added = next.filter((n) => !have.has(n.id) && belongs(n));
        return [...kept, ...added].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      };
      writeViews({
        snoozed: place(v.snoozed, (n) => !isCleared(n) && isSnoozed(n, now)),
        history: place(v.history, (n) => isCleared(n) || isResolved(n)),
      });
      if (delta.unread) setUnread((u) => Math.max(0, u + delta.unread));
      if (delta.needs) setNeedsAction((c) => Math.max(0, c + delta.needs));
    },
    [writeItems, writeViews],
  );

  /** The freshest copy this provider holds of each row, else the one passed in. */
  const freshest = useCallback((rows: readonly NotificationView[]): NotificationView[] => {
    const held = new Map<string, NotificationView>();
    const v = viewsRef.current;
    for (const n of [...(v.history ?? []), ...(v.snoozed ?? []), ...itemsRef.current])
      held.set(n.id, n);
    return rows.map((n) => held.get(n.id) ?? n);
  }, []);

  const act = useCallback(
    async (verb: InboxVerb, rows: readonly NotificationView[]) => {
      const now = Date.now();
      const at = new Date(now).toISOString();
      const prior = affectedRows(verb, freshest(rows), now);
      if (prior.length === 0) return;
      const after = prior.map((n) => applyVerb(n, verb, at));
      const { label, sub } = verbLabel(verb, prior, now);
      pushUndo({ kind: "rows", prior, after, label, sub });
      placeRows(after, now);
      await runWrites(verbWrites(verb, prior));
    },
    [freshest, pushUndo, placeRows, runWrites],
  );

  const undoLast = useCallback(async () => {
    const entry = undoStack.current[undoStack.current.length - 1];
    if (!entry) return;
    undoStack.current = undoStack.current.slice(0, -1);
    dismissUndo();
    if (entry.kind === "mute") {
      await writeMute(entry.target, !entry.clear);
      return;
    }
    const now = Date.now();
    const current = freshest(entry.after);
    placeRows(entry.prior, now);
    await runWrites(restoreWrites(entry.prior, current, now));
  }, [dismissUndo, writeMute, freshest, placeRows, runWrites]);

  /* ── the drawer, and core's auto-clear rule ──────────────────────────── */

  const openDrawer = useCallback((view?: DrawerView) => {
    setCenterOpenState(false);
    if (view) setDrawerView(view);
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const settingsApi = api.notificationSettings ?? notificationSettings;
  const loadSettings = useCallback(async () => {
    try {
      setSettings(await settingsApi({}));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [settingsApi]);
  const saveSettings = useCallback(
    async (patch: Partial<NotificationSettingsView>) => {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      try {
        setSettings(await settingsApi(patch));
        setError(null);
        // The sweep runs on the next read; make that now rather than later.
        void refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        void loadSettings();
      }
    },
    [settingsApi, refresh, loadSettings],
  );

  /**
   * A snoozed row comes back on its own at `snoozed_until`; the page learns
   * that by reading again at the earliest one the server reported.
   */
  useEffect(() => {
    if (!nextSnoozeAt) return;
    const at = Date.parse(nextSnoozeAt);
    if (Number.isNaN(at)) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now()) + 250);
    const t = setTimeout(() => {
      void refresh();
      if (loadedViews.current.has("snoozed")) void loadView("snoozed");
    }, delay);
    return () => clearTimeout(t);
  }, [nextSnoozeAt, refresh, loadView]);

  /**
   * Nothing to ask for: the app asked the OS when it started, and a page-level
   * prompt does not exist here to raise. Kept on the context because the
   * Notifications section's button is still wired to it, and a button that
   * resolves to "granted" is a truer answer than one that is missing.
   */
  const requestDesktop = useCallback(async () => {}, []);

  /**
   * "Send a test" answers the only question the permission band raises — will
   * anything actually appear — so it raises both halves: the in-page toast and,
   * when the browser has said yes, the OS banner.
   */
  const sendTest = useCallback(() => {
    const now = new Date().toISOString();
    const probe = {
      id: `test:${now}`,
      at: now,
      source: "fleet",
      kind: "fleet.advisory",
      class: "info",
      title: "Test notification",
      detail: "This is what one looks like. Nothing happened.",
      agent: null,
      fleet_id: null,
      ref: null,
      key: null,
      actions: [],
      read_at: now,
      resolved_at: null,
      muted: false,
    } as unknown as NotificationView;
    pushToast(probe);
    raiseDesktop({ title: probe.title, body: probe.detail });
  }, [pushToast, raiseDesktop]);

  const value = useMemo<Notify>(
    () => ({
      items,
      unread,
      needsAction,
      mutes,
      prefs,
      setPrefs,
      centerOpen,
      setCenterOpen,
      watching,
      setWatching,
      ack,
      ackMany,
      ackAll,
      mute,
      unmute,
      act,
      undo,
      undoLast,
      dismissUndo,
      snoozed,
      history,
      views,
      loadView,
      drawerOpen,
      drawerView,
      openDrawer,
      closeDrawer,
      settings,
      loadSettings,
      saveSettings,
      toasts,
      dismissToast,
      refresh,
      truncated,
      error,
      loading,
      desktopPermission,
      requestDesktop,
      sendTest,
    }),
    [
      items,
      unread,
      needsAction,
      mutes,
      prefs,
      setPrefs,
      centerOpen,
      setCenterOpen,
      watching,
      ack,
      ackMany,
      ackAll,
      mute,
      unmute,
      act,
      undo,
      undoLast,
      dismissUndo,
      snoozed,
      history,
      views,
      loadView,
      drawerOpen,
      drawerView,
      openDrawer,
      closeDrawer,
      settings,
      loadSettings,
      saveSettings,
      toasts,
      dismissToast,
      refresh,
      truncated,
      error,
      loading,
      desktopPermission,
      requestDesktop,
      sendTest,
    ],
  );

  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>;
}

export function useNotify(): Notify {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error("useNotify must be used inside <NotifyProvider>");
  return ctx;
}

/**
 * The inbox when this tree has a provider, `null` when it does not — the same
 * shape as `useFleetIfAvailable`, and for the same reason: `App` is rendered in
 * tests that are about the fleet and have no business seeding an inbox, and a
 * missing bell there is better than a thrown render.
 */
export function useNotifyIfAvailable(): Notify | null {
  return useContext(NotifyContext);
}

/**
 * Unread `chat.*` rows per `<instance>/<bot>`, for the rails.
 *
 * Empty without a provider, which is what a rail rendered in a test about the
 * fleet gets: the roster's own `unread` is then the whole story, exactly as it
 * was before.
 */
export function useUnreadChatByConversation(): Map<string, number> {
  const notify = useContext(NotifyContext);
  const items = notify?.items;
  return useMemo(() => (items ? unreadChatByConversation(items) : new Map<string, number>()), [items]);
}
