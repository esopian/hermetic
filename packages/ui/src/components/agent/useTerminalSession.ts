/**
 * The Terminal section's two halves of state (issue #18).
 *
 * - `useTerminalSessions(name)`: the app's session table for one agent, read
 *   with `terminal.list`. Held by the drawer rather than the section because
 *   the nav's sub-line (`● running: apt`) reads it too, and the drawer is
 *   open far more often than the section. Re-read on a short interval only
 *   while a session is live — that is all activity and unseen output are.
 * - `useTerminalScreen(...)`: one attach of one session onto one `TermView`.
 *   Switching session is a detach, a reset and a fresh attach whose snapshot
 *   repaints the screen; sessions live in the main process and outlive all
 *   of it (D2).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/errors.ts";
import {
  sendTerminalAck,
  sendTerminalInput,
  terminalAttach,
  terminalList,
  terminalResize,
  type TerminalFrame,
  type TerminalSessionView,
} from "../../api/terminal.ts";
import {
  AttachLedger,
  RESIZE_DEBOUNCE_MS,
  bytesOf,
  chunkBinary,
  chunkText,
  endedLine,
  sanitizeTitle,
  skippedNote,
  type TerminalProblem,
} from "../../logic/terminal-logic.ts";
import type { TermView } from "./xterm-adapter.ts";

/** How often a live session's activity and unseen flag are re-read. */
const LIST_POLL_MS = 2000;

/**
 * The last preflight refusal this page saw. Module state on purpose: it is a
 * fact about this Mac's Tailscale, not about any one agent or drawer, and
 * the nav's "tailscale not found" should survive closing the drawer.
 */
let lastProblem: TerminalProblem | null = null;

const PROBLEMS: ReadonlySet<string> = new Set([
  "TAILSCALE_MISSING",
  "TAILSCALE_STOPPED",
  "TAILSCALE_WRONG_TAILNET",
]);

/** A refusal code as the preflight problem it names, or null for any other code. */
export function asProblem(code: string): TerminalProblem | null {
  return PROBLEMS.has(code) ? (code as TerminalProblem) : null;
}

export function problemOf(e: unknown): TerminalProblem | null {
  return e instanceof ApiError ? asProblem(e.code) : null;
}

export interface TerminalSessions {
  /** This agent's sessions, lowest index first; empty before the first read. */
  sessions: TerminalSessionView[];
  /** `terminal_alerts`; true until read, so the footer never flashes "off". */
  alerts: boolean;
  /** Whether a read has answered. A deep link waits for it before saying "closed". */
  loaded: boolean;
  problem: TerminalProblem | null;
  setProblem: (problem: TerminalProblem | null) => void;
  refresh: () => Promise<void>;
}

