/**
 * The failure-reason table (`bot-dm-reasons.ts`) against upstream's
 * vocabulary (Hermes v2026.9.24 `tools/bot_failure_reasons.py`).
 */
import { describe, expect, test } from "bun:test";
import { DM_FAILURE_REASONS, dmFailureReason } from "../src/chat/bot-dm-reasons.ts";

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
});
