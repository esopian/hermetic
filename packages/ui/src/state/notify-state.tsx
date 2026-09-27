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
import { ackNotification, fetchNotifications, muteNotification } from "../api/index.ts";
import type {
  NotificationMuteView,
  NotificationSourceView,
  NotificationView,
  NotificationsResult,
} from "../api/index.ts";
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
   * Marks several rows read as one gesture.
   *
   * The route takes one id or `--all` and nothing in between (`NotificationsAckInput`
   * insists on exactly one), so this is a loop over the client call rather than
   * a wider request — a coalesced card in the centre stands for every row in
   * its run, and acking it has to clear all of them, not just the one drawn.
   */
  ackMany: (ids: readonly string[]) => Promise<void>;
  ackAll: () => Promise<void>;
  mute: (target: MuteTarget) => Promise<void>;
  unmute: (target: MuteTarget) => Promise<void>;
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
}

const LIVE_API: NotifyApi = { fetchNotifications, ackNotification, muteNotification };

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
  const [centerOpen, setCenterOpen] = useState(false);
  const [watching, setWatching] = useState<WatchedThread | null>(null);
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
    setLoading(true);
    try {
      const result: NotificationsResult = await api.fetchNotifications({ limit: INBOX_PAGE });
      if (gen !== refreshGeneration.current) return;
      // The page the server returned, before this laptop's listening filter:
      // whether the inbox is bigger than one page is the server's fact.
      setTruncated(result.notifications.length >= INBOX_PAGE);
      writeItems(result.notifications.filter(accepts));
      // Counts cover the entire inbox. Never estimate them from this limited
      // page while a listening write is pending; re-read after it commits.
      setUnread(result.unread);
      setNeedsAction(result.needs_action);
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
      try {
        await api.ackNotification({ id });
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        void refresh();
      }
    },
    [api, refresh, writeItems],
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
      try {
        for (const id of wanted) await api.ackNotification({ id });
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        void refresh();
      }
    },
    [api, refresh, writeItems],
  );

  const ackAll = useCallback(async () => {
    const at = new Date().toISOString();
    writeItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: at })));
    setUnread(0);
    try {
      await api.ackNotification({ all: true });
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      void refresh();
    }
  }, [api, refresh, writeItems]);

  const writeMute = useCallback(
    async (input: MuteTarget, clear: boolean) => {
      try {
        const result = await api.muteNotification({ ...input, ...(clear ? { clear: true } : {}) });
        setMutes(result.mutes);
        writeItems((prev) => applyMutes(prev, result.mutes));
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
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [api],
  );

  const mute = useCallback((target: MuteTarget) => writeMute(target, false), [writeMute]);
  const unmute = useCallback((target: MuteTarget) => writeMute(target, true), [writeMute]);

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
      watching,
      ack,
      ackMany,
      ackAll,
      mute,
      unmute,
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
