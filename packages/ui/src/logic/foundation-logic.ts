/**
 * The decisions `FoundationUpdateDrawer` makes, as pure functions.
 *
 * Same reason `teardown-logic.ts` exists: a drawer is three stages of state and
 * a `useOp` subscription, and the rules that matter — may this stage advance,
 * may this drawer close, does a stored op id mean "reattach" — are worth
 * asserting without mounting React to do it.
 */

/** The three stages of the drawer: review the plan, confirm, watch the op. */
export type FoundationStage = 1 | 2 | 3;

/**
 * `FoundationStatus`, narrowed to what these rules read. Spelled here rather
 * than imported from `api.ts` so this module stays free of the `hc` client (and
 * therefore trivially testable); `api.ts`'s inferred type is assignable to it.
 */
export interface FoundationGateStatus {
  update_available: boolean;
  tool_outdated: boolean;
  in_progress: { owner: string; expires: string } | null;
  /**
   * §8.3's Bedrock grant, with the three states core gives it. Optional on this
   * narrowed type as well as on the wire: a server build older than the field
   * simply does not send it, and that is the same "nothing recorded" answer a
   * pre-v10 fleet gives.
   */
  stale_bedrock_grants?: readonly string[] | undefined;
}

/**
 * §8.3's Bedrock grant line, as the Settings card says it.
 *
 * Three answers, because the field has three states and only two of them are
 * about staleness. A non-empty list is a model the fleet names but its instance
 * role may not invoke; an *empty* list is the comparison having been made and
 * found clean; an *absent* field is a grant nothing has recorded — an unchecked
 * policy, which rendering as `current` would report as a checked one.
 *
 * The wording is `bedrockGrantLine` in `packages/cli/src/commands/foundation.ts`
 * transposed into this head's remedy: the CLI names the command, and here the
 * button that runs it is directly below. Copied rather than imported, because
 * the UI may not reach into core or the CLI (§3.1) — `foundation.test.ts` is
 * what keeps the two saying the same thing.
 */
export function bedrockGrantLine(stale: readonly string[] | undefined): {
  text: string;
  warn: boolean;
} {
  if (stale === undefined) return { text: "not recorded — run a foundation update", warn: true };
  if (stale.length === 0) return { text: "current", warn: false };
  return { text: `stale: ${stale.join(", ")} — run a foundation update`, warn: true };
}

/**
 * Whether the grant alone is reason to run an update, with the version current.
 *
 * It is: the update is what *records* the grant as well as what reconciles it,
 * so both "stale" and "not recorded" are fixed by the same button — and a
 * button disabled because `update_available` is false would leave an operator
 * reading "stale" above an action they cannot take.
 */
export function grantNeedsUpdate(stale: readonly string[] | undefined): boolean {
  return stale === undefined || stale.length > 0;
}

/**
 * `FoundationStatus["hermes"]`, narrowed to what the Settings card reads. Same
 * reason `FoundationGateStatus` is spelled here: this module must stay free of
 * the `hc` client so it is testable without one.
 */
export interface HermesAdvisory {
  pinned: string;
  pinned_ref: string;
  latest: string | null;
  update_available: boolean;
  checked_at: string | null;
  error: string | null;
}

/**
 * §6.6's advisory Hermes line, as the Settings card shows it.
 *
 * Three states, and the difference between the last two is the point: "up to
 * date" is a fact hermetic checked, and "could not check" is hermetic admitting
 * it does not know. Rendering a failed check as "up to date" would be the one
 * way this feature could actively mislead — an operator who reads a green line
 * while GitHub has been rate-limiting the portal for a month.
 *
 * `alert` is deliberately not tied to `foundation.update_available`: bumping
 * Hermes is a per-agent `hermetic upgrade --hermes`, which no button in this
 * card runs, so the badge is a notice rather than an offer.
 */
