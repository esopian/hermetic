import type { ContentPurpose } from "@hermetic/core/shared";
import { filesContent } from "../api/files.ts";

/**
 * Decode only bytes verified by the main process, optionally against a share's
 * pinned digest, read for `purpose` (an image unless named): the main process
 * refuses a type the purpose does not admit before the bytes are read.
 */
export async function readVerifiedBytes(
  instance: string,
  id: string,
  expectedSha256: string | undefined,
  purpose: ContentPurpose | undefined,
  read: typeof filesContent = filesContent,
): Promise<Blob> {
  const { mime, data_b64 } = await read(instance, id, expectedSha256, purpose);
  const binary = atob(data_b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Decode only image bytes verified by the main process, optionally against a share's pinned digest. */
export function readVerifiedImage(
  instance: string,
  id: string,
  expectedSha256: string | undefined,
  read: typeof filesContent = filesContent,
): Promise<Blob> {
  return readVerifiedBytes(instance, id, expectedSha256, undefined, read);
}
