/**
 * What a failed turn offers (`recoveryPlan`), and which prompt its actions
 * resend (`failedPrompt`). The plan mirrors Hermes Desktop's
 * `errorRecoveryPlan`: layer defaults, then per-code overrides.
 */
import { describe, expect, test } from "bun:test";
import type { ChatFailureView, ChatMessageView } from "../src/api/index.ts";
import {
  failedPrompt,
  failureDetails,
  isLatestFailure,
  lateAnswer,
  recoveryPlan,
} from "../src/chat/chat-recovery.ts";
import type { RecoveryPlan } from "../src/chat/chat-recovery.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");

const failure = (surface?: ChatFailureView["surface"], code = "CHAT_TURN_FAILED"): ChatFailureView => ({
  code,
  message: "it broke",
  ...(surface ? { surface } : {}),
});

/** The plan's offered actions, as names, so a row of the matrix reads as one line. */
function offered(plan: RecoveryPlan): string[] {
  return (
    [
      "retry",
      "editMessage",
      "compact",
      "newSession",
      "chooseModel",
      "switchProvider",
      "updateApiKey",
    ] as const
  ).filter((key) => plan[key]);
}

describe("recoveryPlan", () => {
  test("the matrix", () => {
    const rows: [string, ChatFailureView, string[]][] = [
      ["no surface", failure(), ["retry"]],
      [
        "rate limited (provider, retryable)",
        failure({ layer: "provider", code: "rate_limit", retryable: true }),
        ["retry", "switchProvider"],
      ],
      [
        "context overflow",
        failure({ layer: "provider", code: "context_overflow", retryable: false }),
        ["compact", "newSession", "switchProvider"],
      ],
      [
        "payload too large",
        failure({ layer: "provider", code: "payload_too_large", retryable: false }),
        ["compact", "newSession", "switchProvider"],
      ],
      [
        "content policy",
        failure({ layer: "provider", code: "content_policy_blocked", retryable: false }),
        ["editMessage", "switchProvider"],
      ],
      [
        "model not found",
        failure({ layer: "provider", code: "model_not_found", retryable: false }),
        ["chooseModel", "switchProvider"],
      ],
      [
        "api key rejected",
        failure({ layer: "auth", code: "auth", retryable: false, auth_kind: "api_key" }),
        ["retry", "switchProvider", "updateApiKey"],
      ],
      [
        "gateway loop error",
        failure({ layer: "gateway", code: "loop_error", retryable: false }),
        ["newSession"],
      ],
      [
        "session owned elsewhere (surface)",
        failure({ layer: "gateway", code: "SESSION_NOT_OWNED", retryable: true }),
        ["newSession"],
      ],
      ["session owned elsewhere (core code)", failure(undefined, "SESSION_NOT_OWNED"), ["newSession"]],
      ["billing", failure({ layer: "billing", code: "billing", retryable: false }), ["switchProvider"]],
    ];
    for (const [name, input, expected] of rows)
      expect({ name, offered: offered(recoveryPlan(input, NOW)) }).toEqual({ name, offered: expected });
  });

  test("an OAuth rejection names the provider by its label when upstream sends one", () => {
    const plan = recoveryPlan(
      failure({
        layer: "auth",
        code: "auth",
        retryable: false,
        auth_kind: "oauth",
        provider: "openai-codex",
        provider_label: "OpenAI Codex",
      }),
      NOW,
    );
    expect(plan.signInAgain).toBe("OpenAI Codex");
  });

  test("an OAuth rejection says to sign in again on the box, and Retry stays", () => {
    const plan = recoveryPlan(
      failure({ layer: "auth", code: "auth", retryable: false, auth_kind: "oauth", provider: "nous" }),
      NOW,
    );
    expect(plan.signInAgain).toBe("nous");
    expect(plan.retry).toBe(true);
    expect(plan.updateApiKey).toBe(false);
  });

  test("resets_at in range holds Retry until then; past or far off it does not", () => {
    const at = (seconds: number) =>
      recoveryPlan(
        failure({ layer: "provider", code: "rate_limit", retryable: true, resets_at: seconds }),
        NOW,
      ).retryAt;
    expect(at(NOW / 1000 + 60)).toBe(NOW + 60_000);
    expect(at(NOW / 1000 - 60)).toBe(null);
    expect(at(NOW / 1000 + 3 * 24 * 3600)).toBe(null);
  });
});

