/**
 * `fleets.list`, `fleets.use` and `directory.status` (§4.8): the three reads and
 * one write that make "which fleets are there" answerable without opening any
 * of them.
 *
 * Its own module with an explicit deps object, for the reason `plans.ts` and
 * `teardown.ts` are (AGENTS.md rule 5): nothing here shares the lifecycle's
 * closure — no locks, no transitions, no rendering — and `hermetic.ts` is at
 * the size where a new surface belongs beside it rather than inside it.
 *
 * The shape of the answer matters more than the calls behind it. A fleet can be
 * frozen locally and unknown to the directory (an older fleet, or a directory
 * that has never been written), known to the directory and not frozen here (a
 * teammate's fleet, which this laptop can *see* but not command), or both. One
 * row per `fleet_id` either way — never per alias, which is optional, mutable
 * and owned by the directory — with `local`/`registered` saying which, because
 * a head that showed only the intersection would hide exactly the two states an
 * operator needs to act on.
 */
import { DEFAULT_DIRECTORY_REGION } from "../schema/directory.ts";
import { FleetsAliasInput, FleetsUseInput } from "../schema/requests.ts";
import type {
  DirectoryEntry,
  DirectoryStatus,
  FleetListEntry,
  FleetsListResult,
  LocalConfig,
} from "../schema/index.ts";
import { HermeticError, isHermeticError } from "../errors.ts";
import type { ConfigStore } from "../hermetic.ts";
import type { Backend } from "../backend/types.ts";

/** What `safeParse` answers with, without naming a zod version in a signature. */
type SafeParseLike<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };

export interface FleetsDeps {
  backend: Backend;
  /** The fleet this `Hermetic` was opened as; `null` before `init`. */
  config: LocalConfig | null;
  /** The local `fleets` table. Absent in tests and the pre-init instance. */
  configStore?: ConfigStore | undefined;
  /** `FOUNDATION_VERSION` this build ships: what "behind" is measured against. */
  foundationVersion: number;
}

