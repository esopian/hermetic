/**
 * Why a `message_agent` delivery failed, in words, and whether asking again
 * can help.
 *
 * Upstream ships the reason as a closed machine code beside its free-text
 * `error` (`tools/bot_failure_reasons.py:16-37`, Hermes v2026.9.24), plus
 * `target_busy`, which predates that set (`bot_failure_reasons.py:133`). It
 * has no human-facing labels for them anywhere — Desktop never reads the code
 * — so the labels here are hermetic's, and the guidance leans on upstream's own
 * error sentences where it has them.
 *
 * `retry` follows upstream's retry policy (`bot_failure_reasons.py:39-64`):
 * the four `AUTO_RETRYABLE` reasons, plus `context_overflow`, which upstream
 * re-runs after compressing the transcript (`retry_action`, and the runner's
 * `!= RETRY_NONE` gate at `tools/bot_mode_dm.py:428`). `target_busy` and
 * `queued_expired` are outside that policy only because an automatic retry
 * cannot know when the target frees up or the Desktop reconnects; upstream's
 * own sentences tell the sender to try again (`bot_mode_dm.py:444-445`,
 * `tools/bot_relay.py:623-625`, `bot_relay.py:325-328`), which is exactly what
 * an operator Retry asks for. Auth, quota, config, model, `agent_blocked`,
 * `cancelled` and `unknown` never retry: "it can't be fixed by a retry and only
 * burns quota" (`bot_failure_reasons.py:50-51`).
 */

export interface DmFailureReason {
  /** A few words for the marker's summary: "Couldn't message X · <label>". */
  label: string;
  /** One sentence on what happened and what to do about it. */
  guidance: string;
  /** Whether asking the sender to send again can succeed without anyone fixing anything first. */
  retry: boolean;
}

/** Every code upstream v2026.9.24 can put in a refusal's `reason`. */
export const DM_FAILURE_REASONS: Readonly<Record<string, DmFailureReason>> = {
  // platform-side (`bot_failure_reasons.py:16-21`)
  runtime_offline: {
    label: "its machine is offline",
    guidance:
      "The target's machine isn't connected right now, so nothing was queued; it can be sent again once that machine reconnects.",
    retry: true,
  },
  queued_expired: {
    label: "expired in the queue",
    guidance:
      "The message waited too long for the Desktop relay to pick it up and was not delivered; it can be sent again once the Desktop reconnects.",
    retry: true,
  },
  delivery_timeout: {
    label: "delivery timed out",
    guidance:
      "The delivery did not finish in time and the message was not delivered; it can be sent again.",
    retry: true,
  },
  agent_blocked: {
    label: "blocked",
    guidance: "The target is blocked from taking this message; sending it again will not change that.",
    retry: false,
  },
  cancelled: {
    label: "cancelled",
    guidance: "The delivery was cancelled before the target answered.",
    retry: false,
  },
  target_busy: {
    label: "busy in another window",
    guidance:
      "The target's Bot Chat is open on another surface or already running another delivery, so the message was not delivered; it can be sent again shortly.",
    retry: true,
  },
  // agent-side (`bot_failure_reasons.py:23-31`)
  provider_auth_or_access: {
    label: "model provider refused access",
    guidance:
      "The target's model provider rejected its credentials; fix the provider key before sending again.",
    retry: false,
  },
  provider_quota_limit: {
    label: "out of provider quota",
    guidance: "The target's model provider is out of quota or funds; top it up before sending again.",
    retry: false,
  },
  provider_rate_limit: {
    label: "rate-limited",
    guidance: "The model provider rate-limited the turn; it can be sent again in a moment.",
    retry: true,
  },
  provider_server_error: {
    label: "model provider error",
    guidance: "The model provider failed or was overloaded; it can be sent again in a moment.",
    retry: true,
  },
  context_overflow: {
    label: "conversation too long",
    guidance:
      "The Bot Chat outgrew the model's context; Hermes compresses it on a retry, so it can be sent again.",
    retry: true,
  },
  missing_config: {
    label: "not configured",
    guidance: "No model provider is configured for the bot; set one up before sending again.",
    retry: false,
  },
  model_unavailable: {
    label: "model unavailable",
    guidance:
      "The configured model does not exist or is not available; pick another before sending again.",
    retry: false,
  },
  unknown: {
    label: "failed",
    guidance: "Hermes could not classify the failure; upstream's own message is below.",
    retry: false,
  },
};

/** The reason for a missing code, or one newer than this build: say only that it failed. */
const GENERIC: DmFailureReason = {
  label: "failed",
  guidance: "The message was not delivered; upstream's own message is below.",
  retry: false,
};

/** A failure code as words, the generic entry for no code or one this build does not know. */
export function dmFailureReason(code: string | null | undefined): DmFailureReason {
  return (code && Object.hasOwn(DM_FAILURE_REASONS, code) ? DM_FAILURE_REASONS[code] : null) ?? GENERIC;
}

/**
 * Upstream's sentences for a refusal no second send of the same call can fix:
 * the target or the message itself is wrong, or the session cannot message at
 * all (`tools/bot_mode_dm.py:209-283`, Hermes v2026.9.24). `_err` classifies
 * every refusal by its text (`classify_agent_error`, :187-195), so one of
 * these can carry a retryable `reason` — "No teammate named 'rate-limiter'"
 * reads as `provider_rate_limit`. Matched on upstream's own openings, so a
 * sentence this list does not know falls back to its reason.
 */
const UNFIXABLE_REFUSALS: readonly RegExp[] = [
  /^message_agent is only available in a Bot Mode 'Bot Chat' session\b/,
  /^This install is not Bot-Mode-managed\b/,
  /^message is required\b/,
  /^message too long \(/,
  /^target is required\./,
  /^No registered peer named '/,
  /^Invalid target: /,
  /^You can't message yourself\./,
  /^No teammate named '/,
  /^'.*' exists on several connected machines — disambiguate with one of: /s,
  /\bdo not retry\b/i,
];

/**
 * Whether asking the sender to send a refused call again can succeed: its
 * reason must be one a second send fixes, and the refusal must not be a
 * resolution error. `_err` attaches the valid targets (`teammates`, `peers`)
 * only to those, so a refusal carrying either is one whatever its reason; the
 * rest are known by upstream's sentence (`UNFIXABLE_REFUSALS`).
 */
export function dmRetryable(call: {
  reason: string | null;
  error: string | null;
  teammates: readonly string[] | null;
  peers: readonly string[] | null;
}): boolean {
  if (!dmFailureReason(call.reason).retry) return false;
  if (call.teammates !== null || call.peers !== null) return false;
  const error = call.error?.trim() ?? "";
  return !UNFIXABLE_REFUSALS.some((pattern) => pattern.test(error));
}
