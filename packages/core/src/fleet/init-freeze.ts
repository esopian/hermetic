/**
 * The config freeze at the end of `init` (§4.6): one home, one account, and the
 * row keyed by `fleet_id` that every later command trusts.
 */
import { HermeticError } from "../errors.ts";
import type { InitDeps, InitRun } from "./init-run.ts";

/**
 * The freeze of §4.6: one home, one account. Re-targeting an existing home
 * is `hermetic init --reset --yes` and nothing else — silently overwriting
 * the frozen row would undo the entire guard, because everything downstream
 * trusts it (§4.7).
 */
export async function freeze(
  deps: InitDeps,
  run: InitRun,
  fleet_id: string,
  region: string,
  name: string | null,
): Promise<void> {
  const { backend, nowIso } = deps.ctx;
  const { parsed, id, existingConfig, alias, org_id, directoryApi } = run;
  if (!deps.configStore) return;
  const profile = parsed.profile ?? existingConfig?.profile;
  if (!profile) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      "init needs the profile name to freeze into this home",
      {},
    );
  }

  const confirmedReset = parsed.reset === true && parsed.yes === true;

  /**
   * §4.6 still holds: **one home, one account**. What §4.8 changed is how
   * many *fleets* that account may have here, not how many accounts. A home
   * already frozen to another account is a re-target however the fleet is
   * named, and it is `hermetic init --reset --yes` or nothing.
   */
  const rows = (await deps.configStore.list?.()) ?? (existingConfig !== null ? [existingConfig] : []);
  const elsewhere = rows.find((r) => r.account_id !== id.account_id);
  if (elsewhere && !confirmedReset) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `this home is frozen to account ${elsewhere.account_id} · fleet ${elsewhere.fleet_id}; re-targeting is \`hermetic init --reset --yes\``,
      {
        frozen_account: elsewhere.account_id,
        frozen_fleet: elsewhere.fleet_id,
        observed_account: id.account_id,
        observed_fleet: fleet_id,
      },
    );
  }

  /**
   * §4.6: there is no *second* guard to run here any more. The local row is
   * keyed by `fleet_id`, so a write either creates a row for a fleet this
   * home did not hold or refreshes the one it did — there is no case where
   * one fleet's row is silently rebound to another fleet, which is what the
   * old name-keyed table made possible and what the check that used to sit
   * here existed to refuse. Re-targeting the *account* is still guarded,
   * immediately above, and is still `hermetic init --reset --yes`.
   */

  /**
   * The identity is re-read through the guarded client immediately before the
   * write. `resolveIdentity` ran unguarded, before anything was frozen; this
   * is the call that proves the credentials still resolve where the operator
   * was told they do (§4.7).
   */
  const confirmed = await backend.identity.callerIdentity();
  if (confirmed.account_id !== id.account_id) {
    throw new HermeticError(
      "ACCOUNT_MISMATCH",
      `credentials moved from ${id.account_id} to ${confirmed.account_id} during init; nothing was frozen`,
      { started: id.account_id, observed: confirmed.account_id },
    );
  }

  /**
   * `--reset` re-targets the *home*, not one fleet in it: it archives the
   * run log and forgets every frozen row, so the home comes out of it
   * holding exactly the fleet this init just bound and nothing else. Leaving
   * the old rows behind (as this did) meant `--reset` produced a home with
   * two fleets in it, one of them the fleet the operator had just said they
   * were done with — and a `default_fleet` pref still pointing at it.
   */
  if (parsed.reset) {
    await deps.configStore.archiveRuns?.();
    await deps.configStore.clear?.();
  }
  await deps.configStore.write({
    schema_version: 1,
    name,
    fleet_id,
    account_id: id.account_id,
    account_alias: alias,
    org_id,
    profile,
    region,
    frozen_at: nowIso(),
    frozen_by: id.arn,
  });
  /**
   * §4.8: the directory region is asked for once and remembered, so no
   * later command has to be told where the account's index lives. The
   * *effective* region, not `parsed.directory_region` — a home that took
   * the default must record the default, or a later change of default
   * would silently move it.
   */
  await deps.configStore.setDirectoryRegion?.(directoryApi.region);
  /**
   * And the default fleet, but only when this home has none. Freezing a
   * second fleet must not quietly re-point every bare command at it: that
   * is `hermetic fleet use`, which is a thing the operator does on purpose.
   */
  if (deps.configStore.setDefaultFleet) {
    const preferred =
      parsed.reset === true ? null : ((await deps.configStore.defaultFleet?.()) ?? null);
    if (preferred === null) await deps.configStore.setDefaultFleet(fleet_id);
  }
}
