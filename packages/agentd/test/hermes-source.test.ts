/**
 * The Hermes bundle fetch, streamed (§6.4).
 *
 * The bundle is ~100 MB. Read whole into memory on a 2 GB box with Hermes and
 * Chrome running, it got hermeticd kernel-OOM-killed during an upgrade's
 * pre-fetch. These model the box's read: the body arrives as a stream of
 * chunks, and nothing on the way to disk may hold more than one of them.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { hermesBundleKey } from "@hermetic/core/schema";
import { getObjectStream } from "../src/aws.ts";
import { AgentdError } from "../src/errors.ts";
import { FLEET_CACHE_PATH, STATE_DIR } from "../src/fleet.ts";
import { fetchHermesBundle, HERMES_BUNDLE_PATH } from "../src/hermes-source.ts";
import { FakeHost } from "./fake-host.ts";
import { makeFleetManifest, sha256Of, TEST_BUCKET } from "./fixtures.ts";

const REF = "v0.23.1";
const KEY = hermesBundleKey(REF);
const CHUNK = 64 * 1024;
const CHUNKS = Array.from({ length: 4 }, (_, i) => new Uint8Array(CHUNK).fill(i + 1));
const OBJECT = new Uint8Array(Buffer.concat(CHUNKS));

/** A body delivered one chunk per read; `fail` errors it and `stall` parks it after the last. */
function chunkedBody(
  chunks: readonly Uint8Array[],
  opts: { fail?: Error; stall?: boolean; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull: async (c) => {
      const next = chunks[i++];
      if (next) return c.enqueue(next);
      if (opts.fail) return c.error(opts.fail);
      if (opts.stall) return new Promise<void>(() => undefined);
      c.close();
    },
    cancel: () => opts.onCancel?.(),
  });
}

function seed(host: FakeHost, entry: { sha256?: string; size?: number } = {}): void {
  const base = makeFleetManifest();
  const fleet = {
    ...base,
    hermes: {
      ...base.hermes,
      [REF]: {
        key: KEY,
        sha256: entry.sha256 ?? sha256Of(OBJECT),
        size: entry.size ?? OBJECT.byteLength,
        upstream_sha: "9f1c0a4e2b6d8f0a1c3e5b7d9f1a3c5e7b9d1f30",
      },
    },
  };
  host.seed(FLEET_CACHE_PATH, JSON.stringify(fleet));
}

async function fetchWith(host: FakeHost, body: () => ReadableStream<Uint8Array>) {
  const warnings: string[] = [];
  const result = await fetchHermesBundle(
    host,
    REF,
    (m) => warnings.push(m),
    async () => body(),
  );
  return { result, warnings };
}

describe("the Hermes bundle reaches disk a chunk at a time", () => {
  test("a multi-chunk body is written chunk by chunk and verified, never held whole", async () => {
    const host = new FakeHost();
    seed(host);

    const { result, warnings } = await fetchWith(host, () => chunkedBody(CHUNKS));

    expect(result).toEqual({ path: HERMES_BUNDLE_PATH, upstreamSha: expect.any(String) });
    expect(warnings).toEqual([]);
    expect(host.files.get(HERMES_BUNDLE_PATH)?.bytes).toEqual(OBJECT);
    expect(host.files.get(HERMES_BUNDLE_PATH)?.mode).toBe("0600");
    // What the box ran out of memory on: the host was handed chunks, never the object.
    const writes = host.chunkWrites.filter((w) => w.path === HERMES_BUNDLE_PATH);
    expect(writes.map((w) => w.sizes)).toEqual([[CHUNK, CHUNK, CHUNK, CHUNK]]);
  });

  test("a truncated body is CHECKSUM_MISMATCH by length, and nothing is left staged", async () => {
    const host = new FakeHost();
    seed(host);

    const err = await fetchWith(host, () => chunkedBody(CHUNKS.slice(0, 3))).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentdError);
    expect((err as AgentdError).code).toBe("CHECKSUM_MISMATCH");
    expect((err as AgentdError).detail).toEqual({
      key: KEY,
      expected_size: OBJECT.byteLength,
      actual_size: 3 * CHUNK,
    });
    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
  });

  test("a body with the right length and the wrong digest is CHECKSUM_MISMATCH, nothing staged", async () => {
    const host = new FakeHost();
    seed(host, { sha256: "b".repeat(64) });

    const err = await fetchWith(host, () => chunkedBody(CHUNKS)).catch((e: unknown) => e);

    expect((err as AgentdError).code).toBe("CHECKSUM_MISMATCH");
    expect((err as AgentdError).detail).toEqual({
      key: KEY,
      expected: "b".repeat(64),
      actual: sha256Of(OBJECT),
    });
    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
  });

  test("a body that errors mid-stream warns and falls back to upstream", async () => {
    const host = new FakeHost();
    seed(host);

    const { result, warnings } = await fetchWith(host, () =>
      chunkedBody(CHUNKS.slice(0, 2), { fail: new Error("ECONNRESET: socket hang up") }),
    );

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ECONNRESET");
    expect(warnings[0]).toContain(`s3://${TEST_BUCKET}/${KEY}`);
    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
  });

  test("a body that stalls is bounded by the timeout, cancelled, and falls back", async () => {
    const host = new FakeHost();
    seed(host);
    const timer = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => timer.signal);
    let cancelled = false;

    const pending = fetchWith(host, () =>
      chunkedBody(CHUNKS.slice(0, 1), {
        stall: true,
        onCancel: () => {
          cancelled = true;
        },
      }),
    );
    await Bun.sleep(5);
    timer.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const { result, warnings } = await pending.finally(() => timeout.mockRestore());

    expect(result).toBeNull();
    expect(warnings[0]).toContain("timed out");
    await Bun.sleep(5);
    expect(cancelled).toBe(true);
    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
  });
});

