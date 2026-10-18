/**
 * Haptics, behind the operator's toggle (Settings → Haptics). Every tap the
 * app plays goes through here so one switch silences all of them; a failure
 * (no Taptic Engine, simulator) is never an error.
 */
import * as Haptics from "expo-haptics";

let enabled = true;

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

export function hapticsEnabled(): boolean {
  return enabled;
}

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

export const haptic = {
  /** A selection tick: toggles, chips, choices. */
  select(): void {
    if (enabled) quiet(Haptics.selectionAsync());
  },
  /** A light bump: a long-press menu opening, a pull that triggered. */
  light(): void {
    if (enabled) quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  },
  medium(): void {
    if (enabled) quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
  },
  success(): void {
    if (enabled) quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  warning(): void {
    if (enabled) quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  },
  error(): void {
    if (enabled) quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
  },
};
