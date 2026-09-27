/**
 * The brain: which provider profile this agent runs on, and which model — one
 * compact row showing `profile · model`, opening a popover with the ready
 * profiles on the left and the chosen profile's catalog on the right.
 *
 * §8.3: the chooser replaced a provider select *and* an API key field. A create
 * carries no credential at all — the key lives on the profile, was typed once
 * in Settings, and core resolves it after re-checking readiness. Only ready
 * profiles are offered, because anything else builds an agent that boots and
 * cannot answer.
 */
import { useRef, useState } from "react";
import { saveCreateDraft } from "../../logic/create-draft.ts";
import { providerSpec } from "../../logic/provider-logic.ts";
import { useNav } from "../../nav/nav-state.tsx";
import { ModelPicker } from "../ModelPicker.tsx";
import type { ModelCatalogState } from "../ModelPicker.tsx";
import { Popover } from "../Popover.tsx";
import type { CreateFormModel } from "./useCreateForm.ts";

export function BrainChooser({
  f,
  catalog,
  defaultProfile,
}: {
  f: CreateFormModel;
  catalog: ModelCatalogState;
  defaultProfile: string | null;
}) {
  /**
   * Leave for Settings → Providers, keeping this form. The drawer writes its
   * draft first, so the detour costs nothing already typed.
   */
  const { setUpProvider } = useNav();
  const detour = () => {
    saveCreateDraft(f.fleetId, f.draftNow());
    setUpProvider();
  };
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  if (f.noProfiles) {
    return (
      <div>
        <div className="cr-lbl">
          <span className="kicker">Brain</span>
          <span className="cr-src">profile · model</span>
        </div>
        <div className="infobox create-no-profiles">
          <span className="k">provider</span>
          <span>
            No provider profile is ready. A create picks a stored credential and never asks for a key.
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-primary" onClick={detour}>
                Set up a provider →
              </button>
            </div>
            <div className="name-hint" style={{ color: "var(--fg3)" }}>
              What is typed here is kept; this form comes back when you return.
            </div>
          </span>
        </div>
      </div>
    );
  }

  const profile = f.chosenReady ? f.profile : null;
  const override = f.model.trim().length > 0 && f.model.trim() !== (profile?.model ?? "");
  const effectiveModel = f.model.trim() === "" ? (profile?.model ?? "") : f.model.trim();
  const isDefault = profile !== null && profile.id === defaultProfile;

  const hint =
    profile === null
      ? "the fleet has no ready default, so this create needs a profile chosen"
      : override
        ? "hermetic holds this model: change it later with `hermetic agent set`"
        : profile.credential.kind === "role"
          ? "IAM instance role · no stored secrets"
          : `${providerSpec(profile).env ?? "the key"} copied from ${profile.name} into this agent's own slot, tmpfs only`;

  return (
    <div>
      <div className="cr-lbl">
        <span className="kicker">Brain</span>
        <span className="cr-src">profile · model</span>
      </div>
      <button
        ref={anchor}
        type="button"
        className="cr-brain"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          profile === null ? "Brain · choose a profile" : `Brain · ${profile.name} · ${effectiveModel}`
        }
        onClick={() => setOpen((v) => !v)}
      >
        {profile === null ? (
          <span className="c" style={{ color: "var(--warn)" }}>
            <span className="sq warn" />
            <b>choose a profile</b>
          </span>
        ) : (
          <>
            <span className="c">
              <span className="sq ok" />
              <b>{profile.name}</b>
            </span>
            <span className="c mono cr-brain-model">{effectiveModel}</span>
            {override ? (
              <span className="cr-chgtag">model override</span>
            ) : isDefault ? (
              <span className="cr-deftag">fleet default</span>
            ) : (
              <span />
            )}
          </>
        )}
        <span className="c cr-caret">▾</span>
      </button>
      <div className="cr-hint" style={profile === null ? { color: "var(--warn)" } : undefined}>
        {hint}
      </div>

      {open ? (
        <Popover anchor={anchor} onClose={() => setOpen(false)} label="Brain" maxWidth={560}>
          <div className="cr-bm">
            <div className="cr-bm-col" role="group" aria-label="Profiles">
              <div className="cr-bm-h kicker">Profile</div>
              {f.ready.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="cr-bm-row"
                  aria-pressed={p.id === f.profileId}
                  data-profile={p.id}
                  onClick={() => f.chooseProfile(p.id)}
                >
                  <span>
                    {p.name}
                    <small>
                      {providerSpec(p).label}
                      {p.id === defaultProfile ? " · fleet default" : ""}
                    </small>
                  </span>
                </button>
              ))}
              <button type="button" className="cr-bm-row cr-bm-more" onClick={detour}>
                <span>
                  Manage providers →<small>this form is kept</small>
                </span>
              </button>
            </div>
            <div className="cr-bm-col">
              {profile === null ? (
                <div className="cr-hint" style={{ padding: 14 }}>
                  choose a profile to read its catalog
                </div>
              ) : (
                <>
                  <ModelPicker
                    value={effectiveModel}
                    onChange={f.setModel}
                    catalog={catalog}
                    placeholder="search this profile's catalog"
                    idleHint="Refresh asks the provider for its catalog"
                  />
                  {override ? (
                    <button type="button" className="linklike cr-hint" onClick={() => f.setModel("")}>
                      Back to {profile.name}’s own model
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
          <div className="cr-bm-foot">
            <button type="button" className="btn btn-secondary btn-mini" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
