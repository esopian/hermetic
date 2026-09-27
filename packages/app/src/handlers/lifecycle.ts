/**
 * The whole-fleet lifecycle: `init`, `teardown`, `foundation.status` and its
 * update, `artifacts.push`, `upgrade`. These are the methods that claim the
 * teardown and foundation-update slots the guards in `handlers/shared.ts` read.
 *
 * A refusal is a thrown `HermeticError` and nothing here knows what a status
 * code is. The schemas are declared here, so the method and the
 * schema the parity contract compares cannot drift apart (`declare.ts`).
 */
import {
  ArtifactsPushApiInput,
  FoundationStatusInput,
  FoundationUpdateInput,
  InitInput,
  TeardownInput,
  UpgradeInput,
} from "@hermetic/core";
import { HermeticError } from "@hermetic/core";
import type { Hermetic } from "@hermetic/core";
import { declareRpc } from "../declare.ts";
import { startInit } from "../init-op.ts";
import { accepted, type Accepted } from "../ops.ts";
import { requireTarget, stillBound, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { requireInitAllowed } from "./init.ts";
import { TEARDOWN_PLANNING, afterTeardown, requireWritable, unconfirmed } from "./shared.ts";

export const initSchema = declareRpc("init", InitInput);
export const artifactsPushSchema = declareRpc("artifacts.push", ArtifactsPushApiInput);
export const teardownSchema = declareRpc("teardown", TeardownInput);
export const foundationStatusSchema = declareRpc("foundation.status", FoundationStatusInput);
export const foundationUpdateSchema = declareRpc("foundation.update", FoundationUpdateInput);
export const upgradeSchema = declareRpc("upgrade", UpgradeInput);

// §4.7 mutation bodies — see `handlers/shared.ts` and `target.ts`.
export const teardownBody = withTarget(teardownSchema);
export const foundationUpdateBody = withTarget(foundationUpdateSchema);
export const artifactsPushBody = withTarget(artifactsPushSchema);
export const upgradeBody = withTarget(upgradeSchema);

/**
 * `init` is the one method here that does not start its op through `accepted`.
 *
 * `startInit` mints the op itself (`init-op.ts`) — the instance it runs on does
 * not exist yet, so the op has to resolve an identity and bind core before it
 * can call anything — and what it returns is already the `{op_id, op}` the
 * caller is owed, the same shape `accepted` builds for every other op.
 */
export async function init(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  const { state, ops, opts } = ctx;
  // Re-freezing a live home from a browser tab is not on offer (§4.6). A
  // teardown in flight is checked first: the block is held from the moment the
  // op starts until `resetToUninitialized()` has finished, so during it the
  // server reports "teardown in progress" — the specific reason — rather than
  // whichever side of `initialized` the reset happens to be on.
  requireWritable(state);
  requireInitAllowed(state);
  const input = parseInput(initSchema, params);
  // §4.7 step 3: the twelve digits, typed. Core compares them against what STS
  // resolved, but a client that never sends them must not get as far as
  // starting the op.
  const typed = input.account_id_typed ?? input.confirm_account_id;
  if (typed === undefined || !/^\d{12}$/.test(typed)) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      'init needs the twelve-digit account id typed back; send {"account_id_typed": "…"}',
    );
  }
  return await startInit(state, ops, input, opts.log);
}