/** `AbortSignal.timeout` swapped for one the test fires; restored by `done`. */
function fakeTimeout(): { timer: AbortController; done: () => void } {
  const timer = new AbortController();
  const spy = spyOn(AbortSignal, "timeout").mockImplementation(() => timer.signal);
  return { timer, done: () => spy.mockRestore() };
}
const TIMED_OUT = new DOMException("The operation timed out.", "TimeoutError");

describe("the bundle fetch's timeout and failures leave nothing behind", () => {
  test("a timeout after the last chunk verified lets the write finish and uses the bundle", async () => {
    const host = new FakeHost();
    seed(host);
    const { timer, done } = fakeTimeout();
    // The fake stores through `writeBytes` once the chunks are consumed: the real
    // host's `sync` and `rename`, where a slow disk would be when the timer fires.
    const writeBytes = host.writeBytes.bind(host);
    host.writeBytes = async (path, content, mode) => {
      timer.abort(TIMED_OUT);
      await Bun.sleep(5);
      return writeBytes(path, content, mode);
    };

    const { result, warnings } = await fetchWith(host, () => chunkedBody(CHUNKS)).finally(done);

    // Never "could not read" with a verified bundle landing after the fallback was taken.
    expect(warnings).toEqual([]);
    expect(result?.path).toBe(HERMES_BUNDLE_PATH);
    expect(host.files.get(HERMES_BUNDLE_PATH)?.bytes).toEqual(OBJECT);
  });

  test("a local write that fails mid-stream throws, and cancels the S3 body", async () => {
    const host = new FakeHost();
    seed(host);
    let cancelled = false;
    host.writeChunks = async (_path, chunks) => {
      for await (const _chunk of chunks) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
    };

    const err = await fetchWith(host, () =>
      chunkedBody(CHUNKS, {
        onCancel: () => {
          cancelled = true;
        },
      }),
    ).catch((e: unknown) => e);

    expect((err as Error).message).toContain("ENOSPC");
    expect(cancelled).toBe(true);
  });

  test("a timeout that fires before the body is read is still a bounded fallback", async () => {
    const host = new FakeHost();
    seed(host);
    const { timer, done } = fakeTimeout();
    // Between the `GetObject` answering and the first read: the listener a
    // stalled read relies on would be added to a signal that already fired.
    const mkdir = host.mkdir.bind(host);
    host.mkdir = async (path, mode) => {
      timer.abort(TIMED_OUT);
      return mkdir(path, mode);
    };

    const { result, warnings } = await fetchWith(host, () => chunkedBody([], { stall: true })).finally(
      done,
    );

    expect(result).toBeNull();
    expect(warnings[0]).toContain("timed out");
    expect(host.files.has(HERMES_BUNDLE_PATH)).toBe(false);
  });

  test("a staged copy a killed fetch left is removed by the next one, and only that", async () => {
    const host = new FakeHost();
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
    host.seed(`${STATE_DIR}/.hermes.bundle.tmp.0a1b2c3d`, "99 MB of a killed download");
    host.seed(`${STATE_DIR}/.fleet.json.tmp.0a1b2c3d`, "somebody else's write");

    await fetchHermesBundle(host, REF, () => undefined);

    expect(host.files.has(`${STATE_DIR}/.hermes.bundle.tmp.0a1b2c3d`)).toBe(false);
    expect(host.files.has(`${STATE_DIR}/.fleet.json.tmp.0a1b2c3d`)).toBe(true);
  });
});

describe("getObjectStream", () => {
  test("hands back the SDK body as a stream and never buffers it", async () => {
    let buffered = false;
    let sentSignal: AbortSignal | undefined;
    const signal = new AbortController().signal;
    const s3 = {
      send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
        sentSignal = options?.abortSignal;
        return {
          Body: {
            transformToByteArray: async () => {
              buffered = true;
              return OBJECT;
            },
            transformToWebStream: () => chunkedBody(CHUNKS),
          },
        };
      },
    };

    const stream = await getObjectStream(s3, TEST_BUCKET, KEY, signal);
    const sizes: number[] = [];
    for await (const chunk of stream) sizes.push(chunk.byteLength);

    expect(buffered).toBe(false);
    expect(sizes).toEqual([CHUNK, CHUNK, CHUNK, CHUNK]);
    expect(sentSignal).toBe(signal);
  });
});
