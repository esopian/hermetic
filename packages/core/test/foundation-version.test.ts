/**
 * The lock on the foundation contract (§6.6, spec §1).
 *
 * `FOUNDATION_VERSION` numbers the contract; the template digest is what
 * actually changed. Keeping the two in a table here means a template edit
 * cannot land quietly: the digest moves, this test fails, and the author has to
 * decide whether the change is a new contract version (bump, add a migration,
 * add a row here) or the same one (update the row, and say why in the commit).
 *
 * It is deliberately a hand-written literal and not a snapshot: `bun test -u`
 * must not be able to update it.
 */
import { describe, expect, test } from "bun:test";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { foundationTemplateBody, foundationTemplateSha256 } from "../src/aws/cfn-template.ts";
import { FOUNDATION_MIGRATIONS, migrationsBetween } from "../src/fleet/foundation-migrations.ts";

/** Foundation version → the sha256 of the template that version applies. */
const FOUNDATION_TEMPLATE_SHA256: Record<number, string> = {
  1: "e17c327ab25553fbd963ba5be4452da11d85b2b422e2680971ec56631e0cdd5e",
  // v2 is a *state* change and not a template one — `_fleet` gains `settings`,
  // CloudFormation gains nothing — so it applies the same template v1 did, and
  // the repeated digest is the record of that rather than an oversight.
  2: "e17c327ab25553fbd963ba5be4452da11d85b2b422e2680971ec56631e0cdd5e",
  // v3 *is* a template change, in two places: the agent role's SSM statement is
  // scoped from `parameter/hermes/*` to `parameter/hermes/${FleetId}/*`, and the
  // DLM policy's target tags gain the fleet id (DLM ANDs them), so two fleets in
  // one account stop sharing every box's keys and every box's snapshots. It is a
  // state change too — the parameters themselves move under the fleet id,
  // `_fleet` gains `fleet_name`, and EC2/EBS gain the `hermetic:fleet_id` tag —
  // which is what the v3 migration carries forward.
  3: "7ebd554644003fc6eee264f64eaf4d7f0d1d502ff2f3588928181d1317039d2f",
  // v4 is a *state* change and not a template one — a cloud name is built from
  // `fleet_id` instead of `fleet_name` (`cloudName`), which moves what new
  // instances, volumes and tailnet nodes are called and nothing CloudFormation
  // owns — so it applies the same template v3 did, and the repeated digest is
  // the record of that rather than an oversight.
  4: "7ebd554644003fc6eee264f64eaf4d7f0d1d502ff2f3588928181d1317039d2f",
  // v5 *is* a template change: the bucket gains a `LifecycleConfiguration` that
  // expires noncurrent object versions and expired delete markers, so versioning
  // stops growing without bound. Nothing but the template moves — no state — so
  // the v5 migration entry carries no hooks.
  5: "8fc91501bb2a9b89f6d8dfa46f649b265b31d3ccebae97456eb1a0f9d8120b9b",
  // v6 is both, and it stacks on v5's bucket rules rather than replacing them.
  // The template half is the `nat` branch being finished: `NatEip` +
  // `NatEipAssociation` give a `nat` fleet a stable egress address instead of
  // one that changes under every replacement, and `EgressOnlyInternetGateway` +
  // `PrivateDefaultRouteV6` + an `Ipv6CidrBlock` /64 on each private subnet make
  // it dual-stack like `public` already was. Two new outputs come with it
  // (`Network`, and `NatEgressIp` for `nat` only). A `public` fleet's stack is
  // untouched — every added resource is gated on `IsNat` — but the *template*
  // digest moves for both, which is why this row differs from v5's. The state
  // half is `_fleet.network`, back-filled by the v6 migration from the stack's
  // own `Network` parameter.
  6: "336a38bed436008034beb28f17ae78578ac1897e40d4108fc52c35f7fd4df04b",
  // v7 *is* a template change, in the agent role's policy only, and it stacks on
  // v6 rather than replacing anything: `hermes/*` is added to the S3 read and to
  // the `ListBucket` prefix condition so a box can fetch the Hermes source bundle
  // the laptop mirrors (§3.6), and a separate read-only Bedrock statement grants
  // `ListFoundationModels` / `ListInferenceProfiles`, which `hermes doctor` and
  // the model picker call and which no ARN can scope. No state moves; the
  // migration records the widening and nothing else.
  7: "34dd2a240c621d2c054fabefc856a68fa9aaa6d81b289157f7e0876d922ab692",
  // v8 is a *state* change and not a template one — the agent row gains the two
  // fields a box writes about itself (`running_hermeticd_sha256`,
  // `running_hermes_version`) and the fleet manifest's `hermetic_version` starts
  // carrying the tool build it always claimed to, none of which CloudFormation
  // owns — so it applies the same template v7 did, and the repeated digest is
  // the record of that rather than an oversight. The v8 migration carries no
  // hooks for the reason spelled out there: only a box can write either field,
  // so there is nothing for a laptop to back-fill.
  8: "34dd2a240c621d2c054fabefc856a68fa9aaa6d81b289157f7e0876d922ab692",
  9: "34dd2a240c621d2c054fabefc856a68fa9aaa6d81b289157f7e0876d922ab692",
  // v10 is a *state* change and not a template one. `BedrockModelArns` has been
  // a parameter, and the agent role's `bedrock:InvokeModel*` statement has read
  // it, since v1; what moves is who decides its value. Until now it was decided
  // once at `init` and carried forward by every update (`UsePreviousValue`), so
  // a fleet could never be granted a model that did not exist when it was
  // created. From v10 `foundation update` computes the set the fleet needs from
  // its provider profiles and its agents, states it, and records the result on
  // `_fleet.bedrock_model_ids` — which the v10 migration back-fills from the
  // stack's current parameter first, so a grant an older build gave is unioned
  // rather than recomputed away. The repeated digest is the record of the
  // template standing still.
  10: "34dd2a240c621d2c054fabefc856a68fa9aaa6d81b289157f7e0876d922ab692",
  // v11 is a *state* change and not a template one, for v8's reason and in v8's
  // shape: the agent row gains `tailscale_version`, a fact only a box can state,
  // and `stages/01-tailscale.sh` turns Tailscale's own updater on so that the
  // version it states actually moves. Neither is CloudFormation's — a stage
  // reaches a box through `artifacts push`, not through a stack update — so the
  // template stands still and the digest repeats.
  11: "34dd2a240c621d2c054fabefc856a68fa9aaa6d81b289157f7e0876d922ab692",
  // v12 *is* a template change, in the agent role only, and it is a narrowing
  // rather than a widening: the role stops attaching
  // `AmazonSSMManagedInstanceCore` and states that policy's contents inline
  // minus `ssm:GetParameter`/`ssm:GetParameters`. The managed policy granted
  // both on `Resource: "*"` and IAM unions an attached policy with an inline
  // one, so the fleet-scoped `FleetParameters` statement narrowed at v3 was
  // bounding nothing — a box could read any parameter name in the account,
  // including its own fleet's Tailscale OAuth secret. Session Manager still
  // works: the `ssmmessages`/`ec2messages`/SSM-agent half is carried over
  // verbatim. No state moves, so the v12 migration carries only notes.
  12: "9bc5961a952866b444383b4e12001829f8e7c56d111a60ee6f5f17bdfea228f0",
  // v13 is a *state* change and not a template one, so it applies the same
  // template v12 did. `_fleet` gains `version`, the revision counter every
  // fleet-wide write is now conditional on (§4.4). It is optional on read —
  // absent still means 0 — which is exactly why the contract had to move: a
  // build that predates the field parses a row carrying it and writes the item
  // back without it, rewinding the counter and letting two replacements
  // composed against the same revision both succeed. The bump is what lets
  // `guardFleet` refuse such a build with `FOUNDATION_NEWER` before it writes.
  13: "9bc5961a952866b444383b4e12001829f8e7c56d111a60ee6f5f17bdfea228f0",
  // v14 *is* a template change, in the agent role's policy only, and it stacks
  // on v13 rather than replacing anything: `browser/*` is added to the S3 read
  // and to the `ListBucket` prefix condition, so a box can fetch the Chrome for
  // Testing build the laptop mirrors (§7.3). It is the grant every create now
  // requires, because every agent runs a browser.
  // The bucket's lifecycle rules are untouched — the new prefix falls under the
  // whole-bucket 30-day rule, which is right for an object re-pushed
  // idempotently by key. No state moves, so the v14 migration carries no hooks.
  14: "e028920a3a6c0a0fc5c6f895355190d71317e07f3248f2be943bd2e186503804",
  // v15 changes neither the template nor any state: it applies the same
  // template v14 did, and the repeated digest is the record of that rather
  // than an oversight. The contract number moves because the *release* has to
  // reach every box — the rendered sudoers grant, the per-agent
  // `approvals_mode` setting and `hermeticd`'s advisory `approvals` check all
  // travel by `artifacts push` and rollout, not by a stack update, and
  // `foundation update` is the one operator-invoked path that runs both in
  // order. The bump is what makes `update_available` true so a fleet still on
  // the old grant says so. The stack phase takes the empty change set as the
  // no-op it is (`stack already at this template`).
  15: "e028920a3a6c0a0fc5c6f895355190d71317e07f3248f2be943bd2e186503804",
};

