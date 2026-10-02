/**
 * The avatar seed, the palette, and the numbers a state is worth (§9.2).
 *
 * Pure, DOM-free and React-free on purpose. Everything an avatar *is* — which
 * colours it wears, which cells are on, how fast it moves when its box is
 * thinking — is decided here, so it can be tested without mounting anything and
 * so a second head could derive the same picture from the same three fields.
 * The renderers in `sigil.ts` / `pixel.ts` / `blob.ts` consume this module and
 * draw; `Avatar.tsx` is the only file that touches React.
 *
 * The CLI promise in §9.2 rests on that purity: `agent ps` already prints
 * `fleet_id`, the agent name and the profile, and both hash functions below are
 * ten lines each, so the CLI can colour a name with exactly the palette the
 * portal draws without shipping a renderer. Nothing in here may grow a
 * dependency on the DOM if that is to stay true.
 */

/* ── the three styles, the two enums the app already has ──────────────────── */

export type AvatarStyle = "sigil" | "pixel" | "blob";

/**
 * `blob` is the default, chosen by the owner on 2026-09-17.
 *
 * It is the style that costs something to ship, and the cost was accepted
 * deliberately rather than overlooked (§9.2). `styles.css` declares
 * `* { border-radius: 0 }` and means it — the brutalist shell has no curve
 * anywhere — so a blob is a **stated exception to a real rule**, and the reason
 * it is allowed is that an avatar is the one thing on screen that is not a
 * control, not a surface and not a seam. It is a face. A rule with one
 * deliberate exception is still a rule; a rule with one undocumented exception
 * is a bug somebody later "fixes", which is why this comment exists and why
 * `docs/ui-brief.md` names it too.
 *
 * `sigil` was the default until this choice: a 5×3 cell matrix built entirely
 * from hermetic's own unit, the square. It remains available and remains the
 * conservative pick if the curve is ever regretted — swapping the constant
 * below is the whole change, because every style reads the same seed.
 */
export const AVATAR_STYLES: readonly AvatarStyle[] = ["sigil", "pixel", "blob"];
export const DEFAULT_AVATAR_STYLE: AvatarStyle = "blob";

/** The agent's health, as the fleet view already reports it. */
export type AvatarStatus = "ready" | "degraded" | "error" | "stopped" | "destroyed" | "pending";

/** What the bot is doing *right now*, which is a different axis from health. */
export type AvatarActivity = "idle" | "thinking" | "streaming" | "muted";

/** A seeded random source. `mulberry32`, in practice, but nothing depends on that. */
export type Rng = () => number;

/* ── the identity key ─────────────────────────────────────────────────────── */

/**
 * The only place a seed is derived: `fleet_id / instance / bot`.
 *
 * Never the display name. Every part is chosen for being immutable, and the
 * first draft of this — seeding on the agent's name alone — was wrong in two
 * ways that only surfaced once the swarm model landed:
 *
 *   · every instance runs its own roster, so two boxes will both have a bot
 *     called `researcher`. Name-seeded, those were the same avatar, which is
 *     the exact confusion `@bot@instance` exists to prevent.
 *   · two fleets in one account can both have an `atlas`. Different machines,
 *     same picture.
 *
 * What each part buys:
 *
 *   fleet_id   the fleet's identity, never its alias — §4.6 makes the alias
 *              display-only, and renaming a fleet must not repaint every
 *              avatar in it.
 *   instance   the agent name. A destroy releases it (§6.7), so a later agent
 *              under the same name shares its predecessor's avatar; the name
 *              is the identity an operator addresses, and a dead agent has no
 *              rail entry left to be confused with.
 *   bot        the profile name under `$HERMES_HOME/profiles/`. Pass `""` for
 *              an instance-level avatar, so a box and its default bot are
 *              deliberately *not* the same picture — they are different rows in
 *              the rail.
 *
 * Consequences worth stating: a `recreate` keeps the name and therefore the
 * avatar (nothing in the key is EC2's), `researcher@atlas` and
 * `researcher@granite` differ, and `atlas` in `main` and `atlas` in `staging`
 * differ.
 */
