/**
 * §4.6/§10: what a create inherits when a flag is omitted — and, since plan
 * 0001 phase 7, where it is changed.
 *
 * Every field here is a fleet-wide write: a second laptop that attaches to this
 * fleet reads exactly these values. So the fields stage, and go out together
 * from the save bar rather than saving on blur, and the write carries the
 * `expected_version` the form was loaded from, which is what makes two laptops
 * editing at once a `CONFLICT` instead of a silent overwrite.
 *
 * The document itself is held by the shell, not here: every section writes to
 * the same `_fleet` item and every write bumps `settings.version`, so a version
 * this section remembered on its own would be stale the moment Providers saved.
 * The draft is the shell's too (`DraftHolder`), so a staged edit survives a
 * visit to another section and the rail can say it is waiting.
 */
import { useContext, useId, useState } from "react";
import { setSettings, updateProfile } from "../../api/index.ts";
import type { SettingsResult } from "../../api/index.ts";
import { profileById, providerSpec, readyProfiles } from "../../logic/provider-logic.ts";
import type { ProfilesState } from "../../state/state.tsx";
import {
  APPROVALS_MODES,
  REASONING_EFFORTS,
  SECRETS_MODES,
  TERMINAL_BACKENDS,
  activeSaveError,
  changedDefaults,
  defaultsIssue,
  dirtyDefaults,
  toSaveError,
} from "../../logic/settings-logic.ts";
import type { DefaultsForm, RaisedSaveError, SaveError } from "../../logic/settings-logic.ts";
import { SaveBar } from "./SaveBar.tsx";
import { liveDraft, useSeededForm } from "./seeded.ts";
import type { DraftHolder, SeededDraft } from "./seeded.ts";
import {
  Block,
  Callout,
  PageFoot,
  RowChanged,
  RowNote,
  SavedTick,
  SettingRow,
  SettingsFleetContext,
  SettingsPage,
  useSavedTick,
} from "./Section.tsx";

/** "" is a real choice — *unstated* — so it rides in the option list. */
const TERMINALS = ["", ...TERMINAL_BACKENDS] as const;
const EFFORTS = ["", ...REASONING_EFFORTS] as const;
const APPROVALS = ["", ...APPROVALS_MODES] as const;

/** What the save bar calls each field when it names the staged ones. */
const FIELD_LABEL: Record<keyof DefaultsForm, string> = {
  secrets: "secrets mode",
  model: "model",
  terminal_backend: "terminal backend",
  max_turns: "max turns",
  reasoning_effort: "reasoning effort",
  approvals_mode: "approvals",
};

const HERMES_FIELDS: ReadonlySet<keyof DefaultsForm> = new Set([
  "model",
  "terminal_backend",
  "max_turns",
  "reasoning_effort",
  "approvals_mode",
]);

export function defaultsFormOf(result: SettingsResult): DefaultsForm {
  const s = result.settings;
  const hermes = s.agent_defaults ?? {};
  return {
    secrets: s.defaults.secrets,
    model: hermes.model ?? "",
    terminal_backend: hermes.terminal_backend ?? "",
    max_turns: hermes.max_turns === undefined ? "" : String(hermes.max_turns),
    reasoning_effort: hermes.reasoning_effort ?? "",
    approvals_mode: hermes.approvals_mode ?? "",
  };
}

/**
 * Whether the shell's held draft stages anything against the fleet's current
 * values — the rail's "unsaved" square on Defaults. A draft typed over values
 * the fleet has since moved away from is not staged any more: the form has
 * already started again from the new ones.
 */
export function defaultsDraftDirty(
  settings: SettingsResult | null,
  draft: SeededDraft<DefaultsForm> | null,
): boolean {
  if (settings === null) return false;
  const loaded = defaultsFormOf(settings);
  const form = liveDraft(loaded, draft);
  return form !== null && changedDefaults(loaded, form).length > 0;
}

/**
 * The model a create resolves to with no `--model`: since §8.3 that is the
 * default *profile's* model, resolved once when the profile was created and
 * persisted there, rather than a provider's catalog default that could move
 * under a running fleet.
 *
 * It is a placeholder rather than a value, because a blank field here means
 * "leave it to the profile" — and typing the same string would mean something
 * else (§6.4: hermetic manages what it was told to manage).
 */
