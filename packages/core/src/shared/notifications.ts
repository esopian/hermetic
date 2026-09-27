/**
 * The inbox's listening rule (§4.6), shared so the server's list and the
 * page's own re-filter cannot disagree about which rows it hides.
 */

/**
 * The sources that raise *instance* notifications: only these are scoped by the
 * listening set. An `operation` row is this laptop's own op settling and a
 * `fleet` row is a fleet-wide advisory; either may name an agent — one since
 * destroyed, even — and both stay visible regardless.
 */
export const INSTANCE_NOTIFICATION_SOURCES: readonly string[] = ["agent", "chat"];

/** True when the listening set hides this row; `undefined` means no filter. */
export function hiddenByListening(
  row: { source: string; agent?: string | null },
  instances: readonly string[] | undefined,
): boolean {
  return (
    instances !== undefined &&
    row.agent != null &&
    INSTANCE_NOTIFICATION_SOURCES.includes(row.source) &&
    !instances.includes(row.agent)
  );
}