export function avatarSeed(fleet_id: string, instance: string, bot: string): string {
  return [fleet_id || "_", instance || "_", bot || ""].filter(Boolean).join("/");
}

/* ── determinism ──────────────────────────────────────────────────────────── */

/**
 * xmur3 spreads a short string over 32 bits. Paired with `mulberry32` below it
 * is the whole PRNG: both are tiny, both are pure, and the pair is reproducible
 * in any language — which is what makes the CLI able to print the same palette.
 */
function xmur3(str: string): () => number {
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

/** mulberry32: a 32-bit state PRNG, uniform in [0, 1). */
function mulberry32(a: number): Rng {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The random stream for one identity key. Same key, same stream, forever. */
export function rngFor(key: string): Rng {
  return mulberry32(xmur3(key)());
}

/** Pick one item from a parts library. The whole combinatorial idea in one line. */
export function pick<T>(rnd: Rng, arr: readonly T[]): T {
  // `arr` is never empty at any call site, but `noUncheckedIndexedAccess` is on
  // and an assertion here would be the only one in the file.
  const item = arr[Math.floor(rnd() * arr.length)];
  if (item === undefined) throw new Error("pick() from an empty parts library");
  return item;
}

/**
 * The two streams an avatar draws from.
 *
 * With `family` on — the default, and §9.2's argument for it is the
 * all-instances feed — the HUE comes from the `fleet_id/instance` prefix while
 * the SHAPE still comes from the full key. Every bot on one box then reads as a
 * hue family, and the rail's buckets and labels go on doing the job of telling
 * `researcher` from `ops-writer` inside a swarm. Hue is the only channel with
 * the reach to say *which box* a row belongs to at 32px in peripheral vision,
 * and in the interleaved feed nothing else says it at all.
 */
export function avatarSeeds(key: string, family: boolean): { shape: Rng; hue: Rng | null } {
  const shape = rngFor(key);
  if (!family) return { shape, hue: null };
  const instanceKey = key.split("/").slice(0, 2).join("/");
  return { shape, hue: rngFor(instanceKey) };
}

/* ── palette ──────────────────────────────────────────────────────────────── */

/**
 * The band that is not an avatar's to take: `--acc` is #ff5a1f and the warn/bad
 * family sits beside it. An avatar that landed there would read as a status,
 * and status in this app is a square, never a face.
 *
 * Both of the palette's hues dodge it, not just the primary. An earlier
 * prototype guarded only the first, which was fine for a blob where the
 * second hue is a gradient stop — but a sigil fills whole cells with it, and
 * a mark that is 40% accent orange competes with the one colour the UI
 * reserves for "look here".
 */
export const RESERVED_HUE = { from: 14, to: 40 } as const;

/** Rotate a hue out of the reserved band. 150° is far enough to be a decision. */
function dodgeReserved(h: number): number {
  return h > RESERVED_HUE.from && h < RESERVED_HUE.to ? (h + 150) % 360 : h;
}

export interface AvatarPalette {
  /** Primary hue, in degrees, already dodged out of the reserved band. */
  readonly h: number;
  /** Secondary hue, likewise dodged. */
  readonly h2: number;
  /** Saturation, 56–80%. */
  readonly s: number;
  /** Lightness: 44–52% on the light theme, 55–66% on the dark one. */
  readonly l: number;
  readonly light: boolean;
  /** The primary fill. */
  readonly a: string;
  /** The secondary fill: the other hue, duller and darker. */
  readonly b: string;
  /** A lift of the primary, for highlights and gradient tops. */
  readonly glow: string;
  /** The outline colour, for the styles that draw one. */
  readonly line: string;
  /** Near-black and near-paper, for pixel's pupils and sclera. */
  readonly ink: string;
  readonly paper: string;
  /**
   * One of the two tones, shifted in hue and lightness. `tone(0, 0, 0)` is
   * exactly `a` and `tone(1, 0, 0)` is exactly `b`, so a renderer can animate
   * shading without drifting away from its own identity colours.
   */
  tone(which: 0 | 1, dh: number, dl: number): string;
}

/**
 * Hue free, saturation and lightness pinned.
 *
 * The pinning is what makes thirteen avatars read as thirteen hues of one
 * material rather than thirteen unrelated stickers. Light theme sits on #f1efe9
 * and the same hue has to come down to stay legible; dark sits on #0e0e0d and
 * can run brighter.
 *
 * `hueRnd` lets the hue come from a different stream than the shape — see
 * `avatarSeeds` and the family option. The shape stream is stepped once either
 * way, so turning family mode on or off changes the colour of a mark and never
 * its geometry.
 */
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
    return `hsl(${hue.toFixed(1)} ${sat.toFixed(1)}% ${lit.toFixed(1)}%)`;
  };
  return {
    h,
    h2,
    s,
    l,
    light,
    a: hsl(h),
    b: hsl(h2, -10, -14),
    glow: hsl(h, 6, 14),
    line: hsl(h, -20, light ? -34 : -38),
    ink: light ? "#111110" : "#0e0e0d",
    paper: light ? "#faf9f6" : "#f1efe9",
    tone: (which, dh, dl) => (which ? hsl(h2 + dh, -10, -14 + dl) : hsl(h + dh, 0, dl)),
  };
}

