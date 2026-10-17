/**
 * Files on the conversation's box, for the blocks that show or save one: a
 * picture in the transcript (`useBoxImage`), and the client a shared file's
 * Save goes through (`save-box-file.ts`).
 *
 * `useBoxFiles` finds the files client the way a request card does: the
 * conversation scope's when it carries one, else the paired fleet's for the
 * scope's box, else none. A picture's bytes come through that client
 * (`PhoneFiles.content`: the tunnel gate, the digest check) and are handed to
 * `Image` as a `data:` URI, so no request goes to a host the transcript named.
 * Ready pictures are kept in a small cache keyed by box and id, so a row the
 * list recycles does not fetch again.
 */
import { isImageMime } from "@hermetic/core/shared";
import { useContext, useEffect, useMemo, useState } from "react";
import { dataUri, type ImageSource } from "../../client/file-urls.ts";
import { errorCode } from "../../client/errors.ts";
import { FleetContext } from "../../fleet/FleetProvider.tsx";
import type { PhoneFiles } from "../../gateway/files.ts";
import { useChatScope } from "../ChatScope.tsx";

/** The files client for the conversation's box, or `null` (the block is then read-only). */
export function useBoxFiles(): PhoneFiles | null {
  const scope = useChatScope();
  const fleet = useContext(FleetContext);
  const instance = scope?.instance ?? null;
  const derived = useMemo(() => {
    if (!fleet?.files || !instance) return null;
    const host = fleet.fleet.hostOf(instance);
    return host ? fleet.files(host) : null;
  }, [fleet, instance]);
  if (scope && scope.files !== undefined) return scope.files;
  return derived;
}

export type BoxImage =
  | { state: "loading" }
  | { state: "ready"; uri: string }
  /** The box no longer holds the file. */
  | { state: "gone" }
  /** No client, a refusal, a mismatch, or bytes that are not an image. */
  | { state: "failed"; code: string };

const CACHE_MAX = 32;
const cache = new Map<string, string>();

function remember(key: string, uri: string): void {
  cache.delete(key);
  cache.set(key, uri);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test seam: forget every cached picture. */
export function clearBoxImageCache(): void {
  cache.clear();
}

/**
 * A picture's state: a web image (already allowed by a tap) is ready at once; a box file is fetched once
 * and cached. `sha256`, when the block names one (a share), must match the
 * bytes too, beside the box's own `Content-Digest`.
 */
export function useBoxImage(source: ImageSource | null, sha256?: string | null): BoxImage | null {
  const files = useBoxFiles();
  const instance = useChatScope()?.instance ?? "";
  const id = source?.kind === "box" ? source.id : null;
  const key = id ? `${instance}\n${id}\n${sha256 ?? ""}` : null;
  const [state, setState] = useState<{ key: string | null; image: BoxImage } | null>(null);

  useEffect(() => {
    if (!key || !id) return;
    const hit = cache.get(key);
    if (hit) {
      setState({ key, image: { state: "ready", uri: hit } });
      return;
    }
    if (!files) {
      setState({ key, image: { state: "failed", code: "UNSUPPORTED" } });
      return;
    }
    const controller = new AbortController();
    setState({ key, image: { state: "loading" } });
    files
      .content(id, { signal: controller.signal, image: true })
      .then((got) => {
        if (controller.signal.aborted) return;
        if (sha256 && got.sha256 !== sha256.toLowerCase()) {
          setState({ key, image: { state: "failed", code: "FILE_DIGEST_MISMATCH" } });
          return;
        }
        if (!isImageMime(got.mime)) {
          setState({ key, image: { state: "failed", code: "FILE_TYPE_REJECTED" } });
          return;
        }
        const uri = dataUri(got.mime, got.bytes);
        remember(key, uri);
        setState({ key, image: { state: "ready", uri } });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        const code = errorCode(e) ?? "UNKNOWN";
        setState({
          key,
          image: code === "FILE_NOT_FOUND" ? { state: "gone" } : { state: "failed", code },
        });
      });
    return () => controller.abort();
  }, [key, id, files, sha256]);

  if (!source) return null;
  // An external image reaches here only after the operator's tap (`Picture`).
  if (source.kind === "external") return { state: "ready", uri: source.uri };
  if (state?.key === key) return state.image;
  const hit = key ? cache.get(key) : undefined;
  return hit ? { state: "ready", uri: hit } : { state: "loading" };
}
