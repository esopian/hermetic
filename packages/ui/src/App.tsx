/**
 * The shell: header, env strip, view nav, and the fleet page — its toolbar,
 * then one of three agent layouts, the volume lanes or the destroyed-agent
 * audit, by the lens the
 * toolbar's headline switch is on — footer, and the drawers. Everything below
 * reads one live fleet from `useFleet` and its place on the page from `useNav`
 * (`nav-state.tsx`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fleetIdOf, isInitialized } from "./api/index.ts";
import { AgentDrawer } from "./components/AgentDrawer.tsx";
import { CreateDrawer } from "./components/CreateDrawer.tsx";
import type { CreateOp } from "./components/CreateDrawer.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { readyProfiles } from "./logic/provider-logic.ts";
import { EnvStrip } from "./components/EnvStrip.tsx";
import { FleetBoard } from "./components/FleetBoard.tsx";
import { FleetTable } from "./components/FleetTable.tsx";
import { ListeningNotice } from "./components/ListenButton.tsx";
import { FleetTriage } from "./components/FleetTriage.tsx";
import { Footer } from "./components/Footer.tsx";
import { AppUpdateNotice } from "./state/app-update-state.tsx";
import { FoundationUpdateDrawer } from "./components/FoundationUpdateDrawer.tsx";
import { FleetPicker } from "./components/FleetSwitcher.tsx";
import { Header } from "./components/Header.tsx";
import { Bell } from "./components/notify/Bell.tsx";
import { NotificationCenter } from "./components/notify/Center.tsx";
import { Toasts } from "./components/notify/Toasts.tsx";
import { useNotifyIfAvailable } from "./state/notify-state.tsx";
import { ShortcutsPopover } from "./components/Shortcuts.tsx";
import { InitWizard } from "./components/InitWizard.tsx";
import { FleetSkeleton } from "./components/Loading.tsx";
import { ChatView } from "./chat/components/ChatView.tsx";
import { ChatShell } from "./chat/components/ChatShell.tsx";
import { useChatEntry } from "./chat/chat-entry-state.tsx";
import { ChatProvider } from "./chat/chat-state.tsx";
import { Settings } from "./components/settings/SettingsShell.tsx";
import { TeardownDrawer } from "./components/TeardownDrawer.tsx";
import { LastTeardownReceipt } from "./components/TeardownReceipt.tsx";
import { SkewBand } from "./components/SkewBand.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { ViewNav } from "./components/ViewNav.tsx";
import { VolumeDeleteDrawer } from "./components/VolumeDeleteDrawer.tsx";
import { VolumesView } from "./components/VolumesView.tsx";
import { DestroyedView, useDestroyedAudit } from "./components/DestroyedView.tsx";
import { filterVolumes, settleVolumes, type SettledPhase } from "./logic/volume-logic.ts";
import { fleetPhase, volumeScan } from "./logic/loading.ts";
import { NavProvider, useNav, useNavKeys } from "./nav/nav-state.tsx";
import {
  countsOf,
  emptyHint,
  filterAgents,
  nextSort,
  shouldDeselect,
  sortAgents,
  triageGroups,
  useFleet,
  useLayout,
  useProfiles,
  useVolumes,
  withoutDestroyed,
} from "./state/state.tsx";
import type { ProfilesState, Sort, SortKey } from "./state/state.tsx";

export function App() {
  const fleet = useFleet();
  const initialized = fleet.meta !== null && isInitialized(fleet.meta);
  /**
   * Identity is the `fleet_id` and nothing else (§4.6). The display alias is
   * optional and mutable — two fleets may both have none — so keying on it
   * would give aliasless fleets one shared cache and make an alias edit look
   * like a fleet switch.
   */
  const identity = JSON.stringify([
    fleet.meta?.config?.account_id,
    fleet.meta?.config?.region,
    fleet.meta?.fleet?.id ?? fleet.meta?.config?.fleet_id,
  ]);
  /**
   * §8.3's provider profiles, read once for the whole page: Settings lists and
   * edits them, the create drawer offers the ready ones, and the agent drawer
   * names the one each agent is bound to. Keyed on the fleet's identity, so a
   * switch forgets them rather than showing another account's setup. Read up
   * here because `NavProvider` re-reads them every time the create drawer opens.
   */
  const profiles = useProfiles(initialized, identity);
  const previousFleet = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!fleet.meta?.config?.fleet_id) return;
    if (
      previousFleet.current !== null &&
      previousFleet.current !== identity &&
      window.location.hash.startsWith("#chat/")
    ) {
      // A route carries no fleet identity. Clear its destination before the new
      // provider's passive effects can read an identically named bot elsewhere.
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#chat`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    previousFleet.current = identity;
  }, [identity, fleet.meta?.config?.fleet_id]);
  return (
    <ChatProvider key={identity} eager={false}>
      <ChatShell enabled={initialized}>
        <NavProvider onOpenCreate={profiles.refresh}>
          <AppBody profiles={profiles} />
        </NavProvider>
      </ChatShell>
    </ChatProvider>
  );
}

