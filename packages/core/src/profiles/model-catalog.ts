/**
 * Live model discovery (§8.3): what each provider says it can run right now.
 *
 * Six providers, six different answers to the same question, normalised here to
 * one shape — `{ id, name, capabilities? }` — so a head can render one list and
 * an operator can pick from it. The endpoint, the auth header and the
 * pagination scheme are per-provider facts and live in this file only; nothing
 * outside it knows that Anthropic pages on `after_id` while everyone else
 * returns one array.
 *
 * **The key never travels anywhere but the request.** It is a parameter, not a
 * field: it is not in the result, not in the error, not in the error's details,
 * and not in any event. A failure names the provider and the HTTP status and
 * stops there, which is why `PROVIDER_AUTH` exists as its own code rather than
 * as a message somebody might decide to enrich later.
 *
 * **Nothing is cached.** A catalog is a fact about a remote service at a
 * moment; the persisted answer is the *profile's* model, resolved once and then
 * owned by the fleet (`ProviderProfile.model`). Refreshing this list therefore
 * cannot move anything an agent runs, which is the property the whole feature
 * rests on.
 *
 * **Parsers do not fall back to each other.** Each provider's response is read
 * by its own parser, and a response that does not have that provider's shape is
 * `PROVIDER_MALFORMED` rather than something a laxer parser might salvage. A
 * gateway that answered on the wrong host, or a captive portal's login page,
 * must not be able to produce a plausible-looking model list.
 */
import { PROVIDERS } from "../schema/index.ts";
import type { CatalogModel, Provider } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import type { FetchLike } from "../aws/tailscale.ts";
import type { BedrockCatalog } from "../aws/bedrock.ts";

/**
 * §8.3: a catalog read is a page load, not a job. Fifteen seconds, then fail.
 *
 * The budget is for the **whole read**, not for each request in it. Anthropic
 * pages, and a per-request timeout would have let twenty pages take five
 * minutes while every individual page looked healthy — which is a drawer that
 * never opens and a timeout that never fires.
 */
export const MODEL_CATALOG_TIMEOUT_MS = 15_000;

/** The Anthropic Models API's own page size ceiling. */
const ANTHROPIC_PAGE_LIMIT = 1000;
/** Pages read before a paginating provider is assumed to be looping. */
const MAX_PAGES = 20;

export interface ModelCatalogDeps {
  fetch: FetchLike;
  /** Overridable only so a test need not wait fifteen seconds to prove a timeout. */
  timeoutMs?: number | undefined;
  /**
   * Bedrock's two `List*` calls, in the fleet's region. Absent means this
   * backend cannot reach Bedrock — a fixture, or a fleet whose backend has no
   * AWS — and a Bedrock request then fails rather than answering with nothing.
   *
   * It is handed the same deadline the HTTP providers get, so a paginating
   * `ListInferenceProfiles` cannot outlast the budget either.
   */
  bedrock?: (signal: AbortSignal) => Promise<BedrockCatalog>;
}

export interface ModelCatalogRequest {
  provider: Provider;
  /** Absent for a `role` provider; required by every other one. */
  api_key?: string | undefined;
  /**
   * The model the caller already has selected. Pinned to the head of the list,
   * and marked `unlisted` when the provider's catalog does not contain it — a
   * custom id, or one the provider retired, stays visible and stays selected.
   */
  selected: string;
}

/**
 * Model ids whose own name says they do not generate text.
 *
 * Deliberately a short, conservative list of families rather than a clever
 * classifier: §8.3 says exclude what is *explicitly* unsuitable and keep
 * everything whose capabilities are unknown, so a pattern that is not certain
 * does not belong here. Where a provider gives real modality metadata
 * (OpenRouter's `architecture`, Bedrock's `outputModalities`) that metadata is
 * used instead and this list never runs.
 */
