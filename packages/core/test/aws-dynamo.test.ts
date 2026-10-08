import { beforeEach, describe, expect, test } from "bun:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { createDynamoStores } from "../src/aws/dynamo.ts";
import { guardClient } from "../src/aws/client.ts";
import { DESTROYED_KEY, FLEET_KEY } from "../src/schema/index.ts";
import type { AgentTombstone } from "../src/schema/index.ts";
import type { Agent } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";
import { inputsOf } from "./aws-harness.ts";

const ddb = mockClient(DynamoDBDocumentClient);

/**
 * The store refuses a client that was not built by `aws.client()`, so these
 * tests attach a no-op guard. `aws-client.test.ts` owns the guard's behaviour;
 * here the subject is the store's own SQL-shaped logic.
 */
let guardCalls = 0;
function stores() {
  const client = guardClient(new DynamoDBClient({ region: "us-west-2" }), async () => {
    guardCalls += 1;
  });
  return createDynamoStores(client, { agents: "hermetic-agents", events: "hermetic-events" });
}

/**
 * Every alias declared must be used: DynamoDB rejects the whole request for a
 * stray one, and `aws-sdk-client-mock` never parses an expression, so nothing
 * else in this suite can catch it. At module scope because every conditional
 * write here has to answer for it.
 */
function unusedAliases(input: {
  /** Absent on a `PutCommand`: a conditional `Put` has a condition and no update. */
  UpdateExpression?: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}): string[] {
  const expressions = `${input.UpdateExpression ?? ""} ${input.ConditionExpression}`;
  return [
    ...Object.keys(input.ExpressionAttributeNames),
    ...Object.keys(input.ExpressionAttributeValues),
  ].filter((alias) => !expressions.includes(alias));
}

const LOCK_EXPIRES = "2026-09-01T12:10:00.000Z";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "atlas",
    status: "creating",
    version: 3,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
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
    created_by: "arn:aws:iam::123456789012:user/e",
    created_at: "2026-09-01T12:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

/** aws-sdk-client-mock cannot fabricate the error class, so build a lookalike. */
function conditionalFailure(item?: Record<string, unknown>): Error {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  if (item) (e as unknown as { Item: unknown }).Item = item;
  return e;
}

beforeEach(() => ddb.reset());

describe("putIfAbsent", () => {
  test("claims the name with attribute_not_exists(name)", async () => {
    ddb.on(PutCommand).resolves({});
    expect(await stores().agents.putIfAbsent(agent())).toBe(true);

    const [input] = inputsOf<{
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
    }>(ddb, PutCommand);
    expect(input!.ConditionExpression).toBe("attribute_not_exists(#name)");
    expect(input!.ExpressionAttributeNames).toEqual({ "#name": "name" });
  });

  test("returns false when the name is already taken", async () => {
    ddb.on(PutCommand).rejects(conditionalFailure());
    expect(await stores().agents.putIfAbsent(agent())).toBe(false);
  });
});

/** §4.4: every update is a conditional write on the current version. */
describe("optimistic concurrency", () => {
  test("a moved version maps to CONFLICT and reports what it found", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure({ name: "atlas", version: 9 }));
    let error: HermeticError | null = null;
    try {
      await stores().agents.update("atlas", 3, { status: "error" });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    expect(error!.details).toMatchObject({ expected: 3, actual: 9 });
  });

  /**
   * The document client unmarshalls responses, not exceptions, so the `ALL_OLD`
   * item a refused write carries reaches the store as raw `AttributeValue`s.
   * DynamoDB Local found this; the mock cannot, because it hands over whatever
   * object it was given — so the marshalled shape is written out by hand here.
   */
  test("a marshalled item on the refusal still names the version it found", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure({ name: { S: "atlas" }, version: { N: "9" } }));
    let error: HermeticError | null = null;
    try {
      await stores().agents.update("atlas", 3, { status: "error" });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    expect(error!.details).toMatchObject({ expected: 3, actual: 9 });
    expect(error!.message).toContain("expected version 3, found 9");
  });

  test("a vanished row maps to NOT_FOUND, not CONFLICT", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure());
    let error: HermeticError | null = null;
    try {
      await stores().agents.update("atlas", 3, { status: "error" });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("NOT_FOUND");
  });

  test("the update expression pins the expected version and increments it", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: agent({ version: 4, status: "error" }) });
    await stores().agents.update("atlas", 3, { status: "error" });

    const [input] = inputsOf<{
      ConditionExpression: string;
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    }>(ddb, UpdateCommand);
    expect(input!.ConditionExpression).toBe("attribute_exists(#name) AND #version = :expected");
    expect(input!.UpdateExpression).toContain("#version = :next");
    expect(input!.ExpressionAttributeValues[":expected"]).toBe(3);
    expect(input!.ExpressionAttributeValues[":next"]).toBe(4);
  });
});

/**
 * There is no TTL on the `agents` table and no mirrored attribute. DynamoDB's
 * TTL deletes the whole item, which would delete the agent when its lock aged
 * out; expiry is decided against the clock in `hermetic.ts` instead (§4.4).
 */