function effectiveModel(profiles: ProfilesState): string {
  const fallback = profileById(profiles.list ?? [], profiles.defaultProfile);
  return fallback?.model ?? "the default profile's model";
}

/** A loaded value as the "was …" under a changed row says it. */
function wasText(v: string): string {
  if (v.trim() === "") return "unstated";
  return v;
}

/**
 * The fleet default, changed where it actually lives.
 *
 * An instant-save row, deliberately outside the save bar's count: the default
 * is a field on a *profile* (`providers.update` with `default: true`), not on
 * `_fleet.defaults`, so folding it into the settings patch would send a write
 * to the wrong resource and carry the wrong `expected_version` with it. One
 * select, one request, its own error line — and the `✓ saved` tick every
 * instant control flashes.
 */
function DefaultProfileRow({
  profiles,
  expectedVersion,
  onWritten,
  onOpenProviders,
}: {
  profiles: ProfilesState;
  /** The `settings.version` the page holds; the write is CAS'd on it like every other. */
  expectedVersion: number | null;
  /** Re-read the fleet's settings: this write bumped `settings.version` too. */
  onWritten: () => void;
  onOpenProviders: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [ticked, flash] = useSavedTick();
  const list = profiles.list ?? [];
  const ready = readyProfiles(list);
  const current = profileById(list, profiles.defaultProfile);

  async function choose(next: string) {
    if (next === "" || next === profiles.defaultProfile) return;
    setBusy(true);
    setError(null);
    try {
      await updateProfile(next, { default: true, expected_version: expectedVersion });
      profiles.refresh();
      onWritten();
      flash();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setBusy(false);
    }
  }

  const desc =
    error !== null ? (
      <span className="st-err">
        {error.code} · {error.message}
      </span>
    ) : ready.length === 0 ? (
      <>
        no profile is ready —{" "}
        <button type="button" className="linklike" onClick={onOpenProviders}>
          set one up in Providers
        </button>
      </>
    ) : (
      "What a create with no --provider-profile resolves to."
    );

  return (
    <SettingRow
      label="Default provider profile"
      desc={desc}
      htmlFor={id}
      field="default_profile"
      state={
        <>
          {ticked ? null : <RowNote>saves at once</RowNote>}
          <SavedTick on={ticked} />
        </>
      }
    >
      <div className="select-wrap st-w">
        <select
          id={id}
          className="select-input"
          disabled={busy || ready.length === 0}
          value={profiles.defaultProfile ?? ""}
          onChange={(e) => void choose(e.target.value)}
        >
          {/* A default the fleet has but which is no longer ready still has to
              be *shown*, or the select would silently claim another profile is
              the default. It is listed and unpickable. */}
          {current !== null && !current.ready ? (
            <option value={current.id} disabled>
              {current.name} (not ready)
            </option>
          ) : null}
          {profiles.defaultProfile === null ? <option value="">— none —</option> : null}
          {ready.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {providerSpec(p).label} · {p.model}
            </option>
          ))}
        </select>
      </div>
    </SettingRow>
  );
}

