/**
 * The create drawer's sticky footer: what the whole machine costs, the command
 * that would make the same agent, and Create.
 *
 * The CLI line is built from the same form as the request (`createCliLine`), so
 * a flag appears here exactly when its field is on the wire.
 */
import { fmtUsd } from "../../logic/format.ts";
import { HOURS_PER_MONTH } from "../../logic/create-presets.ts";
import type { CreateFormModel } from "./useCreateForm.ts";

export function CreateFooter({ f, onClose }: { f: CreateFormModel; onClose: () => void }) {
  const sub =
    f.monthly === null
      ? "part of it is a fleet default the portal could not read"
      : f.changes > 0 && f.preset !== null
        ? `~$${(f.monthly / HOURS_PER_MONTH).toFixed(2)}/h · ${f.changes} change${f.changes === 1 ? "" : "s"} from ${f.preset.name}`
        : `~$${(f.monthly / HOURS_PER_MONTH).toFixed(2)}/h · ready in ~8 min`;
  return (
    <div className="drawer-foot cr-foot">
      <div className="cr-cli mono" title={f.cli}>
        <span className="dim">$</span> {f.cli}
      </div>
      <div className="cr-cost">
        <span className="kicker">Total</span>
        <b data-testid="create-total">
          {f.monthly === null ? "fleet default" : `≈${fmtUsd(f.monthly)}`}
          {f.monthly === null ? null : <small>/mo</small>}
        </b>
        <span className="mono cr-cost-sub">{sub}</span>
      </div>
      <div className="cr-foot-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary cr-create"
          disabled={f.disabled}
          onClick={() => void f.submit()}
        >
          Create agent →
        </button>
      </div>
    </div>
  );
}
