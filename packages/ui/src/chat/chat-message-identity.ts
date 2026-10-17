/**
 * Stable identity for transcript rows across reconciles.
 *
 * Every read of a transcript — a history response, an observation snapshot —
 * arrives as fresh objects off the wire, even when nothing in it changed. React
 * compares props by identity, so a memoized message handed a new object that
 * says the same thing renders again, and a busy chat re-rendered every row of
 * every transcript on every poll. The helpers here keep the old object wherever
 * the new one is equal to it, so "nothing changed" reaches the components as
 * the same reference it means.
 *
 * Correctness first: anything that is not plain JSON data (a `File`, a `Map`)
 * is equal only to itself, so a row carrying one is always taken fresh.
 */
import type { ChatMessageView } from "../api/index.ts";

/** Is `value` a plain object — `{}` or `Object.create(null)` — rather than a class instance? */
function plain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality over plain JSON values: primitives, arrays and plain
 * objects, compared all the way down. A key present on one side and absent on
 * the other is a difference, even when its value is `undefined`.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || !plain(a) || !plain(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(right, key) || !sameValue(left[key], right[key])) return false;
  }
  return true;
}

/**
 * `next`, with every row that equals the `prev` row of the same id replaced by
 * that `prev` object. When every row was kept, in the same order and number,
 * the answer is `prev` itself, so a reconcile that changed nothing leaves the
 * transcript array untouched as well.
 */
export function reuseMessages<M extends { id: string } = ChatMessageView>(
  prev: readonly M[],
  next: readonly M[],
): M[] {
  if (prev === next) return next as M[];
  const byId = new Map<string, M>();
  for (const row of prev) byId.set(row.id, row);
  let unchanged = prev.length === next.length;
  const out = next.map((row, index) => {
    const old = byId.get(row.id);
    const kept = old !== undefined && sameValue(old, row) ? old : row;
    if (unchanged && kept !== prev[index]) unchanged = false;
    return kept;
  });
  return unchanged ? (prev as M[]) : out;
}

/* ── presented rows ──────────────────────────────────────────────────────── */

/** What `reuseRows` reads off a presented row (`turnRows` output). */
export interface RowLike {
  message: object;
  ids: readonly string[];
  continuation: boolean;
  divider: string | null;
}

/** The two arrays hold the same elements, by identity. */
function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * One level of identity comparison: every field the same reference, an array
 * field holding the same elements, a plain-object field holding the same
 * values. A merged turn (`mergeTurn`) is rebuilt on every pass from source rows
 * that `reuseMessages` already kept, so its blocks are the same objects and its
 * usage the same numbers — this is all it takes to see that, and it costs no
 * walk of the blocks' contents.
 */
function shallowSame(a: object, b: object): boolean {
  if (a === b) return true;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false;
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && sameItems(x, y)) continue;
    if (
      typeof x === "object" &&
      typeof y === "object" &&
      x !== null &&
      y !== null &&
      !Array.isArray(x) &&
      !Array.isArray(y) &&
      plain(x) &&
      plain(y) &&
      shallowSame(x, y)
    )
      continue;
    return false;
  }
  return true;
}

/** The key a presented row is drawn under: its first source id, which does not move. */
export function rowKey(row: { message: { id: string }; ids: readonly string[] }): string {
  return row.ids[0] ?? row.message.id;
}

/**
 * `next` presented rows, keeping each `prev` row whose content is unchanged.
 *
 * `turnRows` builds every row object afresh — and every merged turn's message
 * with it — each time the transcript or the live message moves. Without this a
 * streaming delta on the last turn hands every turn above it a new `row`, and
 * each of them renders again to draw exactly what it drew before.
 */
export function reuseRows<R extends RowLike & { message: { id: string } }>(
  prev: readonly R[],
  next: readonly R[],
): R[] {
  if (prev === next) return next as R[];
  const byKey = new Map<string, R>();
  for (const row of prev) byKey.set(rowKey(row), row);
  let unchanged = prev.length === next.length;
  const out = next.map((row, index) => {
    const old = byKey.get(rowKey(row));
    const kept =
      old !== undefined &&
      old.continuation === row.continuation &&
      old.divider === row.divider &&
      sameItems(old.ids, row.ids) &&
      shallowSame(old.message, row.message)
        ? old
        : row;
    if (unchanged && kept !== prev[index]) unchanged = false;
    return kept;
  });
  return unchanged ? (prev as R[]) : out;
}

/** The two maps hold the same keys with equal values. */
export function sameMap<K, V>(
  a: ReadonlyMap<K, V>,
  b: ReadonlyMap<K, V>,
  equal: (x: V, y: V) => boolean = (x, y) => x === y,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !equal(value, b.get(key) as V)) return false;
  }
  return true;
}
