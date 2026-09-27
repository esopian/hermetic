/**
 * Which pre-v3 SSM parameters belong to *this* fleet, and when it is safe to
 * say so (§8.2, §6.6).
 *
 * Before foundation v3 every fleet in an account wrote to the same two roots:
 * `/hermes/<agent>/…` and `/hermetic/{secrets,tailscale}/…`. v3 moved each
 * fleet under its own id, and the migration *copies* rather than moves — so an
 * upgraded account holds both shapes at once, and four different callers have
 * to answer the same two questions about the leftovers: which of them are ours,
 * and may we act on them at all.
 *
 * They are answered here, once, because the four callers disagreeing is a
 * cross-fleet data loss rather than a cosmetic drift: `teardown --purge` deletes
 * what this says, `plan teardown` promises it, the v3 migration copies it, and
 * `doctor` counts it.
 *
 * Two rules, and neither is a heuristic:
 *
 * - **Enumerate, never sweep a root.** `deleteByPrefix("/hermes/")` is
 *   recursive, so on an account whose other fleets have already taken v3 it
 *   would delete `/hermes/<their id>/…` as well. The legacy set is therefore
 *   built from this fleet's own agent table plus the two fixed fleet-level
 *   layouts, and nothing is ever addressed by root.
 * - **A first segment that names a fleet is not an agent.** An agent may
 *   legitimately be called `research`, and a fleet id is eight characters of
 *   base32 — so "does it look like an id" is a guess that misfires both ways.
 *   The directory's actual ids are the test instead.
 */
import type { DirectoryApi, FoundationApi, StackSummary } from "../backend/types.ts";
import type { DirectoryEntry } from "../schema/index.ts";
import { AGENT_PARAM_ROOT, HERMETIC_PARAM_ROOT } from "../backend/constants.ts";

/**
 * The fleet-level layouts a pre-v3 fleet wrote outside any agent's prefix: the
 * shared secret slots (§8.3) and the two halves of the Tailscale OAuth client
 * (§5). Fixed names, not a pattern — nothing else has ever lived under
 * `/hermetic/` directly.
 */
export const LEGACY_FLEET_LAYOUTS: readonly string[] = [
  `${HERMETIC_PARAM_ROOT}secrets/`,
  `${HERMETIC_PARAM_ROOT}tailscale/`,
];

/**
 * What the account looks like, from the two sources that can independently
 * disagree about it.
 *
 * `active` is `null` — and not an empty array — when the directory could not be
 * read at all. The difference decides whether anything gets deleted, so it must
 * not be expressible as "no fleets".
 */
export interface DirectoryScope {
  /** Fleets that are not torn down, or `null` when the directory was unreadable. */
  active: readonly DirectoryEntry[] | null;
  /** Every fleet id the directory lists, torn down or not; empty when unreadable. */
  fleetIds: ReadonlySet<string>;
  /** Why the read failed, for the message a caller prints; `null` when it did not. */
  error: string | null;
  /**
   * Whether both the directory *and* CloudFormation say this account holds one
   * live fleet and it is this one. `readDirectoryScope` alone cannot set it —
   * it is filled in by `readFleetScope`, which asks both.
   */
  sole: boolean;
  /** Which check said no, in words. `null` when `sole` is true. */
  reason: string | null;
}

/** Never throws: an unreadable directory is an answer here, not a failure. */
export async function readDirectoryScope(directory: DirectoryApi): Promise<DirectoryScope> {
  try {
    const entries = await directory.list();
    return {
      active: entries.filter((e) => e.status !== "torn_down"),
      fleetIds: new Set(entries.map((e) => e.fleet_id)),
      error: null,
      sole: false,
      reason: "corroboration was not attempted",
    };
  } catch (e) {
    return {
      active: null,
      fleetIds: new Set(),
      error: e instanceof Error ? e.message : String(e),
      sole: false,
      reason: null,
    };
  }
}

/**
 * The account as both sources see it, and whether this fleet is its only live
 * one — the single condition under which an untagged resource or a root-path
 * parameter can be treated as ours.
 *
 * Four checks, and each rules out a way of getting it wrong:
 *
 * - the directory was readable (an unreadable one is "cannot tell", never
 *   "yes");
 * - it lists exactly one live fleet (`<= 1` would have said yes for *zero*,
 *   which is an account whose directory has not been written yet and may hold
 *   anything);
 * - that fleet is this one;
 * - and CloudFormation agrees. The directory is an index, not the truth: a
 *   fleet created before it existed, or in an account whose table was deleted,
 *   has a stack and no entry — and it is exactly that fleet whose parameters
 *   are still sitting on the pre-v3 roots. So the stacks are counted too, and a
 *   second live one is a second fleet whatever the directory says.
 *
 * Both sources are asked and both must agree, because the failure this guards
 * is silent: nothing warns you that a `--purge` took another fleet's Tailscale
 * client until that fleet's next `agent create`.
 */
