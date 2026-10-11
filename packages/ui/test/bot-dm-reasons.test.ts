/**
 * The failure-reason table (`bot-dm-reasons.ts`) against upstream's
 * vocabulary (Hermes v2026.9.24 `tools/bot_failure_reasons.py`).
 */
import { describe, expect, test } from "bun:test";
import { DM_FAILURE_REASONS, dmFailureReason, dmRetryable } from "../src/chat/bot-dm-reasons.ts";

/** `ALL_REASONS` (`bot_failure_reasons.py:33-37`) plus `target_busy` (:133). */
const UPSTREAM = [
  "runtime_offline",
  "queued_expired",
  "delivery_timeout",
  "agent_blocked",
  "cancelled",
  "provider_auth_or_access",
  "provider_quota_limit",
  "provider_rate_limit",
  "provider_server_error",
  "context_overflow",
  "missing_config",
  "model_unavailable",
  "unknown",
  "target_busy",
];

describe("dm failure reasons", () => {
  test("covers exactly upstream's codes, each with a label and a sentence", () => {
    expect(Object.keys(DM_FAILURE_REASONS).sort()).toEqual([...UPSTREAM].sort());
    for (const code of UPSTREAM) {
      const reason = dmFailureReason(code);
      expect(reason.label.trim()).not.toBe("");
      expect(reason.guidance.trim()).toMatch(/\.$/);
    }
  });

  test("retries exactly what upstream's policy retries, plus what its sentences say to resend", () => {
    const retried = UPSTREAM.filter((code) => dmFailureReason(code).retry).sort();
    expect(retried).toEqual([
      "context_overflow",
      "delivery_timeout",
      "provider_rate_limit",
      "provider_server_error",
      "queued_expired",
      "runtime_offline",
      "target_busy",
    ]);
  });

  test("an absent, unknown or inherited code is a generic failure with no retry", () => {
    for (const code of [null, undefined, "", "flux_capacitor", "toString", "__proto__"]) {
      expect(dmFailureReason(code)).toMatchObject({ label: "failed", retry: false });
    }
  });

  test("a resolution error never retries, whatever its reason", () => {
    const refusal = (error: string, lists: { teammates?: string[]; peers?: string[] } = {}) => ({
      error,
      // Retryable on its own, as `_err`'s text classifier can make any of these.
      reason: "provider_rate_limit",
      teammates: lists.teammates ?? null,
      peers: lists.peers ?? null,
    });
    expect(dmRetryable(refusal("Rate limit hit (429); try again shortly."))).toBe(true);
    // `_roster_err` attaches the valid targets, even when there are none.
    expect(dmRetryable(refusal("Something new.", { teammates: [] }))).toBe(false);
    expect(dmRetryable(refusal("Something new.", { peers: ["lab"] }))).toBe(false);
    // Upstream's sentences that carry no roster (`tools/bot_mode_dm.py:209-283`, v2026.9.24).
    for (const error of [
      "message_agent is only available in a Bot Mode 'Bot Chat' session. This session is not one; do not retry.",
      "This install is not Bot-Mode-managed (no bot roster); message_agent is unavailable. Do not retry.",
      "message is required — compose what you want to say to that agent.",
      "message too long (16001 chars > 16000). Send the essentials; share large content as a file path instead.",
      "target is required.",
      "No registered peer named 'lab'.",
      "Invalid target: 'a b'.",
      "You can't message yourself. Pick a teammate from the roster.",
      "No teammate named 'rate-limiter' on this install, on a connected machine, or on a registered peer.",
      "'qa' exists on several connected machines — disambiguate with one of: qa@laptop, qa@desk.",
    ]) {
      expect([error, dmRetryable(refusal(error))]).toEqual([error, false]);
    }
    // A reason that never retries stays that way, whatever the text.
    expect(dmRetryable({ ...refusal("Rate limit hit."), reason: "agent_blocked" })).toBe(false);
  });
});