describe("the lock", () => {
  test("no synthetic TTL attribute is ever written", async () => {
    ddb.on(PutCommand).resolves({});
    await stores().agents.putIfAbsent(agent({ lock: { owner: "evan", expires: LOCK_EXPIRES } }));
    const [input] = inputsOf<{ Item: Record<string, unknown> }>(ddb, PutCommand);
    expect("lock_expires" in input!.Item).toBe(false);
    expect(input!.Item["lock"]).toEqual({ owner: "evan", expires: LOCK_EXPIRES });
  });

  test("releasing a lock writes NULL rather than removing an attribute", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: agent({ version: 4 }) });
    await stores().agents.update("atlas", 3, { lock: null });

    const [input] = inputsOf<{
      UpdateExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    }>(ddb, UpdateCommand);
    expect(input!.UpdateExpression).not.toContain("REMOVE");
    const key = Object.entries(input!.ExpressionAttributeNames).find(([, v]) => v === "lock")![0];
    expect(input!.ExpressionAttributeValues[key.replace("#", ":")]).toBeNull();
  });

  test("acquiring a lock writes the object as-is", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: agent({ version: 4 }) });
    await stores().agents.update("atlas", 3, { lock: { owner: "evan", expires: LOCK_EXPIRES } });
    const [input] = inputsOf<{
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
      UpdateExpression: string;
    }>(ddb, UpdateCommand);
    expect(input!.UpdateExpression).not.toContain("lock_expires");
    const key = Object.entries(input!.ExpressionAttributeNames).find(([, v]) => v === "lock")![0];
    expect(input!.ExpressionAttributeValues[key.replace("#", ":")]).toEqual({
      owner: "evan",
      expires: LOCK_EXPIRES,
    });
  });
});

describe("scan", () => {
  test("reads consistently, pages fully, and excludes _fleet", async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({
        Items: [agent({ name: "atlas" }), { name: FLEET_KEY, fleet_id: "x" }],
        LastEvaluatedKey: { name: "atlas" },
      })
      .resolvesOnce({ Items: [agent({ name: "corvid" })] });

    const rows = await stores().agents.scan();
    expect(rows.map((r) => r.name)).toEqual(["atlas", "corvid"]);

    const inputs = inputsOf<{ ConsistentRead: boolean }>(ddb, ScanCommand);
    expect(inputs).toHaveLength(2);
    // §4.5: a command must never fail to see its own write.
    expect(inputs.every((i) => i.ConsistentRead === true)).toBe(true);
  });
});

describe("events", () => {
  test("query is newest-first", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        {
          name: "atlas",
          timestamp: "2026-09-01T12:00:00.000Z",
          actor: "e",
          action: "create",
          from_status: null,
          to_status: "creating",
          detail: null,
        },
      ],
    });
    await stores().events.query("atlas", 10);
    const [input] = inputsOf<{ ScanIndexForward: boolean; Limit: number }>(ddb, QueryCommand);
    expect(input!.ScanIndexForward).toBe(false);
    expect(input!.Limit).toBe(10);
  });
});

