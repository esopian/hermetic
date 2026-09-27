/**
 * hermeticd's AWS surface, and the one place in hermetic where the *default*
 * credential provider chain is correct: on the box the chain resolves to the
 * instance role, whose IAM policy scopes it to this agent's own row
 * (`LeadingKeys`), its own SSM path and its own S3 prefix (§6.4). It has no view
 * of the fleet.
 *
 * Three services, nothing more:
 *   SSM      GetParameter (WithDecryption) for `${param_prefix}<name>/{ts-key,bws-token,provider-key}`
 *            — `/hermes/<fleet_id>/<name>/…` since foundation v3, which is why the
 *            prefix is read from the fleet manifest and never rebuilt here
 *   S3       GetObject for `manifest.json`, the config tarball and the release objects
 *            the manifest records under `artifacts/<ver>/<generation>/…` — never a
 *            key rebuilt from the version label (§3.6)
 *   DynamoDB GetItem/UpdateItem on its own row + PutItem into `events`
 *
 * Two rules govern every write here:
 *
 *  - **Every attribute name is aliased.** `metrics`, `status`, `version`, `name`
 *    and `health` are all DynamoDB reserved words; an unaliased one is a
 *    `ValidationException` on the real service and nowhere else. Same discipline
 *    as `packages/core/src/aws/dynamo.ts`.
 *  - **The heartbeat never touches `version`.** Core's optimistic concurrency is
 *    `ConditionExpression: version = :expected` (§4.4); a writer bumping the
 *    version every 30 s would make every operator write lose a race it should
 *    have won. The same reasoning covers `setBootstrap` and `ackCommand`, which
 *    a boot writes dozens of times. Only the status transitions hermeticd owns
 *    increment it, and those are already guarded on the current status.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type {
  Agent,
  AgentStatus,
  BootstrapState,
  FleetManifest,
  Health,
  Metrics,
} from "@hermetic/core/schema";
import { FLEET_MANIFEST_KEY } from "@hermetic/core/shared";
import { parseFleetManifest } from "./fleet.ts";
import { AgentdError } from "./errors.ts";

/**
 * The table names come from the fleet manifest, which is the only source of
 * them on the box (§4.2) — the stack they are named for is named for the fleet
 * (`hermetic-<fleet_id>-agents`), so there is nothing to fall back on and
 * nothing to guess. The env override exists for a DynamoDB Local run on a
 * laptop and announces itself, so a mis-set variable is never silent.
 */
export function tableName(
  variable: "HERMETIC_AGENTS_TABLE" | "HERMETIC_EVENTS_TABLE",
  fromManifest: string,
  warn: (message: string) => void = defaultWarn,
): string {
  const value = process.env[variable];
  if (!value || value === fromManifest) return fromManifest;
  warn(`${variable} overrides the fleet table name: using ${value} instead of ${fromManifest}`);
  return value;
}

function defaultWarn(message: string): void {
  process.stderr.write(`hermeticd: ${message}\n`);
}

/** Anything with a `send`: the real document client, or a test recorder. */
export interface CommandSink {
  send(command: unknown): Promise<unknown>;
}

export interface AwsDeps {
  readonly ddb: CommandSink;
  readonly ssm: CommandSink;
  readonly s3: CommandSink;
  readonly agentsTable: string;
  readonly eventsTable: string;
  now(): Date;
  /** Where a one-off operational notice goes. Defaults to stderr. */
  warn?(message: string): void;
}

/** The verbs hermeticd writes into the event log. */
export type EventAction =
  | "boot"
  | "stage"
  | "rerun"
  | "ready"
  | "degrade"
  | "recover"
  | "error"
  | "update"
  /** A self-update that swapped a binary the box could not stay up on (§6.5). */
  | "update-failed"
  | "heartbeat-error";

