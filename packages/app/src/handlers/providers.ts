/**
 * `providers.*`: §8.3's provider profiles and the model discovery that serves
 * their setup.
 *
 * Nothing here knows what a status code is: a refusal is a thrown
 * `HermeticError`.
 *
 * The schemas are declared here, with `declareRpc` recording what this handler
 * validates against core's surface — so the method and the schema the parity
 * contract compares cannot drift apart (`declare.ts`).
 */
import {
  ProvidersCreateInput,
  ProvidersDeleteInput,
  ProvidersListInput,
  ProvidersModelsInput,
  ProvidersUpdateInput,
} from "@hermetic/core";
import {
  HermeticError,
  redactProvidersCreateInput,
  redactProvidersModelsInput,
  redactProvidersUpdateInput,
} from "@hermetic/core";
import { declareRpc } from "../declare.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { requireWritable, unconfirmed } from "./shared.ts";

export const listSchema = declareRpc("providers.list", ProvidersListInput);
export const createSchema = declareRpc("providers.create", ProvidersCreateInput);
export const updateSchema = declareRpc("providers.update", ProvidersUpdateInput);
export const deleteSchema = declareRpc("providers.delete", ProvidersDeleteInput);
export const modelsSchema = declareRpc("providers.models", ProvidersModelsInput);

// §4.7 mutation bodies — see `handlers/shared.ts` and `target.ts`.
export const createBody = withTarget(createSchema);
export const updateBody = withTarget(updateSchema);
export const deleteBody = withTarget(deleteSchema);

/**
 * §8.3's model discovery. It may carry the draft credential an operator is
 * typing into provider setup, which is why its route is a POST: a key does not
 * belong in a query string, not in the server's access log, not in the
 * browser's history, not in a copied URL. Nothing is stored — the response is a
 * read of somebody else's service — so the teardown/update guards do not apply.
 *
 * What reaches the portal log is the *redacted* input: which provider or
 * profile was asked about, never the key that was presented (§8.3).
 */
export async function models(ctx: HandlerContext, params: unknown) {
  const input = parseInput(modelsSchema, params);
  ctx.opts.log?.line("info", "providers", "providers.models", redactProvidersModelsInput(input));
  return await ctx.hermetic().providers.models(input);
}

export async function list(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().providers.list(parseInput(listSchema, params));
}

export async function create(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(createBody, params));
  ctx.opts.log?.line("info", "providers", "providers.create", redactProvidersCreateInput(input));
  return await h.providers.create(input);
}

export async function update(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(updateBody, params));
  ctx.opts.log?.line("info", "providers", "providers.update", redactProvidersUpdateInput(input));
  return await h.providers.update(input);
}

export async function remove(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(deleteBody, unconfirmed(params)));
  // Confirmation is a precondition, not a failure — the same 428 the secret
  // and volume deletes answer with.
  if (!input.yes) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `deleting the provider profile ${input.profile} deletes its credential slot; send {"yes": true}`,
      { profile: input.profile },
    );
  }
  return await h.providers.delete(input);
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const providerHandlers = {
  "providers.list": list,
  "providers.create": create,
  "providers.update": update,
  "providers.delete": remove,
  "providers.models": models,
} satisfies Record<string, Handler>;