describe("the _fleet item", () => {
  test("lives in the agents table under pk _fleet", async () => {
    ddb.on(GetCommand).resolves({ Item: undefined });
    expect(await stores().fleet.get()).toBeNull();
    const [input] = inputsOf<{ TableName: string; Key: { name: string } }>(ddb, GetCommand);
    expect(input!.TableName).toBe("hermetic-agents");
    expect(input!.Key.name).toBe(FLEET_KEY);
  });

  test("agents.get never returns it", async () => {
    expect(await stores().agents.get(FLEET_KEY)).toBeNull();
    expect(inputsOf(ddb, GetCommand)).toHaveLength(0);
  });

  /**
   * `put` was the one door left that could still overwrite the whole item — no
   * condition, no version, and every other method on this store rewritten to
   * stop exactly that. `init --create` is its only caller and it writes a row
   * that is not there.
   */
  describe("put", () => {
    const item = {
      fleet_id: "fxtr0001",
      region: "us-west-2",
      bucket: "hermetic-123456789012-us-west-2",
      created_by: "arn:aws:iam::123456789012:user/e",
      created_at: "2026-09-01T12:00:00.000Z",
      min_hermetic_version: "0.5.0",
      ubuntu_release: "24.04",
      ami_id: "ami-0123456789abcdef0",
      tailnet: "example.ts.net",
      stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic-fxtr0001/abc",
      defaults: {
        size: "medium" as const,
        provider: "bedrock" as const,
        model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        volume_gib: 100,
        browser: true,
        secrets: "none" as const,
      },
    };

    test("is create-only, and stamps the revision counter it will be guarded on", async () => {
      ddb.on(PutCommand).resolves({});
      await stores().fleet.put(item);

      const [input] = inputsOf<{
        Item: Record<string, unknown>;
        ConditionExpression: string;
        ExpressionAttributeNames: Record<string, string>;
      }>(ddb, PutCommand);
      expect(input!.Item["name"]).toBe(FLEET_KEY);
      expect(input!.Item["version"]).toBe(0);
      expect(input!.ConditionExpression).toBe("attribute_not_exists(#name)");
      // No value aliases at all on this one, so every declared name is used.
      expect(input!.ExpressionAttributeNames).toEqual({ "#name": "name" });
    });

    test("a _fleet that is already there is CONFLICT, not an overwrite", async () => {
      ddb.on(PutCommand).rejects(conditionalFailure());
      const e = await stores()
        .fleet.put(item)
        .catch((err: unknown) => err);
      expect(e).toBeInstanceOf(HermeticError);
      expect((e as HermeticError).code).toBe("CONFLICT");
      expect((e as HermeticError).message).toContain("fxtr0001");

      ddb.reset();
      ddb.on(PutCommand).rejects(Object.assign(new Error("boom"), { name: "ThrottlingException" }));
      await expect(stores().fleet.put(item)).rejects.toBeInstanceOf(HermeticError);
    });
  });

  /**
   * §4.6's settings write. `_fleet` carries no row version the way an agent
   * does, so the condition is on `settings.version` itself — and on the fleet
   * lock, because a `foundation update` is about to rewrite the whole item.
   */
  describe("putSettings", () => {
    const settings = {
      version: 2,
      defaults: {
        size: "medium" as const,
        provider: "bedrock" as const,
        volume_gib: 100,
        secrets: "none" as const,
      },
      providers: { bedrock: { enabled: true } },
      secrets: [],
      updated_at: "2026-09-01T12:00:00.000Z",
      updated_by: "ops",
    };

    test("writes settings and the defaults mirror, conditional on both", async () => {
      ddb.on(UpdateCommand).resolves({});
      const now = new Date("2026-09-01T12:00:00.000Z");
      expect(await stores().fleet.putSettings(settings, 1, now)).toBe(true);
      const [input] = inputsOf<{
        Key: { name: string };
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      }>(ddb, UpdateCommand);
      expect(input!.Key.name).toBe(FLEET_KEY);
      // One write, both attributes: `_fleet.defaults` is what the lifecycle
      // reads (§10), so it may never disagree with `settings.defaults`.
      expect(input!.UpdateExpression).toBe("SET #settings = :settings, #defaults = :defaults");
      expect(input!.ExpressionAttributeValues[":defaults"]).toEqual(settings.defaults);
      expect(input!.ConditionExpression).toContain("#settings.#sversion = :expected");
      expect(input!.ConditionExpression).toContain("#lock.#expires < :now");
      expect(input!.ExpressionAttributeValues[":expected"]).toBe(1);
      expect(input!.ExpressionAttributeValues[":now"]).toBe(now.toISOString());
    });

    test("a null expected version means `there are none yet`", async () => {
      ddb.on(UpdateCommand).resolves({});
      await stores().fleet.putSettings({ ...settings, version: 1 }, null, new Date());
      const [input] = inputsOf<{
        ConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
      }>(ddb, UpdateCommand);
      // Not `= 0`: absent and zero are different facts, and only one of them
      // can be written by a second laptop racing to be first.
      expect(input!.ConditionExpression).toContain("attribute_not_exists(#settings)");
      expect(input!.ExpressionAttributeValues[":expected"]).toBeUndefined();
    });

    /**
     * Every alias declared must be used. DynamoDB rejects the whole request for
     * a stray one — `ValidationException: Value provided in
     * ExpressionAttributeNames unused in expressions` — and
     * `aws-sdk-client-mock` never parses an expression, so nothing else in this
     * suite can catch it. It was a real bug: `#sversion` was declared
     * unconditionally while only the numeric branch used it, which made the
     * *first* settings write on every pre-existing fleet fail against real AWS.
     */
    test("declares no name or value the expressions do not use, on either branch", async () => {
      ddb.on(UpdateCommand).resolves({});
      const s = stores();
      await s.fleet.putSettings({ ...settings, version: 1 }, null, new Date());
      await s.fleet.putSettings(settings, 1, new Date());
      const inputs = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, UpdateCommand);
      expect(inputs).toHaveLength(2);
      // Named per call, so a failure says which branch is malformed.
      expect(unusedAliases(inputs[0]!)).toEqual([]);
      expect(unusedAliases(inputs[1]!)).toEqual([]);
      // And the check itself bites: `#sversion` belongs to the numeric branch
      // alone, so declaring it on the other one is exactly what is caught.
      expect(
        unusedAliases({
          ...inputs[0]!,
          ExpressionAttributeNames: { ...inputs[0]!.ExpressionAttributeNames, "#sversion": "version" },
        }),
      ).toEqual(["#sversion"]);
    });

    test("a failed condition is false, and any other error still throws", async () => {
      ddb
        .on(UpdateCommand)
        .rejects(Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" }));
      expect(await stores().fleet.putSettings(settings, 1, new Date())).toBe(false);

      ddb.reset();
      ddb.on(UpdateCommand).rejects(Object.assign(new Error("boom"), { name: "ThrottlingException" }));
      await expect(stores().fleet.putSettings(settings, 1, new Date())).rejects.toBeInstanceOf(
        HermeticError,
      );
    });

    /**
     * §8.3: a profile write holds the fleet lock across its own settings write,
     * so its own lock may not be what refuses it. The clause is *added* to the
     * three that were always there rather than replacing any of them — a lock
     * that expired under this run and was taken by somebody else is a different
     * owner, and must still refuse.
     */
    test("an owner adds the holder's own lock to the ways the lock is free", async () => {
      ddb.on(UpdateCommand).resolves({});
      const s = stores();
      await s.fleet.putSettings(settings, 1, new Date(), "arn:aws:iam::1:user/e#r1 providers.update");
      await s.fleet.putSettings(settings, 1, new Date());
      const [withOwner, without] = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, UpdateCommand);

      expect(withOwner!.ConditionExpression).toContain("#lock.#owner = :owner");
      expect(withOwner!.ExpressionAttributeValues[":owner"]).toBe(
        "arn:aws:iam::1:user/e#r1 providers.update",
      );
      expect(withOwner!.ExpressionAttributeNames["#owner"]).toBe("owner");
      // The other three ways are untouched by the addition.
      expect(withOwner!.ConditionExpression).toContain("attribute_not_exists(#lock)");
      expect(withOwner!.ConditionExpression).toContain("#lock.#expires < :now");

      // And with no owner the request is byte-identical to what it always was:
      // no clause, and no alias declared that no expression uses.
      expect(without!.ConditionExpression).not.toContain(":owner");
      expect(without!.ExpressionAttributeNames["#owner"]).toBeUndefined();
      expect(unusedAliases(withOwner!)).toEqual([]);
      expect(unusedAliases(without!)).toEqual([]);
    });
  });

  /**
   * §4.4's attribute-level metadata write. The bug it exists for: every
   * fleet-wide write used to be a whole-item `PutItem` composed from a copy the
   * caller read some awaits earlier, so `secrets push` recording an OAuth client
   * id reverted whatever `settings.set`, profile write or Bedrock grant had
   * landed in the meantime. An expression that names three attributes cannot.
   */
  describe("updateFleet", () => {
    /** The `ALL_NEW` image the store parses back. Only the shape matters here. */
    const stored = {
      name: FLEET_KEY,
      fleet_id: "fxtr0001",
      defaults: {
        size: "medium" as const,
        provider: "bedrock" as const,
        volume_gib: 100,
        browser: true,
        secrets: "none" as const,
      },
      ubuntu_release: "24.04",
      ami_id: "ami-0123456789abcdef0",
      min_hermetic_version: "0.5.0",
      tailnet: "example.ts.net",
      region: "us-west-2",
      bucket: "hermetic-fxtr0001",
      stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic/abc",
      created_by: "arn:aws:iam::123456789012:user/e",
      created_at: "2026-09-01T12:00:00.000Z",
      version: 4,
    };

    test("SETs only the named attributes, and bumps version in the same expression", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: stored });
      const now = new Date("2026-09-01T12:00:00.000Z");
      const written = await stores().fleet.updateFleet(
        { tailscale_oauth_client_id: "kabc123", network: "public" },
        { now },
      );
      expect(written?.version).toBe(4);

      const [input] = inputsOf<Parameters<typeof unusedAliases>[0] & { Key: { name: string } }>(
        ddb,
        UpdateCommand,
      );
      expect(input!.Key.name).toBe(FLEET_KEY);
      // The whole assertion of the method: the two attributes asked for, the
      // counter, and nothing else. `settings` and `bedrock_model_ids` are not
      // named, so whatever landed on them since the caller's read survives.
      const names = Object.values(input!.ExpressionAttributeNames);
      expect(names).toContain("tailscale_oauth_client_id");
      expect(names).toContain("network");
      expect(names).not.toContain("settings");
      expect(names).not.toContain("bedrock_model_ids");
      expect(input!.UpdateExpression).toContain("#version = if_not_exists(#version, :zero) + :one");
      // Counted by alias, not by comma: `if_not_exists(#version, :zero)` has one of its own.
      expect(Object.keys(input!.ExpressionAttributeNames).filter((n) => /^#p\d/.test(n))).toHaveLength(
        2,
      );
      expect(unusedAliases(input!)).toEqual([]);
    });

    /**
     * The same four ways the lock is free `lockFleet` spells out, because a
     * fleet-wide operation takes the lock precisely so the item stops moving.
     * With no owner — which is what `secrets push` passes, holding no lock —
     * a live lock of any owner refuses.
     */
    test("carries the four-way lock condition, and the owner clause only when given", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: stored });
      const s = stores();
      const now = new Date("2026-09-01T12:00:00.000Z");
      await s.fleet.updateFleet({ tailnet: "a.ts.net" }, { now });
      await s.fleet.updateFleet({ tailnet: "a.ts.net" }, { now, owner: "me#run-1" });
      const [without, withOwner] = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, UpdateCommand);

      for (const input of [without!, withOwner!]) {
        expect(input.ConditionExpression).toContain("attribute_exists(#name)");
        expect(input.ConditionExpression).toContain("attribute_not_exists(#lock)");
        expect(input.ConditionExpression).toContain("#lock = :null");
        expect(input.ConditionExpression).toContain("#lock.#expires < :now");
        expect(unusedAliases(input)).toEqual([]);
      }
      expect(without!.ConditionExpression).not.toContain(":owner");
      expect(without!.ExpressionAttributeNames["#owner"]).toBeUndefined();
      expect(withOwner!.ConditionExpression).toContain("#lock.#owner = :owner");
      expect(withOwner!.ExpressionAttributeValues[":owner"]).toBe("me#run-1");
    });

    /**
     * `expectVersion: 0` has to match an item written before `version` existed,
     * which carries no such attribute — absent means 0. A condition that told
     * the two apart would refuse the first write on every older fleet.
     */
    test("an expected version is a condition, and zero also matches an item that has none", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: stored });
      const s = stores();
      const now = new Date();
      await s.fleet.updateFleet({ tailnet: "a.ts.net" }, { now, expectVersion: 4 });
      await s.fleet.updateFleet({ tailnet: "a.ts.net" }, { now, expectVersion: 0 });
      await s.fleet.updateFleet({ tailnet: "a.ts.net" }, { now });
      const [four, zero, none] = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, UpdateCommand);

      expect(four!.ConditionExpression).toContain("#version = :expectedVersion");
      expect(four!.ConditionExpression).not.toContain("attribute_not_exists(#version)");
      expect(four!.ExpressionAttributeValues[":expectedVersion"]).toBe(4);
      expect(zero!.ConditionExpression).toContain("attribute_not_exists(#version) OR #version =");
      // Stating nothing is the common case, and it must declare nothing either.
      expect(none!.ConditionExpression).not.toContain(":expectedVersion");
      expect(none!.ExpressionAttributeValues[":expectedVersion"]).toBeUndefined();
      for (const input of [four!, zero!, none!]) expect(unusedAliases(input)).toEqual([]);
    });

    /** A key the caller did not mean to set is dropped: there is no `SET` to nothing. */
    test("an undefined value is not written as NULL", async () => {
      ddb.on(UpdateCommand).resolves({ Attributes: stored });
      await stores().fleet.updateFleet(
        { tailnet: "a.ts.net", tailscale_oauth_client_id: undefined },
        { now: new Date() },
      );
      const [input] = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, UpdateCommand);
      expect(Object.values(input!.ExpressionAttributeNames)).not.toContain("tailscale_oauth_client_id");
      expect(Object.keys(input!.ExpressionAttributeNames).filter((n) => /^#p\d/.test(n))).toHaveLength(
        1,
      );
    });

    /**
     * A patch that names nothing still wrote: `SET` had only the version bump
     * left in it, so the counter moved for an update that changed no attribute
     * — and moving it is exactly what invalidates another operation's commit
     * point. Nothing to set is nothing to write.
     */
    test("a patch that names nothing writes nothing and reads the row instead", async () => {
      ddb.on(GetCommand).resolves({ Item: stored });
      const written = await stores().fleet.updateFleet(
        { tailnet: undefined },
        { now: new Date("2026-09-01T12:00:00.000Z") },
      );
      expect(written?.version).toBe(stored.version);
      expect(inputsOf(ddb, UpdateCommand)).toHaveLength(0);

      ddb.reset();
      ddb.on(GetCommand).resolves({ Item: undefined });
      expect(await stores().fleet.updateFleet({}, { now: new Date() })).toBeNull();
    });

    test("a failed condition is null, and any other error still throws", async () => {
      ddb.on(UpdateCommand).rejects(conditionalFailure());
      expect(await stores().fleet.updateFleet({ tailnet: "a.ts.net" }, { now: new Date() })).toBeNull();

      ddb.reset();
      ddb.on(UpdateCommand).rejects(Object.assign(new Error("boom"), { name: "ThrottlingException" }));
      await expect(
        stores().fleet.updateFleet({ tailnet: "a.ts.net" }, { now: new Date() }),
      ).rejects.toBeInstanceOf(HermeticError);
    });

    /**
     * The other door, and the two counters it states. A whole-item replacement
     * is only safe because it says which row it believes it is replacing:
     * `version` for any content write, and `settings.version` because a
     * `putSettings` moves that one independently.
     */
    test("replaceFleet states both counters and writes the expected version plus one", async () => {
      ddb.on(PutCommand).resolves({});
      const now = new Date("2026-09-01T12:00:00.000Z");
      const item = { ...stored, version: 4 } as unknown as Parameters<
        ReturnType<typeof stores>["fleet"]["replaceFleet"]
      >[0];
      const written = await stores().fleet.replaceFleet(item, "me#run-1", now, {
        version: 4,
        settingsVersion: 2,
      });
      // The counter keeps advancing through a replacement the way it does
      // through a patch, so a stale patch composed earlier cannot land after.
      expect(written?.version).toBe(5);

      const [input] = inputsOf<Parameters<typeof unusedAliases>[0] & { Item: Record<string, unknown> }>(
        ddb,
        PutCommand,
      );
      expect(input!.Item["name"]).toBe(FLEET_KEY);
      expect(input!.Item["version"]).toBe(5);
      expect(input!.ConditionExpression).toContain("attribute_exists(#name)");
      expect(input!.ConditionExpression).toContain("#version = :expectedVersion");
      expect(input!.ConditionExpression).toContain("#settings.#sversion = :expectedSettings");
      expect(input!.ConditionExpression).toContain("#lock.#owner = :owner");
      expect(input!.ExpressionAttributeValues[":expectedSettings"]).toBe(2);
      expect(unusedAliases(input!)).toEqual([]);
    });

    /**
     * A fleet with no settings record yet — the v2 migration is about to seed
     * one. "There are none" and "there are none *yet*" are the same fact here,
     * and `= 0` would be a different one, writable by a racing second laptop.
     */
    test("replaceFleet on a fleet with no settings asserts their absence", async () => {
      ddb.on(PutCommand).resolves({});
      const item = stored as unknown as Parameters<
        ReturnType<typeof stores>["fleet"]["replaceFleet"]
      >[0];
      await stores().fleet.replaceFleet(item, "me#run-1", new Date(), {
        version: 0,
        settingsVersion: null,
      });
      const [input] = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, PutCommand);
      expect(input!.ConditionExpression).toContain("attribute_not_exists(#settings)");
      expect(input!.ExpressionAttributeValues[":expectedSettings"]).toBeUndefined();
      expect(input!.ExpressionAttributeNames["#sversion"]).toBeUndefined();
      expect(unusedAliases(input!)).toEqual([]);
    });

    test("replaceFleet answers null on a failed condition and throws on anything else", async () => {
      const item = stored as unknown as Parameters<
        ReturnType<typeof stores>["fleet"]["replaceFleet"]
      >[0];
      const expect0 = { version: 0, settingsVersion: null };
      ddb.on(PutCommand).rejects(conditionalFailure());
      expect(await stores().fleet.replaceFleet(item, "me", new Date(), expect0)).toBeNull();

      ddb.reset();
      ddb.on(PutCommand).rejects(Object.assign(new Error("boom"), { name: "ThrottlingException" }));
      await expect(stores().fleet.replaceFleet(item, "me", new Date(), expect0)).rejects.toBeInstanceOf(
        HermeticError,
      );
    });
  });

  /**
   * §4.4's lock over one attribute (§8.3). The point of the method is what it
   * does *not* write: it leaves every other attribute of `_fleet` — `version`
   * included — exactly as it is stored, so taking or renewing the lock can
   * neither revert a settings write that landed in the gap nor invalidate the
   * revision the holder's own commit point is written against.
   */
  describe("lockFleet / unlockFleet", () => {
    const OWNER = "arn:aws:iam::123456789012:user/e#run-1 providers.update";
    const EXPIRES = "2026-09-01T12:00:30.000Z";

    test("sets the lock attribute and nothing else, under the four-way condition", async () => {
      ddb.on(UpdateCommand).resolves({});
      const now = new Date("2026-09-01T12:00:00.000Z");
      expect(await stores().fleet.lockFleet(OWNER, EXPIRES, now)).toBe(true);

      const [input] = inputsOf<{
        Key: { name: string };
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeNames: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
      }>(ddb, UpdateCommand);
      expect(input!.Key.name).toBe(FLEET_KEY);
      // The whole assertion of this method: one attribute, by name.
      expect(input!.UpdateExpression).toBe("SET #lock = :lock");
      expect(input!.ExpressionAttributeValues[":lock"]).toEqual({ owner: OWNER, expires: EXPIRES });

      // The same four ways the lock is free every conditional write here spells out.
      const condition = input!.ConditionExpression;
      expect(condition).toContain("attribute_not_exists(#lock)");
      expect(condition).toContain("#lock = :null");
      expect(condition).toContain("#lock.#owner = :owner");
      expect(condition).toContain("#lock.#expires < :now");
      // Plus the one an `UpdateCommand` needs and a `PutCommand` does not: an
      // update on an absent key would *create* `_fleet` with only a lock on it.
      expect(condition).toContain("attribute_exists(#name)");
      expect(input!.ExpressionAttributeValues[":now"]).toBe(now.toISOString());
      expect(unusedAliases(input!)).toEqual([]);
    });

    test("a live lock somebody else holds is false, and any other error throws", async () => {
      ddb
        .on(UpdateCommand)
        .rejects(Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" }));
      expect(await stores().fleet.lockFleet(OWNER, EXPIRES, new Date())).toBe(false);

      ddb.reset();
      ddb.on(UpdateCommand).rejects(Object.assign(new Error("boom"), { name: "ThrottlingException" }));
      await expect(stores().fleet.lockFleet(OWNER, EXPIRES, new Date())).rejects.toBeInstanceOf(
        HermeticError,
      );
    });

    test("the release nulls the lock, conditional on it still being ours", async () => {
      ddb.on(UpdateCommand).resolves({});
      await stores().fleet.unlockFleet(OWNER);
      const [input] = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, UpdateCommand);
      expect(input!.UpdateExpression).toBe("SET #lock = :null");
      expect(input!.ConditionExpression).toContain("#lock.#owner = :owner");
      expect(unusedAliases(input!)).toEqual([]);
    });

    /**
     * A renew is not a take, and the condition is where the two part company.
     * Going through `lockFleet` meant a run whose TTL had lapsed — with the
     * fleet free for anyone to claim in the meantime — succeeded at renewing
     * and carried on believing it had never let go.
     */
    test("a renew requires the lock to be ours and still live", async () => {
      ddb.on(UpdateCommand).resolves({});
      const now = new Date("2026-09-01T12:00:00.000Z");
      expect(await stores().fleet.renewFleetLock(OWNER, EXPIRES, now)).toBe(true);

      const [input] = inputsOf<Parameters<typeof unusedAliases>[0]>(ddb, UpdateCommand);
      expect(input!.UpdateExpression).toBe("SET #lock = :lock");
      expect(input!.ConditionExpression).toBe(
        "attribute_exists(#name) AND #lock.#owner = :owner AND #lock.#expires >= :now",
      );
      // None of the four ways `lockFleet` counts the lock as free may appear.
      expect(input!.ConditionExpression).not.toContain("attribute_not_exists(#lock)");
      expect(input!.ConditionExpression).not.toContain(":null");
      expect(unusedAliases(input!)).toEqual([]);
    });

    test("a lapsed or foreign lock refuses the renew, and any other error throws", async () => {
      ddb.on(UpdateCommand).rejects(conditionalFailure());
      expect(
        await stores().fleet.renewFleetLock(OWNER, EXPIRES, new Date("2026-09-01T12:00:00.000Z")),
      ).toBe(false);

      ddb.reset();
      ddb.on(UpdateCommand).rejects(Object.assign(new Error("boom"), { name: "ThrottlingException" }));
      await expect(
        stores().fleet.renewFleetLock(OWNER, EXPIRES, new Date("2026-09-01T12:00:00.000Z")),
      ).rejects.toBeInstanceOf(HermeticError);
    });

    /** A release that lost the race has nothing to release; it is never an error. */
    test("a lost release is silent, and a real failure is not", async () => {
      ddb
        .on(UpdateCommand)
        .rejects(Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" }));
      await stores().fleet.unlockFleet(OWNER);

      ddb.reset();
      ddb.on(UpdateCommand).rejects(Object.assign(new Error("boom"), { name: "ThrottlingException" }));
      await expect(stores().fleet.unlockFleet(OWNER)).rejects.toBeInstanceOf(HermeticError);
    });
  });
});