describe("foundation version", () => {
  test("the template matches the digest recorded for this version", () => {
    expect(foundationTemplateSha256()).toBe(
      FOUNDATION_TEMPLATE_SHA256[FOUNDATION_VERSION] ??
        "the template changed — bump FOUNDATION_VERSION, add a migration if state changes, update this table",
    );
  });

  test("the digest is of the body that is actually uploaded", async () => {
    const digest = new Bun.CryptoHasher("sha256").update(foundationTemplateBody()).digest("hex");
    expect(foundationTemplateSha256()).toBe(digest);
  });

  test("every version up to this one has a migration entry, in order", () => {
    const versions = FOUNDATION_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.at(-1)).toBe(FOUNDATION_VERSION);
    for (const m of FOUNDATION_MIGRATIONS) expect(m.describe.length).toBeGreaterThan(0);
  });

  test("migrationsBetween is exclusive of `from` and inclusive of `to`", () => {
    expect(migrationsBetween(0, 1).map((m) => m.version)).toEqual([1]);
    expect(migrationsBetween(0, 2).map((m) => m.version)).toEqual([1, 2]);
    expect(migrationsBetween(1, 2).map((m) => m.version)).toEqual([2]);
    expect(migrationsBetween(2, 3).map((m) => m.version)).toEqual([3]);
    expect(migrationsBetween(0, 3).map((m) => m.version)).toEqual([1, 2, 3]);
    expect(migrationsBetween(3, 5).map((m) => m.version)).toEqual([4, 5]);
    expect(migrationsBetween(4, 7).map((m) => m.version)).toEqual([5, 6, 7]);
    expect(migrationsBetween(6, 8).map((m) => m.version)).toEqual([7, 8]);
    // Already there: nothing to re-run, which is what makes the phase idempotent.
    expect(migrationsBetween(1, 1)).toEqual([]);
    expect(migrationsBetween(1, 0)).toEqual([]);
  });
});
