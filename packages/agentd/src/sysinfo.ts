/**
 * Every OS-level system reading hermeticd takes — CPU load, memory, filesystem
 * usage — comes from `systeminformation`, and this is the only module that
 * imports it. `realHost` delegates here; tests answer the same three questions
 * from `FakeHost` instead.
 *
 * The library replaces hand-rolled `/proc/stat` and `/proc/meminfo` parsers and
 * a `statfs`-then-`df` fallback chain. Those were each correct on paper and
 * still reported 0% CPU and 0% memory on every box for as long as `Bun.file`
 * read procfs back empty, because nothing exercised them against a real kernel.
 * A widely used library that is exercised against real kernels is the better
 * owner of "how do you read this number on Linux".
 *
 * Two of its behaviours shape the interface:
 *  - `currentLoad()` is a delta against the previous call, held in the
 *    library's module state. The first call in a process is the average since
 *    boot. Only the heartbeat may call `cpuLoad`: a second caller would shrink
 *    the heartbeat's window to whatever interval separates the two.
 *  - `fsSize(drive)` filters by *substring* of device or mount point, so
 *    `fsSize("/")` matches every mount. It is called unfiltered and the mount
 *    holding a path is picked here, by longest prefix (`mountFor`).
 *
 * The library swallows its own failures and answers `[]` or zeros; each reader
 * turns those into `null`, "not measured", which callers already distinguish
 * from "empty".
 */
import si from "systeminformation";

export interface MemorySample {
  /** Bytes. */
  readonly total: number;
  /** Bytes the kernel could hand out without swapping (`MemAvailable`). */
  readonly available: number;
}

export interface FilesystemSample {
  /** The mount point holding the path asked about. */
  readonly mount: string;
  /** Bytes. */
  readonly size: number;
  /** Bytes an unprivileged writer could still use. */
  readonly available: number;
  /** Percent used, as `df` reports it: used / (used + available). */
  readonly usePct: number;
}

/** Busy CPU percentage since the previous call; `null` when unmeasurable. */
export async function cpuLoad(): Promise<number | null> {
  try {
    const load = await si.currentLoad();
    return Number.isFinite(load.currentLoad) ? load.currentLoad : null;
  } catch {
    return null;
  }
}

export async function memory(): Promise<MemorySample | null> {
  try {
    const mem = await si.mem();
    return mem.total > 0 ? { total: mem.total, available: mem.available } : null;
  } catch {
    return null;
  }
}

/** The filesystem holding `path`; `null` when no mount could be read. */
export async function filesystem(path: string): Promise<FilesystemSample | null> {
  try {
    const mounts = await si.fsSize();
    const picked = mountFor(
      mounts.map((m) => m.mount),
      path,
    );
    const entry = mounts.find((m) => m.mount === picked);
    if (!entry || !(entry.size > 0)) return null;
    return {
      mount: entry.mount,
      size: entry.size,
      available: entry.available,
      usePct: entry.use,
    };
  } catch {
    return null;
  }
}

/**
 * The mount point that holds `path`: the longest mount equal to it or a
 * directory prefix of it. `/data` holds `/data/x` but not `/database`.
 */
export function mountFor(mounts: readonly string[], path: string): string | null {
  let best: string | null = null;
  for (const mount of mounts) {
    const holds =
      mount === path || mount === "/" || path.startsWith(mount.endsWith("/") ? mount : `${mount}/`);
    if (holds && path.startsWith("/") && (best === null || mount.length > best.length)) {
      best = mount;
    }
  }
  return best;
}