/** §9.1: a refused reservation names the operation that holds the disk. */
describe("volume reservations", () => {
  const EXPIRES = "2026-09-01T12:01:00.000Z";
  const VOLUME = "vol-0123456789abcdef0";
  const held = {
    name: { S: `_volume:${VOLUME}` },
    owner: { S: "agent create alpha" },
    expires: { S: EXPIRES },
  };

  test("a marshalled item on the refusal still names the holder", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure(held));
    const refused = await stores().volumeClaims.claim(
      VOLUME,
      "agent create bravo",
      EXPIRES,
      new Date(),
    );
    expect(refused.ok).toBe(false);
    expect(refused.holder).toEqual({
      volume_id: VOLUME,
      owner: "agent create alpha",
      expires: EXPIRES,
    });
  });

  test("a refusal carrying no item names an anonymous holder rather than none", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure());
    const refused = await stores().volumeClaims.claim(
      VOLUME,
      "agent create bravo",
      EXPIRES,
      new Date(),
    );
    expect(refused.ok).toBe(false);
    expect(refused.holder.owner).toBe("another operation");
  });
});

/** §4.7: failing open on a missing guard would be the guard, silently absent. */
/**
 * F3: `get` and `scan` were the two reads with no `asHermeticError` around them,
 * so after `teardown` deleted the tables a `ResourceNotFoundException` left the
 * store as a raw SDK error — no code for the CLI's exit table, no status for the
 * server's. A missing table is `NOT_FOUND` specifically, because `teardown`,
 * `plan.teardown` and `doctor` act on it rather than merely reporting it.
 */
