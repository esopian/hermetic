/**
 * The terminal's half of the notification provider (issue #18): the banner
 * gate and the return toast. Kept out of `notify-state.tsx`, which is already
 * long, and called from it once (`useTerminalNotify`).
 *
 * The rules themselves are pure and live in `logic/terminal-notify.ts`; this
 * module owns only what they need from a running page — a clock and a timer
 * for the held banners, and the window's comings and goings for the return
 * toast.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationView } from "../api/index.ts";
import { TerminalBannerGate, isTerminalKind, pickReturnToast } from "../logic/terminal-notify.ts";
import type { ReturnToastPick, TerminalBanner } from "../logic/terminal-notify.ts";
import { windowPresent } from "./terminal-watch.ts";

export type ReturnToast = ReturnToastPick<NotificationView>;

export interface TerminalNotifyDeps {
  /** The rows the provider holds, read when the window comes back. */
  itemsRef: { current: NotificationView[] };
  /** The OS banner, once the gate has said one is owed. */
  raiseDesktop: (banner: TerminalBanner) => void;
  /**
   * Whether a banner held behind the app-wide limit may still go out when the
   * limit lifts. The same rule `maybeDesktop` applies to a fresh one: not
   * while the page is on screen with the centre open.
   */
  mayBanner: () => boolean;
  /** Takes the stacked toasts for these rows down: the return toast speaks for them. */
  dismissToastsFor: (ids: ReadonlySet<string>) => void;
  /** The clock; tests pass their own. */
  now?: () => number;
}

export interface TerminalNotify {
  /**
   * Every streamed terminal row, once the provider has decided whether it
   * interrupts. A row that interrupted while the window was away is kept for
   * the return toast.
   */
  noteRow: (n: NotificationView, interrupted: boolean) => void;
  /** A terminal row's desktop banner, through the coalescing gate. */
  banner: (n: NotificationView) => void;
  /** The pinned return toast, while it is up. */
  returnToast: ReturnToast | null;
  dismissReturnToast: () => void;
}

export function useTerminalNotify(deps: TerminalNotifyDeps): TerminalNotify {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const clock = useCallback(() => (depsRef.current.now ?? Date.now)(), []);

  /* ── banners ──────────────────────────────────────────────────────────── */

  const gate = useRef(new TerminalBannerGate());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** One timer at most, armed for the moment the held banners may go. */
  const schedule = useCallback(() => {
    if (flushTimer.current !== null) return;
    const at = gate.current.nextFlushAt();
    if (at === null) return;
    flushTimer.current = setTimeout(
      () => {
        flushTimer.current = null;
        const folded = gate.current.flush(clock());
        if (folded !== null && depsRef.current.mayBanner()) depsRef.current.raiseDesktop(folded);
        schedule();
      },
      Math.max(0, at - clock()),
    );
  }, [clock]);

  useEffect(
    () => () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      flushTimer.current = null;
    },
    [],
  );

  const banner = useCallback(
    (n: NotificationView) => {
      // The row's own id tags its banner, so the OS folds a repeat of the same
      // row; the session is the gate's key, which is the row's `ref`.
      const raised = gate.current.offer(
        n.ref ?? n.id,
        { title: n.title, body: n.detail ?? "", tag: n.id },
        clock(),
      );
      if (raised !== null) depsRef.current.raiseDesktop(raised);
      schedule();
    },
    [clock, schedule],
  );

  /* ── the return toast ─────────────────────────────────────────────────── */

  const away = useRef<NotificationView[]>([]);
  const [returnToast, setReturnToast] = useState<ReturnToast | null>(null);

  const noteRow = useCallback((n: NotificationView, interrupted: boolean) => {
    if (!interrupted || !isTerminalKind(n.kind) || windowPresent()) return;
    away.current.push(n);
  }, []);

  /**
   * On every arrival — the window going from absent to present — the rows
   * kept while it was away become one pinned toast for the newest of them,
   * and the ordinary toasts they raised in the meantime go: the return toast
   * is the one place they are summarised, and the inbox still has every row.
   */
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let wasPresent = windowPresent();
    const check = (): void => {
      const present = windowPresent();
      const arrived = present && !wasPresent;
      wasPresent = present;
      if (!arrived || away.current.length === 0) return;
      const kept = away.current;
      away.current = [];
      const pick = pickReturnToast(kept, depsRef.current.itemsRef.current);
      if (pick === null) return;
      setReturnToast(pick);
      depsRef.current.dismissToastsFor(new Set(kept.map((row) => row.id)));
    };
    window.addEventListener("focus", check);
    window.addEventListener("blur", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  const dismissReturnToast = useCallback(() => setReturnToast(null), []);

  return { noteRow, banner, returnToast, dismissReturnToast };
}
