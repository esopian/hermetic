/**
 * `foundation.status` (§6.6) and the advisory upstream-Hermes check it carries.
 */
import { FLEET_KEY } from "../../schema/index.ts";
import type { FoundationStatus, HermesUpstream } from "../../schema/index.ts";
import { staleBedrockGrants } from "../../profiles/bedrock-grants.ts";
import {
  ADVISORY_BEDROCK_GRANT,
  ADVISORY_FOUNDATION_UPDATE,
  bedrockGrantAdvisories,
  foundationUpdateAdvisories,
  observeAdvisories,
} from "../../chat/notifications.ts";
import { settingsOf } from "../../profiles/settings.ts";
import { HermeticError } from "../../errors.ts";
import { computeSkew, configVerdict } from "../skew.ts";
import type { FoundationCtx } from "./shared.ts";
import { BUILD_VERSIONS } from "../../build-versions.ts";

/**
 * Where the advisory Hermes check looks (§6.6). Unauthenticated, and therefore
 * rate-limited by GitHub to 60 requests an hour per IP — which is the whole
 * reason for the cache below and for the fact that nothing polls this on a
 * timer. It is a courtesy read, not a fleet fact.
 */
const HERMES_RELEASES_URL = "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest";

/**
 * The ceiling on how long a `foundation.status` may be delayed by the check.
 * A status read sits behind an HTTP GET and in front of a CLI command; an
 * upstream that is slow, wedged behind a VPN or simply unreachable must cost
 * this and no more, after which the answer is "could not check".
 */
const HERMES_CHECK_TIMEOUT_MS = 5_000;

/**
 * How long one answer is reused. Upstream tags a release every few weeks, the
 * operator acts on it by hand, and the portal re-reads `/api/meta` every time
 * Settings is opened — so re-asking GitHub per read would spend the whole
 * unauthenticated rate limit to learn the same number.
 */
const HERMES_CACHE_TTL_MS = 6 * 60 * 60_000;

/**
 * A release tag reduced to something orderable, or `null` if it is not.
 *
 * Accepted: an optional leading `v`, then exactly three numeric fields. That
 * covers both spellings this code has to handle — upstream Hermes's date tags
 * (`v2026.8.31`) and an ordinary semver (`0.21.0`) — and rejects everything
 * else, which is the point. A release candidate, a `-rc1` suffix, a two-field
 * tag or a name with words in it is a tag whose position in the sequence
 * hermetic cannot honestly assert, and guessing at one would be how an operator
 * ends up pinning an agent to a pre-release nobody chose.
 */
export function normaliseReleaseTag(tag: string): string | null {
  const stripped = tag.trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(stripped) ? stripped : null;
}

/**
 * Order two normalised tags field by field, numerically: negative when `a` is
 * older, 0 when they are the same release, positive when `a` is newer.
 *
 * Numeric, not lexicographic, for the reason `compareVersions` is: `0.10.0` is
 * newer than `0.9.0`, and `2026.9.4` is newer than `2026.8.31`. It is a
 * separate function from `compareVersions` because it deliberately has no
 * pre-release handling at all — `normaliseReleaseTag` has already refused
 * anything with a suffix, so there is nothing here to get wrong.
 */