const NON_TEXT_PATTERNS: readonly RegExp[] = [
  /embed/i,
  /moderation/i,
  /rerank/i,
  /whisper/i,
  /transcrib/i,
  /dall-?e/i,
  /text-to-speech/i,
  /speech-to-text/i,
  /(^|[/:._-])tts([/:._-]|$)/i,
  /(^|[/:._-])stt([/:._-]|$)/i,
  /stable-diffusion/i,
  /(^|[/:._-])sora([/:._-]|$)/i,
];

function looksNonText(id: string, name: string): boolean {
  return NON_TEXT_PATTERNS.some((re) => re.test(id) || re.test(name));
}

/* ── failure, with the key left out of every path ──────────────────────────── */

function unreachable(provider: Provider, detail: string, extra: Record<string, unknown> = {}): never {
  throw new HermeticError(
    "PROVIDER_UNREACHABLE",
    `could not read ${PROVIDERS[provider].label}'s model catalog: ${detail}`,
    { provider, ...extra },
  );
}

function malformed(provider: Provider, detail: string): never {
  throw new HermeticError(
    "PROVIDER_MALFORMED",
    `${PROVIDERS[provider].label} answered, but not with a model catalog: ${detail}`,
    { provider },
  );
}

function refused(provider: Provider, status: number): never {
  throw new HermeticError(
    "PROVIDER_AUTH",
    `${PROVIDERS[provider].label} refused that credential (HTTP ${String(status)})`,
    { provider, status },
  );
}

/**
 * One request, with the failure taxonomy applied to it.
 *
 * Every throw below carries the provider and, where there is one, the status.
 * None of them carries the key, the `Authorization` header, or the response
 * body — a provider that echoes a credential back in an error message must not
 * be able to put it in hermetic's own error.
 */
async function getJson(
  provider: Provider,
  url: string,
  headers: Record<string, string>,
  deps: ModelCatalogDeps,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal,
    });
  } catch (e) {
    /**
     * Timeout and connection failure are the same fact to an operator: the
     * provider did not answer. Which of the two it was comes from the error's
     * *name*, never from its message.
     *
     * The message used to be forwarded, on the reasoning that it is produced by
     * the runtime rather than by the provider. That reasoning does not hold:
     * a `fetch` implementation, a proxy agent or an interceptor is free to put
     * the request — headers included — in the text it throws, and §8.3 does not
     * get to depend on nobody in that stack ever doing so. So nothing from the
     * cause travels except the fact that it happened.
     */
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    unreachable(
      provider,
      timedOut
        ? `no answer within ${String(Math.round((deps.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS) / 1000))}s`
        : "the request failed before any response arrived",
    );
  }
  if (response.status === 401 || response.status === 403) refused(provider, response.status);
  if (response.status === 429) {
    /**
     * Still `PROVIDER_UNREACHABLE` — the fix is the same (wait and try again)
     * and a code of its own would have to be mapped by both heads to say
     * nothing new. The *message* is different because "HTTP 429" tells an
     * operator to check their key and being rate limited does not.
     */
    unreachable(provider, "rate limited; retry later", { status: 429 });
  }
  if (!response.ok) {
    unreachable(provider, `HTTP ${String(response.status)}`, { status: response.status });
  }
  try {
    return await response.json();
  } catch {
    malformed(provider, "the body did not parse as JSON");
  }
}

/* ── per-provider readers ──────────────────────────────────────────────────── */

