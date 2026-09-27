import { beforeEach, describe, expect, test } from "bun:test";
import {
  CreateTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateContinuousBackupsCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  DescribeContinuousBackupsCommandOutput,
  DescribeTableCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { guardClient } from "../src/aws/client.ts";
import { createDynamoDirectory } from "../src/aws/directory.ts";
import { HermeticError } from "../src/errors.ts";
import { DIRECTORY_TABLE } from "../src/schema/index.ts";
import type { DirectoryEntry } from "../src/schema/index.ts";
import { callCount, inputsOf } from "./aws-harness.ts";

/**
 * The directory's own table management is the half of this module that has no
 * equivalent anywhere else in core: everything else hermetic provisions comes
 * out of CloudFormation, and this one table is created by the SDK because it
 * has to outlive any single fleet's stack (§4.8). So the assertions here are
 * mostly about the *arguments* of that creation — the billing mode, the table
 * class, deletion protection and the bounded PITR window are the cost and
 * recoverability decisions, and a silent drift in any of them would never show
 * up in a behavioural test.
 *
 * `aws-sdk-client-mock@4` under `bun test`, hand-rolled assertions over
 * `commandCalls` — the same shape as `aws-dynamo.test.ts`, for the same reason.
 */

const ddb = mockClient(DynamoDBClient);
const doc = mockClient(DynamoDBDocumentClient);

const REGION = "us-east-1";

function directory() {
  // The module refuses a client `aws.client()` did not build, so attach a no-op
  // guard; `aws-client.test.ts` owns the guard's own behaviour.
  const client = guardClient(new DynamoDBClient({ region: REGION }), async () => {});
  return createDynamoDirectory({
    client,
    region: REGION,
    accountId: "123456789012",
    createTimeoutSeconds: 5,
  });
}

/** aws-sdk-client-mock cannot fabricate the error classes, so build lookalikes. */
function awsError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/**
 * A cancelled transaction, with the per-item reasons DynamoDB attaches. Only
 * `ConditionalCheckFailed` means "somebody holds this"; `TransactionConflict`
 * and the throttling codes mean "ask again", and the two must not be answered
 * with the same sentence.
 */
function cancelled(...codes: string[]): Error {
  const e = awsError("TransactionCanceledException");
  return Object.assign(e, { CancellationReasons: codes.map((Code) => ({ Code })) });
}

/** `ConditionalCheckFailed` for the alias row of a two-item transaction. */
const ALIAS_TAKEN = () => cancelled("None", "ConditionalCheckFailed");

/**
 * The same entry as it is *written* (§4.8): keyed by `fleet/<fleet_id>`, with
 * the display label in `alias`. What a `GetItem` on a migrated table answers
 * with, as opposed to `entry()`, which is the pre-v9 shape.
 */
function stored(e: DirectoryEntry): Record<string, unknown> {
  const { name, ...rest } = e;
  return {
    ...rest,
    name: `fleet/${e.fleet_id}`,
    ...(name === null ? {} : { alias: name }),
    kind: "fleet",
    version: 2,
  };
}

function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    name: "main",
    fleet_id: "fxtr0001",
    account_id: "123456789012",
    region: "us-west-2",
    status: "active",
    stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic-fxtr0001/abc",
    foundation_version: 2,
    hermetic_version: "0.5.0",
    tailnet: "hermetic.ts.net",
    created_at: "2026-07-20T09:00:00.000Z",
    created_by: "arn:aws:iam::123456789012:user/e",
    updated_at: "2026-07-20T09:00:00.000Z",
    updated_by: "arn:aws:iam::123456789012:user/e",
    ...overrides,
  };
}

const ACTIVE_TABLE: Partial<DescribeTableCommandOutput> = {
  Table: {
    TableName: DIRECTORY_TABLE,
    TableStatus: "ACTIVE",
    ItemCount: 2,
    BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
    DeletionProtectionEnabled: true,
  },
};

