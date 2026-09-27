/**
 * Pixel crew — a 16-bit character from a parts library (§9.2).
 *
 * The concept work's one real finding: a concept does not have to be purely
 * procedural. A library of hand-authored parts, chosen by seed and composited,
 * gives far more fidelity per byte than an algorithm that has to invent
 * everything — which is how every reference implementation does it. Five heads ×
 * six eye sets × five mouths × six crests, all drawn on a 16×16 grid, and the
 * seed only picks which of them combine. Pixels are squares, so the style gets
 * personality without importing a curve.
 *
 * Tried at 32×32 and reverted: four times the area bought brows, body marks and
 * eye spacing, and cost the thing that made it work — a 16×16 face is chunky and
 * legible, a 32×32 one is detailed and muddy at the size this actually renders
 * at.
 *
 * The port's one structural change is worth stating, because it is what makes
 * the first-paint rule affordable. An earlier prototype composed one grid per
 * frame and repainted the whole face whenever the frame changed; that means
 * the DOM the face is made of depends on the animation, which is exactly what
 * must not be true of a component React renders. So the face is cut into
 * layers instead:
 * a static base (crest + head), five eye frames and two mouth frames, all
 * emitted once as ordinary `<rect>` elements, and animating is nothing but
 * toggling which frame group is displayed. The composite is identical — the
 * sprites are opaque and the draw order is the same — and the running cost
 * drops from a repaint to two attribute writes.
 */
import type { AvatarMotion, AvatarPalette, Rng } from "./avatar-seed.ts";
import { pick } from "./avatar-seed.ts";

const G = 16;
export const PIXEL_VIEWBOX = "0 0 16 16";

/* '.' transparent · '0' outline · '1' body · '2' shade · '3' highlight
   'e' sclera · 'p' pupil */
type Sprite = readonly string[];

const HEADS: readonly Sprite[] = [
  [
    "................",
    "...00000000000..",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0122222222220.",
    "...00000000000..",
    "................",
    "................",
    "................",
  ],
  [
    "................",
    ".....000000.....",
    "...0011111100...",
    "..011111111120..",
    ".01111111111220.",
    ".01111111111220.",
    ".01111111111220.",
    ".01111111111220.",
    ".01111111111220.",
    ".01111111111220.",
    "..0111111111220.",
    "..0122222222220.",
    "...00000000000..",
    "................",
    "................",
    "................",
  ],
  [
    "................",
    "..00000000000...",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    "..01111111120...",
    "..01111111120...",
    "...012222220....",
    "....0000000.....",
    "................",
    "................",
    "................",
    "................",
  ],
  [
    "................",
    "................",
    ".0000000000000..",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    ".0111111111120..",
    ".0122222222220..",
    ".0000000000000..",
    "................",
    "................",
    "................",
    "................",
    "................",
  ],
  [
    "..0..........0..",
    "..01........10..",
    "..0110000001120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0111111111120.",
    "..0122222222220.",
    "...00000000000..",
    "................",
    "................",
    "................",
    "................",
  ],
];

/**
 * Each eye style, 3×3, stamped at x=3 and x=10 — both UNMIRRORED. Five frames:
 * 0 open · 1 up-left · 2 up-centre · 3 up-right · 4 closed. Thinking holds the
 * gaze up and tracks it across those three; mirroring the sprite would mirror
 * the pupil with it and the face goes wall-eyed.
 */
const EYES: readonly (readonly Sprite[])[] = [
  // square
  [
    ["eee", "epe", "eee"],
    ["pee", "eee", "eee"],
    ["epe", "eee", "eee"],
    ["eep", "eee", "eee"],
    ["...", "000", "..."],
  ],
  // dot
  [
    ["...", ".p.", "..."],
    ["p..", "...", "..."],
    [".p.", "...", "..."],
    ["..p", "...", "..."],
    ["...", "000", "..."],
  ],
  // bar
  [
    ["...", "ppp", "..."],
    ["pp.", "...", "..."],
    ["ppp", "...", "..."],
    [".pp", "...", "..."],
    ["...", "000", "..."],
  ],
  // round
  [
    [".e.", "epe", ".e."],
    ["p..", "e.e", ".e."],
    [".p.", "e.e", ".e."],
    ["..p", "e.e", ".e."],
    ["...", "000", "..."],
  ],
  // side-glance
  [
    ["eep", "eep", "..."],
    ["pee", "pee", "..."],
    ["epe", "epe", "..."],
    ["eep", "eep", "..."],
    ["...", "000", "..."],
  ],
  // goggle — the glint moves rather than the pupil
  [
    ["ppp", "pep", "ppp"],
    ["epp", "ppp", "ppp"],
    ["pep", "ppp", "ppp"],
    ["ppe", "ppp", "ppp"],
    ["...", "000", "..."],
  ],
];

/** Each mouth: [rest, talk]; 6×2, stamped at x=5. */
const MOUTHS: readonly (readonly Sprite[])[] = [
  [
    ["......", "......"],
    ["......", "......"],
  ],
  [
    [".0000.", "......"],
    [".0..0.", ".0000."],
  ],
  [
    ["0....0", ".0000."],
    ["0....0", "..00.."],
  ],
  [
    ["000000", ".0..0."],
    ["000000", "..00.."],
  ],
  [
    ["..00..", ".0000."],
    [".0000.", "..00.."],
  ],
];

const CRESTS: readonly Sprite[] = [
  ["................", "................"],
  ["......3..3......", ".....01....10..."],
  ["......333.......", "......010......."],
  ["..333........333", "..010........010"],
  ["...3333333333...", "...0000000000..."],
  [".....33333......", "....0111110....."],
];

