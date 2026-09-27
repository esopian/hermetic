/**
 * `init`'s dealings with the account's fleet directory (§4.8) and with which of
 * the account's foundations a run is about: the region the directory lives in,
 * looking at it before the gate and making it after, resolving `--fleet` to a
 * stack, and registering the fleet this run attached to or created.
 */
import { STACK_NAME } from "../schema/index.ts";
import type { DirectoryEntry, DirectoryStatus } from "../schema/index.ts";
import { HermeticError, isHermeticError } from "../errors.ts";
import { FLEET_ID_TAG } from "../backend/constants.ts";
import { HERMETIC_VERSION } from "../version.ts";
import type {
  Backend,
  CallerIdentity,
  DirectoryApi,
  StackInfo,
  StackSummary,
} from "../backend/types.ts";
import type { InitDeps, InitRun } from "./init-run.ts";

/**
 * §4.8: which region the account's directory lives in.
 *
 * One table per account, so the answer is given once — at `init` — and
 * remembered. A *second* init that names a different one is refused rather
 * than obeyed: it would create a second directory and leave the account
 * with two partial registers of which fleets exist, which is worse than
 * either of them alone.
 */
export function resolveDirectoryApi(deps: InitDeps, asked: string | undefined): DirectoryApi {
  const { backend } = deps.ctx;
  if (asked === undefined || asked === backend.directory.region) return backend.directory;
  const built = deps.initSupport?.directoryFor?.(asked);
  if (!built) {
    throw new HermeticError(
      "UNSUPPORTED",
      `this hermetic instance cannot reach a fleet directory in ${asked}; it was opened against ${backend.directory.region}`,
      { requested: asked, opened: backend.directory.region },
    );
  }
  return built;
}

/**
 * §4.8. The table has to exist before anything else does, and a failure to
 * make it is a refusal rather than a warning: a fleet that never reaches
 * the directory is invisible to the next `fleet ls`, and "invisible" is how
 * a fleet gets torn down twice or paid for forever.
 */
export async function ensureDirectory(directoryApi: DirectoryApi): Promise<DirectoryStatus> {
  try {
    return await directoryApi.ensure();
  } catch (e) {
    if (isHermeticError(e) && e.code === "DIRECTORY_UNAVAILABLE") throw e;
    throw new HermeticError(
      "DIRECTORY_UNAVAILABLE",
      `the account's fleet directory in ${directoryApi.region} could not be reached or created: ${e instanceof Error ? e.message : String(e)}. Nothing was created.`,
      {
        region: directoryApi.region,
        cause: e instanceof Error ? e.message : String(e),
      },
    );
  }
}

/**
 * §4.8: which of the account's foundations this run is about.
 *
 * `--create` never has one. That is the whole fix: `describeStack` on a
 * backend with no fleet id falls back to "the single live hermetic stack",
 * so a second `init --create` used to find the *first* fleet's stack, call
 * it `existing`, and refuse with CONFLICT — which made a second fleet in
 * one account impossible to create.
 *
 * Otherwise the target is, in order: the live stack whose `fleet_id` is
 * exactly what `--fleet` said, then the fleet whose *display alias* it
 * matches (through the directory, which is what maps a label to an id),
 * then — with nothing named at all — the single live stack, which is what
 * "one foundation per account" always meant. Two stacks and nothing
 * choosing between them is a refusal, because attaching to the wrong one
 * freezes this home to another fleet.
 *
 * The id is tried against CloudFormation *before* the directory is
 * consulted, and that ordering is the point (§4.6): a foundation that is
 * genuinely in this account but missing from the directory — created before
 * the directory existed, or in an account whose table was deleted — is
 * still attachable by the id stamped on its own stack, and the attach
 * registers it. Resolving the id only through the directory would refuse
 * exactly the fleets that need repairing most.
 */
export async function resolveTarget(
  deps: InitDeps,
  run: InitRun,
  live: StackSummary[],
): Promise<StackInfo | null> {
  const { backend } = deps.ctx;
  const { mode, parsed, seen } = run;
  if (mode === "create") return null;

  const asked = parsed.fleet ?? parsed.name;
  if (asked !== undefined) {
    const byId = live.find((s) => s.fleet_id === asked);
    if (byId) return bindTo(backend, byId);

    /**
     * A tombstoned row keeps its alias reserved (§4.7) so nothing else can
     * take the label, and must never select a fleet by it — otherwise
     * `--fleet staging` lands on whichever fleet *used* to be called that.
     */
    const entry =
      seen.fleets.find((e) => e.fleet_id === asked && e.status !== "torn_down") ??
      seen.fleets.find((e) => e.name === asked && e.status !== "torn_down") ??
      null;
    if (entry) {
      const match = live.find((s) => s.fleet_id === entry.fleet_id);
      if (!match) {
        /**
         * The directory says this fleet is here and CloudFormation says it
         * is not — drift worth reporting rather than quietly attaching to
         * some other fleet the operator did not ask for.
         */
        throw new HermeticError(
          "NOT_FOUND",
          `the directory records fleet ${entry.fleet_id}${entry.name ? ` ("${entry.name}")` : ""} in this account, but there is no stack for it; run \`hermetic doctor\` against that fleet, or pass another --fleet`,
          { fleet: asked, fleet_id: entry.fleet_id },
        );
      }
      return bindTo(backend, match);
    }

    /**
     * Nothing in this account answers to it. `--fleet` is a *selector*
     * now — it never names a fleet into existence (§4.6) — so falling
     * through to "whatever single stack is live" would attach to a fleet
     * the operator did not ask for and say nothing about it.
     */
    throw new HermeticError(
      "NOT_FOUND",
      `no fleet in this account answers to "${asked}"; live foundations: ${live.map((s) => s.fleet_id ?? s.stack_name).join(", ") || "(none)"}`,
      {
        fleet: asked,
        stacks: live.map((s) => ({ stack_name: s.stack_name, fleet_id: s.fleet_id })),
      },
    );
  }

  if (live.length === 0) {
    if (mode === "attach") {
      throw new HermeticError("NOT_FOUND", `no ${STACK_NAME} foundation to attach to in this account`);
    }
    return null;
  }
  if (live.length === 1) return bindTo(backend, live[0] as StackSummary);

  throw new HermeticError(
    "CONFLICT",
    `several fleets here (${live.map((s) => s.fleet_id ?? s.stack_name).join(", ")}); pass --fleet <id> to say which one to attach to`,
    { stacks: live.map((s) => ({ stack_name: s.stack_name, fleet_id: s.fleet_id })) },
  );
}

