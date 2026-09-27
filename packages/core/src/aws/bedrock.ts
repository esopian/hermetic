/**
 * Bedrock's model catalog, read in the fleet's own region (§8.3).
 *
 * Two calls, because Bedrock has two kinds of thing a model id can name: a
 * *foundation model* (`ListFoundationModels`, one page) and an *inference
 * profile* (`ListInferenceProfiles`, paginated), and Hermes reaches for the
 * profile where one exists. Both spellings are preserved exactly as AWS returns
 * them — `bedrockModelArns` grants both forms of every id the foundation was
 * given, and rewriting one into the other here would produce an id no grant
 * covers.
 *
 * This module holds no policy about which models are usable: filtering by
 * output modality lives in `model-catalog.ts` beside the other five providers'.
 */
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import type { ClientFactory } from "./client.ts";

export interface BedrockFoundationModel {
  id: string;
  name: string;
  /** e.g. `["TEXT"]`. Empty when Bedrock said nothing. */
  output_modalities: string[];
  /** e.g. `["ON_DEMAND"]`, `["INFERENCE_PROFILE"]`. */
  inference_types: string[];
}

export interface BedrockInferenceProfile {
  id: string;
  name: string;
}

export interface BedrockCatalog {
  foundation_models: BedrockFoundationModel[];
  inference_profiles: BedrockInferenceProfile[];
}

export interface BedrockApi {
  /**
   * The deadline is the caller's (`MODEL_CATALOG_TIMEOUT_MS`), and it is handed
   * to every `send` below rather than only to the first: a paginated
   * `ListInferenceProfiles` is where the whole budget goes, so a signal that
   * stopped at the page boundary would bound nothing.
   */
  catalog(signal?: AbortSignal): Promise<BedrockCatalog>;
}

/** How many pages of inference profiles are read before the walk gives up. */
const MAX_PAGES = 20;

export function bedrockApi(factory: ClientFactory): BedrockApi {
  const client = factory.client(BedrockClient);
  return {
    async catalog(signal?: AbortSignal): Promise<BedrockCatalog> {
      const foundation = await client.send(new ListFoundationModelsCommand({}), {
        abortSignal: signal,
      });
      const foundation_models: BedrockFoundationModel[] = (foundation.modelSummaries ?? []).flatMap(
        (m) =>
          m.modelId === undefined
            ? []
            : [
                {
                  id: m.modelId,
                  name: m.modelName ?? m.modelId,
                  output_modalities: [...(m.outputModalities ?? [])],
                  inference_types: [...(m.inferenceTypesSupported ?? [])],
                },
              ],
      );

      const inference_profiles: BedrockInferenceProfile[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const out = await client.send(
          new ListInferenceProfilesCommand(nextToken === undefined ? {} : { nextToken }),
          { abortSignal: signal },
        );
        for (const p of out.inferenceProfileSummaries ?? []) {
          // `inferenceProfileId`, not the ARN and not the name: it is the string
          // Hermes puts in `model.default`, and the one the role's policy
          // grants by suffix.
          if (p.inferenceProfileId === undefined) continue;
          inference_profiles.push({
            id: p.inferenceProfileId,
            name: p.inferenceProfileName ?? p.inferenceProfileId,
          });
        }
        nextToken = out.nextToken;
        if (nextToken === undefined) break;
      }

      return { foundation_models, inference_profiles };
    },
  };
}
