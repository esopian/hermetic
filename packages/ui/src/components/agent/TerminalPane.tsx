/**
 * The live half of the Terminal section (issue #18): the toolbar, the session
 * sub-tabs, the screen and the footer.
 *
 * The screen owns the keyboard while it has focus — Esc included — which is
 * what `data-owns-keys` tells the drawer and the page shortcuts
 * (`keyboardOwned` in `lib/focus.ts`). The hint under it says how to get the
 * keyboard back, because "press Esc" is the one answer that cannot work.
 */
import type { ReactNode, Ref } from "react";
import type { TerminalSessionView } from "../../api/terminal.ts";
import { SESSIONS_PER_AGENT, sessionHint, sessionLabel } from "../../logic/terminal-logic.ts";

export const TERM_HINT =
  "keys go to the shell while it has focus — Esc included · click outside the terminal, then Esc closes the drawer";

export function TerminalPane({
  sessions,
  selected,
  connecting,
  titles,
  flashing,
  onSelect,
  onNew,
  onCopy,
  copied,
  onExternal,
  onEnd,
  onReconnect,
  onClose,
  screenRef,
  notice,
  foot,
}: {
  sessions: TerminalSessionView[];
  selected: TerminalSessionView | null;
  /** A session is being opened: the strip shows its placeholder tab. */
  connecting: boolean;
  titles: Record<string, string | null>;
  /** The session whose bell just rang. */
  flashing: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onCopy: () => void;
  copied: boolean;
  /** Absent in fixture mode. */
  onExternal?: () => void;
  onEnd: () => void;
  onReconnect: () => void;
  onClose: () => void;
  screenRef: Ref<HTMLDivElement>;
  /** A one-line notice for the toolbar (a refused open, a refused keystroke). */
  notice: string | null;
  /** The footer's right-hand side. */
  foot: ReactNode;
}) {
  const live = sessions.filter((s) => s.state === "live").length;
  const capped = live >= SESSIONS_PER_AGENT;
  const ended = selected?.state === "ended";
  const state = connecting
    ? { label: "connecting", tone: "acc" }
    : selected === null
      ? { label: "no session", tone: "" }
      : ended
        ? { label: stateOfEnded(selected), tone: "" }
        : { label: "connected", tone: "ok" };

  return (
    <div className="term-wrap">
      <div className="term-toolbar">
        <span className="term-state">
          <span className={`term-sq ${state.tone}`} aria-hidden="true" />
          {state.label}
        </span>
        {notice ? <span className="term-notice">{notice}</span> : null}
        <span className="term-spacer" />
        <button
          type="button"
          className="btn btn-secondary btn-mini"
          onClick={onCopy}
          title="Copy the tailscale ssh command"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {onExternal ? (
          <button type="button" className="btn btn-secondary btn-mini" onClick={onExternal}>
            Open in Terminal ↗
          </button>
        ) : null}
        {ended ? (
          <>
            <button type="button" className="btn btn-secondary btn-mini" onClick={onReconnect}>
              Reconnect
            </button>
            <button type="button" className="btn btn-secondary btn-mini" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-mini term-end"
            onClick={onEnd}
            disabled={selected === null}
          >
            End
          </button>
        )}
        <div className="term-tabs" role="tablist" aria-label="Terminal sessions">
          {sessions.map((s) => {
            const on = s.session_id === selected?.session_id;
            const unseen = s.unseen && !on;
            return (
              <button
                key={s.session_id}
                type="button"
                role="tab"
                aria-selected={on}
                className={[
                  on ? "on" : "",
                  flashing === s.session_id ? "bell" : "",
                  s.state === "ended" ? "ended" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                title={sessionHint(s)}
                data-session={s.session_id}
                onClick={() => onSelect(s.session_id)}
              >
                {sessionLabel(s, titles[s.session_id] ?? null)}
                {unseen ? (
                  <>
                    <i className="term-dot" aria-hidden="true" />
                    <span className="sr-only">new output</span>
                  </>
                ) : null}
              </button>
            );
          })}
          {connecting ? (
            <button type="button" role="tab" aria-selected={false} className="pending" disabled>
              {sessions.length + 1} · connecting
            </button>
          ) : null}
          <button
            type="button"
            className="term-new"
            onClick={onNew}
            disabled={capped || connecting}
            title={
              capped
                ? `${SESSIONS_PER_AGENT} sessions is the limit per agent — end one to open another`
                : "Open another session"
            }
          >
            + New
          </button>
        </div>
      </div>
      <div className="term-screen" ref={screenRef} data-owns-keys="" />
      <div className="term-foot">
        <span>{TERM_HINT}</span>
        <span className="term-foot-r">{foot}</span>
      </div>
    </div>
  );
}

function stateOfEnded(s: TerminalSessionView): string {
  const exit = s.exit;
  if (exit === undefined) return "ended";
  if (exit.reason === "acl_denied") return "ended · denied";
  if (exit.reason === "closed") return "ended · closed";
  return exit.signal !== null ? `ended · ${exit.signal}` : `ended · exit ${exit.code ?? "?"}`;
}
