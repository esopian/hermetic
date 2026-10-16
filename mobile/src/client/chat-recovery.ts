/**
 * What a failed turn is called and what can be done about it.
 *
 * Mirrors `packages/ui/src/chat/chat-recovery.ts` (`recoveryPlan`,
 * `failureView`, `failedPrompt`, `isLatestFailure`, `failureDetails`) and the
 * pure half of `components/FailureCard.tsx` (`splitError`, `failureOf`).
 * Pure TypeScript.
 */
import type { AttachmentBlock, ChatFailure, ChatMessage } from "@hermetic/core/chat-client";
import { type FailureCopy, failureCopy } from "./chat-logic.ts";
import { LOCAL_PREFIX } from "./chat-pending.ts";
import { STEER_PREFIX } from "./conversation-store.ts";

const CODED = /^([A-Z][A-Z0-9_]{2,})(?:\s*[·:—-]\s*([\s\S]*))?$/;

export function splitError(error: string | null | undefined): {
  code: string | null;
  message: string | null;
} {
  if (!error) return { code: "INCOMPLETE", message: null };
  const m = CODED.exec(error.trim());
  if (!m) return { code: null, message: error };
  return { code: m[1] ?? null, message: m[2]?.trim() || null };
}

/** The message's failure: the structured one, else the older `error` string read apart. */
export function failureOf(message: ChatMessage): ChatFailure | null {
  if (message.failure) return message.failure;
  if (!message.error) return null;
  const { code, message: said } = splitError(message.error);
  return { code: code ?? "UNKNOWN", message: said ?? "" };
}

export interface RecoveryPlan {
  retry: boolean;
  /** Epoch ms before which Retry waits (upstream `resets_at`), or `null`. */
  retryAt: number | null;
  editMessage: boolean;
  compact: boolean;
  newSession: boolean;
  chooseModel: boolean;
  switchProvider: boolean;
  updateApiKey: boolean;
  signInAgain: string | null;
}

const SWITCH_LAYERS = new Set(["auth", "billing", "endpoint", "provider"]);

const CODE_PLANS: Record<string, Partial<RecoveryPlan>> = {
  SESSION_NOT_OWNED: { retry: false, newSession: true },
  content_policy_blocked: { editMessage: true, retry: false },
  context_overflow: { compact: true, retry: false, newSession: true },
  loop_error: { newSession: true },
  model_not_found: { chooseModel: true, retry: false },
  payload_too_large: { compact: true, retry: false, newSession: true },
};

const RESET_HORIZON_MS = 24 * 60 * 60_000;

export function recoveryPlan(failure: ChatFailure, now = Date.now()): RecoveryPlan {
  const surface = failure.surface ?? null;
  const auth = surface?.layer === "auth";
  const provider = surface?.provider_label || surface?.provider || null;
  const oauth = auth && surface?.auth_kind === "oauth" && !!provider;
  const apiKey = auth && surface?.auth_kind === "api_key";
  const resets = surface?.resets_at !== undefined ? surface.resets_at * 1000 : null;
  const base: RecoveryPlan = {
    retry: !surface || surface.retryable || oauth || apiKey,
    retryAt: resets !== null && resets > now && resets - now <= RESET_HORIZON_MS ? resets : null,
    editMessage: false,
    compact: false,
    newSession: false,
    chooseModel: false,
    switchProvider: !!surface && SWITCH_LAYERS.has(surface.layer),
    updateApiKey: apiKey,
    signInAgain: oauth ? provider : null,
  };
  const override = (surface && CODE_PLANS[surface.code]) || CODE_PLANS[failure.code] || {};
  return { ...base, ...override };
}

const SURFACE_ALIAS: Record<string, string> = {
  rate_limit: "RATE_LIMITED",
  rate_limited: "RATE_LIMITED",
  upstream_rate_limit: "RATE_LIMITED",
  context_overflow: "CONTEXT_FULL",
  payload_too_large: "CONTEXT_FULL",
  auth: "PROVIDER_AUTH",
  auth_permanent: "PROVIDER_AUTH",
};

