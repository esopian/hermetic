/**
 * The browser wizard's read-only half (§4.7 steps 1–2), the Tailscale preflight
 * step 3 rests on, and the tailnet policy snippet step 4 tells the operator to
 * paste.
 *
 * These are machinery requests, not core-backed ones: they wrap `init`'s
 * pre-init helpers, which core deliberately hangs off `init` rather than
 * listing in `PUBLIC_METHODS`, because they are inputs to the one `init`
 * command. Parity stays at one method per command; `declareMachineryRpc`
 * records them alongside the routes that wrap no core method.
 *
 * Every request here is refused once a config exists. Re-targeting a home is
 * `hermetic init --reset` and nothing else (§4.6) — a wizard that could quietly
 * re-freeze a live fleet from a browser tab would undo the whole guard.
 *
 * These handlers need nothing from the context but `state`, so that is all
 * they ask for.
 */
import { z } from "zod";
import { HermeticError, acl_snippet, acl_snippet_parts } from "@hermetic/core";
import type { ErrorCode } from "@hermetic/core";
import { declareMachineryRpc } from "../declare.ts";
import type { AppState } from "../state.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";

/**
 * What these handlers read. A `HandlerContext` satisfies it, which is what puts
 * them in the dispatch table.
 */
export type InitContext = Pick<HandlerContext, "state">;

export const PROFILES = declareMachineryRpc("init.profiles");
export const IDENTITY = declareMachineryRpc("init.identity");
export const ACL = declareMachineryRpc("init.acl");
export const TAILSCALE = declareMachineryRpc("init.tailscale");
export const VERIFY_OAUTH = declareMachineryRpc("init.verifyOauth");

/** The wizard's own request shape; not a core method, so not a core schema. */
export const IdentityRequest = z.object({
  profile: z.string().min(1),
  region: z.string().optional(),
});

/**
 * The OAuth secret the operator just pasted into step 3, on its way to being
 * *used* and not stored: this request mints a probe key with it and revokes it
 * again. It rides the same loopback, same-origin channel `init` already carries
 * it on (`security.ts`), it is never logged, and the response names only what
 * failed (§8.3).
 */
export const TailscaleOauthRequest = z.object({
  secret: z.string().min(1),
});

export const ALREADY_INITIALIZED = {
  error: {
    code: "CONFLICT",
    message: "already initialized; use `hermetic init --reset`",
  },
} as const;

/**
 * The wizard is refused once `state.initialized` — the normal
 * already-initialized case — but also while a *finished* init's `adopt()` (the
 * reopen-and-swap) has failed: `state.initialized` is still false then, but
 * offering the wizard again would let the operator re-run `init` against a
 * fleet that already exists (see `AppState.adopt`). Returns the 409 body to
 * send, or `null` when the request may proceed.
 *
 * Kept as a body-returning function because `tests/` reads the shape. New code
 * calls `requireInitAllowed`.
 */
export function initBlocked(state: AppState): { error: { code: string; message: string } } | null {
  if (state.initialized) return ALREADY_INITIALIZED;
  if (state.adoptError !== null) {
    return {
      error: {
        code: "CONFLICT",
        message: `init already finished but the server failed to switch over (${state.adoptError}); restart hermetic-portal`,
      },
    };
  }
  return null;
}

/**
 * `initBlocked`, as a refusal rather than a body — the same move
 * `requireWritable` makes in `handlers/shared.ts`, and for the same reason: a
 * handler has no `c.json(body, 409)` to return. The wire is unchanged, since
 * `errors.ts` maps `CONFLICT` to 409 and `classifyFailure` builds the identical
 * `{error: {code, message}}` body.
 */
export function requireInitAllowed(state: AppState): void {
  const blocked = initBlocked(state);
  if (blocked === null) return;
  throw new HermeticError(blocked.error.code as ErrorCode, blocked.error.message);
}

/**
 * The region every later call is made in. Core resolves an identity in the
 * region it is given and does not guess, so the wizard supplies one: the
 * operator's choice, else the profile's own default from `~/.aws/config`, else
 * AWS's. Getting this wrong would resolve an identity in one region and describe
 * a foundation in another.
 */
export const FALLBACK_REGION = "us-east-1";

async function regionFor(
  state: AppState,
  profile: string,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined && requested !== "") return requested;
  const profiles = await state.hermetic.init.listProfiles();
  return profiles.find((p) => p.name === profile)?.region ?? FALLBACK_REGION;
}

export async function profiles({ state }: InitContext) {
  requireInitAllowed(state);
  // §4.7 step 1: no identity is resolved here — that would trigger an SSO login
  // for every profile in the file.
  return { profiles: await state.hermetic.init.listProfiles() };
}

export async function identity({ state }: InitContext, params: unknown) {
  requireInitAllowed(state);
  const { profile, region } = parseInput(IdentityRequest, params);
  // §4.7 step 2, for the chosen profile only: STS, then IAM and Organizations
  // best-effort, then a read-only DescribeStacks so the wizard can say which
  // fleet the operator is about to join.
  const resolved = await state.hermetic.init.resolveIdentity(
    profile,
    await regionFor(state, profile, region),
  );
  const foundation = await state.hermetic.init.describeFoundation(profile, resolved.region);
  return { identity: resolved, foundation };
}

/**
 * §4.7 preflight: is *this machine* on a tailnet, and which one. The wizard
 * shows the answer for the operator to confirm instead of asking them to type a
 * tailnet nothing validated — and `init` refuses the create branch on the same
 * reading, so this is the preview of a gate, not the gate.
 */
export async function tailscale({ state }: InitContext) {
  requireInitAllowed(state);
  return { tailscale: await state.hermetic.init.localTailscale() };
}

export async function verifyOauth({ state }: InitContext, params: unknown) {
  requireInitAllowed(state);
  const { secret } = parseInput(TailscaleOauthRequest, params);
  return { oauth: await state.hermetic.init.verifyTailscaleOauth(secret) };
}

export async function acl({ state }: InitContext) {
  requireInitAllowed(state);
  return { snippet: acl_snippet(), parts: acl_snippet_parts() };
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const initHandlers = {
  [PROFILES]: profiles,
  [IDENTITY]: identity,
  [ACL]: acl,
  [TAILSCALE]: tailscale,
  [VERIFY_OAUTH]: verifyOauth,
} satisfies Record<string, Handler>;
