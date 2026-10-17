/**
 * The file half of the app log, off the event loop.
 *
 * `log.ts` used to `mkdirSync` + `appendFileSync` for every line, DEBUG lines
 * and op events included, so each line cost two synchronous filesystem calls on
 * the main process's loop. This is the replacement: lines go onto an in-memory
 * queue and one long-lived handle appends them in batches.
 *
 * - **Batching.** A line schedules a flush after `flushMs` (a burst becomes one
 *   write); a queue that reaches `flushBytes` flushes at once. Only one write is
 *   ever in flight, so order across levels is the order of the `write()` calls.
 * - **Bounded.** A disk that stalls cannot grow memory without limit: past
 *   `maxQueueBytes` the oldest DEBUG lines go first, then the oldest of any
 *   level, and the next line written says how many went.
 * - **Bounded loss on exit.** `flushSync()` writes whatever is still queued (and
 *   a batch whose async write may not have landed) with synchronous calls; the
 *   app calls it from `process.on("exit")` and from a crash. The one cost: a
 *   batch whose write was in flight at that instant can appear twice. A
 *   duplicate in a debugging log is better than a gap.
 * - **A file that disappears comes back.** Before each batch the open handle is
 *   compared with what the path names now; a rotated or deleted file (or
 *   directory) is recreated, which is what per-line `appendFileSync` did.
 *
 * Nothing here knows what a line says; §8.3 is `log.ts`'s concern.
 */
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { type FileHandle, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Where batches go. The default is a file; tests inject one that stalls or counts. */
export interface LogSink {
  append(text: string): Promise<void>;
  /** Used at exit, when nothing can be awaited. Must recreate what is missing. */
  appendSync(text: string): void;
  close(): Promise<void>;
}

export interface FileSinkOptions {
  dirMode: number;
  fileMode: number;
}

/**
 * One long-lived append handle on `path`. The directory is created when the
 * handle is opened (once, and again only if the file went missing), not per
 * line. A file left by an older build with a looser mode is tightened on the
 * first open.
 */
export function fileSink(path: string, options: FileSinkOptions): LogSink {
  let handle: FileHandle | null = null;
  let tightened = false;

  async function current(): Promise<FileHandle> {
    if (handle !== null) {
      try {
        const [named, held] = await Promise.all([stat(path), handle.stat()]);
        if (named.ino === held.ino && named.dev === held.dev) return handle;
      } catch {
        // The path is gone (or the handle is): fall through and reopen.
      }
      const stale = handle;
      handle = null;
      await stale.close().catch(() => {});
    }
    await mkdir(dirname(path), { recursive: true, mode: options.dirMode });
    const opened = await open(path, "a", options.fileMode);
    if (!tightened) {
      await opened.chmod(options.fileMode);
      tightened = true;
    }
    handle = opened;
    return opened;
  }

  return {
    async append(text) {
      await (await current()).appendFile(text);
    },
    appendSync(text) {
      mkdirSync(dirname(path), { recursive: true, mode: options.dirMode });
      appendFileSync(path, text, { mode: options.fileMode });
      if (!tightened) {
        chmodSync(path, options.fileMode);
        tightened = true;
      }
    },
    async close() {
      const held = handle;
      handle = null;
      await held?.close().catch(() => {});
    },
  };
}

export interface LogWriterOptions {
  sink: LogSink;
  /** What the next line says when lines were dropped; already formatted, newline-terminated. */
  droppedNotice: (dropped: number) => string;
  /** The sink failed: the file half goes quiet for the rest of the run. */
  onFailure: () => void;
  /** Delay before a queued line is written. Default 25. */
  flushMs?: number;
  /** A queue this big flushes at once. Default 64 KiB. */
  flushBytes?: number;
  /** Past this, the oldest DEBUG lines are dropped. Default 4 MiB. */
  maxQueueBytes?: number;
  /** Observes each batch handed to the sink (tests count writes with it). */
  onBatch?: (bytes: number) => void;
}

export interface LogWriter {
  /** Queue one line. `droppable` lines (DEBUG) are the first to go under pressure. */
  write(text: string, droppable: boolean): void;
  /** Resolves once everything queued before the call has been handed to the file. */
  flush(): Promise<void>;
  /** Synchronous: what is queued, plus any batch whose write may be unfinished. */
  flushSync(): void;
  close(): Promise<void>;
}

interface Queued {
  text: string;
  droppable: boolean;
}

const DEFAULT_FLUSH_MS = 25;
const DEFAULT_FLUSH_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;

export function createLogWriter(options: LogWriterOptions): LogWriter {
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const flushBytes = options.flushBytes ?? DEFAULT_FLUSH_BYTES;
  const maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
  let queue: Queued[] = [];
  let queued = 0;
  let dropped = 0;
  /** The batch handed to the sink whose write has not resolved. */
  let inflight: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining: Promise<void> | null = null;
  let dead = false;

  function fail(): void {
    dead = true;
    queue = [];
    queued = 0;
    inflight = null;
    options.onFailure();
  }

  /** Oldest DEBUG lines first, then the oldest of anything, down to 3/4 of the cap. */
  function shed(): void {
    const target = Math.floor(maxQueueBytes * 0.75);
    let bytes = queued;
    const keep = queue.map(() => true);
    for (const droppable of [true, false]) {
      for (let i = 0; i < queue.length && bytes > target; i++) {
        const entry = queue[i];
        if (entry === undefined || !keep[i] || entry.droppable !== droppable) continue;
        keep[i] = false;
        bytes -= entry.text.length;
        dropped++;
      }
    }
    queue = queue.filter((_, i) => keep[i]);
    queued = bytes;
  }

  function take(): string {
    const notice = dropped > 0 ? options.droppedNotice(dropped) : "";
    dropped = 0;
    const text = notice + queue.map((q) => q.text).join("");
    queue = [];
    queued = 0;
    return text;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0 || dropped > 0) {
      if (dead) return;
      const batch = take();
      inflight = batch;
      options.onBatch?.(batch.length);
      try {
        await options.sink.append(batch);
      } catch {
        fail();
        return;
      }
      inflight = null;
    }
  }

  function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (draining === null) {
      draining = drain().finally(() => {
        draining = null;
        if (queue.length > 0 && !dead) schedule();
      });
    }
    return draining;
  }

  function schedule(): void {
    if (timer !== null || draining !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    // The exit hook writes what is left; a pending timer must not keep a process alive.
    timer.unref?.();
  }

  return {
    write(text, droppable) {
      if (dead) return;
      queue.push({ text, droppable });
      queued += text.length;
      if (queued > maxQueueBytes) shed();
      if (queued >= flushBytes) void flush();
      else schedule();
    },
    flush,
    flushSync() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (dead) return;
      const pending = take();
      const text = (inflight ?? "") + pending;
      if (text === "") return;
      try {
        options.sink.appendSync(text);
        inflight = null;
      } catch {
        fail();
      }
    },
    async close() {
      await flush();
      await options.sink.close();
    },
  };
}
