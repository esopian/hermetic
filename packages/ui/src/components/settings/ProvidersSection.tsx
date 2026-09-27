/**
 * §8.3: the fleet's named provider profiles — what each one is called, which
 * provider and model it resolves to, whether its credential is actually there,
 * and which agents are running on it.
 *
 * A list of *profiles*, not of the six providers: a provider is a fact about
 * this build of hermetic, a profile is a credential somebody created, and there
 * may be several per provider. So "enabled" is per profile, and the key lives
 * in the profile's own fleet slot rather than in a shared slug an operator had
 * to pick out of a dropdown.
 *
 * Nothing here is staged. Every row action — rotate, enable, set default,
 * delete — is a command: one request against one profile
 * (`PATCH /api/provider-profiles/:id`) carrying the `expected_version` the page
 * holds, confirmed in place or in a drawer, never through a save bar. Each row
 * shows at most two of them; the rest sit under `…`, and a refused one stays
 * visible, dimmed, with its reason.
 */
import { useEffect, useState } from "react";
import { deleteProfile, updateProfile } from "../../api/index.ts";
import type { ProfileView, SettingsResult } from "../../api/index.ts";
import type { ProfilesState } from "../../state/state.tsx";
import { toSaveError } from "../../logic/settings-logic.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import {
  canDeleteProfile,
  canDisableProfile,
  canRotateKey,
  canSetDefault,
  providerSpec,
  readyBadge,
} from "../../logic/provider-logic.ts";
import { EmptyState } from "../EmptyState.tsx";
import { ScanHead, Skel } from "../Loading.tsx";
import { ProviderDrawer } from "./ProviderDrawer.tsx";
import { Block, Overflow, SettingsPage, Sq, Tally, TextAction } from "./Section.tsx";
import type { MenuItem, SqTone } from "./Section.tsx";

/** What the drawer is open for: a fresh profile, an edit, or a key rotation. */
type Editing = { profile: ProfileView | null; focusKey: boolean } | null;

/** The row's square: ready, disabled, or something an operator has to do. */
function profileTone(p: ProfileView): SqTone {
  if (!p.enabled) return "off";
  if (p.ready) return "ok";
  return p.ready_reason === "grant-missing" ? "warn" : "bad";
}

/** The key is what is missing, so the row's second verb says so. */
function needsKey(p: ProfileView): boolean {
  return p.ready_reason === "key-missing" || p.ready_reason === "key-placeholder";
}

function ProfilesSkeleton() {
  return (
    <>
      <ScanHead title="Reading provider profiles" detail="ssm:GetParameter /hermetic/…/_fleet" />
      {[0, 1].map((i) => (
        <div key={i} className="st-sr" aria-hidden="true">
          <Skel w="40%" />
          <Skel w="70%" />
          <Skel w="55%" />
        </div>
      ))}
    </>
  );
}

