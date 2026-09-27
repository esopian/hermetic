/**
 * `hermetic doctor` (§9): the command that earns trust. It reconciles the three
 * sources that can disagree with each other without any hermetic operation
 * having run — DynamoDB, EC2 and Tailscale — plus the account and fleet guards,
 * and reports *where* rather than merely whether.
 *
 * It lives outside `hermetic.ts` because it is a pure read: given a backend and
 * the frozen config it needs nothing else from the SDK's closure, and the
 * lifecycle module is long enough already.
 */
import {
  FLEET_KEY,
  agentHostnameMismatch,
  legacyCloudNames,
  CLOUD_NAME_FOUNDATION_VERSION,
  cloudName,
  stackNameFor,
  staleDeviceNote,
  tablesFor,
} from "../schema/index.ts";
import type {
  Agent,
  AgentStatus,
  LocalConfig,
  NatHealth,
  NetworkMode,
  NetworkReport,
  PolicyManagedState,
  PolicyReport,
  PolicyScope,
  TailscalePreflight,
} from "../schema/index.ts";
import type { Backend } from "../backend/types.ts";
import { AGENT_PARAM_ROOT, HERMETIC_PARAM_ROOT } from "../backend/constants.ts";
import { legacyParamPrefixes, listLegacyParams, readFleetScope } from "./legacy-params.ts";
import { deriveDisplayStatus, heartbeatAgeMs } from "../agents/state.ts";
import { staleBedrockGrants } from "../profiles/bedrock-grants.ts";
import { settingsOf } from "../profiles/settings.ts";
// The §4.7 preflight's own bound. `doctor` reuses the number rather than
// picking a second one: it is the same daemon, asked the same question.
import { PROBE_TIMEOUT_MS } from "./preflight.ts";
// `aws/env.ts` reads `process.env` and imports no SDK, so `doctor` can report
// the credential-environment warning of §4.7 without dragging AWS into core.
import { detectEnvCredentialOverrides } from "../aws/env.ts";

