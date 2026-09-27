/**
 * `FLEET | CHAT | SETTINGS`, drawn inside the header (`Header.tsx`'s `nav`)
 * rather than on a row of its own. Volumes used to be a fourth tab; it is now the
 * fleet's second lens (`Toolbar.tsx`, `#fleet/volumes`), so the alert its badge
 * carried moved onto the Fleet badge instead: `12 · 2 loose vols`, the suffix
 * in the accent colour and present only while something is actually loose, so
 * a quiet fleet reads quiet. The dollar figure lives on the lens switch, next
 * to the thing it prices.
 *
 * Chat carries no badge of its own, and that is a decision rather than an
 * omission. The number would have to come from `chat.swarms`, which is a
 * fan-out over every box in the fleet with a timeout each — the slowest read in
 * the portal (§9.2). Paying for it on every page load so a tab can
 * show a digit is the shape of cost this view exists to avoid; the roster is
 * read when the operator opens Chat. What is waiting on an operator already
 * reaches them through the notification bell, which rides a socket that is
 * open anyway.
 */
import type { VolumeSummary } from "../api/index.ts";

export type View = "fleet" | "chat" | "settings";

export function ViewNav({
  view,
  onView,
  agentCount,
  agentCountKnown = true,
  summary,
}: {
  view: View;
  onView: (v: View) => void;
  agentCount: number;
  /** False until the fleet has been scanned once; `0` would be a lie until then. */
  agentCountKnown?: boolean;
  /** The volume inventory's summary; `null` until read, which shows no suffix. */
  summary: VolumeSummary | null;
}) {
  const loose = summary?.no_agent ?? 0;

  return (
    <nav className="viewnav" aria-label="Views">
      <button type="button" aria-pressed={view === "fleet"} onClick={() => onView("fleet")}>
        Fleet{" "}
        <span className={agentCountKnown ? "badge mono" : "badge mono pending"}>
          {agentCountKnown ? agentCount : "···"}
          {loose > 0 ? (
            <span className="viewnav-loose">
              {" "}
              · {loose} loose vol{loose === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
      </button>
      <button type="button" aria-pressed={view === "chat"} onClick={() => onView("chat")}>
        Chat
      </button>
      <button type="button" aria-pressed={view === "settings"} onClick={() => onView("settings")}>
        Settings
      </button>
    </nav>
  );
}
