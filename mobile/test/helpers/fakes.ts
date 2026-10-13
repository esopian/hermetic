import type { Timers } from "../../src/client/timers.ts";

/** Deterministic timers: `advance(ms)` runs everything due, in order. */
export class FakeTimers implements Timers {
  private t = 1_760_000_000_000;
  private nextId = 1;
  private readonly due = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.due.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.due.delete(handle as number);
  }

  now(): number {
    return this.t;
  }

  pending(): number {
    return this.due.size;
  }

  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.due)
        if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.due.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = until;
  }
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A recorded `fetch` double: `answer(url, init)` decides each response (or throws). */
export function fakeFetch(
  answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] =
    [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return await answer(url, init);
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
