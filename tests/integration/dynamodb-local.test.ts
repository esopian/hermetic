/**
 * §11.2: core against DynamoDB Local.
 *
 * Every other DynamoDB test in the tree runs against `aws-sdk-client-mock`,
 * which never parses a `ConditionExpression`. That double can prove the store
 * *sends* the right condition; it cannot prove the service *enforces* it. This
 * suite is the other half: a real DynamoDB engine, real conditional writes,
 * real concurrency, and the two writers that share the agents table — core's
 * stores on the laptop and hermeticd's heartbeat on the box.
 *
 * It is opt-in. `HERMETIC_DYNAMODB_LOCAL` holds the endpoint
 * (`http://127.0.0.1:8000`); without it every test here is skipped, so the
 * default `bun test` stays offline. To run it:
 *
 *     docker run -p 8000:8000 amazon/dynamodb-local
 *     HERMETIC_DYNAMODB_LOCAL=http://127.0.0.1:8000 bun run test:dynamodb-local
 *
 * The endpoint seam is deliberately *not* a new option on `aws.client()`. The
 * client this suite points at DynamoDB Local is built here and then handed to
 * the already-exported `guardClient`, which can only ever *add* the account
 * guard — so there is no configuration anywhere that makes core talk to an
 * endpoint with the guard off. The last three tests in this file state that as
 * an assertion rather than as a claim.
 *
 * This file lives in root `tests/` because it reads both sides of a seam:
 * `packages/core/src` and `packages/agentd/src` may not import each other, and
 * the whole point here is that they write the same table.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AccountGuard } from "../../packages/core/src/aws/client.ts";
import { guardClient } from "../../packages/core/src/aws/client.ts";
import { createDynamoStores } from "../../packages/core/src/aws/dynamo.ts";
import { foundationTemplate } from "../../packages/core/src/aws/cfn-template.ts";
import { HermeticError } from "../../packages/core/src/errors.ts";
import { LOCK_TTL_MS } from "../../packages/core/src/fleet/fleet-lock.ts";
import { isLockLive } from "../../packages/core/src/agents/state.ts";
import type { StoreApi } from "../../packages/core/src/backend/types.ts";
import type { Agent, FleetItem, FleetSettings } from "../../packages/core/src/schema/index.ts";
import {
  FLEET_KEY,
  defaultFleetSettings,
  volumeClaimKey,
} from "../../packages/core/src/schema/index.ts";
import type { Aws, CommandSink } from "../../packages/agentd/src/aws.ts";
import { makeAws } from "../../packages/agentd/src/aws.ts";

const ENDPOINT = process.env["HERMETIC_DYNAMODB_LOCAL"] ?? "";
const OFFLINE = ENDPOINT === "";

const REGION = "us-west-2";
/**
 * DynamoDB Local signs nothing and stores data per (access key, region), so
 * these only have to be constant. They are the `FIXTURE` sentinels every other
 * fixture in the tree uses, so the leak-grep test has nothing new to look for.
 */
const CREDENTIALS = { accessKeyId: "FIXTURE", secretAccessKey: "FIXTURE" };

