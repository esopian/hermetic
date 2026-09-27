/**
 * `fixture.chat.inject` and `fixture.chat.hint` — the fixture-only staging
 * surface.
 *
 * ## Why the portal needs them
 *
 * Phase 7's headline acceptance criterion is that an external Desktop, CLI or
 * routine message arrives in a watched conversation without a two-minute wait.
 * Every other fixture scenario is a row in a table, because it is something the
 * box already holds; this one is an *event*, and `bun run dev:fixture` has no
 * gateway to produce one. Core's `hermetic.fixture.chat` stages it — an
 * injection appends a `user` row to the fixture box's durable transcript and
 * announces it on the hint streams open for that bot, a hint announces without
 * appending — and these two requests are how a browser or a QA script reaches
 * it while the portal is running.
 *
 * ## Machinery, not declared methods
 *
 * Neither wraps a `PUBLIC_METHOD`: `fixture.chat.inject`/`.hint` are not §9
 * commands, they have no CLI verb, and they exist only on a `Hermetic` built
 * with `fixture: true`. They are declared with `declareMachineryRpc` and so
 * land in `MACHINERY_RPC` (`declare.ts`), where the parity contract accounts
 * for them rather than leaving them unnoticed.
 *
 * ## Why the guard is first
 *
 * `hermetic.fixture` is `null` in real mode — core builds the control object
 * only on the `deps.fixture === true` branch — so a real-mode head has no
 * method to call and these requests must read as *absent*, not as forbidden.
 * The guard therefore runs before the params are touched: a malformed request
 * to a real head is refused `NOT_FOUND` like any unknown name, never as a
 * schema complaint, because a schema complaint would confirm the request is
 * there and merely unhappy with what it was sent.
 *
 * The refusal is a thrown `NOT_FOUND` from the handler rather than something a
 * binding decided, so the guard travels with the handler to every transport
 * (`packages/app/test/handlers/dispatch.test.ts` pins the ordering, and the
 * mutation that would break it).
 *
 * ## Why no request schema
 *
 * Core validates with `FixtureChatInjectInput`/`FixtureChatHintInput` itself
 * and throws `VALIDATION`, so a second copy of the schema here would be a
 * second thing to keep in step with no assertion holding the two together. The
 * raw params go through, and the app's existing error mapping (`errors.ts`)
 * turns core's codes into statuses: `VALIDATION` → 400, `CHAT_UNREACHABLE` →
 * 502 with the rest of chat, `UNSUPPORTED` → 501 for the refusal only a test
 * can reach (a head gets the 404 from the guard first).
 *
 * Nothing here logs the request. The message body is operator text and the
 * portal log is a file on the laptop; only a *failed* request is logged, and
 * what is written is core's own error message, which names the field rather
 * than repeating what was sent.
 */
import { HermeticError } from "@hermetic/core";
import type { FixtureControls } from "@hermetic/core";
import { declareMachineryRpc } from "../declare.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";

/**
 * What these handlers read: the instance getter alone. A `HandlerContext`
 * satisfies it, which is what puts them in the dispatch table.
 */
export type FixtureContext = Pick<HandlerContext, "hermetic">;

export const INJECT = declareMachineryRpc("fixture.chat.inject");
export const HINT = declareMachineryRpc("fixture.chat.hint");

/**
 * The staging surface, or a refusal that reads as "no such request".
 *
 * `state.hermetic` throws when the portal has neither an instance nor an init
 * session (`state.ts`), and an uninitialized portal is not a fixture portal
 * either — so that throw is answered the same way rather than as a 500 about
 * server state the caller cannot act on.
 */
function fixtureControls({ hermetic }: FixtureContext): FixtureControls {
  let controls: FixtureControls | null = null;
  try {
    controls = hermetic().fixture;
  } catch {
    controls = null;
  }
  if (controls === null) {
    throw new HermeticError(
      "NOT_FOUND",
      "fixture staging is available in fixture mode only (--fixture / HERMETIC_FIXTURE=1)",
    );
  }
  return controls;
}

export async function inject(ctx: FixtureContext, params: unknown) {
  const controls = fixtureControls(ctx);
  return await controls.chat.inject(params);
}

export async function hint(ctx: FixtureContext, params: unknown) {
  const controls = fixtureControls(ctx);
  return await controls.chat.hint(params);
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const fixtureHandlers = {
  [INJECT]: inject,
  [HINT]: hint,
} satisfies Record<string, Handler>;
