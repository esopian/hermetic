/**
 * "Nothing here" — a claim, not a loading state. Nothing renders this until a
 * read has come back (`loading.ts`); before that it is a skeleton.
 *
 * `title` defaults to the fleet's own sentence because the fleet is where this
 * started, and every other caller says what its own nothing is.
 */
import type { ReactNode } from "react";

export function EmptyState({
  hint,
  title = "No agents here",
  action,
}: {
  hint: string;
  title?: string;
  /** The one useful next step, when there is one — e.g. §8.3's "Set up a provider". */
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <b>{title}</b>
      <span>{hint}</span>
      {action ? <span className="empty-action">{action}</span> : null}
    </div>
  );
}