function backups(
  enabled: boolean,
  days: number | null,
): Partial<DescribeContinuousBackupsCommandOutput> {
  return {
    ContinuousBackupsDescription: {
      ContinuousBackupsStatus: enabled ? "ENABLED" : "DISABLED",
      PointInTimeRecoveryDescription: {
        PointInTimeRecoveryStatus: enabled ? "ENABLED" : "DISABLED",
        ...(days === null ? {} : { RecoveryPeriodInDays: days }),
      },
    },
  };
}

beforeEach(() => {
  ddb.reset();
  doc.reset();
  doc.on(ScanCommand).resolves({ Items: [] });
});

describe("ensure", () => {
  test("creates the table when it is missing, waits, then bounds PITR to 7 days", async () => {
    ddb
      .on(DescribeTableCommand)
      .rejectsOnce(awsError("ResourceNotFoundException"))
      .resolves(ACTIVE_TABLE);
    ddb.on(CreateTableCommand).resolves({});
    ddb.on(UpdateContinuousBackupsCommand).resolves({});
    ddb.on(DescribeContinuousBackupsCommand).resolves(backups(true, 7));

    const status = await directory().ensure();

    const created = inputsOf(ddb, CreateTableCommand)[0];
    expect(created).toMatchObject({
      TableName: DIRECTORY_TABLE,
      KeySchema: [{ AttributeName: "name", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "name", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
      TableClass: "STANDARD",
      DeletionProtectionEnabled: true,
      Tags: [{ Key: "hermetic:managed", Value: "directory" }],
    });
    // The create is followed by the waiter's own DescribeTable, and then by the
    // DescribeTable `status()` makes: three in total, one of them the wait.
    expect(callCount(ddb, DescribeTableCommand)).toBeGreaterThanOrEqual(3);
    expect(inputsOf(ddb, UpdateContinuousBackupsCommand)[0]).toEqual({
      TableName: DIRECTORY_TABLE,
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
        RecoveryPeriodInDays: 7,
      },
    });
    expect(status).toMatchObject({
      region: REGION,
      table: DIRECTORY_TABLE,
      exists: true,
      billing_mode: "PAY_PER_REQUEST",
      pitr_enabled: true,
      pitr_recovery_days: 7,
      deletion_protection: true,
      fleets: [],
    });
  });

  test("a table another laptop created a second earlier is not a failure", async () => {
    ddb
      .on(DescribeTableCommand)
      .rejectsOnce(awsError("ResourceNotFoundException"))
      .resolves(ACTIVE_TABLE);
    ddb.on(CreateTableCommand).rejects(awsError("ResourceInUseException"));
    ddb.on(UpdateContinuousBackupsCommand).resolves({});
    ddb.on(DescribeContinuousBackupsCommand).resolves(backups(true, 7));

    expect((await directory().ensure()).exists).toBe(true);
  });

  test("re-applies PITR on an existing table that has it switched off", async () => {
    ddb.on(DescribeTableCommand).resolves(ACTIVE_TABLE);
    ddb
      .on(DescribeContinuousBackupsCommand)
      .resolvesOnce(backups(false, null))
      .resolves(backups(true, 7));
    ddb.on(UpdateContinuousBackupsCommand).resolves({});

    const status = await directory().ensure();

    expect(callCount(ddb, CreateTableCommand)).toBe(0);
    expect(callCount(ddb, UpdateContinuousBackupsCommand)).toBe(1);
    expect(status.pitr_enabled).toBe(true);
    expect(status.pitr_recovery_days).toBe(7);
  });

  test("re-applies PITR when the window has drifted off 7 days", async () => {
    ddb.on(DescribeTableCommand).resolves(ACTIVE_TABLE);
    ddb.on(DescribeContinuousBackupsCommand).resolvesOnce(backups(true, 35)).resolves(backups(true, 7));
    ddb.on(UpdateContinuousBackupsCommand).resolves({});

    await directory().ensure();
    expect(callCount(ddb, UpdateContinuousBackupsCommand)).toBe(1);
  });

  test("leaves a healthy table alone", async () => {
    ddb.on(DescribeTableCommand).resolves(ACTIVE_TABLE);
    ddb.on(DescribeContinuousBackupsCommand).resolves(backups(true, 7));

    await directory().ensure();

    expect(callCount(ddb, CreateTableCommand)).toBe(0);
    expect(callCount(ddb, UpdateContinuousBackupsCommand)).toBe(0);
    expect(callCount(ddb, UpdateTableCommand)).toBe(0);
  });

  test("puts deletion protection back when somebody cleared it", async () => {
    ddb.on(DescribeTableCommand).resolves({
      Table: { ...ACTIVE_TABLE.Table, DeletionProtectionEnabled: false },
    });
    ddb.on(DescribeContinuousBackupsCommand).resolves(backups(true, 7));
    ddb.on(UpdateTableCommand).resolves({});

    await directory().ensure();

    expect(inputsOf(ddb, UpdateTableCommand)[0]).toEqual({
      TableName: DIRECTORY_TABLE,
      DeletionProtectionEnabled: true,
    });
  });
});

describe("status", () => {
  test("a missing table is a fact, not a failure", async () => {
    ddb.on(DescribeTableCommand).rejects(awsError("ResourceNotFoundException"));

    expect(await directory().status()).toEqual({
      region: REGION,
      table: DIRECTORY_TABLE,
      exists: false,
      billing_mode: null,
      pitr_enabled: false,
      pitr_recovery_days: null,
      deletion_protection: false,
      item_count: null,
      // §4.8: nothing there is nothing unreadable either.
      unparseable: 0,
      fleets: [],
    });
    // Nothing else was asked: no backups call, no scan, on a table that is not there.
    expect(callCount(ddb, DescribeContinuousBackupsCommand)).toBe(0);
    expect(callCount(doc, ScanCommand)).toBe(0);
  });

  test("reports every fleet, sorted by name, and skips a row it cannot parse", async () => {
    ddb.on(DescribeTableCommand).resolves(ACTIVE_TABLE);
    ddb.on(DescribeContinuousBackupsCommand).resolves(backups(true, 7));
    doc.on(ScanCommand).resolves({
      Items: [
        entry({ name: "staging", fleet_id: "sg7k2m4p", foundation_version: 1 }),
        { name: "half-written" },
        entry(),
      ],
    });

    const status = await directory().status();
    expect(status.fleets.map((f) => f.name)).toEqual(["main", "staging"]);
    expect(status.item_count).toBe(2);
  });
});

describe("items", () => {
  /**
   * §4.6: the partition key is the fleet's immutable id, and the display alias
   * rides on the row as `alias`. `attribute_not_exists(name)` is what makes a
   * register a claim rather than an overwrite.
   */
  test("register claims the fleet id row", async () => {
    doc.on(PutCommand).resolves({});
    expect(await directory().register(entry({ name: null }))).toBe(true);
    const put = inputsOf(doc, PutCommand)[0] as Record<string, unknown>;
    expect(put).toMatchObject({
      TableName: DIRECTORY_TABLE,
      ConditionExpression: "attribute_not_exists(#n)",
      ExpressionAttributeNames: { "#n": "name" },
    });
    expect((put["Item"] as Record<string, unknown>)["name"]).toBe("fleet/fxtr0001");
    expect((put["Item"] as Record<string, unknown>)["alias"]).toBeUndefined();
    // No alias, so no reservation to make: one row, one write.
    expect(callCount(doc, TransactWriteCommand)).toBe(0);
  });

  /**
   * An alias is a second row, claimed in the *same* transaction as the fleet
   * row — DynamoDB has no unique constraint on a non-key attribute, so this is
   * what makes "one label, one fleet" atomic.
   */
  test("register with an alias reserves it in the same transaction", async () => {
    doc.on(TransactWriteCommand).resolves({});
    expect(await directory().register(entry())).toBe(true);
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Item?: Record<string, unknown>; ConditionExpression?: string }>>;
    expect(items).toHaveLength(2);
    expect(items[0]?.["Put"]?.Item?.["name"]).toBe("fleet/fxtr0001");
    expect(items[0]?.["Put"]?.Item?.["alias"]).toBe("main");
    expect(items[1]?.["Put"]?.Item).toMatchObject({
      name: "alias/main",
      kind: "alias",
      fleet_id: "fxtr0001",
    });
    expect(items[1]?.["Put"]?.ConditionExpression).toBe("attribute_not_exists(#n)");
  });

  test("register answers false when the alias is taken", async () => {
    doc.on(TransactWriteCommand).rejects(ALIAS_TAKEN());
    expect(await directory().register(entry())).toBe(false);
  });

  /**
   * A cancellation is not a refusal. `TransactionConflict` and the throttling
   * codes are "ask again", and answering them with `false` reported a throttled
   * write as `NAME_TAKEN` — a confident answer to a question nobody asked.
   */
  test("a transaction cancelled for anything but the condition throws", async () => {
    doc.on(TransactWriteCommand).rejects(cancelled("TransactionConflict"));
    const e = await directory()
      .register(entry())
      .catch((err: unknown) => err);
    expect((e as HermeticError).code).toBe("DIRECTORY_UNAVAILABLE");
  });

  test("a cancellation with no reasons at all throws rather than guessing", async () => {
    doc.on(TransactWriteCommand).rejects(awsError("TransactionCanceledException"));
    const e = await directory()
      .register(entry())
      .catch((err: unknown) => err);
    expect((e as HermeticError).code).toBe("DIRECTORY_UNAVAILABLE");
  });

  test("register answers false when the fleet id is already there", async () => {
    doc.on(PutCommand).rejects(awsError("ConditionalCheckFailedException"));
    expect(await directory().register(entry({ name: null }))).toBe(false);
  });

  /**
   * An update that leaves the alias alone is one conditional `Put`, guarded on
   * the row still being this fleet's *and* its alias still being the one that
   * was read — so two laptops relabelling one fleet produce a winner and a
   * `false`, never a lost update.
   */
  test("update rewrites the row in place when the alias does not move", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    doc.on(PutCommand).resolves({});
    expect(await directory().update(entry({ status: "torn_down" }))).toBe(true);
    expect(inputsOf(doc, PutCommand)[0]).toMatchObject({
      ConditionExpression: "fleet_id = :id AND #a = :old",
      ExpressionAttributeNames: { "#a": "alias" },
      ExpressionAttributeValues: { ":id": "fxtr0001", ":old": "main" },
    });
  });

  /** Moving a label is claim-new, release-old, rewrite-row — all or nothing. */
  test("update moves the alias reservation with the row", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    doc.on(TransactWriteCommand).resolves({});
    expect(await directory().update(entry({ name: "prod" }))).toBe(true);
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<
      Record<
        string,
        {
          Item?: Record<string, unknown>;
          Key?: Record<string, unknown>;
          ConditionExpression?: string;
          ExpressionAttributeNames?: Record<string, string>;
          ExpressionAttributeValues?: Record<string, unknown>;
        }
      >
    >;
    expect(items).toHaveLength(3);
    expect(items[1]?.["Put"]).toMatchObject({
      Item: { name: "alias/prod", kind: "alias", fleet_id: "fxtr0001" },
      ConditionExpression: "attribute_not_exists(#n)",
      ExpressionAttributeNames: { "#n": "name" },
    });
    // The release is conditional on the reservation being *this* fleet's, so a
    // laptop racing the same label cannot free somebody else's.
    expect(items[2]?.["Delete"]).toMatchObject({
      Key: { name: "alias/main" },
      ConditionExpression: "fleet_id = :id",
      ExpressionAttributeValues: { ":id": "fxtr0001" },
    });
  });

  /** Clearing a label releases its reservation and writes no `alias` attribute. */
  test("update --clear drops the alias attribute and its reservation", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    doc.on(TransactWriteCommand).resolves({});
    expect(await directory().update(entry({ name: null }))).toBe(true);
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> }>>;
    expect(items).toHaveLength(2);
    expect(items[0]?.["Put"]?.Item?.["alias"]).toBeUndefined();
    expect(items[1]?.["Delete"]?.Key?.["name"]).toBe("alias/main");
  });

  test("update answers false for a fleet that is not registered", async () => {
    doc.on(GetCommand).resolves({});
    doc.on(ScanCommand).resolves({ Items: [] });
    expect(await directory().update(entry())).toBe(false);
  });

  /**
   * §4.8: a write against a directory nobody has migrated yet moves that fleet
   * first rather than reporting `false`. Without it `teardown` from an upgraded
   * binary leaves the row `active` for ever — it reads the fleet, writes
   * nothing, and says it succeeded.
   */
  test("update repairs a pre-v9 row before writing to it", async () => {
    const legacy = entry();
    // Miss on `fleet/<id>`, then the migrated row once `migrateFleet` has run.
    doc
      .on(GetCommand)
      .resolvesOnce({})
      .resolves({ Item: stored(legacy) });
    doc.on(ScanCommand).resolves({ Items: [legacy] });
    doc.on(TransactWriteCommand).resolves({});
    doc.on(PutCommand).resolves({});

    expect(await directory().update(entry({ status: "torn_down" }))).toBe(true);
    // The move happened: the canonical row and its reservation were written.
    const moved = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Item?: Record<string, unknown> }>>;
    expect(moved[0]?.["Put"]?.Item?.["name"]).toBe("fleet/fxtr0001");
    // And then the status write landed on it.
    expect((inputsOf(doc, PutCommand)[0] as Record<string, unknown>)["Item"]).toMatchObject({
      name: "fleet/fxtr0001",
      status: "torn_down",
    });
  });

  test("update answers false when the alias it wants is already held", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    doc.on(TransactWriteCommand).rejects(ALIAS_TAKEN());
    expect(await directory().update(entry({ name: "prod" }))).toBe(false);
  });

  /**
   * §4.6: the optimistic guard is the caller's, not this method's. `expect`
   * carries the alias the caller *read*, so a row that moved between that read
   * and this write loses — without the write being attempted at all.
   */
  test("update refuses when the alias moved since the caller read it", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry({ name: "moved" })) });
    doc.on(PutCommand).resolves({});
    doc.on(TransactWriteCommand).resolves({});
    expect(await directory().update(entry({ name: "prod" }), { alias: "main" })).toBe(false);
    expect(callCount(doc, TransactWriteCommand)).toBe(0);
    expect(callCount(doc, PutCommand)).toBe(0);
  });

  test("update conditions on the alias the caller read, not the one it re-read", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    doc.on(PutCommand).resolves({});
    expect(await directory().update(entry({ status: "torn_down" }), { alias: "main" })).toBe(true);
    expect(inputsOf(doc, PutCommand)[0]).toMatchObject({
      ConditionExpression: "fleet_id = :id AND #a = :old",
      ExpressionAttributeValues: { ":id": "fxtr0001", ":old": "main" },
    });
  });

  /** An aliasless fleet's guard is "still has no alias", not "alias = null". */
  test("update guards an aliasless row with attribute_not_exists", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry({ name: null })) });
    doc.on(PutCommand).resolves({});
    expect(await directory().update(entry({ name: null, status: "torn_down" }))).toBe(true);
    expect(inputsOf(doc, PutCommand)[0]).toMatchObject({
      ConditionExpression: "fleet_id = :id AND attribute_not_exists(#a)",
      ExpressionAttributeNames: { "#a": "alias" },
    });
  });

  test("get returns null for a fleet nobody registered", async () => {
    doc.on(GetCommand).resolves({});
    expect(await directory().get("nope")).toBeNull();
  });

  test("get parses the item it found, and reads its alias back as the name", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    const found = await directory().get("fxtr0001");
    expect(found?.fleet_id).toBe("fxtr0001");
    expect(found?.name).toBe("main");
  });

  /**
   * §4.8: a pre-v9 row is keyed by the fleet's *name*, so the `GetItem` this
   * method leads with cannot reach it — the fallback scan is what makes a
   * directory nobody has migrated yet still answer. Without it a `teardown`
   * from an upgraded binary would report "there was no directory entry" and
   * leave the row `active` forever.
   */
  test("get falls back to a scan for a pre-v9 row keyed by its name", async () => {
    doc.on(GetCommand).resolves({});
    doc.on(ScanCommand).resolves({ Items: [entry()] });

    const found = await directory().get("fxtr0001");
    expect(found?.name).toBe("main");
    expect(found?.fleet_id).toBe("fxtr0001");

    // The key really is the id-derived one — the mock ignores `Key`, so this is
    // the only thing standing between the test and a false pass.
    expect((inputsOf(doc, GetCommand)[0] as Record<string, unknown>)["Key"]).toEqual({
      name: "fleet/fxtr0001",
    });
    // And the fallback asks for this fleet's rows, excluding the bookkeeping
    // ones (`alias`/`legacy_duplicate` rows carry a `fleet_id` too).
    expect(inputsOf(doc, ScanCommand)[0]).toMatchObject({
      FilterExpression: "fleet_id = :id AND attribute_not_exists(#k)",
      ExpressionAttributeNames: { "#k": "kind" },
      ExpressionAttributeValues: { ":id": "fxtr0001" },
    });
  });

  /** A migrated directory pays one `GetItem` and never reaches the scan. */
  test("get does not scan when the fleet-id row is there", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    expect((await directory().get("fxtr0001"))?.name).toBe("main");
    expect(callCount(doc, ScanCommand)).toBe(0);
  });

  test("get is still null when neither the row nor a legacy one exists", async () => {
    doc.on(GetCommand).resolves({});
    doc.on(ScanCommand).resolves({ Items: [] });
    expect(await directory().get("fxtr0001")).toBeNull();
  });

  /**
   * Two legacy rows for one fleet — an interrupted pre-v9 rename. The read has
   * to pick the same one the migration will keep, or the answer changes the
   * moment somebody runs `foundation update`.
   */
  test("get picks the same legacy row the migration would keep", async () => {
    const older = entry({ name: "old", updated_at: "2026-07-01T00:00:00.000Z" });
    const newer = entry({ name: "prod", updated_at: "2026-08-01T00:00:00.000Z" });
    doc.on(GetCommand).resolves({});

    doc.on(ScanCommand).resolves({ Items: [older, newer] });
    expect((await directory().get("fxtr0001"))?.name).toBe("prod");
    doc.on(ScanCommand).resolves({ Items: [newer, older] });
    expect((await directory().get("fxtr0001"))?.name).toBe("prod");
  });

  /** A removed fleet releases the label it was holding. */
  test("remove drops the fleet row and its alias reservation together", async () => {
    doc.on(GetCommand).resolves({ Item: stored(entry()) });
    doc.on(TransactWriteCommand).resolves({});
    expect(await directory().remove("fxtr0001")).toBe(true);
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Key?: Record<string, unknown> }>>;
    expect(items.map((i) => i["Delete"]?.Key?.["name"])).toEqual(["fleet/fxtr0001", "alias/main"]);
  });
});

