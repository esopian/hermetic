/**
 * Spacing and type scale. The desktop's sizes (`docs/ui-brief.md`), nudged up
 * where a phone needs a touch target: 44pt minimum for anything tappable.
 */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Borders carry the structure: seams 3, controls 2, rows 1. Radius is zero everywhere but avatars. */
export const border = {
  seam: 3,
  control: 2,
  row: 1,
} as const;

/**
 * The one corner radius: none. Controls, surfaces, cards, the composer and
 * buttons are square, as on the desktop (`docs/ui-brief.md`, "Look"). The blob
 * avatar is the single documented curve and lives in `src/ui/avatar/`.
 */
export const radius = 0 as const;

export const touch = {
  min: 44,
} as const;

export const type = {
  /** Kicker labels: 10/700/0.14em uppercase, fg3. */
  kicker: { size: 10, letterSpacing: 1.4 },
  caption: { size: 11, lineHeight: 15 },
  mono: { size: 12, lineHeight: 17 },
  body: { size: 15, lineHeight: 21 },
  bodySmall: { size: 13, lineHeight: 18 },
  title: { size: 17, lineHeight: 22 },
  heading: { size: 22, lineHeight: 26, letterSpacing: -0.4 },
  display: { size: 34, lineHeight: 36, letterSpacing: -1 },
} as const;

/** Durations (ms) — the desktop's pulse, slide and fade. */
export const motion = {
  pulse: 1200,
  slide: 180,
  fade: 120,
} as const;
