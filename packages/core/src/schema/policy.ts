import { z } from "zod";

/**
 * What hermetic can see and do to the tailnet policy file, and what it found
 * there (§4.7, §5 "Tailnet policy").
 *
 * The policy file is the operator's — it usually lives in git and its comments
 * are load-bearing — so hermetic owns nothing but the lines between its
 * `// hermetic:managed` markers (`hujson.ts`). This report is what a head shows
 * before anyone is asked to let it write: which of the three blocks are there,
 * which have drifted, which hermetic is deliberately leaving alone, and the
 * exact diff a write would produce.
 *
 * Nothing here is a secret, but the policy file *can* name people (a `groups`
 * entry is a list of email addresses), so what travels is a diff of hermetic's
 * own marker-to-marker ranges and nothing else — not the document, and not the
 * lines around those ranges either.
 */

/**
 * What the fleet's OAuth client may do with the policy file. `write` is the
 * `policy_file` scope, `read` is `policy_file:read`, and `none` is a client
 * created before hermetic asked for either — which is every fleet initialised
 * before this feature and is therefore a report, not a failure.
 */
export const PolicyScope = z.enum(["write", "read", "none"]);
export type PolicyScope = z.infer<typeof PolicyScope>;

/**
 * One managed block's state.
 *
 * `skipped` is the interesting one: hermetic writes the `tagOwners` block only
 * when nothing *outside* a managed block already owns `tag:hermetic`. The
 * operator has to paste that line by hand before the OAuth client can be
 * created at all (the client form only offers tags that already have an owner),
 * so by the time hermetic can read the policy the line is normally already
 * there — and a second `"tag:hermetic"` key in the same object is invalid
 * HuJSON, not an improvement.
 */
export const PolicyBlockState = z.enum(["absent", "current", "drifted", "skipped"]);
export type PolicyBlockState = z.infer<typeof PolicyBlockState>;

export const PolicyBlockReport = z.object({
  /** The top-level policy key the block sits inside: `tagOwners`, `ssh`, `acls`. */
  key: z.string(),
  state: PolicyBlockState,
  /** Why it is `skipped` or `drifted`, or null. Never a secret. */
  reason: z.string().nullable(),
});
export type PolicyBlockReport = z.infer<typeof PolicyBlockReport>;

/**
 * Whether the policy says what this build of hermetic would write.
 * `unavailable` is not "no": it is "we could not read the file", which the
 * report keeps distinct so an operator never reads a missing scope as a clean
 * bill (the same rule `doctor`'s device list follows).
 */
export const PolicyManagedState = z.enum(["absent", "current", "drifted", "unavailable"]);
export type PolicyManagedState = z.infer<typeof PolicyManagedState>;

/**
 * How much a finding matters. `high` is reach an agent box should not have:
 * a rule that lets it out to the rest of the tailnet, SSH out of it, or routes
 * it can advertise and have approved without a human. `info` is worth knowing
 * but not reach in itself — a Funnel attribute, or a rule whose addresses may
 * or may not belong to a box.
 */
export const PolicyExposureSeverity = z.enum(["high", "info"]);
export type PolicyExposureSeverity = z.infer<typeof PolicyExposureSeverity>;

/**
 * One rule in the operator's own policy that lets a `tag:hermetic` box reach
 * beyond what hermetic needs (§5.2 "What the rest of the policy lets a box do").
 * Informational: hermetic never edits the rule and `doctor` never reports it.
 *
 * The rule is named by its top-level key and position and nothing else. The
 * policy can name people, so `summary` is built from a fixed vocabulary and
 * never quotes a selector, a group member or an address from the document.
 */
export const PolicyExposure = z.object({
  /** The policy key the rule sits in: `acls`, `grants`, `ssh`, `autoApprovers.routes`, … */
  rule: z.string(),
  /** The rule's zero-based position under that key, or null for a finding about the whole file. */
  index: z.number().int().nonnegative().nullable(),
  severity: PolicyExposureSeverity,
  summary: z.string(),
});
export type PolicyExposure = z.infer<typeof PolicyExposure>;

export const PolicyReport = z.object({
  scope: PolicyScope,
  /**
   * Why the scope is not `write`, when that could not be *proved* rather than
   * refused. `policy_file` write is claimed only on a 200 from `/acl/validate`;
   * a 400 (the policy's own embedded tests failing), a 429 or a 5xx leave the
   * question open, and an open question is reported as `read` with the answer
   * Tailscale actually gave. Null whenever the scope is definite — including a
   * plain 403, which is an answer.
   */
  scope_reason: z.string().nullable(),
  managed: PolicyManagedState,
  blocks: z.array(PolicyBlockReport),
  /**
   * The ETag of the policy this report read. `plan.policy` carries it into the
   * plan and `apply` sends it back as `If-Match`, so a policy edited in the
   * admin console between the plan and the apply is a `CONFLICT` rather than a
   * silent overwrite of somebody else's work.
   */
  etag: z.string().nullable(),
  /**
   * A unified diff of hermetic's own marker-to-marker ranges, one hunk per
   * managed key, or null when there is nothing to write. Never a line of the
   * document from outside those ranges.
   */
  diff: z.string().nullable(),
  /**
   * Rules outside hermetic's blocks that let an agent box reach further than
   * hermetic needs (`fleet/policy-exposure.ts`). An empty array is a policy
   * that was read and found clean; null is a policy that could not be read or
   * parsed, so a missing scope never reads as a clean bill.
   */
  exposure: z.array(PolicyExposure).nullable(),
});
export type PolicyReport = z.infer<typeof PolicyReport>;