describe("reads are wrapped like the writes", () => {
  /** aws-sdk-client-mock cannot fabricate the error class, so build a lookalike. */
  function resourceNotFound(): Error {
    const e = new Error("Requested resource not found");
    e.name = "ResourceNotFoundException";
    return e;
  }

  test("get on a deleted table is NOT_FOUND, not a raw SDK throw", async () => {
    ddb.on(GetCommand).rejects(resourceNotFound());
    let error: unknown = null;
    try {
      await stores().agents.get("atlas");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect((error as HermeticError).code).toBe("NOT_FOUND");
    expect((error as HermeticError).details?.["aws_error"]).toBe("ResourceNotFoundException");
  });

  test("scan on a deleted table is NOT_FOUND and names the table", async () => {
    ddb.on(ScanCommand).rejects(resourceNotFound());
    let error: unknown = null;
    try {
      await stores().agents.scan();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect((error as HermeticError).code).toBe("NOT_FOUND");
    expect((error as HermeticError).message).toContain("hermetic-agents");
  });

  test("any other read failure is a typed INTERNAL carrying the AWS name", async () => {
    const throttled = new Error("Rate exceeded");
    throttled.name = "ProvisionedThroughputExceededException";
    ddb.on(ScanCommand).rejects(throttled);
    let error: unknown = null;
    try {
      await stores().agents.scan();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect((error as HermeticError).code).toBe("INTERNAL");
    expect((error as HermeticError).details?.["aws_error"]).toBe(
      "ProvisionedThroughputExceededException",
    );
  });

  test("a paged scan that fails on the second page still throws typed", async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: { name: "atlas" } })
      .rejectsOnce(resourceNotFound());
    let error: unknown = null;
    try {
      await stores().agents.scan();
    } catch (e) {
      error = e;
    }
    expect((error as HermeticError).code).toBe("NOT_FOUND");
  });
});