export function createFleets(deps: FleetsDeps) {
  const { backend, configStore } = deps;

  /** The rows this home has frozen — its own config included, store or not. */
  async function localConfigs(): Promise<LocalConfig[]> {
    const listed = configStore?.list ? await configStore.list() : null;
    if (listed && listed.length > 0) return listed;
    return deps.config ? [deps.config] : [];
  }

  /** `prefs.default_fleet`: a `fleet_id`, or null when this home has chosen none. */
  async function defaultFleetId(): Promise<string | null> {
    if (!configStore?.defaultFleet) return null;
    return configStore.defaultFleet();
  }

  /**
   * §4.8. The union of both halves, one entry per `fleet_id`, sorted so the fleet the
   * caller is standing in comes first — a list whose first line is "you are
   * here" reads as an answer rather than as a table to search.
   *
   * A directory that cannot be read is *reported*, not thrown: `fleet ls` is
   * the command an operator reaches for when they are not sure what they have,
   * and answering "the local half is this, and the directory said X" is more
   * useful than refusing. The account guard applies to the directory half only
   * (it is an AWS read); with nothing frozen there is no account to guard, so
   * that half is skipped and said to be skipped.
   */
  async function list(): Promise<FleetsListResult> {
    const locals = await localConfigs();
    const preferred = await defaultFleetId();
    const current = deps.config?.fleet_id ?? null;

    let entries: DirectoryEntry[] = [];
    let directory_error: string | null = null;
    let region = DEFAULT_DIRECTORY_REGION;
    if (locals.length === 0) {
      directory_error = "not initialized";
    } else if (deps.config === null) {
      /**
       * §4.8: a home with rows but no *selected* fleet — a portal that booted
       * into `FLEET_REQUIRED`, which is exactly the moment it needs to draw a
       * picker. There is no chosen fleet to run the account guard against, so
       * the directory half is skipped and said to be skipped; the local half is
       * the whole point of the call and is answered in full.
       */
      directory_error = "no fleet selected";
    } else {
      try {
        region = backend.directory.region;
        entries = await backend.directory.list();
      } catch (e) {
        directory_error = isHermeticError(e) ? e.message : e instanceof Error ? e.message : String(e);
      }
    }

    const ids = new Set<string>([...locals.map((c) => c.fleet_id), ...entries.map((e) => e.fleet_id)]);
    const fleets: FleetListEntry[] = [...ids].map((fleet_id) => {
      const local = locals.find((c) => c.fleet_id === fleet_id) ?? null;
      const registered = entries.find((e) => e.fleet_id === fleet_id) ?? null;
      const foundation_version = registered?.foundation_version ?? null;
      const status = registered?.status ?? null;
      return {
        name: registered ? registered.name : (local?.name ?? null),
        fleet_id,
        account_id: local?.account_id ?? registered?.account_id ?? null,
        region: local?.region ?? registered?.region ?? null,
        local: local !== null,
        registered: registered !== null,
        default: preferred === fleet_id,
        current: current === fleet_id,
        status,
        foundation_version,
        // Only a fleet that is still here can be behind (§6.6): a torn-down one
        // has nothing left to update, and offering it `foundation update` would
        // be offering to update something into nonexistence.
        update_available:
          status === "active" && foundation_version !== null
            ? foundation_version < deps.foundationVersion
            : false,
        updated_at: registered?.updated_at ?? null,
      };
    });

    fleets.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.default !== b.default) return a.default ? -1 : 1;
      return (a.name ?? a.fleet_id ?? "").localeCompare(b.name ?? b.fleet_id ?? "");
    });

    return { directory_region: region, directory_error, fleets };
  }

  /**
   * Core validates its own input (§3.2): the heads validate with the same
   * schema before they call, but a caller holding the SDK directly has no head
   * in front of it, and `FleetName`'s shape is not a rule a head may be the
   * only keeper of. The refusal carries which fields were wrong and never the
   * values (§8.3).
   */
  function parse<T>(
    schema: { safeParse(v: unknown): SafeParseLike<T> },
    input: unknown,
    what: string,
  ): T {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    throw new HermeticError("VALIDATION", `${what} input does not validate`, {
      issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    });
  }

  /** How a fleet is spelled back to an operator: the id, with its alias beside it. */
  function describe(rows: readonly LocalConfig[]): string {
    return rows.map((c) => (c.name ? `${c.fleet_id} (${c.name})` : c.fleet_id)).join(", ") || "(none)";
  }

  /**
   * `hermetic fleet use <fleet-id|alias>` (§4.8). Local only, and deliberately
   * so: it records which of *this laptop's* fleets a bare command means, and a
   * fleet this home has not frozen has no credentials, no region and no stack
   * here to mean. `init --attach --fleet <id>` is how one is added, which is
   * what the refusal says.
   *
   * What is *recorded* is always the `fleet_id`: an alias is a label another
   * laptop may reassign at any moment, and a default that had to be re-resolved
   * through the directory on every command would make "which fleet does a bare
   * command mean" a question with a network answer.
   */
  async function use(input: { fleet: string }): Promise<{ fleet_id: string; previous: string | null }> {
    // The SDK is the surface (§1): a caller that reaches `Hermetic` directly
    // gets the same validation a CLI flag or an HTTP body does, rather than the
    // heads being the only thing between core and a malformed request.
    const asked = parse(FleetsUseInput, input, "fleet use").fleet;
    const locals = await localConfigs();
    /**
     * The id first, exactly as `matchFleet` does for `--fleet`, so the two
     * cannot drift: an id is what the fleet *is*, and it resolves without
     * asking the account anything.
     */
    let found = locals.find((f) => f.fleet_id === asked) ?? null;
    if (found === null) {
      /**
       * Only then the alias — and from the *directory*, never from the local
       * cache, because another laptop may have moved the label since this home
       * last read it. A cached alias is good enough to display and never good
       * enough to select with.
       */
      let remote: DirectoryEntry[];
      try {
        remote = await backend.directory.list();
      } catch {
        throw new HermeticError(
          "DIRECTORY_UNAVAILABLE",
          `cannot resolve fleet alias "${asked}" while the directory is unavailable; use the fleet id`,
          { alias: asked },
        );
      }
      /**
       * A tombstoned row keeps its alias reserved (§4.7) so the label cannot be
       * recycled onto another fleet — but it must never *select* one. Skipping
       * it here is what stops `fleet use staging` quietly landing on the fleet
       * that used to be called `staging`.
       */
      const entry = remote.find((e) => e.name === asked && e.status !== "torn_down") ?? null;
      if (entry !== null) {
        found = locals.find((f) => f.fleet_id === entry.fleet_id) ?? null;
        if (found === null) {
          throw new HermeticError(
            "NOT_FOUND",
            `the alias "${asked}" belongs to fleet ${entry.fleet_id}, which is not frozen in this home; run \`hermetic init --attach --fleet ${entry.fleet_id}\` first`,
            { alias: asked, fleet_id: entry.fleet_id },
          );
        }
      }
    }
    if (found === null) {
      throw new HermeticError(
        "NOT_FOUND",
        `fleet "${asked}" is not frozen in this home; known: ${describe(locals)}. Use \`hermetic init --attach --fleet ${asked}\` to add it.`,
        {
          fleet: asked,
          known_ids: locals.map((c) => c.fleet_id),
          known_aliases: locals.map((c) => c.name ?? null),
        },
      );
    }
    const fleet_id = found.fleet_id;
    if (!configStore?.setDefaultFleet) {
      throw new HermeticError(
        "UNSUPPORTED",
        "this hermetic home cannot record a default fleet; it has no local database",
        { fleet: fleet_id },
      );
    }
    const previous = await defaultFleetId();
    await configStore.setDefaultFleet(fleet_id);
    return { fleet_id, previous };
  }

  /**
   * `hermetic fleet alias <fleet-id> <alias>` / `--clear` (§4.8): the one write
   * that changes what a fleet is *called*, and nothing else about it.
   *
   * The target is a `fleet_id` and only a `fleet_id`. Every other command takes
   * either spelling, and this one deliberately does not: renaming by the name
   * that is being replaced is how an operator reassigns the wrong fleet's
   * label, and the mutation target has to be the thing that cannot move.
   *
   * The directory is the register of record, so the conditional write there is
   * what decides; the local row's `name` is a display cache and is refreshed
   * only once that write has been won. Uniqueness spans torn-down rows too —
   * their reservations survive teardown so an old label cannot silently start
   * meaning a different fleet.
   */
  async function alias(input: {
    fleet: string;
    alias?: string;
    clear?: boolean;
  }): Promise<DirectoryEntry> {
    const parsed = parse(FleetsAliasInput, input, "fleet alias");
    const clearing = parsed.clear === true;
    const locals = await localConfigs();
    const local = locals.find((f) => f.fleet_id === parsed.fleet) ?? null;
    if (!local) {
      throw new HermeticError(
        "NOT_FOUND",
        `fleet "${parsed.fleet}" is not frozen in this home; known: ${describe(locals)}. An alias is set by fleet id, never by the label it replaces.`,
        { fleet: parsed.fleet, known_ids: locals.map((c) => c.fleet_id) },
      );
    }
    const entry = await backend.directory.get(local.fleet_id);
    if (!entry) {
      throw new HermeticError(
        "NOT_FOUND",
        `fleet ${local.fleet_id} is not registered in the account's directory, so it has no alias to change`,
        { fleet_id: local.fleet_id },
      );
    }
    const next: DirectoryEntry = {
      ...entry,
      name: clearing ? null : (parsed.alias ?? null),
      updated_at: deps.backend.clock.now().toISOString(),
      updated_by: local.frozen_by,
    };
    /**
     * The expectation the conditional write is made against is the alias this
     * call *read*, not the one the directory happens to hold a moment later —
     * so the window the guard covers is the whole of this function rather than
     * the two lines inside `update()`. Losing it means somebody else wrote to
     * this fleet in between.
     */
    if (!(await backend.directory.update(next, { alias: entry.name }))) {
      throw await aliasWriteFailure(local.fleet_id, next.name);
    }
    // Cache only after the authoritative write; a stale cache is harmless
    // because nothing ever *selects* by it.
    if (configStore?.write) await configStore.write({ ...local, name: next.name });
    return next;
  }

  /**
   * Why a conditional alias write lost, asked rather than assumed.
   *
   * `update()` answers with one `false` for two different situations: the label
   * belongs to somebody else, or this fleet's row moved between the read and
   * the write. They have different fixes — pick another label, versus run the
   * command again — so the directory is re-read to tell them apart instead of
   * reporting the first as if it were always the cause. Clearing a label can
   * only ever be the second, since there is no label to be taken.
   */
  async function aliasWriteFailure(fleetId: string, wanted: string | null): Promise<HermeticError> {
    const raced = new HermeticError(
      "CONFLICT",
      `the directory entry for fleet ${fleetId} changed while its alias was being written; read it again and retry`,
      { fleet_id: fleetId, ...(wanted === null ? {} : { alias: wanted }) },
    );
    if (wanted === null) return raced;
    const taken = new HermeticError(
      "NAME_TAKEN",
      `the alias "${wanted}" is already held in this account's fleet directory; aliases stay reserved after a teardown, so clear it on the fleet that holds it first`,
      { alias: wanted, fleet_id: fleetId },
    );
    try {
      const holder = (await backend.directory.list()).find(
        (e) => e.name === wanted && e.fleet_id !== fleetId,
      );
      return holder ? taken : raced;
    } catch {
      /**
       * The re-read failed too. "Somebody holds that label" is the cause this
       * write loses to in every case anyone has seen, and it is the only one of
       * the two with an action attached, so it is what gets reported — rather
       * than inventing certainty about a directory that just refused to answer.
       */
      return taken;
    }
  }

  /** §4.8: the table itself — where it is, how it is billed, how far back it can be recovered. */
  async function status(): Promise<DirectoryStatus> {
    return backend.directory.status();
  }

  return { list, use, alias, status };
}
