/**
 * Sigil — a mirrored cell matrix that assembles itself (§9.2).
 *
 * The default style, and the argument for it is that it is built entirely from
 * the square: hermetic's own unit, the one already carrying the status dots,
 * the health squares and the DANGER block. It is also the only one of the three
 * that puts no curve on screen, which matters in a body whose CSS says
 * `* { border-radius: 0 }` and means it.
 *
 * Three *kinds* of motion, not three speeds of one — an operator should be able
 * to tell them apart from across a room:
 *
 *   thinking   the mark comes APART and puts itself back together. Every cell
 *              has its own cycle length and phase, and on EVERY loop it rolls a
 *              fresh entry and exit style, so the choreography never settles
 *              into something you can learn.
 *   streaming  every block holds its place and the MATERIAL moves — a hue sweep
 *              and a shading sweep at different frequencies, so the two never
 *              line up and the mark keeps moving without a cell leaving home.
 *   idle       a quiet diagonal opacity wave. If the resting state also flew
 *              apart, working would have nothing left to say.
 *
 * The split between this file and `Avatar.tsx` is the first-paint rule:
 * `sigilCells` is pure and returns geometry, which React renders as ordinary
 * `<rect>` elements, so the mark is correct in static markup and on a machine
 * that never gets a frame. `sigilTick` only ever writes attributes onto rects
 * that already exist.
 */
import type { AvatarMotion, AvatarPalette, Rng } from "./avatar-seed.ts";

const TAU = Math.PI * 2;

/** 5×5 on screen, mirrored from 5×3 of decided columns. */
export const SIGIL_N = 5;
const CELL = 100 / SIGIL_N;
export const SIGIL_VIEWBOX = "0 0 100 100";

export interface SigilCell {
  readonly id: number;
  /** Which of the palette's two tones this cell wears. */
  readonly tone: 0 | 1;
  /** Diagonal index, which is what the idle wave and the streaming sweep travel along. */
  readonly d: number;
  /** Rect geometry, already in viewBox units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The cell's own centre, which every transform is taken about. */
  readonly cx: number;
  readonly cy: number;
  /** Where this cell flies in from, how far it spins, and its own clock. */
  readonly dx: number;
  readonly dy: number;
  readonly spin: number;
  readonly phase: number;
  readonly speed: number;
}

/**
 * The mark itself. ~50% density is the identicon sweet spot; 58% made marks
 * rhyme with each other. The 2×2 block is the part that changes a sigil's
 * MASS rather than only its texture, which is what makes two of them differ at
 * 20px and not only at 96.
 */
export function sigilCells(rnd: Rng): SigilCell[] {
  const on: boolean[] = [];
  const tone: (0 | 1)[] = [];
  for (let i = 0; i < SIGIL_N * 3; i++) {
    on.push(rnd() > 0.5);
    tone.push(rnd() > 0.62 ? 1 : 0);
  }
  // Column 3 and 4 mirror column 1 and 0, so the mark has an axis and reads as
  // a mark rather than as noise.
  const at = (x: number, y: number): number => (x < 3 ? y * 3 + x : y * 3 + (4 - x));
  const bx = 1 + Math.floor(rnd() * 3);
  const by = Math.floor(rnd() * 4);
  const hasBlock = rnd() > 0.45;
  const blockTone: 0 | 1 = rnd() > 0.5 ? 1 : 0;

  const cells: SigilCell[] = [];
  const add = (x: number, y: number, w: number, h: number, t: 0 | 1, d: number): void => {
    // Every cell carries its own flight: where it comes in from, how fast it
    // cycles, and how far out of phase it is with its neighbours. Shared timing
    // would read as one object pulsing; independent timing reads as parts
    // arriving.
    const a = rnd() * TAU;
    const dist = 12 + rnd() * 20;
    cells.push({
      id: cells.length,
      tone: t,
      d,
      x: x * CELL,
      y: y * CELL,
      w: w * CELL,
      h: h * CELL,
      cx: (x + w / 2) * CELL,
      cy: (y + h / 2) * CELL,
      dx: Math.cos(a) * dist,
      dy: Math.sin(a) * dist,
      spin: (rnd() < 0.5 ? -1 : 1) * (25 + rnd() * 65),
      phase: rnd(),
      speed: 0.26 + rnd() * 0.26,
    });
  };

  const covered = (x: number, y: number): boolean =>
    hasBlock && x >= bx && x < bx + 2 && y >= by && y < by + 2;
  if (hasBlock) add(bx, by, 2, 2, blockTone, bx + by);
  for (let y = 0; y < SIGIL_N; y++) {
    for (let x = 0; x < SIGIL_N; x++) {
      if (!on[at(x, y)] || covered(x, y)) continue;
      add(x, y, 1, 1, tone[at(x, y)] ?? 0, x + y);
    }
  }
  return cells;
}

