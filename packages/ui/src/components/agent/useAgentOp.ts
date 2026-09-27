/**
 * The op this drawer is showing progress for, and the rail that shows it.
 *
 * Split out of `AgentDrawer.tsx`: everything about *which* op the rail is
 * attached to — re-attaching on open, marking it live, the hold-then-fade exit
 * — lives here, and the drawer only draws what comes back. `accept` is how an
 * action the drawer just started becomes the rail's op.
 */
import { useEffect, useRef, useState } from "react";
import { listOps } from "../../api/index.ts";
import { failureHints, railFades, railNotes } from "../../logic/op-hints.ts";
import { labelsForOp, phasesForOp, useOp } from "../../lib/useOp.ts";

interface RunningOp {
  opId: string;
  label: string;
  /**
   * The registry said this op was running while this drawer was open — either
   * because we started it, or because `GET /api/ops?status=running` confirmed
   * it. A `runningOpId` handed down by the parent is only a belief: it survives
   * the drawer being closed, so it can name an op that finished in the
   * meantime. Only a live op gets a progress rail (§6.3); a finished one has no
   * progress left to show.
   */
  live: boolean;
}

/** How long a completed rail stays up, and how long it takes to fade. */
const RAIL_HOLD_MS = 1000;
export const RAIL_FADE_MS = 300;

export function useAgentOp({
  name,
  status,
  runningOpId,
  onOp,
  onFinished,
}: {
  name: string;
  /** The row's `display_status`, which the failure hints are worded against. */
  status: string;
  runningOpId: string | null;
  onOp: (name: string, opId: string | null) => void;
  /** Called once when the op finishes, before the parent is told it is over. */
  onFinished: () => void;
}) {
  const [op, setOpLocal] = useState<RunningOp | null>(
    runningOpId ? { opId: runningOpId, label: "operation", live: false } : null,
  );
  /** Which `runningOpId` (or agent, when there is none) we have already asked the registry about. */
  const probed = useRef<string | null>(null);
  /** The completed rail's exit: shown → fading (300ms) → gone. */
  const [rail, setRail] = useState<"shown" | "fading" | "gone">("shown");

  // Seeded with the phases the op will run, not just the ones it already has:
  // the step list below the bar is the "what is it doing" the bare percentage
  // never answered — and with that op's own wording for them, since `instance`
  // and `secrets` mean opposite things on a create and on a destroy.
  const opLabel = op?.label ?? "";
  const opState = useOp(op?.opId ?? null, phasesForOp(opLabel), labelsForOp(opLabel));
  /** A finished op that failed, and therefore has a reason worth showing. */
  const opFailure = opState.finished && !opState.ok ? opState.error : null;

  /**
   * Re-attach on open: an op the engine is still running outlives this tab, so
   * the drawer asks the registry for it rather than trusting session memory.
   * The same answer is what makes an op `live`: an id the parent still holds
   * for an op that ended while the drawer was closed is not in the running
   * list, so its rail never opens.
   */
  useEffect(() => {
    if (runningOpId) {
      setOpLocal((prev) =>
        prev?.opId === runningOpId ? prev : { opId: runningOpId, label: "operation", live: false },
      );
    }
    const key = `${name}:${runningOpId ?? "none"}`;
    if (probed.current === key) return;
    probed.current = key;
    let alive = true;
    listOps({ target: name, status: "running" })
      .then((running) => {
        const found = runningOpId ? running.find((o) => o.id === runningOpId) : running[0];
        if (!alive || !found) return;
        setOpLocal({ opId: found.id, label: found.method.replace(/^agents\./, ""), live: true });
        onOp(name, found.id);
      })
      .catch(() => {
        /* no registry answer just means no progress bar */
      });
    return () => {
      alive = false;
    };
  }, [runningOpId, name, onOp]);

  /** A new op re-opens the rail the last one faded out of. */
  useEffect(() => {
    setRail("shown");
  }, [op?.opId]);

  /**
   * What the rail is still saying now the op has stopped: the terminal
   * warnings, plus the terminal message itself — which for `upgrade` is "it
   * takes effect on the next recreate", the entire answer to "did that change
   * anything yet", and an ordinary info line that no warning filter would ever
   * catch.
   */
  const railNoteLines = railNotes(
    opState.events,
    opState.finished,
    opFailure ? failureHints(opFailure.code, op?.label ?? "operation", name, status) : [],
  );

  /**
   * A rail whose every step is done and which has nothing left to say holds for
   * a beat and fades, instead of sitting there as a wall of green. A rail that
   * *is* still saying something does not: fading it deleted the one line the
   * operator pressed the button to read, about a second after it appeared. Only
   * a rail the operator was actually watching gets the exit — one that was
   * already complete on open was never rendered.
   */
  const railComplete = railFades({
    live: op?.live === true,
    finished: opState.finished,
    ok: opState.ok,
    notes: railNoteLines,
  });
  useEffect(() => {
    if (!railComplete) return;
    const fade = setTimeout(() => setRail("fading"), RAIL_HOLD_MS);
    const drop = setTimeout(() => setRail("gone"), RAIL_HOLD_MS + RAIL_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(drop);
    };
  }, [railComplete]);

  const showRail = op?.live && rail !== "gone";

  useEffect(() => {
    if (opState.finished) {
      onFinished();
      onOp(name, null);
    }
  }, [opState.finished, onFinished, name, onOp]);

  /** An op the drawer just started: it is live by definition, and the registry need not be asked. */
  const accept = (opId: string, label: string) => {
    probed.current = `${name}:${opId}`;
    setOpLocal({ opId, label, live: true });
    onOp(name, opId);
  };

  return { op, opState, opFailure, rail, showRail, accept };
}
