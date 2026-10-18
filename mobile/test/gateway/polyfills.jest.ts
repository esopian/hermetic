import { cloneValue, installPolyfills } from "../../src/gateway/polyfills.ts";

/** A global object with none of the three, built from the real constructors. */
function bare() {
  // A fresh constructor object so installing onto it never touches the real one.
  const SignalCtor = Object.create(AbortSignal) as typeof AbortSignal & {
    timeout?: unknown;
    any?: unknown;
  };
  Object.defineProperty(SignalCtor, "timeout", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(SignalCtor, "any", { value: undefined, writable: true, configurable: true });
  return {
    AbortController,
    AbortSignal: SignalCtor,
    structuredClone: undefined as typeof structuredClone | undefined,
    setTimeout,
  };
}

describe("installPolyfills", () => {
  test("installs all three when absent", () => {
    const target = bare();
    expect(installPolyfills(target)).toEqual([
      "AbortSignal.timeout",
      "AbortSignal.any",
      "structuredClone",
    ]);
    expect(typeof (target.AbortSignal as { timeout?: unknown }).timeout).toBe("function");
    expect(typeof (target.AbortSignal as { any?: unknown }).any).toBe("function");
    expect(typeof target.structuredClone).toBe("function");
  });

  test("is a no-op where the runtime has them", () => {
    const timeout = () => new AbortController().signal;
    const any = () => new AbortController().signal;
    const clone = <T>(v: T) => v;
    const target = {
      AbortController,
      AbortSignal: Object.assign(Object.create(AbortSignal), { timeout, any }),
      structuredClone: clone as typeof structuredClone,
      setTimeout,
    };
    expect(installPolyfills(target)).toEqual([]);
    expect(target.AbortSignal.timeout).toBe(timeout);
    expect(target.AbortSignal.any).toBe(any);
    expect(target.structuredClone).toBe(clone);
  });

  test("AbortSignal.timeout aborts after the delay with a TimeoutError", () => {
    jest.useFakeTimers();
    try {
      const target = bare();
      installPolyfills(target);
      const signal = (target.AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(
        50,
      );
      expect(signal.aborted).toBe(false);
      jest.advanceTimersByTime(50);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error).name).toBe("TimeoutError");
    } finally {
      jest.useRealTimers();
    }
  });

  test("AbortSignal.any follows the first of its signals, or one already aborted", () => {
    const target = bare();
    installPolyfills(target);
    const any = (target.AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any;
    const a = new AbortController();
    const b = new AbortController();
    const both = any([a.signal, b.signal]);
    expect(both.aborted).toBe(false);
    b.abort("b went");
    expect(both.aborted).toBe(true);
    expect(both.reason).toBe("b went");
    const gone = new AbortController();
    gone.abort("early");
    expect(any([gone.signal, a.signal]).reason).toBe("early");
  });

  test("structuredClone copies plain data deeply, with Dates, Maps, Sets and cycles", () => {
    const at = new Date("2026-10-13T10:00:00.000Z");
    const value: Record<string, unknown> = {
      list: [1, { two: 2 }],
      at,
      map: new Map([["k", { v: 1 }]]),
      set: new Set(["x"]),
    };
    value.self = value;
    const copy = cloneValue(value);
    expect(copy).not.toBe(value);
    expect(copy.list).toEqual([1, { two: 2 }]);
    expect(copy.list).not.toBe(value.list);
    expect(copy.at).toEqual(at);
    expect(copy.at).not.toBe(at);
    expect((copy.map as Map<string, unknown>).get("k")).toEqual({ v: 1 });
    expect((copy.set as Set<string>).has("x")).toBe(true);
    expect(copy.self).toBe(copy);
  });
});
