/**
 * Runtime globals core's chat adapter uses that Hermes (React Native's engine)
 * may lack: `AbortSignal.timeout`, `AbortSignal.any` and `structuredClone`.
 * `packages/core/test/chat-client-portable.test.ts` records the list.
 *
 * Each is installed only when absent, so a runtime that has the real one keeps
 * it. `installPolyfills` takes the global object so a test can hand it a bare
 * one; the module installs onto `globalThis` when it is first imported, which
 * is why `src/gateway/client.ts` imports it before anything else.
 */

interface PolyfillTarget {
  AbortController: typeof AbortController;
  AbortSignal: typeof AbortSignal;
  structuredClone?: typeof structuredClone;
  setTimeout: typeof setTimeout;
}

/** A `DOMException`-shaped error where the runtime has none (Hermes before 0.74 had none). */
function abortError(name: "AbortError" | "TimeoutError", message: string): Error {
  if (typeof DOMException === "function") return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * A deep copy of plain data: what the adapter clones is JSON-shaped (frames,
 * blocks, session rows), plus the odd `Date`, `Map` or `Set`. Cycles are kept.
 */
export function cloneValue<T>(value: T, seen = new Map<unknown, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(cloneValue(k, seen), cloneValue(v, seen));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(cloneValue(v, seen));
    return out as T;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const v of value) out.push(cloneValue(v, seen));
    return out as T;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneValue(v, seen);
  return out as T;
}

/** Install whichever of the three `target` lacks. Returns the names it installed. */
export function installPolyfills(target: PolyfillTarget = globalThis as PolyfillTarget): string[] {
  const installed: string[] = [];
  const Signal = target.AbortSignal as typeof AbortSignal & {
    timeout?: (ms: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  const Controller = target.AbortController;

  if (typeof Signal.timeout !== "function") {
    Signal.timeout = (ms: number): AbortSignal => {
      const controller = new Controller();
      target.setTimeout(() => controller.abort(abortError("TimeoutError", "signal timed out")), ms);
      return controller.signal;
    };
    installed.push("AbortSignal.timeout");
  }

  if (typeof Signal.any !== "function") {
    Signal.any = (signals: AbortSignal[]): AbortSignal => {
      const controller = new Controller();
      const already = signals.find((s) => s.aborted);
      if (already) {
        controller.abort(already.reason);
        return controller.signal;
      }
      const listeners: Array<[AbortSignal, () => void]> = [];
      for (const signal of signals) {
        const onAbort = (): void => {
          for (const [s, l] of listeners) s.removeEventListener("abort", l);
          controller.abort(signal.reason);
        };
        listeners.push([signal, onAbort]);
        signal.addEventListener("abort", onAbort, { once: true });
      }
      return controller.signal;
    };
    installed.push("AbortSignal.any");
  }

  if (typeof target.structuredClone !== "function") {
    target.structuredClone = (<T>(value: T): T => cloneValue(value)) as typeof structuredClone;
    installed.push("structuredClone");
  }

  return installed;
}

installPolyfills();