export function hermesLine(hermes: HermesAdvisory | null | undefined): {
  pinned: string;
  detail: string;
  alert: boolean;
  hint: string | null;
} {
  if (!hermes) {
    return { pinned: "—", detail: "not checked by this server build", alert: false, hint: null };
  }
  const pinned = `${hermes.pinned} (${hermes.pinned_ref})`;
  if (hermes.latest === null) {
    return {
      pinned,
      detail: `could not check — ${hermes.error ?? "no reason given"}`,
      alert: false,
      hint: null,
    };
  }
  if (hermes.error !== null) {
    return {
      pinned,
      detail: `upstream is ${hermes.latest} — could not compare (${hermes.error})`,
      alert: false,
      hint: null,
    };
  }
  if (!hermes.update_available) {
    return { pinned, detail: `upstream is ${hermes.latest} — up to date`, alert: false, hint: null };
  }
  return {
    pinned,
    detail: `upstream is ${hermes.latest}`,
    alert: true,
    /**
     * Both halves, because the flag alone would not do it: `--hermes` pins the
     * version the box must *report*, while the tag it checks out comes from
     * `BUILD_VERSIONS.hermes_ref`, which no flag moves (§6.6). And one agent
     * first, because the operator chooses which one goes first — this card has
     * no button that runs any of it, deliberately.
     */
    hint: `set BUILD_VERSIONS.hermes/hermes_ref to ${hermes.latest}, then \`hermetic upgrade <name> --hermes <version>\` — one agent first`,
  };
}

/**
 * What a stored op id means on mount. A drawer reopened while its op is still
 * running (or just after it finished) reattaches to the stream instead of
 * restarting at stage 1 — and must *not* fetch a plan, because
 * `plan.foundation` asks CloudFormation to compute a real change set against a
 * stack that is mid-update, which the server now refuses with 409 anyway.
 */
export function reattach(storedOpId: string | null): {
  stage: FoundationStage;
  opId: string | null;
  loadPlan: boolean;
} {
  if (storedOpId) return { stage: 3, opId: storedOpId, loadPlan: false };
  return { stage: 1, opId: null, loadPlan: true };
}

/**
 * Closing stage 3 mid-op would discard the only view of it. The op id is in
 * sessionStorage either way, so nothing is lost permanently — but "I pressed
 * Esc and the update vanished" is not a thing this drawer should be able to do.
 */
export function closeBlocked(input: { stage: FoundationStage; running: boolean }): boolean {
  return input.stage === 3 && input.running;
}

export interface ContinueGate {
  allowed: boolean;
  /** Why not, in the operator's words. `null` when allowed. */
  reason: string | null;
}

/**
 * Whether stage 1 may advance to stage 2.
 *
 * This repeats the gate on Settings' own "Update foundation…" button on
 * purpose. That button is disabled from a `/api/meta` snapshot taken when the
 * page loaded, and the drawer can be reached without it — the EnvStrip pill
 * opens it directly — so a foundation that became up to date, or that another
 * operator started updating, has to be caught here too, against a `refreshMeta`
 * that is at most a moment old.
 *
 * A `null` status is *not* a refusal: the server could not read `_fleet`, the
 * plan itself succeeded, and core's own preflight is the real gate. Blocking on
 * a missing courtesy read would make a broken status endpoint a broken update.
 */
export function continueGate(input: {
  planLoading: boolean;
  planError: string | null;
  hasPlan: boolean;
  foundation: FoundationGateStatus | null;
}): ContinueGate {
  if (input.planLoading) return { allowed: false, reason: "reading the plan…" };
  if (input.planError !== null || !input.hasPlan) {
    return { allowed: false, reason: "the plan could not be read" };
  }
  const f = input.foundation;
  if (!f) return { allowed: true, reason: null };
  if (f.in_progress) {
    return {
      allowed: false,
      reason: `a foundation update is already running (locked by ${f.in_progress.owner} until ${f.in_progress.expires})`,
    };
  }
  if (f.tool_outdated) {
    return {
      allowed: false,
      reason: "this hermetic build is older than the fleet's foundation; upgrade hermetic",
    };
  }
  // The grant is the second reason to update, and it is independent of the
  // version: a fleet on the current foundation can still name a Bedrock model
  // its instance role may not invoke, or record no grant at all. Refusing here
  // would disagree with the enabled button that opened this drawer.
  if (!f.update_available && !grantNeedsUpdate(f.stale_bedrock_grants)) {
    return { allowed: false, reason: "the foundation is already up to date" };
  }
  return { allowed: true, reason: null };
}