export function compareReleaseTags(a: string, b: string): number {
  const left = a.split(".").map((n) => Number.parseInt(n, 10));
  const right = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function createStatus(ctx: FoundationCtx) {
  const {
    deps,
    core,
    backend,
    hermeticdVersion,
    nowIso,
    versionOf,
    lockIsLive,
    foundationVersion,
    templateSha256,
  } = ctx;

  // ─── the advisory Hermes check ─────────────────────────────────────────────

  /**
   * One answer, reused for `HERMES_CACHE_TTL_MS`, and one in-flight request
   * shared by everyone who asks while it is running. The portal is long-lived
   * and re-reads `/api/meta` on every Settings open; without this, opening the
   * view five times would spend five of the sixty requests an hour GitHub
   * allows an unauthenticated caller.
   */
  let hermesCache: { at: number; result: HermesUpstream } | null = null;
  let hermesInFlight: Promise<HermesUpstream> | null = null;

  /** What this build pins, with no upstream answer attached. The base of every verdict. */
  function hermesPin(
    latest: string | null,
    error: string | null,
    checkedAt: string | null,
  ): HermesUpstream {
    return {
      pinned: core.hermesVersion,
      pinned_ref: BUILD_VERSIONS.hermes_ref,
      latest,
      update_available: false,
      checked_at: checkedAt,
      error,
    };
  }

  /**
   * GitHub's own vocabulary, shortened to something a status line can carry.
   * 403 and 429 both mean the rate limit on this IP, which is the failure an
   * operator is most likely to see and the one least worth alarming them about.
   */
  function hermesFetchError(e: unknown): string {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "timeout";
    const message = e instanceof Error ? e.message : String(e);
    return message.length > 120 ? `${message.slice(0, 117)}…` : message;
  }

  /**
   * Ask upstream once. Every failure is returned, never thrown: this is a
   * courtesy read hanging off `foundation.status`, and a GitHub outage must not
   * be able to break "which foundation version is my fleet on".
   */
  async function readHermesUpstream(): Promise<HermesUpstream> {
    const http = deps.hermesFetch ?? ((input, init) => fetch(input, init));
    const checkedAt = nowIso();
    let tag: string;
    try {
      const res = await http(HERMES_RELEASES_URL, {
        // A ceiling on the whole request, not just on connecting: an upstream
        // that accepts the socket and then says nothing is the case a
        // connect-only deadline sails straight past.
        signal: AbortSignal.timeout(HERMES_CHECK_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "hermetic",
        },
      });
      if (res.status === 403 || res.status === 429) {
        return hermesPin(
          null,
          "GitHub rate limit reached; unauthenticated checks are 60/hour",
          checkedAt,
        );
      }
      if (!res.ok) return hermesPin(null, `GitHub answered HTTP ${res.status}`, checkedAt);
      const body: unknown = await res.json();
      const name = (body as { tag_name?: unknown } | null)?.tag_name;
      if (typeof name !== "string" || name.length === 0) {
        return hermesPin(null, "GitHub's latest release carries no tag_name", checkedAt);
      }
      tag = name;
    } catch (e) {
      return hermesPin(null, hermesFetchError(e), checkedAt);
    }

    const latest = normaliseReleaseTag(tag);
    const pinned = normaliseReleaseTag(BUILD_VERSIONS.hermes_ref);
    // Reported either way: an operator who can see the tag can decide about it
    // themselves, which is more use than hiding it because this could not.
    const shown = latest ?? tag.replace(/^v/, "");
    if (latest === null || pinned === null) {
      return { ...hermesPin(shown, "unrecognised tag", checkedAt) };
    }
    return {
      ...hermesPin(shown, null, checkedAt),
      update_available: compareReleaseTags(latest, pinned) > 0,
    };
  }

  /** The cached, single-flight wrapper every `status()` goes through. */
  async function hermesUpstream(): Promise<HermesUpstream> {
    if (hermesCache && Date.now() - hermesCache.at < HERMES_CACHE_TTL_MS) return hermesCache.result;
    hermesInFlight ??= readHermesUpstream()
      .then((result) => {
        hermesCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        hermesInFlight = null;
      });
    return hermesInFlight;
  }

  // ─── foundation.status ─────────────────────────────────────────────────────

  /**
   * §6.6: one `_fleet` GetItem and one agents scan, and deliberately no S3 read.
   * Every CLI command and every `/api/meta` calls this, so it has to cost what a
   * read costs — the manifest's copy of the same numbers is written *from*
   * `_fleet` and would only be a second chance to disagree.
   *
   * `opts.hermes` is the one thing that can make it cost more: the advisory
   * upstream-Hermes check reaches GitHub. It is on by default, because the two
   * readers that render it — `hermetic foundation status` and the portal — are
   * the readers that matter. The CLI's per-command nag turns it *off*: it
   * prints nothing about Hermes, it is already racing a 1.5 s budget, and every
   * `hermetic agent ps` spending one of GitHub's sixty unauthenticated requests
   * an hour to learn a number it will not print is the worst trade available.
   */
  async function status(
    _input: Record<string, never> = {},
    opts: { hermes?: boolean } = {},
  ): Promise<FoundationStatus> {
    await core.guardAccount();
    const fleet = await backend.store.fleet.get();
    if (!fleet) {
      throw new HermeticError("FLEET_MISMATCH", `the ${FLEET_KEY} item is missing`, {});
    }
    const agents = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
    const hermes = (opts.hermes ?? true) ? await hermesUpstream() : null;
    const available = {
      foundation_version: foundationVersion,
      template_sha256: templateSha256(),
      hermeticd_version: hermeticdVersion,
    };
    const current = {
      foundation_version: versionOf(fleet),
      template_sha256: fleet.foundation_template_sha256 ?? null,
      hermeticd_version: fleet.min_hermetic_version,
      ubuntu_release: fleet.ubuntu_release,
      ami_id: fleet.ami_id,
      // §5. Absent on a fleet the v6 migration has not reached yet, and
      // reported as absent rather than guessed at — the stack parameter is the
      // truth, and this read does not open the stack.
      ...(fleet.network === undefined ? {} : { network: fleet.network }),
      // §8.3. Absent reads as "not recorded" — the v10 migration is what puts
      // it there — and never as a fleet whose role may invoke nothing.
      ...(fleet.bedrock_model_ids === undefined ? {} : { bedrock_model_ids: fleet.bedrock_model_ids }),
    };
    /**
     * §8.3: models named somewhere in this fleet that its own stack does not
     * grant. Computed against what `_fleet` records rather than against this
     * build's defaults — the question is what somebody else's stack allows, and
     * a newer laptop's default list is not evidence about it.
     */
    const staleGrants =
      fleet.bedrock_model_ids === undefined
        ? undefined
        : staleBedrockGrants({
            settings: settingsOf(fleet).settings,
            agents,
            granted: fleet.bedrock_model_ids,
          });
    /**
     * §6.6: the per-agent half of the skew, computed from the scan this read
     * already paid for. `configVerdict` compares the two hashes the row now
     * keeps apart — what the fleet rendered, and what the box reports having
     * applied — which is the comparison that was impossible while one attribute
     * carried both meanings in turn.
     */
    const agentRows = agents
      .map((a) => ({
        name: a.name,
        status: a.status,
        hermeticd_version: a.hermeticd_version ?? null,
        /**
         * "Reported" is load-bearing. `recreate` writes the release it just
         * pinned onto the row *before* the replacement box has booted, clearing
         * `last_heartbeat` in the same write — so the version on a row is a
         * claim by the laptop until the box has said something, and reading it
         * as the box's answer reports a machine that does not exist yet as
         * up to date.
         *
         * This is still a label comparison and still cannot see a release that
         * changed the binary without changing the version (see
         * `Agent.running_hermeticd_sha256`, which is the fact that can). What it
         * no longer does is answer for a box that has never spoken: that is
         * `null`, and `computeSkew` counts only a strict `false` as behind.
         */
        current:
          a.last_heartbeat == null || a.hermeticd_version == null
            ? null
            : a.hermeticd_version === hermeticdVersion,
        config: configVerdict(a),
        hermes_version: a.hermes_version ?? null,
        running_hermes_version: a.running_hermes_version ?? null,
        last_heartbeat: a.last_heartbeat ?? null,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const updateAvailable =
      current.foundation_version < available.foundation_version ||
      current.template_sha256 !== available.template_sha256 ||
      current.hermeticd_version !== available.hermeticd_version;
    const toolOutdated = current.foundation_version > available.foundation_version;
    const result = {
      fleet: current,
      available,
      /**
       * Any of the three: a fleet on an older contract, a fleet whose template
       * digest differs (a template edit that forgot to bump the version), or a
       * fleet pointed at an older release than this build ships.
       *
       * Deliberately *not* gated on `tool_outdated`. The two are independent
       * facts and both can be true at once — a fleet that is ahead on the
       * foundation version and behind on hermeticd is exactly the state a
       * half-upgraded team is in — and a head that wants "offer the update
       * button" reads both. Hiding one behind the other made the flag lie.
       */
      update_available: updateAvailable,
      tool_outdated: toolOutdated,
      in_progress: lockIsLive(fleet) ? (fleet.lock ?? null) : null,
      /**
       * The whole §6.6 warning, computed once here so every head renders the
       * same sentence about the same fleet rather than each comparing the
       * numbers above for itself (`computeSkew`).
       */
      skew: computeSkew({
        fleetVersion: current.foundation_version,
        expectedVersion: available.foundation_version,
        toolOutdated,
        updateAvailable,
        agents: agentRows,
      }),
      /**
       * Deliberately *not* folded into `update_available` above. That flag is
       * what `foundation update` acts on, and this is a bump only a human
       * performs, one agent at a time (§6.5) — conflating them would put an
       * "Update foundation…" button behind a Hermes release it does not apply.
       */
      ...(hermes ? { hermes } : {}),
      /**
       * Three states, not two. An empty array is "compared, nothing stale"; the
       * field is *absent* only when there was nothing to compare against —
       * a fleet that predates v10 and records no grant, or an older server that
       * never sent the field. Collapsing the two into one absence made every
       * head report an unchecked policy as a checked one.
       */
      ...(staleGrants === undefined ? {} : { stale_bedrock_grants: staleGrants }),
      agents: agentRows,
    };
    observeStatusAdvisories(result);
    return result;
  }

  /**
   * §4.9: `status` is where both of these conditions are already
   * decided, so it is where they are delivered — one row while each holds, and
   * a `resolved_at` on the scan that no longer sees it.
   *
   * `staleGrants === undefined` means *not compared* (a fleet that records no
   * grant), and is deliberately not reconciled: handing `observeAdvisories` an
   * empty list would resolve every open Bedrock row as though the grant had
   * been fixed.
   */
  function observeStatusAdvisories(status: FoundationStatus): void {
    const notifications = core.notifications;
    if (notifications === undefined) return;
    observeAdvisories(
      notifications,
      ADVISORY_FOUNDATION_UPDATE,
      foundationUpdateAdvisories({
        update_available: status.update_available,
        current: status.fleet,
        available: status.available,
      }),
    );
    const stale = status.stale_bedrock_grants;
    if (stale !== undefined) {
      observeAdvisories(notifications, ADVISORY_BEDROCK_GRANT, bedrockGrantAdvisories(stale));
    }
  }

  return { status };
}
