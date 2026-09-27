/**
 * What the portal says when the fleet and this build disagree (§6.6), as pure
 * functions.
 *
 * The sentence itself is core's (`SKEW_MESSAGE`, carried on the wire as
 * `skew.message`) and is deliberately not rewritten here: the band, the CLI's
 * stderr warning and the Settings section are the same words about the same
 * fleet, and a head with its own copy of them would drift from the others the
 * first time one changed. What this module owns is everything around that
 * sentence — which tone it is drawn in, whether it may be dismissed, what the
 * marks beside individual version numbers say, and which agents a drawer's band
 * is about.
 *
 * Same reason `foundation-logic.ts` and `settings-logic.ts` are pure: these are
 * rules worth asserting without mounting React, and the types are spelled here
 * structurally rather than imported from `api.ts` so the module stays free of
 * the `hc` client (`api.ts`'s inferred types are assignable to them).
 */

/** Mirrors core's `SkewSeverity`; pinned by `test/skew-logic.test.ts`. */
export type SkewSeverity = "none" | "pending" | "degraded" | "blocked";

/** Mirrors core's `ConfigVerdict`. */
export type ConfigVerdict = "current" | "drifted" | "unknown";

/** `FoundationStatus["skew"]`, narrowed to what these rules read. */
export interface SkewView {
  severity: SkewSeverity;
  headline: string;
  message: string;
  fleet_version: number;
  expected_version: number;
  agents_behind: number;
  agents_drifted: number;
  agents_affected: number;
  fix: string | null;
}

/** One row of `FoundationStatus["agents"]`, narrowed the same way. */
export interface SkewAgentView {
  name: string;
  /**
   * Mirrors core's tri-state: `null` is "this box has reported no version",
   * which is neither current nor behind. Every reader below tests `=== false`
   * rather than `!current`, because the boolean shape is what made a stopped or
   * still-booting agent render as out of date.
   */
  current: boolean | null;
  /**
   * Optional for the same reason it is optional on the wire: a status served by
   * a build that does not compute the verdict carries none, and absence reads
   * as `unknown` rather than as agreement (`configLabel`).
   */
  config?: ConfigVerdict | undefined;
  hermeticd_version: string | null;
}

/** `FoundationStatus`, narrowed to the three fields the band needs. */
export interface SkewStatusView {
  skew?: SkewView | null;
  agents?: readonly SkewAgentView[];
  available?: { hermeticd_version: string } | null;
}

/**
 * What a band is drawn as. `tone` is the class suffix rather than a colour so
 * the stylesheet keeps the palette; the three values line up with core's
 * severities minus `none`, which renders no band at all.
 */
export type BandTone = "warn" | "bad" | "muted";

export interface Band {
  tone: BandTone;
  /** The short bold line: what is wrong, in the fewest words that are still true. */
  headline: string;
  /** Core's generic sentence, verbatim. */
  message: string;
  /** The CLI command that resolves it, or `null` when no command does. */
  fix: string | null;
  /**
   * Whether the operator may put it away for this session. `blocked` may not
   * be: it means writes will be refused, and an operator who dismissed it would
   * meet it again as a failed command instead of as a warning.
   */
  dismissible: boolean;
}

const TONE: Record<Exclude<SkewSeverity, "none">, BandTone> = {
  blocked: "bad",
  degraded: "warn",
  pending: "muted",
};

/**
 * The fleet-wide band, or `null` when there is nothing to say.
 *
 * `null` is also the answer when the server did not report a skew at all — an
 * older server, or a `/api/meta` whose `_fleet` read failed. A head that
 * guessed in that gap would either invent a warning or suppress a real one, and
 * the version numbers it would have to guess from are exactly what it does not
 * have.
 */
export function fleetBand(status: SkewStatusView | null | undefined): Band | null {
  const skew = status?.skew;
  if (!skew || skew.severity === "none") return null;
  const affected =
    skew.agents_affected === 0
      ? ""
      : ` · ${skew.agents_affected} agent${skew.agents_affected === 1 ? "" : "s"} affected`;
  return {
    tone: TONE[skew.severity],
    headline:
      skew.severity === "blocked"
        ? `This fleet is ahead of your hermetic build${affected}`
        : skew.severity === "degraded"
          ? `This fleet is behind your hermetic build${affected}`
          : `Agents are catching up${affected}`,
    message: skew.message,
    fix: skew.fix,
    dismissible: skew.severity !== "blocked",
  };
}