describe("the account guard", () => {
  test("every store call goes through it", async () => {
    ddb.on(GetCommand).resolves({ Item: undefined });
    guardCalls = 0;
    const s = stores();
    await s.agents.get("atlas");
    await s.fleet.get();
    expect(guardCalls).toBe(2);
  });

  test("a client not built by aws.client() is refused, not trusted", () => {
    let error: HermeticError | null = null;
    try {
      createDynamoStores(new DynamoDBClient({ region: "us-west-2" }), {
        agents: "hermetic-agents",
        events: "hermetic-events",
      });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect(error!.code).toBe("INTERNAL");
    expect(error!.message).toContain("no account guard");
  });
});

/**
 * §4.5: one half-written row must not take `agent ps` and the server's poller
 * down with it. It is skipped, and `doctor` names it.
 */
describe("a row that does not parse", () => {
  test("is skipped rather than failing the whole fleet read", async () => {
    ddb.on(ScanCommand).resolves({
      Items: [
        agent({ name: "atlas" }),
        // A create interrupted before the row was complete.
        { name: "half-written", status: "creating" },
        // Something else entirely in the table.
        { name: "foreign", kind: "not-an-agent" },
        agent({ name: "corvid" }),
      ],
    });
    const store = stores().agents;
    const rows = await store.scan();
    expect(rows.map((r) => r.name)).toEqual(["atlas", "corvid"]);
    expect(store.unparseable!()).toEqual(["half-written", "foreign"]);
  });

  test("a clean scan reports nothing unparseable", async () => {
    ddb.on(ScanCommand).resolves({ Items: [agent({ name: "atlas" })] });
    const store = stores().agents;
    await store.scan();
    expect(store.unparseable!()).toEqual([]);
  });

  test("the skipped list is per-scan, not cumulative", async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [{ name: "half-written" }] })
      .resolvesOnce({ Items: [agent({ name: "atlas" })] });
    const store = stores().agents;
    await store.scan();
    expect(store.unparseable!()).toEqual(["half-written"]);
    await store.scan();
    expect(store.unparseable!()).toEqual([]);
  });

  test("a row with no name at all is still reported", async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ status: "creating" }] });
    const store = stores().agents;
    expect(await store.scan()).toEqual([]);
    expect(store.unparseable!()).toEqual(["(unnamed row)"]);
  });
});