function AppBody({ profiles }: { profiles: ProfilesState }) {
  const chatEntry = useChatEntry();
  const fleet = useFleet();
  const nav = useNav();
  const initialized = fleet.meta !== null && isInitialized(fleet.meta);
  const volumes = useVolumes(initialized);
  /**
   * Since foundation v4 a node joins the tailnet as `<fleet id>-<agent>`
   * (`cloudName`, `format.ts`) — every hostname derivation below needs the
   * fleet's id to spell that prefix, not just the agent's name.
   */
  const fleetId = fleetIdOf(fleet.meta);
  const fleetIdentity = JSON.stringify([
    fleet.meta?.config?.account_id,
    fleet.meta?.config?.region,
    fleetId,
  ]);
  const [layout, setLayout] = useLayout();
  const [query, setQuery] = useState("");
  /**
   * §6.7: a destroy deletes the agent's row, so a destroyed agent is on no
   * layout here; its tombstone and history are the Destroyed lens's, read
   * only while that lens is up.
   */
  const destroyedAudit = useDestroyedAudit(initialized && nav.fleetLens === "destroyed");
  /** The create drawer's running op, so reopening re-attaches to its stream. */
  const [createOp, setCreateOp] = useState<CreateOp | null>(null);
  /**
   * The table's column order, owned here rather than by the table: the board
   * and the triage view draw the same list, so an order chosen in one layout
   * has to be the order the other two draw or switching layout reshuffles the
   * fleet under the operator. `null` is the server's own order.
   */
  const [sort, setSort] = useState<Sort | null>(null);
  const onSort = useCallback((key: SortKey) => setSort((s) => nextSort(s, key)), []);
  /** The `?` overlay: five shortcuts that had no discovery affordance at all. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsAnchor = useRef<HTMLButtonElement>(null);
  /**
   * §4.9's inbox. `null` when this tree has no `NotifyProvider` — the
   * fleet's own DOM tests mount `App` without one — so every notification
   * surface below is conditional rather than assumed.
   */
  const notify = useNotifyIfAvailable();
  const bellAnchor = useRef<HTMLButtonElement>(null);
  const notifyOpen = notify?.centerOpen ?? false;
  /**
   * Read through a ref because the window keydown handler is registered once
   * (see the effect below): a setter captured in that closure would go stale
   * the first time the provider re-rendered.
   */
  const setCenterOpenRef = useRef<((open: boolean) => void) | null>(null);
  setCenterOpenRef.current = notify?.setCenterOpen ?? null;
  // Sticky: once the wizard is up it stays up until the operator opens the
  // fleet, so the last step is not yanked away the moment the config lands.
  const [wizardOpen, setWizardOpen] = useState(false);
  /** Volumes with no agent, drawn among the fleet cards; on by default. */
  const [showVolumes, setShowVolumes] = useState(true);
  /**
   * §4.6: raised when a teardown op finishes, and deliberately owned here
   * rather than by the drawer — `reset_local` swaps this whole view for the
   * init wizard, and the receipt has to survive that. Closing it leaves the
   * operator on whatever is underneath, which after a reset is step one.
   */
  const [receiptOpen, setReceiptOpen] = useState(false);
  const showReceipt = useCallback(() => {
    setShortcutsOpen(false);
    setReceiptOpen(true);
  }, []);
  const filterRef = useRef<HTMLInputElement>(null);
  // Read by `useNavKeys` through a ref, so the one window listener it
  // registers sees live overlay state.
  const overlay = {
    shortcutsOpen,
    notifyOpen,
    popoverOpen: nav.popoverOpen,
    teardownOpen: nav.teardownOpen,
    createOpen: nav.createOpen,
    selected: nav.selected,
    settingsOpen: nav.settingsOpen,
    chatOpen: nav.chatOpen,
    foundationTeardownOpen: nav.foundationTeardownOpen,
    foundationUpdateOpen: nav.foundationUpdateOpen,
  };
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  // `agents.list` never returns a destroyed row (§6.7); the filter is a cheap
  // guard against one arriving anyway. The text query narrows the rest.
  const shown = useMemo(() => withoutDestroyed(fleet.agents), [fleet.agents]);
  const filtered = useMemo(
    () => filterAgents(shown, query, fleet.tailnet, fleetId),
    [shown, query, fleet.tailnet, fleetId],
  );
  // `Date.now()` is read once per sort rather than per comparison: uptime is an
  // age, and a clock that moves mid-sort is a comparator that is not a total
  // order. It changes nothing an operator can see — the fleet re-renders on
  // every poll anyway.
  const visible = useMemo(() => sortAgents(filtered, sort, Date.now()), [filtered, sort]);
  // Counted over the whole fleet, not the filtered view: the legend tells the
  // truth about what exists.
  const counts = useMemo(() => countsOf(fleet.agents), [fleet.agents]);
  const groups = useMemo(() => triageGroups(visible, fleet.latest), [visible, fleet.latest]);
  // Every live agent's name: the only names `agents.create` refuses, since a
  // destroy releases its name (§6.7) and the list carries no destroyed rows.
  const names = useMemo(() => new Set(fleet.agents.map((a) => a.name)), [fleet.agents]);
  /**
   * The volumes the agents lens may draw as tombstones: narrowed by the same
   * text filter the agents are, and by the toolbar chip. The volumes lens reads
   * the same filter but ignores the chip — it is where the tombstones go to be
   * seen in full.
   */
  const fleetVolumes = useMemo(
    () => (showVolumes ? filterVolumes(volumes.volumes, query) : []),
    [showVolumes, volumes.volumes, query],
  );
  const agent = nav.selected ? (fleet.byName.get(nav.selected) ?? null) : null;

  /**
   * The first paint, before the server has read the fleet even once. An empty
   * board is a claim about the account; until a scan comes back nobody has
   * looked, so the board owes a skeleton instead (`loading.ts`).
   */
  const phase = fleetPhase({
    connected: fleet.connected,
    everConnected: fleet.everConnected,
    scanned: fleet.scanned,
    scanError: fleet.scanError,
  });
  const scanning = phase !== "ready";
  const vscan = volumeScan({
    loading: volumes.loading,
    hasRead: volumes.hasRead,
    error: volumes.error,
    count: volumes.volumes.length,
  });
  // The last good agent count, so a resync redraws the shape the operator was
  // already looking at rather than a guess that reflows when the scan lands.
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (fleet.scanned && fleet.agents.length > 0) lastCount.current = fleet.agents.length;
  }, [fleet.scanned, fleet.agents.length]);

  const { closeCreate: navCloseCreate, createOnVolume } = nav;
  const closeCreate = useCallback(() => {
    setCreateOp(null);
    // A create that adopted a volume changed the inventory: the volume it took
    // is no longer loose, and the fleet's tombstone for it has to go.
    if (createOnVolume) volumes.refresh();
    navCloseCreate();
  }, [createOnVolume, volumes, navCloseCreate]);
  const startCreate = useCallback(
    (op: CreateOp) => {
      setCreateOp(op);
      fleet.markFresh(op.name);
      fleet.setOp(op.name, op.opId);
    },
    [fleet.markFresh, fleet.setOp],
  );

  /**
   * The drawer of an agent that is no longer in the fleet closes: a finished
   * destroy deletes the row (§6.7), and a hash naming an agent this fleet has
   * never had — a bookmark kept past a destroy, or a typed `#agent/lumne` —
   * would otherwise render no drawer at all but leave the hash sitting there,
   * so a reload came back to the same nothing. `shouldDeselect` waits for a
   * scan: before one, "not in `byName`" means "not read yet".
   */
  const { selected, closeAgent } = nav;
  useEffect(() => {
    if (!shouldDeselect(!scanning, selected, fleet.byName)) return;
    closeAgent();
  }, [scanning, selected, fleet.byName, closeAgent]);

  const toggleShortcuts = useCallback(() => setShortcutsOpen((v) => !v), []);
  useNavKeys({
    enabled: initialized && !wizardOpen,
    overlay: overlayRef,
    filterRef,
    toggleShortcuts,
    openInbox: setCenterOpenRef,
  });

  /**
   * §4.8: an unbound home gets the wizard, but a home that is merely *unchosen*
   * gets the picker (`FleetPicker`) — so the wizard is not raised while a
   * `fleet_error` is outstanding, and a switch out of that state lands on the
   * dashboard rather than on a wizard nobody opened.
   */
  const fleetError = fleet.meta?.fleet_error ?? null;
  useEffect(() => {
    if (fleet.meta !== null && !initialized && fleetError === null) setWizardOpen(true);
  }, [initialized, fleetError, fleet.meta]);

  /**
   * §4.8: `NavProvider` closes everything that names an agent on a fleet
   * switch; the volume inventory is per-fleet too, and it is on a poll of its
   * own. Without this the volumes lens and the loose-volume counts would
   * keep describing the fleet the operator just left, with no skeleton to say
   * they were stale.
   */
  const prevFleetId = useRef(fleetId);
  /** Each agent's last settled phase, for `settleVolumes` below; forgotten on a switch. */
  const settled = useRef<ReadonlyMap<string, SettledPhase> | null>(null);
  useEffect(() => {
    const previous = prevFleetId.current;
    prevFleetId.current = fleetId;
    if (previous === null || fleetId === null || previous === fleetId) return;
    settled.current = null;
    volumes.reset();
    destroyedAudit.reset();
  }, [fleetId, volumes.reset, destroyedAudit.reset]);

  /**
   * An op that can move a volume — destroy, create, recreate, stop, start —
   * re-reads the inventory when its agent comes to rest (`settleVolumes`), so
   * the Volumes view and the nav's loose-volume summary do not keep a destroyed
   * agent's volume attached until the next 30s poll.
   */
  const { refresh: refreshVolumes } = volumes;
  const { refresh: refreshDestroyed } = destroyedAudit;
  // Read through a ref: the lens changing is not a reason to re-settle.
  const onDestroyedLens = useRef(false);
  onDestroyedLens.current = nav.fleetLens === "destroyed";
  useEffect(() => {
    if (!fleet.scanned) return;
    const { next, changed } = settleVolumes(settled.current, fleet.agents);
    settled.current = next;
    if (!changed) return;
    refreshVolumes();
    // A destroy settling is a new tombstone; the lens reads again on entry anyway.
    if (onDestroyedLens.current) refreshDestroyed();
  }, [fleet.scanned, fleet.agents, refreshVolumes, refreshDestroyed]);

  const region = fleet.meta?.config?.region ?? "—";
  const hint = emptyHint({ total: counts.total, query });
  /**
   * §8.3: an empty fleet with no ready profile is not "press New agent" — the
   * create drawer would open on a call-to-action instead of a form. Say so
   * here, where the operator already is, and offer the one useful next step.
   */
  const noReadyProfile = profiles.list !== null && readyProfiles(profiles.list).length === 0;
  /**
   * A fleet with no agents at all gets a big first step as well as the
   * toolbar's `+ New agent`, which is easy to miss on an otherwise blank page.
   * With no ready profile that first step is the provider instead.
   */
  const emptyAction =
    counts.total > 0 ? null : noReadyProfile ? (
      <button type="button" className="btn btn-primary" onClick={nav.setUpProvider}>
        Set up a provider →
      </button>
    ) : (
      <button type="button" className="btn btn-primary empty-first-agent" onClick={nav.openCreate}>
        Create your first agent →
      </button>
    );
  const help = shortcutsOpen ? (
    <ShortcutsPopover anchor={shortcutsAnchor} onClose={() => setShortcutsOpen(false)} />
  ) : null;

  /**
   * §4.9's three surfaces, built once and dropped into every branch beside
   * `help`. The bell and the centre hang off the header, which every branch
   * draws; the toast stack is fixed to the viewport and belongs to the page
   * rather than to any one view, so an op that finishes while Settings is open
   * still says so.
   */
  const bell = notify ? (
    <Bell
      unread={notify.unread}
      needsAction={notify.needsAction}
      open={notifyOpen}
      onToggle={() => notify.setCenterOpen(!notifyOpen)}
      triggerRef={bellAnchor}
    />
  ) : null;
  const inbox =
    notify === null ? null : (
      <>
        {notifyOpen ? (
          <NotificationCenter
            anchor={bellAnchor}
            onClose={() => notify.setCenterOpen(false)}
            onOpenAgent={nav.openAgent}
            onOpenSettings={nav.openSettings}
          />
        ) : null}
        <Toasts onOpenAgent={nav.openAgent} />
      </>
    );
  /**
   * `FLEET | CHAT | SETTINGS`, drawn inside the header on every screen that has
   * views to move between — Settings included, so leaving it is the same click
   * as arriving.
   */
  const viewNav = (
    <ViewNav
      view={nav.view}
      onView={nav.setView}
      agentCount={counts.total}
      agentCountKnown={!scanning}
      summary={volumes.summary}
    />
  );
  const footer = (
    <Footer
      lastPollAt={fleet.lastPollAt}
      connected={fleet.connected}
      everConnected={fleet.everConnected}
      retryAt={fleet.retryAt}
      scanError={fleet.scanError}
      volumesReadAt={volumes.readAt}
      volumesBusy={vscan.busy || vscan.skeleton}
      volumesError={volumes.error}
      shortcutsRef={shortcutsAnchor}
      onShortcuts={() => setShortcutsOpen((v) => !v)}
      update={<AppUpdateNotice />}
    />
  );
  const createDrawer = nav.createOpen ? (
    <CreateDrawer
      meta={fleet.meta}
      names={names}
      latest={fleet.latest}
      tailnet={fleet.tailnet}
      active={createOp}
      profiles={profiles}
      onVolume={nav.createOnVolume}
      onStart={startCreate}
      onClose={closeCreate}
    />
  ) : null;

  if (fleet.meta === null) {
    return (
      <div className="app">
        <Header />
        <div className="empty" role={fleet.metaError ? "alert" : "status"}>
          <b>{fleet.metaError ? "Could not connect" : "Connecting"}</b>
          <div className="mono hint">{fleet.metaError ?? "Reading the fleet target…"}</div>
          {fleet.metaError ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={fleet.metaLoading}
              onClick={() => void fleet.refreshMeta()}
            >
              Retry
            </button>
          ) : null}
        </div>
        {help}
        {inbox}
      </div>
    );
  }

  /**
   * §4.8's picker, above the wizard and below everything else: the server has
   * no fleet open, but this home has fleets. Offer the choice rather than
   * `init`. The header is drawn without its view nav, and the env strip without
   * its fleet switcher, because there is no target for either to describe yet —
   * the list below is the only thing on this screen that can name one.
   */
  if (!initialized && fleetError !== null && !wizardOpen) {
    return (
      <div className="app">
        <Header bell={bell} />
        <EnvStrip meta={fleet.meta} connected={fleet.connected} />
        <FleetPicker meta={fleet.meta} onSetUpNewFleet={() => setWizardOpen(true)} />
        {help}
        {inbox}
      </div>
    );
  }

  // Nothing below the header means anything until this home is bound (§4.7).
  if (!initialized || wizardOpen) {
    return (
      <div className="app">
        <Header bell={bell} />
        <EnvStrip meta={fleet.meta} connected={fleet.connected} switcher={false} />
        <InitWizard
          meta={fleet.meta}
          onOpenFleet={() => {
            fleet.resync();
            setWizardOpen(false);
          }}
          onOpenReceipt={showReceipt}
        />
        {receiptOpen ? <LastTeardownReceipt onClose={() => setReceiptOpen(false)} /> : null}
        {help}
        {inbox}
      </div>
    );
  }

  if (nav.settingsOpen) {
    return (
      <div className="app">
        <Header nav={viewNav} bell={bell} />
        <EnvStrip
          meta={fleet.meta}
          connected={fleet.connected}
          onOpenFoundation={() => nav.setFoundationUpdateOpen(true)}
        />
        <Settings key={fleetIdentity} meta={fleet.meta} profiles={profiles} />
        {nav.foundationUpdateOpen ? (
          <FoundationUpdateDrawer
            meta={fleet.meta}
            onClose={() => nav.setFoundationUpdateOpen(false)}
          />
        ) : null}
        {nav.foundationTeardownOpen ? (
          <TeardownDrawer
            meta={fleet.meta}
            agents={fleet.agents}
            onClose={() => nav.setFoundationTeardownOpen(false)}
            onGoToFleet={() => {
              nav.setFoundationTeardownOpen(false);
              nav.closeSettings();
            }}
            onFinished={showReceipt}
          />
        ) : null}
        {receiptOpen ? <LastTeardownReceipt onClose={() => setReceiptOpen(false)} /> : null}
        {help}
        {inbox}
      </div>
    );
  }

  const chrome = (
    <>
      <Header nav={viewNav} bell={bell} />
      <EnvStrip
        meta={fleet.meta}
        connected={fleet.connected}
        onOpenFoundation={() => nav.openSettings("foundation")}
      />
    </>
  );

  if (nav.chatOpen) {
    return (
      <div className="app">
        {chrome}
        <ChatView />
        {footer}
        {help}
        {inbox}
      </div>
    );
  }

  return (
    <div className="app">
      {chrome}
      {/*
        §6.6: between the nav and the counts, so it is read before any number
        under it. Nothing renders when the fleet and this build agree.
      */}
      <SkewBand
        status={fleet.meta?.foundation}
        fleetId={fleetId}
        onFix={() => nav.openSettings("foundation")}
        onDetails={() => nav.openSettings("foundation")}
      />
      <ListeningNotice
        instances={fleet.agents
          .filter((agent) => agent.status !== "destroyed")
          .map((agent) => agent.name)}
      />
      <Toolbar
        region={region}
        lens={nav.fleetLens}
        onLens={nav.setFleetLens}
        counts={counts}
        volumes={volumes.volumes}
        volumeSummary={volumes.summary}
        volumesRead={volumes.hasRead}
        volumeScan={vscan}
        onRefreshVolumes={volumes.refresh}
        onNewAgent={nav.openCreate}
        query={query}
        onQuery={setQuery}
        layout={layout}
        onLayout={setLayout}
        destroyedCount={destroyedAudit.tombstones?.length ?? null}
        destroyedBusy={destroyedAudit.loading}
        onRefreshDestroyed={destroyedAudit.refresh}
        sort={sort}
        onClearSort={() => setSort(null)}
        showVolumes={showVolumes}
        onShowVolumes={setShowVolumes}
        scanning={scanning}
        filterRef={filterRef}
      />

      {nav.fleetLens === "destroyed" ? (
        <DestroyedView audit={destroyedAudit} query={query} onClearQuery={() => setQuery("")} />
      ) : nav.fleetLens === "volumes" ? (
        /*
         * §9's inventory, under the fleet's own toolbar. It has its own read
         * state (`vscan`), so it never waits on the instance scan above.
         */
        <VolumesView
          volumes={volumes.volumes}
          summary={volumes.summary}
          error={volumes.error}
          region={fleet.meta?.config?.region ?? null}
          scan={vscan}
          query={query}
          onClearQuery={() => setQuery("")}
          onCreate={nav.openCreateOnVolume}
          onDelete={nav.setDeleteVolume}
          onGoToAgent={nav.openAgent}
        />
      ) : phase !== "ready" ? (
        <FleetSkeleton
          phase={phase}
          layout={layout}
          scanError={fleet.scanError}
          remembered={lastCount.current}
          onRetry={fleet.resync}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          hint={
            noReadyProfile && counts.total === 0 ? `${hint} · no provider profile is ready yet` : hint
          }
          action={emptyAction}
        />
      ) : layout === "table" ? (
        <FleetTable
          agents={visible}
          latest={fleet.latest}
          foundation={fleet.meta?.foundation}
          tailnet={fleet.tailnet}
          fleetId={fleetId}
          fresh={fleet.fresh}
          volumes={fleetVolumes}
          selected={nav.selected}
          sort={sort}
          onSort={onSort}
          onSelect={nav.select}
          onCreateOnVolume={nav.openCreateOnVolume}
          onSeeVolumes={nav.openVolumes}
        />
      ) : layout === "board" ? (
        <FleetBoard
          agents={visible}
          latest={fleet.latest}
          tailnet={fleet.tailnet}
          fleetId={fleetId}
          volumes={fleetVolumes}
          onSelect={nav.select}
          onCreateOnVolume={nav.openCreateOnVolume}
          onSeeVolumes={nav.openVolumes}
        />
      ) : (
        <FleetTriage
          groups={groups}
          latest={fleet.latest}
          tailnet={fleet.tailnet}
          fleetId={fleetId}
          selected={nav.selected}
          agents={visible}
          volumes={fleetVolumes}
          onSelect={nav.select}
          onCreateOnVolume={nav.openCreateOnVolume}
          onSeeVolumes={nav.openVolumes}
        />
      )}

      {footer}
      {createDrawer}
      {nav.deleteVolume ? (
        <VolumeDeleteDrawer
          volume={nav.deleteVolume}
          onClose={() => nav.setDeleteVolume(null)}
          onDeleted={() => {
            nav.setDeleteVolume(null);
            volumes.refresh();
          }}
        />
      ) : null}

      {agent ? (
        <AgentDrawer
          key={`${fleetIdentity}:${agent.name}`}
          agent={agent}
          chatInitiallyOpen={chatEntry?.drawerTarget?.instance === agent.name}
          meta={fleet.meta}
          latest={fleet.latest}
          tailnet={fleet.tailnet}
          profiles={profiles}
          runningOpId={fleet.opsByAgent[agent.name] ?? null}
          onOp={fleet.setOp}
          onClose={() => {
            chatEntry?.closeDrawer();
            nav.closeAgent();
          }}
          confirmOpen={nav.teardownOpen}
          setConfirmOpen={nav.setTeardownOpen}
          tab={nav.agentTab}
          onTab={nav.setAgentTab}
          /*
           * Anything raised over the drawer suspends the Desktop tab's stream.
           * The drawer stays mounted underneath these, so without this the RFB
           * session keeps running — and keeps the agent's screen live — behind
           * a Settings pane the operator may sit in for minutes.
           */
          covered={
            nav.settingsOpen ||
            nav.createOpen ||
            wizardOpen ||
            nav.foundationTeardownOpen ||
            nav.foundationUpdateOpen
          }
        />
      ) : null}
      {help}
      {inbox}
    </div>
  );
}