export function failureView(failure: ChatFailure | null): FailureCopy {
  if (!failure) return failureCopy("INCOMPLETE", null);
  const surface = failure.surface;
  const alias = surface ? SURFACE_ALIAS[surface.code] : undefined;
  const copy = failureCopy(alias ?? failure.code, surface?.message || failure.message);
  return surface ? { ...copy, right: surface.code } : copy;
}

const isPrompt = (m: ChatMessage): boolean =>
  m.role === "user" && !m.from_bot && !m.id.startsWith(STEER_PREFIX);

/**
 * What started a failed turn, for its Retry (desktop `TurnPrompt`): the
 * operator's words and the files that went with them, as chips carrying each
 * file's id. `recorded` is whether the row is the box's own (its files were
 * committed, so the stage area's expiry no longer applies) rather than this
 * phone's optimistic echo.
 */
export interface TurnPrompt {
  text: string;
  files: AttachmentBlock[];
  recorded: boolean;
}

/** The prompt a failed turn answered, words and files: the operator's message above it. */
export function failedTurnPrompt(
  messages: readonly ChatMessage[],
  ids: readonly string[],
): TurnPrompt | null {
  const at = messages.findIndex((m) => ids.includes(m.id));
  for (let i = at - 1; i >= 0; i -= 1) {
    const m = messages[i] as ChatMessage;
    if (!isPrompt(m)) continue;
    const text = m.blocks
      .map((b) => (b.kind === "text" ? b.markdown : ""))
      .join("")
      .trim();
    const files = m.blocks.filter((b): b is AttachmentBlock => b.kind === "attachment");
    if (!text && files.length === 0) return null;
    return { text, files, recorded: !m.id.startsWith(LOCAL_PREFIX) };
  }
  return null;
}

/** The words of the prompt a failed turn answered (Edit message), or `null` when it had none. */
export function failedPrompt(messages: readonly ChatMessage[], ids: readonly string[]): string | null {
  return failedTurnPrompt(messages, ids)?.text || null;
}

/** Sending again is the latest failure's to offer: nothing the bot said since. */
export function isLatestFailure(messages: readonly ChatMessage[], ids: readonly string[]): boolean {
  let last = -1;
  messages.forEach((m, i) => {
    if (ids.includes(m.id)) last = i;
  });
  const reply = (m: ChatMessage) =>
    (m.role === "bot" && !m.blocks.every((b) => b.kind === "process_event")) ||
    (m.role === "user" && !!m.from_bot);
  return last !== -1 && !messages.slice(last + 1).some(reply);
}

export function failureDetails(failure: ChatFailure, at: string): string {
  const s = failure.surface;
  const said = (s?.message || failure.message).trim();
  const shown = !!said && failureView(failure).detail.includes(said);
  return [
    `time: ${at}`,
    `code: ${failure.code}`,
    s ? `layer: ${s.layer}` : null,
    s ? `upstream code: ${s.code}` : null,
    s ? `retryable: ${s.retryable}` : null,
    s?.resets_at !== undefined ? `resets at: ${new Date(s.resets_at * 1000).toISOString()}` : null,
    s?.provider ? `provider: ${s.provider}` : null,
    s?.model ? `model: ${s.model}` : null,
    shown ? `message: ${said}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Whether a turn error still needs its band (desktop `Thread.tsx`): not when
 * the last message already carries the failure, because its card says it there
 * with what to do about it. The band is for a turn refused before it got that
 * far, which has no message to carry it.
 */
export function turnErrorNeedsBand(
  messages: readonly ChatMessage[],
  live: ChatMessage | null,
): boolean {
  const last = live ?? messages[messages.length - 1];
  return !(last?.failure || last?.error);
}
