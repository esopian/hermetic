/**
 * The square type tag on the left of a file row — a chip, a share card, a
 * tray entry. Its own module so `Attachment.tsx` and `ShareCard.tsx`, which
 * draw each other, both read it without importing one another for it.
 */

/** `image/png` → `PNG`, `application/pdf` → `PDF`. The square on the left of the row. */
export function typeTag(mime: string, name: string): string {
  const sub = (typeof mime === "string" ? mime : "").split("/")[1] ?? "";
  const cleaned = sub.split("+")[0] ?? "";
  if (cleaned && cleaned.length <= 4) return cleaned.toUpperCase();
  const file = typeof name === "string" ? name : "";
  const ext = file.includes(".") ? (file.split(".").pop() ?? "") : "";
  return (ext || cleaned || "file").slice(0, 4).toUpperCase();
}