export interface Aws {
  /** SecureString, decrypted. Never logged, never written to disk. */
  getParameter(path: string): Promise<string>;
  getParameterOptional(path: string): Promise<string | null>;
  getObjectBytes(bucket: string, key: string): Promise<Uint8Array>;
  /**
   * The fleet manifest (§4.2 step 2). It needs S3 and nothing else — which is
   * what lets it be fetched *before* the DynamoDB table names are known, since
   * it is the file that names them.
   */
  getFleetManifest(bucket: string): Promise<FleetManifest>;
  /** hermeticd's own row. It cannot read another agent's. */
  getOwnRow(name: string): Promise<Agent | null>;
  /**
   * A guarded status change (§4.3). The condition is on the *current* status, so
   * a stale writer cannot move a `destroying` agent back to `ready`.
   */
  transition(input: TransitionInput): Promise<boolean>;
  /**
   * Version-neutral, and conditional only on the row still existing. Returns
   * false when the row is gone (or hermeticd has already latched off).
   */
  heartbeat(input: HeartbeatInput): Promise<boolean>;
  /**
   * The stage runner's progress write (§4.2). Same reasoning as the heartbeat:
   * a boot writes this dozens of times, so it must never bump `version` and
   * make an operator's CAS write lose a race it should have won. `attributes`
   * are extra row fields written in the same guarded update — today the facts a
   * stage reported, i.e. `tailscale_ip` and `tailscale_dns_name`.
   */
  setBootstrap(
    name: string,
    state: BootstrapState,
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<boolean>;
  /**
   * Clear an operator `command` once the runner has acted on it, guarded on it
   * still being the command we read. False when the operator has since issued
   * another one — which the next poll will pick up. No version bump.
   */
  ackCommand(name: string, commandId: string): Promise<boolean>;
  appendEvent(input: EventInput): Promise<void>;
}

export interface TransitionInput {
  readonly name: string;
  readonly from: readonly AgentStatus[];
  readonly to: AgentStatus;
  readonly action: EventAction;
  readonly detail?: string;
  /** Extra attributes written in the same guarded update. */
  readonly set?: Readonly<Record<string, unknown>>;
}

export interface HeartbeatInput {
  readonly name: string;
  readonly health: Health;
  readonly metrics: Metrics;
  readonly hermeticd_version?: string;
  /**
   * The digest of the hermeticd binary this process is running (§6.6).
   *
   * The version above is a build-time label two releases can share; this is the
   * only thing a laptop can compare against the fleet manifest to learn whether
   * a rollout actually landed on this box.
   */
  readonly running_hermeticd_sha256?: string;
  /**
   * What Hermes's own `/api/health` reports. Not `hermes_version`, which is the
   * laptop's pin and which no box has ever written.
   */
  readonly running_hermes_version?: string;
  readonly tailscale_ip?: string | null;
  /**
   * The node's real MagicDNS name, which after a recreate is `<name>-2.<tailnet>`
   * rather than `<name>.<tailnet>`. Like the address, `null`/absent means "the
   * daemon could not tell us this tick" and leaves the row's value alone.
   */
  readonly tailscale_dns_name?: string | null;
  /**
   * The version of the `tailscaled` running on this box, as the daemon reports
   * it. Nothing on the laptop chooses it — Tailscale's own updater takes new
   * stable releases (`stages/01-tailscale.sh`) — so the heartbeat is the only
   * thing that can ever know it, and absence reads as unknown.
   */
  readonly tailscale_version?: string | null;
  /**
   * The `config_hash` of the manifest this box has on disk (§6.6 skew).
   *
   * Written here rather than only at the `ready` transition because the
   * question it answers — "is this box running the config the fleet rendered
   * for it?" — goes stale between boots: a self-update re-applies without a
   * transition, and an operator asking a *running* fleet what it holds should
   * not be answered with what it held when it last booted.
   */
  readonly applied_config_hash?: string | null;
}

/**
 * Every `agents` attribute the heartbeat writes, by its expression placeholder.
 *
 * A table rather than literals scattered through the builder below, because
 * these strings are a *seam*: they are DynamoDB attribute names, so each one has
 * to be spelled exactly as the corresponding key of core's `Agent` schema, and
 * nothing about a mismatch fails loudly. A typo here writes a new attribute
 * nobody reads and leaves the real one at its old value forever — the row keeps
 * parsing, the box keeps heartbeating, and the field simply never moves.
 *
 * `tests/seams.test.ts` holds every value here equal to a key of `Agent`. That
 * test is the reason this is a constant: the builder's `names` map is assembled
 * inside a closure and cannot be inspected from outside.
 */
export const HEARTBEAT_ATTRIBUTES = {
  "#name": "name",
  "#lh": "last_heartbeat",
  "#h": "health",
  "#m": "metrics",
  "#ua": "updated_at",
  "#hdv": "hermeticd_version",
  "#hds": "running_hermeticd_sha256",
  "#hv": "running_hermes_version",
  "#tip": "tailscale_ip",
  "#tdn": "tailscale_dns_name",
  "#tv": "tailscale_version",
  "#ach": "applied_config_hash",
} as const;

export interface EventInput {
  readonly name: string;
  readonly action: EventAction | string;
  readonly from_status?: AgentStatus | null;
  readonly to_status?: AgentStatus | null;
  readonly detail?: string | null;
  /**
   * The redacted tail of a failed stage's log (§4.2). Only a failed `stage`
   * event carries one; it is written only when it is a non-empty string, so an
   * event without a tail has no attribute at all rather than a null — which is
   * also what every event written before this field existed looks like.
   */
  readonly log_tail?: string | null;
}

/** `hermeticd@<name>` — every event hermeticd writes is attributed to the box. */
export function hermeticdActor(name: string): string {
  return `hermeticd@${name}`;
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (typeof (body as { transformToByteArray?: unknown })?.transformToByteArray === "function") {
    return await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  }
  if (body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  throw new AgentdError("INTERNAL", "unrecognised S3 response body");
}

/**
 * The fleet manifest fetch, standing alone because it is the one AWS call that
 * happens before there is an `Aws` to make it with: it names the tables the
 * rest of the client is constructed from (§4.2 step 2).
 */
export async function fetchFleetManifest(s3: CommandSink, bucket: string): Promise<FleetManifest> {
  const out = (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: FLEET_MANIFEST_KEY }))) as {
    Body?: unknown;
  };
  return parseFleetManifest(new TextDecoder().decode(await bodyBytes(out.Body)));
}

