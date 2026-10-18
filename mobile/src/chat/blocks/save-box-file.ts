/**
 * Save one shared file from the box to wherever the operator chooses: the
 * bytes (digest-checked by `PhoneFiles.content`) are written to the app's
 * cache directory, then the system share sheet offers Files, AirDrop or
 * another app. The share sheet is iOS's own; nothing here picks a folder.
 */
import { FILES_LIMITS } from "@hermetic/core/shared";
import { File, Paths } from "expo-file-system";
import { Share } from "react-native";
import type { PhoneFiles } from "../../gateway/files.ts";

/** The most a Save may bring onto the phone: the box's own file cap. */
const SAVE_MAX_BYTES = FILES_LIMITS.fileBytes;

/**
 * Save one file from the box: its bytes (digest-checked) into the app's cache
 * directory, then the system share sheet for it, where the operator picks
 * Files, AirDrop or another app. Throws the box's refusal.
 */
export async function saveBoxFile(
  files: Pick<PhoneFiles, "content">,
  id: string,
  name: string,
  deps: {
    write?: (name: string, bytes: Uint8Array) => string;
    share?: (url: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const got = await files.content(id, { maxBytes: SAVE_MAX_BYTES });
  const write =
    deps.write ??
    ((fileName: string, bytes: Uint8Array) => {
      const file = new File(Paths.cache, fileName);
      if (file.exists) file.delete();
      file.create({ intermediates: true });
      file.write(bytes);
      return file.uri;
    });
  const share = deps.share ?? ((url: string) => Share.share({ url }));
  // The id keeps two shares with one name apart in the cache directory.
  const url = write(`${id}-${name.replace(/[/\\]/g, "_")}`, got.bytes);
  await share(url);
}