function requireKey(provider: Provider, key: string | undefined): string {
  if (key === undefined || key.length === 0) {
    throw new HermeticError(
      "PROVIDER_AUTH",
      `${PROVIDERS[provider].label} needs an API key before its model catalog can be read`,
      { provider },
    );
  }
  return key;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Anthropic's Models API. The one paginated HTTP provider: `has_more` plus
 * `last_id`, fed back as `after_id`.
 *
 * `has_more` is required rather than defaulted, and that is the isolation this
 * parser provides: every other provider here answers `{ data: [...] }` with no
 * such field, so a response from one of them — or from a proxy that answered on
 * the wrong host — is `PROVIDER_MALFORMED` instead of a catalog with somebody
 * else's models in it.
 */
async function listAnthropic(
  req: ModelCatalogRequest,
  deps: ModelCatalogDeps,
  signal: AbortSignal,
): Promise<CatalogModel[]> {
  const key = requireKey("anthropic", req.api_key);
  const models: CatalogModel[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", String(ANTHROPIC_PAGE_LIMIT));
    if (afterId !== undefined) url.searchParams.set("after_id", afterId);
    const body = asRecord(
      await getJson(
        "anthropic",
        url.toString(),
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        deps,
        signal,
      ),
    );
    if (body === null || !Array.isArray(body["data"]) || typeof body["has_more"] !== "boolean") {
      malformed("anthropic", "no `data` array with a `has_more` flag beside it");
    }
    for (const raw of body["data"] as unknown[]) {
      const entry = asRecord(raw);
      const id = entry === null ? undefined : str(entry["id"]);
      if (id === undefined) continue;
      models.push({ id, name: str(entry?.["display_name"]) ?? id });
    }
    const lastId = str(body["last_id"]);
    if (body["has_more"] !== true || lastId === undefined) break;
    afterId = lastId;
  }
  return models;
}

/**
 * The four OpenAI-compatible `/models` endpoints: OpenAI itself, Vercel's AI
 * Gateway, OpenRouter and the Nous Portal. One array, one page, `Bearer` auth.
 *
 * OpenRouter is the only one of the four that states modalities, and it states
 * them well (`architecture.output_modalities`), so a model it says outputs no
 * text is dropped on that authority rather than on its name.
 */
async function listOpenAiCompatible(
  provider: Provider,
  url: string,
  req: ModelCatalogRequest,
  deps: ModelCatalogDeps,
  signal: AbortSignal,
): Promise<CatalogModel[]> {
  const key = requireKey(provider, req.api_key);
  const body = asRecord(await getJson(provider, url, { authorization: `Bearer ${key}` }, deps, signal));
  if (body === null || !Array.isArray(body["data"])) {
    malformed(provider, "no `data` array in the response");
  }
  const models: CatalogModel[] = [];
  for (const raw of body["data"] as unknown[]) {
    const entry = asRecord(raw);
    const id = entry === null ? undefined : str(entry["id"]);
    if (id === undefined || entry === null) continue;

    const architecture = asRecord(entry["architecture"]);
    const outputs = Array.isArray(architecture?.["output_modalities"])
      ? (architecture["output_modalities"] as unknown[]).filter(
          (m): m is string => typeof m === "string",
        )
      : undefined;
    // Stated and text-less is a drop; stated and text-bearing, or not stated at
    // all, falls through to the name heuristic below (§8.3 keeps the unknown).
    if (outputs !== undefined && outputs.length > 0 && !outputs.includes("text")) continue;

    const inputs = Array.isArray(architecture?.["input_modalities"])
      ? (architecture["input_modalities"] as unknown[]).filter(
          (m): m is string => typeof m === "string",
        )
      : undefined;
    const context = entry["context_length"];
    const capabilities = {
      ...(outputs === undefined ? {} : { text: outputs.includes("text") }),
      ...(inputs === undefined ? {} : { vision: inputs.includes("image") }),
      ...(typeof context === "number" && Number.isInteger(context) && context > 0 ? { context } : {}),
    };
    models.push({
      id,
      name: str(entry["name"]) ?? id,
      ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    });
  }
  return models;
}

/**
 * Bedrock, in the fleet's own region. Both `List*` calls, both spellings kept:
 * the foundation model ids and the inference profile ids are different strings
 * naming different ARNs, and the fleet's role is granted both forms of each id
 * it was given, so collapsing them would produce an id no grant covers.
 */
async function listBedrock(deps: ModelCatalogDeps, signal: AbortSignal): Promise<CatalogModel[]> {
  if (deps.bedrock === undefined) {
    unreachable("bedrock", "this backend cannot reach Bedrock");
  }
  let catalog: BedrockCatalog;
  try {
    catalog = await deps.bedrock(signal);
  } catch (e) {
    // The SDK's own message, for the same reason the HTTP path drops its
    // cause's: nothing this fleet holds may travel out through an error, and an
    // AWS client error can quote the request it was making.
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    unreachable("bedrock", timedOut ? "no answer in time" : "the ListFoundationModels call failed");
  }
  /**
   * Which bare foundation ids an inference profile in this same listing already
   * covers. A profile id is the foundation id with a region prefix, which is
   * exactly what `bedrockBaseModelId` strips — so the comparison that says
   * "these two names are one model" is the one the grant check already makes.
   */
  const covered = new Set(
    catalog.inference_profiles.map((p) => p.id.replace(/^(us|eu|apac|us-gov|global)\./, "")),
  );

  const models: CatalogModel[] = [];
  for (const m of catalog.foundation_models) {
    // Stated, and stated by AWS: a model whose output modalities do not include
    // TEXT is not a model Hermes can hold a conversation with.
    if (m.output_modalities.length > 0 && !m.output_modalities.includes("TEXT")) continue;
    /**
     * A model AWS lists but will not serve directly. Most of the Anthropic
     * catalog is `INFERENCE_PROFILE`-only in most regions: `InvokeModel` on the
     * bare id fails with a validation error naming the profile to use instead,
     * so offering the bare id in a picker is offering a model that cannot run.
     *
     * Dropped only when this listing carries the profile that covers it — the
     * operator loses nothing, because the id that does work is right there
     * under its regional name. A model whose inference types AWS did not state
     * at all is kept, on §8.3's rule that unknown is not the same as excluded.
     */
    const onDemand = m.inference_types.length === 0 || m.inference_types.includes("ON_DEMAND");
    if (!onDemand && covered.has(m.id)) continue;
    models.push({
      id: m.id,
      name: m.name,
      capabilities: { text: true },
    });
  }
  for (const p of catalog.inference_profiles) {
    models.push({ id: p.id, name: p.name, capabilities: { text: true } });
  }
  return models;
}

/* ── the one entry point ───────────────────────────────────────────────────── */

/**
 * Normalise, exclude, dedupe, sort, pin.
 *
 * In that order, and the order matters: the pin is last so the selected model
 * is first in the list whether or not the provider happened to sort it there,
 * and the `unlisted` mark is decided after the exclusion, so a custom id that
 * the heuristic would have dropped is still shown as the thing that is
 * selected.
 */
function finish(selected: string, raw: CatalogModel[]): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const model of raw) {
    if (model.id !== selected && looksNonText(model.id, model.name)) continue;
    const seen = byId.get(model.id);
    // First-seen-wins would throw away real metadata: a provider that lists the
    // same id twice — once bare, once with `context_length` and modalities —
    // would be rendered from whichever copy happened to come first. The richer
    // description of one model is still one model, so the two are merged.
    byId.set(model.id, seen === undefined ? model : mergeModel(seen, model));
  }
  const sorted = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const pinned = byId.get(selected) ?? { id: selected, name: selected, unlisted: true as const };
  return [pinned, ...sorted.filter((m) => m.id !== selected)];
}

