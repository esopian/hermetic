/**
 * One agent, everything about it, as a small settings app: a short header, the
 * environment strip, and a left nav of sections — Overview, Chat, Desktop,
 * Logs, Config, Lifecycle. Every action lives on Lifecycle as a card that says
 * what it keeps, what it loses and how long it takes; teardown goes through
 * `plan.destroy` and a typed-name confirm there, because core will not ask
 * (§3.2 rule 3).
 *
 * This is the shell: it owns the state every section shares — the op rail,
 * the history read, the probe, the destroy flow, the Desktop credentials — and
 * composes the sections under `./agent/`. The op rail is pinned above the
 * section content, so an operator who starts an op on Lifecycle and moves to
 * Logs still watches it finish.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useChatIfAvailable } from "../chat/chat-state.tsx";
import { useChatEntry } from "../chat/chat-entry-state.tsx";
import { ChatView } from "../chat/components/ChatView.tsx";
import { isTopmostOverlay } from "../lib/focus.ts";
import { openExternal } from "../lib/open-external.ts";
import { useListeningIfAvailable } from "../state/listening-state.tsx";
import { fleetIdOf, history as fetchHistory, rebootAgent, rerunAgent } from "../api/index.ts";
import type { AgentEvent, AgentView, Meta } from "../api/index.ts";
import type { ProfilesState } from "../state/state.tsx";
import { rerunState } from "../logic/bootstrap.ts";
import { DEFAULT_AGENT_TAB } from "../nav/agent-nav.ts";
import type { AgentTab } from "../nav/agent-nav.ts";
import {
  dashboardUrl,
  desktopUrl,
  drawerActions,
  hostname,
  hostnameMismatch,
  rebootState,
} from "../logic/format.ts";
import { failureHints } from "../logic/op-hints.ts";
import { AgentDesktop } from "./AgentDesktop.tsx";
import { AgentConfig } from "./agent/AgentConfig.tsx";
import { AgentLifecycle } from "./agent/AgentLifecycle.tsx";
import { AgentLogs } from "./agent/AgentLogs.tsx";
import { AgentOverview } from "./agent/AgentOverview.tsx";
import { AgentSectionNav } from "./agent/AgentSectionNav.tsx";
import { RAIL_FADE_MS, useAgentOp } from "./agent/useAgentOp.ts";
import { useDesktopAttach } from "./agent/useDesktopAttach.ts";
import { useDestroyFlow } from "./agent/useDestroyFlow.ts";
import { useLivenessProbe } from "./agent/useLivenessProbe.ts";
import { ListenButton, ListeningNotice } from "./ListenButton.tsx";
import { OpProgress } from "./OpProgress.tsx";
import { StatusDot } from "./primitives.tsx";
import { Drawer } from "./Drawer.tsx";
import { DrawerEnvStrip } from "./EnvStrip.tsx";

/** How long a sent reboot may wait for the box's first heartbeat before the button is released. */
const REBOOT_WAIT_MS = 5 * 60_000;

/**
 * Is focus inside the desktop viewer's frame rather than on one of the drawer's
 * own controls?
 *
 * Belt and braces, not the mechanism: a cross-origin frame swallows every
 * keydown it receives, so an Escape aimed at the agent's screen does not reach
 * this document in the first place. This guard is what catches the cases where
 * it might — a same-origin frame in a test or a future local viewer — and
 * keeps Esc from closing the drawer out from under a keypress meant for the
 * remote screen. The hint line in the panel tells operators the move that
 * actually works: click off the frame first.
 */
function inFrame(): boolean {
  if (typeof document === "undefined") return false;
  // The desktop viewer is an `<electrobun-webview>`, not an iframe
  // (`AgentDesktop.tsx`); either is a frame whose keys are not the drawer's.
  const tag = document.activeElement?.tagName;
  return tag === "IFRAME" || tag === "ELECTROBUN-WEBVIEW";
}