/**
 * `Plan["release"]`, narrowed the way every other view type in this module is —
 * structurally, so this file stays free of the `hc` client.
 */
export interface ReleaseView {
  published_version: string | null;
  published_build: string | null;
  local_version: string;
  local_build: string | null;
  published_build_number?: number | null;
  local_build_number?: number | null;
  published_commit?: string | null;
  local_commit?: string | null;
  drift: string | null;
}

/**
 * The drawer's `hermeticd` line: the two versions, and what — if anything — is
 * true about them that the versions do not say.
 *
 * This exists because of a specific bug report: an operator changed the
 * hermeticd binary, opened this drawer, and read `hermeticd 0.5.0 → 0.5.0`.
 * Nothing was wrong with the push — the release shipped and the boxes took it —
 * but the line could not have said so. Both sides of it are
 * `BUILD_VERSIONS.hermeticd`, a constant that moves only when somebody edits it
 * by hand, so after any update from this build they are equal by construction.
 *
 * `note` is therefore the load-bearing half, and it has three states rather
 * than two. A *changed build at the same version* is the answer the operator
 * was looking for. "Cannot tell" — neither side stamped a build, or no manifest
 * is published — is said out loud rather than rendered as agreement, which is
 * the mistake the version line was already making. Only a genuine match is
 * silent.
 */
