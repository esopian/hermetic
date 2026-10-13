/**
 * What a failed turn offers the operator (§9.2), and the drafting helpers the
 * failure card and a settled clarify share.
 *
 * `recoveryPlan` mirrors Hermes Desktop's `errorRecoveryPlan`
 * (`apps/desktop/src/lib/error-surface.ts`) over upstream's classified failure
 * (`ChatFailure.surface`): the layer decides the defaults, a handful of codes
 * override them. Every action maps onto something hermetic already has —
 * `chat.send` again, `chat.compact`, a new session, a link to where the
 * provider binding or key lives — so the card only decides what to show. It
 * never collects a credential (#20) and never retries on its own.
 */
import type { ChatFailureView, ChatMessageView } from "../api/index.ts";
import { failureCopy } from "./chat-logic.ts";
import { isProcessEventMessage } from "./process-events.ts";
import type { FailureCopy } from "./chat-logic.ts";

export interface RecoveryPlan {
  /** Send the failed turn's own prompt again, into the same session. */
  retry: boolean;
  /** Epoch ms before which Retry waits (upstream `resets_at`), or `null`. Never auto-fires. */
  retryAt: number | null;
  /** Put the failed prompt back in the composer (a blocked prompt). */
  editMessage: boolean;
  /** `chat.compact` the session (the context is too long). */
  compact: boolean;
  /** Send the failed prompt into a new session (this one cannot continue as-is). */
  newSession: boolean;
  /** Link to the agent's provider binding: the model is not there. */
  chooseModel: boolean;
  /** Link to the agent's provider binding: the fix is provider, endpoint or auth config. */
  switchProvider: boolean;
  /** Link to Settings → Providers: the provider rejected the profile's API key. */
  updateApiKey: boolean;
  /** The provider to sign in to again, on the box (an OAuth credential), or `null`. */
  signInAgain: string | null;
}

/** Layers where the fix is provider, endpoint or auth config rather than a retry. */
const SWITCH_LAYERS = new Set(["auth", "billing", "endpoint", "provider"]);

/**
 * Per-code overrides on the layer defaults, as Desktop's `CODE_PLANS`. `retry:
 * false` is a failure an unchanged retry is known to reproduce.
 */
const CODE_PLANS: Record<string, Partial<RecoveryPlan>> = {
  SESSION_NOT_OWNED: { retry: false, newSession: true },
  content_policy_blocked: { editMessage: true, retry: false },
  context_overflow: { compact: true, retry: false, newSession: true },
  loop_error: { newSession: true },
  model_not_found: { chooseModel: true, retry: false },
  payload_too_large: { compact: true, retry: false, newSession: true },
};

/** How far ahead a `resets_at` is still believed; a stamp past this is noise. */
const RESET_HORIZON_MS = 24 * 60 * 60_000;

/**
 * The actions a failure card offers. No surface (an older box, a failure
 * minted before the turn reached it) offers Retry, as Desktop does.
 */
export function recoveryPlan(failure: ChatFailureView, now = Date.now()): RecoveryPlan {
  const surface = failure.surface ?? null;
  const auth = surface?.layer === "auth";
  // Upstream names the provider; `provider_label` is its display name, when sent.
  const provider = surface?.provider_label || surface?.provider || null;
  const oauth = auth && surface?.auth_kind === "oauth" && !!provider;
  const apiKey = auth && surface?.auth_kind === "api_key";
  const resets = surface?.resets_at !== undefined ? surface.resets_at * 1000 : null;
  const base: RecoveryPlan = {
    // A rejected credential is the exception to "deterministic means no
    // retry": fixing the credential changes the outcome, and Retry is the
    // natural second click.
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

/**
 * The copy a failure card reads. Upstream's code picks hermetic's own words
 * where they say the same thing; anything else keeps core's code and the
 * message the box sent. The right-hand tag names upstream's code when there is
 * one, since that is what the box's logs will say.
 */
export function failureView(failure: ChatFailureView | null): FailureCopy {
  if (!failure) return failureCopy("INCOMPLETE", null);
  const surface = failure.surface;
  const alias = surface ? SURFACE_ALIAS[surface.code] : undefined;
  const copy = failureCopy(alias ?? failure.code, surface?.message || failure.message);
  return surface ? { ...copy, right: surface.code } : copy;
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

/**
 * The id prefix of a steer's optimistic prompt (`chat-conversations.ts`):
 * words said into a running turn, not the prompt that started it.
 */
export const STEER_PREFIX = "local:steer:";

/** An operator's own prompt: not another bot's delivery, not a steer into a running turn. */
const isPrompt = (m: ChatMessageView): boolean =>
  m.role === "user" && !m.from_bot && !m.id.startsWith(STEER_PREFIX);

/**
 * The prompt a failed turn answered: the nearest operator prompt above the
 * failed message, found by the failed message's own ids — never "the last
 * thing the operator said", which may belong to a later turn, and never a
 * steer said into this one. `null` when the conversation in hand does not
 * hold it.
 */
export function failedPrompt(
  messages: readonly ChatMessageView[],
  ids: readonly string[],
): string | null {
  const at = messages.findIndex((m) => ids.includes(m.id));
  for (let i = at - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (!isPrompt(m)) continue;
    const text = m.blocks
      .map((b) => (b.kind === "text" ? b.markdown : ""))
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

/**
 * Whether the failed message is the conversation's latest reply: no reply
 * after it — a bot row, or another bot's delivery on the user role — only the
 * operator's own words, tool rows and background-process events. Only then
 * does its card offer to send again (Retry, Compact, a new session), as
 * Desktop offers them only on the last message: a Retry that started a new
 * turn leaves the old card inert, and an older failure has been overtaken.
 */
export function isLatestFailure(messages: readonly ChatMessageView[], ids: readonly string[]): boolean {
  let last = -1;
  messages.forEach((m, i) => {
    if (ids.includes(m.id)) last = i;
  });
  const reply = (m: ChatMessageView) =>
    (m.role === "bot" && !isProcessEventMessage(m)) || (m.role === "user" && !!m.from_bot);
  return last !== -1 && !messages.slice(last + 1).some(reply);
}

/**
 * The failure as plain text, for "Copy details". No credential ever rides on a
 * failure, and the box's message is copied only where the card itself shows
 * it: a card whose words replace it (a rejected key, a full context, a lost
 * box) does not leak it through the clipboard either.
 */
export function failureDetails(failure: ChatFailureView, at: string): string {
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

/** Desktop's late-answer draft (`i18n/en.ts` `lateAnswer`). */
export function lateAnswer(prompt: string, choice: string): string {
  return `Re: "${prompt}" — my answer: ${choice}`;
}

/**
 * Put `text` in the composer and focus it, after whatever the operator had
 * typed rather than over it. Never sends. The composer nearest `from` wins,
 * so a card in the dock fills the dock's composer.
 */
export function draftInto(
  current: string,
  setDraft: (text: string) => void,
  text: string,
  from?: Element | null,
): void {
  const kept = current.trim();
  const next = kept && kept !== text ? `${current}\n\n${text}` : text;
  setDraft(next);
  // After the render that puts the text in, so the caret lands at its end.
  setTimeout(() => {
    let scope: Element | null = from ?? null;
    let input: HTMLTextAreaElement | null = null;
    while (scope && !input) {
      input = scope.querySelector<HTMLTextAreaElement>(".ch-composer textarea.ch-input");
      scope = scope.parentElement;
    }
    input ??= document.querySelector<HTMLTextAreaElement>(".ch-composer textarea.ch-input");
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange?.(input.value.length, input.value.length);
  }, 0);
}
