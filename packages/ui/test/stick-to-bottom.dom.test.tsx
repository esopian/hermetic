/**
 * `useStickToBottom` against a real node: an image settling its size after the
 * log was pinned re-pins it while the reader follows, and leaves a reader who
 * scrolled up where they are. The DOM has no layout, so `scrollHeight` is
 * stubbed on the log.
 */
import { cleanup, fireEvent, render } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import { useRef } from "react";
import { useStickToBottom } from "../src/chat/stick-to-bottom.ts";
import type { Pin } from "../src/chat/stick-to-bottom.ts";

afterEach(cleanup);

function Log({ following }: { following: boolean }) {
  const log = useRef<HTMLDivElement>(null);
  const pin = useRef<Pin>({ following, pinnedTop: null });
  useStickToBottom(log, pin);
  return (
    <div className="log" ref={log}>
      <img src="/a.png" alt="" />
    </div>
  );
}

function grow(node: HTMLElement, height: number) {
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: height });
}

test("an image that loads late re-pins a following log", () => {
  const { container } = render(<Log following />);
  const log = container.querySelector(".log") as HTMLElement;
  grow(log, 2400);
  fireEvent.load(container.querySelector("img") as HTMLImageElement);
  expect(log.scrollTop).toBe(2400);
});

test("an image that fails late re-pins too", () => {
  const { container } = render(<Log following />);
  const log = container.querySelector(".log") as HTMLElement;
  grow(log, 1800);
  fireEvent.error(container.querySelector("img") as HTMLImageElement);
  expect(log.scrollTop).toBe(1800);
});

test("a reader who scrolled away is not moved", () => {
  const { container } = render(<Log following={false} />);
  const log = container.querySelector(".log") as HTMLElement;
  grow(log, 2400);
  fireEvent.load(container.querySelector("img") as HTMLImageElement);
  expect(log.scrollTop).toBe(0);
});
