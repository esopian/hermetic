/** The create drawer after submit: the op's own progress, and a way out. */
import { SAFE_TO_CLOSE } from "../../logic/op-hints.ts";
import type { useOp } from "../../lib/useOp.ts";
import { OpProgress } from "../OpProgress.tsx";
import type { CreateOp } from "./types.ts";

export function CreateProgress({
  active,
  op,
  onClose,
}: {
  active: CreateOp;
  op: ReturnType<typeof useOp>;
  onClose: () => void;
}) {
  const done = op.finished;
  return (
    <>
      <OpProgress title={active.name} sub={active.sub} op={op} />
      <div className="progress-foot">
        <div className="t">
          {done
            ? "The instance reports the rest of its bootstrap over the heartbeat."
            : `${SAFE_TO_CLOSE} and the row keeps updating.`}
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          style={{
            height: 48,
            padding: "0 22px",
            fontWeight: 900,
            background: done ? "var(--fg)" : "transparent",
            color: done ? "var(--bg)" : "var(--fg)",
          }}
          onClick={onClose}
        >
          {done ? "Back to fleet" : "Run in background"}
        </button>
      </div>
    </>
  );
}
