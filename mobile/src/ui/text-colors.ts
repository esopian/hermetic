import type { Palette, SchemeName } from "../theme/tokens.ts";

export type TextTone = "fg" | "fg2" | "fg3" | "acc" | "ok" | "warn" | "bad";

/** Text needs 4.5:1 on page/card/raised surfaces; decorative fills keep the brand palette. */
export function textColor(c: Palette, scheme: SchemeName, tone: TextTone): string {
  if (tone === "fg3") return c.fg2;
  if (scheme === "dark" && tone === "bad") return "#f45648";
  if (scheme === "light") {
    if (tone === "acc") return "#ac3300";
    if (tone === "ok") return "#166c44";
    if (tone === "warn") return "#805700";
    if (tone === "bad") return "#ac2b22";
  }
  return c[tone];
}
