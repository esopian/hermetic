/**
 * This laptop's zone, for the "your time" hint beside an instance time. The
 * schedule helpers themselves are `@hermetic/core/shared` (`routine-schedule.ts`).
 */
export const LAPTOP_ZONE = Intl.DateTimeFormat("en-US").resolvedOptions().timeZone;
