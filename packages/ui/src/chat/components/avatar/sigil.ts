/**
 * Sigil — the DOM write (§9.2).
 *
 * The cells and the choreography (`sigilCells`, `sigilFrame`, `transformFor`)
 * live in `@hermetic/core/shared` so the phone draws the same mark. React
 * renders the cells as ordinary `<rect>` elements, so the mark is correct in
 * static markup and on a machine that never gets a frame; `sigilTick` only
 * ever writes attributes onto rects that already exist.
 */
import type { AvatarMotion, AvatarPalette, SigilCell, SigilFrame } from "@hermetic/core/shared";
import { SIGIL_HOME, sigilFrame, transformFor } from "@hermetic/core/shared";

function applyCell(node: SVGRectElement, cell: SigilCell, f: SigilFrame, pal: AvatarPalette): void {
  node.setAttribute("transform", transformFor(cell, f));
  node.setAttribute("opacity", Math.max(0, Math.min(1, f.opacity)).toFixed(3));
  node.setAttribute("fill", pal.tone(cell.tone, f.dh, f.dl));
}

/** Write one frame onto rects React already put in the document. */
export function sigilTick(
  cells: readonly SigilCell[],
  nodes: readonly (SVGRectElement | null)[],
  t: number,
  motion: AvatarMotion,
  pal: AvatarPalette,
): void {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const node = nodes[i];
    if (!cell || !node) continue;
    applyCell(node, cell, sigilFrame(cell, t, motion), pal);
  }
}

/**
 * Every cell seated at full strength. This is what reduced motion gets and what
 * a stopped box gets — not a frozen animation frame, which was a real bug in
 * an earlier prototype: a `still()` overwritten by an unconditional `tick()`
 * at a random phase gave reduced-motion users a different mark on every mount.
 */
export function sigilStill(
  cells: readonly SigilCell[],
  nodes: readonly (SVGRectElement | null)[],
  pal: AvatarPalette,
): void {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const node = nodes[i];
    if (!cell || !node) continue;
    applyCell(node, cell, SIGIL_HOME, pal);
  }
}