const msg = (id: string, role: "user" | "bot" | "system", text: string, extra = {}): ChatMessageView =>
  ({
    id,
    session: "S",
    role,
    author: null,
    at: "2026-10-12T12:00:00Z",
    blocks: text ? [{ kind: "text", markdown: text }] : [],
    usage: null,
    error: null,
    incomplete: null,
    ...extra,
  }) as unknown as ChatMessageView;

describe("failedPrompt", () => {
  const messages = [
    msg("u1", "user", "first question"),
    msg("b1", "bot", "", { failure: failure() }),
    msg("u2", "user", "a later one"),
    msg("b2", "bot", "fine"),
  ];

  test("is the operator message above the failed one, not the latest", () => {
    expect(failedPrompt(messages, ["b1"])).toBe("first question");
  });

  test("walks back over the turn's own tool rows and another bot's delivery", () => {
    const rows = [
      msg("u1", "user", "do the thing"),
      msg("dm", "user", "from a teammate", { from_bot: { name: "other" } }),
      msg("t1", "system", "tool"),
      msg("b1", "bot", "", { failure: failure() }),
    ];
    expect(failedPrompt(rows, ["t1", "b1"])).toBe("do the thing");
  });

  test("skips a steer said into the turn, back to the prompt that started it", () => {
    const rows = [
      msg("local:2026-10-12T12:00:00Z", "user", "do X"),
      msg("part~1", "bot", "Starting on X."),
      msg("local:steer:2026-10-12T12:00:03Z", "user", "actually, do Y first"),
      msg("failed:2026-10-12T12:00:03Z", "bot", "", { failure: failure() }),
    ];
    expect(failedPrompt(rows, ["failed:2026-10-12T12:00:03Z"])).toBe("do X");
  });

  test("is null when the failed message is not in hand", () => {
    expect(failedPrompt(messages, ["gone"])).toBe(null);
  });
});

describe("isLatestFailure", () => {
  const failed = msg("b1", "bot", "", { failure: failure() });
  const event = msg("ev", "system", "", {
    blocks: [{ kind: "process_event", process_id: "p1", status: "exited" }],
  });

  test("operator words, tool rows and process events after it leave it the latest", () => {
    const rows = [
      msg("u1", "user", "go"),
      failed,
      msg("t", "system", "tool"),
      event,
      msg("u2", "user", "again"),
    ];
    expect(isLatestFailure(rows, ["b1"])).toBe(true);
  });

  test("a later reply, or another bot's delivery, overtakes it", () => {
    expect(isLatestFailure([failed, msg("b2", "bot", "fine")], ["b1"])).toBe(false);
    expect(
      isLatestFailure([failed, msg("dm", "user", "hi", { from_bot: { name: "other" } })], ["b1"]),
    ).toBe(false);
  });
});

describe("drafting", () => {
  test("a late answer is Desktop's sentence", () => {
    expect(lateAnswer("Which branch?", "main")).toBe('Re: "Which branch?" — my answer: main');
  });

  test("copied details leave out a message the card itself does not show", () => {
    for (const hidden of [
      failure({ layer: "auth", code: "auth", retryable: false, auth_kind: "api_key" }),
      failure({ layer: "provider", code: "context_overflow", retryable: false }),
      failure(undefined, "MAX_TURNS"),
      failure(undefined, "CHAT_UNREACHABLE"),
      failure(undefined, "PROVIDER_AUTH"),
    ]) {
      const text = failureDetails(hidden, "2026-10-12T12:00:00Z");
      expect(text).not.toContain("it broke");
      expect(text).toContain(`code: ${hidden.code}`);
    }
  });

  test("copied details carry the surface and no more", () => {
    const text = failureDetails(
      failure({ layer: "provider", code: "rate_limit", retryable: true, provider: "anthropic" }),
      "2026-10-12T12:00:00Z",
    );
    expect(text).toContain("layer: provider");
    expect(text).toContain("upstream code: rate_limit");
    expect(text).toContain("retryable: true");
    expect(text).toContain("provider: anthropic");
    expect(text).toContain("message: it broke");
  });
});
