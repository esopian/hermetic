/**
 * The model control §8.3 asks for, in one place: a searchable list of what the
 * provider actually offers, plus a free-text escape hatch for an id it does not.
 *
 * Three callers draw it — provider setup, agent create, the agent drawer's
 * profile edit — and the rules it encodes are the same in all three:
 *
 * - The catalog is fetched once a credential exists to fetch it with, and then
 *   only on an explicit Refresh. A draft key is typed one character at a time,
 *   so the caller says when it is *finished* (`revision`); nothing here reads a
 *   provider once per keystroke.
 * - A failure is never fatal. Save stays available, the current selection
 *   stands, and Retry is offered beside the code core reported.
 * - **Refreshing never changes the selection.** The list is ordered around the
 *   selected id (`pinSelected`) rather than around the catalog's own default,
 *   and a selection the provider does not list is shown as `unlisted` instead
 *   of being quietly replaced.
 * - A response that arrives after the provider changed is discarded. The fetch
 *   carries a sequence number and only the newest one is allowed to land — the
 *   alternative is an OpenAI catalog rendered under an Anthropic profile.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchModels } from "../api/index.ts";
import type { CatalogModel, ModelsInput } from "../api/index.ts";
import { ApiError } from "../api/index.ts";
import { catalogFailure, pinSelected, searchModels } from "../logic/provider-logic.ts";

/** What to ask for, or `null` when there is nothing to ask with yet. */
export type ModelFetchSpec = { profile: string } | { provider: string; api_key?: string } | null;

export interface ModelCatalogState {
  models: CatalogModel[];
  loading: boolean;
  /** The failure of the last attempt, already worded (`catalogFailure`). */
  error: string | null;
  fetchedAt: string | null;
  /** What a new profile on this provider would select; null until a read lands. */
  defaultModel: string | null;
  refresh: () => void;
}

/**
 * The identity of a fetch, deliberately *not* including the draft key itself.
 *
 * A key is typed one character at a time, and a read per keystroke would send a
 * dozen half-typed credentials to the provider — every one of them a failed
 * authentication in somebody's audit log. So the caller says when a draft key
 * is *finished* by bumping `revision`, and `spec` being `null` is how it says
 * there is nothing to read with yet.
 */
function specKey(spec: ModelFetchSpec, revision: number): string | null {
  if (spec === null) return null;
  const base = "profile" in spec ? `profile:${spec.profile}` : `provider:${spec.provider}`;
  return `${base}:${revision}`;
}

export function useModelCatalog(spec: ModelFetchSpec, enabled = true, revision = 0): ModelCatalogState {
  const [state, setState] = useState<{
    models: CatalogModel[];
    error: string | null;
    fetchedAt: string | null;
    defaultModel: string | null;
  }>({ models: [], error: null, fetchedAt: null, defaultModel: null });
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** The newest fetch. Anything older than this is a stale answer and is dropped. */
  const seq = useRef(0);
  /** Read at call time so a keystroke does not restart the effect. */
  const latest = useRef<ModelFetchSpec>(spec);
  latest.current = spec;

  const key = specKey(spec, revision);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || key === null) return;
    const current = latest.current;
    if (current === null) return;
    const mine = ++seq.current;
    setLoading(true);
    // A new provider's read must not paint under the old provider's list, so
    // the models go the moment a fetch for a different spec starts.
    setState((prev) => ({ ...prev, models: [], error: null }));
    fetchModels(current as ModelsInput)
      .then((out) => {
        if (seq.current !== mine) return;
        setState({
          models: out.models,
          error: null,
          fetchedAt: out.fetched_at,
          defaultModel: out.default_model,
        });
      })
      .catch((e: unknown) => {
        if (seq.current !== mine) return;
        const code = e instanceof ApiError ? e.code : "UNKNOWN";
        const message = e instanceof Error ? e.message : String(e);
        setState({
          models: [],
          error: catalogFailure(code, message),
          fetchedAt: null,
          defaultModel: null,
        });
      })
      .finally(() => {
        if (seq.current === mine) setLoading(false);
      });
  }, [enabled, key, nonce]);

  return { ...state, loading, refresh };
}

export function ModelPicker({
  value,
  onChange,
  catalog,
  placeholder,
  /** Said when there is no credential to fetch a catalog with yet. */
  idleHint,
}: {
  value: string;
  onChange: (id: string) => void;
  catalog: ModelCatalogState;
  placeholder: string;
  idleHint?: string;
}) {
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");

  const pinned = pinSelected(catalog.models, value);
  const shown = searchModels(pinned, query);
  const idle = !catalog.loading && catalog.error === null && catalog.models.length === 0;

  /** Named `applyCustom`, not `useCustom`: `use*` is a hook prefix. */
  function applyCustom() {
    const id = custom.trim();
    if (id === "") return;
    onChange(id);
    setCustom("");
    setCustomOpen(false);
  }

  return (
    <div className="model-picker">
      <div className="kicker" style={{ marginBottom: 8 }}>
        Model
      </div>

      <div className="model-picker-head">
        <input
          className="key-input model-search"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search models"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary btn-mini"
          disabled={catalog.loading}
          onClick={catalog.refresh}
        >
          {catalog.loading ? "Loading…" : catalog.error === null ? "Refresh" : "Retry"}
        </button>
      </div>

      <div className="model-picker-selected mono">
        selected · <b>{value === "" ? "—" : value}</b>
      </div>

      {catalog.error !== null ? (
        // A catalog failure is never allowed to block Save: the selection on
        // screen is still a model, and the key it was typed with is still
        // worth storing (§8.3).
        <div className="mono model-picker-error" style={{ color: "var(--bad)" }}>
          {catalog.error} — the model above still saves
        </div>
      ) : null}

      {idle && catalog.error === null ? (
        <div className="name-hint" style={{ color: "var(--fg3)" }}>
          {idleHint ?? "no catalog read yet"}
        </div>
      ) : null}

      {shown.length > 0 ? (
        <ul className="model-list" aria-label="Models">
          {shown.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="model-row"
                aria-pressed={m.id === value}
                onClick={() => onChange(m.id)}
              >
                <span className="mono model-row-id">{m.id}</span>
                <span className="model-row-name">{m.name}</span>
                {m.unlisted ? <span className="tag ghost">unlisted</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {catalog.fetchedAt !== null ? (
        <div className="name-hint mono" style={{ color: "var(--fg3)" }}>
          {catalog.models.length} models · read {catalog.fetchedAt}
        </div>
      ) : null}

      {customOpen ? (
        <div className="model-custom">
          <input
            className="key-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="Custom model ID"
            placeholder="provider/model-id"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyCustom();
              }
            }}
          />
          <button type="button" className="btn btn-secondary btn-mini" onClick={applyCustom}>
            Use
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-mini model-custom-open"
          onClick={() => setCustomOpen(true)}
        >
          Enter custom model ID
        </button>
      )}
    </div>
  );
}
