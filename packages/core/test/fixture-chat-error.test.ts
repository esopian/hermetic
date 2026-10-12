/**
 * The fixture's failing turns (`fixture-chat-error.ts`): `E2E_ERROR_<CODE>` fails
 * the turn with an `error` frame carrying `failure {code, message, surface}`, and
 * the stored turn holds the same `ChatMessage.failure`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import { ChatFrame, ChatMessage, type ChatFailure } from "../src/schema/index.ts";

const INSTANCE = "atlas";
const BOT = "default";

async function fixtureHermetic(): Promise<Hermetic> {
  const home = mkdtempSync(join(tmpdir(), "hermetic-fixture-error-"));
  const hermetic = await openHermetic({ fixture: true, home });
  await hermetic.chat.listen({ instance: INSTANCE, listening: true });
  await hermetic.chat.open({ instance: INSTANCE, bot: BOT });
  return hermetic;
}

async function turn(hermetic: Hermetic, message: string): Promise<ChatFrame[]> {
  const frames: ChatFrame[] = [];
  for await (const frame of hermetic.chat.send({ instance: INSTANCE, bot: BOT, message }))
    frames.push(frame);
  return frames;
}

const errorOf = (frames: readonly ChatFrame[]) => {
  const found = frames.filter((f) => f.type === "error");
  expect(found).toHaveLength(1);
  const frame = found[0];
  if (frame?.type !== "error") throw new Error("no error frame");
  return frame;
};

/** The stored failed turn: the newest bot row that carries a failure. */
async function stored(hermetic: Hermetic): Promise<ChatMessage | undefined> {
  const read = await hermetic.chat.history({ instance: INSTANCE, bot: BOT });
  return read.messages.findLast((m) => m.failure);
}

/** Where the surface `code` is not the trigger's lowercased spelling (`FailoverReason` names). */
const UPSTREAM_CODE: Record<string, string> = { RATE_LIMITED: "rate_limit", AUTH_OAUTH: "auth" };

const SURFACES: [string, string, boolean, Record<string, unknown>][] = [
  ["RATE_LIMITED", "provider", true, { provider: "anthropic" }],
  ["CONTEXT_OVERFLOW", "provider", false, {}],
  ["PAYLOAD_TOO_LARGE", "provider", false, {}],
  ["AUTH", "auth", false, { auth_kind: "api_key", provider_label: "Anthropic" }],
  ["AUTH_OAUTH", "auth", false, { auth_kind: "oauth", provider_label: "OpenAI Codex" }],
  ["BILLING", "billing", false, {}],
  ["CONTENT_POLICY_BLOCKED", "provider", false, {}],
  ["MODEL_NOT_FOUND", "provider", false, {}],
  ["LOOP_ERROR", "gateway", true, {}],
];

describe("E2E_ERROR_<CODE>", () => {
  for (const [code, layer, retryable, extra] of SURFACES) {
    test(`${code}: layer ${layer}, retryable ${retryable}, no content before the failure`, async () => {
      const hermetic = await fixtureHermetic();
      const frames = await turn(hermetic, `please E2E_ERROR_${code} now`);

      // Fails before any assistant content: the error is the whole stream.
      expect(frames.map((f) => f.type)).toEqual(["error"]);
      const frame = errorOf(frames);
      expect(ChatFrame.safeParse(frame).success).toBe(true);
      expect(frame.code).toBe("CHAT_TURN_FAILED");
      expect(frame.failure).toMatchObject({
        code: "CHAT_TURN_FAILED",
        message: frame.message,
        surface: { layer, code: UPSTREAM_CODE[code] ?? code.toLowerCase(), retryable, ...extra },
      });
      expect(frame.failure?.surface?.message).toBe(frame.message);

      // The re-read holds the same failure, beside the `error` string.
      const row = await stored(hermetic);
      expect(ChatMessage.safeParse(row).success).toBe(true);
      expect(row?.role).toBe("bot");
      expect(row?.failure).toEqual(frame.failure as ChatFailure);
      expect(row?.error).toBe(frame.message);
      expect(row?.blocks).toEqual([]);
    });
  }

  test("RATE_LIMITED carries `resets_at` a minute out, in epoch seconds", async () => {
    const hermetic = await fixtureHermetic();
    const before = Math.floor(Date.now() / 1000);
    const frame = errorOf(await turn(hermetic, "E2E_ERROR_RATE_LIMITED"));
    const resets = frame.failure?.surface?.resets_at;
    expect(resets).toBeGreaterThanOrEqual(before + 60);
    expect(resets).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
    // Only a rate limit has one.
    const other = errorOf(await turn(hermetic, "E2E_ERROR_CONTEXT_OVERFLOW"));
    expect(other.failure?.surface).not.toHaveProperty("resets_at");
  });

  test("UNCLASSIFIED has no surface: a head falls back to code and message", async () => {
    const hermetic = await fixtureHermetic();
    const frame = errorOf(await turn(hermetic, "E2E_ERROR_UNCLASSIFIED"));
    expect(frame.failure).toEqual({ code: "CHAT_TURN_FAILED", message: frame.message });
    expect((await stored(hermetic))?.failure).toEqual(frame.failure as ChatFailure);
  });

  test("AUTH_OAUTH is not read as AUTH", async () => {
    const hermetic = await fixtureHermetic();
    const frame = errorOf(await turn(hermetic, "E2E_ERROR_AUTH_OAUTH"));
    // An OAuth failure is `auth` like any other; `auth_kind` tells them apart.
    expect(frame.failure?.surface?.code).toBe("auth");
    expect(frame.failure?.surface?.auth_kind).toBe("oauth");
  });
});

describe("E2E_ERROR_AFTER_TEXT", () => {
  test("streams some text, then fails like a rate limit", async () => {
    const hermetic = await fixtureHermetic();
    const frames = await turn(hermetic, "E2E_ERROR_AFTER_TEXT");
    expect(frames.map((f) => f.type)).toEqual(["block", "delta", "error"]);
    const frame = errorOf(frames);
    expect(frame.failure?.surface).toMatchObject({ code: "rate_limit", retryable: true });
    const streamed = frames.flatMap((f) => (f.type === "delta" ? [f.text] : [])).join("");
    expect(streamed).not.toBe("");

    // The stored turn keeps the text it had written and the failure.
    const row = await stored(hermetic);
    expect(row?.blocks).toEqual([{ kind: "text", markdown: streamed }]);
    expect(row?.failure).toEqual(frame.failure as ChatFailure);
  });
});

describe("any other prompt still gets the ordinary turn", () => {
  test("no error frame, no failure row", async () => {
    const hermetic = await fixtureHermetic();
    const frames = await turn(hermetic, "hi");
    expect(frames.some((f) => f.type === "error")).toBe(false);
    expect(frames.at(-1)?.type).toBe("done");
    expect(await stored(hermetic)).toBeUndefined();
  });
});