export function useTerminalSessions(name: string): TerminalSessions {
  const [sessions, setSessions] = useState<TerminalSessionView[]>([]);
  const [alerts, setAlerts] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblemState] = useState<TerminalProblem | null>(lastProblem);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const listing = await terminalList(name);
      if (!alive.current) return;
      setSessions([...listing.sessions].sort((a, b) => a.index - b.index));
      setAlerts(listing.alerts);
    } catch {
      // A head with no terminal host (`UNSUPPORTED`), or a test with no route:
      // the section still offers Copy and Open in Terminal, which need none.
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [name]);

  const setProblem = useCallback((next: TerminalProblem | null) => {
    lastProblem = next;
    setProblemState(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const anyLive = sessions.some((s) => s.state === "live");
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => void refresh(), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [anyLive, refresh]);

  return { sessions, alerts, loaded, problem, setProblem, refresh };
}

/* ── one attach ──────────────────────────────────────────────────────────── */

/** Each session's keystroke counter, from 0. Outlives a remount so a reattach does not restart it. */
const inSeqs = new Map<string, number>();

function nextInSeq(sessionId: string): number {
  const n = inSeqs.get(sessionId) ?? 0;
  inSeqs.set(sessionId, n + 1);
  return n;
}

export interface ScreenEvents {
  /** OSC 0/2, sanitized; null clears it. */
  onTitle: (sessionId: string, title: string | null) => void;
  onBell: (sessionId: string) => void;
  /** The stream's last frame: the session ended (or was closed). */
  onExit: (sessionId: string) => void;
}

export interface ScreenState {
  /** "[skipped N KiB to catch up]" after a resync, until the next one. */
  skipped: string | null;
  /** The last `input_error` code, for the toolbar. */
  inputError: string | null;
  /** Whether the first snapshot of this attach has been drawn. */
  restored: boolean;
}

/**
 * Attach `session` to `view`, and keep the two in step: frames in, keystrokes
 * and acks out, the pane's size to the PTY. `session` null detaches.
 *
 * Output is written with xterm's callback, and the ack goes from there —
 * after parsing, not on receipt — so the app's credit window measures what
 * the page has actually drawn (`AttachLedger`).
 */
export function useTerminalScreen(
  view: TermView | null,
  container: HTMLElement | null,
  session: TerminalSessionView | null,
  events: ScreenEvents,
): ScreenState {
  const [skipped, setSkipped] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const sessionId = session?.session_id ?? null;
  const live = session?.state === "live";
  const startedAt = session?.started_at ?? null;
  /** Whether keystrokes and resizes go anywhere: a live session, attached. */
  const liveRef = useRef(false);
  liveRef.current = live;

  /** The PTY's size, after a debounce, and only when it changed. */
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentSize = useRef<string>("");
  const fit = useCallback(() => {
    if (view === null || sessionId === null) return;
    const size = view.proposeSize();
    if (size === null || size.cols < 2 || size.rows < 2) return;
    if (size.cols !== view.cols || size.rows !== view.rows) view.resize(size.cols, size.rows);
    if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      resizeTimer.current = null;
      const key = `${sessionId}:${size.cols}x${size.rows}`;
      if (!liveRef.current || sentSize.current === key) return;
      sentSize.current = key;
      void terminalResize(sessionId, Math.min(size.cols, 500), Math.min(size.rows, 200)).catch(
        () => {},
      );
    }, RESIZE_DEBOUNCE_MS);
  }, [view, sessionId]);

  // The attach. Keyed on the session and whether it is live: an exit that
  // turned it `ended` keeps the screen as drawn and does not reattach.
  useEffect(() => {
    if (view === null || sessionId === null) return;
    const ledger = new AttachLedger();
    let streamId: string | null = null;
    let closed = false;
    setSkipped(null);
    setInputError(null);
    setRestored(false);
    view.reset();
    sentSize.current = "";

    const onFrame = (frame: TerminalFrame) => {
      if (closed) return;
      switch (frame.event) {
        case "snapshot": {
          const { gen, seq, cols, rows, b64 } = frame.data;
          const verdict = ledger.snapshot(gen, seq);
          if (!verdict.draw) return;
          view.reset();
          view.resize(cols, rows);
          view.write(bytesOf(b64), () => {
            if (!closed) fit();
          });
          setRestored(true);
          if (verdict.skipped > 0) setSkipped(skippedNote(verdict.skipped));
          return;
        }
        case "data": {
          const { gen, end, b64 } = frame.data;
          if (!ledger.data(gen, end)) return;
          view.write(bytesOf(b64), () => {
            const upto = ledger.parsed(gen, end);
            if (upto !== null && streamId !== null && !closed) sendTerminalAck(streamId, gen, upto);
          });
          return;
        }
        case "input_error":
          setInputError(frame.data.code);
          return;
        case "exit": {
          const ran = startedAt === null ? null : Date.now() - Date.parse(startedAt);
          view.write(
            `\r\n\x1b[2m${endedLine(frame.data, Number.isFinite(ran) ? ran : null)}\x1b[0m\r\n`,
          );
          closed = true;
          detach();
          eventsRef.current.onExit(sessionId);
          return;
        }
        default:
          return;
      }
    };

    const detach = terminalAttach(sessionId, {
      onOpen: (id) => {
        streamId = id;
      },
      onFrame,
      onEnd: () => {
        // The stream died without an `exit` (the window's bridge went away,
        // or the session was dropped). The list read says what is left.
        if (!closed) eventsRef.current.onExit(sessionId);
        closed = true;
      },
    });

    const typed = view.onData((data) => {
      if (!liveRef.current) return;
      for (const chunk of chunkText(data)) {
        sendTerminalInput({ session_id: sessionId, in_seq: nextInSeq(sessionId), data: chunk });
      }
    });
    const binary = view.onBinary((data) => {
      if (!liveRef.current) return;
      for (const chunk of chunkBinary(data)) {
        sendTerminalInput({ session_id: sessionId, in_seq: nextInSeq(sessionId), binary: chunk });
      }
    });
    const titled = view.onTitle((raw) => eventsRef.current.onTitle(sessionId, sanitizeTitle(raw)));
    const rang = view.onBell(() => eventsRef.current.onBell(sessionId));

    return () => {
      closed = true;
      detach();
      typed.dispose();
      binary.dispose();
      titled.dispose();
      rang.dispose();
    };
    // `live` is deliberately absent: see above. `startedAt` and `fit` are per session.
  }, [view, sessionId, startedAt, fit]);

  // The pane's size: a debounced fit on every change of the container's box.
  useEffect(() => {
    if (container === null || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, fit]);

  useEffect(
    () => () => {
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    },
    [],
  );

  return { skipped, inputError, restored };
}
