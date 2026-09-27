import {
  CreateTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  UpdateContinuousBackupsCommand,
  UpdateTableCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import type { ScanCommandOutput, TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DirectoryEntry, DirectoryStatus } from "../schema/index.ts";
import {
  DIRECTORY_PITR_DAYS,
  DIRECTORY_TABLE,
  DirectoryEntry as DirectoryEntrySchema,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import type { DirectoryApi } from "../backend/types.ts";
import { accountGuardOf, guardClient, isAwsError } from "./client.ts";

/**
 * The account-global fleet directory, on real DynamoDB.
 *
 * It is provisioned here, by the SDK, and not by the foundation template — that
 * is the one structural decision this file exists to hold. The per-fleet stack
 * is deleted by `teardown`, and a directory owned by it would be deleted with
 * whichever fleet happened to be torn down first, erasing the account's index
 * of every *other* fleet. So: `CreateTable` from the laptop, idempotent, and
 * `DeletionProtectionEnabled` so nobody can casually undo it either.
 *
 * Cheapest thing that is still recoverable (§4.8): `PAY_PER_REQUEST` (a handful
 * of items read a handful of times a day), the `STANDARD` table class,
 * AWS-owned encryption, and point-in-time recovery bounded to
 * `DIRECTORY_PITR_DAYS` as the *only* backup — no on-demand backups, no DLM, no
 * global tables. A 7-day window costs cents on a table this size and still
 * answers the question PITR is here for: somebody deleted a fleet's row by hand
 * last night.
 *
 * `ensure()` is idempotent in the strong sense — it is safe to call on every
 * `init`, and it repairs drift rather than merely tolerating it: a table whose
 * PITR was switched off, or whose deletion protection was cleared, is put back.
 * Everything else about the table (its keys, its class) is fixed at creation and
 * never rewritten, because changing those in place is a different operation with
 * different failure modes and no caller has ever asked for it.
 *
 * Every SDK failure leaves this module as `DIRECTORY_UNAVAILABLE`. That is
 * deliberately one code rather than a translation of DynamoDB's vocabulary: to
 * every caller the interesting distinction is "we could talk to the directory"
 * versus "we could not", and `init` stops before any stack work on the second.
 * `status()` is the single exception — a table that is simply absent is a fact
 * it reports (`exists: false`), not a failure, because "there is no directory
 * yet" is the state a first `init` starts from.
 */

/**
 * The two kinds of row this table holds, and the key prefixes that keep them
 * from colliding with each other — or with a pre-v2 row, whose key is a bare
 * fleet name and therefore contains no `/` at all.
 */
const FLEET_KIND = "fleet";
const ALIAS_KIND = "alias";
/** A pre-v2 row this build could not safely fold into its fleet row; kept, never read. */
const LEGACY_DUPLICATE_KIND = "legacy_duplicate";
const FLEET_KEY_PREFIX = "fleet/";
const ALIAS_KEY_PREFIX = "alias/";
/** Stamped on every row this build writes, so a later one can tell them apart. */
const DIRECTORY_ROW_VERSION = 2;

/**
 * Whether a write failed **its own condition**, as opposed to simply failing.
 *
 * `TransactWriteItems` reports both through one exception name. A cancelled
 * transaction carries a `CancellationReasons` array with one entry per item,
 * and only `ConditionalCheckFailed` there means "somebody else holds this" —
 * `TransactionConflict`, `ThrottlingError` and `ProvisionedThroughputExceeded`
 * mean "ask again". Mapping every cancellation to `false` reported a throttled
 * alias write as `NAME_TAKEN` and a throttled removal as "there was nothing
 * there", which are two confident answers to a question that was never asked.
 *
 * A cancellation with no reasons at all is *not* treated as a condition
 * failure: the only honest reading of "cancelled, and here is no reason" is
 * that the caller does not know why.
 */
function isConditionFailure(e: unknown): boolean {
  if (isAwsError(e, "ConditionalCheckFailedException")) return true;
  if (!isAwsError(e, "TransactionCanceledException")) return false;
  const reasons = (e as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return false;
  return reasons.some((r) => (r as { Code?: unknown } | null)?.Code === "ConditionalCheckFailed");
}

/** A row that is bookkeeping rather than a fleet: never returned to a caller. */
function isReservation(item: Record<string, unknown>): boolean {
  return item["kind"] === ALIAS_KIND || item["kind"] === LEGACY_DUPLICATE_KIND;
}

/**
 * A row written by this build's layout, as opposed to a pre-alias one. Both
 * callers run `isReservation` first, so the bare `version` test cannot pick up
 * an `alias`/`legacy_duplicate` row — which also carries this version.
 */
function isModern(item: Record<string, unknown>): boolean {
  return item["kind"] === FLEET_KIND || item["version"] === DIRECTORY_ROW_VERSION;
}

/** What `directory.migrate()` moved, for the migration's own event line. */
export interface DirectoryMigrationResult {
  /** Pre-v2 rows rewritten under their `fleet_id`. */
  fleets: number;
  /** Display aliases whose reservation row was created by that rewrite. */
  aliases: number;
  /** Pre-v2 rows kept as history because a canonical row already existed. */
  duplicates: number;
}

export interface DynamoDirectoryOptions {
  /** Built by `aws.client()` against the *directory* region, so it carries the account guard. */
  client: DynamoDBClient;
  /** The directory region, stated rather than inferred — heads report it. */
  region: string;
  /** The frozen account, carried on the error details of anything that fails. */
  accountId?: string;
  /** Overridable only so a test can use a name of its own; production is `DIRECTORY_TABLE`. */
  table?: string;
  /** Seconds the create waiter may spend before giving up. */
  createTimeoutSeconds?: number;
}

/** One place decides what a directory failure looks like to the rest of core. */
function directoryError(e: unknown, message: string, details: Record<string, unknown>): HermeticError {
  if (e instanceof HermeticError) return e;
  const detail = e instanceof Error ? e.message : String(e);
  return new HermeticError("DIRECTORY_UNAVAILABLE", `${message}: ${detail}`, details);
}

/**
 * DynamoDB answers "no such table" with two different names depending on which
 * API was asked — `DescribeContinuousBackups` says `TableNotFoundException`
 * where `DescribeTable` says `ResourceNotFoundException` — and both mean the
 * same thing here.
 */
function isMissingTable(e: unknown): boolean {
  return isAwsError(e, "ResourceNotFoundException", "TableNotFoundException");
}

/** `DynamoDBDocumentClient.from()` builds a client that does not reuse the proxied `send` (§4.7). */
function docClient(client: DynamoDBClient): DynamoDBDocumentClient {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
  const guard = accountGuardOf(client);
  if (!guard) {
    throw new HermeticError(
      "INTERNAL",
      "the directory DynamoDB client was not built by aws.client(); it carries no account guard",
      {},
    );
  }
  return guardClient(doc, guard);
}

interface TableFacts {
  billing_mode: string | null;
  deletion_protection: boolean;
  item_count: number | null;
}

interface BackupFacts {
  pitr_enabled: boolean;
  pitr_recovery_days: number | null;
}

const ABSENT: DirectoryStatus = {
  region: "",
  table: "",
  exists: false,
  billing_mode: null,
  pitr_enabled: false,
  pitr_recovery_days: null,
  deletion_protection: false,
  item_count: null,
  fleets: [],
  unparseable: 0,
};

export function createDynamoDirectory(opts: DynamoDirectoryOptions): DirectoryApi {
  const table = opts.table ?? DIRECTORY_TABLE;
  const region = opts.region;
  const details = { table, region, ...(opts.accountId ? { account_id: opts.accountId } : {}) };
  const doc = docClient(opts.client);

  /** `null` when the table is not there — the one AWS answer callers act on. */
  async function describeTable(): Promise<TableFacts | null> {
    try {
      const out = await opts.client.send(new DescribeTableCommand({ TableName: table }));
      const t = out.Table;
      return {
        billing_mode: t?.BillingModeSummary?.BillingMode ?? null,
        deletion_protection: t?.DeletionProtectionEnabled === true,
        item_count: typeof t?.ItemCount === "number" ? t.ItemCount : null,
      };
    } catch (e) {
      if (isMissingTable(e)) return null;
      throw directoryError(e, `could not read the ${table} table`, details);
    }
  }

  async function describeBackups(): Promise<BackupFacts> {
    try {
      const out = await opts.client.send(new DescribeContinuousBackupsCommand({ TableName: table }));
      const pitr = out.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
      return {
        pitr_enabled: pitr?.PointInTimeRecoveryStatus === "ENABLED",
        pitr_recovery_days:
          typeof pitr?.RecoveryPeriodInDays === "number" ? pitr.RecoveryPeriodInDays : null,
      };
    } catch (e) {
      if (isMissingTable(e)) return { pitr_enabled: false, pitr_recovery_days: null };
      throw directoryError(e, `could not read the ${table} backup settings`, details);
    }
  }

  /**
   * Wait until the table can be written to. `ensure` is idempotent and two
   * laptops may run `init` seconds apart, so "the table is already there" and
   * "the table is `CREATING`" are the same sentence from DynamoDB's side — and
   * writing to a `CREATING` table fails. The waiter is cheap on a table that is
   * already `ACTIVE`: one `DescribeTable`.
   */
  async function waitActive(): Promise<void> {
    try {
      // The waiter's stock `minDelay` is 20 seconds, which is most of the time a
      // small on-demand table takes to exist at all; two keeps `init`'s first
      // phase from looking hung for no reason.
      await waitUntilTableExists(
        {
          client: opts.client,
          maxWaitTime: opts.createTimeoutSeconds ?? 300,
          minDelay: 2,
          maxDelay: 10,
        },
        { TableName: table },
      );
    } catch (e) {
      throw directoryError(e, `the ${table} table never became ACTIVE`, details);
    }
  }

  async function applyPitr(): Promise<void> {
    try {
      await opts.client.send(
        new UpdateContinuousBackupsCommand({
          TableName: table,
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
            RecoveryPeriodInDays: DIRECTORY_PITR_DAYS,
          },
        }),
      );
    } catch (e) {
      /**
       * Somebody else is doing the same thing to the same table — the other
       * laptop running `init` in this account, or DynamoDB still settling the
       * table after its create. Both mean "the setting is being applied", so
       * the honest move is to look again rather than to fail an `init` over a
       * backup setting that is already on its way on.
       */
      if (isAwsError(e, "ContinuousBackupsUnavailableException", "ResourceInUseException")) return;
      throw directoryError(e, `could not enable point-in-time recovery on ${table}`, details);
    }
  }

  /**
   * Every entry, and a count of the ones this build could not read. The count
   * travels with the list because skipping a row silently is the difference
   * between "there are two fleets" and "there are two fleets I understand" —
   * and only the second is true.
   */
  function publicEntry(item: Record<string, unknown>): DirectoryEntry | null {
    // v2 rows key the table on `fleet/<fleet_id>` and carry the display label
    // in `alias`; pre-v2 rows keyed it on the label itself and have no `alias`.
    if (isReservation(item)) return null;
    const parsed = DirectoryEntrySchema.safeParse({
      ...item,
      name: isModern(item) ? (typeof item.alias === "string" ? item.alias : null) : item.name,
    });
    return parsed.success ? parsed.data : null;
  }

  /**
   * The item as it is written. The partition key is the `fleet_id` — identity,
   * which cannot move — and the display label rides beside it in `alias`, which
   * is what makes relabelling a fleet a one-attribute write rather than a
   * delete and a re-insert under a new key.
   *
   * `alias: undefined` rather than `null` is deliberate: the document client is
   * built with `removeUndefinedValues`, so an aliasless fleet has *no* `alias`
   * attribute at all, and `attribute_not_exists(alias)` is then the condition
   * that means "still unlabelled".
   */
  function storedEntry(entry: DirectoryEntry): Record<string, unknown> {
    return {
      ...entry,
      name: fleetKey(entry.fleet_id),
      alias: entry.name ?? undefined,
      kind: FLEET_KIND,
      version: DIRECTORY_ROW_VERSION,
    };
  }

  /**
   * The reservation row a display alias holds. It is a *row*, not an index,
   * because DynamoDB has no unique constraint on a non-key attribute: the only
   * way to make "this label belongs to exactly one fleet" atomic is to make the
   * label a partition key somewhere, and to write it in the same transaction as
   * the fleet row it labels.
   *
   * It survives teardown with the fleet row it belongs to (§4.7): a torn-down
   * fleet keeps its label reserved so the label cannot silently start meaning a
   * different fleet, and `fleet alias --clear` on that id is what releases it.
   */
  function aliasReservation(alias: string, fleetId: string): Record<string, unknown> {
    return {
      name: aliasKey(alias),
      kind: ALIAS_KIND,
      version: DIRECTORY_ROW_VERSION,
      fleet_id: fleetId,
    };
  }

  function fleetKey(fleetId: string): string {
    return `${FLEET_KEY_PREFIX}${fleetId}`;
  }

  function aliasKey(alias: string): string {
    return `${ALIAS_KEY_PREFIX}${alias}`;
  }

  /** One `GetItem` by fleet id, as the whole raw row. */
  async function rawFleetRow(fleetId: string): Promise<Record<string, unknown> | null> {
    const out = await doc.send(
      new GetCommand({ TableName: table, Key: { name: fleetKey(fleetId) }, ConsistentRead: true }),
    );
    return (out?.Item as Record<string, unknown> | undefined) ?? null;
  }

  /**
   * Pre-v9 rows for one fleet: keyed by the fleet's *name*, so unreachable by
   * key and only findable by filtering on the attribute. Reservation rows carry
   * a `fleet_id` too, so the filter excludes anything that declares a `kind` —
   * only a legacy row has none.
   */
  async function scanLegacyRowsFor(fleetId: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out: ScanCommandOutput = await doc.send(
        new ScanCommand({
          TableName: table,
          ConsistentRead: true,
          FilterExpression: "fleet_id = :id AND attribute_not_exists(#k)",
          ExpressionAttributeNames: { "#k": "kind" },
          ExpressionAttributeValues: { ":id": fleetId },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of out.Items ?? []) {
        const row = item as Record<string, unknown>;
        if (!isReservation(row) && !isModern(row)) rows.push(row);
      }
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return rows;
  }

  async function scanAll(): Promise<{ rows: DirectoryEntry[]; unparseable: number }> {
    const rows: DirectoryEntry[] = [];
    let unparseable = 0;
    let start: Record<string, unknown> | undefined;
    do {
      let out: ScanCommandOutput;
      try {
        out = await doc.send(
          new ScanCommand({
            TableName: table,
            ConsistentRead: true,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
      } catch (e) {
        throw directoryError(e, `could not list the fleets in ${table}`, details);
      }
      for (const item of out.Items ?? []) {
        // One item this build cannot parse — written by a newer hermetic, or
        // half-written — must not take `fleet ls` down with it. The rest of the
        // account's fleets are still worth reporting.
        if (isReservation(item as Record<string, unknown>)) continue;
        const parsed = publicEntry(item as Record<string, unknown>);
        if (parsed) rows.push(parsed);
        else unparseable += 1;
      }
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    rows.sort((a, b) => (a.name ?? a.fleet_id).localeCompare(b.name ?? b.fleet_id));
    return { rows, unparseable };
  }

  async function list(): Promise<DirectoryEntry[]> {
    return (await scanAll()).rows;
  }

  async function status(): Promise<DirectoryStatus> {
    const facts = await describeTable();
    if (!facts) return { ...ABSENT, region, table };
    const [backups, scanned] = await Promise.all([describeBackups(), scanAll()]);
    return {
      region,
      table,
      exists: true,
      ...facts,
      ...backups,
      fleets: scanned.rows,
      unparseable: scanned.unparseable,
    };
  }

  /** Every raw item in the table, one page at a time. */
  async function scanRaw(what: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      let out: ScanCommandOutput;
      try {
        out = await doc.send(
          new ScanCommand({
            TableName: table,
            ConsistentRead: true,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
      } catch (e) {
        throw directoryError(e, `could not read ${table} to ${what}`, details);
      }
      for (const item of out.Items ?? []) rows.push(item as Record<string, unknown>);
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return rows;
  }

  /**
   * Which of several pre-v9 rows for one fleet is the fleet's *current* one.
   *
   * An interrupted rename left two rows with the same `fleet_id` under two
   * names, and a `Scan` returns them in whatever order DynamoDB feels like —
   * so picking "the first one seen" makes the surviving alias depend on page
   * boundaries and item sizes. Newest `updated_at` wins, because a rename
   * restamps it; an exact tie falls back to the lexicographically smallest key,
   * which is arbitrary but *the same* arbitrary answer on every run and on
   * every laptop.
   */
  function newestLegacyRow(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    return [...rows].sort((a, b) => {
      const at = String(a["updated_at"] ?? "");
      const bt = String(b["updated_at"] ?? "");
      if (at !== bt) return at < bt ? 1 : -1;
      return String(a["name"] ?? "").localeCompare(String(b["name"] ?? ""));
    })[0] as Record<string, unknown>;
  }

  /**
   * Move every pre-alias row onto the `fleet_id` key, reserving its label as it
   * goes (foundation v9). Idempotent by construction: a row already stamped
   * `version: 2` is skipped, so a second run over a migrated table writes
   * nothing.
   *
   * The whole table is read *before* anything is written, because the answer to
   * "which of this fleet's rows is the current one" is a property of the set
   * and not of the row in front of you (`newestLegacyRow`). Writing as the scan
   * went would have made that answer depend on scan order.
   *
   * Nothing is deleted before its replacement exists. Each fleet moves as one
   * transaction — write the canonical row, reserve its alias, drop the old key
   * — so a failure part-way leaves the old row intact and the fleet findable,
   * which is the only outcome worth having: a directory that has lost a fleet
   * is how a fleet gets paid for forever.
   */
  async function migrate(): Promise<DirectoryMigrationResult> {
    const moved: DirectoryMigrationResult = { fleets: 0, aliases: 0, duplicates: 0 };
    const byFleet = new Map<string, Record<string, unknown>[]>();
    for (const row of await scanRaw("migrate its rows")) {
      if (isReservation(row) || isModern(row)) continue;
      // Unparseable rows stay where they are and keep showing up in
      // `status.unparseable`: a row this build cannot read is a row it must not
      // rewrite. `publicEntry` is only asked whether the row parses — what gets
      // written is built from the raw item, so attributes this build does not
      // know about survive the move.
      const entry = publicEntry(row);
      if (!entry) continue;
      const held = byFleet.get(entry.fleet_id);
      if (held) held.push(row);
      else byFleet.set(entry.fleet_id, [row]);
    }

    for (const [fleetId, rows] of byFleet) {
      const one = await migrateFleet(fleetId, rows);
      moved.fleets += one.fleets;
      moved.aliases += one.aliases;
      moved.duplicates += one.duplicates;
    }
    return moved;
  }

  /**
   * One fleet's pre-v9 rows, moved. Split out of `migrate()` because `update()`
   * needs it too: a caller writing to a fleet whose row is still name-keyed
   * must not silently write nothing, and moving that one fleet is both the
   * smallest repair and the same repair the migration would have made.
   */
  async function migrateFleet(
    fleetId: string,
    rows: readonly Record<string, unknown>[],
  ): Promise<DirectoryMigrationResult> {
    const moved: DirectoryMigrationResult = { fleets: 0, aliases: 0, duplicates: 0 };
    const winner = newestLegacyRow(rows);
    const entry = publicEntry(winner);
    if (!entry) return moved;

    /**
     * The rows this fleet is not keeping. Marked as history rather than
     * deleted: a fleet has exactly one current alias, and silently dropping
     * the other spelling would erase the only record that it was ever used.
     */
    for (const loser of rows) {
      if (loser === winner) continue;
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { ...loser, kind: LEGACY_DUPLICATE_KIND, version: DIRECTORY_ROW_VERSION },
            ConditionExpression: "fleet_id = :id",
            ExpressionAttributeValues: { ":id": fleetId },
          }),
        );
      } catch (e) {
        if (!isConditionFailure(e)) {
          throw directoryError(e, `could not set aside the duplicate row for ${fleetId}`, details);
        }
      }
      moved.duplicates += 1;
    }

    /**
     * A legacy key is a bare `FleetName`, which cannot contain `/`, so it is
     * never already the `fleet/<id>` key this writes — the canonical row is
     * always a new item and the old key is always a separate delete.
     */
    const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      {
        Put: {
          TableName: table,
          Item: { ...winner, ...storedEntry(entry) },
          ConditionExpression: "attribute_not_exists(#n)",
          ExpressionAttributeNames: { "#n": "name" },
        },
      },
    ];
    if (entry.name !== null) {
      items.push({
        Put: {
          TableName: table,
          Item: aliasReservation(entry.name, entry.fleet_id),
          ConditionExpression: "attribute_not_exists(#n)",
          ExpressionAttributeNames: { "#n": "name" },
        },
      });
    }
    items.push({
      Delete: {
        TableName: table,
        Key: { name: winner["name"] },
        ConditionExpression: "fleet_id = :id",
        ExpressionAttributeValues: { ":id": entry.fleet_id },
      },
    });
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (e) {
      throw directoryError(
        e,
        `could not migrate legacy directory entry ${String(winner["name"])}`,
        details,
      );
    }
    moved.fleets += 1;
    if (entry.name !== null) moved.aliases += 1;
    return moved;
  }

  return {
    region,

    async ensure(): Promise<DirectoryStatus> {
      const existing = await describeTable();
      if (!existing) {
        try {
          await opts.client.send(
            new CreateTableCommand({
              TableName: table,
              AttributeDefinitions: [{ AttributeName: "name", AttributeType: "S" }],
              KeySchema: [{ AttributeName: "name", KeyType: "HASH" }],
              BillingMode: "PAY_PER_REQUEST",
              TableClass: "STANDARD",
              DeletionProtectionEnabled: true,
              Tags: [{ Key: "hermetic:managed", Value: "directory" }],
            }),
          );
        } catch (e) {
          // Two laptops running `init` at the same second: the loser sees
          // `ResourceInUseException` for a table that now exists, which is the
          // outcome it wanted. Fall through to the waiter.
          if (!isAwsError(e, "ResourceInUseException")) {
            throw directoryError(e, `could not create the ${table} table`, details);
          }
        }
        await waitActive();
        await applyPitr();
        await migrate();
        return status();
      }

      /**
       * The table is already there — but "there" includes `CREATING`, which is
       * what another laptop's `init` a second ago looks like. Every write below
       * (and every write `init` makes after this returns) would fail against a
       * table in that state, so this waits for the same thing the create branch
       * waits for.
       */
      await waitActive();

      // Re-apply only the two settings an operator (or an older build) can have
      // left drifting; everything else about the table was decided at creation.
      if (!existing.deletion_protection) {
        try {
          await opts.client.send(
            new UpdateTableCommand({ TableName: table, DeletionProtectionEnabled: true }),
          );
        } catch (e) {
          throw directoryError(e, `could not re-enable deletion protection on ${table}`, details);
        }
      }
      const backups = await describeBackups();
      if (!backups.pitr_enabled || backups.pitr_recovery_days !== DIRECTORY_PITR_DAYS) {
        await applyPitr();
      }
      await migrate();
      return status();
    },

    status,
    list,

    /**
     * One fleet, by id — through the `fleet/<id>` key, and failing that through
     * a scan for a pre-v9 row.
     *
     * The fallback is not a nicety. A pre-v9 row is keyed by the fleet's
     * *name*, so a `GetItem` on `fleet/<id>` misses it entirely, and every
     * caller of this method would then be told the fleet is not registered: a
     * `teardown` run from an upgraded binary against a directory that has not
     * been migrated yet would report "there was no directory entry" and leave
     * the row `active` forever, which is exactly the state §4.8 exists to
     * prevent. `ensure()` and the v9 migration normally get there first; this
     * is what makes "normally" not load-bearing.
     *
     * The scan is only reached on a miss, so a migrated directory — every
     * directory, after one `init` or one `foundation update` — pays one
     * `GetItem` and nothing else.
     */
    async get(fleet_id: string): Promise<DirectoryEntry | null> {
      let item: Record<string, unknown> | null;
      try {
        item = await rawFleetRow(fleet_id);
      } catch (e) {
        throw directoryError(e, `could not read the directory entry for ${fleet_id}`, {
          ...details,
          fleet_id,
        });
      }
      if (item) {
        const parsed = publicEntry(item);
        return parsed && parsed.fleet_id === fleet_id ? parsed : null;
      }

      let legacy: Record<string, unknown>[];
      try {
        legacy = await scanLegacyRowsFor(fleet_id);
      } catch (e) {
        throw directoryError(e, `could not read the directory entry for ${fleet_id}`, {
          ...details,
          fleet_id,
        });
      }
      if (legacy.length === 0) return null;
      // The same deterministic winner the migration would pick, so what this
      // reads and what `migrate()` keeps can never disagree.
      const parsed = publicEntry(newestLegacyRow(legacy));
      return parsed && parsed.fleet_id === fleet_id ? parsed : null;
    },

    /**
     * §4.7: the fleet row and, when the fleet is being given a label, that
     * label's reservation, in one conditional transaction. Two operators
     * racing the same alias in one account therefore get one fleet and one
     * `false`, never two fleets answering to one word.
     *
     * A fleet with no alias is a single conditional `Put` — there is no second
     * row to write, and an aliasless create is the normal case (§4.6).
     */
    async register(entry: DirectoryEntry): Promise<boolean> {
      const item = DirectoryEntrySchema.parse(entry);
      const claimRow = {
        TableName: table,
        Item: storedEntry(item),
        ConditionExpression: "attribute_not_exists(#n)",
        ExpressionAttributeNames: { "#n": "name" },
      };
      try {
        if (item.name === null) {
          await doc.send(new PutCommand(claimRow));
        } else {
          await doc.send(
            new TransactWriteCommand({
              TransactItems: [
                { Put: claimRow },
                {
                  Put: {
                    TableName: table,
                    Item: aliasReservation(item.name, item.fleet_id),
                    ConditionExpression: "attribute_not_exists(#n)",
                    ExpressionAttributeNames: { "#n": "name" },
                  },
                },
              ],
            }),
          );
        }
        return true;
      } catch (e) {
        if (isConditionFailure(e)) return false;
        throw directoryError(e, `could not register the fleet ${item.fleet_id}`, {
          ...details,
          fleet_id: item.fleet_id,
          alias: item.name,
        });
      }
    },

    /**
     * Overwrite an existing row, and move its alias reservation with it.
     *
     * Every branch is conditional on `fleet_id = :id`, which is both an
     * existence check and an identity check: a row that is not there, or that
     * turns out to be some other fleet's, answers `false` rather than being
     * overwritten. When the alias itself changes the write is a transaction —
     * new reservation claimed, old one released, row rewritten — so a label is
     * never held by two fleets and never held by none.
     *
     * The alias is additionally conditioned on its *previous* value, so two
     * laptops relabelling one fleet at the same moment produce one winner and
     * one `false` rather than a lost update.
     */
    async update(entry: DirectoryEntry, expect?: { alias: string | null }): Promise<boolean> {
      const item = DirectoryEntrySchema.parse(entry);
      let previous: DirectoryEntry | null;
      try {
        let row = await rawFleetRow(item.fleet_id);
        if (!row) {
          /**
           * The same repair `get()` makes, carried through to the write. A
           * pre-v9 row is keyed by the fleet's name, so this write would
           * otherwise condition on a key that is not there and report `false` —
           * which is how a `teardown` from an upgraded binary against an
           * un-migrated directory left the row `active` for ever. Moving that
           * one fleet first is the smallest repair, and it is the same one
           * `foundation update` would have made.
           */
          const legacy = await scanLegacyRowsFor(item.fleet_id);
          if (legacy.length > 0) {
            await migrateFleet(item.fleet_id, legacy);
            row = await rawFleetRow(item.fleet_id);
          }
        }
        previous = row ? publicEntry(row) : null;
      } catch (e) {
        throw directoryError(e, `could not read the directory entry for ${item.fleet_id}`, {
          ...details,
          fleet_id: item.fleet_id,
        });
      }
      if (!previous) return false;

      /**
       * "The row is this fleet's, and its alias is still the one I read."
       *
       * *Which* read is the caller's choice: `expect.alias` when it has done a
       * read-modify-write of its own, so the window the guard covers is that
       * whole span, and this method's own read otherwise.
       */
      const held = expect === undefined ? previous.name : expect.alias;
      if (expect !== undefined && previous.name !== expect.alias) return false;
      const guard = {
        ConditionExpression:
          held === null
            ? "fleet_id = :id AND attribute_not_exists(#a)"
            : "fleet_id = :id AND #a = :old",
        ExpressionAttributeNames: { "#a": "alias" },
        ExpressionAttributeValues: {
          ":id": item.fleet_id,
          ...(held === null ? {} : { ":old": held }),
        },
      };
      const rewrite = { TableName: table, Item: storedEntry(item), ...guard };
      try {
        if (previous.name === item.name) {
          await doc.send(new PutCommand(rewrite));
          return true;
        }
        const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{ Put: rewrite }];
        if (item.name !== null) {
          items.push({
            Put: {
              TableName: table,
              Item: aliasReservation(item.name, item.fleet_id),
              ConditionExpression: "attribute_not_exists(#n)",
              ExpressionAttributeNames: { "#n": "name" },
            },
          });
        }
        if (previous.name !== null) {
          items.push({
            Delete: {
              TableName: table,
              Key: { name: aliasKey(previous.name) },
              ConditionExpression: "fleet_id = :id",
              ExpressionAttributeValues: { ":id": item.fleet_id },
            },
          });
        }
        await doc.send(new TransactWriteCommand({ TransactItems: items }));
        return true;
      } catch (e) {
        if (isConditionFailure(e)) return false;
        throw directoryError(e, `could not update the fleet ${item.fleet_id}`, {
          ...details,
          fleet_id: item.fleet_id,
          alias: item.name,
        });
      }
    },

    /**
     * Drop a fleet row and release the alias it held. Conditional on the row
     * being there, so a second run of an interrupted removal reports `false`
     * rather than pretending it removed something.
     */
    async remove(fleet_id: string): Promise<boolean> {
      try {
        const row = await rawFleetRow(fleet_id);
        const current = row ? publicEntry(row) : null;
        if (!current) return false;
        const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
          {
            Delete: {
              TableName: table,
              Key: { name: fleetKey(fleet_id) },
              ConditionExpression: "attribute_exists(#n)",
              ExpressionAttributeNames: { "#n": "name" },
            },
          },
        ];
        if (current.name !== null) {
          items.push({
            Delete: {
              TableName: table,
              Key: { name: aliasKey(current.name) },
              ConditionExpression: "fleet_id = :id",
              ExpressionAttributeValues: { ":id": fleet_id },
            },
          });
        }
        await doc.send(new TransactWriteCommand({ TransactItems: items }));
        return true;
      } catch (e) {
        if (isConditionFailure(e)) return false;
        throw directoryError(e, `could not remove the fleet ${fleet_id}`, { ...details, fleet_id });
      }
    },

    migrate,
  };
}
