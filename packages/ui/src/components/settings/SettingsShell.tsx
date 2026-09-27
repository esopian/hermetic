/**
 * Settings: a left rail of sections and one section at a time.
 *
 * It was one long scroll. It is now a page per section, for a reason that is
 * not tidiness: each section's data is its own network read — `doctor` walks
 * EC2 and the tailnet, the policy card reaches api.tailscale.com through the
 * server, the run log hits SQLite — and a scroll made every one of them happen
 * because somebody wanted to see the account id. Rendering one section means a
 * read happens when the section it belongs to is opened, and the mounting does
 * the deciding: no section here has a "should I load" flag.
 *
 * The section is App state and lives in the hash (`settings-nav.ts`), so it is
 * linkable and survives a reload; `ViewNav`'s `View` gains no member, because
 * Settings is still one view.
 */
import { useCallback, useEffect, useState } from "react";
import { getSettings } from "../../api/index.ts";
import type { Meta, SettingsResult } from "../../api/index.ts";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, settingsHash } from "../../nav/settings-nav.ts";
import { useNav } from "../../nav/nav-state.tsx";
import { nextSettings } from "../../logic/settings-logic.ts";
import type { DefaultsForm } from "../../logic/settings-logic.ts";
import type { SettingsSection } from "../../nav/settings-nav.ts";
import { useFleet, useFleetIfAvailable } from "../../state/state.tsx";
import type { ProfilesState } from "../../state/state.tsx";
import { ChatSection } from "./ChatSection.tsx";
import { AccountSection } from "./AccountSection.tsx";
import { DangerSection } from "./DangerSection.tsx";
import { DefaultsSection, defaultsDraftDirty } from "./DefaultsSection.tsx";
import { railStatus } from "./rail-status.ts";
import type { RailStatus } from "./rail-status.ts";
import type { SeededDraft } from "./seeded.ts";
import { SettingsFleetContext, Sq } from "./Section.tsx";
import { DiagnosticsSection } from "./DiagnosticsSection.tsx";
import { FoundationSection } from "./FoundationSection.tsx";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { PolicySection } from "./PolicySection.tsx";
import { PresetsSection } from "./PresetsSection.tsx";
import { useHeldPresets } from "../../state/presets-store.ts";
import { ProvidersSection } from "./ProvidersSection.tsx";
import { RunsSection } from "./RunsSection.tsx";
import { SecretsSection } from "./SecretsSection.tsx";

export interface SettingsProps {
  meta: Meta | null;
  /**
   * §8.3's profiles, read once by `App` and shared: Providers lists them,
   * Fleet defaults picks the default out of them, and the create drawer offers
   * the ready ones. One read, one refresh, one answer on the page.
   */
  profiles: ProfilesState;
  /**
   * Open Providers' New-profile drawer as soon as the section mounts — the
   * create drawer's "Set up a provider" detour, which sends an operator here to
   * do exactly one thing.
   */
  providersNew?: boolean;
  onProvidersNewHandled?: () => void;
  /** Which section is open. Owned by `App` so it can round-trip through the hash. */
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  onOpenTeardown: () => void;
  /** Raises `FoundationUpdateDrawer`; owned by the app shell, like the teardown one. */
  onOpenFoundationUpdate: () => void;
}

function RailItem({
  id,
  label,
  active,
  danger,
  status,
  onSection,
}: {
  id: SettingsSection;
  label: string;
  active: boolean;
  danger: boolean;
  status: RailStatus | undefined;
  onSection: (section: SettingsSection) => void;
}) {
  const cls = ["st-ri"];
  if (danger) cls.push("st-ri-d");
  if (active) cls.push("on");
  return (
    // A real `href`, not a button: a section is a URL, so "copy link" and
    // middle-click have to work. The click is still intercepted, because
    // `App` owns the state and writes the hash from it.
    <a
      href={settingsHash(id)}
      className={cls.join(" ")}
      aria-current={active ? "page" : undefined}
      data-rail={id}
      onClick={(e) => {
        e.preventDefault();
        onSection(id);
      }}
    >
      {/* The square slot is always there, blank when the section has no
          health to report, so every label starts at the same x. Decorative:
          its meaning is the tooltip, and the page itself says it in words. */}
      <Sq tone={status?.tone ?? "none"} title={status?.hint} />
      <span className="st-ri-l">{label}</span>
      <em>{status?.meta ?? ""}</em>
    </a>
  );
}

