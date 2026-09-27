/**
 * One provider profile, created or edited (§8.3).
 *
 * The drawer is where a credential is typed and where a model is chosen, and
 * the two are deliberately not the same transaction: a key can be saved with no
 * catalog (the provider may be down), and a model can be changed with no key
 * (Bedrock has none). Save never waits on a catalog read.
 *
 * `provider` is immutable on edit, and the select says so rather than being
 * silently absent: a profile that changed provider would be a different
 * credential at a different endpoint under a name agents have already pinned.
 */
import { useState } from "react";
import { createProfile, updateProfile } from "../../api/index.ts";
import type { ProfileView, ProviderCatalog, ProviderId } from "../../api/index.ts";
import { toSaveError } from "../../logic/settings-logic.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import { canDisableProfile, readyBadge } from "../../logic/provider-logic.ts";
import { Drawer, DrawerHead } from "../Drawer.tsx";
import { ModelPicker, useModelCatalog } from "../ModelPicker.tsx";
import type { ModelFetchSpec } from "../ModelPicker.tsx";

/** §8.3's profile-name shape, restated (core is off limits to the UI). */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function ProviderDrawer({
  profile,
  catalog,
  expectedVersion,
  defaultProfile,
  focusKey = false,
  onClose,
  onSaved,
}: {
  /** `null` is the create case; a profile is the edit case. */
  profile: ProfileView | null;
  catalog: ProviderCatalog;
  /** The `settings.version` the page loaded with, or null when nothing is persisted. */
  expectedVersion: number | null;
  defaultProfile: string | null;
  /** Opened by "Rotate key": the credential field is what the operator came for. */
  focusKey?: boolean;
  onClose: () => void;
  /** Re-read profiles and settings; the drawer closes itself after calling it. */
  onSaved: () => void;
}) {
  const editing = profile !== null;
  const providers = Object.keys(catalog) as ProviderId[];
  const [provider, setProvider] = useState<ProviderId>(
    (profile?.provider as ProviderId | undefined) ?? providers[0] ?? "bedrock",
  );
  const [name, setName] = useState(profile?.name ?? "");
  const [model, setModel] = useState(profile?.model ?? catalog[provider]?.default_model ?? "");
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [makeDefault, setMakeDefault] = useState(profile?.is_default ?? false);
  /**
   * Write-only, and never prefilled from anything: no read path returns a key,
   * so an empty field on an edit means "leave the stored one alone", not "clear
   * it". It lives in this component's state for as long as the drawer is open
   * and is never put in storage, the URL, or the op's recorded input.
   */
  const [apiKey, setApiKey] = useState("");
  /**
   * Bumped when the operator has *finished* typing a key (blur), which is what
   * triggers the one catalog read a draft credential gets. Zero means nothing
   * has been committed yet, and the picker says so instead of reading.
   */
  const [keyRevision, setKeyRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);

  const spec = catalog[provider];
  const keyed = spec?.auth !== "role";

  /**
   * Where the catalog is read from. On an edit core already holds the
   * credential, so the profile is enough; on a create the only credential is
   * the draft one being typed, which is why the request carries it.
   */
  const fetchSpec: ModelFetchSpec = editing
    ? { profile: profile.id }
    : keyed
      ? keyRevision === 0
        ? null
        : { provider, api_key: apiKey }
      : { provider };
  const models = useModelCatalog(fetchSpec, true, keyRevision);

  const trimmedName = name.trim();
  const nameBad = trimmedName !== "" && !PROFILE_NAME_RE.test(trimmedName);
  const blocked =
    trimmedName === ""
      ? "a profile needs a name"
      : nameBad
        ? "1–40 characters of [a-z0-9-], starting alphanumeric"
        : model.trim() === ""
          ? "a profile needs a model"
          : null;
  const disable = canDisableProfile(profile ?? ({ is_default: false, enabled: true } as ProfileView));
  const conflict = error?.code === "CONFLICT";

  /**
   * Switching provider in the create drawer resets the model to the new
   * provider's own default. Anything else would carry an Anthropic model id
   * onto an OpenAI profile and save it.
   */
  function chooseProvider(id: ProviderId) {
    setProvider(id);
    setModel(catalog[id]?.default_model ?? "");
    // The key belongs to the provider that issued it, and so does the catalog
    // it read. Both go, and the picker goes back to "type a key".
    setApiKey("");
    setKeyRevision(0);
  }

  async function save() {
    if (blocked !== null || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateProfile(profile.id, {
          name: trimmedName === profile.name ? undefined : trimmedName,
          model: model.trim() === profile.model ? undefined : model.trim(),
          enabled: enabled === profile.enabled ? undefined : enabled,
          ...(apiKey.trim().length > 0 ? { api_key: apiKey.trim() } : {}),
          ...(makeDefault && !profile.is_default ? { default: true } : {}),
          expected_version: expectedVersion,
        });
      } else {
        await createProfile({
          provider,
          name: trimmedName,
          model: model.trim(),
          enabled,
          ...(apiKey.trim().length > 0 ? { api_key: apiKey.trim() } : {}),
          ...(makeDefault ? { default: true } : {}),
          expected_version: expectedVersion,
        });
      }
      setApiKey("");
      onSaved();
      onClose();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setSaving(false);
    }
  }

  const stored = profile?.credential.kind === "secret" ? readyBadge(profile) : null;

  return (
    <Drawer width={560} onClose={onClose} labelledBy="provider-drawer-title">
      <DrawerHead
        titleId="provider-drawer-title"
        kicker={editing ? `Profile · ${profile.id}` : "New provider profile"}
        title={editing ? `Edit ${profile.name}` : "New profile"}
        onClose={onClose}
      />

      <div className="form">
        <label className="select-field">
          <div className="kicker" style={{ marginBottom: 8 }}>
            Provider
          </div>
          <div className="select-wrap">
            <select
              className="select-input"
              value={provider}
              disabled={editing}
              onChange={(e) => chooseProvider(e.target.value as ProviderId)}
            >
              {providers.map((id) => (
                <option key={id} value={id}>
                  {catalog[id]?.label ?? id}
                </option>
              ))}
            </select>
          </div>
          <div className="name-hint" style={{ color: "var(--fg3)" }}>
            {editing
              ? "fixed after create — agents pin this profile, and moving it to another endpoint would move them with it"
              : (spec?.description ?? "")}
          </div>
        </label>

        <label style={{ display: "block" }}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Name
          </div>
          <input
            className="key-input"
            data-autofocus={focusKey ? undefined : true}
            type="text"
            aria-label="Name"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. anthropic-main"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <div className="name-hint" style={{ color: nameBad ? "var(--bad)" : "var(--fg3)" }}>
            {nameBad
              ? "1–40 characters of [a-z0-9-], starting alphanumeric"
              : "what an operator calls this credential; unique per fleet"}
          </div>
        </label>

        {keyed ? (
          <label style={{ display: "block" }}>
            <div className="kicker" style={{ marginBottom: 8 }}>
              {editing ? "Rotate key" : (spec?.env ?? "API key")}
            </div>
            <input
              className="key-input"
              data-autofocus={focusKey ? true : undefined}
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={editing ? "Rotate key" : "API key"}
              placeholder={editing ? "leave blank to keep the stored key" : `${spec?.label} API key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={() => {
                if (apiKey.trim().length > 0) setKeyRevision((n) => n + 1);
              }}
            />
            <div className="name-hint" style={{ color: "var(--fg3)" }}>
              {editing
                ? `${stored?.label ?? "—"} · ${stored?.reason ?? ""}`
                : "written into this profile's own fleet secret slot; never returned by any read"}
            </div>
          </label>
        ) : (
          <div>
            <div className="kicker" style={{ marginBottom: 8 }}>
              Credential
            </div>
            <div className="mono provider-role">IAM role</div>
            <div className="name-hint" style={{ color: "var(--fg3)" }}>
              authenticates as the instance role — there is no key to type and nothing to rotate
            </div>
          </div>
        )}

        <ModelPicker
          value={model}
          onChange={setModel}
          catalog={models}
          placeholder="search this provider's catalog"
          idleHint={
            keyed && !editing && apiKey.trim() === ""
              ? "type a key above and the catalog is read once"
              : "no catalog read yet — Refresh asks the provider"
          }
        />

        <label className="verify-row">
          <input
            className="verify-check"
            type="checkbox"
            checked={enabled}
            disabled={!disable.ok && enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            Offer this profile to a create
            {!disable.ok && enabled ? (
              <span className="name-hint" style={{ color: "var(--fg3)", display: "block" }}>
                {disable.reason}
              </span>
            ) : null}
          </span>
        </label>

        <label className="verify-row">
          <input
            className="verify-check"
            type="checkbox"
            checked={makeDefault}
            disabled={profile?.is_default === true}
            onChange={(e) => setMakeDefault(e.target.checked)}
          />
          <span>
            Make this the fleet default
            <span className="name-hint" style={{ color: "var(--fg3)", display: "block" }}>
              {defaultProfile === null
                ? "this fleet has no default profile yet"
                : profile?.is_default === true
                  ? "already the default"
                  : "a create with no --provider-profile resolves to the default"}
            </span>
          </span>
        </label>

        {error !== null ? (
          <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
            {conflict
              ? "CONFLICT · settings changed on another laptop — reload and try again"
              : `${error.code} · ${error.message}`}
          </div>
        ) : null}
      </div>

      <div className="drawer-foot">
        <div style={{ fontSize: 12, color: "var(--fg2)" }}>
          {editing
            ? "Agents already bound to this profile keep running their pinned revision until they are updated."
            : "Creating a profile writes its credential slot first, then the profile."}
        </div>
        <span style={{ display: "flex", gap: 8 }}>
          {conflict ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                onSaved();
                onClose();
              }}
            >
              Reload
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || blocked !== null}
            title={blocked ?? undefined}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : editing ? "Save profile" : "Create profile"}
          </button>
        </span>
      </div>
    </Drawer>
  );
}
