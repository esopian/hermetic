/**
 * Running `init` from the browser (§4.7 steps 3–4).
 *
 * Two things make this different from every other op:
 *
 * 1. **The instance it runs on does not exist yet.** Core's pre-init instance
 *    has a backend that refuses everything, on purpose: until an identity has
 *    actually been resolved there is nothing to point `aws.client()` at, and a
 *    stand-in backend would let `init` freeze the wrong account into the
 *    operator's database. So the op resolves the identity itself, `bind()`s core
 *    to that profile, and runs `init` on the bound instance — the same sequence
 *    `packages/cli/src/commands/init.ts` drives interactively.
 * 2. **The body carries a secret.** The Tailscale OAuth client secret cannot be
 *    minted by an API (§4.7 step 4), so the operator pastes it in. It is handed
 *    to core and must appear nowhere else: not in the op record, not in an
 *    OpEvent, not in the run log, not in an error. `redactInitInput` is what the
 *    server is allowed to keep.
 */
import { HermeticError, redactInitInput } from "@hermetic/core";
import type { InitInput } from "@hermetic/core";
import type { OpRegistry, OpSummary } from "./ops.ts";
import type { AppState } from "./state.ts";
import { FALLBACK_REGION } from "./handlers/init.ts";
import type { AppLog } from "./log.ts";

/** The header line an uninitialized server prints and serves (§4.7). */
export const NOT_INITIALIZED_HEADER = "▸ not initialized";

/**
 * The full uninitialized header: which home is waiting to be written, and —
 * matching core's `headerLine` — a `FIXTURE` suffix when this is the wizard's
 * in-memory backend rather than a real, empty home.
 */
export function uninitializedHeader(home: string, fixture: boolean): string {
  const base = `${NOT_INITIALIZED_HEADER} · ${home}`;
  return fixture ? `${base} · FIXTURE` : base;
}

/**
 * Placeholder `AppState.initOpId` value between claiming the single
 * init-op slot and `ops.start` actually minting an id — closes the race two
 * concurrent `POST /api/init` calls would otherwise hit (see `startInit`).
 * Never leaks out: `InitInFlightError` reports it as `op_id: null`.
 */
const PENDING_INIT_OP = "pending";

/** Thrown by `startInit` when an init op is already running; carries its id. */
export class InitInFlightError extends HermeticError {
  /** `null` when the other request has claimed the slot but has no op id yet. */
  readonly opId: string | null;

  constructor(opId: string) {
    const reported = opId === PENDING_INIT_OP ? null : opId;
    super(
      "CONFLICT",
      reported
        ? `an init op is already running (${reported})`
        : "an init op is starting; try again shortly",
    );
    this.opId = reported;
  }
}

/**
 * Starts the wizard's init op and, when it succeeds, swaps the initialized core
 * instance in behind every route.
 */
export async function startInit(
  state: AppState,
  ops: OpRegistry,
  input: InitInput,
  log?: AppLog,
): Promise<{ op_id: string; op: OpSummary }> {
  const session = state.session;
  if (!session) {
    throw new HermeticError("CONFLICT", "already initialized; use `hermetic init --reset`");
  }
  const inFlight = state.initOpId;
  if (inFlight !== null) {
    throw new InitInFlightError(inFlight);
  }
  const profile = input.profile;
  if (profile === undefined) {
    throw new HermeticError(
      "VALIDATION",
      "init from the dashboard needs the profile name; pick one from /api/init/profiles",
    );
  }

  // Claim the single init-op slot *synchronously*, before the first `await`
  // below — two concurrent `POST /api/init` calls both pass the `inFlight`
  // check above in the same tick, so the race has to be closed here, not
  // there. The `catch` below releases it again unless the op actually started
  // (in which case `ops.wait` releases it once the op settles).
  state.beginInit(PENDING_INIT_OP);
  try {
    // One STS call for the chosen profile, before anything is written. Core
    // compares the twelve digits the operator typed against what this returns,
    // so binding to a claimed account cannot freeze the wrong one. Core
    // resolves in the region it is handed and does not guess, so an omitted
    // region falls back to the profile's own default.
    const region =
      input.region ??
      (await session.hermetic.init.listProfiles()).find((p) => p.name === profile)?.region ??
      FALLBACK_REGION;
    const identity = await session.hermetic.init.resolveIdentity(profile, region);

    // A mismatched `mode` fails inside core's `init` generator too, but only
    // after the op has been started and has begun mutating — the UI would see
    // a 202 immediately followed by an error event. `mode: "auto"` picks
    // attach-or-create for itself and is never wrong here; an explicit
    // `attach` or `create` is checked against what the wizard's own read-only
    // `describeFoundation` sees, so the caller gets a synchronous 409 instead.
    const mode = input.mode ?? "auto";
    if (mode !== "auto") {
      const foundation = await session.hermetic.init.describeFoundation(
        identity.profile,
        identity.region,
      );
      if (mode === "attach" && !foundation.found) {
        throw new HermeticError(
          "CONFLICT",
          'no foundation to attach to in this account; use mode: "create" (or omit mode)',
        );
      }
      if (mode === "create" && foundation.found) {
        throw new HermeticError(
          "CONFLICT",
          'a foundation already exists in this account; use mode: "attach"',
          { fleet_id: foundation.fleet_id },
        );
      }
    }

    const bound = session.bind({
      profile: identity.profile,
      region: identity.region,
      accountId: identity.account_id,
    });

    // Core validates `region` strictly, so the resolved one is what init runs
    // with rather than whatever (or nothing) the client sent.
    const resolved: InitInput = { ...input, region: identity.region, profile: identity.profile };
    const op = ops.start("init", null, (signal) => bound.init(resolved, { signal }), {
      // What the op record and the run log are allowed to remember. Core's
      // `redactInitInput` replaces the Tailscale OAuth client secret; the raw
      // input goes only to `bound.init` above.
      input: redactInitInput(resolved),
    });
    state.beginInit(op.id);

    // Not awaited: the POST answers 202 like every other op. The swap happens
    // when the op lands, so `/api/meta` flips on its own and the UI's next poll
    // sees a dashboard instead of a wizard.
    void ops.wait(op.id).then(async (summary) => {
      state.endInit();
      if (summary?.status !== "ok") return;
      try {
        await state.adopt();
        log?.line("info", "init", "adopted the new fleet; serving the dashboard");
      } catch (e) {
        // `adopt()` already recorded `adoptError`; the fleet exists either way,
        // and swallowing this is better than an unhandled rejection taking the
        // server down mid-init. `/api/init*` refuses while `adoptError` is set.
        log?.line(
          "error",
          "init",
          `fleet created but could not be adopted: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });

    return { op_id: op.id, op };
  } catch (e) {
    // Never actually started an op (a validation or identity failure): release
    // the slot so the operator can retry.
    state.endInit();
    throw e;
  }
}
