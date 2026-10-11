/**
 * The Terminal section's panels — everything it shows instead of a screen
 * (issue #18): the cold start, the preflight refusals that name their fix,
 * the stopped agent, the ACL refusal and the session that has gone.
 *
 * One shape for all of them, the Desktop section's cold panel in the mock's
 * terminal dress: a square glyph, a kicker that names the state (the error
 * code where there is one, so an operator can search for it), a heading that
 * says what is wrong in words, and the one or two moves that fix it.
 */
import type { ReactNode } from "react";

export function TermPanel({
  tone = "idle",
  kicker,
  title,
  children,
  actions,
}: {
  tone?: "idle" | "off" | "bad" | "warn";
  kicker: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={`term-panel term-panel-${tone}`} aria-label={title}>
      <div className="term-glyph" aria-hidden="true">
        {tone === "bad" || tone === "warn" ? "!" : ">_"}
      </div>
      <div className="term-panel-body">
        <div className="kicker">{kicker}</div>
        <h3>{title}</h3>
        {children}
        {actions ? <div className="term-panel-row">{actions}</div> : null}
      </div>
    </section>
  );
}

/** The command a session runs, with Copy beside it. */
export function CommandRow({
  command,
  onCopy,
  copied,
}: {
  command: string | null;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="term-cmd">
      <code className="mono" title={command ?? undefined}>
        {command ?? "tailscale ssh …"}
      </code>
      <button
        type="button"
        className="btn btn-secondary btn-mini"
        onClick={onCopy}
        disabled={command === null}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function ColdPanel({
  name,
  host,
  command,
  copied,
  onCopy,
  onConnect,
  onExternal,
  connecting,
}: {
  name: string;
  host: string;
  command: string | null;
  copied: boolean;
  onCopy: () => void;
  onConnect: () => void;
  /** Absent in fixture mode, where there is no terminal app to hand the command to. */
  onExternal?: () => void;
  connecting: boolean;
}) {
  return (
    <TermPanel
      kicker="Terminal · tailscale ssh"
      title={`Open a shell on ${name}`}
      actions={
        <>
          <button type="button" className="btn btn-primary" onClick={onConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect →"}
          </button>
          {onExternal ? (
            <button type="button" className="btn btn-secondary" onClick={onExternal}>
              Open in Terminal ↗
            </button>
          ) : null}
        </>
      }
    >
      <p>
        Runs Tailscale SSH from this Mac to <span className="mono">{host}</span>. There's no keypair and
        no port 22 open to the internet. Sessions stay open while you use the rest of the app, and
        quitting ends them.
      </p>
      <CommandRow command={command} onCopy={onCopy} copied={copied} />
    </TermPanel>
  );
}

/** The three preflight refusals (`TAILSCALE_*`), each with the fix it needs. */
export function PreflightPanel({
  code,
  details,
  onRetry,
  onCopy,
}: {
  code: "TAILSCALE_MISSING" | "TAILSCALE_STOPPED" | "TAILSCALE_WRONG_TAILNET";
  details: unknown;
  onRetry: () => void;
  onCopy: () => void;
}) {
  const detail = (key: string): string | null => {
    if (typeof details !== "object" || details === null) return null;
    const value = (details as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  const actions = (
    <>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Check again
      </button>
      <button type="button" className="btn btn-secondary" onClick={onCopy}>
        Copy command
      </button>
    </>
  );
  if (code === "TAILSCALE_MISSING") {
    return (
      <TermPanel
        tone="bad"
        kicker={`Terminal · ${code}`}
        title="Tailscale isn't installed on this Mac"
        actions={actions}
      >
        <p>
          The terminal connects through Tailscale SSH, so it needs the{" "}
          <span className="mono">tailscale</span> command on this machine. Hermetic looked in{" "}
          <span className="mono">/usr/local/bin</span>, <span className="mono">/opt/homebrew/bin</span>{" "}
          and <span className="mono">Tailscale.app</span>.
        </p>
        <ol>
          <li>
            Install Tailscale from tailscale.com/download, or run{" "}
            <span className="mono">brew install tailscale</span>.
          </li>
          <li>Sign in to the fleet's tailnet.</li>
          <li>
            Come back and press <b>Check again</b>.
          </li>
        </ol>
      </TermPanel>
    );
  }
  if (code === "TAILSCALE_STOPPED") {
    const state = detail("backend_state");
    return (
      <TermPanel
        tone="warn"
        kicker={`Terminal · ${code}`}
        title="Tailscale isn't running on this Mac"
        actions={actions}
      >
        <p>
          Tailscale is installed but not connected
          {state ? (
            <>
              {" "}
              (<span className="mono">{state}</span>)
            </>
          ) : null}
          . Start it from the menu bar, or run <span className="mono">tailscale up</span>, then check
          again.
        </p>
      </TermPanel>
    );
  }
  const local = detail("local_tailnet");
  const fleet = detail("fleet_tailnet");
  return (
    <TermPanel
      tone="warn"
      kicker={`Terminal · ${code}`}
      title="This Mac is on a different tailnet"
      actions={actions}
    >
      <p>
        Tailscale here is signed in to <span className="mono">{local ?? "another tailnet"}</span>, but
        this fleet lives on <span className="mono">{fleet ?? "its own tailnet"}</span>. Switch accounts
        in the Tailscale menu, then check again.
      </p>
    </TermPanel>
  );
}

export function StoppedPanel({
  name,
  status,
  onLifecycle,
}: {
  name: string;
  status: string;
  onLifecycle: () => void;
}) {
  return (
    <TermPanel
      tone="off"
      kicker="Terminal"
      title={`No shell while this agent is ${status}`}
      actions={
        <button type="button" className="btn btn-secondary" onClick={onLifecycle}>
          Go to Lifecycle →
        </button>
      }
    >
      <p>
        <span className="mono">{name}</span> is <span className="mono">{status}</span>. There's no
        instance on the tailnet to SSH into. Start it from Lifecycle, and the terminal is available once
        it reports ready.
      </p>
    </TermPanel>
  );
}

/** Exit 255 with the policy's words, inside the ACL window (`exitReason` in the app). */
export function AclPanel({ onPolicy, onRetry }: { onPolicy: () => void; onRetry: () => void }) {
  return (
    <TermPanel
      tone="bad"
      kicker="Terminal · exit 255"
      title="Your tailnet policy doesn't allow SSH to this agent"
      actions={
        <>
          <button type="button" className="btn btn-primary" onClick={onPolicy}>
            Review tailnet policy →
          </button>
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Try again
          </button>
        </>
      }
    >
      <p>
        Tailscale refused the connection. Hermetic's managed <span className="mono">ssh</span> and{" "}
        <span className="mono">acls :22</span> entries may be missing or drifted, or your user isn't in{" "}
        <span className="mono">autogroup:member</span>. The raw output is below.
      </p>
    </TermPanel>
  );
}

/**
 * The box let the login through and `nologin` ended it: the `hermes` account was
 * created by a hermeticd older than the terminal (§9.3). The release that sets
 * the shell does so when it starts, so the remedy is getting it onto the box.
 */
export function NoLoginShellPanel({ host, onRetry }: { host: string; onRetry: () => void }) {
  return (
    <TermPanel
      tone="bad"
      kicker="Terminal · no login shell"
      title="This agent's hermes account can't log in yet"
      actions={
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      }
    >
      <p>
        The box was created by a hermeticd older than the terminal, so{" "}
        <span className="mono">hermes</span> still has the <span className="mono">nologin</span> shell.
        Push this build's hermeticd with <span className="mono">hermetic artifacts push</span>: the box
        takes it on its nightly update and sets the shell when the new hermeticd starts. A{" "}
        <span className="mono">recreate</span> fixes it now. Until then,{" "}
        <span className="mono">tailscale ssh root@{host}</span> logs in as root.
      </p>
    </TermPanel>
  );
}

/** A deep link (a notification's `Open session`) to a session the app no longer holds. */
export function ClosedPanel({ onConnect }: { onConnect: () => void }) {
  return (
    <TermPanel
      tone="off"
      kicker="Terminal"
      title="That session has closed"
      actions={
        <button type="button" className="btn btn-primary" onClick={onConnect}>
          Connect →
        </button>
      }
    >
      <p>It ended and was closed, or the app restarted since. Connect opens a new one.</p>
    </TermPanel>
  );
}
