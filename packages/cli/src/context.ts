/**
 * Everything a command needs: a core instance, the resolved global flags, the
 * frozen config, the header line, and the process-wide AbortSignal that Ctrl-C
 * trips (§3.2 rule 2).
 */
import type { Command } from "commander";
import { openHermetic } from "@hermetic/core";
import type { Hermetic, LocalConfig } from "@hermetic/core";
import { fixtureOptionsFromEnv } from "@hermetic/core";
import { err, headerLine, warnCredentialOverrides, type GlobalFlags } from "./io.ts";
import { annotateRun } from "./run-log.ts";
import { ValidationFailure } from "./validate.ts";
import { SKEW_QUIET_ENV, skewIsLoud, skewReport } from "./skew.ts";

export interface Ctx {
  hermetic: Hermetic;
  flags: GlobalFlags;
  /**
   * The frozen row plus what only `_fleet` knows. `fleet_name` is the fleet's
   * own name (§5) — a label since v4, when cloud-side identifiers moved to
   * `fleet_id`, and still what recognises a node built under v3 — and is `null`
   * on a fleet created before v3, which was never given one. It is not the same
   * as `name`, which is what this home calls it.
   */
  config: LocalConfig & { stack_id: string | null; fleet_name: string | null };
  /** The one-line account header, already written to stderr once. */
  header: string;
  signal: AbortSignal;
}

const controller = new AbortController();
let flags: GlobalFlags = { json: false, fixture: false, yes: false, fleet: null, fleetFlag: null };

/** Ctrl-C. One process runs one command, so one signal ends everything. */
export function abortAll(): void {
  controller.abort();
}

export function aborted(): boolean {
  return controller.signal.aborted;
}

export function signal(): AbortSignal {
  return controller.signal;
}

/** Records the flags for the command about to run, so the error path can see them. */
export function setGlobalFlags(raw: Record<string, unknown>): GlobalFlags {
  const flagFleet = fleetOption(raw["fleet"]);
  flags = {
    json: raw["json"] === true,
    fixture: raw["fixture"] === true || process.env["HERMETIC_FIXTURE"] === "1",
    yes: raw["yes"] === true,
    /**
     * `--fleet` is merged by `optsWithGlobals()` exactly as `--fixture` is, so
     * it works on either side of the subcommand. The environment is the second
     * answer and core's chain (recorded default, then the only frozen fleet)
     * the rest — which is why an absent flag stays `null` here rather than
     * being resolved to something this head guessed.
     */
    fleet: flagFleet ?? envFleet(),
    /**
     * The flag *alone*. The two are not interchangeable: `--fleet` is what this
     * invocation said, while `HERMETIC_FLEET` is what the shell has been saying
     * all session. Anything that asks "did the operator name a fleet *here*" —
     * `teardown`'s refusal to guess, the fleet recorded in the run log — must
     * read this one, or an exported variable would answer a question it was
     * never asked.
     */
    fleetFlag: flagFleet,
  };
  return flags;
}

/**
 * `--fleet ""` (or `--fleet=`) is a mistake, not an answer: the operator typed
 * the flag, so they meant to name something, and silently reading it as "no
 * fleet" would fall through to the default — the one thing `--fleet` exists to
 * prevent. Exit 2, like any other argument that failed its schema.
 */
function fleetOption(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "") {
    throw new ValidationFailure([{ path: "fleet", message: "--fleet needs a fleet name or id" }]);
  }
  return value;
}

/**
 * `HERMETIC_FLEET=` is not the same mistake: an unset-looking variable in a
 * shell profile (or a test scrubbing its environment) says nothing, and nothing
 * is what it should mean.
 */
function envFleet(): string | null {
  const value = process.env["HERMETIC_FLEET"];
  return value === undefined || value === "" ? null : value;
}

/**
 * The raw `--fleet` for a command that has not opened core yet — the same read
 * `setGlobalFlags` does, available before the `preAction` hook's flags are the
 * ones a guard can trust (a guard that runs *first* cannot wait for them).
 */
export function rawFleetFlag(cmd: Command): string | null {
  return fleetOption((cmd.optsWithGlobals() as Record<string, unknown>)["fleet"]);
}

export function globalFlags(): GlobalFlags {
  return flags;
}

let running: { command: string; args: string[] } = { command: "", args: [] };

export function setRunningCommand(command: string, args: string[]): void {
  running = { command, args };
}

export function runningCommand(): { command: string; args: string[] } {
  return running;
}

export function readFlags(cmd: Command): GlobalFlags {
  return setGlobalFlags(cmd.optsWithGlobals() as Record<string, unknown>);
}

