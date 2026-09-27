/**
 * `secrets.*`: §8.2's per-agent and fleet-level shared slots.
 *
 * A refusal is a thrown `HermeticError` and nothing here knows what a status
 * code is. The schemas are declared here, so the method and the
 * schema the parity contract compares cannot drift apart (`declare.ts`).
 */
import {
  SecretsDeleteInput,
  SecretsListInput,
  SecretsPushInput,
  SecretsVerifyInput,
} from "@hermetic/core";
import { HermeticError, redactSecretsPushInput } from "@hermetic/core";
import { declareRpc } from "../declare.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { requireWritable, unconfirmed } from "./shared.ts";

export const pushSchema = declareRpc("secrets.push", SecretsPushInput);
export const verifySchema = declareRpc("secrets.verify", SecretsVerifyInput);
/**
 * §8.2's fleet-level shared slots: the list, and a delete that addresses one
 * slug. Neither carries a value in either direction.
 */
export const listSchema = declareRpc("secrets.list", SecretsListInput);
export const deleteSchema = declareRpc("secrets.delete", SecretsDeleteInput);

// §4.7 mutation bodies — see `handlers/shared.ts` and `target.ts`.
export const pushBody = withTarget(pushSchema);
export const deleteBody = withTarget(deleteSchema);

export async function list(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().secrets.list(parseInput(listSchema, params));
}

export async function push(ctx: HandlerContext, params: unknown) {
  // Pushing a secret into SSM paths a running teardown is purging is a write
  // nobody wants to win that race (§8.2).
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(pushBody, params));
  // The value is in the request and goes straight to core; what reaches the
  // app log is the *redacted* input, so the record says which slot was
  // written and never what went into it (§8.3). Spread as top-level fields
  // (name/shared/flags), the
  // same shape every other `log?.line` call uses — nesting it under one
  // `input` key would hand `formatLine` an object to stringify, which is
  // how this used to print `input=[object Object]`. `value` is dropped
  // outright rather than logged as "(redacted)": this line names the slot,
  // never that a value field existed at all.
  const { value: _value, ...loggedFields } = redactSecretsPushInput(input);
  ctx.opts.log?.line("info", "secrets", "secrets.push", loggedFields);
  return await h.secrets.push(input);
}

export async function verify(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().secrets.verify(parseInput(verifySchema, params));
}

export async function remove(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(deleteBody, unconfirmed(params)));
  // Confirmation is a precondition, not a failure — the same 428 the volume
  // and agent delete routes answer with.
  if (!input.yes) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `deleting the shared secret ${input.slug} is irreversible; send {"yes": true}`,
      { slug: input.slug },
    );
  }
  return await h.secrets.delete(input);
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const secretHandlers = {
  "secrets.list": list,
  "secrets.push": push,
  "secrets.verify": verify,
  "secrets.delete": remove,
} satisfies Record<string, Handler>;
