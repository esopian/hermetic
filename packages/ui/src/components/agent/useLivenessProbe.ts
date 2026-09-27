/**
 * The §9 liveness probe, as the drawer runs it: one on open for a row that
 * already looks wrong, and one per click after that. Split out of
 * `AgentDrawer.tsx`; the Overview section draws the answer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { probeAgent } from "../../api/index.ts";
import type { AgentView, ProbeReport } from "../../api/index.ts";
import { probeSequencer, shouldAutoProbe } from "../../logic/liveness-logic.ts";

export function useLivenessProbe(agent: AgentView) {
  const name = agent.name;
  /** The last §9 probe for *this* name, kept across row upserts (see below). */
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [probing, setProbing] = useState(false);
  /**
   * A failed probe reports itself inside the Liveness panel rather than in the
   * shared banner: `failure` is where a reboot or a destroy says why it did
   * not happen, and a probe — which changes nothing — has no business wiping
   * that off the screen while the operator is still reading it.
   */
  const [probeError, setProbeError] = useState<string | null>(null);
  /** Which probe the panel is waiting on; see `probeSequencer`. */
  const probes = useRef(probeSequencer());

  /**
   * The row, readable from an effect that does not depend on it. The fleet
   * stream re-emits rows on every tick; an auto-probe effect that listed
   * `agent` would therefore fire on every tick, each one a five-second
   * round trip nobody asked for. Declared before the auto-probe effect so it
   * has already been refreshed by the time that one runs.
   */
  const agentRef = useRef(agent);
  useEffect(() => {
    agentRef.current = agent;
  });

  /**
   * `agents.probe` (§9): four layers asked directly, in parallel, up to ~5s.
   * Nothing is written, so it is safe to fire on open and safe to repeat; the
   * only cost is the wait, which is why the auto-probe below is narrow.
   */
  const doProbe = useCallback(async () => {
    const ticket = probes.current.begin(name);
    // Already asking this same question. The auto-probe and a click on top of
    // it are one request, not two.
    if (ticket === null) return;
    // A re-probe drops the old verdict rather than leaving five seconds of a
    // stale answer under a button that says "Probing…".
    setReport(null);
    setProbeError(null);
    setProbing(true);
    try {
      const answer = await probeAgent(name);
      if (probes.current.isCurrent(ticket)) setReport(answer);
    } catch (e) {
      // Guarded on the same ticket as the success path: an A→B switch whose
      // A-probe rejects afterwards must not put A's error under B either.
      if (probes.current.isCurrent(ticket)) {
        setProbeError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      // Only the current ticket owns `probing`; a superseded one clearing it
      // would re-enable the button underneath a request still in flight.
      if (probes.current.settle(ticket)) setProbing(false);
    }
  }, [name]);

  /**
   * One automatic probe per agent opened, and only for a row that has already
   * said something is wrong (`shouldAutoProbe`). Keyed on the name alone: the
   * report has to survive the row upserting underneath it — otherwise the SSE
   * tick that follows would wipe the answer off the screen. `focus`
   * decides whether this run is a real move (drop everything) or StrictMode
   * mounting the same effect twice (leave the in-flight probe alone).
   */
  useEffect(() => {
    if (probes.current.focus(name)) {
      setReport(null);
      setProbeError(null);
      setProbing(false);
    }
    if (shouldAutoProbe(agentRef.current, Date.now())) void doProbe();
  }, [name, doProbe]);

  return { report, probing, probeError, doProbe };
}
