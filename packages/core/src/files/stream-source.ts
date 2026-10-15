/**
 * Helpers for a streamed-through upload (`UploadSource` kind `stream`): bytes
 * the page is sending to the loopback upload port while the box is receiving
 * them, never held whole on this laptop.
 */
import { HermeticError } from "../errors.ts";

/** A byte stream as an async iterable that cancels the stream when its consumer stops early. */
export async function* streamChunks(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // After a clean end this is a no-op; after an early stop it tells the
    // feeding side nobody is reading, so its request fails instead of hanging.
    await reader.cancel().catch(() => undefined);
  }
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Read the first `want` bytes (fewer when the stream is shorter) without
 * losing them: `body` replays everything read, then carries on. Nothing is
 * pulled past what `want` needs, so the sender stays blocked behind it.
 */
export async function peekHead(
  body: AsyncIterable<Uint8Array>,
  want: number,
): Promise<{ head: Uint8Array; body: AsyncGenerator<Uint8Array, void, undefined> }> {
  const it = body[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let have = 0;
  let ended = false;
  while (have < want) {
    const next = await it.next();
    if (next.done) {
      ended = true;
      break;
    }
    parts.push(next.value);
    have += next.value.byteLength;
  }
  const buffered = concat(parts, have);
  async function* replay(): AsyncGenerator<Uint8Array, void, undefined> {
    try {
      if (buffered.byteLength > 0) yield buffered;
      if (ended) return;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await it.return?.();
    }
  }
  return { head: buffered.subarray(0, want), body: replay() };
}

/** A whole stream, for a source small enough to hold (a secret): refused past `limit` bytes. */
export async function collectStream(
  body: AsyncIterable<Uint8Array>,
  size: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let at = 0;
  for await (const chunk of body) {
    if (at + chunk.byteLength > size) {
      out.fill(0);
      throw new HermeticError("VALIDATION", "the upload ran past the size it declared");
    }
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  if (at !== size) {
    out.fill(0);
    throw new HermeticError("VALIDATION", "the upload ended before the size it declared");
  }
  return out;
}