/**
 * Two descriptions of one model, combined. A stated field beats an absent one;
 * where both state something, the first stays — later entries are duplicates,
 * not corrections, and nothing here can tell which of two answers is newer.
 */
function mergeModel(a: CatalogModel, b: CatalogModel): CatalogModel {
  const capabilities = { ...(b.capabilities ?? {}), ...(a.capabilities ?? {}) };
  return {
    id: a.id,
    // A name equal to the id is the fallback `listOpenAiCompatible` uses when a
    // provider gave none, so the other entry's is better if it has one.
    name: a.name === a.id && b.name !== b.id ? b.name : a.name,
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    ...(a.unlisted === true || b.unlisted === true ? { unlisted: true as const } : {}),
  };
}

export interface ModelCatalogResult {
  models: CatalogModel[];
}

export async function listModels(
  req: ModelCatalogRequest,
  deps: ModelCatalogDeps,
): Promise<ModelCatalogResult> {
  /**
   * One deadline, opened here and shared by every request the read makes. A
   * paginating provider gets the same fifteen seconds a single-page one does,
   * which is the promise the constant's name makes.
   */
  const signal = AbortSignal.timeout(deps.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS);
  const raw = await (async (): Promise<CatalogModel[]> => {
    switch (req.provider) {
      case "anthropic":
        return await listAnthropic(req, deps, signal);
      case "openai":
        return await listOpenAiCompatible(
          "openai",
          "https://api.openai.com/v1/models",
          req,
          deps,
          signal,
        );
      case "vercel":
        return await listOpenAiCompatible(
          "vercel",
          "https://ai-gateway.vercel.sh/v1/models",
          req,
          deps,
          signal,
        );
      case "openrouter":
        return await listOpenAiCompatible(
          "openrouter",
          "https://openrouter.ai/api/v1/models",
          req,
          deps,
          signal,
        );
      case "nous":
        return await listOpenAiCompatible(
          "nous",
          "https://inference-api.nousresearch.com/v1/models",
          req,
          deps,
          signal,
        );
      case "bedrock":
        return await listBedrock(deps, signal);
    }
  })();
  return { models: finish(req.selected, raw) };
}

