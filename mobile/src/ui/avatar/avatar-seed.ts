/**
 * Seeded avatar identity — a port of the desktop's
 * `packages/ui/src/chat/components/avatar/avatar-seed.ts` (the blob subset).
 *
 * The seed is `fleet_id/instance/bot`, never the display name, so renaming a
 * bot keeps its face; the RNG (`xmur3` → `mulberry32`) and the order every
 * number is drawn in are the desktop's, so a bot has the same hues and the
 * same shape on both heads. The only change is the output colour format:
 * React Native SVG wants hex, so `hsl()` is converted (`hslHex`).
 */

export type AvatarStatus = "ready" | "degraded" | "error" | "stopped" | "destroyed" | "pending";
export type AvatarActivity = "idle" | "thinking" | "streaming" | "muted";
export type Rng = () => number;

export function avatarSeed(fleet_id: string, instance: string, bot: string): string {
  return [fleet_id || "_", instance || "_", bot || ""].filter(Boolean).join("/");
}

export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function mulberry32(a: number): Rng {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(key: string): Rng {
  return mulberry32(xmur3(key)());
}

/** The shape stream, and (in a family) a hue stream shared by every bot on one instance. */
export function avatarSeeds(key: string, family: boolean): { shape: Rng; hue: Rng | null } {
  const shape = rngFor(key);
  if (!family) return { shape, hue: null };
  const instanceKey = key.split("/").slice(0, 2).join("/");
  return { shape, hue: rngFor(instanceKey) };
}

/** The accent's hue band, kept for the product's own orange. */
export const RESERVED_HUE = { from: 14, to: 40 } as const;

function dodgeReserved(h: number): number {
  return h > RESERVED_HUE.from && h < RESERVED_HUE.to ? (h + 150) % 360 : h;
}

/** `hsl(h s% l%)` as `#rrggbb`. */
export function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lit = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lit, 1 - lit);
  const f = (n: number) => lit - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export interface AvatarPalette {
  readonly h: number;
  readonly h2: number;
  readonly s: number;
  readonly l: number;
  readonly a: string;
  readonly b: string;
  readonly glow: string;
}

/** Same draws, same order as the desktop's `avatarPalette`. */
export function avatarPalette(rnd: Rng, light: boolean, hueRnd?: Rng | null): AvatarPalette {
  let h = (hueRnd ?? rnd)() * 360;
  if (hueRnd) rnd();
  h = dodgeReserved(h);
  const dir = rnd() < 0.5 ? -1 : 1;
  const h2 = dodgeReserved((h + dir * (34 + rnd() * 58) + 360) % 360);
  const s = 56 + rnd() * 24;
  const l = light ? 44 + rnd() * 8 : 55 + rnd() * 11;
  const hsl = (x: number, ds = 0, dl = 0): string => {
    const hue = ((x % 360) + 360) % 360;
    const sat = Math.max(6, s + ds);
    const lit = Math.min(94, Math.max(6, l + dl));
    return hslHex(hue, sat, lit);
  };
  return { h, h2, s, l, a: hsl(h), b: hsl(h2, -10, -14), glow: hsl(h, 6, 14) };
}

const STATUS: Record<AvatarStatus, { opacity: number; stopped: boolean }> = {
  ready: { opacity: 1, stopped: false },
  pending: { opacity: 0.7, stopped: false },
  degraded: { opacity: 0.92, stopped: false },
  error: { opacity: 0.88, stopped: false },
  stopped: { opacity: 0.45, stopped: true },
  destroyed: { opacity: 0.3, stopped: true },
};

const ACTIVITY_SCALE: Record<AvatarActivity, number> = {
  idle: 1,
  thinking: 1.04,
  streaming: 1.06,
  muted: 0.97,
};

export function avatarLook(
  status: AvatarStatus,
  activity: AvatarActivity,
): { opacity: number; scale: number; alive: boolean } {
  const st = STATUS[status] ?? STATUS.ready;
  return { opacity: st.opacity, scale: ACTIVITY_SCALE[activity] ?? 1, alive: !st.stopped };
}
