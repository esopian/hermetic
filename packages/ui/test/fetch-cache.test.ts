/**
 * The shared read cache: one request in flight per endpoint, a short memory of
 * the answer, and a write that drops it.
 *
 * The bug it exists for was visible from the network panel rather than from any
 * test — ten `GET /api/chat/listening` in twenty seconds of switching views —
 * so what is asserted here is the count of calls that reached the loader.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FETCH_CACHE_TTL_MS, cachedFetch, invalidateFetchCache } from "../src/lib/fetch-cache.ts";

afterEach(() => invalidateFetchCache());

function counter<T>(value: T) {
  let calls = 0;
  return {
    calls: () => calls,
    load: () => {
      calls += 1;
      return Promise.resolve(value);
    },
  };
}

describe("cachedFetch", () => {
  test("concurrent callers share one request", async () => {
    const c = counter({ instances: ["atlas"] });
    const [a, b] = await Promise.all([cachedFetch("k", c.load), cachedFetch("k", c.load)]);
    expect(c.calls()).toBe(1);
    expect(a).toBe(b);
  });

  test("a later caller inside the TTL is answered from the cache", async () => {
    const c = counter(1);
    await cachedFetch("k", c.load);
    await cachedFetch("k", c.load);
    expect(c.calls()).toBe(1);
  });

  test("a caller past the TTL reads again", async () => {
    const c = counter(1);
    await cachedFetch("k", c.load, 0);
    await new Promise((r) => setTimeout(r, 2));
    await cachedFetch("k", c.load, 0);
    expect(c.calls()).toBe(2);
  });

  test("keys do not share an answer", async () => {
    const a = counter("a");
    const b = counter("b");
    expect(await cachedFetch("a", a.load)).toBe("a");
    expect(await cachedFetch("b", b.load)).toBe("b");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  test("invalidating one key makes the next read real, and leaves the others alone", async () => {
    const a = counter("a");
    const b = counter("b");
    await cachedFetch("a", a.load);
    await cachedFetch("b", b.load);
    invalidateFetchCache("a");
    await cachedFetch("a", a.load);
    await cachedFetch("b", b.load);
    expect(a.calls()).toBe(2);
    expect(b.calls()).toBe(1);
  });

  test("invalidating everything drops every key", async () => {
    const a = counter("a");
    await cachedFetch("a", a.load);
    invalidateFetchCache();
    await cachedFetch("a", a.load);
    expect(a.calls()).toBe(2);
  });

  test("a failure is never cached: the next caller really retries", async () => {
    let calls = 0;
    const load = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve("ok");
    };
    await expect(cachedFetch("k", load)).rejects.toThrow("offline");
    expect(await cachedFetch("k", load)).toBe("ok");
    expect(calls).toBe(2);
  });

  test("the default life is the one the endpoints were tuned for", () => {
    expect(FETCH_CACHE_TTL_MS).toBe(10_000);
  });
});