function ProfileRow({
  profile,
  busy,
  onEdit,
  onRotate,
  onToggle,
  onDefault,
  onDelete,
  onOpenFoundation,
}: {
  profile: ProfileView;
  busy: boolean;
  onEdit: () => void;
  onRotate: () => void;
  onToggle: () => void;
  onDefault: () => void;
  onDelete: () => void;
  onOpenFoundation: () => void;
}) {
  const badge = readyBadge(profile);
  const spec = providerSpec(profile);
  const disable = canDisableProfile(profile);
  const rotate = canRotateKey(profile);
  const linked = profile.linked_agents;

  /**
   * The second visible verb is whatever the row most needs: Enable on a
   * disabled profile, Set key on one whose slot holds no key, Rotate key
   * otherwise (refused, with its reason, on a role-authenticated one). The
   * verbs it displaced move into `…`, so nothing is lost by the choice.
   */
  const second: "enable" | "setkey" | "rotate" = !profile.enabled
    ? "enable"
    : needsKey(profile)
      ? "setkey"
      : "rotate";

  // The "fleet default" tag already says what Set-as-default would do, so the
  // profile that holds it has no such item rather than a dead one.
  const menu: MenuItem[] = profile.is_default
    ? []
    : [{ label: "Set as fleet default", allowed: canSetDefault(profile), onSelect: onDefault }];
  if (second !== "rotate" && second !== "setkey") {
    menu.push({ label: "Rotate key", allowed: rotate, onSelect: onRotate });
  }
  if (profile.enabled) menu.push({ label: "Disable", allowed: disable, onSelect: onToggle });
  menu.push({ label: "Delete…", allowed: canDeleteProfile(profile), onSelect: onDelete, danger: true });

  return (
    <tr data-profile={profile.id}>
      <td className="st-c-sq">
        <span role="img" aria-label={badge.label} title={badge.reason}>
          <Sq tone={profileTone(profile)} />
        </span>
      </td>
      <td>
        <div className="st-name">
          <b className="mono">{profile.name}</b>
          {profile.is_default ? <span className="tag">fleet default</span> : null}
        </div>
        {/* The readiness reason is one mono line, and only when there is
            something to act on — a ready profile's square already says it. */}
        {profile.ready ? null : <div className="st-why">{badge.reason}</div>}
        {profile.grant === "needs_foundation_update" ? (
          <div className="st-why warn">
            The fleet&apos;s role may not invoke <span className="mono">{profile.model}</span> yet.{" "}
            <button type="button" className="linklike" onClick={onOpenFoundation}>
              Run a foundation update
            </button>{" "}
            to add the grant.
          </div>
        ) : null}
      </td>
      <td>
        {spec.label}
        <div className="mono st-sub">{profile.model}</div>
      </td>
      <td className="mono st-cell-sm">
        {profile.credential.kind === "role" ? "IAM role" : profile.credential.slug}
      </td>
      <td className="mono st-cell-sm">{linked.length === 0 ? "—" : linked.join(", ")}</td>
      <td className="mono st-cell-sm">r{profile.revision}</td>
      <td className="st-acts">
        <span className="st-acts-in">
          <TextAction busy={busy} onClick={onEdit} label={`Edit ${profile.name}`}>
            Edit
          </TextAction>
          {second === "enable" ? (
            <TextAction busy={busy} onClick={onToggle} label={`Enable ${profile.name}`}>
              Enable
            </TextAction>
          ) : second === "setkey" ? (
            <TextAction
              busy={busy}
              tone="primary"
              onClick={onRotate}
              label={`Set key for ${profile.name}`}
            >
              Set key
            </TextAction>
          ) : (
            <TextAction
              busy={busy}
              allowed={rotate}
              onClick={onRotate}
              label={`Rotate key for ${profile.name}`}
            >
              Rotate key
            </TextAction>
          )}
          <Overflow label={`More actions for ${profile.name}`} items={menu} disabled={busy} />
        </span>
      </td>
    </tr>
  );
}

