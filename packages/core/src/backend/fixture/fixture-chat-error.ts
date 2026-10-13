/**
 * The fixture's failing turns, one per recovery plan a head offers.
 *
 * A prompt containing `E2E_ERROR_<CODE>` fails the turn before any assistant
 * content with an `error` frame whose `failure` carries upstream's classified
 * surface (`agent/error_surface.py`: `{layer, code, retryable, provider?, model?,
 * auth_kind?, resets_at?, provider_label?}`); `<CODE>` is the surface's `code`
 * uppercased, except the two spellings that differ (see `ErrorSpec.code`).
 * `E2E_ERROR_AFTER_TEXT` streams some text first and then fails the way
 * `RATE_LIMITED` does, which is the turn that fails partway.
 *
 * The stored turn carries the same failure (`ChatMessage.failure`, beside the
 * `error` string), so a re-read draws the same card the live frame did.
 */
import { CHAT_ERROR_CODES } from "../../chat/hermes/hermes-chat-types.ts";
import type { ChatErrorSurface, ChatFailure } from "../../schema/index.ts";

export const FIXTURE_ERROR_AFTER_TEXT_TRIGGER = "E2E_ERROR_AFTER_TEXT";
const PREFIX = "E2E_ERROR_";

interface ErrorSpec {
  message: string;
  /**
   * The surface `code` when it is not the trigger's own lowercased spelling:
   * upstream's is `rate_limit` (a `FailoverReason`), and an OAuth failure is
   * `auth` like any other, told apart by `auth_kind` alone.
   */
  code?: string;
  /** Undefined: the box sent no surface, and a head falls back to code and message. */
  surface?: Omit<ChatErrorSurface, "code" | "message" | "resets_at"> & { resets_in_s?: number };
}

/** Keyed by the surface `code`, uppercased: the part of the trigger after `E2E_ERROR_`. */
const SPECS: Record<string, ErrorSpec> = {
  RATE_LIMITED: {
    code: "rate_limit",
    message: "The provider is rate limiting this account. Try again in a minute.",
    surface: {
      layer: "provider",
      retryable: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      resets_in_s: 60,
    },
  },
  CONTEXT_OVERFLOW: {
    message: "The conversation is longer than the model's context window.",
    surface: { layer: "provider", retryable: false, provider: "anthropic", model: "claude-sonnet-5" },
  },
  PAYLOAD_TOO_LARGE: {
    message: "The request was too large for the provider to accept.",
    surface: { layer: "provider", retryable: false, provider: "anthropic", model: "claude-sonnet-5" },
  },
  AUTH: {
    message: "The provider rejected the API key for this agent.",
    surface: {
      layer: "auth",
      retryable: false,
      provider: "anthropic",
      model: "claude-sonnet-5",
      auth_kind: "api_key",
      provider_label: "Anthropic",
    },
  },
  AUTH_OAUTH: {
    code: "auth",
    message: "The provider no longer accepts this account's sign-in.",
    surface: {
      layer: "auth",
      retryable: false,
      provider: "openai-codex",
      model: "gpt-5",
      auth_kind: "oauth",
      provider_label: "OpenAI Codex",
    },
  },
  BILLING: {
    message: "The provider reports the account is out of credit.",
    surface: { layer: "billing", retryable: false, provider: "anthropic", model: "claude-sonnet-5" },
  },
  CONTENT_POLICY_BLOCKED: {
    message: "The provider declined the request under its content policy.",
    surface: { layer: "provider", retryable: false, provider: "anthropic", model: "claude-sonnet-5" },
  },
  MODEL_NOT_FOUND: {
    message: "The provider has no model with this name.",
    surface: { layer: "provider", retryable: false, provider: "anthropic", model: "claude-sonnet-9" },
  },
  LOOP_ERROR: {
    message: "The agent loop failed before it reached the provider.",
    surface: { layer: "gateway", retryable: true },
  },
  /** The box classified nothing: the failure arrives with no surface at all. */
  UNCLASSIFIED: { message: "the turn failed on the box" },
};

export interface FixtureErrorScript {
  /** Text streamed before the failure; null fails the turn before any content. */
  text: string | null;
  failure: ChatFailure;
}

/**
 * The failure a prompt triggers, or null. `now` is epoch seconds: a rate limit's
 * `resets_at` is relative to the turn, so it is the one value here a clock
 * decides.
 */
export function fixtureErrorScript(prompt: string, now: () => number): FixtureErrorScript | null {
  const afterText = prompt.includes(FIXTURE_ERROR_AFTER_TEXT_TRIGGER);
  // Longest code first, so `AUTH_OAUTH` is not read as `AUTH`.
  const code = afterText
    ? "RATE_LIMITED"
    : Object.keys(SPECS)
        .sort((a, b) => b.length - a.length)
        .find((candidate) => prompt.includes(`${PREFIX}${candidate}`));
  const spec = code === undefined ? undefined : SPECS[code];
  if (code === undefined || spec === undefined) return null;
  let surface: ChatErrorSurface | undefined;
  if (spec.surface) {
    const { resets_in_s, ...rest } = spec.surface;
    surface = {
      ...rest,
      code: spec.code ?? code.toLowerCase(),
      message: spec.message,
      ...(resets_in_s !== undefined ? { resets_at: Math.floor(now()) + resets_in_s } : {}),
    };
  }
  return {
    text: afterText ? "Checking the box before the provider call. " : null,
    failure: {
      code: CHAT_ERROR_CODES.TURN_FAILED,
      message: spec.message,
      ...(surface ? { surface } : {}),
    },
  };
}
