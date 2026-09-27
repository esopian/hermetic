/**
 * `hermetic init` (§4.7): the identity check, the attach-or-create decision, the
 * Tailscale preflight, and the freeze — plus the pre-init reads the heads draw
 * their pickers and their preflight panel from.
 *
 * It lives outside `hermetic.ts` for the same reason `doctor.ts` does: it is a
 * self-contained command with a dependency list it can be handed rather than
 * close over, and the lifecycle module is at its size limit (AGENTS.md rule 5).
 * Everything it needs from `createHermetic`'s closure arrives in `InitDeps`.
 */
import { InitInput as InitInputSchema, STACK_NAME, isStackDeleting } from "../schema/index.ts";
import type {
  AwsProfileInfo,
  FoundationSummary,
  InitInput,
  OpEvent,
  ResolvedIdentity,
  TailscaleOauthCheck,
  TailscalePreflight,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import type { InitDeps, InitOpOptions, InitRun } from "./init-run.ts";
import { evt } from "../events.ts";
import { checkAbort } from "../abort.ts";
import {
  ensureDirectory,
  readDirectory,
  resolveDirectoryApi,
  resolveTarget,
} from "./init-directory.ts";
import { attach } from "./init-attach.ts";
import { create } from "./init-create.ts";

export type { InitDeps, InitOpOptions, InitRun } from "./init-run.ts";
export { FOUNDATION_HEARTBEAT_MS, narrateStack } from "./init-narrate.ts";
export type { StackNarration } from "./init-narrate.ts";

/**
 * `init` plus its pre-init helpers, as one object. The helpers hang off `init`
 * rather than appearing in `PUBLIC_METHODS` because parity is one method, one
 * CLI command, one route — and these are inputs to the single `init` command.
 */
export function createInit(deps: InitDeps) {
  const { backend, nowIso } = deps.ctx;

  /**
   * §4.7 step 4, non-interactive. Every prompt — the profile picker, the twelve
   * typed digits, the ACL snippet — belongs to the head (§3.2 rule 1); by the
   * time `init` is called the operator has already confirmed, and this does the
   * identity check, the attach-or-create decision, and the freeze.
   *
   * Attach is the new-machine, corrupt-state and new-teammate path, all one
   * command: only the profile name is truly local, so everything else comes back
   * from the stack tags and the `_fleet` item.
   */
  async function* init(input: InitInput = {}, opts: InitOpOptions = {}): AsyncIterable<OpEvent> {
    /**
     * §8.3: `tailscale_oauth_secret` is the one secret that arrives as a *field
     * of a request*, so a validation failure is the one place it could be echoed
     * back out — a ZodError carries the input it rejected, and heads log thrown
     * errors. Validation is therefore wrapped, and the details carry only which
     * fields were wrong.
     */
    const validated = InitInputSchema.safeParse(input);
    if (!validated.success) {
      throw new HermeticError("VALIDATION", "init input does not validate", {
        issues: validated.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
      });
    }
    const parsed = validated.data;
    if (parsed.attach && parsed.create) {
      throw new HermeticError("UNSUPPORTED", "--attach and --create are mutually exclusive");
    }
    const mode: "attach" | "create" | "auto" =
      parsed.mode ?? (parsed.attach ? "attach" : parsed.create ? "create" : "auto");
    if (parsed.name !== undefined && mode === "create") {
      throw new HermeticError(
        "VALIDATION",
        "--name is no longer accepted when creating a fleet; create it first, then run `hermetic fleet alias <fleet-id> <alias>`",
      );
    }
    if ((parsed.attach && mode !== "attach") || (parsed.create && mode !== "create")) {
      throw new HermeticError("UNSUPPORTED", "mode disagrees with --attach/--create", { mode });
    }

    const id = await backend.identity.callerIdentity();
    const typed = parsed.account_id_typed ?? parsed.confirm_account_id;
    const existingConfig = deps.ctx.config;

    if (typed !== undefined && typed !== id.account_id) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        "the account id you typed does not match the account these credentials resolve to",
        { typed, observed: id.account_id },
      );
    }
    deps.ctx.setActor(deps.actor ?? id.arn);

    yield evt("identity", 0.15, `account ${id.account_id} as ${id.arn}`, nowIso());

    /**
     * §4.8, and read-only — this is the *look*, not the making.
     *
     * `init` wants to be able to say what the account already holds before the
     * operator is asked to type twelve digits at it. But §4.7's gate stands
     * before the first mutation, and creating the directory table is a
     * mutation: doing it here would mean a refused `init` had already made
     * something. So the early step is `status()`, which answers `exists: false`
     * for a table that is not there rather than creating one, and
     * `ensureDirectory()` runs on the far side of the gate.
     */
    checkAbort(opts.signal, "directory");
    /**
     * §4.8: one directory per account, so the region it lives in is a fact this
     * home already holds if it has ever run `init`. A second run naming a
     * different one is refused rather than obeyed — obeying would create a
     * second table and leave the account with two half-registers of which
     * fleets exist.
     */
    const persistedDirectoryRegion = (await deps.configStore?.directoryRegion?.()) ?? null;
    if (
      parsed.directory_region !== undefined &&
      persistedDirectoryRegion !== null &&
      parsed.directory_region !== persistedDirectoryRegion
    ) {
      throw new HermeticError(
        "CONFLICT",
        `this home already knows the account's fleet directory in ${persistedDirectoryRegion}; --directory-region ${parsed.directory_region} would make a second one`,
        { persisted: persistedDirectoryRegion, requested: parsed.directory_region },
      );
    }
    const directoryApi = resolveDirectoryApi(deps, parsed.directory_region);
    const seen = await readDirectory(directoryApi);
    yield evt(
      "directory",
      0.18,
      seen.exists
        ? `fleet directory in ${directoryApi.region}: ${seen.fleets.length} fleet(s)`
        : `no fleet directory yet in ${directoryApi.region}; init will create it`,
      nowIso(),
    );

    const alias = await backend.identity.accountAlias();
    const org_id = await backend.identity.orgId();

    checkAbort(opts.signal, "foundation");

    /**
     * §4.8: *which* foundation this run is about, before deciding what to do
     * with it. An account may hold several, so "the stack" is no longer a
     * question `describeStack` can answer on its own — it answers "this fleet's
     * stack", and until this resolves there is no this fleet.
     */
    const stacks = await backend.foundation.listStacks();

    /**
     * A foundation that is being deleted is neither branch of §4.7 step 4.
     * Attaching would freeze this home to a VPC, a bucket and two tables that
     * are seconds from not existing; creating would race CloudFormation for the
     * one stack name and fail halfway. `auto` therefore refuses rather than
     * guessing, and so do `--attach` and `--create` — the answer to all three
     * is the same, and it is "wait".
     */
    const deleting = stacks.find((s) => isStackDeleting(s.status));
    if (deleting) {
      throw new HermeticError(
        "CONFLICT",
        `the ${STACK_NAME} foundation is being deleted; wait and retry`,
        { stack_status: deleting.status, stack_id: deleting.stack_id, decision: mode },
      );
    }
    const live = stacks.filter((s) => !isStackDeleting(s.status));

    const run: InitRun = { parsed, mode, id, existingConfig, alias, org_id, directoryApi, seen };
    const existing = await resolveTarget(deps, run, live);

    /**
     * §4.7 step 3: the operator types the twelve digits, not `y`.
     *
     * The gate is computed from the *effective* decision, not from the flags,
     * and it stands before the first mutation. `auto` with a frozen config and
     * no stack — a home whose foundation was torn down — is a create, and
     * deciding that from `mode` alone let the whole stack, the `_fleet` item and
     * the tailscale secret be written and only then refused at `freeze()`,
     * leaving an orphan foundation nobody's config pointed at.
     */
    const effective: "attach" | "create" = existing ? "attach" : "create";
    if (parsed.name !== undefined && effective === "create") {
      throw new HermeticError(
        "VALIDATION",
        "--name is no longer accepted when creating a fleet; create it first, then run `hermetic fleet alias <fleet-id> <alias>`",
      );
    }
    const bindsSomewhereNew =
      effective === "create" || parsed.reset === true || existingConfig === null;
    if (typed === undefined && bindsSomewhereNew && deps.configStore) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `type the twelve digits of the account id to confirm; \`y\` is not enough (this ${effective === "create" ? "creates a new foundation" : "binds this home"})`,
        { observed: id.account_id, decision: effective },
      );
    }

    /**
     * §4.8, and now the *making*: the first mutation `init` performs, on the far
     * side of the gate above — so nothing has been created in an account the
     * operator did not confirm. Idempotent (an existing table costs one
     * describe), and still before every piece of stack work, because a fleet
     * that could not be registered is a fleet that should not be created.
     */
    checkAbort(opts.signal, "directory");
    const directory = await ensureDirectory(directoryApi);
    yield evt(
      "directory",
      0.19,
      `fleet directory ready in ${directoryApi.region} (${directory.fleets.length} fleet(s) in this account)`,
      nowIso(),
    );

    if (existing) {
      yield* attach(deps, run, opts, existing, directory);
      return;
    }
    yield* create(deps, run, opts, live, directory);
  }

  /**
   * §4.7 steps 1–2, before anything is frozen. Attached to `init` rather than
   * added to `PUBLIC_METHODS`: they are inputs to the one `init` command, not
   * commands of their own, so parity stays at one method per command.
   */
  async function listProfiles(): Promise<AwsProfileInfo[]> {
    if (!deps.initSupport) {
      throw new HermeticError(
        "UNSUPPORTED",
        "profile enumeration is only available from `openForInit`",
      );
    }
    return deps.initSupport.listProfiles();
  }

  async function resolveIdentity(profile: string, region: string): Promise<ResolvedIdentity> {
    if (!deps.initSupport) {
      throw new HermeticError(
        "UNSUPPORTED",
        "identity resolution is only available from `openForInit`",
      );
    }
    return deps.initSupport.resolveIdentity(profile, region);
  }

  async function describeFoundation(profile: string, region: string): Promise<FoundationSummary> {
    if (!deps.initSupport) {
      throw new HermeticError(
        "UNSUPPORTED",
        "foundation discovery is only available from `openForInit`",
      );
    }
    return deps.initSupport.describeFoundation(profile, region);
  }

  return Object.assign(init, {
    listProfiles,
    resolveIdentity,
    describeFoundation,
    localTailscale: (): Promise<TailscalePreflight> => deps.localTailscale(),
    /**
     * The secret is an argument and never leaves this call: the result names
     * what failed, never what was pasted (§8.3).
     */
    verifyTailscaleOauth: (secret: string): Promise<TailscaleOauthCheck> =>
      deps.verifyTailscaleOauth(secret),
  });
}