export async function teardown(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  const { state, ops } = ctx;
  const bound = requireTarget(state, parseInput(teardownBody, unconfirmed(params)));
  const { hermetic: h, input } = bound;
  if (input.yes !== true) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      'teardown deletes the whole foundation; send {"yes": true}',
    );
  }
  /**
   * §4.7 step 3, over a transport: there is no prompt on this side of the wire,
   * so the twelve digits must arrive *in the request* — the UI is what types
   * them. Required rather than optional, unlike core's own check: `yes` from a
   * browser is one fetch, and one fetch must not be able to delete an account's
   * foundation.
   */
  if (input.confirm_account_id === undefined || !/^\d{12}$/.test(input.confirm_account_id)) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      'teardown confirms by typing the twelve-digit account id; send {"confirm_account_id": "…"}',
    );
  }
  requireWritable(state);
  /**
   * §4.7: the slot is claimed *before* the plan, not after the op.
   *
   * Planning and starting used to be two awaits apart, with the claim after
   * both — so a fleet switch arriving in between was accepted (nothing was in
   * flight yet, as far as the state knew), and the teardown that followed
   * deleted the foundation of a fleet nobody had planned. Claiming first makes
   * the switch refuse, which is what a teardown the operator has already
   * confirmed deserves.
   */
  state.beginTeardown(TEARDOWN_PLANNING);
  let plan: Awaited<ReturnType<Hermetic["plan"]["teardown"]>>;
  try {
    // Read before the op starts: `plan.teardown`'s `summary` and `warnings` are
    // what `last_teardown` is built from once the op lands, and by then — if
    // `reset_local` is true — the initialized instance this reads from is
    // already gone.
    plan = await h.plan.teardown(input);
  } catch (e) {
    // Nothing ran, so nothing owns the slot; a failed plan must not leave the
    // portal refusing every mutation until it is restarted.
    state.endTeardown();
    throw e;
  }
  // The op id goes into the receipt (§4.6), so the record in the local table
  // and the stream the browser watched are recognisably one run.
  // §4.7, the same re-check `agents.destroy` makes: the plan above is an
  // `await`, and `ops.start` stamps the run with whatever fleet the server is
  // on when it returns. The teardown block claimed a moment ago already refuses
  // a switch, so this cannot fire today — which is the point of asserting it
  // here rather than trusting that it cannot.
  stillBound(state, bound);
  const op = ops.start("teardown", null, (signal, opId) => h.teardown(input, { signal, opId }));
  state.beginTeardown(op.id);
  afterTeardown(ctx, op.id, plan, input.reset_local === true);
  return accepted(op);
}

/**
 * §6.6. Every CLI command and `/api/meta` read this, so it costs what a read
 * costs: one `_fleet` GetItem and one agents scan, no S3.
 */
export async function foundationStatus(ctx: HandlerContext, params: unknown) {
  parseInput(foundationStatusSchema, params ?? {});
  return await ctx.hermetic().foundation.status();
}

export async function foundationUpdate(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  const { state, ops } = ctx;
  const { hermetic: h, input } = requireTarget(state, parseInput(foundationUpdateBody, params));
  /**
   * The head owes the client the 428 now, the way `teardown`, `recreate` and
   * `apply` all do. Core takes `yes` and ignores it (§3.2 rule 1), so without
   * this an empty body from one fetch rewrites the stack, the release and every
   * agent's `hermeticd`.
   */
  if (input.yes !== true) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      'a foundation update rewrites the stack, the release and every agent\'s hermeticd; send {"yes": true}',
    );
  }
  // Mutual exclusion with teardown, and single-flight against itself: the fleet
  // lock core takes would refuse the second one anyway, but a browser that got
  // a 202 and then watched the op fail `LOCKED` learned nothing it could not
  // have been told here.
  requireWritable(state);
  const op = ops.start("foundation.update", null, (signal, opId) =>
    h.foundation.update(input, { signal, opId }),
  );
  state.beginFoundationUpdate(op.id);
  // Not awaited: the caller is answered 202 like every other op, and the slot is
  // released however the op ends — including `error` and `aborted`, since a
  // failed update leaves the fleet exactly where it was (§6.6).
  void ops.wait(op.id).finally(() => state.endFoundationUpdate());
  return accepted(op);
}

export async function artifactsPush(ctx: HandlerContext, params: unknown) {
  // A foundation update pushes its own release and then *prunes* the
  // `artifacts/<ver>/` prefixes it is not keeping (§6.6 step 4); a push racing
  // that decides which directories exist while it is being made.
  requireWritable(ctx.state);
  // `ArtifactsPushInput.path` and `.bytes` make core read the laptop's disk,
  // which over a transport is an arbitrary-file-read primitive — so the
  // declared schema is `ArtifactsPushApiInput`, a version and nothing else,
  // and zod strips whatever else a caller sends.
  // TODO(evan): the Hono head *refused* an unrecognised key rather than
  // stripping it, so a caller that sent `path` was told it would not be
  // honoured instead of being left to believe it had been. Nothing on the
  // bridge does that yet.
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(artifactsPushBody, params));
  return await h.artifacts.push(input);
}

export async function upgrade(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  const { state, ops } = ctx;
  requireWritable(state);
  const { hermetic: h, input } = requireTarget(state, parseInput(upgradeBody, params));
  const op = ops.start("upgrade", input.name ?? null, (signal) => h.upgrade(input, { signal }));
  return accepted(op);
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const lifecycleHandlers = {
  init,
  teardown,
  "foundation.status": foundationStatus,
  "foundation.update": foundationUpdate,
  "artifacts.push": artifactsPush,
  upgrade,
} satisfies Record<string, Handler>;
