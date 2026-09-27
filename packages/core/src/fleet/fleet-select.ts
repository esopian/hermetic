/**
 * Which fleet a command is about (§4.8).
 *
 * A home may freeze more than one fleet, so every entrypoint has to answer the
 * same question before it opens anything: *which one*. The rule is one
 * precedence chain — what the operator said now, then what their environment
 * says, then what they chose last, then the only one there is — and hermetic
 * refuses rather than guessing when none of those answers.
 *
 * What comes back is always a `fleet_id`. The alias is a mutable display label
 * an operator may reassign between two runs of the same script (§4.6), so it is
 * accepted as *input* and never used as an answer: everything downstream — the
 * local `fleets` rows, `prefs.default_fleet`, the run log, the portal's poller
 * keys — is keyed by the id.
 *
 * Pure and dependency-free on purpose: `open.ts` runs it against SQLite rows,
 * the heads run it against whatever they have, and the refusals are the same
 * sentences in both. Nothing here reads the environment itself — the caller
 * passes `env`, so a test never has to mutate `process.env` to describe a
 * laptop.
 */
import { HermeticError } from "../errors.ts";

export interface ResolveFleetInput {
  /** `--fleet <id|alias>`, or the portal's active fleet. Wins over everything. */
  explicit?: string | null | undefined;
  /** `HERMETIC_FLEET`. */
  env?: string | null | undefined;
  /** `prefs.default_fleet`, a `fleet_id`, honoured only while that row still exists. */
  defaultFleet?: string | null | undefined;
  /** Every fleet frozen in this home, by the two things it answers to. */
  fleets: readonly { name?: string | null; fleet_id: string }[];
}

/**
 * Which frozen fleet a token means, or `null` for none.
 *
 * `fleet_id` is tried before the alias because the id is the fleet's identity
 * and the alias is a label over it (§4.8): a home that has attached fleet
 * `k7m2x9qa` under the alias `staging` and separately holds a fleet whose
 * *alias* is `k7m2x9qa` would otherwise resolve the id to the wrong one. An id
 * is eight characters of Crockford base32 and an alias may legally be the same
 * eight characters, so the collision is possible rather than merely
 * theoretical, and identity wins.
 */
export function matchFleet<T extends { name?: string | null; fleet_id: string }>(
  fleets: readonly T[],
  token: string,
): T | null {
  return fleets.find((f) => f.fleet_id === token) ?? fleets.find((f) => f.name === token) ?? null;
}

/**
 * How a fleet is named back to an operator who typed something that missed.
 * The id is always there; the alias, when it exists, is the parenthetical —
 * never the other way round, because the id is what they can type back.
 */
function describe(fleets: readonly { name?: string | null; fleet_id: string }[]): string {
  return fleets.map((f) => (f.name ? `${f.fleet_id} (${f.name})` : f.fleet_id)).join(", ");
}

/**
 * `explicit > HERMETIC_FLEET > prefs.default_fleet > the only frozen row > error`.
 *
 * Each of the first three may be either a `fleet_id` or a display alias — the
 * id is what a fleet *is* and the alias is a label an operator may change, so
 * both address it and the id is authoritative when the two disagree (§4.6). The
 * value returned is always the **`fleet_id`**, because that is what this home
 * keys its `fleets` rows, its `default_fleet` pref and its run log on.
 *
 * - no frozen rows at all → `NOT_INITIALIZED`
 * - a token that is neither an id nor an alias here → `NOT_FOUND`, naming what is
 * - two or more, and nothing chose → `FLEET_REQUIRED`, naming them
 */
export function resolveFleetId(input: ResolveFleetInput): string {
  const fleets = [...input.fleets];
  if (fleets.length === 0) {
    throw new HermeticError(
      "NOT_INITIALIZED",
      "this hermetic home has no frozen config; run `hermetic init`",
    );
  }

  const asked = input.explicit ?? input.env ?? null;
  if (asked !== null && asked !== "") {
    const found = matchFleet(fleets, asked);
    if (found === null) {
      throw new HermeticError(
        "NOT_FOUND",
        `fleet "${asked}" is not frozen in this home; known: ${describe(fleets)}. Use \`hermetic init --attach --fleet ${asked}\` to add it.`,
        {
          fleet: asked,
          known_ids: fleets.map((f) => f.fleet_id),
          known_aliases: fleets.map((f) => f.name ?? null),
        },
      );
    }
    return found.fleet_id;
  }

  /**
   * A default that names a fleet this home no longer holds is stale, not an
   * error: `teardown --reset-local` removes the row and may or may not have
   * cleared the pref, and the operator asking for "whatever I use normally"
   * should fall through to the rest of the chain rather than be refused.
   */
  const preferred = input.defaultFleet ?? null;
  const chosen = preferred === null || preferred === "" ? null : matchFleet(fleets, preferred);
  if (chosen !== null) return chosen.fleet_id;

  if (fleets.length === 1) return fleets[0]!.fleet_id;

  throw new HermeticError(
    "FLEET_REQUIRED",
    `more than one fleet is frozen here and none is the default; pass --fleet or run \`hermetic fleet use\` (known: ${describe(fleets)})`,
    {
      known_ids: fleets.map((f) => f.fleet_id),
      known_aliases: fleets.map((f) => f.name ?? null),
    },
  );
}
