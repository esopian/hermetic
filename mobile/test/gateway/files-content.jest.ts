/**
 * `PhoneFiles.content` (`src/gateway/files.ts`, `callHermeticdBody` in
 * `hermeticd.ts`): the caller's stop and the body deadline reach the request
 * through the body read, an image read refuses a non-image from the headers
 * without reading the body, and the cap for the kind holds.
 */
import {
  CONTENT_DIGEST_HEADER,
  FILES_LIMITS,
  formatContentDigest,
  sha256Hex,
} from "@hermetic/core/shared";
import { createPhoneFiles } from "../../src/gateway/files.ts";
import { resetTunnelChecks } from "../../src/gateway/hermeticd.ts";

const HOST = "fxtr0001-atlas.hermetic.ts.net";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface FakeBody {
  read: jest.Mock;
  cancel: jest.Mock;
  /** The signal the request was sent with. */
  signal: () => AbortSignal | undefined;
}

/**
 * A box whose content answer has `headers`, and a body that never arrives on
 * its own: reading it waits until the request's signal aborts.
 */
function hangingBox(headers: Record<string, string>) {
  let sent: AbortSignal | undefined;
  const body: FakeBody = {
    read: jest.fn(
      () =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          sent?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    ),
    cancel: jest.fn(async () => undefined),
    signal: () => sent,
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (String(input).startsWith("https://")) return new Response("ok");
    sent = init?.signal ?? undefined;
    return {
      ok: true,
      status: 200,
      headers: new Headers(headers),
      body: { cancel: body.cancel, getReader: undefined },
      arrayBuffer: body.read,
    } as unknown as Response;
  };
  return { fetch, body };
}

function boxAnswering(bytes: Uint8Array, headers: Record<string, string>) {
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).startsWith("https://")) return new Response("ok");
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers });
  };
  return fetch;
}

const PNG_HEADERS = {
  "content-type": "image/png",
  [CONTENT_DIGEST_HEADER]: formatContentDigest(sha256Hex(PNG)),
};

beforeEach(() => resetTunnelChecks());
afterEach(() => jest.useRealTimers());

describe("content", () => {
  test("verified bytes come back with their type and digest", async () => {
    const files = createPhoneFiles({ fetch: boxAnswering(PNG, PNG_HEADERS), host: HOST });
    const got = await files.content("f_fxqueuedpth1", { image: true });
    expect(got).toEqual({ bytes: PNG, mime: "image/png", sha256: sha256Hex(PNG) });
  });

  test("the caller's stop reaches the request while the body is read", async () => {
    const { fetch, body } = hangingBox(PNG_HEADERS);
    const files = createPhoneFiles({ fetch, host: HOST });
    const stop = new AbortController();
    const pending = files.content("f_fxqueuedpth1", { image: true, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(body.read).toHaveBeenCalled();
    expect(body.signal()?.aborted).toBe(false);
    stop.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(body.signal()?.aborted).toBe(true);
  });

  test("a body that never ends is stopped by the body deadline", async () => {
    jest.useFakeTimers();
    const { fetch, body } = hangingBox(PNG_HEADERS);
    const files = createPhoneFiles({ fetch, host: HOST });
    const pending = files.content("f_fxqueuedpth1", { image: true });
    const settled = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await settled;
    expect(body.signal()?.aborted).toBe(true);
  });

  test("an image read refuses a non-image from the headers, cancelling the body unread", async () => {
    const { fetch, body } = hangingBox({
      "content-type": "application/pdf",
      [CONTENT_DIGEST_HEADER]: formatContentDigest(sha256Hex(PNG)),
    });
    const files = createPhoneFiles({ fetch, host: HOST });
    await expect(files.content("f_fxqueuedpth1", { image: true })).rejects.toMatchObject({
      code: "FILE_TYPE_REJECTED",
    });
    expect(body.read).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalled();
  });

  test("a declared length over the image cap is refused before the body", async () => {
    const { fetch, body } = hangingBox({
      ...PNG_HEADERS,
      "content-length": String(FILES_LIMITS.imageBytes + 1),
    });
    const files = createPhoneFiles({ fetch, host: HOST });
    await expect(
      files.content("f_fxqueuedpth1", { image: true, maxBytes: FILES_LIMITS.fileBytes }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(body.read).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalled();
  });

  test("a body that does not hash to its digest, or has none, is FILE_DIGEST_MISMATCH", async () => {
    const tampered = PNG.slice();
    tampered[9] = 0xff;
    await expect(
      createPhoneFiles({ fetch: boxAnswering(tampered, PNG_HEADERS), host: HOST }).content(
        "f_fxqueuedpth1",
      ),
    ).rejects.toMatchObject({ code: "FILE_DIGEST_MISMATCH" });
    await expect(
      createPhoneFiles({
        fetch: boxAnswering(PNG, { "content-type": "image/png" }),
        host: HOST,
      }).content("f_fxqueuedpth1"),
    ).rejects.toMatchObject({ code: "FILE_DIGEST_MISMATCH" });
  });
});
