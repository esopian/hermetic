/**
 * The create branch of `init` (§4.7 step 4): the Tailscale preflight gate, the
 * foundation stack, the OAuth secret, the AMI pin, the `_fleet` item, the
 * directory entry, the release push, the freeze and the readiness report — in
 * that order, for the reasons each step's comment gives. Runs on the far side
 * of the confirmation gate, with the directory already made.
 */
import {
  FLEET_KEY,
  FLEET_MANIFEST_KEY,
  DEFAULT_ROOT_GIB,
  defaultFleetSettings,
} from "../schema/index.ts";
import type { DirectoryStatus, FleetItem, OpEvent } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { mintFleetId } from "./fleet-id.ts";
import {
  tailscaleOauthClientIdPath,
  tailscaleOauthSecretPath,
  UBUNTU_RELEASE,
} from "../backend/constants.ts";
import { clientIdFromSecret } from "../aws/tailscale.ts";
import { DEFAULT_BEDROCK_MODEL_IDS } from "../aws/index.ts";
import { writeHermeticPolicy } from "./policy.ts";
import { foundationResourceCount, foundationTemplateSha256 } from "../aws/cfn-template.ts";
import { FOUNDATION_VERSION } from "../version.ts";
import { TAILSCALE_DOWNLOAD_URL } from "./preflight.ts";
import type { StackSummary } from "../backend/types.ts";
import type { InitDeps, InitOpOptions, InitRun } from "./init-run.ts";
import { evt } from "../events.ts";
import { checkAbort } from "../abort.ts";
import { directoryEntry, registerFleet } from "./init-directory.ts";
import { ensureRelease, locateHermeticd } from "./init-release.ts";
import { freeze } from "./init-freeze.ts";
import {
  FOUNDATION_PROGRESS_FROM,
  FOUNDATION_PROGRESS_TO,
  fmtElapsed,
  narrateStackCreate,
} from "./init-narrate.ts";