const T0 = new Date("2026-09-01T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** A table pair per test, so nothing one test writes is visible to the next. */
let suffix = 0;
let agentsTable = "";
let eventsTable = "";

/** How many times the account guard ran. Every send through core must move it. */
let guardCalls = 0;

let admin: DynamoDBClient | null = null;

function rawClient(): DynamoDBClient {
  return new DynamoDBClient({ region: REGION, endpoint: ENDPOINT, credentials: CREDENTIALS });
}

/** The long-lived client this suite creates and drops its tables with. */
function db(): DynamoDBClient {
  admin ??= rawClient();
  return admin;
}

async function countGuard(): Promise<void> {
  guardCalls += 1;
}

/** A DynamoDB Local client wearing an account guard, exactly as `aws.client()` leaves one. */
function guarded(guard: AccountGuard = countGuard): DynamoDBClient {
  return guardClient(rawClient(), guard);
}

function stores(guard?: AccountGuard): StoreApi {
  return createDynamoStores(guarded(guard), { agents: agentsTable, events: eventsTable });
}

/**
 * The `CreateTable` input for one of the foundation's tables, read out of the
 * CFN template rather than restated here.
 *
 * A local table that has drifted from the deployed one proves nothing, and the
 * drift would be silent: every assertion below would still pass against the
 * wrong key schema. So the keys come from `foundationTemplate()`, and the two
 * facts the template states by *omission* — no GSI, and deliberately no TTL
 * (§4.4: a TTL would delete the agent record, not the lock) — are asserted
 * rather than assumed, because an index or a TTL added there and not here would
 * change what these tests mean.
 */
function tableInput(logicalId: "AgentsTable" | "EventsTable", tableName: string) {
  const resource = foundationTemplate().Resources[logicalId];
  if (resource === undefined) throw new Error(`the foundation template has no ${logicalId}`);
  expect(resource["Type"]).toBe("AWS::DynamoDB::Table");
  const props = resource["Properties"] as Record<string, unknown>;
  expect(props["GlobalSecondaryIndexes"]).toBeUndefined();
  expect(props["LocalSecondaryIndexes"]).toBeUndefined();
  expect(props["TimeToLiveSpecification"]).toBeUndefined();
  expect(props["BillingMode"]).toBe("PAY_PER_REQUEST");
  return {
    TableName: tableName,
    AttributeDefinitions: props["AttributeDefinitions"] as {
      AttributeName: string;
      AttributeType: "S";
    }[],
    KeySchema: props["KeySchema"] as { AttributeName: string; KeyType: "HASH" | "RANGE" }[],
    BillingMode: "PAY_PER_REQUEST" as const,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "atlas",
    status: "creating",
    version: 0,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: REGION,
    instance_id: null,
    volume_id: null,
    volume_gib: 100,
    hermes_version: "0.15.0",
    hermeticd_version: "0.4.1",
    config_hash: null,
    provider: "bedrock",
    secrets_mode: "none",
    tailscale_ip: null,
    resources: { ssm_paths: [] },
    last_heartbeat: null,
    health: null,
    metrics: null,
    created_by: "arn:aws:iam::123456789012:user/FIXTURE",
    created_at: T0.toISOString(),
    updated_at: T0.toISOString(),
    ...overrides,
  };
}

const DEFAULTS = {
  size: "medium" as const,
  provider: "bedrock" as const,
  volume_gib: 100,
  secrets: "none" as const,
};

function fleetItem(overrides: Partial<FleetItem> = {}): FleetItem {
  return {
    fleet_id: "fxtr0001",
    defaults: DEFAULTS,
    ubuntu_release: "24.04",
    ami_id: "ami-0123456789abcdef0",
    min_hermetic_version: "0.5.0",
    tailnet: "example.ts.net",
    region: REGION,
    bucket: "hermetic-fxtr0001",
    stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic/abc",
    created_by: "arn:aws:iam::123456789012:user/FIXTURE",
    created_at: T0.toISOString(),
    version: 0,
    ...overrides,
  };
}

function settings(): FleetSettings {
  return defaultFleetSettings(DEFAULTS, "FIXTURE", T0.toISOString());
}

/** The SSM/S3 halves of `AwsDeps` this suite never reaches. */
const unreachable: CommandSink = {
  send() {
    throw new Error("this suite exercises DynamoDB only");
  },
};

function agentdAws(
  opts: { ddb?: CommandSink; warn?: (m: string) => void; now?: () => Date } = {},
): Aws {
  return makeAws({
    ddb:
      opts.ddb ??
      DynamoDBDocumentClient.from(rawClient(), { marshallOptions: { removeUndefinedValues: true } }),
    ssm: unreachable,
    s3: unreachable,
    agentsTable,
    eventsTable,
    now: opts.now ?? (() => T0),
    warn: opts.warn ?? (() => {}),
  });
}

/**
 * §5.1's `dynamodb:LeadingKeys`, simulated at the repository layer.
 *
 * hermetic has no production partition guard: the confinement is entirely in
 * the instance role's IAM policy (`cfn-template.ts`), and nothing in
 * `packages/agentd/src/aws.ts` compares the key it is writing against the agent
 * it is running as. So the condition is modelled here — the layer the IAM
 * policy sits in front of — and what the test proves is that hermeticd's writes
 * are all keyed by a single row, so that policy is sufficient to confine them.
 */
function leadingKeys(inner: CommandSink, signedAs: string): CommandSink {
  return {
    async send(command) {
      const input = (command as { input?: { TableName?: string; Key?: Record<string, unknown> } })
        .input;
      const key = input?.Key?.["name"];
      if (input?.TableName === agentsTable && typeof key === "string" && key !== signedAs) {
        const denied = new Error(
          `User is not authorized to perform dynamodb:UpdateItem on row ${key}: ` +
            `the instance role is scoped to ${signedAs}`,
        );
        denied.name = "AccessDeniedException";
        throw denied;
      }
      return inner.send(command);
    },
  };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "(resolved)";
  } catch (e) {
    return e instanceof HermeticError ? e.code : `(${String(e)})`;
  }
}