/**
 * The band inside one agent's drawer, or `null`.
 *
 * Narrower than the fleet band in what it claims and wider in when it appears:
 * an agent on a current fleet can still be holding a config nothing rendered
 * for it, which is a per-agent fact the fleet band would be wrong to state.
 */
export function agentBand(
  status: SkewStatusView | null | undefined,
  name: string,
): (Band & { stale: readonly string[] }) | null {
  const base = fleetBand(status);
  const row = status?.agents?.find((a) => a.name === name) ?? null;
  /**
   * What is out of date about *this box*, named rather than counted.
   *
   * This used to be a number — "2 of 4 axes behind" — and the number was wrong
   * twice over: the denominator counted Hermes, which §6.6 keeps out of the
   * skew on purpose and which therefore can never be one of the things behind,
   * and the numerator folded the fleet's two disagreements (foundation
   * contract, fleet-wide release) into a single point. It could never reach 4,
   * and nothing an operator could do followed from whether it read 2 or 3.
   * Naming the parts costs the same line and says what to look at.
   */
  const stale = [
    ...(row?.current === false ? ["its hermeticd release"] : []),
    ...(row?.config === "drifted" ? ["its config"] : []),
  ];
  if (!base && stale.length === 0) return null;
  if (!base) {
    // The fleet is current; this agent alone has not caught up. That resolves
    // itself, so it is stated in the quiet tone whatever else is true of it.
    return {
      tone: "muted",
      headline: "This agent has not caught up with the fleet",
      message: "it re-applies on its own; nothing to do here",
      fix: null,
      dismissible: false,
      stale,
    };
  }
  /**
   * The fleet half of the headline, keyed on severity rather than on tone.
   *
   * `pending` and `degraded` share a tone and are opposite facts: `pending`
   * means the fleet is *current* and its agents have not finished taking the
   * release, while `degraded` means the fleet itself is behind this build. The
   * drawer used to read tone alone and so told an operator looking at a
   * perfectly current fleet that it "was built by an older hermetic" — the one
   * claim on the band, and false.
   */
  const fleetHalf =
    status?.skew?.severity === "blocked"
      ? "This fleet is ahead of your hermetic build"
      : status?.skew?.severity === "pending"
        ? "Agents are still taking the new release"
        : "This fleet was built by an older hermetic";
  return {
    ...base,
    headline:
      // `blocked` is the one severity with nothing per-agent to add: the fix is
      // to upgrade hermetic, and what this box is running does not change that.
      status?.skew?.severity === "blocked" || stale.length === 0
        ? fleetHalf
        : `${fleetHalf} · this agent is behind on ${list(stale)}`,
    // Per-agent bands are never dismissible: the drawer was opened
    // deliberately, and it closes on its own.
    dismissible: false,
    stale,
  };
}

/** `a`, `a and b`, `a, b and c` — a list an operator reads rather than parses. */
function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The suffix that qualifies a version already on screen, or `null` when the
 * value needs no qualifying.
 *
 * Always on, even when the band has been dismissed: a mark is part of the value
 * rather than an alert about it, and an operator reading `v1` should never have
 * to remember whether this build wanted something else.
 */
export function foundationMark(status: SkewStatusView | null | undefined): string | null {
  const skew = status?.skew;
  if (!skew || skew.severity === "none") return null;
  if (skew.fleet_version === skew.expected_version) return null;
  return skew.severity === "blocked"
    ? `⚠ this build only knows v${skew.expected_version}`
    : `⚠ this build expects v${skew.expected_version}`;
}

