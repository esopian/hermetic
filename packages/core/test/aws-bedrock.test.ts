/**
 * Bedrock's catalog calls (§8.3), and the one property that is not about their
 * contents: the caller's deadline has to reach the SDK.
 *
 * `providers.models` gives the whole read a single budget
 * (`MODEL_CATALOG_TIMEOUT_MS`) because the failure it exists to prevent is a
 * paginating list that never ends while every individual page looks healthy. A
 * signal that stopped at this module's door would leave exactly that hole:
 * twenty pages of `ListInferenceProfiles`, each of them fine, and a drawer that
 * never opens.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { mockClient } from "aws-sdk-client-mock";
import { bedrockApi } from "../src/aws/bedrock.ts";
import type { ClientFactory } from "../src/aws/client.ts";

const bedrock = mockClient(BedrockClient);

/** One foundation model, in the shape `ListFoundationModels` answers with. */
const FOUNDATION_MODEL = {
  modelId: "m-1",
  modelArn: "arn:aws:bedrock:us-west-2::foundation-model/m-1",
};

beforeEach(() => bedrock.reset());
afterEach(() => bedrock.reset());

/** Only `client()` is ever reached from here; the rest is the account guard. */
function factory(): ClientFactory {
  return {
    client: (() => new BedrockClient({ region: "us-west-2" })) as ClientFactory["client"],
    assertAccount: () => Promise.resolve(),
    region: "us-west-2",
    profile: "hermetic-test",
    expectedAccountId: "000000000000",
  };
}

/** The options `send` was given on its nth call — where `abortSignal` lives. */
function sendOptions(ctor: Parameters<typeof bedrock.commandCalls>[0], n: number) {
  const call = bedrock.commandCalls(ctor)[n];
  return (call?.args as unknown[] | undefined)?.[1] as { abortSignal?: AbortSignal } | undefined;
}

describe("bedrockApi.catalog", () => {
  test("hands the caller's signal to every call it makes, pages included", async () => {
    bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: [FOUNDATION_MODEL] });
    let page = 0;
    bedrock.on(ListInferenceProfilesCommand).callsFake(() => {
      page += 1;
      return page === 1
        ? { inferenceProfileSummaries: [{ inferenceProfileId: "us.m-1" }], nextToken: "p2" }
        : { inferenceProfileSummaries: [{ inferenceProfileId: "eu.m-1" }] };
    });
    const signal = new AbortController().signal;

    const catalog = await bedrockApi(factory()).catalog(signal);

    expect(catalog.foundation_models.map((m) => m.id)).toEqual(["m-1"]);
    expect(catalog.inference_profiles.map((p) => p.id)).toEqual(["us.m-1", "eu.m-1"]);
    expect(sendOptions(ListFoundationModelsCommand, 0)?.abortSignal).toBe(signal);
    // The second page too: a deadline that covered only the first call would
    // bound the one part of this read that cannot run long.
    expect(sendOptions(ListInferenceProfilesCommand, 0)?.abortSignal).toBe(signal);
    expect(sendOptions(ListInferenceProfilesCommand, 1)?.abortSignal).toBe(signal);
  });

  /**
   * And what that buys: a walk that stops when the budget is spent instead of
   * running to `MAX_PAGES`. The fake refuses the way the SDK's own abort
   * middleware does — by looking at the signal it was handed — so a `send` that
   * was given no signal would page on, which is the regression.
   */
  test("an aborted signal stops the pagination rather than walking every page", async () => {
    bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: [] });
    const controller = new AbortController();
    bedrock.on(ListInferenceProfilesCommand).callsFake(() => {
      const calls = bedrock.commandCalls(ListInferenceProfilesCommand).length;
      if (sendOptions(ListInferenceProfilesCommand, calls - 1)?.abortSignal?.aborted === true) {
        const aborted = new Error("Request aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      // Never the last page: only the deadline can end this walk.
      controller.abort();
      return {
        inferenceProfileSummaries: [{ inferenceProfileId: `us.m-${String(calls)}` }],
        nextToken: "next",
      };
    });

    await expect(bedrockApi(factory()).catalog(controller.signal)).rejects.toThrow(/aborted/i);

    // One page, then the refusal — not the twenty `MAX_PAGES` allows.
    expect(bedrock.commandCalls(ListInferenceProfilesCommand)).toHaveLength(2);
  });
});
