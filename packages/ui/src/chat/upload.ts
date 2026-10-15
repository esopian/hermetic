/**
 * Bytes the page holds, into the main process.
 *
 * A drop or a paste hands the page a `File` and no path. It is sent with
 * `putStream`: one `fetch` of the `File` to the loopback upload port
 * (`app/src/upload-port.ts`), which the browser reads from disk as the request
 * goes, so the page copies nothing and no size is too big. `files.stage` or
 * `files.put` runs on the upload id at the same time and sends the bytes on to
 * the box as they arrive.
 *
 * A text secret is bytes the operator typed, small and never a `File`: it goes
 * in one bounded RPC request. The composer's tray (`chat-attachments.ts`) and
 * the request cards (`FileRequest.tsx`) share the streamed file upload below.
 */

/** Base64 of a bounded byte array, sliced for `String.fromCharCode`. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

/**
 * PUTs `file` to the loopback URL `files.upload.open` answered. Resolves when
 * the main process has taken every byte; rejects with the refusal's `code`
 * when it did not. An `abort` resolves quietly: whoever aborted knows.
 *
 * The `File` is the request body itself, never read into the page: WebKit and
 * Chromium both stream it from disk. The request is read only as fast as the
 * box takes the bytes, so this is also how long the whole transfer takes.
 */
export async function putStream(url: string, file: Blob, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "PUT", body: file, signal });
  } catch (e) {
    if (signal.aborted) return;
    throw Object.assign(new Error("the upload could not reach the app"), {
      code: "UPLOAD_FAILED",
      cause: e,
    });
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  throw Object.assign(
    new Error(typeof body?.message === "string" ? body.message : `the upload failed (${res.status})`),
    { code: typeof body?.code === "string" ? body.code : "UPLOAD_FAILED" },
  );
}