export function AgentDrawer({
  agent,
  chatInitiallyOpen = false,
  meta,
  latest,
  tailnet,
  profiles,
  runningOpId,
  onOp,
  onClose,
  confirmOpen,
  setConfirmOpen,
  tab = DEFAULT_AGENT_TAB,
  onTab,
  covered = false,
}: {
  agent: AgentView;
  /** When true, the drawer opens straight onto its Chat section. */
  chatInitiallyOpen?: boolean;
  meta: Meta | null;
  latest: string | null;
  tailnet: string;
  /** §8.3's profiles, read once by `App` — the binding panel names them. */
  profiles: ProfilesState;
  runningOpId: string | null;
  onOp: (name: string, opId: string | null) => void;
  onClose: () => void;
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  /**
   * Which section is open. Owned by `App` rather than here, because it rides in
   * the hash (`#agent/<name>/lifecycle`) and the app has the one hash writer —
   * the same split Settings' sections use. Mirrored locally so a caller with no
   * `onTab` (the static tests, a host that does not route) can still move
   * between sections; defaulted so every caller with no opinion gets Overview.
   */
  tab?: AgentTab;
  onTab?: (tab: AgentTab) => void;
  /**
   * Another surface is open over this drawer (Settings, Volumes, a create
   * drawer). The drawer stays mounted underneath, which for the Desktop
   * section means a live RFB stream nobody can see — so the flag is passed
   * down and the panel goes cold. `App` owns it because `App` owns those
   * overlays.
   */
  covered?: boolean;
}) {
  const chat = useChatIfAvailable();
  const entry = useChatEntry();
  const listening = useListeningIfAvailable();
  const watched = !listening || listening.instances.includes(agent.name);
  const name = agent.name;

  const [section, setSection] = useState<AgentTab>(chatInitiallyOpen && watched ? "chat" : tab);
  useEffect(() => {
    setSection(tab);
  }, [tab]);

  /** The conversation the drawer's Chat section should show: this agent's, on its `default` bot. */
  const chatTarget = useCallback(
    () =>
      chat?.selection?.instance === name
        ? chat.selection
        : { instance: name, bot: "default", session: null },
    [chat?.selection, name],
  );

  /**
   * Move to a section. Leaving Lifecycle closes the destroy confirm: a typed
   * name half-way to a destroy should not survive the operator walking off to
   * read logs and be waiting, armed, when they come back.
   */
  const go = useCallback(
    (next: AgentTab) => {
      if (next !== "lifecycle" && confirmOpen) setConfirmOpen(false);
      setSection(next);
      onTab?.(next);
    },
    [confirmOpen, setConfirmOpen, onTab],
  );

  /** Chat needs the conversation selected before it can show it; the entry does both. */
  const openChat = useCallback(() => {
    if (!watched) return;
    if (entry?.open(chatTarget(), "drawer")) go("chat");
  }, [entry, chatTarget, watched, go]);

  const selectSection = useCallback(
    (next: AgentTab) => (next === "chat" ? openChat() : go(next)),
    [openChat, go],
  );

  // A fleet chat link opened this drawer on a conversation (`drawerTarget`):
  // land on Chat, the way the old Details|Chat strip did.
  useEffect(() => {
    if (chatInitiallyOpen && watched) go("chat");
    // `go` moves with `confirmOpen`; this is about the link, not the confirm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatInitiallyOpen, watched]);

  // `#agent/<name>/chat` from a reload or a pasted link has a section and no
  // selected conversation; select this agent's, once it is watched.
  // Keyed on the selected instance rather than the chat state, which moves on
  // every frame: one attempt per mismatch, not one per streamed token.
  const hasChat = !!chat;
  const selectedInstance = chat?.selection?.instance ?? null;
  useEffect(() => {
    if (section !== "chat" || !watched || !entry || !hasChat) return;
    if (selectedInstance === name) return;
    entry.open({ instance: name, bot: "default", session: null }, "drawer");
  }, [section, watched, entry, hasChat, selectedInstance, name]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const root = document.querySelector<HTMLElement>('[aria-labelledby="agent-title"]');
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "k" &&
        isTopmostOverlay(root)
      ) {
        e.preventDefault();
        if (!watched) return;
        if (entry?.open(chatTarget(), "dock")) onClose();
        return;
      }
      if (
        e.defaultPrevented ||
        e.key !== "t" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.shiftKey ||
        e.repeat ||
        e.isComposing ||
        !isTopmostOverlay(root)
      )
        return;
      if ((e.target as Element | null)?.closest("input, textarea, select, [contenteditable=true]"))
        return;
      e.preventDefault();
      openChat();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openChat, chatTarget, entry, onClose, watched]);

  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Command id the rerun route just handed back, before the stream catches up. */
  const [issuedCommand, setIssuedCommand] = useState<string | null>(null);
  /** A reboot this drawer just sent, and the heartbeat the row had when it was pressed. */
  const [rebootIssued, setRebootIssued] = useState<{ before: string | null } | null>(null);
  /**
   * The fleet's id, which is what a cloud name is built from since v4
   * (`cloudName`), and the fleet's *own* name — `_fleet.fleet_name`, not what
   * this home calls it — which is what a node built under v3 wears and the only
   * way to tell such a node from one whose name a dead device took.
   */
  const fleetId = fleetIdOf(meta);
  const fleetCloudName = meta?.config?.fleet_name ?? null;
  const actions = drawerActions(agent.display_status);
  const rerun = rerunState(agent, issuedCommand);
  const reboot = rebootState(agent, rebootIssued);

  const loadHistory = useCallback(() => {
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError(null);
    fetchHistory(name)
      .then((result) => {
        if (request === historyRequest.current) setEvents(result);
      })
      .catch((e: unknown) => {
        if (request === historyRequest.current)
          setHistoryError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (request === historyRequest.current) setHistoryLoading(false);
      });
  }, [name]);

  useEffect(() => {
    setEvents(null);
    loadHistory();
    return () => {
      historyRequest.current++;
    };
  }, [loadHistory]);

  // The drawer is not remounted when the selection moves, so the optimistic
  // rerun ack has to be dropped by hand or it would leak onto the next agent.
  useEffect(() => {
    setIssuedCommand(null);
    setRebootIssued(null);
  }, [name]);

  /**
   * A box that never heartbeats again is not left pulsing "Rebooting…" for as
   * long as the drawer is open: by this bound its row reads `unreachable`, which
   * is the signal that matters, and Reboot is what the operator may want again.
   */
  const rebootPending = reboot.pending;
  useEffect(() => {
    if (!rebootPending) return;
    const t = setTimeout(() => setRebootIssued(null), REBOOT_WAIT_MS);
    return () => clearTimeout(t);
  }, [rebootPending]);

  const { op, opState, opFailure, rail, showRail, accept } = useAgentOp({
    name,
    status: agent.display_status,
    runningOpId,
    onOp,
    onFinished: loadHistory,
  });
  const probe = useLivenessProbe(agent);
  const destroy = useDestroyFlow({
    confirmOpen,
    setConfirmOpen,
    fleetId,
    name,
    busy,
    setBusy,
    setFailure,
    accept,
  });
  const desktop = useDesktopAttach(name);

  async function run(label: string, fn: () => Promise<{ op_id: string }>) {
    setBusy(true);
    setFailure(null);
    try {
      const accepted = await fn();
      accept(accepted.op_id, label);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * `rerun` is not an op: the route writes a command on the row and returns
   * it, so there is no stream to attach and nothing to confirm. The returned
   * row's `command.id` is what the pending state waits on being acked.
   */
  async function doRerun() {
    setBusy(true);
    setFailure(null);
    try {
      const row = await rerunAgent(name);
      setIssuedCommand(row.command?.id ?? null);
      loadHistory();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Reboot is not an op either: one `RebootInstances`, one row write, and the
   * box comes back by itself. Nothing to confirm — the instance, its disks and
   * its tailnet address all survive, which is the whole difference from a
   * rebuild. The heartbeat on screen at the press is what the pressed state
   * waits past (`rebootState`): without it a reboot that worked showed nothing
   * at all.
   */
  async function doReboot() {
    setBusy(true);
    setFailure(null);
    const before = agent.last_heartbeat ?? null;
    try {
      await rebootAgent(name);
      setRebootIssued({ before });
      loadHistory();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The node came up under a name that is not the agent's, because the device
   * it replaced still holds that one. Everything hermetic links to already
   * follows the real name, so this is not a fault the drawer has to route
   * around — it is the one piece of cleanup nothing but the operator can do,
   * in a console hermetic has no scope to reach.
   *
   * `meta?.tailnet`, not the `tailnet` prop: that one falls back to
   * `DEFAULT_TAILNET` so a hostname can be *shown* before `/api/meta` arrives,
   * and comparing a real name against a guessed tailnet accuses every agent of
   * holding the wrong name for as long as the first paint lasts.
   */
  const staleDevice = hostnameMismatch(agent, meta?.tailnet ?? null, fleetId, fleetCloudName);
  const history = { events, historyLoading, historyError, loadHistory };

  let body: ReactNode;
  switch (section) {
    case "chat":
      body =
        chat && watched ? (
          <div className="dr-chat">
            <div className="ch-drawer-tabs">
              <button
                type="button"
                className="btn btn-sm"
                disabled={!chat.selection}
                onClick={() => {
                  if (chat.selection && entry?.open(chat.selection, "dock")) onClose();
                }}
              >
                Open in dock
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!chat.selection}
                onClick={() => {
                  if (chat.selection && entry?.open(chat.selection, "full")) onClose();
                }}
              >
                Expand chat
              </button>
            </div>
            {chat.selection?.instance === name ? (
              <div className="ch-drawer-chat">
                <ChatView withContext={false} withRail={false} />
              </div>
            ) : null}
          </div>
        ) : (
          // A `#agent/<name>/chat` link to an instance nobody listens to, or a
          // host with no chat at all: say which, and where the switch is.
          <div className="dr-pane">
            <div className="dr-say">
              <div className="kicker">Chat</div>
              <p>
                <b>{chat ? "Not listening." : "Chat is not available here."}</b>{" "}
                {chat ? "Listen to this instance to connect its bots to chat and alerts." : ""}
              </p>
            </div>
            {chat ? <ListenButton instance={name} /> : null}
          </div>
        );
      break;
    case "desktop":
      /*
        Mounted only while this section is selected — which is what makes the
        stream's lifetime the section's (`AgentDesktop`). Reachable on an agent
        with no browser stack: this panel is where an operator finds out *why*
        there is nothing to watch.
      */
      body = (
        <div className="dr-pane dr-desktop">
          <AgentDesktop
            name={agent.name}
            tailnet={tailnet}
            dnsName={agent.tailscale_dns_name}
            fleetId={fleetId}
            browsers={agent.browsers ?? []}
            status={agent.display_status}
            suspended={covered}
          />
        </div>
      );
      break;
    case "logs":
      body = <AgentLogs agent={agent} history={history} />;
      break;
    case "config":
      body = (
        <AgentConfig
          agent={agent}
          meta={meta}
          latest={latest}
          tailnet={tailnet}
          fleetId={fleetId}
          profiles={profiles}
          busy={busy}
          onRunOp={run}
          desktop={desktop}
        />
      );
      break;
    case "lifecycle":
      body = (
        <AgentLifecycle
          agent={agent}
          latest={latest}
          busy={busy}
          rerun={rerun}
          reboot={reboot}
          onRun={run}
          onRerun={() => void doRerun()}
          onReboot={() => void doReboot()}
          confirmOpen={confirmOpen}
          setConfirmOpen={setConfirmOpen}
          destroy={destroy}
        />
      );
      break;
    default:
      body = (
        <AgentOverview
          agent={agent}
          meta={meta}
          latest={latest}
          tailnet={tailnet}
          fleetId={fleetId}
          probe={probe}
          history={history}
          onSection={selectSection}
        />
      );
  }

  return (
    <Drawer
      width={840}
      onClose={onClose}
      onEscape={() => {
        // While the desktop frame has focus, Esc belongs to whatever is running
        // inside it — a dialog in the agent's own browser, a full-screen page,
        // noVNC's own key handling. Defensive: the cross-origin frame already
        // keeps that keystroke, so this line is for the frames that would not
        // (see `inFrame`).
        if (inFrame()) return;
        if (confirmOpen) setConfirmOpen(false);
        else if (section === "chat" && chat?.sending) void chat.abort();
        else onClose();
      }}
      labelledBy="agent-title"
    >
      <div className="drawer-head dr-head">
        <div style={{ minWidth: 0 }}>
          <div className="dr-head-status">
            <span className="dr-head-pill">
              <StatusDot status={agent.display_status} />
              {agent.display_status}
            </span>
            <span className="detail-host">
              {hostname(agent.name, tailnet, agent.tailscale_dns_name, fleetId)} ·{" "}
              {agent.tailscale_ip ?? "no tailnet ip"}
            </span>
          </div>
          <div className="drawer-title" id="agent-title">
            <span className="detail-name">{agent.name}</span>
          </div>
          {/*
            Two very different sentences, because the advice is opposite. A
            `stale` device is a corpse sitting on the canonical name and the fix
            is to delete it. A `legacy` node is this agent's own machine,
            wearing the name hermetic gave it before the naming rule moved —
            telling an operator to delete that device in the console would be
            telling them to evict the box they are looking at.

            The legacy sentence says what the name *is*, not when the box was
            built, and core's `staleDeviceNote` says why: the spelling a node
            asks for comes from the release published in the fleet bucket, so
            an agent created minutes ago can wear it too.
          */}
          {staleDevice?.kind === "stale" ? (
            <div className="detail-host-note">
              {staleDevice.canonical} is held by a stale device — delete it in the Tailscale admin
              console (Machines → {agent.name})
            </div>
          ) : staleDevice ? (
            <div className="detail-host-note">
              wearing a name hermetic used to hand out — a hostname is fixed at boot, so it keeps this
              one until it is recreated; nothing answers to {staleDevice.canonical}
            </div>
          ) : null}
        </div>
        <div className="dr-head-actions">
          {actions.dashboard ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() =>
                  openExternal(dashboardUrl(agent.name, tailnet, agent.tailscale_dns_name, fleetId))
                }
              >
                Dashboard ↗
              </button>
              {/*
                The desktop in the system browser rather than the drawer's own
                Desktop section — for the operator who wants the whole screen.
                An anchor, because it is a link: `href` is what makes
                middle-click and "copy link address" work.
              */}
              <a
                className="btn btn-sm btn-secondary"
                href={desktopUrl(agent.name, tailnet, agent.tailscale_dns_name, fleetId)}
                target="_blank"
                rel="noopener"
                title="Open this agent's screen in a new tab"
              >
                Open desktop ↗
              </a>
            </>
          ) : null}
          <button type="button" className="btn btn-box" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>
      <DrawerEnvStrip meta={meta} right={`${agent.size} · ${agent.instance_type}`} />
      {listening?.error ? <ListeningNotice instances={[agent.name]} /> : null}
      <div className="dr-side">
        <AgentSectionNav
          agent={agent}
          latest={latest}
          profiles={profiles}
          rerun={rerun}
          section={section}
          onSection={selectSection}
          chat={{ available: !!entry && !!chat, watched, listening: !!listening }}
        />
        <div className="dr-main" role="tabpanel" aria-labelledby={`agent-tab-${section}`}>
          {/*
            Pinned above whatever section is open: an op started on Lifecycle
            keeps reporting while the operator reads its logs.

            The same progress view create and init get, not a stripped bar: the
            stripped one dropped every message, so `agents.upgrade`'s "takes
            effect on the next recreate" was never rendered anywhere.
          */}
          {op && showRail ? (
            <div
              className="drawer-op"
              style={{
                opacity: rail === "fading" ? 0 : 1,
                transition: `opacity ${RAIL_FADE_MS}ms ease`,
              }}
            >
              <OpProgress
                title={op.label}
                sub={`${agent.name} · ${agent.instance_type}`}
                op={opState}
                hints={
                  opFailure ? failureHints(opFailure.code, op.label, name, agent.display_status) : []
                }
                hintsLabel={opFailure ? "What to try next" : "Before this agent is done"}
              />
            </div>
          ) : null}
          {/*
            A finished-and-failed op says its message, not only its code: the
            message is the part that names the failing AWS call. Kept beside the
            rail rather than folded into it — a rail that has faded out still
            owes this.
          */}
          {opFailure ? (
            <div className="opbar">
              <span className="ph" style={{ color: "var(--bad)" }}>
                {opFailure.code}
                {opFailure.message ? ` — ${opFailure.message}` : ""}
              </span>
              <span />
              <span />
            </div>
          ) : null}
          {failure ? (
            <div className="opbar">
              <span className="ph" style={{ color: "var(--bad)" }}>
                {failure}
              </span>
              <span />
              <span />
            </div>
          ) : null}
          <div className="dr-scroll">{body}</div>
        </div>
      </div>
    </Drawer>
  );
}
