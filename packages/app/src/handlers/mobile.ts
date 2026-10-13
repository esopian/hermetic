/**
 * `mobile.pair`: the phone companion's pairing link, from the desktop page.
 *
 * A read of the fleet and its agents, encoded as a `hermetic://fleet?v=2&…`
 * link the page draws as a QR. The link holds no secret: the phone talks to
 * the boxes directly over the tailnet, and being on the tailnet is its
 * authentication.
 */
import { MobilePairInput } from "@hermetic/core";
import { declareRpc } from "../declare.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";

export const mobilePairSchema = declareRpc("mobile.pair", MobilePairInput);

export async function mobilePair(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().mobile.pair(parseInput(mobilePairSchema, params ?? {}));
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const mobileHandlers = {
  "mobile.pair": mobilePair,
} satisfies Record<string, Handler>;
