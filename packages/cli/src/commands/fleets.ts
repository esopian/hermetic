/**
 * `hermetic fleet ls`, `hermetic fleet use <fleet-id|alias>`, `hermetic fleet
 * alias <fleet-id> <alias>` and `hermetic directory status` (§4.8): the
 * commands about *which* fleets there are, as opposed to what is inside one.
 *
 * Separate from `commands/fleet.ts`, which owns the fleet-wide reads and the
 * teardown of the fleet you are standing in. The names are one letter apart on
 * purpose: everything there is about *this* fleet, everything here is about the
 * set of them.
 *
 * These are also the only commands that must work when no fleet has been
 * chosen. "Which fleets do I have?" and "make this one the default" are exactly
 * the questions an operator asks when `NOT_INITIALIZED` or `FLEET_REQUIRED` is
 * what every other command just told them, so `openFleetsCtx` opens core
 * without a chosen fleet rather than refusing — see its comment.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { existsSync } from "node:fs";
import {
  HermeticError,
  dbPath,
  hasCode,
  listConfigs,
  openForInit,
  openHermetic,
  openLocalDb,
} from "@hermetic/core";
import type { DirectoryEntry, DirectoryStatus, FleetsListResult, Hermetic } from "@hermetic/core";
import {
  DirectoryStatusInput,
  FleetsAliasInput,
  FleetsListInput,
  FleetsUseInput,
} from "@hermetic/core";
import { openCtx, readFlags } from "../context.ts";
import { globals } from "../options.ts";
import { validate } from "../validate.ts";
import { err, out, outJson, type GlobalFlags } from "../io.ts";
import { renderTable } from "../table.ts";
import { declare } from "../declare.ts";

const listSchema = declare("fleets.list", "fleet ls", FleetsListInput);
const useSchema = declare("fleets.use", "fleet use", FleetsUseInput);
const aliasSchema = declare("fleets.alias", "fleet alias", FleetsAliasInput);
const directorySchema = declare("directory.status", "directory status", DirectoryStatusInput);

interface FleetsCtx {
  hermetic: Hermetic;
  flags: GlobalFlags;
  /**
   * Whether core was opened *as* a fleet. False when nothing is frozen here, or
   * when several are and the invocation named none — in which case no row is
   * `current`, and this is what says so.
   */
  chosen: boolean;
  close(): void;
}

/**
 * Every `fleet_id` frozen in this home, read straight from the local database
 * and nothing else: no AWS client, no account guard, no directory. It is the
 * one question that has to be answerable *before* a fleet has been chosen —
 * which is exactly when it is asked, by the two callers below.
 *
 * Ids, never aliases: an alias is optional (a fleet may have none at all) and
 * mutable (another laptop may move it), and both of those make it the wrong
 * thing to pin a session to or to gate a teardown on.
 *
 * `existsSync` first, because a home that has never run `init` must not gain a
 * database from being asked what is in it (the same bargain `openForInit`
 * makes). A database that cannot be read at all answers "none": these are
 * guards and fallbacks, and neither is improved by turning a broken file into
 * a second failure on top of the one the command is already reporting.
 */
export function frozenFleetIds(flags: Pick<GlobalFlags, "fixture">): string[] {
  const home = process.env["HERMETIC_HOME"];
  const opts = { ...(home !== undefined ? { home } : {}), fixture: flags.fixture };
  if (!existsSync(dbPath(home, { fixture: flags.fixture }))) return [];
  let local: ReturnType<typeof openLocalDb> | null = null;
  try {
    local = openLocalDb(opts);
    return listConfigs(local.db)
      .map((c) => c.fleet_id)
      .sort();
  } catch {
    return [];
  } finally {
    local?.close();
  }
}