/* ── easings ──────────────────────────────────────────────────────────────── */

/** Overshoot on landing — a cell that arrives dead-on reads as a fade. */
function backOut(p: number): number {
  const c1 = 1.9;
  const q = p - 1;
  return 1 + (c1 + 1) * q * q * q + c1 * q * q;
}
function expoOut(p: number): number {
  return p >= 1 ? 1 : 1 - 2 ** (-10 * p);
}
function smooth(p: number): number {
  return p * p * (3 - 2 * p);
}
function bounceOut(p: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) {
    const q = p - 1.5 / d;
    return n * q * q + 0.75;
  }
  if (p < 2.5 / d) {
    const q = p - 2.25 / d;
    return n * q * q + 0.9375;
  }
  const q = p - 2.625 / d;
  return n * q * q + 0.984375;
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/**
 * The state of one cell in one frame. Separated from the DOM write so the whole
 * choreography is testable as arithmetic: `sigilFrame` is a pure function of
 * (cell, time, motion) and `sigilTick` is the three `setAttribute` calls that
 * put it on screen.
 *
 * `dh`/`dl` are offsets applied to the cell's own tone, never absolute colours —
 * that is what keeps the streaming sweep from drifting away from the agent's
 * identity palette.
 */
export interface SigilFrame {
  kx: number;
  ky: number;
  dx: number;
  dy: number;
  rot: number;
  opacity: number;
  dh: number;
  dl: number;
}

/** Seated, full strength, own colour: the still frame, and the first paint. */
export const SIGIL_HOME: SigilFrame = { kx: 1, ky: 1, dx: 0, dy: 0, rot: 0, opacity: 1, dh: 0, dl: 0 };

/* ── per-cycle randomness ─────────────────────────────────────────────────────
   The style must change EVERY LOOP, not once per cell — otherwise the mark has
   a fixed choreography you have learnt after ten seconds. Hashing (cell id,
   cycle number) keeps it deterministic — same agent, same frame, same picture,
   which is what a snapshot needs — while never repeating an arrangement twice
   in a row. */