/** The same, for one agent's hermeticd release. */
export function hermeticdMark(status: SkewStatusView | null | undefined, name: string): string | null {
  const row = status?.agents?.find((a) => a.name === name);
  const expected = status?.available?.hermeticd_version;
  // `=== false` and not `!row.current`: a box that has reported no version at
  // all gets no mark, because there is nothing to qualify. Marking it would say
  // "this agent is behind" about a machine that has not spoken.
  if (row?.current !== false || !expected) return null;
  return `⚠ fleet points at ${expected}`;
}

/** How a config verdict reads in a table cell: label plus whether it is a warning. */
export function configLabel(verdict: ConfigVerdict | null | undefined): {
  label: string;
  warn: boolean;
} {
  if (verdict === "drifted") return { label: "drifted", warn: true };
  if (verdict === "current") return { label: "current", warn: false };
  // Not "current", and not a warning either: an agent that has never reported
  // an applied config is not known to be either, and both other answers would
  // be inventing one.
  return { label: "unknown", warn: false };
}

/**
 * The config line in the agent drawer: which hash to *show*, and what to say
 * about it.
 *
 * The rule that matters is the `unknown` branch. The drawer used to render
 * `applied_config_hash ?? config_hash`, so a box that has never reported an
 * applied config was shown the hash the *fleet rendered* — with the fact that
 * nothing had confirmed it reduced to a dim `· unknown` beside a plausible
 * sixty-four character hex string. That is the one shape this panel must not
 * take: `configVerdict` goes out of its way to answer `unknown` rather than
 * invent a fact, and the display then invented one anyway.
 *
 * So: show a hash only when a box has reported one. Otherwise show nothing in
 * the value slot and name the rendered hash in the note, where it reads as what
 * it is — what this build would apply, not what any box has applied.
 */
export function configHashView(
  agent: { config_hash?: string | null; applied_config_hash?: string | null },
  verdict: ConfigVerdict | null | undefined,
): { value: string; note: string; warn: boolean } {
  const applied = agent.applied_config_hash ?? null;
  const desired = agent.config_hash ?? null;
  if (verdict === "drifted" && applied !== null) {
    return {
      value: applied,
      note: `⚠ this build renders ${desired ?? "a different config"}`,
      warn: true,
    };
  }
  if (applied !== null) return { value: applied, note: `· ${configLabel(verdict).label}`, warn: false };
  return {
    value: "—",
    note: desired === null ? "· not reported" : `· not reported; this build renders ${desired}`,
    warn: false,
  };
}

/** One agent's config verdict, for the rows that show it. */
export function configOf(
  status: SkewStatusView | null | undefined,
  name: string,
): ConfigVerdict | null {
  return status?.agents?.find((a) => a.name === name)?.config ?? null;
}

/**
 * The key a dismissal is remembered under, for one session.
 *
 * Keyed by fleet *and* severity so that neither a fleet switch nor a skew
 * getting worse is hidden by a dismissal of something else — putting away
 * "degraded" on `main` must not silence "blocked" on `staging`.
 */
export function dismissKey(fleet: string | null | undefined, severity: SkewSeverity): string {
  return `hermetic.skew.${fleet ?? "-"}.${severity}`;
}

/**
 * The Hermes line: the version pinned on the row, and — when the box has said
 * something different — what it is actually running.
 *
 * `hermes_version` is a pin a laptop wrote. `upgrade --hermes` moves it and
 * says in its own event text that the change "takes effect on the next
 * recreate", so between the two the row names a version no box is running, and
 * this line used to render that pin alone as fact. `running_hermes_version` is
 * the box's own answer, read out of Hermes's `/api/health`.
 *
 * Deliberately never a warning. §6.6 keeps Hermes out of the skew on
 * purpose — bumping it is a manual, per-agent decision that no update applies —
 * so a pin ahead of reality is a *pending recreate*, not drift, and dressing it
 * in an alert colour would teach an operator to ignore the colour. Silence when
 * the two agree, and silence when the box has not said: absence is unknown, and
 * unknown is not a discrepancy.
 */
export function hermesRunningNote(agent: {
  hermes_version?: string | null;
  running_hermes_version?: string | null;
}): string | null {
  const pinned = agent.hermes_version ?? null;
  const running = agent.running_hermes_version ?? null;
  if (running === null || pinned === null || running === pinned) return null;
  return `· running ${running}`;
}
