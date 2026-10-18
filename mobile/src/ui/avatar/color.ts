/**
 * Colour format for react-native-svg.
 *
 * The shared palette (`@hermetic/core/shared`) speaks CSS `hsl(h s% l%)`, which
 * is what the desktop's SVG takes. react-native-svg wants hex, so the phone
 * converts at the edge. This is a format change only: the numbers are the
 * palette's own, rounded exactly as the desktop's string rounds them.
 */

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

const HSL = /^hsl\(\s*([-\d.]+)\s+([-\d.]+)%\s+([-\d.]+)%\s*\)$/;

/** Any palette colour as hex: an `hsl()` string is converted, anything else passes through. */
export function svgColor(css: string): string {
  const m = HSL.exec(css);
  if (!m) return css;
  return hslHex(Number(m[1]), Number(m[2]), Number(m[3]));
}