describe.skipIf(OFFLINE)("DynamoDB Local", () => {
  beforeEach(async () => {
    // Fail on the endpoint rather than inside an assertion about conditional
    // writes: an endpoint that is set but not listening should name itself.
    await db().send(new ListTablesCommand({}));
    suffix += 1;
    agentsTable = `hermetic-itest-${suffix}-agents`;
    eventsTable = `hermetic-itest-${suffix}-events`;
    guardCalls = 0;
    await db().send(new CreateTableCommand(tableInput("AgentsTable", agentsTable)));
    await db().send(new CreateTableCommand(tableInput("EventsTable", eventsTable)));
  });

  afterEach(async () => {
    await db().send(new DeleteTableCommand({ TableName: agentsTable }));
    await db().send(new DeleteTableCommand({ TableName: eventsTable }));
  });

  describe("create", () => {
    test("eight operators race one name and exactly one wins", async () => {
      const operators = Array.from({ length: 8 }, (_, i) => i);
      const results = await Promise.all(
        operators.map((i) =>
          stores().agents.putIfAbsent(
            agent({ name: "corvid", created_by: `arn:aws:iam::123456789012:user/op-${i}` }),
          ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);

      // And the loser's row is not half-written over the winner's.
      const rows = await stores().agents.scan();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("corvid");
    });

    test("a re-run of the same create is refused rather than clobbering the row", async () => {
      expect(await stores().agents.putIfAbsent(agent({ name: "corvid" }))).toBe(true);
      expect(await stores().agents.putIfAbsent(agent({ name: "corvid", status: "ready" }))).toBe(false);
      expect((await stores().agents.get("corvid"))?.status).toBe("creating");
    });
  });

  describe("optimistic concurrency", () => {
    test("a stale version is rejected with CONFLICT", async () => {
      await stores().agents.putIfAbsent(agent({ name: "atlas", version: 0 }));

      const first = await stores().agents.update("atlas", 0, { status: "ready" });
      expect(first.version).toBe(1);

      const stale = stores().agents.update("atlas", 0, { status: "error" });
      await expect(stale).rejects.toThrow(HermeticError);
      await expect(stale).rejects.toMatchObject({
        code: "CONFLICT",
        details: { name: "atlas", expected: 0, actual: 1 },
      });
      expect((await stores().agents.get("atlas"))?.status).toBe("ready");
    });

    /**
     * The gap this suite was written to find, and the reason §11.2 is not
     * satisfied by `aws-sdk-client-mock`: the mock hands the store a plain
     * object as the failed condition's `Item`, so a unit test sees the version
     * whether or not the store unmarshalls. The service — DynamoDB Local and the
     * real one alike — returns `ReturnValuesOnConditionCheckFailure` as raw
     * `AttributeValue`s, and `DynamoDBDocumentClient` unmarshalls *responses*,
     * not *exceptions*, so `item["version"]` arrives as `{ N: "1" }`. Only a
     * store that reads it as a document can tell the operator which version it
     * found rather than "found ?".
     */
    test("a CONFLICT names the version it found", async () => {
      await stores().agents.putIfAbsent(agent({ name: "atlas", version: 0 }));
      await stores().agents.update("atlas", 0, { status: "ready" });
      const stale = stores().agents.update("atlas", 0, { status: "error" });
      await expect(stale).rejects.toMatchObject({ details: { actual: 1 } });
      await expect(stale).rejects.toThrow(/expected version 0, found 1/);
    });

    test("two writers at the same version produce one winner and one CONFLICT", async () => {
      await stores().agents.putIfAbsent(agent({ name: "atlas", version: 0 }));
      const outcomes = await Promise.allSettled([
        stores().agents.update("atlas", 0, { status: "ready" }),
        stores().agents.update("atlas", 0, { status: "stopped" }),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: "CONFLICT" });
      expect((await stores().agents.get("atlas"))?.version).toBe(1);
    });

    test("an update of a row that is gone is NOT_FOUND, not CONFLICT", async () => {
      expect(await codeOf(stores().agents.update("ghost", 0, { status: "ready" }))).toBe("NOT_FOUND");
    });
  });

  describe("the per-agent lock", () => {
    test("expires by TTL and is then re-acquirable by somebody else", async () => {
      const A = "opA#run-1 agents.create";
      const B = "opB#run-2 agents.destroy";
      await stores().agents.putIfAbsent(agent({ name: "atlas", version: 0 }));

      let row = await stores().agents.update("atlas", 0, {
        lock: { owner: A, expires: iso(T0.getTime() + LOCK_TTL_MS) },
      });
      expect(row.lock?.owner).toBe(A);

      // Inside the TTL the lock is live for everybody but its owner (§4.4).
      expect(isLockLive(row.lock, B, T0.getTime() + 60_000)).toBe(true);
      expect(isLockLive(row.lock, A, T0.getTime() + 60_000)).toBe(false);

      // B taking it anyway is refused by the *version*, not by the lock: B read
      // the row before A wrote it, which is the race a stale operator is in.
      expect(
        await codeOf(
          stores().agents.update("atlas", 0, {
            lock: { owner: B, expires: iso(T0.getTime() + LOCK_TTL_MS) },
          }),
        ),
      ).toBe("CONFLICT");

      // Past the TTL the lock holds nothing, and B takes it at the current version.
      const later = T0.getTime() + LOCK_TTL_MS + 1000;
      expect(isLockLive(row.lock, B, later)).toBe(false);
      row = await stores().agents.update("atlas", row.version, {
        lock: { owner: B, expires: iso(later + LOCK_TTL_MS) },
      });
      expect(row.lock?.owner).toBe(B);

      // And a release is a written NULL, not an absent key, so it bumps version.
      const released = await stores().agents.update("atlas", row.version, { lock: null });
      expect(released.lock).toBeNull();
      expect(released.version).toBe(row.version + 1);
    });
  });

  describe("the fleet lock", () => {
    test("lockFleet admits one holder, and unlockFleet gives it back", async () => {
      await stores().fleet.put(fleetItem({ version: 3 }));
      expect(await stores().fleet.lockFleet("A", iso(T0.getTime() + LOCK_TTL_MS), T0)).toBe(true);
      expect(await stores().fleet.lockFleet("B", iso(T0.getTime() + LOCK_TTL_MS), T0)).toBe(false);

      // Taking and holding the lock is not a content change (§4.4).
      expect((await stores().fleet.get())?.version).toBe(3);

      // A renew by the holder is the same write, and still not a content change.
      expect(await stores().fleet.lockFleet("A", iso(T0.getTime() + 2 * LOCK_TTL_MS), T0)).toBe(true);
      expect((await stores().fleet.get())?.version).toBe(3);

      // B's release is a no-op: the lock is not theirs to drop.
      await stores().fleet.unlockFleet("B");
      expect((await stores().fleet.get())?.lock?.owner).toBe("A");

      await stores().fleet.unlockFleet("A");
      expect((await stores().fleet.get())?.lock).toBeNull();
      expect(await stores().fleet.lockFleet("B", iso(T0.getTime() + LOCK_TTL_MS), T0)).toBe(true);
    });

    test("an expired fleet lock is re-acquirable", async () => {
      await stores().fleet.put(fleetItem());
      expect(await stores().fleet.lockFleet("A", iso(T0.getTime() + LOCK_TTL_MS), T0)).toBe(true);
      const after = new Date(T0.getTime() + LOCK_TTL_MS + 1000);
      expect(await stores().fleet.lockFleet("B", iso(after.getTime() + LOCK_TTL_MS), after)).toBe(true);
      expect((await stores().fleet.get())?.lock?.owner).toBe("B");
    });

    test("lockFleet on an absent fleet conjures nothing", async () => {
      expect(await stores().fleet.lockFleet("A", iso(T0.getTime() + LOCK_TTL_MS), T0)).toBe(false);
      expect(await stores().fleet.get()).toBeNull();
    });
  });

  describe("updateFleet", () => {
    test("is refused under somebody else's live lock and allowed under our own", async () => {
      await stores().fleet.put(fleetItem({ version: 2 }));
      await stores().fleet.lockFleet("A", iso(T0.getTime() + LOCK_TTL_MS), T0);

      const stranger = await stores().fleet.updateFleet({ tailnet: "moved.ts.net" }, { now: T0 });
      expect(stranger).toBeNull();
      expect((await stores().fleet.get())?.tailnet).toBe("example.ts.net");

      const mine = await stores().fleet.updateFleet(
        { tailnet: "moved.ts.net" },
        { now: T0, owner: "A" },
      );
      expect(mine?.tailnet).toBe("moved.ts.net");
      expect(mine?.version).toBe(3);
      // The lock survives a patch written under it.
      expect(mine?.lock?.owner).toBe("A");
    });

    test("is refused on a moved version, and writes only the attributes it names", async () => {
      await stores().fleet.put(fleetItem({ version: 2, settings: settings() }));

      expect(
        await stores().fleet.updateFleet({ tailnet: "moved.ts.net" }, { now: T0, expectVersion: 1 }),
      ).toBeNull();

      const written = await stores().fleet.updateFleet(
        { tailscale_oauth_client_id: "kFIXTURE" },
        { now: T0, expectVersion: 2 },
      );
      expect(written?.version).toBe(3);
      expect(written?.tailscale_oauth_client_id).toBe("kFIXTURE");
      // Everything it did not name is as stored, not as the caller last read it.
      expect(written?.settings?.version).toBe(1);
      expect(written?.tailnet).toBe("example.ts.net");
    });

    test("an expired lock does not refuse a stranger's patch", async () => {
      await stores().fleet.put(fleetItem({ version: 1 }));
      await stores().fleet.lockFleet("A", iso(T0.getTime() + LOCK_TTL_MS), T0);
      const after = new Date(T0.getTime() + LOCK_TTL_MS + 1000);
      expect(
        await stores().fleet.updateFleet({ tailnet: "moved.ts.net" }, { now: after }),
      ).not.toBeNull();
    });
  });

  describe("replaceFleet", () => {
    test("is refused when the item version moved under it", async () => {
      const item = fleetItem({ version: 4, settings: settings() });
      await stores().fleet.put(item);
      await stores().fleet.updateFleet({ tailnet: "moved.ts.net" }, { now: T0, expectVersion: 4 });

      const refused = await stores().fleet.replaceFleet({ ...item, ubuntu_release: "26.04" }, "A", T0, {
        version: 4,
        settingsVersion: 1,
      });
      expect(refused).toBeNull();
      // Refused, not reverted: the write that landed in between is still there.
      const stored = await stores().fleet.get();
      expect(stored?.tailnet).toBe("moved.ts.net");
      expect(stored?.ubuntu_release).toBe("24.04");
    });

    test("is refused when settings.version moved under it", async () => {
      const item = fleetItem({ version: 4, settings: settings() });
      await stores().fleet.put(item);
      expect(await stores().fleet.putSettings({ ...settings(), version: 2 }, 1, T0)).toBe(true);

      expect(
        await stores().fleet.replaceFleet({ ...item, ubuntu_release: "26.04" }, "A", T0, {
          version: 4,
          settingsVersion: 1,
        }),
      ).toBeNull();
      expect((await stores().fleet.get())?.settings?.version).toBe(2);
    });

    test("commits when both counters are where the caller left them", async () => {
      const item = fleetItem({ version: 4, settings: settings() });
      await stores().fleet.put(item);
      await stores().fleet.lockFleet("A", iso(T0.getTime() + LOCK_TTL_MS), T0);

      const written = await stores().fleet.replaceFleet(
        { ...item, ubuntu_release: "26.04", foundation_version: 7 },
        "A",
        T0,
        { version: 4, settingsVersion: 1 },
      );
      expect(written?.version).toBe(5);
      expect(written?.foundation_version).toBe(7);
      expect((await stores().fleet.get())?.ubuntu_release).toBe("26.04");
    });
  });

  describe("volume reservations", () => {
    const VOLUME = "vol-0123456789abcdef0";

    test("eight operations contend for one disk and exactly one reserves it", async () => {
      const expires = iso(T0.getTime() + 60_000);
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          stores().volumeClaims.claim(VOLUME, `agent create op-${i}`, expires, T0),
        ),
      );
      const winners = attempts.filter((a) => a.ok);
      expect(winners).toHaveLength(1);

      const holder = winners[0]?.holder.owner ?? "(nobody)";
      // A refusal never reads as "free", whatever else it can or cannot say.
      for (const lost of attempts.filter((a) => !a.ok)) {
        expect(lost.holder.volume_id).toBe(VOLUME);
        expect(lost.holder.owner.length).toBeGreaterThan(0);
      }
      expect((await stores().volumeClaims.get(VOLUME))?.owner).toBe(holder);
    });

    /**
     * The same reading as `a CONFLICT names the version it found`, reaching a
     * second caller. `DynamoVolumeClaimStore.claim` parses the failed
     * condition's `ALL_OLD` image to name the holder in one round trip, and the
     * image arrives as raw `AttributeValue`s — `owner` is `{ S: "…" }`, not a
     * string. Unmarshalled it names the operation actually holding the disk;
     * unread it falls back to the anonymous "another operation" branch, which
     * belongs to a reservation that moved mid-flight and to nothing else.
     */
    test("a refused reservation names its holder", async () => {
      const expires = iso(T0.getTime() + 60_000);
      expect((await stores().volumeClaims.claim(VOLUME, "agent create alpha", expires, T0)).ok).toBe(
        true,
      );
      const refused = await stores().volumeClaims.claim(VOLUME, "agent create bravo", expires, T0);
      expect(refused.ok).toBe(false);
      expect(refused.holder).toMatchObject({ volume_id: VOLUME, owner: "agent create alpha" });
    });

    test("a re-run by the holder only pushes the expiry out", async () => {
      const first = iso(T0.getTime() + 60_000);
      const second = iso(T0.getTime() + 120_000);
      expect((await stores().volumeClaims.claim(VOLUME, "volume delete", first, T0)).ok).toBe(true);
      expect((await stores().volumeClaims.claim(VOLUME, "volume delete", second, T0)).ok).toBe(true);
      expect((await stores().volumeClaims.get(VOLUME))?.expires).toBe(second);
    });

    test("an expired reservation is re-claimable, and a stranger's release is a no-op", async () => {
      const expires = iso(T0.getTime() + 60_000);
      await stores().volumeClaims.claim(VOLUME, "agent create alpha", expires, T0);

      await stores().volumeClaims.release(VOLUME, "agent create bravo");
      expect((await stores().volumeClaims.get(VOLUME))?.owner).toBe("agent create alpha");

      const after = new Date(T0.getTime() + 61_000);
      const taken = await stores().volumeClaims.claim(
        VOLUME,
        "agent create bravo",
        iso(after.getTime() + 60_000),
        after,
      );
      expect(taken.ok).toBe(true);

      await stores().volumeClaims.release(VOLUME, "agent create bravo");
      expect(await stores().volumeClaims.get(VOLUME)).toBeNull();
    });

    test("reservations share the agents table without becoming agents", async () => {
      await stores().agents.putIfAbsent(agent({ name: "atlas" }));
      await stores().fleet.put(fleetItem());
      await stores().volumeClaims.claim(VOLUME, "agent create atlas", iso(T0.getTime() + 60_000), T0);

      expect((await stores().agents.scan()).map((a) => a.name)).toEqual(["atlas"]);
      expect((await stores().volumeClaims.list()).map((c) => c.volume_id)).toEqual([VOLUME]);
      expect(await codeOf(stores().agents.delete(volumeClaimKey(VOLUME)))).toBe("UNSUPPORTED");
      expect(await codeOf(stores().agents.delete(FLEET_KEY))).toBe("UNSUPPORTED");
    });
  });

  describe("hermeticd's heartbeat", () => {
    const health = { hermes: true, tailscale: true, disk: true };
    const metrics = { cpu_pct: 4, mem_pct: 31, disk_pct: 12 };

    test("renews the row without moving version", async () => {
      await stores().agents.putIfAbsent(agent({ name: "atlas", version: 0 }));
      const bumped = await stores().agents.update("atlas", 0, { status: "ready" });
      expect(bumped.version).toBe(1);

      const beat = new Date(T0.getTime() + 30_000);
      expect(
        await agentdAws({ now: () => beat }).heartbeat({
          name: "atlas",
          health,
          metrics,
          hermeticd_version: "0.4.1",
          applied_config_hash: "a".repeat(64),
        }),
      ).toBe(true);

      const row = await stores().agents.get("atlas");
      expect(row?.last_heartbeat).toBe(beat.toISOString());
      expect(row?.health).toEqual(health);
      expect(row?.metrics).toEqual(metrics);
      expect(row?.applied_config_hash).toBe("a".repeat(64));
      // The whole point (§4.4): an operator's CAS write must not lose to a beat.
      expect(row?.version).toBe(1);
      expect(row?.status).toBe("ready");
    });

    test("a beat racing an operator's update loses nothing", async () => {
      await stores().agents.putIfAbsent(agent({ name: "atlas", version: 0 }));
      const [, updated] = await Promise.all([
        agentdAws().heartbeat({ name: "atlas", health, metrics }),
        stores().agents.update("atlas", 0, { status: "ready" }),
      ]);
      expect(updated.version).toBe(1);
      const row = await stores().agents.get("atlas");
      expect(row?.status).toBe("ready");
      expect(row?.last_heartbeat).toBe(T0.toISOString());
    });

    test("cannot resurrect a destroyed row, and then suspends itself", async () => {
      const warnings: string[] = [];
      const aws = agentdAws({ warn: (m) => warnings.push(m) });
      await stores().agents.putIfAbsent(agent({ name: "atlas" }));
      await stores().agents.delete("atlas");

      expect(await aws.heartbeat({ name: "atlas", health, metrics })).toBe(false);
      expect(await stores().agents.get("atlas")).toBeNull();
      expect(warnings.join("\n")).toContain("no longer exists");

      // Latched off: the next beat makes no request at all.
      expect(await aws.heartbeat({ name: "atlas", health, metrics })).toBe(false);
      expect(await stores().agents.get("atlas")).toBeNull();
    });

    /**
     * §11.2's `LeadingKeys` case. hermetic has no production partition guard —
     * the confinement is the instance role's IAM policy — so the condition is
     * simulated one layer below the writer, and what is proved is that every
     * write hermeticd makes is keyed by its own row, which is what makes that
     * policy sufficient.
     */
    test("a request signed as agent a cannot write row b", async () => {
      await stores().agents.putIfAbsent(agent({ name: "alpha" }));
      await stores().agents.putIfAbsent(agent({ name: "bravo" }));

      const doc = DynamoDBDocumentClient.from(rawClient(), {
        marshallOptions: { removeUndefinedValues: true },
      });
      const alpha = agentdAws({ ddb: leadingKeys(doc, "alpha") });

      expect(await alpha.heartbeat({ name: "alpha", health, metrics })).toBe(true);
      await expect(alpha.heartbeat({ name: "bravo", health, metrics })).rejects.toMatchObject({
        name: "AccessDeniedException",
      });

      expect((await stores().agents.get("alpha"))?.last_heartbeat).toBe(T0.toISOString());
      expect((await stores().agents.get("bravo"))?.last_heartbeat).toBeNull();
    });
  });

  describe("the read path", () => {
    /**
     * §4.5 has no local mirror and no incremental sync: every read of the fleet
     * is a full consistent `Scan`. §11.2 puts the budget at 200 ms for 500
     * agents, which is what makes that decision defensible.
     *
     * The measurement is printed, not asserted, at that number: it is taken
     * against DynamoDB Local on whatever CPU the runner gave us, which is not
     * the service. The assertion is a ceiling loose enough that only a change
     * in *shape* — a scan that became a query per row, a page size that
     * collapsed to one — can cross it.
     */
    test("scans 500 agents in one pass", async () => {
      const doc = DynamoDBDocumentClient.from(guarded(), {
        marshallOptions: { removeUndefinedValues: true },
      });
      const names = Array.from({ length: 500 }, (_, i) => `agent-${String(i).padStart(3, "0")}`);
      for (let i = 0; i < names.length; i += 25) {
        await doc.send(
          new BatchWriteCommand({
            RequestItems: {
              [agentsTable]: names
                .slice(i, i + 25)
                .map((name) => ({ PutRequest: { Item: { ...agent({ name }) } } })),
            },
          }),
        );
      }
      await stores().fleet.put(fleetItem());

      const store = stores();
      const started = performance.now();
      const rows = await store.agents.scan();
      const elapsed = performance.now() - started;

      expect(rows).toHaveLength(500);
      expect(store.agents.unparseable?.()).toEqual([]);
      console.log(
        `scan of 500 agents: ${elapsed.toFixed(1)} ms (§11.2 budget on the real service: 200 ms)`,
      );
      // Deliberately generous; see the comment above.
      expect(elapsed).toBeLessThan(10_000);
    });
  });

  /**
   * The seam itself. `guardClient` can only add the account guard, never remove
   * one, so pointing core at DynamoDB Local cannot be a way to run without it.
   * These two assert that rather than leaving it as a property of the code.
   */
  describe("the account guard, with the endpoint set", () => {
    test("every store call against the local endpoint runs the guard", async () => {
      await stores().agents.putIfAbsent(agent({ name: "atlas" }));
      const before = guardCalls;
      await stores().agents.get("atlas");
      await stores().fleet.get();
      expect(guardCalls).toBeGreaterThan(before);
    });

    test("a mismatched account still refuses, and nothing reaches the table", async () => {
      const mismatch: AccountGuard = async () => {
        throw new HermeticError("ACCOUNT_MISMATCH", "credentials resolve to another account", {});
      };
      expect(await codeOf(stores(mismatch).agents.putIfAbsent(agent({ name: "atlas" })))).toBe(
        "ACCOUNT_MISMATCH",
      );
      expect(await codeOf(stores(mismatch).fleet.lockFleet("A", iso(T0.getTime() + 1), T0))).toBe(
        "ACCOUNT_MISMATCH",
      );
      expect(await stores().agents.scan()).toEqual([]);
      expect(await stores().fleet.get()).toBeNull();
    });

    test("a client with no guard at all is refused before it is used", () => {
      expect(() =>
        createDynamoStores(rawClient(), { agents: agentsTable, events: eventsTable }),
      ).toThrow(/carries no account guard/);
    });
  });
});
