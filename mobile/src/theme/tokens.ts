/**
 * Colour tokens, copied verbatim from the desktop (`docs/ui-brief.md` "Look",
 * `packages/ui/src/styles/styles.css:5-41`). Same names minus the `--`, so a
 * rule read off the desktop's CSS maps onto the phone one-to-one.
 */
export interface Palette {
  bg: string;
  bg2: string;
  bg3: string;
  fg: string;
  fg2: string;
  fg3: string;
  line: string;
  line2: string;
  acc: string;
  accFg: string;
  ok: string;
  warn: string;
  bad: string;
  sel: string;
  dangerText: string;
  /** Modal backdrop (`rgba(0,0,0,.55)` on the desktop). */
  backdrop: string;
  /**
   * Phone-only, derived: the fill of a soft card (Settings groups, the chat's
   * request and failure cards) and its hairline ring. Dark keeps `bg2` with no
   * ring. Light lifts the card halfway from `bg` to white and rings it in
   * `line`: `bg2` sat a shade under the page and the groups ran together.
   */
  card: string;
  cardEdge: string;
}

export type SchemeName = "dark" | "light";

export const palettes: Record<SchemeName, Palette> = {
  dark: {
    bg: "#0e0e0d",
    bg2: "#161614",
    bg3: "#1f1f1c",
    fg: "#f1efe9",
    fg2: "#a8a59c",
    fg3: "#6b6963",
    line: "#2c2b27",
    line2: "#3d3b35",
    acc: "#ff5a1f",
    accFg: "#0e0e0d",
    ok: "#37c27f",
    warn: "#e8b03a",
    bad: "#ef4d3f",
    sel: "#22211e",
    dangerText: "#0e0e0d",
    backdrop: "rgba(0,0,0,0.55)",
    card: "#161614",
    cardEdge: "transparent",
  },
  light: {
    bg: "#f1efe9",
    bg2: "#e8e6df",
    bg3: "#dedbd2",
    fg: "#111110",
    fg2: "#57554f",
    fg3: "#8b8880",
    line: "#cfccc3",
    line2: "#b9b6ac",
    acc: "#ff5a1f",
    accFg: "#111110",
    ok: "#188a55",
    warn: "#b07a12",
    bad: "#c9352a",
    sel: "#e3e0d7",
    dangerText: "#f1efe9",
    backdrop: "rgba(0,0,0,0.55)",
    card: "#f8f7f4",
    cardEdge: "#cfccc3",
  },
};

/** Agent status → colour (`docs/ui-brief.md`, "Data → UI mapping"). Busy states pulse. */
export function statusColor(p: Palette, status: string): { color: string; pulse: boolean } {
  switch (status) {
    case "ready":
      return { color: p.ok, pulse: false };
    case "degraded":
      return { color: p.warn, pulse: false };
    case "unreachable":
    case "error":
      return { color: p.bad, pulse: false };
    case "stopped":
    case "destroyed":
      return { color: p.fg3, pulse: false };
    default:
      return { color: p.acc, pulse: true };
  }
}

/** Notification class → colour (desktop `classColor`). */
export function classColor(p: Palette, cls: string): string {
  if (cls === "needs_action" || cls === "warn") return p.warn;
  if (cls === "bad") return p.bad;
  if (cls === "ok") return p.ok;
  return p.line2;
}
