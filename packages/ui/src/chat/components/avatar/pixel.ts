/**
 * Pixel crew — the DOM write (§9.2).
 *
 * The parts library and the frame choice (`pixelParts`, `pixelFrame`) live in
 * `@hermetic/core/shared` so the phone draws the same face. The face is cut
 * into layers — a static base, five eye frames and two mouth frames, all
 * emitted once as `<rect>` elements — so animating is nothing but toggling
 * which frame group is displayed.
 */
import type { AvatarMotion, PixelFrame, PixelParts } from "@hermetic/core/shared";
import { pixelFrame } from "@hermetic/core/shared";

export interface PixelNodes {
  /** The group everything sits in; carries the bob. */
  readonly root: SVGGElement | null;
  /** One group per eye frame, and one per mouth frame. */
  readonly eyes: readonly (SVGGElement | null)[];
  readonly mouths: readonly (SVGGElement | null)[];
}

/**
 * Show one frame and hide the rest. Every group is already in the document, so
 * a frame change is `display` on a handful of `<g>` elements and never a
 * rebuild.
 */
export function pixelApply(nodes: PixelNodes, frame: PixelFrame): void {
  for (let i = 0; i < nodes.eyes.length; i++) {
    nodes.eyes[i]?.setAttribute("display", i === frame.eye ? "inline" : "none");
  }
  for (let i = 0; i < nodes.mouths.length; i++) {
    nodes.mouths[i]?.setAttribute("display", i === frame.mouth ? "inline" : "none");
  }
  nodes.root?.setAttribute("transform", frame.bob ? `translate(0 ${frame.bob})` : "");
}

export function pixelTick(parts: PixelParts, nodes: PixelNodes, t: number, motion: AvatarMotion): void {
  pixelApply(nodes, pixelFrame(parts, t, motion));
}
