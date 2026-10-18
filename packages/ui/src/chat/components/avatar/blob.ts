/**
 * Blob — the DOM write (§9.2).
 *
 * The geometry (`blobShape`, `blobFrame`) lives in `@hermetic/core/shared` so
 * the phone draws the same face; React renders the still pose from
 * `blobFrame(shape, 0, frozen)` and the ticker below only ever rewrites `d`
 * and `transform` on paths that already exist.
 */
import type { AvatarMotion, BlobFrame, BlobShape } from "@hermetic/core/shared";
import { blobFrame } from "@hermetic/core/shared";

export interface BlobNodes {
  readonly front: SVGPathElement | null;
  readonly back: SVGPathElement | null;
  readonly gFront: SVGGElement | null;
  readonly gBack: SVGGElement | null;
}

export function blobApply(nodes: BlobNodes, frame: BlobFrame): void {
  nodes.front?.setAttribute("d", frame.front);
  nodes.back?.setAttribute("d", frame.back);
  nodes.gFront?.setAttribute("transform", `rotate(${frame.rotation.toFixed(2)} 50 50)`);
  nodes.gBack?.setAttribute("transform", `rotate(${(-frame.rotation * 0.55).toFixed(2)} 50 50)`);
}

export function blobTick(shape: BlobShape, nodes: BlobNodes, t: number, motion: AvatarMotion): void {
  blobApply(nodes, blobFrame(shape, t, motion));
}