export async function readFleetScope(
  deps: { directory: DirectoryApi; foundation: FoundationApi },
  fleetId: string,
): Promise<DirectoryScope> {
  const scope = await readDirectoryScope(deps.directory);
  const no = (reason: string): DirectoryScope => ({ ...scope, sole: false, reason });

  if (scope.active === null) {
    return no(
      `the account's fleet directory could not be read (${scope.error ?? "unknown error"}), so this account cannot be shown to hold only this fleet`,
    );
  }
  if (scope.active.length === 0) {
    return no(
      "the account's fleet directory lists no live fleets, so it cannot vouch for what is on the pre-v3 paths",
    );
  }
  if (scope.active.length > 1) {
    return no(
      // §4.6: a fleet without a display alias is named by its id, never blank.
      `this account holds ${scope.active.length} live fleets (${scope.active.map((e) => e.name ?? e.fleet_id).join(", ")})`,
    );
  }
  if (scope.active[0]?.fleet_id !== fleetId) {
    return no(
      `the account's only live fleet is ${scope.active[0]?.fleet_id ?? "another one"}, not ${fleetId}`,
    );
  }

  let stacks: StackSummary[];
  try {
    stacks = await deps.foundation.listStacks();
  } catch (e) {
    return no(
      `CloudFormation could not be asked which fleets this account holds (${e instanceof Error ? e.message : String(e)}), so the directory's answer is uncorroborated`,
    );
  }
  if (stacks.length !== 1) {
    return no(
      `the directory lists one live fleet but CloudFormation shows ${stacks.length} hermetic stack(s) (${stacks.map((s) => s.fleet_id ?? s.stack_name).join(", ") || "none"})`,
    );
  }
  if (stacks[0]?.fleet_id !== fleetId) {
    return no(
      `the one hermetic stack in this account is ${stacks[0]?.fleet_id ?? stacks[0]?.stack_name ?? "untagged"}, not ${fleetId}`,
    );
  }
  return { ...scope, sole: true, reason: null };
}

/**
 * The pre-v3 prefixes this fleet owns: one per agent name in its own table,
 * plus the two fixed fleet-level layouts.
 *
 * `agents` must be every row the fleet's table holds, destroyed ones included —
 * `destroy` sweeps an agent's slots, but a half-finished one leaves them, and
 * they are exactly what `--purge` exists to find.
 *
 * An agent whose name happens to equal a fleet id the directory lists is
 * skipped: `/hermes/<that>/` is ambiguous with that fleet's own scoped root,
 * and deleting it would take a live fleet's keys.
 */
export function legacyParamPrefixes(
  agents: readonly string[],
  scope: DirectoryScope,
): { prefixes: string[]; skipped: string[] } {
  const prefixes: string[] = [];
  const skipped: string[] = [];
  for (const agent of [...new Set(agents)].sort()) {
    if (scope.fleetIds.has(agent)) {
      skipped.push(agent);
      continue;
    }
    prefixes.push(`${AGENT_PARAM_ROOT}${agent}/`);
  }
  for (const layout of LEGACY_FLEET_LAYOUTS) {
    // Belt and braces: `secrets`/`tailscale` are not fleet-id shaped, but the
    // rule is "never address a segment a fleet answers to", not "usually".
    const first = layout.slice(HERMETIC_PARAM_ROOT.length).replace(/\/$/, "");
    if (scope.fleetIds.has(first)) {
      skipped.push(first);
      continue;
    }
    prefixes.push(layout);
  }
  return { prefixes, skipped };
}

/** Every legacy parameter of this fleet, by path. Names only — never a value (§8.3). */
export async function listLegacyParams(
  secrets: { list(prefix: string): Promise<string[]> },
  prefixes: readonly string[],
): Promise<string[]> {
  const found = new Set<string>();
  for (const prefix of prefixes) {
    for (const path of await secrets.list(prefix)) found.add(path);
  }
  return [...found].sort();
}
