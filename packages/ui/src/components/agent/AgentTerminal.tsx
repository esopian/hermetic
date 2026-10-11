/**
 * The agent drawer's Terminal section (§9.3, issue #18): a shell on the box
 * over Tailscale SSH, owned by the app's main process and drawn here.
 *
 * What it holds to:
 *
 * - **It starts cold** (D3). Opening the section spawns nothing; `Connect →`
 *   does. Reaching it for a session that already exists attaches to that one
 *   instead, and the snapshot repaints the screen as it was left (D2).
 * - **Sessions outlive it.** Leaving the section, or closing the drawer,
 *   detaches; it never ends a session. Only End and Close do.
 * - **Failures are panels, not toasts.** A preflight refusal names its fix;
 *   a stopped agent points at Lifecycle; an ACL refusal points at the policy.
 * - **Copy and Open in Terminal ↗ never need the PTY** — the phase-1 path
 *   stays whole if the in-app one breaks.
 *
 * Which session is on screen is the hash's (`#agent/<name>/terminal/<id>`,
 * `nav-state.tsx`), so a notification's `Open session` lands on the right one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentView } from "../../api/index.ts";
import { ApiError } from "../../api/errors.ts";
import { initTailscale } from "../../api/client.ts";
import { sendTerminalView, terminalClose, terminalExternal, terminalOpen } from "../../api/terminal.ts";
import { openExternal } from "../../lib/open-external.ts";
import { hostname } from "../../logic/format.ts";
import {
  BELL_FLASH_MS,
  FALLBACK_SIZE,
  SESSIONS_PER_AGENT,
  terminalAgentOff,
} from "../../logic/terminal-logic.ts";
import type { SettingsSection } from "../../nav/settings-nav.ts";
import {
  onTerminalViewChange,
  setTerminalShowing,
  viewedTerminal,
} from "../../state/terminal-watch.ts";
import { AclPanel, ClosedPanel, ColdPanel, PreflightPanel, StoppedPanel } from "./TerminalPanels.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import {
  asProblem,
  problemOf,
  useTerminalScreen,
  type TerminalSessions,
} from "./useTerminalSession.ts";
import { useSshCommand } from "./useSshCommand.ts";
import { createTermView, type TermView } from "./xterm-adapter.ts";

/** A refused open, kept as the panel or notice it becomes. */
interface Refusal {
  code: string;
  message: string;
  details: unknown;
}

