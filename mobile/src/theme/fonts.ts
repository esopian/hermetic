/**
 * Archivo (display/body) and JetBrains Mono (identifiers, timestamps), the
 * desktop's two families, as static TTFs (`mobile/assets/fonts/`, OFL).
 *
 * Each weight is its own family named by its PostScript name, which is how iOS
 * finds an embedded font (expo-font config plugin) and how `useFonts` registers
 * one at runtime — so the same name works in a dev client and a release build.
 * Set `fontFamily` from `sans(weight)`/`mono(weight)`, never `fontWeight`.
 */
export const FONT_ASSETS = {
  "Archivo-Regular": require("../../assets/fonts/Archivo-Regular.ttf"),
  "Archivo-Medium": require("../../assets/fonts/Archivo-Medium.ttf"),
  "Archivo-SemiBold": require("../../assets/fonts/Archivo-SemiBold.ttf"),
  "Archivo-Bold": require("../../assets/fonts/Archivo-Bold.ttf"),
  "Archivo-ExtraBold": require("../../assets/fonts/Archivo-ExtraBold.ttf"),
  "Archivo-Black": require("../../assets/fonts/Archivo-Black.ttf"),
  "JetBrainsMono-Regular": require("../../assets/fonts/JetBrainsMono-Regular.ttf"),
  "JetBrainsMono-Medium": require("../../assets/fonts/JetBrainsMono-Medium.ttf"),
  "JetBrainsMono-Bold": require("../../assets/fonts/JetBrainsMono-Bold.ttf"),
} as const;

export type FontName = keyof typeof FONT_ASSETS;
export type Weight = 400 | 500 | 600 | 700 | 800 | 900;

const SANS: Record<Weight, FontName> = {
  400: "Archivo-Regular",
  500: "Archivo-Medium",
  600: "Archivo-SemiBold",
  700: "Archivo-Bold",
  800: "Archivo-ExtraBold",
  900: "Archivo-Black",
};

const MONO: Record<Weight, FontName> = {
  400: "JetBrainsMono-Regular",
  500: "JetBrainsMono-Medium",
  600: "JetBrainsMono-Medium",
  700: "JetBrainsMono-Bold",
  800: "JetBrainsMono-Bold",
  900: "JetBrainsMono-Bold",
};

export const sans = (weight: Weight = 400): FontName => SANS[weight];
export const mono = (weight: Weight = 400): FontName => MONO[weight];
