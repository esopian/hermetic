/**
 * The box's copy of one request slot, for a request card (desktop
 * `use-file-request.ts`).
 *
 * The card never draws from the tool's arguments: those are the model's
 * words. It draws from hermeticd's slot (`files.request`), read when the card
 * mounts, again every two seconds while the slot can still change, and once
 * more whenever the card itself acted (`refresh`). A read that fails backs off
 * (2, 4, 8 … 60 s) and, after `FILE_REQUEST_MAX_FAILURES` in a row, stops: the
 * card says the box is unreachable and offers Retry.
 *
 * A slot the box no longer has (`FILE_NOT_FOUND`) is `missing`: a card from an
 * old transcript, whose answer is only what the tool's result recorded.
 *
 * `useRequestFiles` finds the files client: the conversation scope's when it
 * carries one, else the paired fleet's for the scope's box, else none (the
 * card is then read-only).
 */
import type { FileRequest } from "@hermetic/core/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { slotLive } from "../../client/file-request-logic.ts";
import type { PhoneFiles } from "../../gateway/files.ts";
import { useBoxFiles } from "./use-box-file.ts";

export const FILE_REQUEST_POLL_MS = 2_000;
/** The longest a failing read waits before the next: 2, 4, 8 … 60 s. */
export const FILE_REQUEST_BACKOFF_MAX_MS = 60_000;
/** Consecutive failed reads after which the card stops and offers Retry. */
export const FILE_REQUEST_MAX_FAILURES = 6;

/** The box answered that the slot is not there. */
const GONE_CODES = new Set(["FILE_NOT_FOUND"]);

export type RequestFiles = Pick<PhoneFiles, "request" | "fulfil" | "secret" | "decline">;

/** The files client a request card in this conversation answers through, or `null`. */
export function useRequestFiles(): RequestFiles | null {
  return useBoxFiles();
}

export interface FileRequestView {
  slot: FileRequest | null;
  missing: boolean;
  /** The last read failed for another reason; polling backs off. */
  error: string | null;
  /** Reads failed `FILE_REQUEST_MAX_FAILURES` times in a row: polling stopped until `refresh`. */
  unreachable: boolean;
  /** Read the slot now: after a put, a decline, or Retry. */
  refresh: () => void;
}

/** The wait after the `failures`-th consecutive failed read: 2 s, doubling, capped. */
export function backoffMs(failures: number): number {
  return Math.min(FILE_REQUEST_BACKOFF_MAX_MS, FILE_REQUEST_POLL_MS * 2 ** Math.max(0, failures - 1));
}

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

interface ReadState {
  slot: FileRequest | null;
  missing: boolean;
  error: string | null;
  unreachable: boolean;
}

const UNREAD: ReadState = { slot: null, missing: false, error: null, unreachable: false };

export function useFileRequest(
  files: Pick<PhoneFiles, "request"> | null,
  request_id: string,
): FileRequestView {
  const [state, setState] = useState<ReadState>(UNREAD);
  const [tick, setTick] = useState(0);
  const filesRef = useRef(files);
  filesRef.current = files;
  const present = files !== null;

  useEffect(() => {
    if (!present) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Counted per run of the effect: a refresh (Retry) starts again from 2 s.
    let failures = 0;
    const controller = new AbortController();
    const update = (patch: Partial<ReadState>): void => setState((prev) => ({ ...prev, ...patch }));
    update({ unreachable: false });
    const later = (ms: number): void => {
      timer = setTimeout(() => void read(), ms);
    };
    const read = async (): Promise<void> => {
      timer = null;
      const client = filesRef.current;
      if (!client) return;
      try {
        const next = await client.request(request_id, { signal: controller.signal });
        if (stopped) return;
        failures = 0;
        update({ slot: next, missing: false, error: null });
        if (slotLive(next)) later(FILE_REQUEST_POLL_MS);
      } catch (e) {
        if (stopped) return;
        if (GONE_CODES.has(codeOf(e))) {
          update({ missing: true });
          return;
        }
        failures += 1;
        const error = e instanceof Error ? e.message : String(e);
        if (failures >= FILE_REQUEST_MAX_FAILURES) {
          update({ error, unreachable: true });
          return;
        }
        update({ error });
        later(backoffMs(failures));
      }
    };
    void read();
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [present, request_id, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}
