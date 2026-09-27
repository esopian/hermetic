/**
 * Blob — two counter-rotating layers of seeded spline points (§9.2).
 *
 * The one style with a curve in it, and therefore the **stated, documented
 * exception** to `* { border-radius: 0 }` in `styles.css`. That law is real and
 * this is the only thing allowed through it: everything else in hermetic is
 * infrastructure — squares, hairlines, 900-weight caps — and the blob marks the
 * one row in the system that is a *running agent* rather than a resource. It
 * carries liveness in peripheral vision, where a status word cannot reach.
 *
 * As with the other two, geometry is pure and the DOM write is separate: React
 * renders the still pose from `blobFrame(shape, 0, frozen)` and the ticker only
 * ever rewrites `d` and `transform` on paths that already exist.
 */
import type { AvatarMotion, Rng } from "./avatar-seed.ts";

const TAU = Math.PI * 2;
export const BLOB_VIEWBOX = "0 0 100 100";

/**
 * One control point on a circle. Each has its own radius amplitude, angular
 * wobble, phase and speed, all seeded — so the shape never returns to a pose
 * you have already seen and there is no loop to notice.
 */
export interface BlobPoint {
  readonly a: number;
  readonly base: number;
  readonly amp: number;
  readonly phase: number;
  readonly speed: number;
  readonly wob: number;
  readonly wobSpeed: number;
  readonly wobPhase: number;
}

export interface BlobShape {
  /** 7–10 points behind, 8–12 in front. The counts are part of the identity. */
  readonly back: readonly BlobPoint[];
  readonly front: readonly BlobPoint[];
  readonly rot0: number;
  readonly rotSpeed: number;
}

function points(rnd: Rng, n: number): BlobPoint[] {
  const out: BlobPoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      a: (i / n) * TAU,
      base: 0.78 + rnd() * 0.1,
      amp: 0.035 + rnd() * 0.085,
      phase: rnd() * TAU,
      speed: 0.45 + rnd() * 0.85,
      wob: 0.03 + rnd() * 0.08,
      wobSpeed: 0.3 + rnd() * 0.6,
      wobPhase: rnd() * TAU,
    });
  }
  return out;
}

export function blobShape(rnd: Rng): BlobShape {
  const back = points(rnd, 7 + Math.floor(rnd() * 3));
  const front = points(rnd, 8 + Math.floor(rnd() * 4));
  return {
    back,
    front,
    rot0: rnd() * 360,
    rotSpeed: (rnd() < 0.5 ? -1 : 1) * (2 + rnd() * 4),
  };
}

/**
 * A closed Catmull-Rom emitted as cubic Béziers. A plain polygon reads as a gem
 * and a circle reads as a dot; this is the cheapest curve that is neither.
 */
function spline(p: readonly (readonly [number, number])[]): string {
  const n = p.length;
  const first = p[0]!;
  let d = `M${first[0].toFixed(2)},${first[1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n]!;
    const p1 = p[i]!;
    const p2 = p[(i + 1) % n]!;
    const p3 = p[(i + 2) % n]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d +=
      `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)}` +
      ` ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

/** The path one layer traces at time `t`. Pure, and the only geometry worth testing. */
export function blobPath(set: readonly BlobPoint[], t: number, r: number, amp: number): string {
  return spline(
    set.map((p) => {
      const rad = r * (p.base + p.amp * amp * Math.sin(t * p.speed + p.phase));
      const ang = p.a + p.wob * amp * Math.sin(t * p.wobSpeed + p.wobPhase);
      return [50 + Math.cos(ang) * rad, 50 + Math.sin(ang) * rad] as const;
    }),
  );
}

export interface BlobFrame {
  readonly front: string;
  readonly back: string;
  /** Degrees. The back layer counter-rotates at 0.55× and is applied from this. */
  readonly rotation: number;
}

/**
 * One instant of both layers.
 *
 * Note what is *not* here: an earlier prototype swelled the whole SVG while
 * thinking, and that job now belongs to `AvatarMotion.scale`, which every
 * style reads and which `Avatar.tsx` applies once. The numbers land in the
 * same place — the prototype's swell ran 1.000/1.030/1.054 against the shared
 * table's 1.00/1.04/1.06 — and one owner of the transform is worth more than
 * the third decimal.
 */
export function blobFrame(shape: BlobShape, t: number, motion: AvatarMotion): BlobFrame {
  const amp = motion.alive ? motion.amp : 0;
  return {
    front: blobPath(shape.front, t, 46, amp),
    back: blobPath(shape.back, t * 0.62 + 11, 48, amp * 0.8),
    rotation: motion.alive ? shape.rot0 + t * shape.rotSpeed : shape.rot0,
  };
}

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