function Rail({
  section,
  onSection,
  onBack,
  fleetId,
  status,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  fleetId: string | null;
  status: Partial<Record<SettingsSection, RailStatus>>;
}) {
  const item = (s: (typeof SETTINGS_SECTIONS)[number]) => (
    <RailItem
      key={s.id}
      id={s.id}
      label={s.label}
      active={s.id === section}
      danger={"tone" in s && s.tone === "danger"}
      status={status[s.id]}
      onSection={onSection}
    />
  );
  return (
    <nav className="st-rail" aria-label="Settings sections">
      <button type="button" className="st-back" onClick={onBack}>
        ← Fleet
      </button>
      {SETTINGS_GROUPS.filter((g) => g.id !== "danger").map((g) => (
        <div key={g.id} className="st-rg" role="group" aria-label={g.label}>
          <div className="st-rgh" aria-hidden="true">
            <span>{g.label}</span>
            {g.id === "fleet" && fleetId !== null ? <span className="mono">{fleetId}</span> : null}
          </div>
          {SETTINGS_SECTIONS.filter((s) => s.group === g.id).map(item)}
        </div>
      ))}
      {/* Danger alone at the foot, under a rule: it is not a group of settings
          but the way out of the whole fleet. */}
      <div className="st-rdanger">
        {SETTINGS_SECTIONS.filter((s) => s.group === "danger").map(item)}
      </div>
    </nav>
  );
}

/**
 * The view without its data source, so a test can render any section from a
 * plain `Meta` instead of standing up a `FleetProvider` and four fetches.
 */