/** Create a new fleet; `live` is every non-deleting stack in the account, `directory` the table as `ensureDirectory` left it. */
export async function* create(
  deps: InitDeps,
  run: InitRun,
  opts: InitOpOptions,
  live: StackSummary[],
  directory: DirectoryStatus,
): AsyncIterable<OpEvent> {
  const { localTailscale } = deps;
  const { backend, hermeticdVersion, nowIso } = deps.ctx;
  const { parsed, id, directoryApi } = run;

  /**
   * §4.7 preflight, and the last read before the first mutation.
   *
   * Tailscale is the only way in and it is required (§1): a foundation created
   * from a machine that is not on a tailnet is a fleet whose own operator
   * cannot reach a single agent on it, discovered ten minutes later when the
   * first box boots. So the gate stands here rather than in a head — the CLI
   * and the wizard are both in front of it, and neither can be the only one
   * that checks.
   *
   * `--skip-tailscale-check` is the headless escape hatch, and it is recorded
   * on the op: the fleet it produces is reachable only by whoever *is* on the
   * tailnet.
   */
  const preflight = await localTailscale();
  if (!preflight.ok && parsed.skip_tailscale_check !== true) {
    throw new HermeticError(
      "TAILSCALE_UNAVAILABLE",
      `${preflight.problem ?? "tailscale is not usable on this machine"}. Every agent is reachable only over Tailscale, so a foundation created from here would be unreachable. ${preflight.installed ? "Fix it" : `Install it from ${TAILSCALE_DOWNLOAD_URL}`} and retry, or pass --skip-tailscale-check.`,
      {
        installed: preflight.installed,
        running: preflight.running,
        backend_state: preflight.backend_state,
        /**
         * Where to go, for a head that would rather render a link than a
         * sentence. Only when it is the answer: a logged-out machine already
         * has Tailscale, and telling it to download one is noise.
         */
        ...(preflight.installed ? {} : { download_url: TAILSCALE_DOWNLOAD_URL }),
      },
    );
  }

  let fleet_id = mintFleetId();
  /**
   * A minted id that already names a stack is a one-in-a-trillion collision,
   * and it would name the *new* fleet's stack after somebody else's. Mint
   * again rather than find out from CloudFormation.
   */
  const usedIds = new Set([
    ...live.flatMap((s) => (s.fleet_id === null ? [] : [s.fleet_id])),
    ...directory.fleets.map((e) => e.fleet_id),
  ]);
  for (let attempt = 0; usedIds.has(fleet_id) && attempt < 8; attempt += 1) fleet_id = mintFleetId();
  if (usedIds.has(fleet_id)) {
    throw new HermeticError("CONFLICT", "could not mint a fleet id that is free in this account");
  }
  const region = parsed.region ?? "us-east-1";
  const network = parsed.network ?? "public";
  /**
   * Serve publishes each agent at `https://<name>.<tailnet>`, and the render
   * has to write that URL into a final file — there is no templating on the box
   * (§6.4), so the fleet has to be stamped with the tailnet it lives on.
   *
   * It is not asked for: the tailnet this machine is on is the tailnet the
   * fleet belongs to, which is the same assumption the gate above rests on.
   * An explicit `tailnet` overrides the detected one — an operator who typed
   * it said something deliberate — and a disagreement is reported rather than
   * refused (§3.2 rule 1: core does not argue with a head's operator).
   */
  const tailnet = parsed.tailnet ?? preflight.tailnet;
  if (!tailnet) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      "creating a foundation needs the tailnet name (e.g. acme.ts.net); it is stamped on `_fleet` and used for every Serve URL, and this machine's tailscale could not be asked for it",
      {},
    );
  }
  if (preflight.ok) {
    yield evt(
      "preflight",
      0.3,
      `tailscale ${preflight.backend_state?.toLowerCase() ?? "up"} on ${preflight.tailnet}${preflight.hostname ? ` as ${preflight.hostname}` : ""}`,
      nowIso(),
    );
  } else {
    yield evt(
      "preflight",
      0.3,
      `tailscale check skipped: ${preflight.problem ?? "not usable on this machine"}`,
      nowIso(),
      "warn",
    );
  }
  if (preflight.tailnet !== null && tailnet !== preflight.tailnet) {
    yield evt(
      "preflight",
      0.32,
      `creating the fleet on ${tailnet}, but this machine is on ${preflight.tailnet}`,
      nowIso(),
      "warn",
    );
  }
  const hermeticd = yield* locateHermeticd(deps, parsed.skip_artifacts === true, true);

  /**
   * The foundation. CloudFormation takes minutes and says nothing to a caller
   * that only awaits it, so the wait is narrated: a `start` so heads show the
   * right step, every resource as it lands (`Vpc CREATE_COMPLETE (3/31)`),
   * a heartbeat when nothing has landed for a while, and a `done` with what
   * came out. A failure names the resource and CloudFormation's reason.
   */
  const total = foundationResourceCount(network);
  const stackStartedAt = Date.now();
  yield evt(
    "foundation",
    FOUNDATION_PROGRESS_FROM,
    `creating the foundation: VPC, sealed security group, agent role, bucket, 2 tables, snapshot policy (${total} resources, typically 2–4 min)`,
    nowIso(),
    undefined,
    "start",
  );
  const stack = yield* narrateStackCreate(
    deps,
    backend.foundation.createStack.bind(backend.foundation),
    {
      fleet_id,
      network,
      tags: { fleet_id, hermetic_version: hermeticdVersion },
      signal: opts.signal,
    },
    total,
  );
  const outputs = Object.entries(stack.outputs)
    .filter(([k]) => /^(Bucket|BucketName|VpcId|Vpc)$/.test(k))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  yield evt(
    "foundation",
    FOUNDATION_PROGRESS_TO,
    `created stack ${stack.stack_name} (${network}) in ${fmtElapsed(Date.now() - stackStartedAt)}${outputs ? ` — ${outputs}` : ""}`,
    nowIso(),
    undefined,
    "done",
  );

  // Not in CloudFormation: the OAuth client must be made by hand in the admin
  // console, scoped to `auth_keys` write *and* `devices:core` read/write, both
  // restricted to `tag:hermetic` (§5). Both halves of the credential
  // are recorded: the secret in its SecureString slot and nowhere else (§8.3),
  // and the client id — parsed from the secret, not asked for — in its own
  // slot and on `_fleet`, because rotating or revoking the client later
  // starts with knowing which one it is.
  let tailscale_oauth_client_id: string | null = null;
  if (parsed.tailscale_oauth_secret !== undefined) {
    tailscale_oauth_client_id = clientIdFromSecret(parsed.tailscale_oauth_secret);
    await backend.secrets.ensureSlot(tailscaleOauthSecretPath(fleet_id));
    await backend.secrets.put(tailscaleOauthSecretPath(fleet_id), parsed.tailscale_oauth_secret);
    if (tailscale_oauth_client_id !== null) {
      await backend.secrets.ensureSlot(tailscaleOauthClientIdPath(fleet_id));
      await backend.secrets.put(tailscaleOauthClientIdPath(fleet_id), tailscale_oauth_client_id);
    }
    yield evt(
      "tailscale",
      0.65,
      `tailscale OAuth client secret stored in SSM${tailscale_oauth_client_id ? ` (client ${tailscale_oauth_client_id})` : ""}`,
      nowIso(),
    );
  } else {
    yield evt(
      "tailscale",
      0.65,
      "no tailscale OAuth client secret supplied; agents cannot be created until one is pushed",
      nowIso(),
      "warn",
    );
  }

  checkAbort(opts.signal, "ami");
  // The whole fleet boots the same image until it is deliberately bumped (§6.2).
  const ami_id = await backend.compute.resolveUbuntuAmi();
  yield evt("ami", 0.75, `pinned Ubuntu ${UBUNTU_RELEASE} arm64 image ${ami_id}`, nowIso());

  const defaults: FleetItem["defaults"] = {
    size: "medium",
    provider: "bedrock",
    volume_gib: 100,
    root_gib: DEFAULT_ROOT_GIB,
    secrets: "none",
  };
  const createdAt = nowIso();
  const item: FleetItem = {
    fleet_id,
    defaults,
    /**
     * §4.6: a fleet created by this build starts with settings, so nothing on
     * a fresh fleet depends on the v2 migration having run — the migration
     * exists for fleets created before them, and the two agree because both
     * call `defaultFleetSettings`.
     */
    settings: defaultFleetSettings(defaults, id.arn, createdAt),
    ubuntu_release: UBUNTU_RELEASE,
    ami_id,
    tailnet,
    tailscale_oauth_client_id,
    min_hermetic_version: hermeticdVersion,
    // §6.6: a fleet created by this build is on this build's foundation
    // contract, recorded with the digest of the template that made it — so a
    // template edit that forgot to bump the version still shows up as an
    // available update rather than silently matching.
    foundation_version: FOUNDATION_VERSION,
    foundation_template_sha256: foundationTemplateSha256(),
    // §5: the mode the stack was just created with, cached on `_fleet` so a
    // head can answer "which side of a NAT is this fleet on" without a
    // `DescribeStacks`. `create` is the one place the `public` default is
    // legitimately applied — everywhere else, absent means "not recorded".
    network,
    /**
     * §8.3: the Bedrock model ids the stack just granted this fleet's agent
     * role, recorded here so `providers ls` and `agents.create` can answer
     * "may this fleet invoke that model" without a `DescribeStacks`.
     *
     * `create` is the one place the defaults are legitimately written —
     * `createStack` passed exactly these ARNs a moment ago — and everywhere
     * else absent means "not recorded" rather than "the defaults", which is
     * what the v10 migration back-fills from the stack itself.
     */
    bedrock_model_ids: [...DEFAULT_BEDROCK_MODEL_IDS],
    region,
    bucket:
      stack.outputs["BucketName"] ?? stack.outputs["Bucket"] ?? `hermetic-${id.account_id}-${region}`,
    stack_id: stack.stack_id,
    created_by: id.arn,
    created_at: createdAt,
  };
  await backend.store.fleet.put(item);
  yield evt("fleet", 0.85, `wrote the ${FLEET_KEY} item`, nowIso());

  /**
   * §4.8: after `_fleet` and before the freeze. After, because the entry
   * records facts only the created fleet has (its stack id, its tailnet);
   * before, because a home frozen to a fleet the directory has never heard of
   * is a home whose `fleet ls` would not list its own fleet.
   */
  checkAbort(opts.signal, "directory");
  await registerFleet(
    directoryApi,
    directoryEntry(id, nowIso, {
      name: null,
      fleet_id,
      region,
      stack_id: stack.stack_id,
      foundation_version: FOUNDATION_VERSION,
      tailnet,
      created_at: createdAt,
    }),
  );
  yield evt(
    "directory",
    0.87,
    `registered fleet ${fleet_id} in the ${directoryApi.region} directory`,
    nowIso(),
  );

  // The fleet manifest's `resources` come from the stack's own outputs, so it
  // is written after the `_fleet` row and never from a guess (§1).
  yield* ensureRelease(deps, id, 0.92, hermeticd, parsed.skip_artifacts === true, item, stack);
  checkAbort(opts.signal, "freeze");
  await freeze(deps, run, fleet_id, region, null);

  /**
   * "Done" has to mean "run `agent create`". Everything the first agent needs
   * is checked once more and said in one place, so the things that are *not*
   * ready are the last lines an operator reads rather than warnings that
   * scrolled by mid-op.
   */
  const published = await backend.artifacts.exists(FLEET_MANIFEST_KEY);
  yield evt(
    "ready",
    0.96,
    published
      ? `the fleet manifest names hermeticd ${hermeticdVersion}`
      : `no fleet manifest in the bucket — run \`hermetic artifacts push\` before the first agent`,
    nowIso(),
    published ? undefined : "warn",
  );
  yield evt(
    "ready",
    0.97,
    `Ubuntu ${UBUNTU_RELEASE} arm64 image ${ami_id} pinned on ${FLEET_KEY}`,
    nowIso(),
  );
  if (parsed.tailscale_oauth_secret !== undefined) {
    // Proved by using it: a tagged key minted and revoked also proves the
    // tailnet policy has its `tagOwners` entry, and a device listing proves
    // the second scope (§4.7).
    const check = await deps.verifyTailscaleOauth(parsed.tailscale_oauth_secret);
    const named = tailscale_oauth_client_id ? ` ${tailscale_oauth_client_id}` : "";
    yield evt(
      "ready",
      0.98,
      check.ok
        ? `tailscale OAuth client${named} can mint tag:hermetic keys${check.can_list_devices ? ", list devices" : ""}${check.policy_scope === "write" ? " and edit the policy file" : check.policy_scope === "read" ? " and read the policy file" : ""}; the tailnet policy has its tagOwners entry`
        : `tailscale OAuth client stored but not usable: ${check.problem ?? "could not mint a tag:hermetic key"}`,
      nowIso(),
      check.ok ? undefined : "warn",
    );
    /**
     * A client that mints but cannot list devices is a working fleet with one
     * capability missing, so it is a second, quieter line rather than a
     * failure — and it is said here, at the end, where the operator is being
     * told what is and is not ready.
     */
    if (check.ok && (!check.can_list_devices || check.policy_scope !== "write")) {
      yield evt(
        "ready",
        0.98,
        `tailscale OAuth client${named} ${check.problem ?? "is missing a second scope"}`,
        nowIso(),
        "warn",
      );
    }
  } else {
    yield evt(
      "ready",
      0.98,
      `no tailscale OAuth client secret stored — push one to ${tailscaleOauthSecretPath(fleet_id)} before the first agent`,
      nowIso(),
      "warn",
    );
  }

  /**
   * §4.7: hermetic's own three entries in the tailnet policy — only those
   * three, between `// hermetic:managed` markers, with every other byte of
   * the operator's policy returned unchanged (`policy.ts`).
   *
   * Last, and deliberately so. This used to run right after the OAuth secret
   * landed in SSM, which put it before the `_fleet` item, the config freeze
   * and `ensureRelease` — so an `init` that failed at any of those left
   * hermetic's blocks in somebody's policy file with no frozen config, and
   * therefore no `hermetic teardown` and no `hermetic policy`, able to find
   * or remove them. Running it after the freeze means the two commands that
   * clean up after it exist by the time there is anything to clean up.
   *
   * Never fatal, wherever it runs. A client without `policy_file` is the
   * state every fleet created before this build is in, and the answer is the
   * same paste-ready snippet the heads have always printed. `--skip-policy`
   * is the flag for an operator whose policy is deployed from git, where a
   * write from here would be reverted by their next deploy.
   */
  if (parsed.tailscale_oauth_secret !== undefined && parsed.skip_policy !== true) {
    checkAbort(opts.signal, "policy");
    const written = await writeHermeticPolicy(backend);
    yield evt(
      "policy",
      0.99,
      written.kind === "written"
        ? `policy: hermetic entries written (${written.keys.join(", ")})${written.skipped.length > 0 ? `; ${written.skipped.join(", ")} left as you pasted it` : ""}`
        : written.kind === "current"
          ? "policy: the tailnet policy already says what hermetic would say"
          : `policy: not written (${written.reason}); apply the snippet by hand — \`hermetic policy\` shows what is missing`,
      nowIso(),
      written.kind === "manual" ? "warn" : undefined,
    );
  } else if (parsed.skip_policy === true) {
    yield evt(
      "policy",
      0.99,
      "policy: --skip-policy, so the tailnet policy is untouched; apply the snippet from `hermetic policy` yourself",
      nowIso(),
      "warn",
    );
  }

  yield evt(
    "done",
    1,
    `fleet ${fleet_id} created in ${id.account_id} · ${region} — next: hermetic agent create <name>`,
    nowIso(),
  );
}