/* ── state → five numbers ─────────────────────────────────────────────────── */

/**
 * Activity is the *rate* axis. All three renderers read the same numbers, so
 * "thinking" means the same amount of more-ness whichever style is on.
 *
 * `muted` is slower and flatter than idle rather than faster: a muted bot is
 * still running, it is just not something the operator wants to be shown.
 */
const ACTIVITY: Record<AvatarActivity, { rate: number; amp: number; sat: number; scale: number }> = {
  idle: { rate: 1, amp: 1, sat: 1, scale: 1 },
  thinking: { rate: 3.1, amp: 1.5, sat: 1.1, scale: 1.04 },
  streaming: { rate: 4.6, amp: 1.9, sat: 1.2, scale: 1.06 },
  muted: { rate: 0.5, amp: 0.55, sat: 0.35, scale: 0.97 },
};

/**
 * Status is the *material* axis: it drains colour and opacity, and for the two
 * states where the box is genuinely not running it stops the clock. A stopped
 * box is not thinking, and freezing the mark is the most honest thing the
 * avatar can say — it also costs nothing to run.
 */
const STATUS: Record<AvatarStatus, { sat: number; opacity: number; stopped: boolean }> = {
  ready: { sat: 1, opacity: 1, stopped: false },
  pending: { sat: 0.5, opacity: 0.7, stopped: false },
  degraded: { sat: 0.72, opacity: 0.92, stopped: false },
  error: { sat: 0.6, opacity: 0.88, stopped: false },
  stopped: { sat: 0, opacity: 0.45, stopped: true },
  destroyed: { sat: 0, opacity: 0.3, stopped: true },
};

export interface AvatarMotion {
  readonly activity: AvatarActivity;
  /** How fast the renderer's clock advances, in seconds of animation per second. */
  readonly rate: number;
  /** How far the renderer is allowed to push its own amplitude. */
  readonly amp: number;
  /** A CSS `saturate()` factor, so a degraded agent drains without regenerating geometry. */
  readonly sat: number;
  readonly opacity: number;
  readonly scale: number;
  /**
   * False when nothing should move — either the box is stopped or the operator
   * asked for reduced motion. A renderer that sees this draws its still frame
   * and the ticker does not visit it again.
   */
  readonly alive: boolean;
  /**
   * True only for the statuses that are genuinely not running. Distinct from
   * `!alive` because the two want *different* still frames: a pixel face under
   * reduced motion has its eyes open, and a stopped one has them shut.
   */
  readonly stopped: boolean;
}

/** The five numbers, for a status crossed with an activity. */
export function avatarMotion(
  status: AvatarStatus,
  activity: AvatarActivity,
  reduced = false,
): AvatarMotion {
  const st = STATUS[status] ?? STATUS.ready;
  const ac = ACTIVITY[activity] ?? ACTIVITY.idle;
  const alive = !st.stopped && !reduced;
  return {
    activity,
    rate: alive ? ac.rate : 0,
    amp: ac.amp,
    sat: ac.sat * st.sat,
    opacity: st.opacity,
    scale: ac.scale,
    alive,
    stopped: st.stopped,
  };
}