/**
 * §6.7: the release deletes the row, conditional on the version it read and on
 * the incarnation (`created_at`) it read it from.
 */
describe("the release's delete", () => {
  const BORN = "2026-01-01T00:00:00.000Z";
  const expected = { expectedVersion: 7, expectedCreatedAt: BORN };

  test("the delete is conditional on the expected version and created_at", async () => {
    ddb.on(DeleteCommand).resolves({});
    await stores().agents.delete("atlas", expected);
    const [input] = inputsOf<{
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
      ReturnValuesOnConditionCheckFailure: string;
    }>(ddb, DeleteCommand);
    expect(input!.ConditionExpression).toBe(
      "attribute_exists(#name) AND #version = :expected AND #created_at = :created_at",
    );
    expect(input!.ExpressionAttributeNames).toEqual({
      "#name": "name",
      "#version": "version",
      "#created_at": "created_at",
    });
    expect(input!.ExpressionAttributeValues).toEqual({ ":expected": 7, ":created_at": BORN });
    expect(input!.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
    expect(unusedAliases(input!)).toEqual([]);
  });

  test("a moved version is CONFLICT", async () => {
    ddb.on(DeleteCommand).rejects(conditionalFailure({ name: "atlas", version: 9, created_at: BORN }));
    let error: HermeticError | null = null;
    try {
      await stores().agents.delete("atlas", expected);
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    expect(error!.details).toMatchObject({ expected: 7, actual: 9 });
  });

  /**
   * A release that stalled past its lock, while somebody destroyed the agent
   * and created a new one of the same name that reached the same version: the
   * refusal says so, rather than deleting the newer agent.
   */
  test("a later incarnation at the same version is CONFLICT", async () => {
    const reborn = "2026-02-01T00:00:00.000Z";
    ddb
      .on(DeleteCommand)
      .rejects(conditionalFailure({ name: "atlas", version: 7, created_at: reborn }));
    let error: HermeticError | null = null;
    try {
      await stores().agents.delete("atlas", expected);
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    expect(error!.message).toContain("different incarnation");
    expect(error!.details).toMatchObject({
      expected_created_at: BORN,
      actual_created_at: reborn,
    });
  });

  test("a row already gone is not an error", async () => {
    ddb.on(DeleteCommand).rejects(conditionalFailure());
    await stores().agents.delete("atlas", expected);
  });

  test("without an expected version the unwind's delete stays unconditional", async () => {
    ddb.on(DeleteCommand).resolves({});
    await stores().agents.delete("atlas");
    const [input] = inputsOf<{ ConditionExpression?: string }>(ddb, DeleteCommand);
    expect(input!.ConditionExpression).toBeUndefined();
  });
});

describe("tombstones", () => {
  const tombstone = (name: string, destroyed_at: string): AgentTombstone => ({
    name,
    fleet_id: "fxtr0001",
    created_at: "2026-09-01T12:00:00.000Z",
    created_by: "arn:aws:iam::123456789012:user/e",
    destroyed_at,
    destroyed_by: "arn:aws:iam::123456789012:user/e",
    size: "medium",
    region: "us-west-2",
    provider: "bedrock",
    profile_id: null,
    instance_id: "i-1",
    volume_id: "vol-1",
    volume_kept: false,
    hermes_version: "0.15.0",
    legacy: false,
  });
  const item = (name: string, at: string) => {
    const { name: _n, legacy: _l, ...rest } = tombstone(name, at);
    return { ...rest, name: DESTROYED_KEY, timestamp: `${at}#${name}`, agent: name };
  };

  test("append writes the reserved partition, range-keyed by time then name", async () => {
    ddb.on(PutCommand).resolves({});
    await stores().events.appendTombstone(tombstone("atlas", "2026-09-02T00:00:00.000Z"));
    const [input] = inputsOf<{ Item: Record<string, unknown>; TableName: string }>(ddb, PutCommand);
    expect(input!.TableName).toBe("hermetic-events");
    expect(input!.Item["name"]).toBe(DESTROYED_KEY);
    expect(input!.Item["timestamp"]).toBe("2026-09-02T00:00:00.000Z#atlas");
    expect(input!.Item["agent"]).toBe("atlas");
    expect("legacy" in input!.Item).toBe(false);
  });

  test("query reads the one partition newest first, paginated, filtered by name", async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [item("atlas", "2026-09-03T00:00:00.000Z")],
        LastEvaluatedKey: { name: DESTROYED_KEY, timestamp: "x" },
      })
      .resolvesOnce({ Items: [item("atlas", "2026-09-02T00:00:00.000Z")] });
    const rows = await stores().events.queryTombstones({ name: "atlas" });
    expect(rows.map((r) => r.destroyed_at)).toEqual([
      "2026-09-03T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
    ]);
    expect(rows[0]!.name).toBe("atlas");
    expect(rows[0]!.legacy).toBe(false);

    const inputs = inputsOf<{
      KeyConditionExpression: string;
      FilterExpression: string;
      ScanIndexForward: boolean;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
      Limit?: number;
      ExclusiveStartKey?: unknown;
    }>(ddb, QueryCommand);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.KeyConditionExpression).toBe("#name = :pk");
    expect(inputs[0]!.FilterExpression).toBe("#agent = :agent");
    expect(inputs[0]!.ExpressionAttributeValues).toEqual({ ":pk": DESTROYED_KEY, ":agent": "atlas" });
    expect(inputs[0]!.ScanIndexForward).toBe(false);
    // The limit is honoured after the filter, so it is never handed to DynamoDB.
    expect(inputs[0]!.Limit).toBeUndefined();
    expect(inputs[1]!.ExclusiveStartKey).toEqual({ name: DESTROYED_KEY, timestamp: "x" });
  });

  test("an unfiltered query declares no filter aliases, and the limit stops the walk", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [item("atlas", "2026-09-03T00:00:00.000Z"), item("ember", "2026-09-02T00:00:00.000Z")],
      LastEvaluatedKey: { name: DESTROYED_KEY, timestamp: "x" },
    });
    const rows = await stores().events.queryTombstones({ limit: 1 });
    expect(rows.map((r) => r.name)).toEqual(["atlas"]);
    const inputs = inputsOf<{
      FilterExpression?: string;
      ExpressionAttributeNames: Record<string, string>;
    }>(ddb, QueryCommand);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.FilterExpression).toBeUndefined();
    expect(inputs[0]!.ExpressionAttributeNames).toEqual({ "#name": "name" });
  });

  /**
   * The events table is writable by the boxes, so the `_destroyed` partition
   * can hold an item nobody's tombstone writer produced. One such item must
   * not fail the destroyed view for every other name.
   */
  test("an item that does not parse is skipped, and the limit counts what parsed", async () => {
    const malformed = { ...item("atlas", "2026-09-04T00:00:00.000Z"), volume_kept: "yes", size: 7 };
    ddb.on(QueryCommand).resolves({
      Items: [
        malformed,
        { name: DESTROYED_KEY, timestamp: "garbage" },
        item("ember", "2026-09-03T00:00:00.000Z"),
        item("atlas", "2026-09-02T00:00:00.000Z"),
      ],
    });
    const all = await stores().events.queryTombstones();
    expect(all.map((r) => `${r.name}@${r.destroyed_at}`)).toEqual([
      "ember@2026-09-03T00:00:00.000Z",
      "atlas@2026-09-02T00:00:00.000Z",
    ]);
    // A malformed newest item reads as absent: `limit: 1` is the newest
    // *readable* tombstone, not nothing.
    const newest = await stores().events.queryTombstones({ limit: 1 });
    expect(newest.map((r) => r.name)).toEqual(["ember"]);
  });
});