export function hermeticdLine(
  release: ReleaseView | null | undefined,
  fallback: { from: string | null; to: string | null },
  /**
   * Where the plan that carries `release` has got to.
   *
   * It is a parameter because the summary line renders the moment the drawer
   * opens, while the plan is still being fetched — and in that window `release`
   * is `null` for a reason that has nothing to do with the fleet. Without this,
   * the line spent the first second or so looking exactly like the old
   * uninformative one, and an operator who read it then would have taken "no
   * note" for "nothing to report". That is the same mistake as everything else
   * this line was rewritten to stop making: absence is not agreement.
   */
  state: "loading" | "error" | "ready" = "ready",
): {
  from: string;
  to: string;
  /**
   * The short build fingerprint beside each version, or `null` where that side
   * did not stamp one.
   *
   * These are the halves that actually differ. The two versions are read from
   * the two places an operator expects — `from` is the release the fleet
   * manifest in S3 names, `to` is what this build would push — but the string
   * itself is `BUILD_VERSIONS.hermeticd`, a constant somebody edits by hand, so
   * it reads the same on both sides until somebody edits it. The fingerprint is
   * derived from the sources the binary was compiled from, so it moves whenever
   * the binary does, which is the comparison the line is actually being asked
   * to make.
   */
  fromBuild: string | null;
  toBuild: string | null;
  note: string | null;
  warn: boolean;
} {
  const from = release?.published_version ?? fallback.from ?? "—";
  const to = release?.local_version ?? fallback.to ?? "—";
  /**
   * What identifies each side, in the most legible form available.
   *
   * `build 36` when the checkout could count commits, because a number is
   * *orderable* and a digest is not: `build 35 → build 36` says which way round
   * the two releases sit, and `a1b2c3d4 → e5f6a7b8` only ever says "not the
   * same". The fingerprint is the fallback for releases that carry no number —
   * pushed from a built binary, a tarball, a shallow clone, or by
   * `upgrade --hermeticd` pointing at another laptop.
   */
  const label = (build: string | null | undefined, number: number | null | undefined): string | null =>
    number ? `build ${number}` : build ? build.slice(0, 8) : null;
  const builds = {
    fromBuild: label(release?.published_build, release?.published_build_number),
    toBuild: label(release?.local_build, release?.local_build_number),
  };
  const bare = { fromBuild: null, toBuild: null };
  if (state === "loading") return { from, to, ...bare, note: "· checking…", warn: false };
  if (state === "error") {
    return { from, to, ...bare, note: "· could not check whether the binary changed", warn: false };
  }
  // A plan from an older hermetic carries no `release` block at all. Nothing can
  // be said, so nothing is claimed.
  if (!release) return { from, to, ...bare, note: "· this server cannot tell", warn: false };
  /**
   * With a number on both sides the line can say which *direction* the two
   * releases sit in, which is the question two people sharing a fleet actually
   * have. A digest comparison cannot reach any of these three answers.
   */
  const published = release.published_build_number ?? null;
  const local = release.local_build_number ?? null;
  /**
   * Whether the two builds are *known to agree*, which is not what
   * `drift === null` means.
   *
   * `releaseDrift` returns `null` for four different reasons — no published
   * manifest, either side unstamped, differing versions, or genuine agreement —
   * and only the last is "same binary". Reading the other three as agreement is
   * the mistake this whole line exists to stop making, and it had a date: the
   * first update after a version bump has `0.5.0` published against `0.5.1`
   * local, which `releaseDrift` skips as "the version already says it", and
   * which would otherwise have printed "same binary" about a binary that is
   * certainly different — the version is compiled into it.
   */
  const sameBinary =
    release.drift === null &&
    release.published_build !== null &&
    release.local_build !== null &&
    release.published_version === release.local_version;
  if (published !== null && local !== null) {
    if (local < published) {
      // The dangerous one, and the only reason this is a warning rather than a
      // remark: pushing would move the fleet *backwards* onto older code, and
      // the version string is identical on both sides, so nothing else on this
      // screen would say so.
      return {
        from,
        to,
        ...builds,
        note: "\u26a0 this checkout is behind the fleet — pull before pushing",
        warn: true,
      };
    }
    if (local > published) {
      // Newer commits that touch nothing hermeticd ships — a docs change, a CLI
      // fix — move the number and not the binary. Worth saying out loud, or an
      // operator reads a moving number as pending work for the fleet.
      if (sameBinary) {
        return { from, to, ...builds, note: "· newer commit, same binary", warn: false };
      }
      // Either a known change, or one of the several ways of not knowing. The
      // second must not borrow the first's confidence in either direction.
      return release.drift !== null
        ? { from, to, ...builds, note: "\u26a0 the binary changed", warn: true }
        : {
            from,
            to,
            ...builds,
            note: "· newer commit, cannot tell if the binary changed",
            warn: false,
          };
    }
    /**
     * Equal numbers, and the same commit: only reachable through
     * `HERMETIC_ALLOW_DIRTY`, which is exactly the state that flag warns it
     * creates — a release nobody can rebuild from the commit it names.
     *
     * The commit is checked and not just the number, because `rev-list --count`
     * is equal for two *sibling* branches one commit off the same base. Accusing
     * a colleague of a dirty push because their branch is the same depth as
     * yours is a false accusation the number alone cannot avoid.
     */
    const sameCommit =
      release.published_commit != null &&
      release.local_commit != null &&
      release.published_commit === release.local_commit;
    if (release.drift !== null && sameCommit) {
      return {
        from,
        to,
        ...builds,
        note: "\u26a0 same commit, different binary — one side was pushed from a dirty tree",
        warn: true,
      };
    }
    if (release.drift !== null) {
      // Same depth, different commits: two branches off one base. The binary
      // differs and neither side is ahead, which is a thing to say plainly
      // rather than to blame on anybody.
      return { from, to, ...builds, note: "⚠ a different commit at the same depth", warn: true };
    }
    return {
      from,
      to,
      ...builds,
      note: sameBinary ? null : "· cannot tell if the binary changed",
      warn: false,
    };
  }

  if (release.drift !== null) {
    // Short, because the two fingerprints are now on the line either side of the
    // arrow, and the plan carries the full sentence in `warnings` below.
    return { from, to, ...builds, note: "⚠ the binary changed", warn: true };
  }
  if (release.published_version === null) {
    return {
      from,
      to,
      ...builds,
      note: "· this fleet has no published release to compare",
      warn: false,
    };
  }
  if (release.published_build === null || release.local_build === null) {
    return { from, to, ...builds, note: "· cannot tell whether the binary changed", warn: false };
  }
  return { from, to, ...builds, note: null, warn: false };
}
