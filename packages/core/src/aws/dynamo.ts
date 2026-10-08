import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { QueryCommandOutput, ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { Agent, AgentEvent, AgentTombstone, FleetItem, FleetSettings } from "../schema/index.ts";
import {
  Agent as AgentSchema,
  AgentEvent as AgentEventSchema,
  DESTROYED_KEY,
  FLEET_KEY,
  FleetItem as FleetItemSchema,
  TombstoneItem as TombstoneItemSchema,
  VOLUME_CLAIM_PREFIX,
  fromTombstoneItem,
  isReservedRowKey,
  toTombstoneItem,
  volumeClaimKey,
  volumeIdOfClaimKey,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import type {
  AgentPatch,
  AgentStore,
  EventStore,
  FleetExpectation,
  FleetPatch,
  FleetStore,
  FleetUpdateOptions,
  StoreApi,
  VolumeClaim,
  VolumeClaimStore,
} from "../backend/types.ts";
import { accountGuardOf, asHermeticError, guardClient, isAwsError } from "./client.ts";

/**
 * DynamoDB is the source of truth (§4.1). Two invariants live here and nowhere
 * else:
 *
 * - **Optimistic concurrency.** Every update is `ConditionExpression: version =
 *   :expected` (§4.4); a failed condition is `CONFLICT`, or `NOT_FOUND` when the
 *   row is gone. `ReturnValuesOnConditionCheckFailure` tells the two apart in one
 *   round trip.
 * - **The account guard.** `DynamoDBDocumentClient.from()` builds a *new* client
 *   that does not reuse the proxied `send` of `aws.client()`, so the guard is
 *   re-applied here. Otherwise the store — the busiest AWS surface in hermetic —
 *   would be the one path that never checks the account (§4.7).
 *
 * There is deliberately no TTL on the `agents` table. DynamoDB's TTL deletes the
 * whole item, and a lock that outlived its operator must expire the *lock*, not
 * the agent record. Expiry is decided in `hermetic.ts` by comparing
 * `lock.expires` to the clock, which is also what makes a lock re-acquirable
 * without a table scan (§4.4).
 */

/**
 * A table name, or a way to get one. The names are stack outputs
 * (`hermetic-<fleet_id>-agents`), so the real backend hands over a resolver that
 * reads them on first use; tests hand over the string directly.
 */
export type TableRef = string | (() => Promise<string>);

export interface DynamoTables {
  agents: TableRef;
  events: TableRef;
}

/** Resolves a `TableRef` once and remembers it — one lookup per store. */
class TableName {
  private resolved: string | null = null;
  constructor(private readonly ref: TableRef) {
    if (typeof ref === "string") this.resolved = ref;
  }
  async get(): Promise<string> {
    if (this.resolved === null) {
      this.resolved = await (this.ref as () => Promise<string>)();
    }
    return this.resolved;
  }
  /** For a message built where there is nothing to await. */
  get known(): string {
    return this.resolved ?? "the agents table";
  }
}

function docClient(client: DynamoDBClient): DynamoDBDocumentClient {
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
  const guard = accountGuardOf(client);
  if (!guard) {
    // Failing open here would be the whole account guard, silently absent. Any
    // client reaching this point came from somewhere other than `aws.client()`,
    // which is a programming error, not an operator one (§4.7).
    throw new HermeticError(
      "INTERNAL",
      "the DynamoDB client was not built by aws.client(); it carries no account guard",
      {},
    );
  }
  return guardClient(doc, guard);
}

/**
 * Every SDK throw leaves this module as a `HermeticError`, reads included: after
 * `teardown` has deleted the stack the tables are gone, and a `scan` that came
 * back as a raw `ResourceNotFoundException` reached the heads as an untyped
 * crash with no exit code and no HTTP status. A missing table is `NOT_FOUND`
 * specifically — it is the one AWS failure here that callers act on rather than
 * merely report (`isMissingTable` in `hermetic.ts`).
 */
function readError(e: unknown, message: string): HermeticError {
  if (e instanceof HermeticError) return e;
  if (isAwsError(e, "ResourceNotFoundException")) {
    return new HermeticError("NOT_FOUND", `${message}: the table does not exist`, {
      aws_error: "ResourceNotFoundException",
    });
  }
  return asHermeticError(e, message);
}

/**
 * Tags that name an `AttributeValue`, used to tell a raw one from a document.
 */
const ATTRIBUTE_VALUE_TAGS = new Set(["S", "N", "B", "SS", "NS", "BS", "M", "L", "NULL", "BOOL"]);

/**
 * The item a refused conditional write hands back, read as a document.
 *
 * `DynamoDBDocumentClient` unmarshalls responses but not exceptions, so the
 * `ALL_OLD` item on a `ConditionalCheckFailedException` arrives as raw
 * `AttributeValue`s (`{"version":{"N":"1"}}`) where every other read here is
 * already plain. Reading it without unmarshalling loses exactly the value the
 * refusal exists to name — the version that was found, the reservation holder —
 * and the refusal degrades to "found ?". A plain item — what a mocked client hands
 * over — is already a document and is returned as it came; a refusal carrying
 * no item at all reads as undefined.
 */
function refusedItem(e: unknown): Record<string, unknown> | undefined {
  const item = (e as { Item?: Record<string, unknown> }).Item;
  if (!item || typeof item !== "object") return undefined;
  if (!isMarshalled(item)) return item;
  return unmarshall(item as Record<string, AttributeValue>);
}

function isMarshalled(item: Record<string, unknown>): boolean {
  const values = Object.values(item);
  if (values.length === 0) return false;
  return values.every((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    const tag = keys[0];
    return keys.length === 1 && tag !== undefined && ATTRIBUTE_VALUE_TAGS.has(tag);
  });
}

/** `Agent.parse` also strips any stray attribute an older build may have left. */
function parseAgent(item: Record<string, unknown> | undefined): Agent | null {
  if (!item) return null;
  return AgentSchema.parse(item);
}

class DynamoAgentStore implements AgentStore {
  /** Names the last `scan` could not parse. Read by `doctor` (§9). */
  private skipped: string[] = [];

  private readonly table: TableName;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    table: TableRef,
  ) {
    this.table = new TableName(table);
  }

  unparseable(): string[] {
    return [...this.skipped];
  }

  async get(name: string): Promise<Agent | null> {
    if (isReservedRowKey(name)) return null;
    try {
      const out = await this.doc.send(
        new GetCommand({ TableName: await this.table.get(), Key: { name }, ConsistentRead: true }),
      );
      return parseAgent(out.Item);
    } catch (e) {
      throw readError(e, `could not read agent ${name}`);
    }
  }

  /** §6.2 step 1: the conditional put is what makes `create` safe to re-run. */
  async putIfAbsent(agent: Agent): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: await this.table.get(),
          Item: { ...agent },
          ConditionExpression: "attribute_not_exists(#name)",
          ExpressionAttributeNames: { "#name": "name" },
        }),
      );
      return true;
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) return false;
      throw asHermeticError(e, `could not claim the name ${agent.name}`);
    }
  }

  async update(name: string, expectedVersion: number, patch: AgentPatch): Promise<Agent> {
    const names: Record<string, string> = { "#name": "name", "#version": "version" };
    const values: Record<string, unknown> = {
      ":expected": expectedVersion,
      ":next": expectedVersion + 1,
    };
    const sets = ["#version = :next"];

    let i = 0;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      i += 1;
      const nk = `#p${i}`;
      const vk = `:p${i}`;
      names[nk] = key;
      values[vk] = value;
      sets.push(`${nk} = ${vk}`);
    }
    if (!("updated_at" in patch)) {
      names["#updated_at"] = "updated_at";
      values[":updated_at"] = new Date().toISOString();
      sets.push("#updated_at = :updated_at");
    }

    // `lock: null` travels through the loop above like any other value — it is a
    // written NULL, not an absent key, so releasing a lock is one conditional
    // write that also bumps the version.
    const expression = `SET ${sets.join(", ")}`;

    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: await this.table.get(),
          Key: { name },
          UpdateExpression: expression,
          ConditionExpression: "attribute_exists(#name) AND #version = :expected",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      const next = parseAgent(out.Attributes);
      if (!next) throw new HermeticError("INTERNAL", `update of ${name} returned no row`, { name });
      return next;
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) {
        const item = refusedItem(e);
        if (!item) {
          throw new HermeticError("NOT_FOUND", `no such agent: ${name}`, { name });
        }
        const actual = typeof item["version"] === "number" ? item["version"] : null;
        throw new HermeticError(
          "CONFLICT",
          `agent ${name} changed underneath this operation (expected version ${expectedVersion}, found ${actual ?? "?"})`,
          { name, expected: expectedVersion, actual },
        );
      }
      throw asHermeticError(e, `could not update agent ${name}`);
    }
  }

  /**
   * §4.5: no local mirror, so the read path is a full consistent scan. `_fleet`
   * and §9.1's `_volume:<id>` reservations share the table and are never
   * agents; every reserved key is skipped by the one rule (§6.1 forbids a
   * leading underscore in an agent name), so a later reserved row does not have
   * to teach this loop about itself to stay out of `agent ps` — or out of
   * `doctor`'s list of rows it could not parse.
   */
  async scan(): Promise<Agent[]> {
    const rows: Agent[] = [];
    const skipped: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      let out: ScanCommandOutput;
      try {
        out = await this.doc.send(
          new ScanCommand({
            TableName: await this.table.get(),
            ConsistentRead: true,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
      } catch (e) {
        throw readError(e, `could not read the ${this.table.known} table`);
      }
      for (const item of out.Items ?? []) {
        if (isReservedRowKey(item["name"])) continue;
        /**
         * One half-written row — an interrupted `create`, a hand-edited item, a
         * row from a newer schema — must not take `agent ps` and the server's
         * poller down with it. The fleet is reported without it, and `doctor`
         * names what was skipped so it is visible rather than merely survived.
         */
        const parsed = AgentSchema.safeParse(item);
        if (parsed.success) rows.push(parsed.data);
        else skipped.push(typeof item["name"] === "string" ? item["name"] : "(unnamed row)");
      }
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    this.skipped = skipped;
    return rows;
  }

  /**
   * Unconditional for the unwind of a failed `create`; conditional on the
   * version *and* the `created_at` for the release at the end of `destroy`
   * (§6.7). The version alone is not an identity: a later incarnation of the
   * same name starts again from a low version, so a release that stalled past
   * its lock could otherwise delete a newer agent that happens to sit at the
   * version it read. `created_at` is set once when a row is born and never
   * written again, so the pair names one incarnation at one moment. The
   * conditional form reads the refused item back in the same round trip, as
   * `update` does, to tell a row a concurrent writer moved or replaced
   * (`CONFLICT`) from a row already gone (a no-op: the release it wanted has
   * happened).
   */
  async delete(
    name: string,
    opts?: { expectedVersion: number; expectedCreatedAt: string },
  ): Promise<void> {
    if (isReservedRowKey(name)) {
      throw new HermeticError("UNSUPPORTED", `${name} is a reserved row, not an agent`, { name });
    }
    if (opts === undefined) {
      await this.doc.send(new DeleteCommand({ TableName: await this.table.get(), Key: { name } }));
      return;
    }
    const { expectedVersion, expectedCreatedAt } = opts;
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: await this.table.get(),
          Key: { name },
          ConditionExpression:
            "attribute_exists(#name) AND #version = :expected AND #created_at = :created_at",
          ExpressionAttributeNames: {
            "#name": "name",
            "#version": "version",
            "#created_at": "created_at",
          },
          ExpressionAttributeValues: { ":expected": expectedVersion, ":created_at": expectedCreatedAt },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) {
        const item = refusedItem(e);
        if (!item) return;
        const actual = typeof item["version"] === "number" ? item["version"] : null;
        const actualCreatedAt = typeof item["created_at"] === "string" ? item["created_at"] : null;
        const replaced = actualCreatedAt !== expectedCreatedAt;
        throw new HermeticError(
          "CONFLICT",
          replaced
            ? `agent ${name} is a different incarnation now (created ${actualCreatedAt ?? "?"}, expected ${expectedCreatedAt}); the record was not deleted`
            : `agent ${name} changed underneath this operation (expected version ${expectedVersion}, found ${actual ?? "?"}); the record was not deleted`,
          {
            name,
            expected: expectedVersion,
            actual,
            expected_created_at: expectedCreatedAt,
            actual_created_at: actualCreatedAt,
          },
        );
      }
      throw asHermeticError(e, `could not delete agent ${name}`);
    }
  }
}