function DefaultsFormView({
  result,
  profiles,
  draft,
  onOpenProviders,
  onOpenPresets,
  onSaved,
  onReload,
  reloadError,
}: {
  result: SettingsResult;
  profiles: ProfilesState;
  draft?: DraftHolder<DefaultsForm>;
  onOpenProviders: () => void;
  onOpenPresets: () => void;
  onSaved: (next: SettingsResult) => void;
  onReload: () => void;
  /** A failed re-read, raised by the section above — shown on the same bar. */
  reloadError: SaveError | null;
}) {
  const ids = useId();
  const fleetId = useContext(SettingsFleetContext);
  const loaded = defaultsFormOf(result);
  const { form, set: setForm, reset } = useSeededForm(loaded, draft);
  const [saving, setSaving] = useState(false);
  const [raisedError, setRaisedError] = useState<RaisedSaveError | null>(null);

  /**
   * The version the shell currently holds, not the one this page loaded with:
   * a save in another section already moved it, and re-sending the older number
   * would be this laptop conflicting with itself.
   *
   * `persisted: false` means nobody has written a settings object at all — the
   * values on screen are the ones the fleet started with — so the write must
   * say `null` ("there was none"), not the synthesized version number.
   */
  const expected = result.persisted ? result.settings.version : null;
  // A `CONFLICT` raised against an older `expected` is stale the moment this
  // version moves — by this section's own successful Reload, or by another
  // section's save — so it stops being shown without anything needing to
  // reach back in and clear it (`activeSaveError`).
  const error = activeSaveError(raisedError, expected);
  const patch = dirtyDefaults(loaded, form, expected);
  const issue = defaultsIssue(form);
  const changed = changedDefaults(loaded, form);
  const isChanged = (k: keyof DefaultsForm) => changed.includes(k);

  function set<K extends keyof DefaultsForm>(k: K, v: DefaultsForm[K]) {
    setForm({ ...form, [k]: v });
  }

  /** The state column: what it was when staged, else whose value this is. */
  function state(k: keyof DefaultsForm) {
    if (isChanged(k)) return <RowChanged was={wasText(loaded[k])} />;
    if (HERMES_FIELDS.has(k) && loaded[k].trim() === "") return <RowNote>unstated</RowNote>;
    return <RowNote>fleet default</RowNote>;
  }

  async function save() {
    if (patch === null || issue !== null) return;
    setSaving(true);
    setRaisedError(null);
    try {
      onSaved(await setSettings(patch));
    } catch (e) {
      setRaisedError({ at: expected, error: toSaveError(e) });
    } finally {
      setSaving(false);
    }
  }

  const id = (k: string) => `${ids}-${k}`;
  const unstated = (v: string) => (v === "" ? "— unstated —" : v);

  return (
    <SettingsPage
      section="defaults"
      scope="fleet"
      desc="What a new agent starts with, apart from its machine. Existing agents do not change."
    >
      {/*
        Size, data volume and system disk are this laptop's create presets now
        (§4.6). One line says where they went, so an operator who comes looking
        for them here is sent to the page that sets them.
      */}
      <Callout tone="info">
        Machine size and disks come from your{" "}
        <button type="button" className="linklike" onClick={onOpenPresets}>
          Create presets →
        </button>{" "}
        (this laptop only).
      </Callout>

      <Block title="New agents">
        <DefaultProfileRow
          profiles={profiles}
          expectedVersion={expected}
          onWritten={onReload}
          onOpenProviders={onOpenProviders}
        />

        <SettingRow
          label="Secrets mode"
          desc="Where box secrets come from."
          field="secrets"
          changed={isChanged("secrets")}
          state={state("secrets")}
        >
          <div className="seg st-seg st-w" role="group" aria-label="Secrets mode">
            {SECRETS_MODES.map((m) => (
              <button
                type="button"
                key={m}
                aria-pressed={form.secrets === m}
                onClick={() => set("secrets", m)}
              >
                {m}
              </button>
            ))}
          </div>
        </SettingRow>
      </Block>

      {/*
        §6.4: a fleet-wide Hermes setting is one an agent inherits where it
        states none — so a *blank* field here is not "off", it is "whatever
        this build of hermetic defaults to". Which is why every one of them has
        an empty option rather than a value the fleet never chose.
      */}
      <Block
        title="Hermes seed defaults"
        right={
          <span className="mono dim">
            written to a new box&apos;s config once; agents may edit after
          </span>
        }
      >
        <SettingRow
          label="Model"
          desc={
            form.model.trim().length > 0
              ? "Every agent created without --model starts on this."
              : "Blank: a create uses its provider profile's model."
          }
          htmlFor={id("model")}
          field="model"
          changed={isChanged("model")}
          state={state("model")}
        >
          <input
            id={id("model")}
            className="key-input st-w"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={effectiveModel(profiles)}
            value={form.model}
            onChange={(e) => set("model", e.target.value)}
          />
        </SettingRow>

        <SettingRow
          label="Terminal backend"
          desc="Where Hermes runs shell commands."
          htmlFor={id("terminal")}
          field="terminal_backend"
          changed={isChanged("terminal_backend")}
          state={state("terminal_backend")}
        >
          <div className="select-wrap st-w">
            <select
              id={id("terminal")}
              className="select-input"
              value={form.terminal_backend}
              onChange={(e) =>
                set("terminal_backend", e.target.value as DefaultsForm["terminal_backend"])
              }
            >
              {TERMINALS.map((v) => (
                <option key={v} value={v}>
                  {unstated(v)}
                </option>
              ))}
            </select>
          </div>
        </SettingRow>

        <SettingRow
          label="Max turns"
          desc="Per task, before Hermes stops and asks."
          htmlFor={id("turns")}
          field="max_turns"
          changed={isChanged("max_turns")}
          state={state("max_turns")}
        >
          <input
            id={id("turns")}
            className="key-input st-num"
            type="number"
            min={1}
            max={10000}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="unstated"
            value={form.max_turns}
            onChange={(e) => set("max_turns", e.target.value)}
          />
        </SettingRow>

        <SettingRow
          label="Reasoning effort"
          desc="How hard the model thinks before it answers."
          htmlFor={id("effort")}
          field="reasoning_effort"
          changed={isChanged("reasoning_effort")}
          state={state("reasoning_effort")}
        >
          <div className="select-wrap st-w">
            <select
              id={id("effort")}
              className="select-input"
              value={form.reasoning_effort}
              onChange={(e) =>
                set("reasoning_effort", e.target.value as DefaultsForm["reasoning_effort"])
              }
            >
              {EFFORTS.map((v) => (
                <option key={v} value={v}>
                  {unstated(v)}
                </option>
              ))}
            </select>
          </div>
        </SettingRow>

        <SettingRow
          label="Approvals"
          desc={
            form.approvals_mode === ""
              ? "Unstated: an agent starts on off — nobody is at the box to answer a prompt."
              : "Where a new agent starts; it can change it from its own dashboard."
          }
          htmlFor={id("approvals")}
          field="approvals_mode"
          changed={isChanged("approvals_mode")}
          state={state("approvals_mode")}
        >
          <div className="select-wrap st-w">
            <select
              id={id("approvals")}
              className="select-input"
              value={form.approvals_mode}
              onChange={(e) => set("approvals_mode", e.target.value as DefaultsForm["approvals_mode"])}
            >
              {APPROVALS.map((v) => (
                <option key={v} value={v}>
                  {unstated(v)}
                </option>
              ))}
            </select>
          </div>
        </SettingRow>
      </Block>

      <PageFoot>
        {result.persisted
          ? `settings v${result.settings.version} · set by ${result.settings.updated_by}`
          : "nobody has set this fleet's settings yet — these are the defaults it started with"}
      </PageFoot>

      <SaveBar
        changes={changed.map((k) => FIELD_LABEL[k])}
        saving={saving}
        error={reloadError ?? error}
        blocked={issue}
        canSave={patch !== null}
        context={`${fleetId ?? "fleet"} · rev ${result.settings.version}`}
        onSave={() => void save()}
        onDiscard={() => {
          reset();
          setRaisedError(null);
        }}
        onReload={onReload}
      />
    </SettingsPage>
  );
}