/**
 * `openCtx` first, because when there is a fleet these commands should behave
 * exactly like every other one — same header, same guards. Two refusals are
 * then answered rather than propagated:
 *
 * - `NOT_INITIALIZED` — nothing frozen at all. `openForInit` is the same door
 *   `init` uses before a config exists; `fleets.list` on it reports the empty
 *   local half and `directory_error: "not initialized"` for the other.
 * - `FLEET_REQUIRED` — several fleets, and none named. There is no fleet to
 *   open, but the *directory* is account-global (one home is one account,
 *   §4.6), so core is pinned to one of the frozen fleets purely to have
 *   credentials to read it with. Which one is read from the local database
 *   (`frozenFleetIds`), not from the error's `details` — a thrown object's
 *   untyped bag is a poor thing to branch on, and the answer is a query away.
 *   Nothing is `current` in that case and the caller blanks the flag, because
 *   the operator chose nothing and a table claiming otherwise would be
 *   answering a question they did not ask.
 *
 * Both fallbacks still print a header, because a command whose output depends
 * on which account answered may not be the one command that says nothing about
 * it — it just cannot name a fleet, and says that instead.
 */
async function openFleetsCtx(cmd: Command): Promise<FleetsCtx> {
  try {
    const ctx = await openCtx(cmd);
    return { hermetic: ctx.hermetic, flags: ctx.flags, chosen: true, close: () => {} };
  } catch (e) {
    const flags = readFlags(cmd);
    if (hasCode(e, "FLEET_REQUIRED")) {
      const pinned = frozenFleetIds(flags)[0];
      if (pinned !== undefined) {
        const hermetic = await openHermetic({ fixture: flags.fixture, fleet: pinned });
        await errUnchosenHeader(hermetic, flags);
        return { hermetic, flags, chosen: false, close: () => {} };
      }
    }
    if (hasCode(e, "NOT_INITIALIZED")) {
      const session = await openForInit({ fixture: flags.fixture });
      await err("▸ (not initialized)\n");
      return { hermetic: session.hermetic, flags, chosen: false, close: () => session.close() };
    }
    throw e;
  }
}

/**
 * §4.7's header line, with the one field it cannot fill. The account, region
 * and profile are the pinned fleet's, and they are the same for every fleet in
 * this home; the fleet name is the part nothing chose, so it says so rather
 * than naming the fleet that happened to be pinned.
 */
async function errUnchosenHeader(hermetic: Hermetic, flags: GlobalFlags): Promise<void> {
  const config = await hermetic.config.show();
  const who = config.account_alias ?? config.profile;
  const line = `▸ (no fleet chosen) · ${who} · ${config.account_id} · ${config.region} · profile ${config.profile}`;
  await err(`${flags.fixture ? `${line} · FIXTURE` : line}\n`);
}

const dash = (value: string | null): string => value ?? "—";

/** `v3`, and — for a fleet the directory says is behind this build — why it matters. */
function foundationCell(version: number | null, updateAvailable: boolean): string {
  if (version === null) return "—";
  return `v${version}${updateAvailable ? " (update available)" : ""}`;
}

export function renderFleets(result: FleetsListResult): string {
  const rows = result.fleets.map((f) => [
    // §4.6: the alias is optional, so the id is the display fallback. Never
    // blank, and never the word "unnamed" — the id is what the fleet is called
    // when nobody has called it anything else.
    `${f.current ? "*" : " "}${f.name ?? f.fleet_id ?? "—"}`,
    dash(f.fleet_id),
    dash(f.region),
    dash(f.status),
    foundationCell(f.foundation_version, f.update_available),
    f.local ? "yes" : "no",
    f.default ? "*" : "",
  ]);
  return renderTable(rows, [" NAME", "FLEET_ID", "REGION", "STATUS", "FOUNDATION", "LOCAL", "DEFAULT"]);
}

/** The directory table itself: where it is, how it is billed, how far back it goes. */
export function renderDirectory(status: DirectoryStatus): string {
  const rows: string[][] = [
    ["region", status.region],
    ["table", status.table],
    ["exists", status.exists ? "yes" : "no"],
    ["billing", dash(status.billing_mode)],
    [
      "point-in-time recovery",
      status.pitr_enabled
        ? `enabled · ${status.pitr_recovery_days ?? "?"} day recovery window`
        : "disabled",
    ],
    ["deletion protection", status.deletion_protection ? "on" : "off"],
    ["items", status.item_count === null ? "—" : String(status.item_count)],
  ];
  const blocks = [renderTable(rows, ["KEY", "VALUE"])];
  if (status.fleets.length > 0) blocks.push(renderDirectoryFleets(status.fleets));
  return blocks.join("\n\n");
}