export function AgentTerminal({
  agent,
  tailnet,
  fleetId,
  fixture,
  terminal,
  session,
  onSession,
  onSection,
  onSettings,
  covered = false,
}: {
  agent: AgentView;
  tailnet: string;
  fleetId: string | null;
  /** Fixture mode: a canned shell, and no terminal app to hand a command to. */
  fixture: boolean;
  /** The drawer's read of the session table (`useTerminalSessions`). */
  terminal: TerminalSessions;
  /** The session the hash names, or null. */
  session: string | null;
  onSession: (session: string | null) => void;
  onSection: (section: "lifecycle") => void;
  onSettings: (section: SettingsSection) => void;
  /** Something covers the drawer: the session is not being looked at. */
  covered?: boolean;
}) {
  const name = agent.name;
  const host = hostname(name, tailnet, agent.tailscale_dns_name, fleetId);
  const ssh = useSshCommand(name, host);
  const { sessions, loaded, refresh, setProblem } = terminal;
  const [opening, setOpening] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const [flashing, setFlashing] = useState<string | null>(null);
  const [facts, setFacts] = useState<string | null>(null);

  const linked = session === null ? undefined : sessions.find((s) => s.session_id === session);
  const fallback = sessions.find((s) => s.state === "live") ?? sessions[0];
  const selected = session === null ? (fallback ?? null) : (linked ?? null);
  const gone = session !== null && loaded && linked === undefined && !opening;
  const off = terminalAgentOff(agent.display_status) || refusal?.code === "TERMINAL_AGENT_OFF";
  const problem = refusal === null ? null : asProblem(refusal.code);

  /* ── the screen ── */
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState<TermView | null>(null);
  useEffect(() => {
    if (screenEl === null) return;
    let made: TermView | null = null;
    let gone_ = false;
    void createTermView({ onLink: openExternal }).then((v) => {
      if (gone_) {
        v.dispose();
        return;
      }
      made = v;
      v.open(screenEl);
      setView(v);
    });
    return () => {
      gone_ = true;
      made?.dispose();
      setView(null);
    };
  }, [screenEl]);

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screen = useTerminalScreen(view, screenEl, opening ? null : selected, {
    onTitle: (id, title) => setTitles((t) => (t[id] === title ? t : { ...t, [id]: title })),
    onBell: (id) => {
      setFlashing(id);
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashing(null), BELL_FLASH_MS);
    },
    onExit: () => void refresh(),
  });
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  /* ── what this window is looking at (`terminal.view`) ── */
  const showing = covered || opening ? null : (selected?.session_id ?? null);
  useEffect(() => {
    setTerminalShowing(showing);
  }, [showing]);
  // Declared before the subscription so that on unmount the `null` is still heard.
  useEffect(() => () => setTerminalShowing(null), []);
  useEffect(() => {
    const off_ = onTerminalViewChange((viewed) => {
      sendTerminalView(viewed);
    });
    sendTerminalView(viewedTerminal());
    return off_;
  }, []);

  /* ── the cold panel's preflight: a cheap read of this Mac's Tailscale ── */
  const cold = loaded && sessions.length === 0 && session === null;
  useEffect(() => {
    if (!cold || off) return;
    let live = true;
    initTailscale().then(
      (t) => {
        if (!live) return;
        if (!t.installed) {
          setProblem("TAILSCALE_MISSING");
          setRefusal({ code: "TAILSCALE_MISSING", message: "", details: null });
        } else if (!t.running) {
          setProblem("TAILSCALE_STOPPED");
          setRefusal({
            code: "TAILSCALE_STOPPED",
            message: "",
            details: { backend_state: t.backend_state },
          });
        } else {
          setProblem(null);
          setFacts(
            `tailscale · signed in to ${t.tailnet ?? "a tailnet"} · up to ${SESSIONS_PER_AGENT} sessions per agent`,
          );
        }
      },
      () => {
        // No preflight read here (a test, an older head); Connect still asks.
      },
    );
    return () => {
      live = false;
    };
  }, [cold, off, setProblem]);

  /* ── moves ── */
  const connect = useCallback(async () => {
    setOpening(true);
    setRefusal(null);
    setNotice(null);
    const size = view?.proposeSize() ?? FALLBACK_SIZE;
    try {
      const opened = await terminalOpen(name, clamp(size.cols, 2, 500), clamp(size.rows, 2, 200));
      setProblem(null);
      await refresh();
      onSession(opened.session_id);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "UNKNOWN";
      const message = e instanceof Error ? e.message : String(e);
      const p = problemOf(e);
      if (p !== null) setProblem(p);
      // A panel only where there is nothing else to show: with sessions open,
      // a refused `+ New` is a toolbar notice and the screens stay.
      if ((p !== null && sessions.length === 0) || code === "TERMINAL_AGENT_OFF") {
        setRefusal({ code, message, details: e instanceof ApiError ? e.details : null });
      } else {
        setNotice(code === "TERMINAL_LIMIT" ? message || "session limit reached" : message);
      }
    } finally {
      setOpening(false);
    }
  }, [name, onSession, refresh, setProblem, view, sessions.length]);

  const end = useCallback(async () => {
    if (selected === null) return;
    const id = selected.session_id;
    try {
      await terminalClose(id);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
    await refresh();
    onSession(null);
  }, [onSession, refresh, selected]);

  const external = useCallback(() => {
    setNotice(null);
    terminalExternal(name).catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  }, [name]);
  const onExternal = fixture ? undefined : external;

  /* ── what to show ── */
  const lead = (
    <p className="term-lead">
      A shell on {name}, over the tailnet.
      {cold ? " It keeps running while you read other sections." : ""}
      {fixture ? <span className="term-tag">fixture · nothing leaves this Mac</span> : null}
    </p>
  );

  let body: ReactNode;
  if (off) {
    body = (
      <StoppedPanel
        name={name}
        status={agent.display_status}
        onLifecycle={() => onSection("lifecycle")}
      />
    );
  } else if (problem !== null && refusal !== null) {
    body = (
      <PreflightPanel
        code={problem}
        details={refusal.details}
        onRetry={() => void connect()}
        onCopy={ssh.copy}
      />
    );
  } else if (gone) {
    body = <ClosedPanel onConnect={() => void connect()} />;
  } else if (selected === null && !opening) {
    body = loaded ? (
      <>
        <ColdPanel
          name={name}
          host={host}
          command={ssh.command}
          copied={ssh.copied}
          onCopy={ssh.copy}
          onConnect={() => void connect()}
          {...(onExternal ? { onExternal } : {})}
          connecting={opening}
        />
        {notice ? <div className="term-facts term-facts-bad">{notice}</div> : null}
        {facts ? (
          <div className="term-facts">
            <span className="term-sq ok" aria-hidden="true" />
            {facts}
          </div>
        ) : null}
      </>
    ) : null;
  } else {
    const acl = selected?.state === "ended" && selected.exit?.reason === "acl_denied";
    const live = sessions.filter((s) => s.state === "live").length;
    const foot = !terminal.alerts ? (
      <>
        <span className="term-warn">◌ alerts off</span> ·{" "}
        <button type="button" className="linklike" onClick={() => onSettings("notifications")}>
          Settings →
        </button>
      </>
    ) : screen.skipped ? (
      <span className="term-dim">{screen.skipped}</span>
    ) : live >= SESSIONS_PER_AGENT ? (
      `${live} of ${SESSIONS_PER_AGENT} · end one to open another`
    ) : screen.restored ? (
      "links open in your browser"
    ) : null;
    body = (
      <>
        {acl ? <AclPanel onPolicy={() => onSettings("policy")} onRetry={() => void connect()} /> : null}
        <TerminalPane
          sessions={sessions}
          selected={opening ? null : selected}
          connecting={opening}
          titles={titles}
          flashing={flashing}
          onSelect={(id) => onSession(id)}
          onNew={() => void connect()}
          onCopy={ssh.copy}
          copied={ssh.copied}
          {...(onExternal ? { onExternal } : {})}
          onEnd={() => void end()}
          onReconnect={() => void connect()}
          onClose={() => void end()}
          screenRef={setScreenEl}
          notice={notice ?? (screen.inputError ? `input refused · ${screen.inputError}` : null)}
          foot={foot}
        />
      </>
    );
  }

  return (
    <div className="dr-pane term-section" data-section="terminal">
      <div className="dr-say">
        <div className="kicker">Terminal</div>
        {lead}
      </div>
      {body}
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