/** Events are keyed (name, timestamp); two in the same millisecond would collide. */
const EVENT_COLLISION_RETRIES = 5;

export function makeAws(deps: AwsDeps): Aws {
  const nowIso = () => deps.now().toISOString();
  const warn = deps.warn ?? defaultWarn;
  /**
   * `UpdateItem` upserts. A heartbeat racing a `destroy` would therefore
   * *recreate* the row as a fragment with no `status`, `size` or `created_at` —
   * which core's `Scan` then fails to parse, taking `ps` down with it. So the
   * write is guarded on the row existing, and once it is gone hermeticd stops
   * heartbeating entirely rather than retrying every 30 s until the instance is
   * terminated. A successful transition (a `start` after a `stop`, say) clears
   * the latch.
   */
  let rowGone = false;

  async function getParameterOptional(path: string): Promise<string | null> {
    try {
      const out = (await deps.ssm.send(
        new GetParameterCommand({ Name: path, WithDecryption: true }),
      )) as { Parameter?: { Value?: string } };
      return out.Parameter?.Value ?? null;
    } catch (e) {
      if ((e as { name?: string }).name === "ParameterNotFound") return null;
      throw e;
    }
  }

  const aws: Aws = {
    getParameterOptional,

    async getParameter(path) {
      const value = await getParameterOptional(path);
      if (value === null) {
        // The path, never the value.
        throw new AgentdError("INTERNAL", `SSM parameter not found: ${path}`, { path });
      }
      return value;
    },

    async getObjectBytes(bucket, key) {
      const out = (await deps.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
        Body?: unknown;
      };
      return await bodyBytes(out.Body);
    },

    getFleetManifest: (bucket) => fetchFleetManifest(deps.s3, bucket),

    async getOwnRow(name) {
      const out = (await deps.ddb.send(
        new GetCommand({ TableName: deps.agentsTable, Key: { name }, ConsistentRead: true }),
      )) as { Item?: Record<string, unknown> };
      return (out.Item as Agent | undefined) ?? null;
    },

    async transition({ name, from, to, action, detail, set }) {
      const at = nowIso();
      const names: Record<string, string> = {
        "#name": "name",
        "#status": "status",
        "#version": "version",
        "#updated_at": "updated_at",
      };
      const values: Record<string, unknown> = { ":to": to, ":at": at, ":one": 1 };
      const assignments = ["#status = :to", "#updated_at = :at", "#version = #version + :one"];

      from.forEach((status, i) => {
        values[`:from${i}`] = status;
      });
      let i = 0;
      for (const [key, value] of Object.entries(set ?? {})) {
        i += 1;
        names[`#s${i}`] = key;
        values[`:s${i}`] = value;
        assignments.push(`#s${i} = :s${i}`);
      }

      let previous: AgentStatus | null = null;
      try {
        const out = (await deps.ddb.send(
          new UpdateCommand({
            TableName: deps.agentsTable,
            Key: { name },
            UpdateExpression: "SET " + assignments.join(", "),
            ConditionExpression:
              "attribute_exists(#name) AND #status IN (" +
              from.map((_, index) => `:from${index}`).join(", ") +
              ")",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            // ALL_OLD is what lets the event record where the agent came from.
            ReturnValues: "ALL_OLD",
          }),
        )) as { Attributes?: { status?: AgentStatus } };
        previous = out.Attributes?.status ?? null;
        // The row is demonstrably there: resume heartbeating.
        rowGone = false;
      } catch (e) {
        if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
        throw e;
      }

      await aws.appendEvent({
        name,
        action,
        from_status: previous,
        to_status: to,
        detail: detail ?? null,
      });
      return true;
    },

    async heartbeat({
      name,
      health,
      metrics,
      hermeticd_version,
      running_hermeticd_sha256,
      running_hermes_version,
      tailscale_ip,
      tailscale_dns_name,
      tailscale_version,
      applied_config_hash,
    }) {
      if (rowGone) return false;
      const A = HEARTBEAT_ATTRIBUTES;
      const names: Record<string, string> = {
        "#name": A["#name"],
        "#lh": A["#lh"],
        "#h": A["#h"],
        "#m": A["#m"],
        "#ua": A["#ua"],
      };
      const values: Record<string, unknown> = {
        ":at": nowIso(),
        ":h": health,
        ":m": metrics,
      };
      const assignments = ["#lh = :at", "#h = :h", "#m = :m", "#ua = :at"];
      if (hermeticd_version !== undefined) {
        names["#hdv"] = A["#hdv"];
        values[":hdv"] = hermeticd_version;
        assignments.push("#hdv = :hdv");
      }
      if (running_hermeticd_sha256 !== undefined) {
        names["#hds"] = A["#hds"];
        values[":hds"] = running_hermeticd_sha256;
        assignments.push("#hds = :hds");
      }
      if (running_hermes_version !== undefined) {
        names["#hv"] = A["#hv"];
        values[":hv"] = running_hermes_version;
        assignments.push("#hv = :hv");
      }
      if (tailscale_ip !== undefined && tailscale_ip !== null) {
        names["#tip"] = A["#tip"];
        values[":tip"] = tailscale_ip;
        assignments.push("#tip = :tip");
      }
      // Same rule as the address, and for the same reason: a tick where
      // `tailscale status` failed knows nothing, and writing that nothing would
      // erase a name the laptop is using to build a URL. Silence leaves the
      // last known good value standing.
      if (tailscale_dns_name !== undefined && tailscale_dns_name !== null) {
        names["#tdn"] = A["#tdn"];
        values[":tdn"] = tailscale_dns_name;
        assignments.push("#tdn = :tdn");
      }
      // And once more for the daemon's version: a tick that could not run
      // `tailscale status` has no reading, and the last one is still the best
      // answer to what this box is running.
      if (tailscale_version !== undefined && tailscale_version !== null) {
        names["#tv"] = A["#tv"];
        values[":tv"] = tailscale_version;
        assignments.push("#tv = :tv");
      }
      // Absent means "this tick could not read the manifest", which is not the
      // same as "this box has applied nothing" — so, like the two Tailscale
      // fields above, silence leaves the row's last known value standing.
      if (applied_config_hash !== undefined && applied_config_hash !== null) {
        names["#ach"] = A["#ach"];
        values[":ach"] = applied_config_hash;
        assignments.push("#ach = :ach");
      }
      // No `version` bump: the heartbeat is a pure observation and must never
      // make an operator's CAS write fail (§4.4). The only condition is that the
      // row still exists, so a heartbeat can never resurrect a destroyed agent.
      try {
        await deps.ddb.send(
          new UpdateCommand({
            TableName: deps.agentsTable,
            Key: { name },
            UpdateExpression: "SET " + assignments.join(", "),
            ConditionExpression: "attribute_exists(#name)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (e) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
        rowGone = true;
        warn(
          `the agents row for ${name} no longer exists; heartbeats are suspended until a status transition succeeds`,
        );
        return false;
      }
    },

    async setBootstrap(name, state, attributes) {
      const names: Record<string, string> = {
        "#name": "name",
        "#bootstrap": "bootstrap",
        "#updated_at": "updated_at",
      };
      const values: Record<string, unknown> = { ":bs": state, ":now": nowIso() };
      const assignments = ["#bootstrap = :bs", "#updated_at = :now"];
      let i = 0;
      for (const [key, value] of Object.entries(attributes ?? {})) {
        i += 1;
        names[`#a${i}`] = key;
        values[`:a${i}`] = value;
        assignments.push(`#a${i} = :a${i}`);
      }
      try {
        await deps.ddb.send(
          new UpdateCommand({
            TableName: deps.agentsTable,
            Key: { name },
            UpdateExpression: "SET " + assignments.join(", "),
            // The only condition is that the row still exists: a stage
            // finishing must never resurrect a destroyed agent.
            ConditionExpression: "attribute_exists(#name)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (e) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
        return false;
      }
    },

    async ackCommand(name, commandId) {
      try {
        await deps.ddb.send(
          new UpdateCommand({
            TableName: deps.agentsTable,
            Key: { name },
            UpdateExpression: "REMOVE #command SET #updated_at = :now",
            // Guarded on the id: an operator who issued a *second* rerun while
            // the first was being applied keeps their command, and the next
            // poll picks it up rather than losing it to this write.
            ConditionExpression: "attribute_exists(#name) AND #command.#id = :id",
            ExpressionAttributeNames: {
              "#name": "name",
              "#command": "command",
              "#id": "id",
              "#updated_at": "updated_at",
            },
            ExpressionAttributeValues: { ":id": commandId, ":now": nowIso() },
          }),
        );
        return true;
      } catch (e) {
        if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
        return false;
      }
    },

    async appendEvent({ name, action, from_status, to_status, detail, log_tail }) {
      let when = deps.now().getTime();
      // Absence is the "no tail" signal, so an empty string is never written:
      // readers — `agent history`, the drawer — treat a missing key and an
      // empty one the same way, and only one of them survives a round trip
      // through DynamoDB unchanged.
      const tail = typeof log_tail === "string" && log_tail.length > 0 ? { log_tail } : {};
      for (let attempt = 0; attempt <= EVENT_COLLISION_RETRIES; attempt += 1) {
        try {
          await deps.ddb.send(
            new PutCommand({
              TableName: deps.eventsTable,
              Item: {
                name,
                timestamp: new Date(when).toISOString(),
                actor: hermeticdActor(name),
                action,
                from_status: from_status ?? null,
                to_status: to_status ?? null,
                detail: detail ?? null,
                ...tail,
              },
              // Events are append-only and never overwritten (§4.2).
              ConditionExpression: "attribute_not_exists(#name)",
              ExpressionAttributeNames: { "#name": "name" },
            }),
          );
          return;
        } catch (e) {
          if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
          // Same millisecond as a previous event: nudge the sort key and retry.
          when += 1;
        }
      }
      throw new AgentdError("INTERNAL", `could not append an event for ${name}`, { name, action });
    },
  };

  return aws;
}

/**
 * The real clients: default provider chain = the instance role.
 *
 * The table names are required, not defaulted: they come from the fleet
 * manifest the caller has already read (§4.2), and a hermeticd that guessed
 * them would be writing to another fleet's tables or to nothing at all.
 */
export function realAws(
  region: string,
  now: () => Date = () => new Date(),
  tables: { agents: string; events: string },
): Aws {
  return makeAws({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    ssm: new SSMClient({ region }),
    s3: new S3Client({ region }),
    agentsTable: tableName("HERMETIC_AGENTS_TABLE", tables.agents),
    eventsTable: tableName("HERMETIC_EVENTS_TABLE", tables.events),
    now,
  });
}

/**
 * An S3-only client, for the one fetch that happens before the table names are
 * known: the fleet manifest itself. `region` is the only thing IMDS has to tell
 * us before AWS is reachable at all.
 */
export function realS3(region: string): CommandSink {
  return new S3Client({ region });
}
