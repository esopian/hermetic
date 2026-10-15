import { filesContent } from "../api/files.ts";

/** Decode only bytes verified by the main process, optionally against a share's pinned digest. */
export async function readVerifiedImage(
  instance: string,
  id: string,
  expectedSha256: string | undefined,
  read: typeof filesContent = filesContent,
): Promise<Blob> {
  const { mime, data_b64 } = await read(instance, id, expectedSha256);
  const binary = atob(data_b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
