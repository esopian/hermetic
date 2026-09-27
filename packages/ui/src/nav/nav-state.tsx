/**
 * Where the operator is.
 *
 * One provider for everything on this page that is a *place* rather than data:
 * which full-page view is up (the fleet on one of its two lenses, Settings on
 * a section, Chat), which agent's drawer is open and on which tab, whether the
 * create drawer is up and on which volume, and the handful of overlays raised
 * over those. The
 * fleet, the ops and the inbox stay in their own contexts (`FleetContext`,
 * `NotifyContext`, `ListeningContext`); this one never reads them for data,
 * only to react to a fleet switch or a home going uninitialized.
 *
 * It is also the single hash writer. The spelling lives in `agent-nav.ts`,
 * `fleet-nav.ts` and `settings-nav.ts` (pure, DOM-free); this module owns the
 * state and the two effects that round-trip it through `window.location.hash`,
 * so a drawer or a section survives a reload and back/forward moves through
 * them.
 *
 * Every component under `App` reads it with `useNav()` instead of taking the
 * same dozen callbacks as props, and a test renders one with `NavProvider`
 * around the component (`packages/ui/test/nav.tsx`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { fleetIdOf, isInitialized } from "../api/index.ts";
import type { VolumeView } from "../api/index.ts";
import { DEFAULT_AGENT_TAB, agentHash, parseAgentHash } from "./agent-nav.ts";
import type { AgentTab } from "./agent-nav.ts";
import { FLEET_VOLUMES_HASH, LEGACY_VOLUMES_HASH, parseFleetLensHash } from "./fleet-nav.ts";
import type { FleetLens } from "./fleet-nav.ts";
import { useChatEntry } from "../chat/chat-entry-state.tsx";
import { isChatHash } from "../chat/chat-routing.ts";
import type { View } from "../components/ViewNav.tsx";
import { hasOpenOverlay } from "../lib/focus.ts";
import { DEFAULT_SETTINGS_SECTION, parseSettingsHash, settingsHash } from "./settings-nav.ts";
import type { SettingsSection } from "./settings-nav.ts";
import { shortcutAllowed } from "./shortcuts.ts";
import type { OverlayState } from "./shortcuts.ts";
import { useFleetIfAvailable } from "../state/state.tsx";

export interface Nav {
  /**
   * The full-page view on screen, by the priority `App` draws them in:
   * Settings over Chat over the fleet. Settings wins because it is the older
   * contract and `#settings` is what the header links to.
   */
  view: View;
  settingsOpen: boolean;
  chatOpen: boolean;
  /**
   * Which half of the fleet page is up (`#fleet/volumes` for the volumes lens).
   * A lens, not a view: it replaces nothing, Escape never closes it, and it is
   * kept while Settings or Chat is up so coming back lands where the operator was.
   */
  fleetLens: FleetLens;
  setFleetLens: (lens: FleetLens) => void;
  /** Settings' second axis (`#settings/<section>`). */
  settingsSection: SettingsSection;
  /**
   * Open Settings. With a section, both halves move together so the hash
   * writer spells `#settings/foundation` in one step instead of flashing the
   * last section; without one, Settings opens on whatever section it was on.
   */
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  /**
   * Settings' own "← Fleet": closes it, drops a pending Providers detour, and
   * reopens the create drawer that sent the operator there (§8.3), so they
   * land back on their saved draft rather than on a fleet they have to search.
   */
  backFromSettings: () => void;
  /** `ViewNav`'s tabs: the fleet and Chat replace each other, Settings opens over both. */
  setView: (view: View) => void;
  /**
   * The fleet's volumes lens, from anywhere — a tombstone's "+ N more", a
   * notification. Leaves Settings and Chat, since the lens is on the fleet page.
   */
  openVolumes: () => void;
  /**
   * Escape's fall-through once no overlay consumed it: the topmost view goes,
   * Settings before Chat. The fleet's lens is never closed by it.
   */
  closeView: () => void;

  /** Which agent's drawer is open (`#agent/<name>`), and on which tab. */
  selected: string | null;
  agentTab: AgentTab;
  setAgentTab: (tab: AgentTab) => void;
  /** The drawer's destroy confirm, owned here so a change of agent resets it. */
  teardownOpen: boolean;
  setTeardownOpen: (open: boolean) => void;
  /** Open an agent from the board: always on Overview, never on the last one's tab. */
  select: (name: string) => void;
  /**
   * Open an agent from anywhere — a notification's action, the volumes lens's
   * "go to agent". The drawer belongs to the fleet's agents lens, so this
   * leaves whichever view is up and puts the fleet back on its agents.
   */
  openAgent: (name: string) => void;
  closeAgent: () => void;

  createOpen: boolean;
  /** The volume a create drawer was opened *onto*, if any (§9's reclaim path). */
  createOnVolume: VolumeView | null;
  openCreate: () => void;
  openCreateOnVolume: (volume: VolumeView) => void;
  closeCreate: () => void;
  /**
   * The create drawer's "Set up a provider" (§8.3): close it (the form is
   * already in `sessionStorage`), open Settings on Providers with the
   * New-profile drawer up, and remember to come back.
   */
  setUpProvider: () => void;
  /**
   * The create drawer's "Edit presets →" (§4.6): the same detour, onto
   * Settings › Create presets. The drawer has already saved its draft.
   */
  editPresets: () => void;
  /** Providers should open its New-profile drawer the moment it mounts. */
  providersNew: boolean;
  /** Providers has acted on `providersNew`; a later visit is a plain one. */
  providersNewHandled: () => void;

  /** The env strip's fleet-switcher popover (`FleetMenu.tsx`). */
  popoverOpen: boolean;
  setPopoverOpen: (open: boolean) => void;

  /** §4.6's foundation teardown, raised from Settings' Danger section. */
  foundationTeardownOpen: boolean;
  setFoundationTeardownOpen: (open: boolean) => void;
  /** §6.6's update drawer, raised from Settings (or the EnvStrip pill, via Settings). */
  foundationUpdateOpen: boolean;
  setFoundationUpdateOpen: (open: boolean) => void;

  /** The volumes lens's delete confirm. */
  deleteVolume: VolumeView | null;
  setDeleteVolume: (volume: VolumeView | null) => void;
}