export function SettingsShell({
  meta,
  profiles,
  providersNew = false,
  onProvidersNewHandled,
  section,
  onSection,
  onBack,
  onOpenTeardown,
  onOpenFoundationUpdate,
}: SettingsProps) {
  const config = meta?.config ?? null;

  /**
   * One settings document for the whole view, not one per section.
   *
   * Defaults, Providers and Secrets all write to the same `_fleet` item and
   * every write bumps `settings.version`. Held per-section, that version died
   * on unmount: save in Fleet defaults, click Providers, save — and the second
   * write carries the version the *page* loaded with, which the store has
   * already moved past. That is a `CONFLICT` this laptop caused itself.
   *
   * So a save hands its response up here (`nextSettings` picks the newer of the
   * two, since two saves can land out of order) and every section reads from
   * the same place. `saved` is seeded from `/api/meta`'s copy and refreshed by
   * `reload`, which is also what the save bar's Reload button reaches.
   */
  const [saved, setSaved] = useState<SettingsResult | null>(null);
  const settings = saved ?? meta?.settings ?? null;
  const onSaved = useCallback((result: SettingsResult) => {
    setSaved((current) => nextSettings(current, result));
  }, []);
  /** Rejects on failure: each section renders its own error rather than swallowing one. */
  const refreshSettings = useCallback(async () => {
    setSaved(await getSettings());
  }, []);

  /**
   * Fleet defaults' staged edits, held here rather than in the form so they
   * outlive the section: open Providers to check a model name, come back, and
   * the draft is still on the bar. The rail marks Defaults while it is dirty.
   * A fleet switch remounts this whole shell (`App` keys it on the fleet), so a
   * draft never follows the operator onto another fleet.
   */
  const defaultsDraft = useState<SeededDraft<DefaultsForm> | null>(null);

  const fleet = useFleetIfAvailable();
  const fleetId = meta?.fleet?.id ?? config?.fleet_id ?? null;
  const status = railStatus({
    meta,
    settings,
    profiles,
    fleets: fleet?.fleets ?? null,
    defaultsDirty: defaultsDraftDirty(settings, defaultsDraft[0]),
  });
  // §4.6: how many loadout slots are filled — from the page's held copy, never
  // a read of the rail's own (`rail-status.ts`).
  const held = useHeldPresets();
  if (held.loaded) {
    status.presets = {
      tone: "none",
      meta: String(held.view.loadout.filter((id) => id !== null).length),
    };
  }

  return (
    <SettingsFleetContext.Provider value={fleetId}>
      <div className="st-view">
        <Rail
          section={section}
          onSection={onSection}
          onBack={onBack}
          fleetId={fleetId}
          status={status}
        />
        <div className="st-main" data-section={section}>
          <div className="st-body">
            {section === "account" ? <AccountSection config={config} meta={meta} /> : null}
            {section === "defaults" ? (
              <DefaultsSection
                settings={settings}
                profiles={profiles}
                draft={defaultsDraft}
                onSaved={onSaved}
                onRefresh={refreshSettings}
                onOpenProviders={() => onSection("providers")}
                onOpenPresets={() => onSection("presets")}
              />
            ) : null}
            {section === "providers" ? (
              <ProvidersSection
                settings={settings}
                profiles={profiles}
                onRefresh={refreshSettings}
                onOpenFoundation={() => onSection("foundation")}
                startNew={providersNew}
                onStartedNew={onProvidersNewHandled}
              />
            ) : null}
            {section === "secrets" ? (
              <SecretsSection
                settings={settings}
                onRefresh={refreshSettings}
                onOpenProviders={() => onSection("providers")}
              />
            ) : null}
            {section === "policy" ? <PolicySection /> : null}
            {section === "foundation" ? (
              <FoundationSection meta={meta} onOpenUpdate={onOpenFoundationUpdate} />
            ) : null}
            {section === "diagnostics" ? <DiagnosticsSection /> : null}
            {section === "presets" ? <PresetsSection /> : null}
            {section === "chat" ? <ChatSection /> : null}
            {section === "notifications" ? <NotificationsSection /> : null}
            {section === "runs" ? <RunsSection config={config} /> : null}
            {section === "danger" ? (
              <DangerSection config={config} onOpenTeardown={onOpenTeardown} />
            ) : null}
          </div>
        </div>
      </div>
    </SettingsFleetContext.Provider>
  );
}

/**
 * The view as `App` mounts it: the section, the way back and the two drawers
 * it can raise all come from `NavContext`, so the shell's props are the data
 * it shows and nothing about where the operator is.
 */
export function Settings({ meta, profiles }: Pick<SettingsProps, "meta" | "profiles">) {
  const fleet = useFleet();
  const nav = useNav();
  /**
   * §6.6: `meta.foundation` (and now `meta.settings`) is a snapshot taken when
   * the page loaded, and the Foundation section is the whole point of this
   * view. A `foundation update` or a `settings set` run from the CLI in another
   * terminal — or by a teammate — has to be visible here without a reload, so
   * opening Settings re-reads `/api/meta`.
   *
   * Depends on `refreshMeta`, not on `fleet`: the context value changes on every
   * poll tick, and `[fleet]` here would re-read `/api/meta` on each one.
   */
  const refreshMeta = fleet.refreshMeta;
  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  return (
    <SettingsShell
      meta={meta}
      profiles={profiles}
      providersNew={nav.providersNew}
      onProvidersNewHandled={nav.providersNewHandled}
      section={nav.settingsSection}
      onSection={nav.setSettingsSection}
      onBack={nav.backFromSettings}
      onOpenTeardown={() => nav.setFoundationTeardownOpen(true)}
      onOpenFoundationUpdate={() => nav.setFoundationUpdateOpen(true)}
    />
  );
}
