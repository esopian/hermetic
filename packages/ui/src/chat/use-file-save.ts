/**
 * "Save…" on a file the box holds (attachments plan §8.5): the folder dialog,
 * then the download into the folder it chose (`saveFile`, `api/files.ts`).
 *
 * The page never learns where the file went. It hears that a folder was
 * chosen, how far the download got, and the saved file's name, size and
 * digest — or a refusal, worded for the operator. A cancelled dialog is not an
 * event: the button simply comes back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { saveFile } from "../api/files.ts";
import type { SavedFile } from "../api/files.ts";

export type FileSaveState =
  | { phase: "idle" }
  /** The folder dialog is open. */
  | { phase: "choosing" }
  /** `progress` is 0–1, or null before the first progress frame. */
  | { phase: "saving"; progress: number | null }
  | { phase: "saved"; file: SavedFile }
  | { phase: "error"; code: string; message: string };

const IDLE: FileSaveState = { phase: "idle" };

/** A save refusal in the operator's words; any other code keeps the message core gave. */
export function saveErrorText(code: string, message: string): string {
  switch (code) {
    case "FILE_NOT_FOUND":
      return "no longer on the box";
    case "CONFLICT":
      return "a file with that name is already in that folder — choose another folder";
    case "FILE_DIGEST_MISMATCH":
      return "the download did not match the shared sha256, so nothing was kept";
    case "FILE_SECRET_FORBIDDEN":
      return "secrets never leave the box";
    default:
      return message || "the save failed";
  }
}

/** One file's Save… button. `name` is the agent's box; `id` an `f_…` or `sh_…`. */
export function useFileSave(
  name: string | null,
  id: string,
  save: typeof saveFile = saveFile,
): { state: FileSaveState; start: () => void; cancel: () => void } {
  const [state, setState] = useState<FileSaveState>(IDLE);
  const close = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => {
    close.current?.();
    close.current = null;
    setState(IDLE);
  }, []);
  // A card that leaves mid-save stops the download; core unlinks its part file.
  useEffect(
    () => () => {
      close.current?.();
      close.current = null;
    },
    [],
  );
  const start = useCallback(() => {
    if (name === null || close.current !== null) return;
    setState({ phase: "choosing" });
    const settle = (next: FileSaveState): void => {
      close.current = null;
      setState(next);
    };
    close.current = save(name, id, {
      onCancelled: () => settle(IDLE),
      onStarted: () => setState({ phase: "saving", progress: null }),
      onProgress: (frame) => setState({ phase: "saving", progress: frame.progress }),
      onDone: (frame) =>
        settle(
          frame.type === "saved"
            ? { phase: "saved", file: frame.file }
            : { phase: "error", code: frame.code, message: frame.message },
        ),
    });
  }, [name, id, save]);
  return { state, start, cancel };
}