class DynamoEventStore implements EventStore {
  private readonly table: TableName;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    table: TableRef,
  ) {
    this.table = new TableName(table);
  }

  async append(event: AgentEvent): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: await this.table.get(), Item: { ...event } }));
  }

  /** Newest first (§6.6): the range key is the timestamp, so scan it backwards. */
  async query(name: string, limit?: number): Promise<AgentEvent[]> {
    const rows: AgentEvent[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: await this.table.get(),
          KeyConditionExpression: "#name = :name",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: { ":name": name },
          ScanIndexForward: false,
          ...(limit ? { Limit: limit - rows.length } : {}),
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of out.Items ?? []) rows.push(AgentEventSchema.parse(item));
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (limit !== undefined && rows.length >= limit) return rows.slice(0, limit);
    } while (start);
    return rows;
  }

  /**
   * One item under the reserved `_destroyed` partition (§6.7). A plain put:
   * the range key is `<destroyed_at>#<name>`, so a retry of the same write
   * lands on the same key and replaces it with identical content.
   */
  async appendTombstone(tombstone: AgentTombstone): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({ TableName: await this.table.get(), Item: { ...toTombstoneItem(tombstone) } }),
      );
    } catch (e) {
      throw asHermeticError(e, `could not record the destroy of ${tombstone.name}`);
    }
  }

  /**
   * Newest first: one `Query` on the reserved partition, walked backwards.
   * `name` is a `FilterExpression`, so DynamoDB's `Limit` counts items before
   * the filter — which is why the limit is honoured here, after it, rather
   * than handed to the query.
   *
   * An item that does not parse as a `TombstoneItem` is skipped, not thrown:
   * the events table is writable by the boxes, and one malformed item under
   * `_destroyed` must not take down the destroyed view, the archive, a plan or
   * a create for every other name. The limit counts parsed tombstones, so
   * `limit: 1` returns the newest *readable* one. A malformed newest item
   * reads as absent, which for `predecessorFloor` only means the floor comes
   * from the tombstone before it, the same answer a future-dated (forged) one
   * gets. The skip
   * is silent: `agents.destroyed` returns a bare list, and a count would change
   * that result's shape in every head (§9).
   */
  async queryTombstones(opts?: { name?: string; limit?: number }): Promise<AgentTombstone[]> {
    const rows: AgentTombstone[] = [];
    const limit = opts?.limit;
    let start: Record<string, unknown> | undefined;
    do {
      let out: QueryCommandOutput;
      try {
        out = await this.doc.send(
          new QueryCommand({
            TableName: await this.table.get(),
            KeyConditionExpression: "#name = :pk",
            ExpressionAttributeNames: {
              "#name": "name",
              ...(opts?.name === undefined ? {} : { "#agent": "agent" }),
            },
            ExpressionAttributeValues: {
              ":pk": DESTROYED_KEY,
              ...(opts?.name === undefined ? {} : { ":agent": opts.name }),
            },
            ...(opts?.name === undefined ? {} : { FilterExpression: "#agent = :agent" }),
            ScanIndexForward: false,
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
      } catch (e) {
        throw readError(e, "could not read the destroyed-agent records");
      }
      for (const item of out.Items ?? []) {
        const parsed = TombstoneItemSchema.safeParse(item);
        if (!parsed.success) continue;
        rows.push(fromTombstoneItem(parsed.data));
        if (limit !== undefined && rows.length >= limit) return rows;
      }
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return rows;
  }
}

/**
 * The four ways the fleet lock is free (§4.4), as a condition fragment and the
 * aliases it needs.
 *
 * All four have to be spelled out because `lock` is nullish on the schema:
 * never written, written as `null` by a release, expired, or already ours. The
 * last of those is declared only when the caller gives an owner, for the reason
 * every conditional alias here is — DynamoDB rejects the whole request for an
 * alias no expression uses.
 */
function unlockedClause(opts: { owner?: string; now: Date }): {
  clause: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  return {
    clause:
      "attribute_not_exists(#lock) OR #lock = :null OR #lock.#expires < :now" +
      (opts.owner === undefined ? "" : " OR #lock.#owner = :owner"),
    names: {
      "#lock": "lock",
      "#expires": "expires",
      ...(opts.owner === undefined ? {} : { "#owner": "owner" }),
    },
    values: {
      ":null": null,
      ":now": opts.now.toISOString(),
      ...(opts.owner === undefined ? {} : { ":owner": opts.owner }),
    },
  };
}

/**
 * The item-version condition (§4.4).
 *
 * `0` also matches an item written before `version` existed, which carries no
 * such attribute: absent means 0 (`FleetItem`), and a writer that told the two
 * apart would refuse every first write on an older fleet.
 */
function versionClause(expected: number): { clause: string; values: Record<string, unknown> } {
  const equals = "#version = :expectedVersion";
  return {
    clause: expected === 0 ? `attribute_not_exists(#version) OR ${equals}` : equals,
    values: { ":expectedVersion": expected },
  };
}

/** The reserved `_fleet` item lives in the `agents` table under pk `_fleet` (§4.2). */
class DynamoFleetStore implements FleetStore {
  private readonly table: TableName;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    table: TableRef,
  ) {
    this.table = new TableName(table);
  }

  async get(): Promise<FleetItem | null> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: await this.table.get(),
        Key: { name: FLEET_KEY },
        ConsistentRead: true,
      }),
    );
    if (!out.Item) return null;
    return FleetItemSchema.parse(out.Item);
  }

  /**
   * The *creation* of `_fleet`, and nothing else (§4.4).
   *
   * `init --create` is its only caller, and it writes the item once, on a fleet
   * that has never had one. Leaving the write unconditional made this the one
   * door in the store that could still overwrite the whole item — lock,
   * settings, revision counter and all — which is exactly what the rest of this
   * class was changed to stop. `attribute_not_exists(#name)` closes it: a row
   * that is already there refuses the write instead of losing whatever it
   * carried, and the caller hears `CONFLICT`.
   *
   * `version: 0` is written explicitly rather than left absent. Absent still
   * reads as 0 (`FleetItem`), so this changes nothing about how the row is
   * interpreted; it means the counter is present from the first write, which is
   * what an older build stripping it on a whole-item write would otherwise be
   * able to undo unnoticed.
   */
  async put(item: FleetItem): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: await this.table.get(),
          Item: { ...item, name: FLEET_KEY, version: item.version ?? 0 },
          ConditionExpression: "attribute_not_exists(#name)",
          ExpressionAttributeNames: { "#name": "name" },
        }),
      );
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) {
        throw new HermeticError(
          "CONFLICT",
          `fleet ${item.fleet_id} already has a ${FLEET_KEY} record; it was not overwritten`,
          { fleet_id: item.fleet_id },
        );
      }
      throw asHermeticError(e, `could not write the ${FLEET_KEY} record`);
    }
  }

  /**
   * An attribute-level write of the named fields, under the same lock condition
   * the lock itself is taken with (§4.4).
   *
   * `UpdateCommand`, never `PutCommand`, and that is the whole point: a
   * whole-item write of `_fleet` carries whatever `settings`,
   * `bedrock_model_ids` or `tailscale_oauth_client_id` the caller read earlier,
   * so it silently reverts anything that landed in between. An expression that
   * names three attributes can only change those three.
   *
   * `version` is bumped in the same expression, so a later whole-item
   * replacement composed before this write is refused rather than applied over
   * it. `ReturnValues: ALL_NEW` hands the caller the row as it now stands,
   * which saves a read and is the only reading that is actually current.
   */
  async updateFleet(patch: FleetPatch, opts: FleetUpdateOptions): Promise<FleetItem | null> {
    // DynamoDB has no way to `SET` an attribute to nothing, and a patch that
    // mentions a key it has no value for means "leave it alone", not "remove it".
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    // A patch that names nothing is not a write. Sending it anyway set no
    // attribute and still bumped `version`, which is the one thing a caller
    // holding an expectation cannot afford: a no-op invalidated somebody else's
    // commit point. The stored row as it stands is the honest answer, and it is
    // `null` for a fleet that has none — which is what `attribute_exists(#name)`
    // would have refused on.
    if (entries.length === 0) return await this.get();
    const sets = entries.map((_, i) => `#p${i} = :p${i}`);
    const { clause: lockClause, names: lockNames, values: lockValues } = unlockedClause(opts);
    const version = opts.expectVersion === undefined ? null : versionClause(opts.expectVersion);
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: await this.table.get(),
          Key: { name: FLEET_KEY },
          // `if_not_exists`, because an item written before `version` existed
          // carries no such attribute and absent means 0 (`FleetItem`).
          UpdateExpression: `SET ${[...sets, "#version = if_not_exists(#version, :zero) + :one"].join(", ")}`,
          ConditionExpression: [
            "attribute_exists(#name)",
            `(${lockClause})`,
            ...(version === null ? [] : [`(${version.clause})`]),
          ].join(" AND "),
          ExpressionAttributeNames: {
            "#name": "name",
            "#version": "version",
            ...lockNames,
            ...Object.fromEntries(entries.map(([k], i) => [`#p${i}`, k])),
          },
          ExpressionAttributeValues: {
            ":zero": 0,
            ":one": 1,
            ...lockValues,
            ...(version === null ? {} : version.values),
            ...Object.fromEntries(entries.map(([, v], i) => [`:p${i}`, v])),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return FleetItemSchema.parse(out.Attributes);
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) return null;
      throw asHermeticError(e, `could not write the ${FLEET_KEY} record`);
    }
  }

  /**
   * The one whole-item write of `_fleet` that is not its creation (§4.4, §6.6):
   * `foundation.update`'s stamp and `apply` kind `network`'s, both of which
   * carry changes accumulated across phases that no short patch describes.
   *
   * It is safe only because it states what it believes: the item `version` and
   * the `settings.version` it was composed against. Anything that moved since
   * the caller read the row fails the condition, and the caller reports
   * `CONFLICT` rather than reverting it. The written row's `version` is the
   * expected one plus one, so the counter keeps advancing through a replacement
   * the same way it does through a patch.
   *
   * `PutCommand` cannot return the new image (`ALL_NEW` is an `UpdateCommand`
   * affordance), so the item that was written is the answer — which is exactly
   * the stored row, the condition having just proved it.
   */
  async replaceFleet(
    item: FleetItem,
    owner: string,
    now: Date,
    expect: FleetExpectation,
  ): Promise<FleetItem | null> {
    const next: FleetItem = { ...item, version: expect.version + 1 };
    const { clause: lockClause, names: lockNames, values: lockValues } = unlockedClause({ owner, now });
    const version = versionClause(expect.version);
    const settings =
      expect.settingsVersion === null
        ? { clause: "attribute_not_exists(#settings)", values: {} }
        : {
            clause: "#settings.#sversion = :expectedSettings",
            values: { ":expectedSettings": expect.settingsVersion },
          };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: await this.table.get(),
          Item: { ...next, name: FLEET_KEY },
          ConditionExpression: [
            "attribute_exists(#name)",
            `(${lockClause})`,
            `(${version.clause})`,
            `(${settings.clause})`,
          ].join(" AND "),
          ExpressionAttributeNames: {
            "#name": "name",
            "#version": "version",
            "#settings": "settings",
            ...lockNames,
            ...(expect.settingsVersion === null ? {} : { "#sversion": "version" }),
          },
          ExpressionAttributeValues: {
            ...lockValues,
            ...version.values,
            ...settings.values,
          },
        }),
      );
      return next;
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) return null;
      throw asHermeticError(e, `could not write the ${FLEET_KEY} record`);
    }
  }

  /**
   * The fleet-wide TTL lock's one conditional write (§4.4, §8.3). An
   * `UpdateCommand` setting `lock` alone — so two `foundation update`s starting
   * together cannot both believe they took it, and so taking the lock cannot
   * revert a `settings.set` that landed since the caller's last read — leaving
   * every other attribute of `_fleet`, `version` included, as it is stored.
   *
   * `attribute_exists(#name)` is on every write here because an `UpdateCommand`
   * on a key that does not exist *creates* the item. A lock taken against a
   * fleet that is not there would conjure a `_fleet` row with nothing on it but
   * a lock, which every reader would then have to defend against.
   */
  async lockFleet(owner: string, expires: string, now: Date): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: await this.table.get(),
          Key: { name: FLEET_KEY },
          UpdateExpression: "SET #lock = :lock",
          ConditionExpression:
            "attribute_exists(#name) AND (attribute_not_exists(#lock) OR #lock = :null OR " +
            "#lock.#owner = :owner OR #lock.#expires < :now)",
          ExpressionAttributeNames: {
            "#name": "name",
            "#lock": "lock",
            "#owner": "owner",
            "#expires": "expires",
          },
          ExpressionAttributeValues: {
            ":lock": { owner, expires },
            ":null": null,
            ":owner": owner,
            ":now": now.toISOString(),
          },
        }),
      );
      return true;
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) return false;
      throw asHermeticError(e, `could not take the ${FLEET_KEY} lock`);
    }
  }

  /**
   * Push our own lock's expiry out (§4.4) — and only ever *our own*.
   *
   * Deliberately not `lockFleet`. That one succeeds on a lock which is absent,
   * null or expired, which is right for taking a lock and wrong for renewing
   * one: a run whose ten-minute TTL lapsed inside an unbounded wait would
   * quietly take the lock back and carry on as though it had never lost it,
   * having spent that window unprotected. The condition here is the opposite
   * one — the stored lock is ours *and* still live — so a lapse is reported to
   * the caller as the lost lock it is.
   */
  async renewFleetLock(owner: string, expires: string, now: Date): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: await this.table.get(),
          Key: { name: FLEET_KEY },
          UpdateExpression: "SET #lock = :lock",
          ConditionExpression:
            "attribute_exists(#name) AND #lock.#owner = :owner AND #lock.#expires >= :now",
          ExpressionAttributeNames: {
            "#name": "name",
            "#lock": "lock",
            "#owner": "owner",
            "#expires": "expires",
          },
          ExpressionAttributeValues: {
            ":lock": { owner, expires },
            ":owner": owner,
            ":now": now.toISOString(),
          },
        }),
      );
      return true;
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) return false;
      throw asHermeticError(e, `could not renew the ${FLEET_KEY} lock`);
    }
  }

  /**
   * The matching release. Conditional on the lock still being ours, and a
   * failed condition is swallowed: a run whose lock expired and was taken by
   * somebody else has nothing to give back, and throwing here would replace the
   * outcome the caller actually cares about.
   */
  async unlockFleet(owner: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: await this.table.get(),
          Key: { name: FLEET_KEY },
          UpdateExpression: "SET #lock = :null",
          ConditionExpression: "attribute_exists(#name) AND #lock.#owner = :owner",
          ExpressionAttributeNames: { "#name": "name", "#lock": "lock", "#owner": "owner" },
          ExpressionAttributeValues: { ":null": null, ":owner": owner },
        }),
      );
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) return;
      throw asHermeticError(e, `could not release the ${FLEET_KEY} lock`);
    }
  }

  /**
   * The settings write (§4.6): an `UpdateCommand`, not a `Put`, because it must
   * touch two attributes of an item whose other fields the caller may be
   * holding a stale copy of — a `foundation update` running beside it rewrites
   * everything else on `_fleet`.
   *
   * `defaults` is written alongside `settings.defaults` deliberately: the
   * lifecycle reads `_fleet.defaults` (§10), and two places holding the same
   * fact is a bug waiting for the second one to be forgotten. One write, both
   * attributes, one condition.
   */
  async putSettings(
    settings: FleetSettings,
    expectedVersion: number | null,
    now: Date,
    owner?: string,
  ): Promise<boolean> {
    const settingsClause =
      expectedVersion === null ? "attribute_not_exists(#settings)" : "#settings.#sversion = :expected";
    // The caller holds the lock itself (§8.3), and `unlockedClause` declares the
    // owner alias only when one is given — for the same reason `#sversion` is
    // conditional: an alias no expression uses fails the whole request.
    const {
      clause: lockClause,
      names: lockNames,
      values: lockValues,
    } = unlockedClause({ ...(owner === undefined ? {} : { owner }), now });
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: await this.table.get(),
          Key: { name: FLEET_KEY },
          UpdateExpression: "SET #settings = :settings, #defaults = :defaults",
          ConditionExpression: `attribute_exists(#name) AND (${settingsClause}) AND (${lockClause})`,
          ExpressionAttributeNames: {
            "#name": "name",
            "#settings": "settings",
            "#defaults": "defaults",
            ...lockNames,
            // Declared only when the settings clause names it. DynamoDB rejects
            // the whole request for an alias no expression uses
            // (`ValidationException: … unused in expressions`), so the first
            // write on a fleet that has no settings yet would fail outright.
            ...(expectedVersion === null ? {} : { "#sversion": "version" }),
          },
          ExpressionAttributeValues: {
            ":settings": settings,
            ":defaults": settings.defaults,
            ...lockValues,
            ...(expectedVersion === null ? {} : { ":expected": expectedVersion }),
          },
        }),
      );
      return true;
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) return false;
      throw asHermeticError(e, `could not write the ${FLEET_KEY} settings`);
    }
  }
}