const NavContext = createContext<Nav | null>(null);

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

export function NavProvider({
  children,
  onOpenCreate,
}: {
  children: ReactNode;
  /**
   * Runs on every `openCreate` (not on the reclaim path): `App` re-reads the
   * provider profiles here (§8.3), because readiness is checked every time
   * the drawer opens rather than once per page.
   */
  onOpenCreate?: () => void;
}) {
  const fleet = useFleetIfAvailable();
  const chatEntry = useChatEntry();
  const initialized = fleet !== null && fleet.meta !== null && isInitialized(fleet.meta);

  /**
   * Which agent's drawer is open, and on which of its two tabs. Both come out
   * of the hash (`#agent/<name>`, `#agent/<name>/desktop`) and both are written
   * back to it by the one writer below, so a drawer survives a reload and can
   * be linked to — including straight onto the agent's screen.
   */
  const [selected, setSelected] = useState<string | null>(
    () => parseAgentHash(currentHash())?.name ?? null,
  );
  const [agentTab, setAgentTab] = useState<AgentTab>(
    () => parseAgentHash(currentHash())?.tab ?? DEFAULT_AGENT_TAB,
  );
  const [teardownOpen, setTeardownOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createOnVolume, setCreateOnVolume] = useState<VolumeView | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Settings is a full-page view, not a drawer; `#settings` lets it survive a
  // reload the same way a bookmarked URL would.
  const [settingsOpen, setSettingsOpen] = useState(() => parseSettingsHash(currentHash()) !== null);
  /**
   * Settings' second axis: which section of it is open (`#settings/providers`).
   * Held here rather than in the view so the one hash writer below can spell
   * both halves of the URL, and so `hashchange` — back/forward, or a link
   * pasted into the bar — moves the section as well as the view.
   */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    () => parseSettingsHash(currentHash()) ?? DEFAULT_SETTINGS_SECTION,
  );
  /**
   * §9's volume inventory, as the fleet's second lens. Hash-addressed
   * (`#fleet/volumes`) so a reload or a bookmark lands back on it; a Settings
   * or Chat hash says nothing about it, so a cold start there is on agents.
   */
  const [fleetLens, setFleetLens] = useState<FleetLens>(
    () => parseFleetLensHash(currentHash()) ?? "agents",
  );
  /** Chat frame visibility is independent of its persistent, fleet-keyed store. */
  const [chatOpen, setChatOpen] = useState(() => isChatHash(currentHash()));
  const [deleteVolume, setDeleteVolume] = useState<VolumeView | null>(null);
  const [foundationTeardownOpen, setFoundationTeardownOpen] = useState(false);
  const [foundationUpdateOpen, setFoundationUpdateOpen] = useState(false);
  /**
   * §8.3: open Providers' New-profile drawer the moment Settings mounts. Set
   * only by the create drawer's "Set up a provider", and cleared by the section
   * as soon as it has acted on it, so a later visit to Settings is a plain one.
   */
  const [providersNew, setProvidersNew] = useState(false);
  /**
   * The create drawer that sent an operator to Providers, so leaving Settings
   * puts it back rather than dropping them on the fleet with a saved draft they
   * have to go and find.
   */
  const [returnToCreate, setReturnToCreate] = useState(false);

  // Read through a ref so `openCreate` is stable however often `App` re-renders.
  const onOpenCreateRef = useRef(onOpenCreate);
  onOpenCreateRef.current = onOpenCreate;

  const openCreate = useCallback(() => {
    // `n` is refused while Settings is up (`shortcutAllowed`), so the only
    // caller that reaches this with Settings open is Settings' own header.
    setSettingsOpen(false);
    setSelected(null);
    setTeardownOpen(false);
    setPopoverOpen(false);
    setCreateOnVolume(null);
    setCreateOpen(true);
    onOpenCreateRef.current?.();
  }, []);

  /**
   * The reclaim path (§9): the same create drawer, with the volume locked. It
   * is the *only* difference — one create path, one op, one progress rail.
   */
  const openCreateOnVolume = useCallback((v: VolumeView) => {
    setSelected(null);
    setTeardownOpen(false);
    setPopoverOpen(false);
    setCreateOnVolume(v);
    setCreateOpen(true);
  }, []);

  const closeCreate = useCallback(() => {
    setCreateOpen(false);
    setCreateOnVolume(null);
  }, []);

  const setUpProvider = useCallback(() => {
    setCreateOpen(false);
    setReturnToCreate(true);
    setProvidersNew(true);
    setSettingsSection("providers");
    setSettingsOpen(true);
  }, []);

  const editPresets = useCallback(() => {
    setCreateOpen(false);
    setReturnToCreate(true);
    setSettingsSection("presets");
    setSettingsOpen(true);
  }, []);

  const providersNewHandled = useCallback(() => setProvidersNew(false), []);

  const openSettings = useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const backFromSettings = useCallback(() => {
    setSettingsOpen(false);
    setProvidersNew(false);
    if (returnToCreate) {
      setReturnToCreate(false);
      openCreate();
    }
  }, [returnToCreate, openCreate]);

  /**
   * The header's `FLEET | CHAT | SETTINGS`. Settings is drawn under the same
   * nav, so leaving it is this call too, not only `backFromSettings`: choosing
   * Fleet or Chat has to close it, or the page keeps rendering Settings
   * whatever was clicked. A pending "New profile" detour is dropped with it.
   */
  const setView = useCallback((v: View) => {
    setChatOpen(v === "chat");
    setSettingsOpen(v === "settings");
    if (v !== "settings") setProvidersNew(false);
  }, []);
  const openVolumes = useCallback(() => {
    setSettingsOpen(false);
    setChatOpen(false);
    // The drawer belongs to the agents lens; see the hash writer below.
    setSelected(null);
    setTeardownOpen(false);
    setFleetLens("volumes");
  }, []);
  /** The toolbar's `N AGENTS | N VOLUMES` switch. */
  const chooseFleetLens = useCallback(
    (lens: FleetLens) => (lens === "volumes" ? openVolumes() : setFleetLens("agents")),
    [openVolumes],
  );

  // Read through a ref: Escape reaches this from a window listener that `App`
  // registers once, so the callback has to stay stable and still see live state.
  const views = useRef({ settingsOpen, chatOpen });
  views.current = { settingsOpen, chatOpen };
  const closeView = useCallback(() => {
    const v = views.current;
    if (v.settingsOpen) setSettingsOpen(false);
    else if (v.chatOpen) setChatOpen(false);
  }, []);

  const select = useCallback((name: string) => {
    setSelected(name);
    // Opening an agent from the board always lands on Overview: the Desktop tab
    // is a live stream, so it is somewhere an operator goes deliberately (by
    // pressing the tab, or by following a `#agent/<name>/desktop` link) and
    // never somewhere the last agent's tab carries them.
    setAgentTab(DEFAULT_AGENT_TAB);
    setTeardownOpen(false);
    setPopoverOpen(false);
  }, []);
  const openAgent = useCallback(
    (name: string) => {
      setSettingsOpen(false);
      setChatOpen(false);
      setFleetLens("agents");
      select(name);
    },
    [select],
  );
  const closeAgent = useCallback(() => {
    setSelected(null);
    setTeardownOpen(false);
  }, []);

  /**
   * Chat's drawer destination, which opens the agent drawer over whatever else
   * is on screen — and closes it again when chat lets the destination go.
   *
   * The close half only fires on a *transition*, never on the first run. The
   * drawer's other opener is the hash (`#agent/<name>`), read once at mount,
   * and an effect that cleared the selection whenever chat happened to have no
   * destination would undo that link on every cold start.
   */
  const prevDrawerTarget = useRef(chatEntry?.drawerTarget ?? null);
  useEffect(() => {
    const previous = prevDrawerTarget.current;
    prevDrawerTarget.current = chatEntry?.drawerTarget ?? null;
    if (chatEntry?.drawerTarget) {
      setSelected(chatEntry.drawerTarget.instance);
      setSettingsOpen(false);
      setFleetLens("agents");
      setChatOpen(false);
    } else if (previous) {
      setSelected(null);
      setTeardownOpen(false);
    }
  }, [chatEntry?.drawerTarget, chatEntry?.navigation]);

  // `#settings` is the URL for the Settings view: reload lands back on it, and
  // back/forward toggles it like any other hash-addressed page.
  useEffect(() => {
    const onHashChange = () => {
      // An old `#volumes` link (a bookmark, a pasted URL) is the volumes lens
      // now; respell it in place so back does not step through the old name.
      if (window.location.hash === LEGACY_VOLUMES_HASH) redirectLegacyVolumesHash();
      const section = parseSettingsHash(window.location.hash);
      setSettingsOpen(section !== null);
      // Only when the hash names Settings: leaving for the fleet must not
      // reset which section is open underneath, so coming back lands where it
      // left off rather than on Account.
      if (section !== null) setSettingsSection(section);
      // The same rule for the lens: a Settings or Chat hash leaves it alone.
      const lens = parseFleetLensHash(window.location.hash);
      if (lens !== null) setFleetLens(lens);
      setChatOpen(isChatHash(window.location.hash));
      /*
       * The agent drawer, on the same rule and for the same reason: a hash that
       * names an agent opens it, on the tab it names, and only an *empty* hash
       * closes it. `#settings` and `#fleet/volumes` leave the selection alone —
       * opening Settings over a drawer writes the Settings hash, and taking
       * that as "no agent" would close the drawer as a side effect.
       */
      const route = parseAgentHash(window.location.hash);
      if (route) {
        setSelected(route.name);
        setAgentTab(route.tab);
        // Same reset `select()` does: back/forward onto another agent must not
        // land on the previous one's open teardown confirm, which names a
        // different agent and is a destructive step.
        setTeardownOpen(false);
      } else if (
        window.location.hash === "" ||
        window.location.hash === "#" ||
        // The drawer lives on the agents lens. Back from `#agent/<name>` to
        // `#fleet/volumes` has to close it, or the writer would push the
        // agent's hash straight back and trap the operator on it.
        lens === "volumes"
      ) {
        setSelected(null);
        setTeardownOpen(false);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Declared before the writer below so it runs first: a cold start on
  // `#volumes` is respelled in place, and the writer then has nothing to push.
  useEffect(() => {
    if (window.location.hash === LEGACY_VOLUMES_HASH) redirectLegacyVolumesHash();
  }, []);

  useEffect(() => {
    // An open drawer takes the fleet's hash over the lens: the drawer only
    // opens onto the agents lens (`openAgent`), so the two never disagree.
    const wants = settingsOpen
      ? settingsHash(settingsSection)
      : chatOpen
        ? isChatHash(window.location.hash)
          ? window.location.hash
          : "#chat"
        : selected
          ? agentHash(selected, agentTab)
          : fleetLens === "volumes"
            ? FLEET_VOLUMES_HASH
            : "";
    if (window.location.hash === wants) return;
    if (wants) {
      window.location.hash = wants;
    } else {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [settingsOpen, settingsSection, fleetLens, chatOpen, selected, agentTab]);

  /**
   * §4.8: a fleet switch replaces every agent on the board, so anything on
   * screen that names one has to go with them. An agent drawer would otherwise
   * sit open on a name the new fleet has never heard of, and a create drawer
   * would submit into a fleet the operator was not looking at when they
   * filled it in. Settings and the fleet's lens are addressed by hash, not by
   * agent, so they stay. (`App` resets the per-fleet volume inventory on the same edge.)
   */
  const fleetId = fleetIdOf(fleet?.meta ?? null);
  const prevFleetId = useRef(fleetId);
  useEffect(() => {
    const previous = prevFleetId.current;
    prevFleetId.current = fleetId;
    if (previous === null || fleetId === null || previous === fleetId) return;
    setSelected(null);
    setTeardownOpen(false);
    setCreateOpen(false);
    setCreateOnVolume(null);
    setDeleteVolume(null);
    setFoundationTeardownOpen(false);
    setFoundationUpdateOpen(false);
    setPopoverOpen(false);
  }, [fleetId]);

  // A foundation teardown with `reset_local` flips this home back to
  // uninitialized; Settings has nothing to show once that happens, so it
  // steps aside for the wizard rather than reappearing empty after the next
  // `init`.
  const bound = fleet !== null && fleet.meta !== null;
  useEffect(() => {
    if (bound && !initialized) {
      setSettingsOpen(false);
      setFleetLens("agents");
      setFoundationTeardownOpen(false);
      setFoundationUpdateOpen(false);
    }
  }, [initialized, bound]);

  const view: View = settingsOpen ? "settings" : chatOpen ? "chat" : "fleet";

  const value = useMemo<Nav>(
    () => ({
      view,
      settingsOpen,
      chatOpen,
      fleetLens,
      setFleetLens: chooseFleetLens,
      settingsSection,
      openSettings,
      closeSettings,
      setSettingsSection,
      backFromSettings,
      setView,
      openVolumes,
      closeView,
      selected,
      agentTab,
      setAgentTab,
      teardownOpen,
      setTeardownOpen,
      select,
      openAgent,
      closeAgent,
      createOpen,
      createOnVolume,
      openCreate,
      openCreateOnVolume,
      closeCreate,
      setUpProvider,
      editPresets,
      providersNew,
      providersNewHandled,
      popoverOpen,
      setPopoverOpen,
      foundationTeardownOpen,
      setFoundationTeardownOpen,
      foundationUpdateOpen,
      setFoundationUpdateOpen,
      deleteVolume,
      setDeleteVolume,
    }),
    [
      view,
      settingsOpen,
      chatOpen,
      fleetLens,
      settingsSection,
      openSettings,
      closeSettings,
      backFromSettings,
      setView,
      openVolumes,
      closeView,
      selected,
      agentTab,
      teardownOpen,
      select,
      openAgent,
      closeAgent,
      createOpen,
      createOnVolume,
      openCreate,
      openCreateOnVolume,
      closeCreate,
      setUpProvider,
      editPresets,
      providersNew,
      providersNewHandled,
      popoverOpen,
      foundationTeardownOpen,
      foundationUpdateOpen,
      deleteVolume,
    ],
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

/** Respell `#volumes` as `#fleet/volumes` without adding a history entry. */
function redirectLegacyVolumesHash(): void {
  history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${FLEET_VOLUMES_HASH}`,
  );
}

export function useNav(): Nav {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav must be used inside <NavProvider>");
  return ctx;
}

/**
 * The page's keyboard shortcuts (`shortcuts.ts`), as one window listener.
 *
 * Registered once: everything it reads that changes per render comes through
 * a ref, so an Esc and an `n` landing in the same frame both see live overlay
 * state instead of the closure from whichever render last re-subscribed.
 */
export function useNavKeys({
  enabled,
  overlay,
  filterRef,
  toggleShortcuts,
  openInbox,
}: {
  /** Nothing but `?` fires before this home is bound, or while the wizard is up. */
  enabled: boolean;
  /** Everything the shell can draw over the fleet, live. */
  overlay: RefObject<OverlayState>;
  /** The fleet's filter input, which `/` focuses. */
  filterRef: RefObject<HTMLInputElement | null>;
  /** The `?` sheet. Toggles, so `?` closes it as well as opening it. */
  toggleShortcuts: () => void;
  /** Opens the notification centre; `null` where this tree has no inbox. */
  openInbox: RefObject<((open: boolean) => void) | null>;
}): void {
  const { openCreate, openSettings, closeView } = useNav();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.shiftKey && e.key !== "?")
      )
        return;
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true ||
        !!target?.closest('[contenteditable]:not([contenteditable="false"])');

      if (e.key === "Escape") {
        // Overlay Escape is consumed by focus.ts before it reaches the shell.
        if (hasOpenOverlay()) return;
        closeView();
        return;
      }
      if (typing) return;
      if (e.key !== "?" && (hasOpenOverlay() || !enabled)) return;
      // View-specific eligibility follows the shared overlay gate above.
      if (!shortcutAllowed(e.key, overlay.current)) return;
      // The one shortcut that is about the shortcuts. `shortcutAllowed` lets
      // it through an open overlay on purpose: it is the thing an operator
      // reaches for *because* they are stuck in one, and the sheet is itself
      // a focus trap.
      if (e.key === "?") {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (e.key === "n") {
        e.preventDefault();
        openCreate();
      }
      // `i` for inbox (§4.9): `n` is already the create drawer, so the bell
      // gets a different letter. It opens only — the centre is an
      // overlay, so `shortcutAllowed` refuses a second press, and Esc is what
      // closes it, exactly like every other popover on this page.
      if (e.key === "i") {
        e.preventDefault();
        openInbox.current?.(true);
      }
      if (e.key === ",") {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCreate, openSettings, closeView, enabled, overlay, filterRef, toggleShortcuts, openInbox]);
}