/**
 * Point the backend at the chosen stack and read it in full. Binding first
 * matters: every later read — the `_fleet` item, the tables, the bucket —
 * resolves through the stack this backend thinks it is about, and on the
 * `init` path it was built without a fleet id to think with.
 */
export async function bindTo(backend: Backend, target: StackSummary): Promise<StackInfo> {
  if (target.fleet_id !== null) backend.foundation.bindFleet(target.fleet_id);
  const described = await backend.foundation.describeStack();
  if (!described) {
    throw new HermeticError(
      "NOT_FOUND",
      `the ${target.stack_name} stack was listed but could not be described`,
      { stack_name: target.stack_name },
    );
  }
  const describedFleet = described.tags[FLEET_ID_TAG] ?? described.tags["fleet_id"] ?? null;
  if (target.fleet_id !== null && describedFleet !== target.fleet_id) {
    throw new HermeticError(
      "FLEET_MISMATCH",
      `asked for fleet ${target.fleet_id} but the backend described ${describedFleet ?? "an untagged stack"}`,
      { requested: target.fleet_id, described: describedFleet },
    );
  }
  return described;
}

/**
 * The same table, looked at rather than made (§4.8). `status()` never throws
 * for "no table" — that is `exists: false` — so the only failures reaching
 * here are the ones that mean the directory is genuinely unreachable, and
 * those are worth stopping for before anything else happens.
 */
export async function readDirectory(directoryApi: DirectoryApi): Promise<DirectoryStatus> {
  try {
    return await directoryApi.status();
  } catch (e) {
    if (isHermeticError(e) && e.code === "DIRECTORY_UNAVAILABLE") throw e;
    throw new HermeticError(
      "DIRECTORY_UNAVAILABLE",
      `the account's fleet directory in ${directoryApi.region} could not be read: ${e instanceof Error ? e.message : String(e)}. Nothing was created.`,
      {
        region: directoryApi.region,
        cause: e instanceof Error ? e.message : String(e),
      },
    );
  }
}

/** One directory item, from what this run already knows (§4.8). No secret is on it. */
export function directoryEntry(
  id: CallerIdentity,
  nowIso: () => string,
  input: {
    name: string | null;
    fleet_id: string;
    region: string;
    stack_id: string;
    foundation_version: number;
    tailnet: string | null;
    created_at?: string;
    created_by?: string;
  },
): DirectoryEntry {
  const at = nowIso();
  return {
    name: input.name,
    fleet_id: input.fleet_id,
    account_id: id.account_id,
    region: input.region,
    status: "active",
    stack_id: input.stack_id,
    foundation_version: input.foundation_version,
    hermetic_version: HERMETIC_VERSION,
    tailnet: input.tailnet,
    created_at: input.created_at ?? at,
    created_by: input.created_by ?? id.arn,
    updated_at: at,
    updated_by: id.arn,
  };
}

/**
 * §4.7: the fleet id row, and its display alias's reservation when it has
 * one, in a single conditional write. A `false` therefore means one of two
 * things and the message covers both — this fleet is already registered, or
 * the label it asked for belongs to somebody else. Neither is rolled back:
 * on the attach path there was nothing to roll back, and on the create path
 * the stack already exists and is perfectly good with no label at all.
 */
export async function registerFleet(directoryApi: DirectoryApi, entry: DirectoryEntry): Promise<void> {
  const won = await directoryApi.register(entry);
  if (won) return;
  throw new HermeticError(
    "NAME_TAKEN",
    entry.name === null
      ? `the account's fleet directory already has an entry for fleet ${entry.fleet_id}`
      : `the account's fleet directory already holds the alias "${entry.name}"; aliases stay reserved after a teardown, so clear it on the fleet that holds it or pick another`,
    { alias: entry.name, fleet_id: entry.fleet_id },
  );
}