function mix(a: number, b: number): number {
  let h = (Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

type Move = (p: number, c: SigilCell, r: number) => SigilFrame;
const move = (
  kx: number,
  ky: number,
  dx: number,
  dy: number,
  rot: number,
  opacity: number,
): SigilFrame => ({
  kx,
  ky,
  dx,
  dy,
  rot,
  opacity,
  dh: 0,
  dl: 0,
});

/**
 * Entry styles. `r` is this cycle's own random number, so even two cells that
 * rolled the same style arrive differently.
 */
const ENTRIES: readonly Move[] = [
  // fly — in along the cell's own vector, landing with an overshoot
  (p, c) => {
    const k = backOut(p);
    const b = 1 - p;
    return move(k, k, c.dx * b, c.dy * b, c.spin * b, Math.min(1, p * 2.2));
  },
  // slide — axis-aligned, no spin, no scale. The quiet one, and the set needs a
  // quiet one or every landing is an event.
  (p, _c, r) => {
    const b = 1 - expoOut(p);
    const dist = (22 + r * 14) * b;
    const dir = Math.floor(r * 4);
    return move(
      1,
      1,
      dir === 0 ? -dist : dir === 1 ? dist : 0,
      dir === 2 ? -dist : dir === 3 ? dist : 0,
      0,
      Math.min(1, p * 3),
    );
  },
  // fade — nothing moves at all
  (p) => move(1, 1, 0, 0, 0, smooth(p)),
  // zoom — scale up through an overshoot, in place
  (p) => {
    const k = backOut(p);
    return move(k, k, 0, 0, 0, Math.min(1, p * 2));
  },
  // spin — a half to a full turn on the way in
  (p, _c, r) => {
    const e = expoOut(p);
    const turn = (r < 0.5 ? -1 : 1) * (180 + r * 360);
    return move(e, e, 0, 0, turn * (1 - e), Math.min(1, p * 2));
  },
  // drop — falls in from above and bounces once
  (p, _c, r) => {
    const b = 1 - bounceOut(p);
    return move(1, 1, 0, -(28 + r * 16) * b, 0, Math.min(1, p * 4));
  },
  // flip — a card turn on one axis
  (p, _c, r) => {
    const k = backOut(p);
    return r < 0.5
      ? move(k, 1, 0, 0, 0, Math.min(1, p * 2.5))
      : move(1, k, 0, 0, 0, Math.min(1, p * 2.5));
  },
  // shrink — arrives oversized and settles down onto its cell
  (p) => {
    const k = 1 + 0.95 * (1 - expoOut(p));
    return move(k, k, 0, 0, 0, smooth(p));
  },
];

/** Exits are shorter and fewer: a leaving cell is punctuation, not a sentence. */
const EXITS: readonly Move[] = [
  (p) => move(1, 1, 0, 0, 0, 1 - p),
  (p) => {
    const k = 1 - p * 0.9;
    return move(k, k, 0, 0, 0, 1 - p);
  },
  (p, c) => {
    const k = 1 - p * 0.4;
    return move(k, k, c.dx * p * 0.5, c.dy * p * 0.5, c.spin * p * 0.6, 1 - p);
  },
  (p, c) => {
    const k = 1 - p * 0.8;
    return move(k, k, 0, 0, c.spin * p * 2.2, 1 - p);
  },
  (p) => move(1 - p, 1, 0, 0, 0, 1 - p * 0.3),
];

/** One cell, one instant. Pure. */
export function sigilFrame(cell: SigilCell, t: number, motion: AvatarMotion): SigilFrame {
  if (!motion.alive) return SIGIL_HOME;

  if (motion.activity === "streaming") {
    // Blocks hold, the material moves. Two sweeps at deliberately unrelated
    // frequencies, so they never line up and the loop has no visible period.
    return {
      ...SIGIL_HOME,
      dh: Math.sin(t * 3.1 - cell.d * 0.85) * 34,
      dl: Math.sin(t * 1.75 - cell.d * 0.46 + 1.2) * 20,
    };
  }

  if (motion.activity === "thinking") {
    const u = t * cell.speed + cell.phase;
    const cycle = Math.floor(u);
    const f = u - cycle;
    // A new roll every loop: which entry, which exit, and one spare random for
    // the style to shape itself with.
    const hash = mix(cell.id, cycle);
    const enter = ENTRIES[hash % ENTRIES.length]!;
    const exit = EXITS[(hash >>> 8) % EXITS.length]!;
    const r = ((hash >>> 16) & 0xffff) / 0xffff;
    if (f < 0.12) return move(0, 0, 0, 0, 0, 0); // gone, waiting its turn
    if (f < 0.42) return enter((f - 0.12) / 0.3, cell, r);
    if (f < 0.86) return SIGIL_HOME; // seated
    return exit((f - 0.86) / 0.14, cell, r);
  }

  // idle and muted: the quiet diagonal wave, scaled by the activity's amplitude.
  const w = Math.sin(t * 1.5 - cell.d * 0.7);
  return { ...SIGIL_HOME, opacity: clamp(0.62 + 0.38 * (0.5 + 0.5 * w) * motion.amp, 0, 1) };
}

/** Scale and rotate about the cell's own centre, then displace. */
function transformFor(cell: SigilCell, f: SigilFrame): string {
  if (f.kx === 1 && f.ky === 1 && f.dx === 0 && f.dy === 0 && f.rot === 0) return "";
  const tx = (cell.cx + f.dx).toFixed(2);
  const ty = (cell.cy + f.dy).toFixed(2);
  return (
    `translate(${tx} ${ty}) scale(${f.kx.toFixed(3)} ${f.ky.toFixed(3)})` +
    ` rotate(${f.rot.toFixed(1)}) translate(${(-cell.cx).toFixed(2)} ${(-cell.cy).toFixed(2)})`
  );
}

function applyCell(node: SVGRectElement, cell: SigilCell, f: SigilFrame, pal: AvatarPalette): void {
  node.setAttribute("transform", transformFor(cell, f));
  node.setAttribute("opacity", clamp(f.opacity, 0, 1).toFixed(3));
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