export interface DoctorReport {
  ok: boolean;
  account: { frozen: string; observed: string; ok: boolean };
  fleet: {
    local: string | null;
    stack_tag: string | null;
    fleet_item: string | null;
    ok: boolean;
  };
  foundation: {
    present: boolean;
    status: string | null;
    /**
     * The fleet is on an older foundation contract, an older template digest or
     * an older hermeticd than this build ships (§6.6) — `hermetic foundation
     * update` is the fix.
     *
     * A field, never a `findings` entry: `ok` is derived from `findings`, and an
     * available update is an offer, not a fault. Heads render it as one.
     */
    outdated: boolean;
    version: number;
    available_version: number;
  };
  security_group: { inbound_rules: number; ok: boolean };
  /**
   * SSM parameters this fleet wrote before foundation v3, still sitting
   * directly under `/hermetic/` and `/hermes/` rather than under the fleet id.
   * The v3 migration copies rather than moves them, so their being here is
   * expected; `teardown --purge` is what finally removes them.
   */
  legacy_parameters: { count: number; note: string | null };
  /**
   * §4.8: the account-global fleet directory, as it sees *this* fleet. Three
   * ways to disagree and each is a finding, because each has a command that
   * fixes it: no table (`init` makes one), no entry for this fleet
   * (`init --attach` registers it), and an entry whose `foundation_version`
   * differs from `_fleet`'s (`foundation update` re-stamps both).
   *
   * `name_matches` is what says the entry found by `fleet_id` is filed under
   * the name this home froze — the one disagreement that makes `fleet ls` and
   * `--fleet` talk about different fleets.
   */
  directory: {
    region: string;
    exists: boolean;
    /**
     * Whether the read succeeded at all. `exists: false, readable: true` is an
     * account with no directory table, which `init` fixes; `readable: false` is
     * a table this laptop's credentials could not reach, which it does not.
     * Collapsing the two would tell an operator to create a table that is
     * already there.
     */
    readable: boolean;
    registered: boolean;
    name_matches: boolean;
    foundation_version_matches: boolean;
    /**
     * How many fleets the account holds that are not torn down. Reported so a
     * head can say whether an unregistered fleet is this account's only one —
     * it no longer decides a suggested name, because a fleet registers with no
     * display alias at all (§4.6).
     */
    fleets_active: number;
  };
  /**
   * Credential environment variables that are set and would have been preferred
   * by the SDK's default chain — `aws.client()` ignores them, but silently
   * (§4.7). A warning list, not a finding: nothing here makes the fleet unwell.
   */
  env_overrides: string[];
  /**
   * Rows `scan` could not parse. They are excluded from every fleet read rather
   * than breaking it, so this is the only place they surface (§4.5).
   */
  unparseable_rows: string[];
  heartbeats: Array<{ name: string; status: AgentStatus; age_ms: number | null; unreachable: boolean }>;
  findings: string[];
  /**
   * EC2-vs-DynamoDB drift (§9): a live instance with no matching row (or a
   * `destroyed` one), a row that should have a live instance and does not, a
   * row whose recorded `instance_id` disagrees with the live one, a row
   * that never captured the id of an instance that already exists tagged for it
   * (create launched, then failed before persist), or a *second* live instance
   * carrying an active agent's tag — nothing in AWS stops two boxes sharing one
   * agent tag, and one of them is billed and on the tailnet unnoticed.
   */
  instance_drift: Array<{
    kind:
      | "instance_missing"
      | "orphan_instance"
      | "instance_mismatch"
      | "instance_unrecorded"
      | "instance_duplicate";
    agent: string | null;
    detail: string;
  }>;
  /**
   * Tailscale-vs-DynamoDB drift (§9). `available` is false when `listDevices`
   * degraded (missing `devices:core` scope, or the call failed) — that is
   * reported as informational, not folded into `missing`, and `detail` says
   * which so the operator knows *why* drift went unchecked rather than reading
   * an empty list as a clean bill.
   *
   * `stale` is the other half, and it needs no device list at all: after a
   * `recreate` the old device keeps the canonical name and the new node is
   * admitted as `<name>-2`, which the row reports on `tailscale_dns_name`.
   * Comparing the two is a row read, so an operator whose OAuth client lacks
   * the scope still gets told which device to delete. Informational too — each
   * entry carries the sentence a head prints on `note`, and none of it reaches
   * `findings`, because deleting the device is not something hermetic can do
   * and a permanent PROBLEMS is a report nobody reads.
   */
  tailscale: {
    available: boolean;
    missing: string[];
    stale: Array<{
      agent: string;
      real: string;
      canonical: string;
      /**
       * `stale` is a dead device sitting on the canonical name; `legacy` is a
       * live node wearing a spelling hermetic used to hand out. Only the first
       * is something to go and delete, and a head that cannot tell them apart
       * will tell an operator to delete the machine their agent is running on.
       */
      kind: "legacy" | "stale";
      /**
       * True when this node was built *after* its fleet adopted the naming rule
       * it is not following — i.e. it is not an old box at all, and the fleet's
       * published release is what is old. That distinction is the difference
       * between a note and a finding (see below).
       */
      misnamed?: boolean;
      note: string;
    }>;
    detail: string | null;
    /**
     * hermetic's own entries in the tailnet policy file (§4.7). Informational,
     * exactly like the device list above and for the same reason: an operator
     * whose OAuth client has no `policy_file` scope would otherwise read
     * PROBLEMS for ever over something no hermetic command can clear, and a
     * report that is permanently red is a report nobody reads. `null` when the
     * read itself failed — which is not the same as "there is nothing there",
     * and is said rather than shown as a clean bill.
     */
    policy: {
      scope: PolicyScope;
      managed: PolicyManagedState;
      /** The blocks that are absent or say something else. */
      blocks_drifted: string[];
    } | null;
  };
  /**
   * The operator's *own* Tailscale — the §4.7 preflight (§9). Two of the things
   * it reads are tailnet-wide and break every `agents.create` about twenty
   * minutes in, on the box: MagicDNS off (nothing has a name to serve under)
   * and HTTPS Certificates off (`tailscale serve --https=443` can get no
   * certificate). `init` checks them; `agents.create` deliberately does not, so
   * a fleet initialised before the toggle was flipped has no other place to
   * find out. This is that place.
   *
   * Unlike `tailscale` above this is a local read, not a fleet one: it says
   * nothing about the agents and everything about whether the next create can
   * possibly work.
   */
  local_tailscale: {
    ok: boolean;
    /** The detected MagicDNS suffix; null when there is none to detect. */
    tailnet: string | null;
    /** `cert_domains` was non-empty: HTTPS Certificates is on for this tailnet. */
    https_certificates: boolean;
    /**
     * The one line a head prints: the preflight's own `problem` verbatim when
     * something is wrong (it already names the toggle and the admin page), or
     * the healthy summary. Never a secret — `problem` never carries one (§8.3).
     */
    detail: string;
  };
  /**
   * §5's fleet network mode, and the three ways it can be wrong.
   *
   * `mode` is the `_fleet` cache, `stack_mode` is what CloudFormation actually
   * built, and `consistent` is whether they agree — the same shape as
   * `foundation_version` versus the directory (§4.8), and reconciled here for
   * the same reason.
   *
   * `checked_nat` is the distinction that matters most. A `public` fleet has no
   * NAT appliance, so `nat` is `null` and nothing was looked at; that is a
   * *skip*, not a pass, and a head that rendered the two alike would show a
   * green tick for a check it never ran (`ui/src/doctor-logic.ts` already draws
   * the distinction). `nat` is also `null` on a `nat` fleet whose resources
   * could not be read, which is why the boolean is carried separately.
   *
   * `drifted` names the agents a mode switch left on the old subnets. They are
   * findings — unlike a stale tailnet device, this is something one hermetic
   * command fixes (`agent recreate`), so it is not a permanent red.
   */
  network: {
    mode: NetworkMode | null;
    stack_mode: NetworkMode | null;
    consistent: boolean;
    nat: NatHealth | null;
    /** True only when a NAT appliance was really asked about and answered. */
    checked_nat: boolean;
    /**
     * What could not be read, said out loud. `probeNat` turns a failed or denied
     * `DescribeInstances`/`DescribeRouteTables` into `null` rather than throwing,
     * and a `null` instance state is *not* the same fact as a stopped one: the
     * first means nobody looked, the second means the fleet has no egress. Only
     * the second is a finding. These are the first, carried the way
     * `tailscale.detail` and `legacy_parameters.note` are — printed, never
     * counted, so a read this laptop's credentials cannot make does not leave
     * `doctor` permanently red.
     */
    notes: string[];
    drifted: string[];
  };
}

