/**
 * Reading a conversation clears its inbox rows — and only while it is actually
 * being read.
 *
 * Three gates, one test each, because each of them is the whole feature when it
 * is the one that fails. A tab in the background that acked on arrival would
 * silently eat every message the operator was not there for; a reader scrolled
 * up into last week who was acked out from under would lose the only pointer
 * they had back to what just landed. Both are worse than a bell that keeps
 * counting.
 */
import { act, cleanup, render, setPageHidden, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import type { AckableRow } from "../src/nav/view-ack.ts";
import { unreadChatRowIds, useViewAck } from "../src/nav/view-ack.ts";

const VIEW_ACK_DEBOUNCE_MS = 10;

afterEach(() => {
  // A visible page, back for the next file: the reset is each suite's own (`setup.ts`).
  setPageHidden(false);
  cleanup();
});

function messageRow(id: string, ref = "atlas/default", extra: Partial<AckableRow> = {}): AckableRow {
  return { id, kind: "chat.message", ref, read_at: null, ...extra };
}

/** Waits out the debounce, so "nothing was acked" is a settled answer. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, VIEW_ACK_DEBOUNCE_MS + 80));
  });
}

function Harness({
  items,
  ackMany,
}: {
  items: readonly AckableRow[];
  ackMany: (ids: readonly string[]) => void | Promise<void>;
}) {
  const log = useRef<HTMLDivElement>(null);
  useViewAck({
    scroller: log,
    instance: "atlas",
    bot: "default",
    items,
    ackMany,
    debounceMs: VIEW_ACK_DEBOUNCE_MS,
  });
  return <div ref={log} data-testid="log" />;
}

/** happy-dom reports every box as zero-sized; this is a real scrolled-up log. */
function scrolledUp(node: HTMLElement) {
  Object.defineProperty(node, "scrollHeight", { value: 4000, configurable: true });
  Object.defineProperty(node, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(node, "scrollTop", { value: 100, configurable: true });
}

/** `setup.ts` owns the `document` properties; this is the local spelling. */
function setVisibility(state: "visible" | "hidden") {
  setPageHidden(state === "hidden");
}

describe("unreadChatRowIds", () => {
  test("only this conversation's unread, unmuted, unresolved chat.message rows", () => {
    const items: AckableRow[] = [
      messageRow("n1"),
      messageRow("n2", "atlas/scribe"),
      messageRow("n3", "atlas/default", { read_at: "2026-09-19T00:00:00Z" }),
      messageRow("n4", "atlas/default", { muted: true }),
      messageRow("n5", "atlas/default", { resolved_at: "2026-09-19T00:00:00Z" }),
      { id: "n6", kind: "chat.error", ref: "atlas/default" },
      { id: "n7", kind: "agent.degraded", ref: "atlas" },
      messageRow("n8"),
    ];
    expect(unreadChatRowIds(items, "atlas", "default")).toEqual(["n1", "n8"]);
  });
});

describe("useViewAck", () => {
  test("a visible thread at the bottom acks its unread rows, once, as one write", async () => {
    setVisibility("visible");
    const acked: string[][] = [];
    const { rerender } = render(
      <Harness
        items={[messageRow("n1"), messageRow("n2")]}
        ackMany={(ids) => void acked.push([...ids])}
      />,
    );
    await waitFor(() => expect(acked).toEqual([["n1", "n2"]]));
    // The inbox rebuilds its array on every refresh; the same rows must not be
    // acked again because their identity changed.
    rerender(
      <Harness
        items={[messageRow("n1"), messageRow("n2")]}
        ackMany={(ids) => void acked.push([...ids])}
      />,
    );
    await settle();
    expect(acked).toEqual([["n1", "n2"]]);
  });

  test("a row that arrives while the reader is still at the bottom is acked too", async () => {
    setVisibility("visible");
    const acked: string[][] = [];
    const push = (ids: readonly string[]) => void acked.push([...ids]);
    const { rerender } = render(<Harness items={[messageRow("n1")]} ackMany={push} />);
    await waitFor(() => expect(acked).toEqual([["n1"]]));
    rerender(
      <Harness
        items={[messageRow("n1", "atlas/default", { read_at: "x" }), messageRow("n2")]}
        ackMany={push}
      />,
    );
    await waitFor(() => expect(acked).toEqual([["n1"], ["n2"]]));
  });

  test("a rejected ack is retried on the next pass rather than counted as done", async () => {
    setVisibility("visible");
    const attempts: string[][] = [];
    let refuse = true;
    const ackMany = (ids: readonly string[]) => {
      attempts.push([...ids]);
      return refuse ? Promise.reject(new Error("the portal refused")) : Promise.resolve();
    };
    const { rerender } = render(<Harness items={[messageRow("n1")]} ackMany={ackMany} />);
    await waitFor(() => expect(attempts).toEqual([["n1"]]));
    // The row is still unread on the box, so the next pass must offer it again.
    refuse = false;
    rerender(<Harness items={[messageRow("n1")]} ackMany={ackMany} />);
    await waitFor(() => expect(attempts).toEqual([["n1"], ["n1"]]));
    // And once it lands, it is done.
    rerender(<Harness items={[messageRow("n1")]} ackMany={ackMany} />);
    await settle();
    expect(attempts).toEqual([["n1"], ["n1"]]);
  });

  test("a reader scrolled up is not acked out from under", async () => {
    setVisibility("visible");
    const acked: string[][] = [];
    const push = (ids: readonly string[]) => void acked.push([...ids]);
    const { getByTestId, rerender } = render(<Harness items={[]} ackMany={push} />);
    scrolledUp(getByTestId("log"));
    rerender(<Harness items={[messageRow("n1")]} ackMany={push} />);
    await settle();
    expect(acked).toEqual([]);
  });

  test("a hidden tab acks nothing, and acks on the visibility change that ends it", async () => {
    setVisibility("hidden");
    const acked: string[][] = [];
    const push = (ids: readonly string[]) => void acked.push([...ids]);
    render(<Harness items={[messageRow("n1")]} ackMany={push} />);
    await settle();
    expect(acked).toEqual([]);
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(acked).toEqual([["n1"]]));
  });
});