/** L → C → R → C, both pupils together. A scan, not a metronome sweep. */
const LOOK = [1, 2, 3, 2] as const;

/** One run of same-coloured cells on one row. Height is always 1. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly fill: string;
}

export interface PixelParts {
  /** Crest and head, composed once. The face's whole silhouette. */
  readonly base: readonly PixelRect[];
  /** Five frames, each holding both sockets. Indexed by `PixelFrame.eye`. */
  readonly eyes: readonly (readonly PixelRect[])[];
  /** Two frames: rest and talk. Indexed by `PixelFrame.mouth`. */
  readonly mouths: readonly (readonly PixelRect[])[];
  readonly blinkAt: number;
  readonly blinkEvery: number;
  readonly lookAt: number;
  readonly lookRate: number;
}

type Grid = string[][];
const emptyGrid = (): Grid => Array.from({ length: G }, () => Array(G).fill("."));

function stamp(grid: Grid, sprite: Sprite, ox: number, oy: number): void {
  for (let y = 0; y < sprite.length; y++) {
    const row = sprite[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (!ch || ch === ".") continue;
      const gx = ox + x;
      const gy = oy + y;
      if (gx < 0 || gx >= G || gy < 0 || gy >= G) continue;
      grid[gy]![gx] = ch;
    }
  }
}

/** Row run-length encoding: a 16×16 face is ~40 rects, not 256. */
function encode(grid: Grid, colour: Record<string, string>): PixelRect[] {
  const out: PixelRect[] = [];
  for (let y = 0; y < G; y++) {
    const row = grid[y]!;
    let x = 0;
    while (x < G) {
      const ch = row[x]!;
      if (ch === ".") {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < G && row[x + w] === ch) w++;
      out.push({ x, y, w, fill: colour[ch] ?? colour["1"]! });
      x += w;
    }
  }
  return out;
}

/**
 * The seed picks the parts and the timings; nothing here is generated. The draw
 * order of the `rnd()` calls is the contract — change it and every existing
 * agent gets a new face.
 */
export function pixelParts(rnd: Rng, pal: AvatarPalette): PixelParts {
  const head = pick(rnd, HEADS);
  const eye = pick(rnd, EYES);
  const mouth = pick(rnd, MOUTHS);
  const crest = pick(rnd, CRESTS);
  const eyeRow = pick(rnd, [4, 5, 5, 6]);
  const mouthRow = eyeRow + pick(rnd, [3, 4]);
  const colour: Record<string, string> = {
    "0": pal.line,
    "1": pal.a,
    "2": pal.b,
    "3": pal.glow,
    e: pal.paper,
    p: pal.ink,
  };

  const baseGrid = emptyGrid();
  stamp(baseGrid, crest, 0, 0);
  stamp(baseGrid, head, 0, 0);

  const eyes = eye.map((frame) => {
    const g = emptyGrid();
    // Same frame in both sockets, unmirrored — see the note on EYES.
    stamp(g, frame, 3, eyeRow);
    stamp(g, frame, 10, eyeRow);
    return encode(g, colour);
  });
  const mouths = mouth.map((frame) => {
    const g = emptyGrid();
    stamp(g, frame, 5, mouthRow);
    return encode(g, colour);
  });

  return {
    base: encode(baseGrid, colour),
    eyes,
    mouths,
    blinkAt: rnd() * 6,
    blinkEvery: 3.2 + rnd() * 3.4,
    lookAt: rnd() * 4,
    // `t` already advances at 3.1× while thinking, so this is the rate AFTER
    // that multiplier: about one move every 0.7–1.1s. Faster read as panic.
    lookRate: 0.3 + rnd() * 0.16,
  };
}

export interface PixelFrame {
  readonly eye: number;
  readonly mouth: number;
  /** A one-pixel bob, in viewBox units, applied to the whole face. */
  readonly bob: number;
}

/** Eyes open, mouth at rest, no bob — the first paint and the reduced-motion frame. */
export const PIXEL_STILL: PixelFrame = { eye: 0, mouth: 0, bob: 0 };
/** Eyes shut. A stopped box is not looking at anything. */
export const PIXEL_STOPPED: PixelFrame = { eye: 4, mouth: 0, bob: 0 };

/**
 * Which frame the face wears at time `t`. Pure, so the whole performance is
 * assertable without a DOM.
 *
 * Reduced motion and a stopped box both come out of the ticker's reach, and
 * they deliberately want *different* frames: a stopped box has its eyes shut,
 * and a reduced-motion user gets the ordinary resting face rather than a
 * corpse.
 */
export function pixelFrame(parts: PixelParts, t: number, motion: AvatarMotion): PixelFrame {
  if (motion.stopped) return PIXEL_STOPPED;
  if (!motion.alive) return PIXEL_STILL;
  const blink = (t + parts.blinkAt) % parts.blinkEvery < 0.14;
  // Thinking: gaze stays up and both pupils track left/right together.
  const looking = LOOK[Math.floor((t + parts.lookAt) * parts.lookRate) % LOOK.length] ?? 0;
  return {
    eye: blink ? 4 : motion.activity === "thinking" ? looking : 0,
    // Streaming cycles the mouth: the character is talking, which is the one
    // gesture a pixel face does better than anything else here.
    mouth: motion.activity === "streaming" && Math.floor(t * 5) % 2 === 0 ? 1 : 0,
    bob: Math.sin(t * 1.4) > 0.72 ? -1 : 0,
  };
}

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