/**
 * Foundation v9 (§4.8): rows keyed by the fleet's *name* move onto its
 * `fleet_id`, and the name they carried becomes a reserved display alias. The
 * table is account-global, so this runs from `ensure()` on every `init` and
 * again from the v9 migration hook — which is only safe because it is a no-op
 * the second time.
 */
describe("migrate", () => {
  test("moves a pre-v9 row onto its fleet id and reserves the label it carried", async () => {
    doc.on(ScanCommand).resolves({ Items: [entry()] });
    doc.on(GetCommand).resolves({});
    doc.on(TransactWriteCommand).resolves({});

    expect(await directory().migrate()).toEqual({ fleets: 1, aliases: 1, duplicates: 0 });
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> }>>;
    expect(items[0]?.["Put"]?.Item).toMatchObject({
      name: "fleet/fxtr0001",
      alias: "main",
      kind: "fleet",
      version: 2,
    });
    expect(items[1]?.["Put"]?.Item).toMatchObject({ name: "alias/main", fleet_id: "fxtr0001" });
    // The old key goes only once its replacement is in the same transaction.
    expect(items[2]?.["Delete"]?.Key?.["name"]).toBe("main");
  });

  /** An aliasless pre-v9 row has no label to reserve, so two writes become one. */
  test("a pre-v9 row with no name reserves nothing", async () => {
    doc.on(ScanCommand).resolves({ Items: [{ ...entry(), name: null }] });
    doc.on(GetCommand).resolves({});
    doc.on(TransactWriteCommand).resolves({});
    expect(await directory().migrate()).toEqual({ fleets: 1, aliases: 0, duplicates: 0 });
  });

  /** Idempotent: a table this build already wrote is scanned and left alone. */
  test("re-running over migrated rows writes nothing", async () => {
    doc.on(ScanCommand).resolves({ Items: [stored(entry())] });
    expect(await directory().migrate()).toEqual({ fleets: 0, aliases: 0, duplicates: 0 });
    expect(callCount(doc, TransactWriteCommand)).toBe(0);
    expect(callCount(doc, PutCommand)).toBe(0);
  });

  /** Reservation rows are bookkeeping, not fleets: the scan steps over them. */
  test("alias reservation rows are not themselves migrated", async () => {
    doc.on(ScanCommand).resolves({
      Items: [{ name: "alias/main", kind: "alias", version: 2, fleet_id: "fxtr0001" }],
    });
    expect(await directory().migrate()).toEqual({ fleets: 0, aliases: 0, duplicates: 0 });
    expect(callCount(doc, TransactWriteCommand)).toBe(0);
  });

  /**
   * An interrupted pre-v9 rename can leave two rows for one fleet. Exactly one
   * becomes the fleet's row; the other is marked as history rather than deleted
   * — a fleet has exactly one current alias, and dropping the older spelling
   * silently would erase the only record it was ever used.
   */
  test("a second row for a fleet is kept as history and the newest one wins", async () => {
    const older = entry({ name: "old", updated_at: "2026-07-01T00:00:00.000Z" });
    const newer = entry({ name: "prod", updated_at: "2026-08-01T00:00:00.000Z" });
    doc.on(ScanCommand).resolves({ Items: [older, newer] });
    doc.on(GetCommand).resolves({});
    doc.on(PutCommand).resolves({});
    doc.on(TransactWriteCommand).resolves({});

    expect(await directory().migrate()).toEqual({ fleets: 1, aliases: 1, duplicates: 1 });
    expect((inputsOf(doc, PutCommand)[0] as Record<string, unknown>)["Item"]).toMatchObject({
      name: "old",
      kind: "legacy_duplicate",
    });
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Item?: Record<string, unknown> }>>;
    expect(items[0]?.["Put"]?.Item).toMatchObject({ name: "fleet/fxtr0001", alias: "prod" });
  });

  /**
   * And which one wins cannot depend on the order DynamoDB happened to return
   * them in: a `Scan` has no promised order, so the same table must migrate to
   * the same rows on every laptop and every re-run.
   */
  test("the winner is the same in either scan order", async () => {
    const older = entry({ name: "old", updated_at: "2026-07-01T00:00:00.000Z" });
    const newer = entry({ name: "prod", updated_at: "2026-08-01T00:00:00.000Z" });
    const aliasOf = async (items: DirectoryEntry[]): Promise<unknown> => {
      doc.reset();
      doc.on(ScanCommand).resolves({ Items: items });
      doc.on(GetCommand).resolves({});
      doc.on(PutCommand).resolves({});
      doc.on(TransactWriteCommand).resolves({});
      await directory().migrate();
      const transact = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
        "TransactItems"
      ] as Array<Record<string, { Item?: Record<string, unknown> }>>;
      return transact[0]?.["Put"]?.Item?.["alias"];
    };
    expect(await aliasOf([older, newer])).toBe("prod");
    expect(await aliasOf([newer, older])).toBe("prod");
  });

  /** An exact tie is broken by the key, so it is still one fixed answer. */
  test("two rows stamped at the same instant are broken by the key", async () => {
    const at = "2026-07-01T00:00:00.000Z";
    const a = entry({ name: "alpha", updated_at: at });
    const z = entry({ name: "zulu", updated_at: at });
    doc.on(ScanCommand).resolves({ Items: [z, a] });
    doc.on(GetCommand).resolves({});
    doc.on(PutCommand).resolves({});
    doc.on(TransactWriteCommand).resolves({});
    await directory().migrate();
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Item?: Record<string, unknown> }>>;
    expect(items[0]?.["Put"]?.Item?.["alias"]).toBe("alpha");
  });

  /** An attribute this build does not know about survives the move. */
  test("unknown attributes on a legacy row are carried across", async () => {
    doc.on(ScanCommand).resolves({ Items: [{ ...entry(), written_by_a_newer_build: "keep me" }] });
    doc.on(GetCommand).resolves({});
    doc.on(TransactWriteCommand).resolves({});
    await directory().migrate();
    const items = (inputsOf(doc, TransactWriteCommand)[0] as Record<string, unknown>)[
      "TransactItems"
    ] as Array<Record<string, { Item?: Record<string, unknown> }>>;
    expect(items[0]?.["Put"]?.Item?.["written_by_a_newer_build"]).toBe("keep me");
  });
});

