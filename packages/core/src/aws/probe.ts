import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";
import { FLEET_KEY, NO_FOUNDATION, STACK_PREFIX, isStackDeleting, tablesFor } from "../schema/index.ts";
import type { FoundationSummary } from "../schema/index.ts";
import type { StackInfo } from "../backend/types.ts";
import { FLEET_ID_TAG } from "../backend/constants.ts";
import { asHermeticError, credentialError } from "./client.ts";
import { listHermeticStacks } from "./cfn.ts";

/**
 * §4.7 step 4, read-only and pre-freeze. The wizard needs to know whether a
 * profile's account already holds a foundation *before* the operator types the
 * twelve digits at it — "you are about to join fleet X in us-west-2" is a very
 * different question from "you are about to create one".
 *
 * Like `resolveIdentity`, this deliberately does not go through `aws.client()`:
 * there is no frozen account to guard against yet, and discovering what is there
 * is the whole point. It mutates nothing, and it never throws for an absent
 * stack or an unreadable `_fleet` — both are answers, not failures.
 */
export async function describeFoundation(profile: string, region: string): Promise<FoundationSummary> {
  const credentials = fromIni({ profile });

  const cfn = new CloudFormationClient({ region, credentials });
  /**
   * There is no fixed stack name to ask for any more — a foundation is
   * `hermetic-<fleet_id>` — so the probe lists what is there and recognises
   * hermetic's own tag. A pre-rename stack called plain `hermetic` is found by
   * the same scan.
   */
  let stacks: StackInfo[];
  try {
    stacks = await listHermeticStacks(cfn);
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/profile|credential|token/i.test(message)) throw credentialError(e, profile);
    throw asHermeticError(e, `could not look for a ${STACK_PREFIX} foundation in ${region}`);
  }
  // Attaching is defined for one foundation per account and region (§4.7), so a
  // live stack is preferred over one on its way out — `init` refuses to attach
  // to a deleting foundation, and that refusal needs to see it.
  const live = stacks.filter((s) => !isStackDeleting(s.status));
  const stack = (live.length > 0 ? live : stacks)[0] ?? null;
  if (!stack) return { ...NO_FOUNDATION };

  const fleet_id = stack.tags[FLEET_ID_TAG] ?? stack.tags["fleet_id"] ?? null;
  const tables = tablesFor(stack.stack_name);

  // Best effort: a profile that can read CloudFormation may still not be able to
  // read the table, and a missing tailnet must not fail the probe.
  let tailnet: string | null = null;
  try {
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials }));
    const item = await doc.send(
      new GetCommand({
        TableName: stack.outputs["AgentsTable"] ?? tables.agents,
        Key: { name: FLEET_KEY },
        ConsistentRead: true,
      }),
    );
    const value = item.Item?.["tailnet"];
    tailnet = typeof value === "string" ? value : null;
  } catch {
    tailnet = null;
  }

  return {
    found: true,
    fleet_id,
    region: stack.tags["region"] ?? region,
    tailnet,
    stack_status: stack.status,
  };
}
