/**
 * §8.2/§8.3: the fleet's shared secret slots — the *names* of them.
 *
 * No value is ever rendered here, and no read returns one: `_fleet` carries
 * slugs and timestamps, `/api/secrets` adds whether the parameter is actually
 * filled and who names it, and the value lives only in
 * `/hermetic/secrets/<slug>`, which no instance role can read. The list shows
 * state, never a value.
 *
 * The list is its own read rather than a slice of `/api/meta`, because
 * "declared on `_fleet`" and "actually set in SSM" are different facts and the
 * second one is the one an operator is here to check. Which is also why an
 * empty table is never drawn before that read has come back — `EmptyState` is a
 * claim about the fleet, and until the scan lands nobody has looked.
 */
import { useEffect, useState } from "react";
import { listSecrets } from "../../api/index.ts";
import type { ProviderCatalog, ProviderId, SettingsResult, SharedSecretView } from "../../api/index.ts";
import { fmtDate } from "../../logic/format.ts";
import { canDeleteSecret, secretState, toSaveError } from "../../logic/settings-logic.ts";
import type { SaveError, SecretState } from "../../logic/settings-logic.ts";
import { EmptyState } from "../EmptyState.tsx";
import { ScanHead, Skel } from "../Loading.tsx";
import { SecretDeleteDrawer, SecretPushDrawer } from "./SecretDrawers.tsx";
import { Block, SettingsPage, Sq, Tally, TextAction } from "./Section.tsx";
import type { SqTone } from "./Section.tsx";

const STATE_TONE: Record<SecretState, SqTone> = { set: "ok", empty: "off", orphan: "warn" };
const STATE_COLOR: Record<SecretState, string> = {
  set: "var(--ok)",
  empty: "var(--fg3)",
  orphan: "var(--warn)",
};

function SecretsSkeleton() {
  return (
    <>
      <ScanHead title="Reading shared secrets" detail="ssm:GetParametersByPath /hermetic/secrets/" />
      {[0, 1].map((i) => (
        <div key={i} className="st-sr" aria-hidden="true">
          <Skel w="60%" />
          <Skel w="70%" />
          <Skel w="40%" />
        </div>
      ))}
    </>
  );
}

/**
 * The table itself, without the read that fills it — so a test can render the
 * three states and the fan-out column from three literals rather than standing
 * up a fetch. The section decides *whether* there is a table; this decides what
 * one looks like.
 */
