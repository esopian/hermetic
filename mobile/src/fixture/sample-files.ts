/**
 * Canned attachments for the conversation's `?attach=` link (fixture builds
 * only): one small PNG and one short text file, written into the cache
 * directory so the real attachment path reads them back with `readBytes`
 * exactly as it reads a picked file. They stand in for the pickers, which an
 * agent driving the simulator by URL cannot tap through.
 */
import type { PickedFile } from "../client/attachments.ts";

/** Write `bytes` under `name` and answer the file's `file://` URI. */
export type SampleWriter = (name: string, bytes: Uint8Array) => Promise<string>;

export const SAMPLE_IMAGE_NAME = "fixture-sample.png";
export const SAMPLE_TEXT_NAME = "fixture-notes.txt";
export const SAMPLE_TEXT =
  "Fixture notes\n\nA short text file attached by the fixture's ?attach= link.\n";

/**
 * The slice of `expo-file-system` the writer uses, typed here rather than as
 * `typeof import("expo-file-system")`: that import would load Expo's typings,
 * and through them react-native's global ones, into every program that
 * builds the kit, including the root seam tests that run under Bun.
 */
interface CacheFs {
  File: new (
    directory: unknown,
    name: string,
  ) => {
    uri: string;
    create(options: { intermediates: boolean; overwrite: boolean }): void;
    write(bytes: Uint8Array): void;
  };
  Paths: { cache: unknown };
}

/**
 * The cache directory's writer. `expo-file-system` is required here, when a
 * sample is first written, so nothing loads it just by building the kit.
 */
export const cacheWriter: SampleWriter = async (name, bytes) => {
  const { File, Paths } = require("expo-file-system") as CacheFs;
  const file = new File(Paths.cache, name);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
  return file.uri;
};

/** Write the two samples and answer them as a picker would: the image first, then the file. */
export async function writeSampleFiles(png: Uint8Array, write: SampleWriter): Promise<PickedFile[]> {
  const text = new TextEncoder().encode(SAMPLE_TEXT);
  const [imageUri, textUri] = await Promise.all([
    write(SAMPLE_IMAGE_NAME, png),
    write(SAMPLE_TEXT_NAME, text),
  ]);
  return [
    { name: SAMPLE_IMAGE_NAME, uri: imageUri, mime: "image/png", size: png.byteLength, kind: "image" },
    { name: SAMPLE_TEXT_NAME, uri: textUri, mime: "text/plain", size: text.byteLength, kind: "file" },
  ];
}