/**
 * §6.6's quiet operator signal costs an STS call, a `_fleet` GetItem and a full
 * agents scan, so the first question is whether the command about to run has
 * any business paying for it.
 *
 * Three reasons to skip, and they are different reasons:
 *
 * - `foundation *` says it better itself, and `init` has no fleet to compare
 *   against yet.
 * - `runs`, `teardowns`, `inbox` and `config *` are **local-only**: they read SQLite and
 *   touch AWS not at all. Making `hermetic runs` wait on a network round trip
 *   to nag about something it is not doing is the worst trade in the feature.
 * - `fleet *` and `directory *` (§4.8) are about *which* fleets exist, not
 *   about the one this command opened; `fleet ls` already reports every fleet's
 *   foundation version in its own table, so paying for a second read of one of
 *   them would be both slow and redundant.
 *
 * Pure and exported so `test/foundation.test.ts` can pin the list without
 * spawning a process per entry.
 */
const LOCAL_ONLY_COMMANDS: readonly string[] = ["runs", "teardowns", "inbox"];
const SKIPPED_PREFIXES: readonly string[] = ["foundation", "config", "fleet", "directory"];

export function skipsFoundationCheck(command: string): boolean {
  if (command === "init") return true;
  // Matched as prefixes, so `inbox ack` is as local as `inbox` is.
  if (LOCAL_ONLY_COMMANDS.some((p) => command === p || command.startsWith(`${p} `))) return true;
  return SKIPPED_PREFIXES.some((p) => command === p || command.startsWith(`${p} `));
}

/**
 * How long the nag may delay the command it is annotating. A status read is a
 * courtesy; a courtesy that can hang `agent ps` on a wedged VPN until the AWS
 * SDK's own retries give up is not one. Nothing about the read is cancellable
 * downstream — `foundation.status()` takes no signal — so this bounds the
 * *wait*, not the call: the command proceeds and the orphaned promise is
 * abandoned (its rejection swallowed below, so it cannot surface later as an
 * unhandled rejection).
 */
export const FOUNDATION_CHECK_TIMEOUT_MS = 1500;

export async function warnFoundationOutdated(
  hermetic: Hermetic,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (skipsFoundationCheck(runningCommand().command)) return;
  const budget = opts.timeoutMs ?? FOUNDATION_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    /**
     * `{ hermes: false }`: the nag prints nothing about upstream Hermes, and
     * §6.6's advisory check reaches api.github.com — which is 60 requests an
     * hour, unauthenticated, and a round trip this 1.5 s budget would usually
     * lose anyway. `foundation status` and the portal are what pay for it.
     */
    const read = hermetic.foundation.status({}, { hermes: false });
    // Whatever happens to the race, this promise has an owner: an unobserved
    // rejection from the loser would take the process down at exit.
    read.catch(() => undefined);
    const status = await Promise.race([
      read,
      new Promise<null>((resolve) => {
        // Already aborted: `addEventListener` would never fire again, so a
        // Ctrl-C that landed before this call would wait out the whole budget.
        if (opts.signal?.aborted) {
          resolve(null);
          return;
        }
        timer = setTimeout(() => resolve(null), budget);
        // Ctrl-C during the read: stop waiting now rather than at the deadline.
        opts.signal?.addEventListener("abort", () => resolve(null), { once: true });
      }),
    ]);
    // Timed out, or aborted. Say nothing: the operator asked for a command, not
    // for a report on why its footnote is late.
    if (status === null) return;
    /**
     * §6.6: one vocabulary, computed in core and rendered here. The nag this
     * replaced said only that an update existed. What an operator needs to know
     * first is that the build in their hand and the fleet it is pointed at
     * disagree, and that some things will therefore not behave as documented —
     * the version numbers are still in it, as the headline, but they are no
     * longer the whole message.
     */
    for (const line of skewReport(status.skew, {
      loud: skewIsLoud(runningCommand().command),
      quiet: process.env[SKEW_QUIET_ENV] === "1",
    })) {
      await err(`${line}\n`);
    }
  } catch {
    /* §6.6: never fails the command it is only annotating. */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Opens core and prints the header. Every command starts here, so the target
 * account is on stderr before anything else happens (§4.7).
 */
export async function openCtx(cmd: Command): Promise<Ctx> {
  const resolved = readFlags(cmd);
  const hermetic = await openHermetic({
    fixture: resolved.fixture,
    ...(resolved.fixture ? { fixtureOptions: fixtureOptionsFromEnv(process.env) } : {}),
    ...(resolved.fleet !== null ? { fleet: resolved.fleet } : {}),
  });
  /**
   * §4.6: the run log's row was opened before this, when all anyone knew was
   * what the operator typed. Core has now resolved the target — through an
   * alias, `HERMETIC_FLEET`, the persisted default or the only fleet there is —
   * so the row is stamped with the identity it was actually against. A command
   * that failed *before* here never resolved one, and its row stays as it was:
   * unattributed, which is the truth about it.
   */
  annotateRun(hermetic.target);
  await warnCredentialOverrides();
  const config = await hermetic.config.show();
  const header = headerLine(config, resolved.fixture);
  await err(`${header}\n`);
  await warnFoundationOutdated(hermetic, { signal: signal() });
  return { hermetic, flags: resolved, config, header, signal: signal() };
}
