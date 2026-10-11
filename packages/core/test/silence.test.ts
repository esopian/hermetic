/**
 * The intentional-silence matcher against upstream's own cases (v2026.9.24):
 * `tests/gateway/test_response_filters.py`,
 * `tests/gateway/test_gateway_silence_tokens.py`,
 * `tests/gateway/test_stream_consumer_silence.py` and
 * `tests/tui_gateway/test_bot_mode_silence_delivery.py`. Each case below is
 * one of theirs unless its comment says otherwise; the extra ones pin the
 * Python string semantics the port has to reproduce.
 */
import { describe, expect, test } from "bun:test";
import { SILENCE_TOKENS, isIntentionalSilence, isPartialSilenceMarker } from "../src/shared/index.ts";

describe("isIntentionalSilence", () => {
  test.each([
    "[SILENT]",
    " SILENT ",
    "NO_REPLY",
    "no reply",
    "[静默]",
    "**沉默**",
    "【静默】",
    "静默。",
    "【沉默】",
    "沉默。",
    "**[静默]**",
    "NO_REPLY.",
    " *NO_REPLY* ",
    "no   reply",
  ])("%p is silence", (text) => {
    expect(isIntentionalSilence(text)).toBe(true);
  });

  test.each([
    "",
    "Use NO_REPLY when no answer is needed.",
    "The reply was [SILENT], intentionally.",
    "Use [SILENT] when no answer is needed.",
    "status: 静默 means the lane is quiet",
    "[SILENT] is mentioned here, but this is a real answer.",
    // Brackets are structural: a malformed marker is not stripped into a bare one.
    "[SILENT",
    "SILENT]",
  ])("%p is not silence", (text) => {
    expect(isIntentionalSilence(text)).toBe(false);
  });

  test("every marker matches itself, exactly and as a partial", () => {
    for (const token of SILENCE_TOKENS) {
      expect(isIntentionalSilence(token)).toBe(true);
      expect(isPartialSilenceMarker(token)).toBe(true);
    }
  });

  test("the length cap counts code points after stripping, at 64", () => {
    const pad = (n: number) => "*".repeat(n);
    expect(isIntentionalSilence(`${pad(28)}NO_REPLY${pad(28)}`)).toBe(true);
    expect(isIntentionalSilence(`${pad(29)}NO_REPLY${pad(28)}`)).toBe(false);
    expect(isIntentionalSilence(`  ${pad(28)}NO_REPLY${pad(28)}  `)).toBe(true);
    // 32 CJK characters are 32 code points, whatever their UTF-16 length.
    expect(isIntentionalSilence(`${"。".repeat(30)}静默${"。".repeat(32)}`)).toBe(true);
    expect(isIntentionalSilence("x".repeat(65))).toBe(false);
  });

  test("only Unicode punctuation is edge-stripped, and never a square bracket", () => {
    expect(isIntentionalSilence("«NO_REPLY»")).toBe(true);
    expect(isIntentionalSilence("¿SILENT?")).toBe(true);
    expect(isIntentionalSilence("_NO_REPLY_")).toBe(true);
    // Symbols, not punctuation (category S*): left in place, so no match.
    expect(isIntentionalSilence("~NO_REPLY~")).toBe(false);
    expect(isIntentionalSilence("`NO_REPLY`")).toBe(false);
    expect(isIntentionalSilence("$NO_REPLY$")).toBe(false);
    expect(isIntentionalSilence("*[SILENT*")).toBe(false);
  });

  test("whitespace is Python's set, not JavaScript's", () => {
    expect(isIntentionalSilence("　NO_REPLY　")).toBe(true);
    expect(isIntentionalSilence("NO REPLY")).toBe(true);
    expect(isIntentionalSilence("\x1cNO_REPLY\x1f")).toBe(true);
    expect(isIntentionalSilence("\x85SILENT")).toBe(true);
    expect(isIntentionalSilence("no\treply\n")).toBe(true);
    // U+FEFF is JavaScript whitespace and not Python's; U+200B is neither.
    expect(isIntentionalSilence("﻿NO_REPLY")).toBe(false);
    expect(isIntentionalSilence("NO​REPLY")).toBe(false);
  });

  test("anything that is not a string is not silence", () => {
    expect(isIntentionalSilence(null)).toBe(false);
    expect(isIntentionalSilence(undefined)).toBe(false);
    expect(isIntentionalSilence(["NO_REPLY"])).toBe(false);
    expect(isPartialSilenceMarker(null)).toBe(false);
  });
});

describe("isPartialSilenceMarker", () => {
  test.each(["N", "NO", "NO_", "no_r", "NO ", "NO R", "[", "[S", "[sil", "*N", "静", "[静", "**[静"])(
    "%p could still become a marker",
    (text) => {
      expect(isPartialSilenceMarker(text)).toBe(true);
    },
  );

  test.each([
    "",
    "   ",
    // Only punctuation: its stripped form is empty, and empty is not a prefix.
    "*",
    ".",
    "NO way,",
    "NOPE",
    "NO_REPLY.x",
    "Sure",
    "【",
    "x".repeat(65),
  ])("%p cannot", (text) => {
    expect(isPartialSilenceMarker(text)).toBe(false);
  });

  /**
   * `test_live_bot_chat_stream_holds_back_partial_silence_marker`: the hold-back
   * loop from `tui_gateway/prompt_turn.py`, driven by this predicate.
   */
  function stream(chunks: readonly string[]): string[] {
    const out: string[] = [];
    let buffer = "";
    let held = "";
    for (const chunk of chunks) {
      buffer += chunk;
      if (isPartialSilenceMarker(buffer)) {
        held += chunk;
        continue;
      }
      out.push(held + chunk);
      held = "";
    }
    return out;
  }

  test("a streamed marker emits nothing, and prose flushes intact once it diverges", () => {
    expect(stream(["NO_", "REPLY"])).toEqual([]);
    expect(stream(["NO", " way,", " here is the answer."])).toEqual([
      "NO way,",
      " here is the answer.",
    ]);
  });
});
