/** Live iOS accessibility preferences, shared by motion and transient UI. */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

interface AccessibilityPreferences {
  reduceMotion: boolean;
  screenReader: boolean | null;
}

const Context = createContext<AccessibilityPreferences>({ reduceMotion: false, screenReader: false });

export function AccessibilityPreferencesProvider({ children }: { children: ReactNode }) {
  // Avoid motion and expiring alerts until the initial native queries resolve.
  const [reduceMotion, setReduceMotion] = useState(true);
  const [screenReader, setScreenReader] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    let motionChanged = false;
    let readerChanged = false;
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      motionChanged = true;
      setReduceMotion(enabled);
    });
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", (enabled) => {
      readerChanged = true;
      setScreenReader(enabled);
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (live && !motionChanged) setReduceMotion(enabled);
      })
      .catch(() => {});
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (live && !readerChanged) setScreenReader(enabled);
      })
      .catch(() => {});
    return () => {
      live = false;
      motion.remove();
      reader.remove();
    };
  }, []);
  return <Context.Provider value={{ reduceMotion, screenReader }}>{children}</Context.Provider>;
}

export function useAccessibilityPreferences(): AccessibilityPreferences {
  return useContext(Context);
}