export interface DoctorDeps {
  backend: Backend;
  /** `FOUNDATION_VERSION`/`foundationTemplateSha256()`/`BUILD_VERSIONS.hermeticd` (§6.6). */
  available: { foundationVersion: number; templateSha256: string; hermeticdVersion: string };
  /** The frozen row (§4.6); `doctor` is initialized-only, like every read. */
  config: LocalConfig;
  /**
   * `scan`, tolerating the `agents` table having already gone with the stack —
   * a half-finished teardown is exactly the state `doctor` exists to name, so
   * the read that would throw is handed in ready to answer instead.
   */
  scanAgents: () => Promise<{ agents: Agent[]; table_gone: boolean }>;
  /**
   * The §4.7 local probe, the same one `init` runs — resolved by the SDK
   * closure, which defaults it to the real `probeLocalTailscale`. Required
   * rather than optional for the reason rule 6 gives: a dependency that can be
   * left out is a check that can be silently switched off.
   */
  localTailscale: () => Promise<TailscalePreflight>;
  /**
   * `policy.status` (§4.7), handed in for the same reason `localTailscale` is:
   * it is a fleet read the SDK closure already owns, and `doctor` is where a
   * fleet whose policy has drifted finds out. Required, not optional — an
   * absent dependency would be a check silently switched off (rule 6) — and
   * `doctor` catches its failures itself, because an unreachable Tailscale is a
   * thing to report rather than a reason `doctor` cannot answer at all.
   */
  policyStatus: () => Promise<PolicyReport>;
  /**
   * `network.status` (§5), handed in for the same reason `policyStatus` is: it
   * is a fleet read the SDK closure already owns, and `doctor` is where a fleet
   * whose `_fleet.network` disagrees with its stack — or whose NAT appliance is
   * down — is supposed to find out. Required, not optional: an absent
   * dependency would be four checks silently switched off (rule 6).
   */
  networkStatus: () => Promise<NetworkReport>;
}

/**
 * The §4.7 preflight, bounded and never throwing. `probeLocalTailscale` already
 * kills a wedged `tailscaled`, but per candidate binary — four of them is four
 * timeouts — and `deps.localTailscale` may be any function at all. `doctor` is
 * the command an operator runs *because* something is wrong, so it bounds the
 * whole call itself and turns both a hang and a throw into what every other
 * source of trouble here becomes: a finding.
 *
 * Exported for its own test: the stale-process guard cannot be reached
 * through the SDK closure, which fills in a default probe.
 */