function renderDirectoryFleets(fleets: readonly DirectoryEntry[]): string {
  const rows = fleets.map((f) => [
    f.name ?? f.fleet_id,
    f.fleet_id,
    f.region,
    f.status,
    `v${f.foundation_version}`,
    f.updated_at,
  ]);
  return renderTable(rows, ["NAME", "FLEET_ID", "REGION", "STATUS", "FOUNDATION", "UPDATED"]);
}

/**
 * The directory half of `fleet ls` can fail on its own — no table yet, no
 * credentials for its region, an account that refuses the scan — and core
 * reports that rather than throwing, because the local half is still the answer
 * to half the question. The head's job is to make sure the operator sees which
 * half they got.
 */
async function warnDirectory(result: FleetsListResult): Promise<void> {
  if (result.directory_error === null) return;
  /**
   * With nothing frozen at all there is no account to ask *as*, so core skips
   * the directory half rather than failing it. Nothing was read because nothing
   * could be; the empty result below says that better than a warning about a
   * read that never happened would.
   */
  if (result.fleets.length === 0) return;
  await err(
    `warning: the fleet directory in ${result.directory_region} could not be read (${result.directory_error}); showing only what is frozen on this laptop\n`,
  );
}

/** Fleets the account knows about that this laptop cannot command, and how to fix that. */
async function hintUnfrozen(result: FleetsListResult): Promise<void> {
  const absent = result.fleets.filter((f) => f.registered && !f.local);
  if (absent.length === 0) return;
  await err(
    `\nnot frozen on this laptop:\n${absent
      .map(
        (f) =>
          `  - ${f.name ?? f.fleet_id ?? "—"} — \`hermetic init --attach --fleet ${f.fleet_id ?? "<fleet-id>"}\``,
      )
      .join("\n")}\n`,
  );
}

export function register(program: Command): void {
  const fleet = new Cmd("fleet").description(
    "the account's fleets: what exists, and which one a bare command means",
  );

  fleet.addCommand(
    globals(new Cmd("ls"))
      .description("every fleet this laptop has frozen and every fleet the account's directory knows")
      .addHelpText(
        "after",
        "\nColumns:\n" +
          "  NAME        the display alias, or the fleet id when it has none;\n" +
          "              `*` marks the fleet this command opened\n" +
          "  LOCAL       whether this laptop has the fleet frozen; only those can be commanded\n" +
          "  FOUNDATION  the version the directory recorded, and whether this build is newer\n" +
          "  DEFAULT     `*` marks what a bare command means — set it with `hermetic fleet use`\n" +
          "\nWorks with nothing frozen at all, and with several frozen and none chosen:\n" +
          "it is the command that says so. The header line then reads\n" +
          "`▸ (no fleet chosen) · …` or `▸ (not initialized)`, because there is no fleet\n" +
          "name to put in it.\n",
      )
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openFleetsCtx(cmd);
        try {
          validate(listSchema, {});
          const listed = await ctx.hermetic.fleets.list();
          // Nothing was chosen, so nothing is current — see `openFleetsCtx`.
          const result: FleetsListResult = ctx.chosen
            ? listed
            : { ...listed, fleets: listed.fleets.map((f) => ({ ...f, current: false })) };
          await warnDirectory(result);
          if (ctx.flags.json) {
            await outJson(result);
            return;
          }
          if (result.fleets.length === 0) {
            await out("no fleets: this laptop has none frozen — run `hermetic init`\n");
            return;
          }
          await out(`${renderFleets(result)}\n`);
          await hintUnfrozen(result);
        } finally {
          ctx.close();
        }
      }),
  );

  fleet.addCommand(
    globals(new Cmd("alias"))
      .description("assign, replace or clear a fleet's optional display alias")
      .argument("<fleet-id>", "the immutable fleet id; an alias is never the target of this command")
      .argument("[alias]", "the new display alias: lowercase letters, digits and hyphens, ≤31 chars")
      .option("--clear", "remove the display alias; the fleet id remains its display name")
      .addHelpText(
        "after",
        "\nA fleet is created without an alias and keeps working without one: every\n" +
          "head falls back to the fleet id. An alias is unique across the account,\n" +
          "including fleets that have been torn down — their labels stay reserved, so\n" +
          "clear the alias on the old fleet before reusing it.\n" +
          "\nExamples:\n" +
          "  hermetic fleet alias k7m2x9qa prod     call that fleet `prod`\n" +
          "  hermetic fleet alias k7m2x9qa --clear  go back to showing its id\n",
      )
      .action(
        async (fleetId: string, alias: string | undefined, opts: { clear?: boolean }, cmd: Command) => {
          const ctx = await openFleetsCtx(cmd);
          try {
            const input = validate(aliasSchema, {
              fleet: fleetId,
              ...(alias !== undefined ? { alias } : {}),
              ...(opts.clear ? { clear: true } : {}),
            });
            const result = await ctx.hermetic.fleets.alias(input);
            if (ctx.flags.json) await outJson(result);
            else await err(`fleet ${result.fleet_id} alias: ${result.name ?? "(none)"}\n`);
          } finally {
            ctx.close();
          }
        },
      ),
  );

  fleet.addCommand(
    globals(new Cmd("use"))
      .description("record which fleet a bare command means on this laptop")
      .argument(
        "<fleet-id|alias>",
        "a fleet frozen in this home, by fleet id or display alias; `hermetic fleet ls` lists both",
      )
      .addHelpText(
        "after",
        "\nLocal only: it records a preference, it does not touch the fleet or the\n" +
          "directory. What is recorded is the fleet id, so a later `fleet alias`\n" +
          "does not move the default. `--fleet <fleet-id|alias>` overrides it for one\n" +
          "command, and `HERMETIC_FLEET` for one shell.\n",
      )
      .action(async (fleet: string, _opts: unknown, cmd: Command) => {
        const ctx = await openFleetsCtx(cmd);
        try {
          const input = validate(useSchema, { fleet });
          const result = await ctx.hermetic.fleets.use(input);
          if (ctx.flags.json) await outJson(result);
          else await err(`default fleet: ${result.fleet_id} (was ${result.previous ?? "none"})\n`);
        } finally {
          ctx.close();
        }
      }),
  );

  program.addCommand(fleet);

  const directory = new Cmd("directory").description(
    "the account-global table that records every fleet (§4.8)",
  );
  directory.addCommand(
    globals(new Cmd("status"))
      .description("where the fleet directory is, how it is billed, and what it holds")
      .addHelpText(
        "after",
        "\nThe table is provisioned by `init`, not by the foundation stack: it outlives\n" +
          "every fleet in the account, which is why it carries deletion protection and a\n" +
          "point-in-time recovery window rather than backups.\n",
      )
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openFleetsCtx(cmd);
        try {
          validate(directorySchema, {});
          const status = await ctx.hermetic.directory.status();
          if (ctx.flags.json) await outJson(status);
          else await out(`${renderDirectory(status)}\n`);
        } finally {
          ctx.close();
        }
      }),
  );
  program.addCommand(directory);
}

/**
 * §4.8's safety rule, used by `teardown` and by `apply` of a teardown plan:
 * with more than one fleet frozen here, falling through to the default is not
 * good enough — the operator must name the one they mean.
 *
 * `explicit` is the **flag**, never `HERMETIC_FLEET`. An exported variable is
 * ambient: it was set once, for a shell, possibly by a script the operator has
 * forgotten, and letting it satisfy this gate would put the whole rule back
 * where it started — a foundation deleted because of something nobody typed in
 * front of the command. The environment still *selects* the fleet; it just
 * cannot be the thing that says "yes, that one, delete it".
 *
 * Local rows only, and no core instance: the guard has to be able to run before
 * anything is opened, so a bare `teardown` in a two-fleet home refuses without
 * having touched AWS at all.
 */
export function assertFleetNamedForTeardown(
  explicit: string | null,
  flags: Pick<GlobalFlags, "fixture">,
): void {
  if (explicit !== null) return;
  const frozen = frozenFleetIds(flags);
  if (frozen.length < 2) return;
  throw new HermeticError(
    "CONFIRMATION_REQUIRED",
    `two or more fleets are frozen here (${frozen.join(", ")}); teardown needs an explicit --fleet <fleet-id>`,
    { known_ids: frozen },
  );
}
