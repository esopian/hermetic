/**
 * `shared/sha256.ts` must agree with `node:crypto` byte for byte: it replaced
 * `createHash("sha256")` in the chat adapter's `rowId`, and a transcript row
 * without a durable id is named by that digest. A drift would rename every such
 * message on the next read, so read state and de-duplication would see a
 * transcript full of new messages.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex, utf8Bytes } from "../src/shared/sha256.ts";
import { mapHistory } from "../src/chat/hermes/hermes-chat-history.ts";

const node = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");

describe("sha256Hex", () => {
  test("known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("matches node:crypto for the empty string and abc", () => {
    expect(sha256Hex("")).toBe(node(""));
    expect(sha256Hex("abc")).toBe(node("abc"));
  });

  test("matches node:crypto across every padding boundary", () => {
    // 55/56/63/64/65 bytes are where the length field spills into a second block.
    for (let n = 0; n <= 200; n++) {
      const text = "x".repeat(n);
      expect(sha256Hex(text), `length ${n}`).toBe(node(text));
    }
  });

  test("matches node:crypto for a 1 MB string", () => {
    let text = "";
    for (let i = 0; text.length < 1_000_000; i++) text += `line ${i}: the quick brown fox\n`;
    text = text.slice(0, 1_000_000);
    expect(sha256Hex(text)).toBe(node(text));
  });

  test("matches node:crypto for multi-byte UTF-8", () => {
    for (const text of [
      "é",
      "naïve café",
      "日本語のテキスト",
      "emoji 😀🎉 and a flag 🇳🇿",
      "\u0000\u007f\u0080߿ࠀ￿",
      "\u{10000}\u{10ffff}",
      "mixed: ascii, ünïcödé, 中文, 🦀",
    ]) {
      expect(sha256Hex(text), text).toBe(node(text));
      expect([...utf8Bytes(text)]).toEqual([...Buffer.from(text, "utf8")]);
    }
  });

  test("encodes a lone surrogate as U+FFFD, as node:crypto does", () => {
    for (const text of ["\ud800", "a\udc00b", "\ud83d", "\ud83d😀", "end\udbff"]) {
      expect(sha256Hex(text), JSON.stringify(text)).toBe(node(text));
    }
  });

  test("hashes raw bytes", () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    expect(sha256Hex(bytes)).toBe(node(bytes));
    expect(sha256Hex(new Uint8Array())).toBe(node(""));
  });

  test("matches node:crypto on the exact inputs rowId hashes", () => {
    // `rowId` joins session, role, author, the canonical content and the row's
    // own stamp with NUL, and keeps the first 16 hex digits.
    const inputs = [
      ["20261013_101500_abc123", "user", "", "hello", "2026-10-13T10:15:00.000Z"],
      ["20261013_101500_abc123", "assistant", "", "", ""],
      [
        "s",
        "assistant",
        "researcher",
        '[{"text":"ünïcödé 😀","type":"text"}]',
        "2026-10-13T10:15:01.000Z",
      ],
      ["sess", "tool", "", '{"a":1,"b":[2,3]}', ""],
    ];
    for (const parts of inputs) {
      const joined = parts.join("\u0000");
      expect(sha256Hex(joined)).toBe(node(joined));
    }
  });

  test("a row with no durable id keeps the id node:crypto gave it", () => {
    const session = "20261013_101500_abc123";
    const box = { instance: "corvid", baseUrl: "https://corvid.example.ts.net/" };
    const row = {
      role: "assistant",
      content: [{ type: "text", text: "réponse 😀" }],
      timestamp: "2026-10-13T10:15:00Z",
    };
    const [message] = mapHistory(box, session, { messages: [row] });
    expect(message).toBeDefined();
    const at = new Date(row.timestamp).toISOString();
    const content = '[{"text":"réponse 😀","type":"text"}]';
    const expected = node([session, "assistant", "", content, at].join("\u0000")).slice(0, 16);
    expect(message!.id).toBe(`${session}:h${expected}`);
  });
});
