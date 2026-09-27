/**
 * One name in, one result out.
 *
 * Everything reaches the handlers through this function: `rpc/bind.ts` calls it
 * with a name off the bridge, and tests call it with no transport at all —
 * which is the point, because the behaviour under test is "what the handler
 * did" rather than "what a transport rendered".
 *
 * The table is a merge and nothing else. A handler module owns its own entries
 * (`agentHandlers` in `handlers/agents.ts`), so adding a method is one line
 * there and one import here.
 */
import { HermeticError } from "@hermetic/core";
import type { HandlerContext } from "./ctx.ts";
import type { StreamSink } from "./streams.ts";
import { agentHandlers } from "./agents.ts";
import { appHandlers } from "./app.ts";
import { botModeHandlers } from "./bot-mode.ts";
import { chatHandlers } from "./chat.ts";
import { fixtureHandlers } from "./fixture.ts";
import { fleetHandlers } from "./fleet.ts";
import { initHandlers } from "./init.ts";
import { lifecycleHandlers } from "./lifecycle.ts";
import { metaHandlers } from "./meta.ts";
import { opHandlers } from "./ops.ts";
import { planHandlers } from "./plans.ts";
import { providerHandlers } from "./providers.ts";
import { secretHandlers } from "./secrets.ts";

export type { StreamSink, StreamFrame, StreamRegistry, StreamHandle } from "./streams.ts";
export { createStreamRegistry } from "./streams.ts";

/**
 * What every handler is. `sink` is passed only for the handful of methods that
 * push frames rather than answering once; a handler that ignores it satisfies
 * the type, which is why the table can hold both kinds.
 */
export type Handler = (ctx: HandlerContext, params: unknown, sink?: StreamSink) => Promise<unknown>;

/**
 * Every request name this head answers, and nothing else.
 * `tests/parity.test.ts` asserts it is exactly `PUBLIC_METHODS` plus
 * `MACHINERY_RPC`, so a handler with no method behind it and a method with no
 * handler are both build failures.
 *
 * Built on a null prototype rather than a literal. The name reaching
 * `dispatch` comes off the wire, and a plain object answers `constructor`,
 * `toString` and `valueOf` with real functions — so `dispatch(ctx,
 * "constructor", params)` found a "handler", called `Object(ctx, …)` and
 * resolved with the context itself instead of refusing. Inheriting from
 * nothing is what makes the lookup mean what it reads as.
 */
export const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Handler>, {
    ...agentHandlers,
    ...appHandlers,
    ...botModeHandlers,
    ...chatHandlers,
    ...fixtureHandlers,
    ...fleetHandlers,
    ...initHandlers,
    ...lifecycleHandlers,
    ...metaHandlers,
    ...opHandlers,
    ...planHandlers,
    ...providerHandlers,
    ...secretHandlers,
  }),
);

/**
 * `async` on purpose. An unknown name is a `HermeticError` like any other
 * refusal, and a caller that wrote `dispatch(...).catch(...)` — which is what
 * a bridge handing every request to one function naturally writes — would
 * otherwise get a synchronous throw for that one case and a rejected promise
 * for every other. Every refusal leaves here the same way.
 */
export async function dispatch(
  ctx: HandlerContext,
  name: string,
  params: unknown,
  sink?: StreamSink,
): Promise<unknown> {
  const handler = HANDLERS[name];
  if (handler === undefined) {
    throw new HermeticError("NOT_FOUND", `no such request ${name}`);
  }
  return await handler(ctx, params, sink);
}