export async function checkLocalTailscale(
  probe: () => Promise<TailscalePreflight>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<DoctorReport["local_tailscale"]> {
  const unknown = (detail: string): DoctorReport["local_tailscale"] => ({
    ok: false,
    tailnet: null,
    https_certificates: false,
    detail,
  });

  // `--hot` reloads modules but not the closure `createHermetic` built at boot,
  // so a required dep can be missing only in a stale dev process; naming the
  // cure beats a TypeError.
  if (typeof probe !== "function") {
    return unknown(
      "this portal was built before the tailscale check existed and is running stale code; restart it (`bun run dev` / `hermetic-portal`) and run doctor again",
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let preflight: TailscalePreflight | null;
  try {
    preflight = await Promise.race([
      probe(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (e) {
    return unknown(
      `could not read this machine's tailscale: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // The probe may still be in flight; the timer must not keep the process
    // alive after the answer (or the lack of one) has been decided.
    clearTimeout(timer);
  }

  if (preflight === null) {
    return unknown(
      `\`tailscale status --json\` did not answer within ${timeoutMs}ms; the local tailscale daemon looks wedged`,
    );
  }
  const https = preflight.cert_domains.length > 0;
  if (!preflight.ok) {
    return {
      ok: false,
      tailnet: preflight.tailnet,
      https_certificates: https,
      // Verbatim: the preflight's message already says what to enable and where.
      detail: preflight.problem ?? "this machine's tailscale is not usable",
    };
  }
  return {
    ok: true,
    tailnet: preflight.tailnet,
    https_certificates: https,
    detail: `tailscale: ${preflight.tailnet ?? "(no tailnet)"}, HTTPS certificates on`,
  };
}

/**
 * §4.8, and never throwing. An absent table, an unreachable region and a fleet
 * nobody registered are three different answers, and all three are things to
 * *report* — so the read is bounded to what it can say and the failure mode is
 * "exists: false", which the caller turns into the finding that names the fix.
 */
async function readDirectory(
  deps: DoctorDeps,
  fleetFoundationVersion: number | null,
): Promise<DoctorReport["directory"]> {
  const { config } = deps;
  const region = deps.backend.directory.region;
  const absent: DoctorReport["directory"] = {
    region,
    exists: false,
    readable: true,
    registered: false,
    name_matches: false,
    foundation_version_matches: false,
    fleets_active: 0,
  };
  try {
    /**
     * `status()`, not `list()`: "the table is not there" and "the table is
     * there and I could not read it" are different findings with different
     * fixes, and only `status` distinguishes them — it answers `exists: false`
     * for a missing table rather than throwing.
     */
    const status = await deps.backend.directory.status();
    if (!status.exists) return absent;
    const active = status.fleets.filter((e) => e.status !== "torn_down").length;
    const byId = status.fleets.find((e) => e.fleet_id === config.fleet_id) ?? null;
    if (!byId) return { ...absent, exists: true, fleets_active: active };
    return {
      region,
      exists: true,
      readable: true,
      registered: true,
      // §4.6: the local row caches the directory's display alias. A disagreement
      // is a stale cache, not two fleets — the ids matched to get here.
      name_matches: byId.name === config.name,
      foundation_version_matches:
        fleetFoundationVersion === null || byId.foundation_version === fleetFoundationVersion,
      fleets_active: active,
    };
  } catch {
    // Unreachable, not absent. `doctor` must not report "there is no directory"
    // to an operator whose credentials simply cannot read the one there is.
    return { ...absent, readable: false };
  }
}

/**
 * Parameters still on the pre-v3 account-root paths. Named, never valued —
 * `secrets.list` returns paths (§8.3) — and counted rather than listed, because
 * the number is the whole of what an operator needs to decide anything.
 */
async function countLegacyParameters(
  backend: DoctorDeps["backend"],
  fleetId: string,
  agents: readonly string[],
): Promise<DoctorReport["legacy_parameters"]> {
  let count = 0;
  try {
    /**
     * The same enumeration `teardown --purge` and the v3 migration use
     * (`legacy-params.ts`): this fleet's own agent names plus the two fixed
     * fleet-level layouts, never a root. `doctor` counting a different set from
     * the command it recommends would be worse than counting nothing — so when
     * `--purge` would not take them, this reports *nothing to take* and says
     * why, rather than a count the recommended command will not act on.
     */
    const scope = await readFleetScope(backend, fleetId);
    if (!scope.sole) {
      return { count: 0, note: scope.reason };
    }
    const { prefixes } = legacyParamPrefixes(agents, scope);
    count = (await listLegacyParams(backend.secrets, prefixes)).length;
  } catch {
    // A profile that cannot list SSM has bigger problems, and every one of them
    // is already a finding. Silence here rather than a second alarm.
    return { count: 0, note: null };
  }
  return {
    count,
    note:
      count === 0
        ? null
        : `${count} SSM parameter(s) remain on this fleet's pre-v3 paths under ${HERMETIC_PARAM_ROOT} and ${AGENT_PARAM_ROOT}; the v3 foundation update copied them under this fleet's id and kept the originals — \`hermetic teardown --purge\` removes them once this is the account's last fleet`,
  };
}

/** The command that earns trust: reconcile three sources and report where they disagree (§9). */
/**
 * Was this agent built *after* its fleet adopted today's cloud-naming rule?
 *
 * The question matters because "wearing an older spelling" has two causes with
 * opposite meanings. A box that predates the rule keeps its hostname until it is
 * recreated, and nothing is wrong with anything. A box created *since* the fleet
 * moved to v4 and still wearing a v3 name means the fleet's **published
 * release** — the hermeticd and stages in its bucket, which are what actually
 * ask the tailnet for a name — is older than the laptop rendering its config.
 *
 * `foundation_updated_at` is when the fleet reached its current contract; a
 * fleet created directly at v4 has none, and `created_at` is that moment
 * instead. Anything this cannot establish answers `false`: a missing timestamp,
 * a fleet with no v4 stamp, or a row with no `created_at` is not evidence of a
 * defect, and a doctor that guesses PROBLEMS is a doctor nobody reads.
 *
 * The agent's side is `bootstrap.started_at` — when *this box* first ran its
 * stages — and only then `created_at`. They differ exactly where it matters: a
 * `recreate` builds a new instance and leaves `created_at` at the row's original
 * value, so an agent from June recreated today would look like an old box and
 * its wrong name would go unreported. A row with no bootstrap has never booted
 * and falls back to the row's own age, which is the best it can say.
 */
export function builtUnderCurrentRule(
  agent: { created_at?: string | null; bootstrap?: { started_at?: string } | null },
  fleet:
    | {
        foundation_version?: number | undefined;
        foundation_updated_at?: string | undefined;
        created_at?: string;
      }
    | null
    | undefined,
): boolean {
  if (!fleet || (fleet.foundation_version ?? 0) < CLOUD_NAME_FOUNDATION_VERSION) return false;
  const adopted = fleet.foundation_updated_at ?? fleet.created_at ?? null;
  const born = agent.bootstrap?.started_at ?? agent.created_at ?? null;
  if (adopted === null || born === null) return false;
  return born >= adopted;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const { backend, config } = deps;
  const id = await backend.identity.callerIdentity();
  const stack = await backend.foundation.describeStack();
  const scanned = await deps.scanAgents();
  const agents = scanned.agents;
  const fleet = scanned.table_gone ? null : await backend.store.fleet.get();
  const now = backend.clock.now();
  const findings: string[] = [];
  // A half-finished teardown is exactly the state `doctor` exists to name
  // (§9): the tables are gone but the local config still points at the fleet.
  if (scanned.table_gone) {
    findings.push(
      `the ${tablesFor(stackNameFor(config.fleet_id)).agents} table does not exist; the foundation is gone or half deleted — \`hermetic teardown --yes\` finishes the job, \`hermetic init\` starts a new one`,
    );
  }

  /**
   * The directory is read defensively: `doctor` is the command an operator runs
   * *because* something is wrong, and a table they cannot reach must become a
   * finding rather than the reason there is no report at all.
   */
  const directory = await readDirectory(deps, fleet?.foundation_version ?? null);
  if (!directory.readable) {
    findings.push(
      `the account's fleet directory in ${directory.region} could not be read; check this profile's dynamodb permissions in that region`,
    );
  } else if (!directory.exists) {
    findings.push(
      `the account's fleet directory table does not exist in ${directory.region}; \`hermetic init\` creates it`,
    );
  } else if (!directory.registered) {
    /**
     * §4.6: the remedy names the `fleet_id`, because that is what `--attach`
     * takes and what the registration will be keyed on. There is no name to
     * suggest — a fleet registers with no display alias and is labelled
     * afterwards, if anybody wants it labelled at all.
     */
    findings.push(
      `fleet ${config.fleet_id} is not in the account's fleet directory; \`hermetic init --attach --fleet ${config.fleet_id}\` registers it`,
    );
  } else {
    if (!directory.name_matches) {
      findings.push(
        `the fleet directory files ${config.fleet_id} under a different display alias than this home last cached (${config.name ?? "(none)"}); the directory is the register of record, and the next command that reads it refreshes the cache`,
      );
    }
    if (!directory.foundation_version_matches) {
      findings.push(
        `the fleet directory records a different foundation version than ${FLEET_KEY} does; \`hermetic foundation update\` re-stamps both`,
      );
    }
  }

  /**
   * §8.2: parameters this fleet wrote before v3, still sitting directly under
   * the account roots rather than under `/hermetic/<fleet_id>/` and
   * `/hermes/<fleet_id>/`. The v3 migration *copies* rather than moves them —
   * a rolled-back hermetic and any box still on the previous release read the
   * old paths — so they are expected to be here, and this says so rather than
   * leaving an operator to find two copies of every key and wonder which is
   * live.
   *
   * Reported, never a finding: nothing is broken by their being there, and a
   * fleet that answered PROBLEMS until an operator ran `teardown --purge` would
   * be teaching them to ignore the answer.
   */
  const legacy_parameters = await countLegacyParameters(
    backend,
    config.fleet_id,
    agents.map((a) => a.name),
  );

  const accountOk = id.account_id === config.account_id;
  if (!accountOk) {
    findings.push(
      `credentials resolve to ${id.account_id} but this home is frozen to ${config.account_id}`,
    );
  }

  const stackTag = stack?.tags["fleet_id"] ?? null;
  const fleetItemId = fleet?.fleet_id ?? null;
  const fleetOk = stackTag === config.fleet_id && fleetItemId === config.fleet_id;
  if (!stack)
    findings.push(
      `no ${stackNameFor(config.fleet_id)} stack found, under that name or any other tagged with this fleet id`,
    );
  else if (stackTag !== config.fleet_id)
    findings.push("stack fleet_id tag disagrees with local config");
  if (!fleet) findings.push(`${FLEET_KEY} item is missing`);
  else if (fleetItemId !== config.fleet_id)
    findings.push(`${FLEET_KEY} fleet_id disagrees with local config`);

  /**
   * §6.6: three ways to be behind, and each of them means the same fix. The
   * template digest is checked as well as the version because a template edit
   * that forgot to bump `FOUNDATION_VERSION` would otherwise look current.
   *
   * Reported as a *field* and deliberately not pushed into `findings`. A
   * finding is something wrong with this fleet, and `ok` is derived from the
   * list — an available update is neither. Every fleet would have been
   * permanently un-`ok` the moment a new hermetic shipped, which is the fastest
   * way to teach an operator to ignore `doctor`. Heads read the field and show
   * it as an offer (the `EnvStrip` pill, the checklist row), not a fault.
   */
  const foundationVersion = fleet?.foundation_version ?? 0;
  const foundationOutdated =
    fleet !== null &&
    foundationVersion <= deps.available.foundationVersion &&
    (foundationVersion < deps.available.foundationVersion ||
      fleet.foundation_template_sha256 !== deps.available.templateSha256 ||
      fleet.min_hermetic_version !== deps.available.hermeticdVersion);

  const inbound = await backend.compute.describeSecurityGroupInbound();
  if (inbound.length > 0) {
    findings.push(`the agent security group has ${inbound.length} inbound rule(s); it must have none`);
  }

  /**
   * §4.7: `aws.client()` pins the frozen profile, so these are ignored — but
   * silently, and an operator who exported them deserves to be told. It is a
   * warning list rather than a finding: nothing here makes the fleet unwell,
   * and `doctor --json` must stay stable for whoever has AWS_PROFILE exported.
   */
  const env_overrides = detectEnvCredentialOverrides();

  // `scan` above skipped these rather than failing the whole fleet read.
  const unparseable_rows = backend.store.agents.unparseable?.() ?? [];
  if (unparseable_rows.length > 0) {
    findings.push(
      `${unparseable_rows.length} agent row(s) do not parse and are hidden from every fleet read: ${unparseable_rows.join(", ")}`,
    );
  }

  const heartbeats = agents
    .filter((a) => a.status !== "destroyed")
    .map((a) => {
      const age = heartbeatAgeMs(a, now);
      const unreachable = deriveDisplayStatus(a, now) === "unreachable";
      if (unreachable) findings.push(`${a.name} is ${a.status} but has not heartbeated recently`);
      return { name: a.name, status: a.status, age_ms: age, unreachable };
    });

  /**
   * §9: the three-way reconciliation `doctor` earns its name for — DynamoDB
   * against the two things that can drift out from under it independently
   * of any hermetic operation: EC2 (an instance terminated or launched by
   * hand) and Tailscale (a device removed from the admin console).
   */
  const instance_drift: DoctorReport["instance_drift"] = [];
  const LIVE_STATUSES: readonly AgentStatus[] = ["ready", "degraded", "bootstrapping"];

  const agentsByName = new Map(agents.map((a) => [a.name, a] as const));
  const liveInstances = await backend.compute.listManagedInstances();

  /**
   * `listManagedInstances` keeps `shutting-down` so a destroy in flight is
   * visible, but a box already on its way out is nobody's drift: every
   * `recreate` leaves one for the 30–60 s EC2 takes to finish with it, and
   * calling that a second box would make `doctor` red about the operation the
   * operator just ran.
   */
  const isDying = (state: string) => state === "shutting-down" || state === "terminated";

  /** Every instance carrying an agent tag, grouped — there may be two. */
  const liveForAgent = new Map<string, Array<{ instance_id: string; state: string }>>();
  for (const inst of liveInstances) {
    if (!inst.agent) continue;
    const list = liveForAgent.get(inst.agent);
    if (list) list.push(inst);
    else liveForAgent.set(inst.agent, [inst]);
  }
  /**
   * The one instance the per-row checks below speak about: the one the row
   * records, when it is still out there. Otherwise a second box that merely
   * happened to come back first would be reported as an `instance_mismatch`,
   * which says the row is wrong when in fact the row is right and there is an
   * extra box.
   */
  const liveByAgent = new Map<string, { instance_id: string; state: string }>();
  /**
   * Agents where *none* of the boxes out there is known to be the agent's own:
   * the row records an id that is not among them, or records no id at all.
   * Which of them EC2 happens to return first must not then decide which
   * finding names which id — so the finding that names one names them all, and
   * where there is more than one they are all duplicates.
   */
  const noOwnInstance = new Set<string>();
  /** The non-dying instances per agent, id-sorted so findings are stable. */
  const presentForAgent = new Map<string, Array<{ instance_id: string; state: string }>>();
  for (const [name, list] of liveForAgent) {
    const row = agentsByName.get(name);
    const recorded = row ? (row.resources.instance_id ?? row.instance_id ?? null) : null;
    /**
     * Dying boxes are out of the picture entirely (see `isDying`), including
     * for this choice: one that is shutting down cannot be the agent's working
     * instance, and a recorded id naming one counts as gone. A `ready` row
     * whose only box is `shutting-down` therefore reports `instance_missing`,
     * which is the honest answer — it is ready with nothing live under it.
     */
    const present = list
      .filter((i) => !isDying(i.state))
      .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    presentForAgent.set(name, present);
    const match = recorded ? present.find((i) => i.instance_id === recorded) : undefined;
    if (match) {
      liveByAgent.set(name, match);
    } else {
      noOwnInstance.add(name);
      const first = present[0];
      if (first) liveByAgent.set(name, first);
    }
  }

  for (const a of agents) {
    const live = liveByAgent.get(a.name) ?? null;
    if (LIVE_STATUSES.includes(a.status) && !live) {
      instance_drift.push({
        kind: "instance_missing",
        agent: a.name,
        detail: `${a.name} is ${a.status} but has no live EC2 instance (instance_missing)`,
      });
    }
    const rowInstanceId = a.resources.instance_id ?? a.instance_id ?? null;
    if (live && !rowInstanceId && a.status !== "destroyed") {
      // The row names none of them, so this names all of them: with two boxes
      // out there, picking one to print would be picking EC2's ordering.
      const named = (presentForAgent.get(a.name) ?? []).map((i) => i.instance_id);
      const has =
        named.length > 1
          ? `has live EC2 instances ${named.join(", ")}`
          : `has live EC2 instance ${named[0]}`;
      instance_drift.push({
        kind: "instance_unrecorded",
        agent: a.name,
        detail: `${a.name} ${has} but the agent row recorded no instance id (instance_unrecorded)`,
      });
    }
    if (live && rowInstanceId && rowInstanceId !== live.instance_id) {
      // The recorded id is nowhere out there. Name every instance that *is*,
      // rather than one picked by EC2's ordering — and drop the singular, which
      // asserted there was only one while standing on a fleet with two.
      const named = (presentForAgent.get(a.name) ?? []).map((i) => i.instance_id);
      const are = named.length > 1 ? `instances are ${named.join(", ")}` : `instance is ${named[0]}`;
      instance_drift.push({
        kind: "instance_mismatch",
        agent: a.name,
        detail: `${a.name}'s row records instance ${rowInstanceId} but the live ${are} (instance_mismatch)`,
      });
    }
  }

  /**
   * The statuses `recreate` accepts (its DRAINS+DIRECT guard in `lifecycle.ts`).
   * Advising it on a row it would refuse is advice that cannot be taken.
   */
  const RECREATABLE: readonly AgentStatus[] = ["ready", "degraded", "creating", "stopped", "error"];

  for (const inst of liveInstances) {
    // A terminating box is neither an orphan nor a second one; see `isDying`.
    if (isDying(inst.state)) continue;
    const row = inst.agent ? agentsByName.get(inst.agent) : undefined;
    if (!row || row.status === "destroyed") {
      instance_drift.push({
        kind: "orphan_instance",
        agent: inst.agent,
        detail: `live EC2 instance ${inst.instance_id} (tag agent=${inst.agent ?? "(none)"}) has no active agent row (orphan_instance)`,
      });
      continue;
    }
    /**
     * Everything tagged for a live agent beyond its own one instance is a
     * second box: nothing in AWS prevents it (two recreates racing, a launch
     * whose id was never persisted followed by another), and until `doctor`
     * says so it is billed and on the tailnet with nobody looking.
     *
     * Which one is the agent's own depends on whether the row's id is out
     * there. If it is, that instance is it and every other is a duplicate. If
     * it is not — gone, or never recorded — none of them is, so a single one is
     * only the `instance_mismatch`/`instance_unrecorded` above, and two or more
     * are all duplicates, whatever order EC2 listed them in.
     */
    const present = presentForAgent.get(row.name) ?? [];
    if (noOwnInstance.has(row.name)) {
      if (present.length < 2) continue;
    } else if (inst.instance_id === liveByAgent.get(row.name)?.instance_id) {
      continue;
    }
    const recorded = row.resources.instance_id ?? row.instance_id ?? null;
    const fix = RECREATABLE.includes(row.status)
      ? `\`hermetic agent recreate ${row.name}\` terminates every stray`
      : `terminate it by hand once ${row.name} settles`;
    instance_drift.push({
      kind: "instance_duplicate",
      agent: row.name,
      detail: `live EC2 instance ${inst.instance_id} (tag agent=${row.name}) is not the instance ${row.name}'s row records (${recorded ?? "(none recorded)"}); a second box for one agent, billed and on the tailnet — ${fix} (instance_duplicate)`,
    });
  }
  for (const d of instance_drift) findings.push(d.detail);

  /**
   * The laptop's own tailnet, before the fleet's devices: a tailnet with
   * MagicDNS or HTTPS Certificates off is not drift in one agent, it is every
   * future `agents.create` failing twenty minutes into provisioning. A finding,
   * because it is something wrong that only the operator can fix.
   */
  const local_tailscale = await checkLocalTailscale(deps.localTailscale);
  if (!local_tailscale.ok) findings.push(local_tailscale.detail);

  const devices = await backend.tailscale.listDevices();
  const tailscaleMissing: string[] = [];
  const tailscaleStale: DoctorReport["tailscale"]["stale"] = [];
  const tailnet = fleet?.tailnet ?? "";
  /**
   * Informational, like `env_overrides`: degraded visibility is not itself a
   * finding that makes the fleet unwell, so it does not affect `ok`. But it is
   * *said*, because an unchecked list and a clean one look identical from the
   * outside, and the fix — re-scoping the OAuth client — is not something an
   * operator will guess at from silence.
   */
  /**
   * hermetic's own entries in the policy file. Bounded by nothing but its own
   * failure handling: `null` is "we could not find out", which the head prints
   * as such rather than as a clean bill.
   */
  let policy: DoctorReport["tailscale"]["policy"] = null;
  try {
    const report = await deps.policyStatus();
    policy = {
      scope: report.scope,
      managed: report.managed,
      blocks_drifted: report.blocks
        .filter((b) => b.state === "absent" || b.state === "drifted")
        .map((b) => b.key),
    };
  } catch {
    policy = null;
  }

  const tailscaleDetail =
    devices === null
      ? "device list unavailable: the fleet's Tailscale OAuth client lacks the `devices:core` read scope (or the call failed), so device drift is unchecked — Tailscale cannot add a scope to an existing client, so create a new one with `auth_keys` write and `devices:core` read/write (both tagged `tag:hermetic`) plus `policy_file`, then `hermetic secrets push _fleet --tailscale-oauth`"
      : null;
  if (devices !== null) {
    const hostnames = new Set(devices.map((d) => d.hostname));
    for (const a of agents) {
      if (a.status !== "ready") continue;
      /**
       * Matched on the agent's *cloud* name, or on any spelling hermetic used
       * to hand out. `TailscaleDevice.hostname` is the OS hostname the node
       * joined with, which cloud-init sets to `<fleet id>-<agent>` since v4
       * (`cloudName`) — so it is `k7m2x9qa-atlas`, never
       * `k7m2x9qa-atlas.tail0.ts.net` and never `k7m2x9qa-atlas-2`. A suffixed
       * replacement is found here precisely because the suffix lives on `name`,
       * not on `hostname`.
       *
       * The legacy spellings count as found, and must: a box built under v3 is
       * called `main-atlas` and one built before it `atlas`, and neither will
       * ever wear the v4 name without a recreate. Checking only the canonical
       * one would report every agent in an upgraded fleet as having no tailnet
       * device at all — a finding, and therefore a `doctor` that says PROBLEMS
       * about a fleet that is entirely healthy.
       */
      const spellings = [
        cloudName(fleet?.fleet_id, a.name),
        ...legacyCloudNames(fleet?.fleet_name, a.name),
      ];
      if (!spellings.some((h) => hostnames.has(h))) {
        tailscaleMissing.push(a.name);
        findings.push(`${a.name} is ready but has no tailscale device (tailscale_missing)`);
      }
    }
  }
  /**
   * Outside the `devices` gate on purpose. The mismatch is two strings on the
   * row, so the one check that names a node not answering to its canonical
   * spelling keeps working on the fleets that cannot read the device list —
   * which is, today, all of them.
   *
   * Reported on `tailscale.stale`, not in `findings`, for the same reason the
   * `devices:core` skip is not a finding: `findings` is what makes `doctor` say
   * PROBLEMS, and no hermetic command can clear either kind on its own. A stale
   * device is deleted in a console hermetic's OAuth client has no scope to
   * reach, and a legacy node keeps its hostname until it is recreated, so a
   * fleet with one of either would answer "PROBLEMS" for ever — which teaches
   * an operator to stop reading the answer. It is still *said*, per agent; it
   * is a detail of the tailnet, not a failure of the fleet.
   */
  for (const a of agents) {
    if (a.status !== "ready") continue;
    const mismatch = agentHostnameMismatch(
      a,
      tailnet || null,
      cloudName(fleet?.fleet_id, a.name),
      legacyCloudNames(fleet?.fleet_name, a.name),
    );
    if (!mismatch) continue;
    /**
     * A readable device list means the OAuth client has `devices:core`, and
     * therefore that `recreate` can delete the corpse itself (§6.5) — so the
     * note offers the command instead of leaving the admin console as the only
     * way out. Without the scope the console *is* the only way out, and the
     * note stays as it was.
     */
    const byHand =
      mismatch.kind === "stale" && devices !== null
        ? ` — hermetic agent recreate ${a.name} will remove it`
        : "";
    /**
     * What the canonical name does *today* — the sentence an operator needs to
     * know whether a bookmark is dangerous. A stale device answers on it and is
     * the wrong machine; nothing at all holds a legacy node's canonical name,
     * so the URL simply fails to resolve.
     */
    const meanwhile =
      mismatch.kind === "stale"
        ? `until then ${mismatch.canonical} resolves to the dead node (tailscale_stale_device)`
        : `until then nothing answers to ${mismatch.canonical} (tailscale_legacy_name)`;
    /**
     * A *legacy* name on a box built before the rule moved is a fact of history,
     * and stays a note. A legacy name on a box this fleet built *after* it
     * adopted the rule is not history — it is a fleet whose published hermeticd
     * and stages predate the rule its laptop renders for, quietly building new
     * nodes under the old spelling. That has a remedy hermetic can name, so it
     * goes in `findings`, where the fleet's verdict can see it.
     *
     * It only ever narrows: a fleet with no v4 stamp, or an agent older than
     * that stamp, keeps the note it has always had.
     */
    const misnamed = mismatch.kind === "legacy" && builtUnderCurrentRule(a, fleet);
    tailscaleStale.push({
      agent: a.name,
      ...mismatch,
      ...(misnamed ? { misnamed: true } : {}),
      note: `${a.name}: ${staleDeviceNote(a.name, mismatch)}${byHand} — ${meanwhile}`,
    });
    if (misnamed) {
      findings.push(
        `${a.name} was created after this fleet adopted fleet-id naming but came up as ` +
          `${mismatch.real} rather than ${mismatch.canonical}: the release this fleet publishes is ` +
          "older than the rule. Run `hermetic artifacts push`, then " +
          `\`hermetic agent recreate ${a.name}\` (tailscale_misnamed)`,
      );
    }
  }

  /**
   * §5: the fleet's network mode, reconciled the way everything else here is.
   *
   * Read through `networkStatus`, and its failure is a *note*, not a crash:
   * `doctor` is the command an operator runs because something is already
   * wrong, and a read that could not be made must not take the other twenty
   * checks down with it. That is the same rule `policyStatus` follows above,
   * and the same one the device list follows — what differs is only which of
   * the results become findings.
   */
  const networkNotes: string[] = [];
  let network: DoctorReport["network"] = {
    mode: null,
    stack_mode: null,
    consistent: false,
    nat: null,
    checked_nat: false,
    notes: networkNotes,
    drifted: [],
  };
  try {
    const report = await deps.networkStatus();
    const driftedAgents = report.agents.filter((a) => a.placement === "drifted").map((a) => a.name);
    network = {
      mode: report.mode,
      stack_mode: report.stack_mode,
      consistent: report.consistent,
      nat: report.nat,
      // A `public` fleet has no NAT appliance to look at, and a `nat` fleet
      // whose resources could not be read has one nobody could look at. Both
      // are "unchecked"; neither is a pass.
      checked_nat: report.stack_mode === "nat" && report.nat !== null,
      notes: networkNotes,
      drifted: driftedAgents,
    };
    /**
     * §8.3: a Bedrock model this fleet names but its role may not invoke.
     *
     * Reported against what `_fleet` records rather than against this build's
     * defaults — the question is what this fleet's own stack allows — and only
     * when it records anything at all, because a fleet the v10 migration has
     * not reached has an unrecorded grant rather than an empty one.
     */
    if (fleet?.bedrock_model_ids !== undefined) {
      const stale = staleBedrockGrants({
        settings: settingsOf(fleet).settings,
        agents,
        granted: fleet.bedrock_model_ids,
      });
      if (stale.length > 0) {
        findings.push(
          `this fleet's provider profiles or agents name ${stale.length} Bedrock model(s) its agent role may not invoke (${stale.join(", ")}); \`hermetic foundation update\` grants them (bedrock_grant_stale)`,
        );
      }
    } else if (fleet !== null && fleet !== undefined) {
      /**
       * The third state, reported rather than passed over (§8.3).
       *
       * A fleet the v10 migration has not reached records no grant at all, and
       * the check above is therefore silent on it — which reads exactly like a
       * clean bill on the one fleet where nobody has checked. It is not a
       * failure: the stack grants whatever an older build gave it, and every
       * agent running on it goes on running. It is an *unchecked* policy, and
       * `doctor` exists to say which of its checks did not happen.
       */
      findings.push(
        `this fleet has never recorded which Bedrock models its agent role may invoke, so whether a model it names is granted cannot be checked; \`hermetic foundation update\` reconciles the grant and records it (bedrock_grant_unrecorded)`,
      );
    }
    if (!report.consistent) {
      findings.push(
        report.mode === null
          ? `the ${FLEET_KEY} item records no network mode but the stack is \`${report.stack_mode ?? "unknown"}\`; \`hermetic foundation update\` back-fills it (network_mode_unrecorded)`
          : `the ${FLEET_KEY} item records network \`${report.mode}\` but the stack says \`${report.stack_mode ?? "unknown"}\`; the stack is authoritative — \`hermetic foundation update\` back-fills the cache (network_mode_drift)`,
      );
    }
    if (network.checked_nat && network.nat !== null) {
      /**
       * `null` is "the read did not happen", not "the instance is unhealthy".
       * Reporting the fleet as having no internet because a `DescribeInstances`
       * was denied would be a red `doctor` caused entirely by an IAM policy, and
       * the operator would go looking at a NAT that is running perfectly well.
       */
      if (network.nat.instance_state === null) {
        networkNotes.push(
          `the state of the NAT instance ${network.nat.instance_id ?? "(unknown)"} could not be read, so whether this fleet has egress is unchecked — not a clean bill. \`ec2:DescribeInstances\` is what the read needs`,
        );
      } else if (network.nat.instance_state !== "running") {
        findings.push(
          `the NAT instance ${network.nat.instance_id ?? "(unknown)"} this fleet's egress depends on is ${network.nat.instance_state}; every agent is without internet access until it is running again (nat_instance_down)`,
        );
      }
      if (network.nat.route_state === null) {
        networkNotes.push(
          "the private subnets' default route could not be read, so whether it still resolves to the NAT instance is unchecked — not a clean bill. `ec2:DescribeRouteTables` is what the read needs",
        );
      } else if (network.nat.route_state === "blackhole") {
        findings.push(
          "the private subnets' default route is blackholed: it is pinned to a NAT instance that no longer exists, so the fleet has no egress at all. Re-apply the foundation stack to rebuild the route (nat_route_blackhole)",
        );
      }
    }
    if (driftedAgents.length > 0) {
      findings.push(
        `${driftedAgents.join(", ")} ${driftedAgents.length === 1 ? "is" : "are"} in a subnet this fleet no longer launches into, left behind by a network mode change; run \`hermetic agent recreate <name>\` for each (network_agent_drift)`,
      );
    }
  } catch {
    // Unreadable, and said as such by `checked_nat: false` and the nulls above.
  }

  return {
    ok: findings.length === 0,
    account: { frozen: config.account_id, observed: id.account_id, ok: accountOk },
    fleet: { local: config.fleet_id, stack_tag: stackTag, fleet_item: fleetItemId, ok: fleetOk },
    foundation: {
      present: stack !== null,
      status: stack?.status ?? null,
      outdated: foundationOutdated,
      version: foundationVersion,
      available_version: deps.available.foundationVersion,
    },
    security_group: { inbound_rules: inbound.length, ok: inbound.length === 0 },
    legacy_parameters,
    directory,
    env_overrides,
    unparseable_rows,
    heartbeats,
    findings,
    instance_drift,
    tailscale: {
      available: devices !== null,
      missing: tailscaleMissing,
      stale: tailscaleStale,
      detail: tailscaleDetail,
      policy,
    },
    local_tailscale,
    network,
  };
}