/* ── the fixture's canned catalogs ─────────────────────────────────────────── */

/**
 * Model discovery in fixture mode (§3.2's mode table): canned bodies, in each
 * provider's own wire shape, behind a `fetch` that opens no socket.
 *
 * Canned at the transport rather than above it deliberately. A fixture that
 * returned already-normalised models would exercise none of the parsing,
 * pagination, exclusion or pinning this file exists for, and `bun run
 * dev:fixture` is where that work is looked at. Each list carries one entry
 * that is not a text model — an embedding, or something whose stated output
 * modality is an image — so the filtering is visible rather than asserted.
 */
const FIXTURE_ANTHROPIC = [
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-opus-4-1-20250805", "Claude Opus 4.1"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
  ["claude-3-7-sonnet-20250219", "Claude Sonnet 3.7"],
  ["claude-3-5-haiku-20241022", "Claude Haiku 3.5"],
  ["claude-opus-4-20250514", "Claude Opus 4"],
  ["claude-embed-v1", "Claude Embeddings v1"],
] as const;

const FIXTURE_OPENAI = [
  "gpt-5.6-luna",
  "gpt-5.6",
  "gpt-5.6-mini",
  "gpt-5.2",
  "o4-mini",
  "gpt-4.1",
  "chatgpt-4o-latest",
  "text-embedding-3-large",
] as const;

const FIXTURE_NOUS = [
  "deepseek/deepseek-v4.1-flash",
  "NousResearch/Hermes-4-405B",
  "NousResearch/Hermes-4-70B",
  "z-ai/glm-5.2",
  "qwen/qwen3-max",
  "moonshotai/kimi-k3",
  "openai/gpt-oss-120b",
  "nous/embedding-v1",
] as const;

const FIXTURE_VERCEL = [
  "deepseek/deepseek-v4.1-flash",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-luna",
  "google/gemini-3-pro",
  "meta/llama-4-70b",
  "xai/grok-5",
  "zai/glm-4.7-flash",
  "openai/text-embedding-3-small",
] as const;

/** OpenRouter states modalities, so its non-text entry is excluded on that authority. */
const FIXTURE_OPENROUTER: ReadonlyArray<{
  id: string;
  name: string;
  context_length: number;
  output: string[];
}> = [
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    context_length: 262144,
    output: ["text"],
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    context_length: 200000,
    output: ["text"],
  },
  { id: "z-ai/glm-5.2", name: "GLM 5.2", context_length: 200000, output: ["text"] },
  { id: "google/gemini-3-pro", name: "Gemini 3 Pro", context_length: 1048576, output: ["text"] },
  {
    id: "meta-llama/llama-4-70b-instruct",
    name: "Llama 4 70B",
    context_length: 131072,
    output: ["text"],
  },
  { id: "qwen/qwen3-max", name: "Qwen3 Max", context_length: 262144, output: ["text"] },
  { id: "mistralai/mistral-large", name: "Mistral Large", context_length: 131072, output: ["text"] },
  { id: "black-forest-labs/flux-2", name: "FLUX.2", context_length: 8192, output: ["image"] },
];

