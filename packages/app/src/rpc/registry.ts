/**
 * The machine-readable request table `tests/parity.test.ts` reads.
 *
 * It is not a table: it is whatever the handler modules declared about
 * themselves once they are all loaded. See `declare.ts` for why that matters.
 *
 * It lives beside the dispatcher rather than in `declare.ts` because reading
 * the declarations means first *causing* them, which is the `HANDLERS` import
 * below — and every handler module imports `declare.ts`, so a `declare.ts`
 * that imported the dispatch table back would close the cycle.
 */
import { PUBLIC_METHODS } from "@hermetic/core";
import type { PublicMethod } from "@hermetic/core";
import { machineryRpcNames, rpcDeclarations, type RpcDeclaration } from "../declare.ts";
// Imported for its side effect as much as for its value: importing the dispatch
// table imports every handler module, which is when `declareRpc` runs.
import { HANDLERS } from "../handlers/dispatch.ts";

export type { RpcDeclaration };

/** Whatever the handler modules declared about themselves, once they are all loaded. */
export const RPC_DECLARATIONS: readonly RpcDeclaration[] = rpcDeclarations();

/** The machinery request names, read after the same imports. */
export const MACHINERY_RPC: readonly string[] = machineryRpcNames();

/**
 * Every request name the dispatcher answers: the public methods plus the
 * machinery. Read after the same side-effect import above, so it is what the
 * handler modules registered rather than a table anybody wrote out.
 */
export const HANDLER_NAMES: readonly string[] = Object.keys(HANDLERS);

/** Public methods no handler declared itself for. Empty is the contract. */
export function unhandledMethods(): PublicMethod[] {
  const declared = new Set(RPC_DECLARATIONS.map((r) => r.path));
  return [...PUBLIC_METHODS].filter((p) => !declared.has(p));
}