export function DefaultsSection({
  settings,
  profiles,
  draft,
  onSaved,
  onRefresh,
  onOpenProviders,
  onOpenPresets,
}: {
  /** The shell's held document — one for the whole view (`SettingsShell.tsx`). */
  settings: SettingsResult | null;
  profiles: ProfilesState;
  /** The shell's held draft, so staged edits outlive a visit to another section. */
  draft?: DraftHolder<DefaultsForm>;
  onSaved: (next: SettingsResult) => void;
  onRefresh: () => Promise<void>;
  onOpenProviders: () => void;
  /** Settings › Create presets, where the machine fields went (§4.6). */
  onOpenPresets: () => void;
}) {
  const [reloadError, setReloadError] = useState<SaveError | null>(null);

  if (settings === null) {
    return (
      <SettingsPage
        section="defaults"
        scope="fleet"
        desc="What a new agent gets unless you override it at create time."
      >
        <PageFoot>not reported by this server build</PageFoot>
      </SettingsPage>
    );
  }

  return (
    <DefaultsFormView
      result={settings}
      profiles={profiles}
      draft={draft}
      onOpenProviders={onOpenProviders}
      onOpenPresets={onOpenPresets}
      onSaved={onSaved}
      reloadError={reloadError}
      onReload={() => {
        setReloadError(null);
        // Fire-and-forget would be an unhandled rejection: the Reload button is
        // the way out of a CONFLICT, so a failed re-read has to say so.
        void onRefresh().catch((e: unknown) => setReloadError(toSaveError(e)));
      }}
    />
  );
}
