/**
 * The theme: both schemes from the desktop's tokens, following the system
 * scheme unless the operator picked one (persisted). `useTheme()` is the only
 * way a component reads a colour.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";
import type { PrefStorage } from "../bridge/storage.ts";
import { mono, sans } from "./fonts.ts";
import { border, motion, space, touch, type } from "./scale.ts";
import { type Palette, palettes, type SchemeName } from "./tokens.ts";

export type SchemePreference = "system" | SchemeName;

export interface Theme {
  scheme: SchemeName;
  preference: SchemePreference;
  setPreference(preference: SchemePreference): void;
  c: Palette;
  space: typeof space;
  border: typeof border;
  type: typeof type;
  touch: typeof touch;
  motion: typeof motion;
  sans: typeof sans;
  mono: typeof mono;
}

const PREF_KEY = "hermetic.theme";

export function buildTheme(
  scheme: SchemeName,
  preference: SchemePreference = "system",
  setPreference: (p: SchemePreference) => void = () => {},
): Theme {
  return {
    scheme,
    preference,
    setPreference,
    c: palettes[scheme],
    space,
    border,
    type,
    touch,
    motion,
    sans,
    mono,
  };
}

const ThemeContext = createContext<Theme>(buildTheme("dark"));

export function ThemeProvider({
  children,
  storage,
  initial = "system",
}: {
  children: ReactNode;
  storage?: PrefStorage;
  initial?: SchemePreference;
}) {
  const system = useColorScheme();
  const [preference, setPref] = useState<SchemePreference>(initial);

  useEffect(() => {
    let live = true;
    void storage
      ?.get(PREF_KEY)
      .then((v) => {
        if (live && (v === "dark" || v === "light" || v === "system")) setPref(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [storage]);

  const setPreference = useCallback(
    (p: SchemePreference) => {
      setPref(p);
      void storage?.set(PREF_KEY, p).catch(() => {});
    },
    [storage],
  );

  // Dark is the product's default, as on the desktop, when the system says nothing.
  const scheme: SchemeName =
    preference === "system" ? (system === "light" ? "light" : "dark") : preference;
  const theme = useMemo(
    () => buildTheme(scheme, preference, setPreference),
    [scheme, preference, setPreference],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
