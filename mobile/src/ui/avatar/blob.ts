/**
 * Blob geometry — a port of the desktop's `avatar/blob.ts` (pure parts only).
 * Two counter-rotating layers of seeded spline points; the still pose is
 * `blobFrame(shape, 0)`. Same draws in the same order, so the same face.
 */
import type { Rng } from "./avatar-seed.ts";

const TAU = Math.PI * 2;
export const BLOB_VIEWBOX = "0 0 100 100";

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
  readonly rotation: number;
}

/** One instant of both layers; `amp` 0 is the frozen pose. */
export function blobFrame(shape: BlobShape, t: number, amp = 0, alive = false): BlobFrame {
  return {
    front: blobPath(shape.front, t, 46, amp),
    back: blobPath(shape.back, t * 0.62 + 11, 48, amp * 0.8),
    rotation: alive ? shape.rot0 + t * shape.rotSpeed : shape.rot0,
  };
}
