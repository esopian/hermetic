/**
 * The current-step rule (`currentPhaseOf`): with start/done kinds the open
 * phase is current for as long as it is open; without them, the last phase seen.
 */
import { describe, expect, test } from "bun:test";
import {
  CREATE_PHASES,
  DESTROY_PHASES,
  RECREATE_PHASES,
  currentPhaseOf,
  labelsForOp,
  phaseLabel,
  phasesForOp,
} from "../src/lib/useOp.ts";
import type { OpEvent } from "../src/api/index.ts";

/** Every op the agent drawer can start, and therefore has to word. */
const LIFECYCLE = ["create", "destroy", "recreate", "stop", "start"] as const;

const at = "2026-09-02T22:17:53.000Z";
const e = (phase: string, kind?: "start" | "done"): OpEvent => ({
  phase,
  progress: 0.3,
  message: phase,
  at,
  ...(kind ? { kind } : {}),
});

describe("currentPhaseOf", () => {
  test("legacy streams: the last phase seen", () => {
    expect(currentPhaseOf([e("identity"), e("preflight")])).toBe("preflight");
    expect(currentPhaseOf([])).toBeNull();
  });

  test("a started phase stays current through its own progress and silence", () => {
    // The screenshot: preflight finished, foundation started, nothing for minutes.
    const events = [e("identity"), e("preflight"), e("foundation", "start")];
    expect(currentPhaseOf(events)).toBe("foundation");
    expect(currentPhaseOf([...events, e("foundation")])).toBe("foundation");
  });

  test("done closes it; a later start opens the next", () => {
    const events = [e("preflight"), e("foundation", "start"), e("foundation", "done")];
    expect(currentPhaseOf(events)).toBe("foundation");
    expect(currentPhaseOf([...events, e("tailscale")])).toBe("tailscale");
    expect(currentPhaseOf([...events, e("artifacts", "start")])).toBe("artifacts");
  });

  test("a later phase speaking closes the open one (phases are sequential)", () => {
    expect(currentPhaseOf([e("stack", "start"), e("stack"), e("ssm")])).toBe("ssm");
    expect(currentPhaseOf([e("stack", "start"), e("stack")])).toBe("stack");
  });
});

/**
 * The drawer knows an op only by the short label it started it with, and the
 * rail has to be seeded from that: an unseeded rail shows only the phases that
 * already happened, which is exactly no help while you are waiting.
 */
describe("phasesForOp", () => {
  test("create's rail includes the post-handoff wait, and ends at done", () => {
    expect(phasesForOp("create")).toBe(CREATE_PHASES);
    expect(CREATE_PHASES).toContain("handoff");
    expect(CREATE_PHASES.at(-1)).toBe("done");
  });

  test("every lifecycle op the drawer can start has a rail", () => {
    for (const label of LIFECYCLE) {
      expect(phasesForOp(label).length, label).toBeGreaterThan(0);
    }
  });

  /**
   * The tailnet sweep is a step of both (§6.5/§6.7), and an unseeded phase is
   * appended to the rail as it arrives — which put a raw `tailnet` row *below*
   * "Done" on every destroy.
   */
  test("destroy and recreate both seed the tailnet sweep, above done", () => {
    for (const phases of [DESTROY_PHASES, RECREATE_PHASES]) {
      expect(phases).toContain("tailnet");
      expect(phases.indexOf("tailnet")).toBeLessThan(phases.indexOf("done"));
    }
  });

  /** Recreate keeps its volume and uploads nothing: it never says either word. */
  test("recreate's rail carries only phases it emits", () => {
    for (const absent of ["render", "upload", "volume"]) {
      expect(RECREATE_PHASES, absent).not.toContain(absent);
    }
  });

  test("an op it does not know gets no rail rather than a wrong one", () => {
    expect(phasesForOp("")).toEqual([]);
    expect(phasesForOp("operation")).toEqual([]);
  });
});

/**
 * The rail is the only place the portal says what a step *does*, and the shared
 * table it used to read from is written in create's voice — so a destroy
 * announced "Allocate the data volume" over the step that deletes it, and
 * "Launch the EC2 instance" over the terminate. Each op now brings its own.
 */
describe("labelsForOp", () => {
  test("every seeded step is worded by its own op, never by the shared table", () => {
    for (const label of LIFECYCLE) {
      const labels = labelsForOp(label);
      for (const phase of phasesForOp(label)) {
        expect(labels[phase], `${label}/${phase}`).toBeString();
        expect(labels[phase], `${label}/${phase}`).not.toBe(phase);
      }
    }
  });

  test("destroy reads as the bootstrap in reverse: every step names what it removes", () => {
    const labels = labelsForOp("destroy");
    expect(labels["instance"]).toBe("Terminate the EC2 instance");
    expect(labels["tailnet"]).toBe("Remove the node from the tailnet");
    expect(labels["secrets"]).toContain("Delete");
    expect(labels["config"]).toContain("Remove");
    // Both paths of §6.7's default: deleted unless `--keep-volume` was asked for.
    expect(labels["volume"]).toMatch(/^Delete the data volume/);
    expect(labels["done"]).toBe("Destroyed");
  });

  test("the shared phase names mean opposite things, and are worded that way", () => {
    const create = labelsForOp("create");
    const destroy = labelsForOp("destroy");
    for (const phase of ["instance", "secrets", "volume"]) {
      expect(destroy[phase], phase).not.toBe(create[phase]);
    }
    expect(labelsForOp("stop")["instance"]).toBe("Stop the EC2 instance");
    expect(labelsForOp("start")["instance"]).toBe("Start the EC2 instance");
  });

  test("an op with no rail brings no labels, and falls back to the shared table", () => {
    expect(labelsForOp("operation")).toEqual({});
    // Which still answers for the phases the non-lifecycle ops emit.
    expect(phaseLabel("archive")).not.toBe("archive");
  });
});
