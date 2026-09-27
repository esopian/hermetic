/**
 * The teardown receipt's presentation logic (§4.6), kept out of the component
 * so it can be tested without a DOM: which groups exist, in what order, and how
 * a receipt's flags read back as the command that produced it.
 */
import type { TeardownReceipt, TeardownResourceOutcome } from "../api/index.ts";

export type Disposition = TeardownResourceOutcome["disposition"];

export const GROUP_TITLES: Record<Disposition, string> = {
  removed: "Removed",
  skipped: "Nothing to remove",
  retained: "Still in the account",
  manual: "Yours to do by hand",
  failed: "Failed",
};

/**
 * Removed first — "what is gone" is the question — then what is still there,
 * then what hermetic cannot reach at all. `failed` sits last because it is
 * rare and, when present, the error banner has already said so.
 */
export const GROUP_ORDER: Disposition[] = ["removed", "skipped", "retained", "manual", "failed"];

export interface ReceiptGroup {
  disposition: Disposition;
  items: TeardownResourceOutcome[];
}

/** Non-empty groups only, in display order. */
export function groupReceipt(receipt: TeardownReceipt): ReceiptGroup[] {
  return GROUP_ORDER.map((disposition) => ({
    disposition,
    items: receipt.resources.filter((r) => r.disposition === disposition),
  })).filter((group) => group.items.length > 0);
}

/** The flags this teardown ran with, spelled as the CLI spells them. */
export function receiptFlags(receipt: TeardownReceipt): string[] {
  return Object.entries(receipt.options)
    .filter(([, on]) => on === true)
    .map(([name]) => `--${name.replace(/_/g, "-")}`);
}