/**
 * §9.1's volume reservations, as reserved rows of the agents table: one item
 * per reserved volume id, keyed `_volume:<vol-id>` beside `_fleet`.
 *
 * DynamoDB's conditional write is the only atomic primitive hermetic has, and a
 * reservation is exactly that write — "take this unless somebody else holds
 * it". The row carries nothing but the claim, so an `UpdateCommand` creating an
 * absent item is the behaviour wanted here, unlike `lockFleet`, where a
 * conjured `_fleet` would be a row every reader has to defend against. A
 * conjured reservation is simply the reservation.
 *
 * The rows are short-lived by design. A reservation covers only the window
 * between "nothing else owns this disk" and "an agent row says it is mine";
 * the row is the durable claim, and its absence during the window is why the
 * window needs a reservation at all. So a release deletes the item, and an
 * expired one is ignored rather than swept.
 */
class DynamoVolumeClaimStore implements VolumeClaimStore {
  private readonly table: TableName;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    table: TableRef,
  ) {
    this.table = new TableName(table);
  }

  private static parse(item: Record<string, unknown> | undefined): VolumeClaim | null {
    if (!item) return null;
    const { name, owner, expires } = item;
    if (typeof name !== "string" || typeof owner !== "string" || typeof expires !== "string") {
      return null;
    }
    const volumeId = volumeIdOfClaimKey(name);
    return volumeId === null ? null : { volume_id: volumeId, owner, expires };
  }

  async get(volumeId: string): Promise<VolumeClaim | null> {
    try {
      const out = await this.doc.send(
        new GetCommand({
          TableName: await this.table.get(),
          Key: { name: volumeClaimKey(volumeId) },
          ConsistentRead: true,
        }),
      );
      return DynamoVolumeClaimStore.parse(out.Item);
    } catch (e) {
      throw readError(e, `could not read the reservation on ${volumeId}`);
    }
  }

  /**
   * Every reservation at once, for the one caller that wants them that way:
   * `volume ls` says who is mid-operation on each disk, and asking per volume
   * would be a round trip per row. A filtered `Scan` still reads the table,
   * which is what the fleet read beside it already costs (§4.5).
   */
  async list(): Promise<VolumeClaim[]> {
    const claims: VolumeClaim[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      let out: ScanCommandOutput;
      try {
        out = await this.doc.send(
          new ScanCommand({
            TableName: await this.table.get(),
            ConsistentRead: true,
            FilterExpression: "begins_with(#name, :prefix)",
            ExpressionAttributeNames: { "#name": "name" },
            ExpressionAttributeValues: { ":prefix": VOLUME_CLAIM_PREFIX },
            ...(start ? { ExclusiveStartKey: start } : {}),
          }),
        );
      } catch (e) {
        throw readError(e, "could not read the volume reservations");
      }
      for (const item of out.Items ?? []) {
        const claim = DynamoVolumeClaimStore.parse(item);
        if (claim) claims.push(claim);
      }
      start = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return claims;
  }

  /**
   * Three ways the reservation is free, and the store decides which — not the
   * caller: no row at all, a row whose expiry has passed, and a row that is
   * already ours, which is a re-run of the same operation and only pushes the
   * expiry out. `ALL_OLD` on the failed condition names the holder in the same
   * round trip, so a refusal says who without reading again.
   */
  async claim(
    volumeId: string,
    owner: string,
    expires: string,
    now: Date,
  ): Promise<{ ok: boolean; holder: VolumeClaim }> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: await this.table.get(),
          Key: { name: volumeClaimKey(volumeId) },
          UpdateExpression: "SET #owner = :owner, #expires = :expires",
          ConditionExpression: "attribute_not_exists(#name) OR #owner = :owner OR #expires < :now",
          ExpressionAttributeNames: { "#name": "name", "#owner": "owner", "#expires": "expires" },
          ExpressionAttributeValues: {
            ":owner": owner,
            ":expires": expires,
            ":now": now.toISOString(),
          },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return { ok: true, holder: { volume_id: volumeId, owner, expires } };
    } catch (e) {
      if (isAwsError(e, "ConditionalCheckFailedException")) {
        const held = DynamoVolumeClaimStore.parse(refusedItem(e));
        /**
         * A failed condition with no item back is a reservation that moved
         * between the write and the read of it. Naming nobody would read as
         * "free", which is the one answer this must never give, so it names an
         * anonymous holder rather than none.
         */
        return {
          ok: false,
          holder: held ?? { volume_id: volumeId, owner: "another operation", expires },
        };
      }
      throw asHermeticError(e, `could not reserve ${volumeId}`);
    }
  }

  async release(volumeId: string, owner: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: await this.table.get(),
          Key: { name: volumeClaimKey(volumeId) },
          ConditionExpression: "attribute_not_exists(#name) OR #owner = :owner",
          ExpressionAttributeNames: { "#name": "name", "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (e) {
      // Somebody else's reservation is theirs to drop — ours expired and was
      // taken — and throwing here would replace the outcome the caller cares
      // about with one it can do nothing about.
      if (isAwsError(e, "ConditionalCheckFailedException")) return;
      throw asHermeticError(e, `could not release the reservation on ${volumeId}`);
    }
  }
}

export function createDynamoStores(client: DynamoDBClient, tables: DynamoTables): StoreApi {
  const doc = docClient(client);
  return {
    agents: new DynamoAgentStore(doc, tables.agents),
    events: new DynamoEventStore(doc, tables.events),
    fleet: new DynamoFleetStore(doc, tables.agents),
    volumeClaims: new DynamoVolumeClaimStore(doc, tables.agents),
  };
}

export { DynamoAgentStore, DynamoEventStore, DynamoFleetStore, DynamoVolumeClaimStore };