describe("failures", () => {
  test("an SDK failure on the table read is DIRECTORY_UNAVAILABLE", async () => {
    ddb.on(DescribeTableCommand).rejects(awsError("AccessDeniedException", "not authorized"));
    const e = await directory()
      .status()
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(HermeticError);
    expect((e as HermeticError).code).toBe("DIRECTORY_UNAVAILABLE");
    expect((e as HermeticError).message).toContain("not authorized");
  });

  test("an SDK failure on the scan is DIRECTORY_UNAVAILABLE", async () => {
    doc.on(ScanCommand).rejects(awsError("ProvisionedThroughputExceededException", "slow down"));
    const e = await directory()
      .list()
      .catch((err: unknown) => err);
    expect((e as HermeticError).code).toBe("DIRECTORY_UNAVAILABLE");
  });

  test("a create that fails for a real reason is DIRECTORY_UNAVAILABLE", async () => {
    ddb.on(DescribeTableCommand).rejects(awsError("ResourceNotFoundException"));
    ddb.on(CreateTableCommand).rejects(awsError("AccessDeniedException", "no dynamodb:CreateTable"));
    const e = await directory()
      .ensure()
      .catch((err: unknown) => err);
    expect((e as HermeticError).code).toBe("DIRECTORY_UNAVAILABLE");
    expect((e as HermeticError).details?.["table"]).toBe(DIRECTORY_TABLE);
  });

  test("a write that fails for a reason other than the condition throws", async () => {
    doc.on(PutCommand).rejects(awsError("ValidationException", "item too large"));
    const e = await directory()
      .register(entry({ name: null }))
      .catch((err: unknown) => err);
    expect((e as HermeticError).code).toBe("DIRECTORY_UNAVAILABLE");
  });

  test("a client that carries no account guard is a programming error", () => {
    expect(() =>
      createDynamoDirectory({ client: new DynamoDBClient({ region: REGION }), region: REGION }),
    ).toThrow(/account guard/);
  });
});
