/**
 * The attach branch of `init` (§4.7 step 4): join this laptop to a fleet
 * that already exists. Runs on the far side of the confirmation gate, with the
 * directory already made; everything it needs from the run arrives in `InitRun`.
 */
import { FLEET_KEY } from "../schema/index.ts";
import type { FleetItem, OpEvent } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { FOUNDATION_VERSION } from "../version.ts";
import type { DirectoryStatus } from "../schema/index.ts";
import type { StackInfo } from "../backend/types.ts";
import type { InitDeps, InitOpOptions, InitRun } from "./init-run.ts";
import { evt } from "../events.ts";
import { checkAbort } from "../abort.ts";
import { directoryEntry, registerFleet } from "./init-directory.ts";
import { ensureRelease, locateHermeticd } from "./init-release.ts";
import { freeze } from "./init-freeze.ts";

/** Attach to `existing`, the stack `resolveTarget` chose; `directory` is the table as `ensureDirectory` left it. */
export async function* attach(
  deps: InitDeps,
  run: InitRun,
  opts: InitOpOptions,
  existing: StackInfo,
  directory: DirectoryStatus,
): AsyncIterable<OpEvent> {
  const { localTailscale } = deps;
  const { backend, nowIso } = deps.ctx;
  const { parsed, id, directoryApi } = run;
  const stored = await backend.store.fleet.get();
  if (!stored) {
    throw new HermeticError("FLEET_MISMATCH", `the stack exists but the ${FLEET_KEY} item does not`);
  }
  const fleet: FleetItem = stored;
  if (fleet.fleet_id !== existing.tags["fleet_id"]) {
    throw new HermeticError("FLEET_MISMATCH", `the stack tag and the ${FLEET_KEY} item disagree`, {
      stack_tag: existing.tags["fleet_id"] ?? null,
      fleet_item: fleet.fleet_id,
    });
  }
  /**
   * §6.6: the fleet's foundation is on a contract this build does not know.
   * Attaching would freeze a home whose every command applies an older
   * template's assumptions to a newer foundation — and whose `foundation
   * update` would try to roll it *back*. Upgrading hermetic is the fix, and
   * it is the only one, so this refuses rather than warns.
   */
  const fleetFoundation = fleet.foundation_version ?? 0;
  if (fleetFoundation > FOUNDATION_VERSION) {
    throw new HermeticError(
      "FOUNDATION_NEWER",
      `fleet ${fleet.fleet_id} is on foundation v${fleetFoundation} but this build of hermetic only knows v${FOUNDATION_VERSION}; upgrade hermetic and attach again`,
      { fleet: fleetFoundation, tool: FOUNDATION_VERSION },
    );
  }
  /**
   * Attach is the new-machine, corrupt-state and new-teammate path —
   * the one an operator reaches for when something is already wrong — so a
   * laptop that is not on the tailnet is reported and not refused. The
   * fleet already exists; nothing this call does makes it less reachable.
   */
  const preflight = await localTailscale();
  if (!preflight.ok) {
    yield evt(
      "preflight",
      0.6,
      `${preflight.problem ?? "tailscale is not usable on this machine"}; this fleet is reachable only over its tailnet`,
      nowIso(),
      "warn",
    );
  } else if (fleet.tailnet && preflight.tailnet && fleet.tailnet !== preflight.tailnet) {
    yield evt(
      "preflight",
      0.6,
      `this fleet is on ${fleet.tailnet} but this machine is on ${preflight.tailnet}; you will not reach its agents`,
      nowIso(),
      "warn",
    );
  }
  /**
   * §4.6/§4.8: attach joins this laptop to a fleet. It never relabels one.
   *
   * The fleet is looked up by its `fleet_id` — the one identifier that
   * survives everything — and whatever display alias the directory has for
   * it is taken as read. A team that calls this fleet `prod` does not stop
   * calling it `prod` because somebody joined from a new machine; changing
   * the label is `hermetic fleet alias`, a deliberate act of its own.
   *
   * A fleet the directory does not know is one created before the directory
   * existed, or in an account whose table was deleted. It is registered
   * here with **no** alias: this command has no business inventing a name
   * for a fleet, and an aliasless fleet displays as its id everywhere
   * (§4.6), which is exactly what an operator attaching by id already typed.
   */
  const known = directory.fleets.find((e) => e.fleet_id === fleet.fleet_id) ?? null;
  const attachName = known?.name ?? null;
  if (known === null) {
    await registerFleet(
      directoryApi,
      directoryEntry(id, nowIso, {
        name: null,
        fleet_id: fleet.fleet_id,
        region: fleet.region,
        stack_id: existing.stack_id,
        foundation_version: fleet.foundation_version ?? 0,
        tailnet: fleet.tailnet ?? null,
        created_at: fleet.created_at,
        created_by: fleet.created_by,
      }),
    );
  }
  yield evt(
    "directory",
    0.68,
    known
      ? `the directory knows fleet ${fleet.fleet_id}${attachName ? ` as "${attachName}"` : ""}`
      : `registered fleet ${fleet.fleet_id} in the directory with no display alias; \`hermetic fleet alias ${fleet.fleet_id} <alias>\` gives it one`,
    nowIso(),
  );
  /**
   * `_fleet.fleet_name` is deliberately *not* touched here (§6.1). Since v4
   * it names no cloud resource — `cloudName` is keyed on `fleet_id` — and
   * the one job it still has is to let `legacyCloudNames` recognise a node
   * built under v3, which wears the name the fleet had *then*. Rewriting it
   * from a current display alias would make those nodes look like another
   * fleet's, so it stays exactly as the fleet that built them left it.
   */
  yield evt(
    "attach",
    0.7,
    `attached to fleet ${fleet.fleet_id}${attachName ? ` as "${attachName}"` : ""}`,
    nowIso(),
  );
  const hermeticd = yield* locateHermeticd(deps, parsed.skip_artifacts === true, false);
  yield* ensureRelease(deps, id, 0.85, hermeticd, parsed.skip_artifacts === true, fleet, existing);
  checkAbort(opts.signal, "freeze");
  // The row is keyed by `fleet_id`, so re-attaching to a fleet this home
  // already holds updates it in place — including its cached alias, which
  // the directory may have changed since this laptop last looked.
  await freeze(deps, run, fleet.fleet_id, fleet.region, attachName);
  yield evt(
    "done",
    1,
    `hermetic home bound to fleet ${fleet.fleet_id} — ${id.account_id} · ${fleet.region}`,
    nowIso(),
  );
  return;
}
