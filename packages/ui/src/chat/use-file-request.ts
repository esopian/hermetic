/**
 * The box's copy of one request slot, for a request card (attachments plan §8.3).
 *
 * The card never draws from the tool's arguments: those are the model's
 * words. It draws from hermeticd's slot (`files.request.get`), read when the
 * card mounts (renderer rule 5: seeded by request, never by a push it may have
 * missed), again every two seconds while the slot can still change, and once
 * more whenever the card itself acted (`refresh`). A read that fails backs off
 * (2, 4, 8 … 60 s) and, after `FILE_REQUEST_MAX_FAILURES` in a row, stops:
 * the card says the box is unreachable and offers Retry (`refresh`).
 *
 * Everything read is tied to the request id it was read for: when the id
 * changes (a provisional id replaced), the view starts unread again.
 *
 * A slot the box no longer has (`FILE_NOT_FOUND`, or the instance gone) is `missing`: a card from an
 * old transcript, whose answer is only what the tool's result recorded.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as filesApi from "../api/files.ts";
import type { FileRequestSlot } from "../api/files.ts";

export const FILE_REQUEST_POLL_MS = 2_000;
/** The longest a failing read waits before the next: 2, 4, 8 … 60 s. */
export const FILE_REQUEST_BACKOFF_MAX_MS = 60_000;
/** Consecutive failed reads after which the card stops and offers Retry. */
export const FILE_REQUEST_MAX_FAILURES = 6;

/** The box answered that the slot, or the instance itself, is not there. */
const GONE_CODES = new Set(["FILE_NOT_FOUND", "NOT_FOUND", "AGENT_NOT_FOUND"]);

export interface FileRequestView {
  slot: FileRequestSlot | null;
  /** The box answered that it has no such slot (or no such instance). */
  missing: boolean;
  /** The last read failed for another reason; polling backs off. */
  error: string | null;
  /** Reads failed `FILE_REQUEST_MAX_FAILURES` times in a row: polling stopped until `refresh`. */
  unreachable: boolean;
  /** Read the slot now: after a put, a decline, a cancel, or Retry. */
  refresh: () => void;
}

/** The timers the hook arms; a test hands in its own. */
export interface PollTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const PLATFORM_TIMERS: PollTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A slot that may still change under the card. */
export function slotLive(slot: FileRequestSlot | null): boolean {
  return slot === null || slot.state === "open" || slot.state === "receiving";
}

/** The wait after the `failures`-th consecutive failed read: 2 s, doubling, capped. */
export function backoffMs(failures: number): number {
  return Math.min(FILE_REQUEST_BACKOFF_MAX_MS, FILE_REQUEST_POLL_MS * 2 ** Math.max(0, failures - 1));
}

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

/** What the reads have said, and which request (instance and id) they were for. */
interface ReadState {
  id: string | null;
  slot: FileRequestSlot | null;
  missing: boolean;
  error: string | null;
  unreachable: boolean;
}

const unread = (id: string | null): ReadState => ({
  id,
  slot: null,
  missing: false,
  error: null,
  unreachable: false,
});

export function useFileRequest(
  instance: string,
  request_id: string | null | undefined,
  api: Pick<typeof filesApi, "requestGet"> = filesApi,
  timers: PollTimers = PLATFORM_TIMERS,
): FileRequestView {
  const id = request_id ? `${instance}\u0000${request_id}` : null;
  const [state, setState] = useState<ReadState>(() => unread(id));
  const [tick, setTick] = useState(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  const timersRef = useRef(timers);
  timersRef.current = timers;

  useEffect(() => {
    if (!request_id) return;
    let stopped = false;
    let timer: unknown = null;
    // Counted per run of the effect: a refresh (Retry) starts again from 2 s.
    let failures = 0;
    // Every write names the id it is for: a read of another request never lands
    // on this one, and what was read for the old id is dropped, not merged.
    const key = `${instance}\u0000${request_id}`;
    const update = (patch: Partial<ReadState>): void =>
      setState((prev) => ({ ...(prev.id === key ? prev : unread(key)), ...patch }));
    update({ unreachable: false });
    const later = (ms: number): void => {
      timer = timersRef.current.setTimeout(() => void read(), ms);
    };
    const read = async (): Promise<void> => {
      timer = null;
      try {
        const next = await apiRef.current.requestGet(instance, request_id);
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
      if (timer !== null) timersRef.current.clearTimeout(timer);
    };
  }, [instance, request_id, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  // A changed id reads as unread from its first render, before its effect ran.
  const view = state.id === id ? state : unread(id);
  return {
    slot: view.slot,
    missing: view.missing,
    error: view.error,
    unreachable: view.unreachable,
    refresh,
  };
}
