/**
 * The `blob:` URLs this page minted, and nothing else.
 *
 * `safeImageSrc` (`chat-logic.ts`) refuses every image source that could make
 * the operator's machine fetch something a box named. A thumbnail of a staged
 * file is bytes the main process read for us (`files.content`), turned into a
 * `Blob` here; its URL is the only `blob:` an `<img>` may load, and only while
 * it is in this registry.
 *
 * Bounded by count and by bytes. A URL an `<img>` on screen still shows is
 * pinned (`pinBlobUrl`) and never evicted; when the registry is over budget
 * the oldest unpinned URL is revoked, and its owner is told so it can fetch
 * again. With everything pinned the registry runs over budget rather than
 * pull a picture out from under a chip.
 */

const DEFAULT_BUDGET = { urls: 64, bytes: 128 * 1024 * 1024 };
let budget = { ...DEFAULT_BUDGET };

interface Minted {
  onEvict: () => void;
  bytes: number;
  pins: number;
}

/** Insertion-ordered, so the first key is the oldest. */
const minted = new Map<string, Minted>();
let totalBytes = 0;

/** Revoke the oldest unpinned URLs until within budget. `keep` is one just minted. */
function evictOverBudget(keep?: string): void {
  if (minted.size <= budget.urls && totalBytes <= budget.bytes) return;
  for (const [url, entry] of minted) {
    if (minted.size <= budget.urls && totalBytes <= budget.bytes) return;
    if (entry.pins === 0 && url !== keep) revokeBlobUrl(url);
  }
}

/**
 * Mints a URL for `blob` and remembers it. `onEvict` runs when the URL is
 * revoked to make room, so a cache holding it can forget it and refetch.
 */
export function mintBlobUrl(blob: Blob, onEvict?: () => void): string {
  const url = URL.createObjectURL(blob);
  minted.set(url, { onEvict: onEvict ?? (() => undefined), bytes: blob.size, pins: 0 });
  totalBytes += blob.size;
  // Never the URL being handed back: its owner has not had a chance to pin it.
  evictOverBudget(url);
  return url;
}

/**
 * Hold `url` while something draws it. Answers the release, which is safe to
 * call twice; a released URL becomes evictable again.
 */
export function pinBlobUrl(url: string): () => void {
  const entry = minted.get(url);
  if (!entry) return () => undefined;
  entry.pins += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    entry.pins = Math.max(0, entry.pins - 1);
    if (minted.get(url) === entry) evictOverBudget();
  };
}

/** Whether `url` is one this page minted and has not revoked. */
export function isMintedBlobUrl(url: string): boolean {
  return minted.has(url);
}

export function revokeBlobUrl(url: string): void {
  const entry = minted.get(url);
  if (entry === undefined) return;
  minted.delete(url);
  totalBytes -= entry.bytes;
  URL.revokeObjectURL(url);
  entry.onEvict();
}

/** Test seam: change the bounds (`null` restores the defaults). */
export function setBlobBudget(next: { urls: number; bytes: number } | null): void {
  budget = next ? { ...next } : { ...DEFAULT_BUDGET };
  evictOverBudget();
}