export function SecretsTable({
  rows,
  catalog,
  onRotate,
  onDelete,
  onOpenProviders,
}: {
  rows: readonly SharedSecretView[];
  catalog: ProviderCatalog | null;
  onRotate: (row: SharedSecretView) => void;
  onDelete: (row: SharedSecretView) => void;
  /** §8.3: a profile-owned slot is managed in Providers, so it links there. */
  onOpenProviders?: () => void;
}) {
  const label = (id: string): string => catalog?.[id as ProviderId]?.label ?? id;

  return (
    <table className="st-list">
      <thead>
        <tr>
          <th aria-label="State" />
          <th>Slug</th>
          <th>State</th>
          <th>Used by</th>
          <th>Last set</th>
          <th className="st-acts">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const view = {
            slug: row.slug,
            exists: row.exists,
            placeholder: row.placeholder,
            used_by: row.used_by,
            orphan: row.orphan,
            owner: row.owner,
          };
          const state = secretState(view);
          const allowed = canDeleteSecret(view);
          const rotate =
            row.owner === undefined
              ? { ok: true }
              : { ok: false, reason: `rotate it on the provider profile ${row.owner.name}` };
          return (
            <tr key={row.slug} data-slug={row.slug}>
              <td className="st-c-sq">
                <Sq tone={STATE_TONE[state]} />
              </td>
              <td>
                <b className="mono">{row.slug}</b>
                {row.label === undefined || row.label === "" ? null : (
                  <div className="mono st-sub">{row.label}</div>
                )}
              </td>
              <td className="mono secrets-state" style={{ color: STATE_COLOR[state] }}>
                {state}
              </td>
              <td className="mono st-cell-sm secrets-used-by">
                {row.owner !== undefined ? (
                  <button type="button" className="linklike" onClick={onOpenProviders}>
                    owned by profile {row.owner.name}
                  </button>
                ) : row.used_by.length === 0 ? (
                  "—"
                ) : (
                  row.used_by.map(label).join(", ")
                )}
              </td>
              <td className="mono st-cell-sm">
                {row.last_set_at === undefined ? "—" : fmtDate(row.last_set_at)}
              </td>
              <td className="st-acts">
                <span className="st-acts-in">
                  <TextAction
                    allowed={rotate}
                    onClick={() => onRotate(row)}
                    label={`Rotate ${row.slug}`}
                  >
                    Rotate
                  </TextAction>
                  <TextAction
                    allowed={allowed}
                    tone="danger"
                    onClick={() => onDelete(row)}
                    label={`Delete ${row.slug}`}
                  >
                    Delete
                  </TextAction>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SecretsSection({
  settings,
  onRefresh,
  onOpenProviders,
}: {
  /** The shell's held document: the catalog for the labels, and the version a
   *  push or a delete has just moved (`SettingsShell.tsx`). */
  settings: SettingsResult | null;
  onRefresh: () => Promise<void>;
  onOpenProviders?: () => void;
}) {
  const catalog = settings?.catalog ?? null;
  const [rows, setRows] = useState<SharedSecretView[] | null>(null);
  const [error, setError] = useState<SaveError | null>(null);
  /** `{ slot: null }` is "add"; a slot is "rotate". `undefined` is closed. */
  const [pushing, setPushing] = useState<{ slot: SharedSecretView | null } | undefined>(undefined);
  const [deleting, setDeleting] = useState<SharedSecretView | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    listSecrets()
      .then((out) => {
        if (live) setRows(out.secrets);
      })
      .catch((e: unknown) => {
        if (live) setError(toSaveError(e));
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  /**
   * A push or a delete writes `_fleet` too — it adds or removes the slot's
   * metadata — so `settings.version` has moved and the *shell's* copy has to
   * move with it, or the next save in Defaults or Providers conflicts with this
   * write. It is also how a brand-new slug reaches the Providers dropdown.
   */
  function written() {
    setNonce((n) => n + 1);
    void onRefresh().catch((e: unknown) => setError(toSaveError(e)));
  }

  const tally = (s: SecretState) => rows?.filter((r) => secretState({ ...r }) === s).length ?? 0;

  return (
    <SettingsPage
      section="secrets"
      scope="fleet"
      desc="Keys the fleet holds. One value, copied into each agent's own slot at create; never shown again."
      primary={
        <button type="button" className="btn btn-primary" onClick={() => setPushing({ slot: null })}>
          <span aria-hidden="true">+ </span>Add secret
        </button>
      }
    >
      <Block
        title={rows === null ? "Slots" : `${rows.length} slot${rows.length === 1 ? "" : "s"}`}
        right={
          rows === null || rows.length === 0 ? null : (
            <>
              <Tally tone="ok">{tally("set")} set</Tally>
              {tally("empty") > 0 ? <Tally tone="off">{tally("empty")} empty</Tally> : null}
              {tally("orphan") > 0 ? <Tally tone="warn">{tally("orphan")} orphan</Tally> : null}
            </>
          )
        }
      >
        {/* A failed *re*-read must not take the table away: what is on screen is
            still the last thing the fleet said, and blanking it would look like
            the slots had gone. The error sits beside them instead. */}
        {error !== null ? (
          <div className="st-hint mono st-err" role="alert">
            {error.code} · {error.message}
          </div>
        ) : null}

        {rows === null ? (
          error === null ? (
            <SecretsSkeleton />
          ) : null
        ) : rows.length === 0 ? (
          <EmptyState
            title="No shared secrets"
            hint="Add one so a create on a keyed provider stops asking · hermetic secrets ls"
          />
        ) : (
          <SecretsTable
            rows={rows}
            catalog={catalog}
            onRotate={(row) => setPushing({ slot: row })}
            onDelete={setDeleting}
            onOpenProviders={onOpenProviders}
          />
        )}
      </Block>

      {pushing !== undefined ? (
        <SecretPushDrawer
          slot={pushing.slot}
          onClose={() => setPushing(undefined)}
          onPushed={written}
        />
      ) : null}
      {deleting !== null ? (
        <SecretDeleteDrawer
          slot={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            written();
          }}
        />
      ) : null}
    </SettingsPage>
  );
}
