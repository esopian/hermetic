/**
 * The stick-to-bottom decision (`stick-to-bottom.ts`).
 *
 * The DOM environment does no layout, so the rule is tested as the pure
 * function it is. The regression: a transcript pinned on open was left
 * mid-history once an attachment preview grew the log, because the scroll
 * event for our own pin arrived after the growth and read as "not at bottom".
 */
import { describe, expect, test } from "bun:test";
import { nextFollowing, pinToBottom } from "../src/chat/stick-to-bottom.ts";
import type { Pin } from "../src/chat/stick-to-bottom.ts";

describe("nextFollowing", () => {
  test("at the bottom is always following", () => {
    expect(nextFollowing({ following: false, atBottom: true, scrollTop: 900, pinnedTop: null })).toBe(
      true,
    );
  });

  test("content grew after our pin: still following, the reader did not scroll", () => {
    // Pinned at 900; an image then added 600px, so the scroll event for that
    // pin reports 600px from the bottom at the same offset.
    expect(nextFollowing({ following: true, atBottom: false, scrollTop: 900, pinnedTop: 900 })).toBe(
      true,
    );
  });

  test("the reader scrolling above the pin stops following", () => {
    expect(nextFollowing({ following: true, atBottom: false, scrollTop: 400, pinnedTop: 900 })).toBe(
      false,
    );
  });

  test("not following stays not following until the bottom is reached", () => {
    expect(nextFollowing({ following: false, atBottom: false, scrollTop: 950, pinnedTop: 900 })).toBe(
      false,
    );
  });

  test("no pin yet and not at the bottom is not following", () => {
    expect(nextFollowing({ following: true, atBottom: false, scrollTop: 0, pinnedTop: null })).toBe(
      false,
    );
  });
});

describe("pinToBottom", () => {
  test("scrolls to the bottom and remembers the offset", () => {
    const node = { scrollTop: 0, scrollHeight: 1500 } as unknown as HTMLElement;
    const pin: Pin = { following: true, pinnedTop: null };
    pinToBottom(node, pin);
    expect(node.scrollTop).toBe(1500);
    expect(pin.pinnedTop).toBe(1500);
  });
});
