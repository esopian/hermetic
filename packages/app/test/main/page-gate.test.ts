/**
 * The push gate (`main/page-gate.ts`).
 *
 * Under CEF a push before the page exists aborts the process, so what is
 * pinned is that nothing passes before a sign of life, that any inbound call
 * is one, and that wrapping the handler table changes nothing else about it.
 */
import { describe, expect, test } from "bun:test";
import { createPageGate, openOnInbound } from "../../src/main/page-gate.ts";

describe("createPageGate", () => {
  test("starts closed, opens once, reports what it dropped", () => {
    const opened: number[] = [];
    const gate = createPageGate((dropped) => opened.push(dropped));
    expect(gate.isOpen).toBe(false);
    gate.dropped();
    gate.dropped();
    gate.open();
    gate.open();
    expect(gate.isOpen).toBe(true);
    expect(opened).toEqual([2]);
  });
});

describe("openOnInbound", () => {
  test("a request opens the gate before its handler runs, and returns its value", () => {
    const gate = createPageGate();
    const seen: boolean[] = [];
    const options = openOnInbound(
      {
        maxRequestTime: 5,
        handlers: {
          requests: {
            "agents.list": (params: never) => {
              seen.push(gate.isOpen);
              return { echoed: params };
            },
          },
        },
      },
      gate,
    );
    expect(options.maxRequestTime).toBe(5);
    expect(gate.isOpen).toBe(false);
    const call = options.handlers.requests["agents.list"] as (p: unknown) => unknown;
    expect(call({ fleet: "x" })).toEqual({ echoed: { fleet: "x" } });
    expect(seen).toEqual([true]);
  });

  test("a message opens it too", () => {
    const gate = createPageGate();
    const seen: unknown[] = [];
    const options = openOnInbound(
      {
        handlers: {
          requests: {},
          messages: { "page.ready": (payload: never) => seen.push(payload) },
        },
      },
      gate,
    );
    const ready = options.handlers.messages?.["page.ready"] as ((p: unknown) => void) | undefined;
    ready?.("hi");
    expect(gate.isOpen).toBe(true);
    expect(seen).toEqual(["hi"]);
  });

  test("no message table in, none out", () => {
    const options = openOnInbound({ handlers: { requests: {} } }, createPageGate());
    expect("messages" in options.handlers).toBe(false);
  });
});
