/**
 * The model providers an agent can be bound to (§8.1): the id list the Zod
 * enum is built from, what each needs on the box, and the model it seeds.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

/** Model provider ids. `bedrock` is the zero-secret path through the instance role. */
export const PROVIDER_IDS = ["bedrock", "anthropic", "openrouter", "nous", "openai", "vercel"] as const;
export type Provider = (typeof PROVIDER_IDS)[number];

export const PROVIDERS_LIST: readonly Provider[] = PROVIDER_IDS;

export interface ProviderSpec {
  readonly label: string;
  /**
   * `role` providers authenticate as the instance itself and need no secret.
   * `api_key` providers need a key on the box before Hermes can start, so they
   * imply a `secrets_mode` that can deliver one (§8.1).
   */
  readonly auth: "role" | "api_key";
  /** Environment variable Hermes reads the key from; null for `role` providers. */
  readonly env: string | null;
  /** OpenAI-compatible base URL, when the provider is reached over one. */
  readonly base_url: string | null;
  /**
   * What this provider is called in Hermes's own `config.yaml`
   * (`model.provider`), which is not always what hermetic calls it.
   *
   * The gap is real and it is why an agent could boot healthy and still refuse
   * the first message. Hermes's built-in `nous` provider is an OAuth
   * device-code login against the Nous Portal: it is registered with
   * `auth_type="oauth_device_code"`, which keeps it out of the registry Hermes
   * scans for API keys, so a `NOUS_API_KEY` sitting in the environment is
   * invisible to it and provider resolution falls all the way through to
   * "No inference provider configured".
   */
  readonly hermes_provider: string;
  /**
   * Whether hermetic must declare this provider to Hermes as its own endpoint —
   * a `providers:` entry naming a base URL and the environment variable the key
   * arrives in — rather than relying on a built-in of the same name.
   *
   * True only where Hermes's built-in cannot take an API key at all (Nous). The
   * name in `hermes_provider` is then deliberately not the built-in's: Hermes
   * refuses to let a declared entry shadow a canonical provider, so an entry
   * called `nous` would be ignored in favour of the OAuth login this is trying
   * to avoid.
   */
  readonly hermes_provider_entry: boolean;
  /**
   * The model id seeded into a new agent's config when the operator names none.
   * Spelled the way this provider spells it — see `HermesSettings.model`.
   *
   * On Bedrock this must be a model the fleet's instance role may actually
   * invoke: `bedrockModelArns` (`aws/index.ts`) grants exactly
   * `DEFAULT_BEDROCK_MODEL_IDS`, as foundation models and as the `us.`-prefixed
   * inference profiles Hermes prefers, and nothing else.
   *
   * These deliberately differ from upstream's own defaults for the two gateway
   * providers, and the difference is the point. Upstream labels one entry per
   * provider `"default": true` in `website/static/api/model-catalog.json` —
   * `z-ai/glm-5.2` for both openrouter and nous — and states that the remote
   * catalog is authoritative precisely so the default *"rotates without a
   * release"* (`models_catalog_static.py:481-498`), with
   * `_SILENT_DEFAULT_PROVIDERS = {"nous", "openrouter"}` existing to stop a
   * silently-chosen default being an expensive flagship. hermetic's ids are
   * valid on both providers, so this is a cost question, not a 404. Keep them:
   * a default that rotates without a release is exactly what a fleet with an
   * `applied_config_hash` must not inherit, and hermetic's default is *stated
   * in the seed* every agent boots with rather than resolved silently at run
   * time, so the guard upstream built does not apply here.
   */
  readonly default_model: string;
  readonly description: string;
}

/** What each provider needs on the box, and where its key comes from (§8.1). */
export const PROVIDERS: Readonly<Record<Provider, ProviderSpec>> = {
  bedrock: {
    label: "Bedrock",
    auth: "role",
    env: null,
    base_url: null,
    hermes_provider: "bedrock",
    hermes_provider_entry: false,
    // `bedrockModelArns` grants both the bare foundation model and the
    // `us.`-prefixed inference profile for every id in
    // `DEFAULT_BEDROCK_MODEL_IDS`, so either spelling of this id is invocable.
    default_model: "zai.glm-4.7-flash",
    description: "Frontier models via the instance role — no key exists on the box",
  },
  anthropic: {
    label: "Anthropic",
    auth: "api_key",
    env: "ANTHROPIC_API_KEY",
    base_url: null,
    hermes_provider: "anthropic",
    hermes_provider_entry: false,
    default_model: "claude-sonnet-5",
    description: "Anthropic API direct, keyed per agent",
  },
  openrouter: {
    label: "OpenRouter",
    auth: "api_key",
    env: "OPENROUTER_API_KEY",
    base_url: "https://openrouter.ai/api/v1",
    hermes_provider: "openrouter",
    hermes_provider_entry: false,
    default_model: "deepseek/deepseek-v4.1-flash",
    description: "OpenRouter's OpenAI-compatible gateway, keyed per agent",
  },
  nous: {
    label: "Nous Portal",
    auth: "api_key",
    env: "NOUS_API_KEY",
    base_url: "https://inference-api.nousresearch.com/v1",
    // Not `nous`: that name is Hermes's OAuth Portal login, which ignores
    // `NOUS_API_KEY` entirely, and which a declared entry may not shadow.
    // See `ProviderSpec.hermes_provider_entry`.
    hermes_provider: "hermetic-nous",
    hermes_provider_entry: true,
    default_model: "deepseek/deepseek-v4.1-flash",
    description: "Nous Research Portal inference API, keyed per agent",
  },
  openai: {
    label: "OpenAI",
    auth: "api_key",
    env: "OPENAI_API_KEY",
    base_url: "https://api.openai.com/v1",
    // Hermes's own built-in, which keys from `OPENAI_API_KEY` and keeps its
    // native Responses API behaviour. Not `openai`: that name is taken by
    // upstream's ChatGPT OAuth login, the same trap `nous` is.
    hermes_provider: "openai-api",
    hermes_provider_entry: false,
    default_model: "gpt-5.6-luna",
    description: "OpenAI API direct, keyed per agent",
  },
  vercel: {
    label: "Vercel AI Gateway",
    auth: "api_key",
    env: "AI_GATEWAY_API_KEY",
    base_url: "https://ai-gateway.vercel.sh/v1",
    // `vercel` is the canonical name in Hermes's `hermes_cli/providers.py`;
    // `ai-gateway` is an alias for it. Either resolves, but the canonical one
    // is what a `hermes config` read on the box will echo back.
    hermes_provider: "vercel",
    hermes_provider_entry: false,
    default_model: "deepseek/deepseek-v4.1-flash",
    description: "Vercel's AI Gateway over every upstream it fronts, keyed per agent",
  },
} as const;

/** True when this provider cannot run without a key delivered to the instance. */
export function providerNeedsKey(provider: Provider): boolean {
  return PROVIDERS[provider].auth === "api_key";
}
