/**
 * The agent drawer's left nav: one entry per section, each with a mono
 * sub-line that summarises the section without opening it — health on
 * Overview, the listening state on Chat, the profile and model on Config, the
 * one action worth taking on Lifecycle.
 *
 * A vertical tablist. Each entry is named by its label alone and described by
 * its sub-line, so "Desktop" is still the tab's name to a screen reader and to
 * a test, and the reading is announced after it.
 *
 * Chat is gated on listening (§9.2): an instance nobody listens to has no bots
 * in chat, so its entry is disabled and the Listen switch sits directly under
 * the list with the sentence that explains it.
 */
import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { AgentView } from "../../api/index.ts";
import type { RerunState } from "../../logic/bootstrap.ts";
import { isOff } from "../../logic/format.ts";
import { profileById } from "../../logic/provider-logic.ts";
import { terminalSubline } from "../../logic/terminal-logic.ts";
import { AGENT_TABS, AGENT_TAB_LABELS } from "../../nav/agent-nav.ts";
import type { AgentTab } from "../../nav/agent-nav.ts";
import type { ProfilesState } from "../../state/state.tsx";
import { useOpenRequestCount } from "../../state/file-requests-state.tsx";
import { openRequestsLabel } from "./files-logic.ts";
import { ListenButton } from "../ListenButton.tsx";
import { lifecycleSubline, overviewSubline } from "./agent-summary.ts";
import type { TerminalSessions } from "./useTerminalSession.ts";

export function AgentSectionNav({
  agent,
  latest,
  profiles,
  rerun,
  section,
  onSection,
  chat,
  terminal,
}: {
  agent: AgentView;
  latest: string | null;
  profiles: ProfilesState;
  rerun: RerunState;
  section: AgentTab;
  onSection: (section: AgentTab) => void;
  /**
   * Whether the Chat entry can open, and why not. `available` is false when
   * the app has no chat at all (a static render, a test); `listening` is false
   * when there is no listening state to gate on, and then there is no switch.
   */
  chat: { available: boolean; watched: boolean; listening: boolean };
  /** The agent's terminal sessions (`useTerminalSessions`); absent reads as none. */
  terminal?: Pick<TerminalSessions, "sessions" | "problem">;
}) {
  const refs = useRef<Partial<Record<AgentTab, HTMLButtonElement | null>>>({});
  const off = isOff(agent);
  const bound = profileById(profiles.list ?? [], agent.profile_id);
  const model = agent.hermes?.model ?? bound?.model ?? null;
  const life = lifecycleSubline(agent, latest, rerun);
  const browsers = agent.browsers ?? [];
  const requests = useOpenRequestCount(agent.name);
  const term = terminalSubline({
    status: agent.display_status,
    sessions: terminal?.sessions ?? [],
    problem: terminal?.problem ?? null,
  });

  const chatDisabled = !chat.available || !chat.watched;
  const sub: Record<AgentTab, string> = {
    overview: overviewSubline(agent),
    chat: !chat.available ? "not available here" : chat.watched ? "listening" : "not listening",
    desktop: off
      ? `instance ${agent.display_status}`
      : browsers.length === 0
        ? "no browser on this box"
        : "not connected",
    terminal: term.text,
    files: off
      ? `instance ${agent.display_status}`
      : requests > 0
        ? openRequestsLabel(requests)
        : "inbox · outbox · secrets",
    logs: "activity · journal · console",
    config: [bound?.name ?? agent.provider, model].filter(Boolean).join(" · "),
    lifecycle: life.text,
  };

  /**
   * Entries whose sub-line is the `●` form, and its colour: Lifecycle's is a
   * recommended action, so `--warn`; Terminal's is session activity, so the
   * accent (docs/ui-brief.md, Colour meaning). Files' is a request waiting on
   * the operator, so `--warn` too.
   */
  const accent: Partial<Record<AgentTab, "warn" | "acc">> = {
    ...(life.accent ? { lifecycle: "warn" as const } : {}),
    ...(requests > 0 && !off ? { files: "warn" as const } : {}),
    ...(term.accent ? { terminal: "acc" as const } : {}),
  };

  const enabled = AGENT_TABS.filter((t) => !(t === "chat" && chatDisabled));

  /** Arrow keys walk the enabled entries, as a vertical tablist does. */
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, current: AgentTab) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = enabled.indexOf(current);
    const next = enabled[(i + (e.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length];
    if (!next) return;
    onSection(next);
    refs.current[next]?.focus();
  };

  return (
    <nav className="dr-snav">
      <div role="tablist" aria-orientation="vertical" aria-label="Agent sections">
        {AGENT_TABS.map((t) => {
          const disabled = t === "chat" && chatDisabled;
          const selected = section === t;
          return (
            <button
              key={t}
              ref={(el) => {
                refs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`agent-tab-${t}`}
              aria-selected={selected}
              aria-labelledby={`agent-tab-${t}-label`}
              aria-describedby={`agent-tab-${t}-sub`}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              title={disabled && chat.available ? "Listen to this instance to enable chat" : undefined}
              className={selected ? "on" : undefined}
              onClick={() => onSection(t)}
              onKeyDown={(e) => onKey(e, t)}
            >
              <span id={`agent-tab-${t}-label`}>{AGENT_TAB_LABELS[t]}</span>
              <small id={`agent-tab-${t}-sub`} className={accent[t]}>
                {accent[t] ? "● " : ""}
                {sub[t]}
              </small>
            </button>
          );
        })}
      </div>
      {chat.listening ? (
        <div className="dr-snav-listen">
          <ListenButton instance={agent.name} />
          {/* Visible, not only the disabled tab's tooltip, which neither a keyboard nor a screen reader reaches. */}
          {!chat.watched ? (
            <span className="hint" id="agent-listen-hint">
              Listen to use chat.
            </span>
          ) : null}
        </div>
      ) : null}
      {/* The CLI echo: what the section is, typed. */}
      <div className="dr-snav-foot mono">
        $ hermetic{" "}
        {section === "logs"
          ? "logs"
          : section === "terminal"
            ? "ssh"
            : section === "files"
              ? "files"
              : "agent"}
        <br />
        &nbsp;&nbsp;
        {section === "logs" || section === "terminal"
          ? agent.name
          : section === "files"
            ? `ls ${agent.name}`
            : `status ${agent.name}`}
      </div>
    </nav>
  );
}