/** The Bedrock catalog a fixture fleet's region answers with; no client is constructed. */
export function fixtureBedrockCatalog(_signal?: AbortSignal): Promise<BedrockCatalog> {
  return Promise.resolve({
    foundation_models: [
      {
        id: "zai.glm-4.7-flash",
        name: "GLM 4.7 Flash",
        output_modalities: ["TEXT"],
        inference_types: ["ON_DEMAND"],
      },
      {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        name: "Claude Sonnet 4.5",
        output_modalities: ["TEXT"],
        inference_types: ["INFERENCE_PROFILE"],
      },
      {
        id: "anthropic.claude-haiku-4-5-20251001-v1:0",
        name: "Claude Haiku 4.5",
        output_modalities: ["TEXT"],
        inference_types: ["INFERENCE_PROFILE"],
      },
      {
        id: "anthropic.claude-opus-4-1-20250805-v1:0",
        name: "Claude Opus 4.1",
        output_modalities: ["TEXT"],
        inference_types: ["INFERENCE_PROFILE"],
      },
      {
        id: "amazon.nova-pro-v1:0",
        name: "Nova Pro",
        output_modalities: ["TEXT"],
        inference_types: ["ON_DEMAND"],
      },
      {
        id: "meta.llama4-70b-instruct-v1:0",
        name: "Llama 4 70B Instruct",
        output_modalities: ["TEXT"],
        inference_types: ["ON_DEMAND"],
      },
      // Stated by AWS as an image model, so `listModels` drops it.
      {
        id: "amazon.nova-canvas-v1:0",
        name: "Nova Canvas",
        output_modalities: ["IMAGE"],
        inference_types: ["ON_DEMAND"],
      },
    ],
    inference_profiles: [
      { id: "us.zai.glm-4.7-flash", name: "GLM 4.7 Flash (US)" },
      { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (US)" },
    ],
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The fixture's transport. Routed by host, so a request that went to the wrong
 * provider's endpoint answers with that provider's shape and the isolation the
 * parsers give is exercised rather than papered over.
 */
export const fixtureModelFetch: FetchLike = (input) => {
  const url = new URL(input);
  if (url.hostname === "api.anthropic.com") {
    // One page: the fixture has eight models and the limit is a thousand, so
    // `has_more` is honestly false. Pagination is covered by its own test.
    return Promise.resolve(
      jsonResponse({
        data: FIXTURE_ANTHROPIC.map(([id, display_name]) => ({ type: "model", id, display_name })),
        has_more: false,
        first_id: FIXTURE_ANTHROPIC[0][0],
        last_id: FIXTURE_ANTHROPIC[FIXTURE_ANTHROPIC.length - 1]![0],
      }),
    );
  }
  if (url.hostname === "api.openai.com") {
    return Promise.resolve(
      jsonResponse({
        object: "list",
        data: FIXTURE_OPENAI.map((id) => ({ id, object: "model", owned_by: "openai" })),
      }),
    );
  }
  if (url.hostname === "ai-gateway.vercel.sh") {
    return Promise.resolve(
      jsonResponse({
        object: "list",
        data: FIXTURE_VERCEL.map((id) => ({ id, object: "model", name: id })),
      }),
    );
  }
  if (url.hostname === "openrouter.ai") {
    return Promise.resolve(
      jsonResponse({
        data: FIXTURE_OPENROUTER.map((m) => ({
          id: m.id,
          name: m.name,
          context_length: m.context_length,
          architecture: { input_modalities: ["text"], output_modalities: m.output },
        })),
      }),
    );
  }
  if (url.hostname === "inference-api.nousresearch.com") {
    return Promise.resolve(
      jsonResponse({ object: "list", data: FIXTURE_NOUS.map((id) => ({ id, object: "model" })) }),
    );
  }
  // Anything else is a bug in this file rather than a provider being down, and
  // saying so is more useful than a canned 404.
  return Promise.resolve(
    new Response(JSON.stringify({ error: `fixture model catalog has no host ${url.hostname}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    }),
  );
};