export function ProvidersSection({
  settings,
  profiles,
  onRefresh,
  onOpenFoundation,
  startNew = false,
  onStartedNew,
}: {
  /** The shell's held settings document — the catalog and the version a write carries. */
  settings: SettingsResult | null;
  profiles: ProfilesState;
  /** Re-read the fleet's settings; a profile write moves `settings.version`. */
  onRefresh: () => Promise<void>;
  onOpenFoundation: () => void;
  /**
   * Open the New-profile drawer as soon as this section mounts. The create
   * drawer's "Set up a provider" sends an operator here *to do one thing*, and
   * making them find the button again would be the detour charging twice.
   */
  startNew?: boolean;
  onStartedNew?: () => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<SaveError | null>(null);
  const [confirming, setConfirming] = useState<ProfileView | null>(null);

  useEffect(() => {
    if (!startNew) return;
    setEditing({ profile: null, focusKey: false });
    onStartedNew?.();
  }, [startNew, onStartedNew]);

  const expected = settings?.persisted ? (settings.settings.version ?? null) : null;

  /** Re-read both halves: the profiles themselves and the version a write moved. */
  function written() {
    profiles.refresh();
    void onRefresh().catch((e: unknown) => setError(toSaveError(e)));
  }

  async function patch(profile: ProfileView, body: Parameters<typeof updateProfile>[1]) {
    setBusy(profile.id);
    setError(null);
    try {
      await updateProfile(profile.id, { ...body, expected_version: expected });
      written();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(profile: ProfileView) {
    setBusy(profile.id);
    setError(null);
    try {
      await deleteProfile(profile.id);
      setConfirming(null);
      written();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setBusy(null);
    }
  }

  const catalog = settings?.catalog ?? null;
  const rows = profiles.list;
  const desc =
    "Model credentials agents link to. A change reaches linked agents on their next restart.";

  // A server built before `settings.get` carried the catalog cannot describe a
  // provider at all, and a New-profile drawer with an empty provider select
  // would be a form nobody can fill in. Say so, rather than draw it.
  if (settings === null) {
    return (
      <SettingsPage section="providers" scope="fleet" desc={desc}>
        <div className="st-hint mono">not reported by this server build</div>
      </SettingsPage>
    );
  }

  const ready = rows?.filter((p) => p.enabled && p.ready).length ?? 0;
  const attention = rows?.filter((p) => p.enabled && !p.ready).length ?? 0;
  const disabled = rows?.filter((p) => !p.enabled).length ?? 0;

  return (
    <SettingsPage
      section="providers"
      scope="fleet"
      desc={desc}
      primary={
        <button
          type="button"
          className="btn btn-primary"
          disabled={catalog === null}
          onClick={() => setEditing({ profile: null, focusKey: false })}
        >
          <span aria-hidden="true">+ </span>New profile
        </button>
      }
    >
      <Block
        title={rows === null ? "Profiles" : `${rows.length} profile${rows.length === 1 ? "" : "s"}`}
        right={
          rows === null || rows.length === 0 ? null : (
            <>
              <Tally tone="ok">{ready} ready</Tally>
              {attention > 0 ? <Tally tone="warn">{attention} need attention</Tally> : null}
              {disabled > 0 ? <Tally tone="off">{disabled} disabled</Tally> : null}
            </>
          )
        }
      >
        {error !== null || profiles.error !== null ? (
          <div className="st-hint mono st-err" role="alert">
            {error !== null ? `${error.code} · ${error.message}` : profiles.error}
            {error?.code === "CONFLICT" ? " — reload the page to see the other laptop's write" : ""}
          </div>
        ) : null}

        {rows === null ? (
          profiles.error === null ? (
            <ProfilesSkeleton />
          ) : null
        ) : rows.length === 0 ? (
          <EmptyState
            title="No provider profiles"
            hint="Create one before an agent — a create picks a profile and never asks for a key"
          />
        ) : (
          <table className="st-list">
            <thead>
              <tr>
                <th aria-label="State" />
                <th>Profile</th>
                <th>Provider · model</th>
                <th>Credential</th>
                <th>Agents</th>
                <th>Rev</th>
                <th className="st-acts">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <ProfileRow
                  key={p.id}
                  profile={p}
                  busy={busy === p.id}
                  onEdit={() => setEditing({ profile: p, focusKey: false })}
                  onRotate={() => setEditing({ profile: p, focusKey: true })}
                  onToggle={() => void patch(p, { enabled: !p.enabled })}
                  onDefault={() => void patch(p, { default: true })}
                  onDelete={() => setConfirming(p)}
                  onOpenFoundation={onOpenFoundation}
                />
              ))}
            </tbody>
          </table>
        )}

        {confirming !== null ? (
          <div className="st-confirm" role="alertdialog" aria-label={`Delete ${confirming.name}`}>
            <span>
              Deleting <b className="mono">{confirming.name}</b> deletes its credential slot too.
              Continue?
            </span>
            <span className="st-acts-in">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy !== null}
                onClick={() => void remove(confirming)}
              >
                Delete profile
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </span>
          </div>
        ) : null}
      </Block>

      <p className="st-foot mono">a named credential plus a model default · hermetic providers ls</p>

      {editing !== null && catalog !== null ? (
        <ProviderDrawer
          key={editing.profile?.id ?? "new"}
          profile={editing.profile}
          catalog={catalog}
          expectedVersion={expected}
          defaultProfile={profiles.defaultProfile}
          focusKey={editing.focusKey}
          onClose={() => setEditing(null)}
          onSaved={written}
        />
      ) : null}
    </SettingsPage>
  );
}
