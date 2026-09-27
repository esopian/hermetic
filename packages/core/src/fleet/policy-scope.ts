/**
 * One answer to "what may this OAuth client do with the tailnet policy file?",
 * for the two places that ask (§4.7).
 *
 * `preflight.ts` asks with a raw token, before there is a fleet; `policy.ts`
 * asks through `backend.tailscale`, after there is one. They used to answer
 * differently on the same tailnet: the preflight said `write` only when
 * `/acl/validate` returned 200, while `policy.status` said `write` on *any*
 * failure except the one message that spells 403 — so a policy whose embedded
 * tests fail (400), a rate limit (429) or a Tailscale outage (5xx) read as
 * "hermetic may write your ACLs" in one head and "it may not" in the other.
 *
 * The rule here, once, for both: only a 200 from validate proves the write
 * scope. Anything else that is not a plain 403 is *unproven*, which is reported
 * as `read` with a `reason` — the honest answer, and the safe one, because the
 * cost of under-claiming is a note and the cost of over-claiming is an operator
 * told they can apply a policy write that will be refused.
 *
 * The probe validates the policy **unchanged**, which is why a 400 is
 * information rather than a verdict: the only document guaranteed to be valid
 * is the one the tailnet already has, so a rejection of it says something about
 * the tailnet, not about hermetic's blocks.
 */
import type { PolicyScope } from "../schema/index.ts";

/** What `probePolicyScope` needs from whoever is holding the credential. */
export interface PolicyScopeProbe {
  /**
   * `GET /acl`. The policy text, or `null` when the read was refused (403) or
   * failed — the two are indistinguishable from outside and only one of them
   * is fine, so both read as "no scope" (§9's rule for the device list).
   */
  read: () => Promise<string | null>;
  /**
   * `POST /acl/validate` with exactly the text `read` returned. `forbidden`
   * separates the one answer that *is* a verdict (403: no write scope) from
   * every other failure, which is only ever a reason.
   */
  validate: (
    text: string,
  ) => Promise<{ ok: true } | { ok: false; forbidden: boolean; message: string }>;
}

/**
 * The scope, and why it is not `write` when that could not be proved. `reason`
 * is null whenever the answer is definite — a 403 from either call is an
 * answer, not a failure to get one.
 */
export interface PolicyScopeResult {
  scope: PolicyScope;
  reason: string | null;
}

/** Never a secret: the caller redacts before it gets here (§8.3). */
function unproven(message: string): string {
  return `could not prove policy_file write: validate answered ${message}; treating the client as read-only`;
}

export async function probePolicyScope(probe: PolicyScopeProbe): Promise<PolicyScopeResult> {
  const text = await probe.read();
  if (text === null) return { scope: "none", reason: null };
  let outcome: Awaited<ReturnType<PolicyScopeProbe["validate"]>>;
  try {
    outcome = await probe.validate(text);
  } catch {
    return { scope: "read", reason: unproven("nothing — api.tailscale.com could not be reached") };
  }
  if (outcome.ok) return { scope: "write", reason: null };
  if (outcome.forbidden) return { scope: "read", reason: null };
  return { scope: "read", reason: unproven(outcome.message) };
}
