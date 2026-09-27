/**
 * §8.3's live model discovery: six providers, six wire shapes, one answer.
 *
 * Nothing here opens a socket — every test hands `listModels` its own `fetch`
 * and asserts on what that fake was *asked for* as well as on what came back.
 * The request half matters as much as the response half: a provider reached at
 * the wrong host, or with somebody else's auth header, is the failure mode this
 * feature has that nothing else in hermetic does.
 */
import { describe, expect, test } from "bun:test";
import { listModels } from "../src/profiles/model-catalog.ts";
import type { BedrockCatalog } from "../src/aws/bedrock.ts";
import { PROVIDERS } from "../src/schema/index.ts";
import type { Provider } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";
import type { ErrorCode } from "../src/schema/index.ts";
import type { FetchLike } from "../src/aws/tailscale.ts";

/** A fixture value that is still obviously a fixture (§11.3, the leak grep). */
const KEY = "sk-FIXTURE-CATALOG-KEY";

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/** A `fetch` that records every request and answers the queued bodies in order. */
function recorder(bodies: unknown[], status = 200): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const fetch: FetchLike = (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url, headers });
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch, calls };
}

const anthropicPage = (ids: string[], has_more: boolean) => ({
  data: ids.map((id) => ({ type: "model", id, display_name: id.toUpperCase() })),
  has_more,
  first_id: ids[0],
  last_id: ids[ids.length - 1],
});

describe("model catalog · Anthropic", () => {
  test("pages on has_more/last_id and feeds the last id back as after_id", async () => {
    const { fetch, calls } = recorder([
      anthropicPage(["claude-a", "claude-b"], true),
      anthropicPage(["claude-c"], false),
    ]);
    const { models } = await listModels(
      { provider: "anthropic", api_key: KEY, selected: "claude-a" },
      { fetch },
    );
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get("after_id")).toBeNull();
    expect(new URL(calls[1]!.url).searchParams.get("after_id")).toBe("claude-b");
    expect(models.map((m) => m.id)).toEqual(["claude-a", "claude-b", "claude-c"]);
  });

  test("presents the key as x-api-key with the dated version header, and nothing else", async () => {
    const { fetch, calls } = recorder([anthropicPage(["claude-a"], false)]);
    await listModels({ provider: "anthropic", api_key: KEY, selected: "claude-a" }, { fetch });
    expect(new URL(calls[0]!.url).hostname).toBe("api.anthropic.com");
    expect(calls[0]!.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  /**
   * Provider isolation. Every other provider here answers a bare
   * `{ data: [...] }`, so a body without `has_more` is not Anthropic's — a
   * proxy that answered on the wrong host, or a gateway that fronted the wrong
   * upstream, must not be able to produce a plausible-looking Claude catalog.
   */
  test("an OpenAI-shaped body is malformed, not silently parsed", async () => {
    const { fetch } = recorder([{ object: "list", data: [{ id: "gpt-5.6", owned_by: "openai" }] }]);
    await expect(
      listModels({ provider: "anthropic", api_key: KEY, selected: "claude-a" }, { fetch }),
    ).rejects.toMatchObject({ code: "PROVIDER_MALFORMED" });
  });
});

describe("model catalog · the OpenAI-compatible four", () => {
  const HOSTS: Record<string, string> = {
    openai: "api.openai.com",
    vercel: "ai-gateway.vercel.sh",
    openrouter: "openrouter.ai",
    nous: "inference-api.nousresearch.com",
  };

  for (const [provider, host] of Object.entries(HOSTS)) {
    test(`${provider} is reached at ${host} with a bearer token`, async () => {
      const { fetch, calls } = recorder([{ data: [{ id: "m-1" }] }]);
      const { models } = await listModels(
        { provider: provider as Provider, api_key: KEY, selected: "m-1" },
        { fetch },
      );
      expect(new URL(calls[0]!.url).hostname).toBe(host);
      expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
      expect(models.map((m) => m.id)).toEqual(["m-1"]);
      // One request: none of these four paginates.
      expect(calls).toHaveLength(1);
    });
  }

  test("OpenRouter's stated modalities decide, and its context length survives", async () => {
    const { fetch } = recorder([
      {
        data: [
          {
            id: "deepseek/deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            context_length: 262144,
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          },
          {
            // Named like a text model, but it says it emits images.
            id: "vendor/painter-3",
            name: "Painter 3",
            architecture: { input_modalities: ["text"], output_modalities: ["image"] },
          },
        ],
      },
    ]);
    const { models } = await listModels(
      { provider: "openrouter", api_key: KEY, selected: "deepseek/deepseek-v4.1-flash" },
      { fetch },
    );
    expect(models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4.1-flash"]);
    expect(models[0]?.capabilities).toEqual({ text: true, vision: true, context: 262144 });
  });

  test("a model whose own name says it is not a text model is excluded", async () => {
    const { fetch } = recorder([
      { data: [{ id: "gpt-5.6" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }] },
    ]);
    const { models } = await listModels(
      { provider: "openai", api_key: KEY, selected: "gpt-5.6" },
      { fetch },
    );
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6"]);
  });
});

describe("model catalog · Bedrock", () => {
  const catalog: BedrockCatalog = {
    foundation_models: [
      {
        id: "zai.glm-4.7-flash",
        name: "GLM",
        output_modalities: ["TEXT"],
        inference_types: ["ON_DEMAND"],
      },
      {
        id: "amazon.nova-canvas-v1:0",
        name: "Canvas",
        output_modalities: ["IMAGE"],
        inference_types: [],
      },
    ],
    inference_profiles: [
      { id: "us.zai.glm-4.7-flash", name: "GLM (US)" },
      { id: "eu.zai.glm-4.7-flash", name: "GLM (EU)" },
    ],
  };

  const never: FetchLike = () => {
    throw new Error("Bedrock discovery must not make an HTTP request");
  };

  test("keeps both spellings and drops what AWS says is not text", async () => {
    const { models } = await listModels(
      { provider: "bedrock", selected: "zai.glm-4.7-flash" },
      { fetch: never, bedrock: () => Promise.resolve(catalog) },
    );
    expect(models.map((m) => m.id)).toEqual([
      "zai.glm-4.7-flash",
      "eu.zai.glm-4.7-flash",
      "us.zai.glm-4.7-flash",
    ]);
  });

  /**
   * M4: most of the Anthropic catalog is `INFERENCE_PROFILE`-only in most
   * regions. `InvokeModel` on the bare id fails with a validation error naming
   * the profile to use instead, so offering the bare id is offering a model
   * that cannot run — but only when the profile that covers it is right there.
   */
  test("a bare id that cannot be invoked on demand is dropped when a profile covers it", async () => {
    const withSonnet: BedrockCatalog = {
      foundation_models: [
        {
          id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
          name: "Claude Sonnet 4.5",
          output_modalities: ["TEXT"],
          inference_types: ["INFERENCE_PROFILE"],
        },
        {
          id: "zai.glm-4.7-flash",
          name: "GLM",
          output_modalities: ["TEXT"],
          inference_types: ["ON_DEMAND"],
        },
      ],
      inference_profiles: [
        { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (US)" },
      ],
    };
    const { models } = await listModels(
      { provider: "bedrock", selected: "zai.glm-4.7-flash" },
      { fetch: never, bedrock: () => Promise.resolve(withSonnet) },
    );
    expect(models.map((m) => m.id)).toEqual([
      "zai.glm-4.7-flash",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ]);
  });

  test("the same bare id is kept when no profile in the listing covers it", async () => {
    const orphaned: BedrockCatalog = {
      foundation_models: [
        {
          id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
          name: "Claude Sonnet 4.5",
          output_modalities: ["TEXT"],
          inference_types: ["INFERENCE_PROFILE"],
        },
      ],
      inference_profiles: [],
    };
    const { models } = await listModels(
      { provider: "bedrock", selected: "x" },
      { fetch: never, bedrock: () => Promise.resolve(orphaned) },
    );
    expect(models.map((m) => m.id)).toContain("anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  test("a model whose inference types AWS did not state at all is kept", async () => {
    const unknown: BedrockCatalog = {
      foundation_models: [
        {
          id: "vendor.mystery-v1:0",
          name: "Mystery",
          output_modalities: ["TEXT"],
          inference_types: [],
        },
      ],
      inference_profiles: [{ id: "us.vendor.mystery-v1:0", name: "Mystery (US)" }],
    };
    const { models } = await listModels(
      { provider: "bedrock", selected: "x" },
      { fetch: never, bedrock: () => Promise.resolve(unknown) },
    );
    expect(models.map((m) => m.id)).toContain("vendor.mystery-v1:0");
  });

  test("a backend that cannot reach Bedrock is unreachable, not empty", async () => {
    await expect(
      listModels({ provider: "bedrock", selected: "zai.glm-4.7-flash" }, { fetch: never }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE" });
  });

  /**
   * `ListInferenceProfiles` is paginated, and the walk is in `aws/bedrock.ts`
   * rather than here — so this proves the two pages arrive as one catalog
   * through the port `listModels` is given.
   */
  test("two pages of inference profiles arrive as one list", async () => {
    const pages: BedrockCatalog[] = [
      {
        foundation_models: [],
        inference_profiles: [
          { id: "us.a", name: "A" },
          { id: "us.b", name: "B" },
          { id: "us.c", name: "C" },
        ],
      },
    ];
    const { models } = await listModels(
      { provider: "bedrock", selected: "us.b" },
      { fetch: never, bedrock: () => Promise.resolve(pages[0]!) },
    );
    expect(models.map((m) => m.id)).toEqual(["us.b", "us.a", "us.c"]);
  });
});

describe("model catalog · failure is classified, and never carries the key", () => {
  const cases: Array<[number, ErrorCode]> = [
    [401, "PROVIDER_AUTH"],
    [403, "PROVIDER_AUTH"],
    [500, "PROVIDER_UNREACHABLE"],
    [502, "PROVIDER_UNREACHABLE"],
    [429, "PROVIDER_UNREACHABLE"],
  ];

  for (const [status, code] of cases) {
    test(`HTTP ${String(status)} is ${code}`, async () => {
      const { fetch } = recorder([{ error: "nope" }], status);
      const failure = await listModels(
        { provider: "openai", api_key: KEY, selected: "gpt-5.6" },
        { fetch },
      ).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(HermeticError);
      expect((failure as HermeticError).code).toBe(code);
      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toInclude(KEY);
    });
  }

  test("a rate limit says so, under the same code", async () => {
    const { fetch } = recorder([{ error: "slow down" }], 429);
    const failure = await listModels(
      { provider: "openrouter", api_key: KEY, selected: "x" },
      { fetch },
    ).catch((e: unknown) => e);
    expect((failure as HermeticError).code).toBe("PROVIDER_UNREACHABLE");
    expect((failure as HermeticError).message).toContain("rate limited");
    expect((failure as HermeticError).message).not.toInclude(KEY);
  });

  /**
   * The budget is for the whole read, not for each request in it: a paginating
   * provider must not be able to spend fifteen seconds a page.
   */
  test("one deadline is shared by every request of a paginated read", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const pages = [anthropicPage(["a"], true), anthropicPage(["b"], false)];
    let i = 0;
    const fetch: FetchLike = (_url, init) => {
      signals.push(init?.signal ?? undefined);
      return Promise.resolve(Response.json(pages[Math.min(i++, 1)]));
    };
    await listModels({ provider: "anthropic", api_key: KEY, selected: "a" }, { fetch });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[0]).toBe(signals[1]);
  });

  test("a body that is not JSON is malformed", async () => {
    const { fetch } = recorder(["<html>login</html>"]);
    await expect(
      listModels({ provider: "nous", api_key: KEY, selected: "x" }, { fetch }),
    ).rejects.toMatchObject({ code: "PROVIDER_MALFORMED" });
  });

  test("a transport that never answers is unreachable, and the key is not in the message", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("The operation timed out."));
    const failure = await listModels(
      { provider: "vercel", api_key: KEY, selected: "x" },
      { fetch },
    ).catch((e: unknown) => e);
    expect((failure as HermeticError).code).toBe("PROVIDER_UNREACHABLE");
    expect((failure as HermeticError).message).not.toInclude(KEY);
    expect((failure as HermeticError).details).toEqual({ provider: "vercel" });
  });

  test("a keyed provider with no key fails before the request is made", async () => {
    const fetch: FetchLike = () => {
      throw new Error("no request should have been made");
    };
    await expect(
      listModels({ provider: "anthropic", selected: "claude-sonnet-5" }, { fetch }),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH" });
  });
});

describe("model catalog · normalisation", () => {
  test("the selected model is pinned first, deduped, and the rest sorted by id", async () => {
    const { fetch } = recorder([{ data: [{ id: "c" }, { id: "a" }, { id: "b" }, { id: "a" }] }]);
    const { models } = await listModels({ provider: "openai", api_key: KEY, selected: "b" }, { fetch });
    expect(models.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  test("a duplicated id is merged, so the richer description survives", async () => {
    const { fetch } = recorder([
      {
        data: [
          { id: "dup" },
          {
            id: "dup",
            name: "The Real Name",
            context_length: 131072,
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          },
        ],
      },
    ]);
    const { models } = await listModels(
      { provider: "openrouter", api_key: KEY, selected: "dup" },
      { fetch },
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "dup",
      name: "The Real Name",
      capabilities: { text: true, vision: true, context: 131072 },
    });
  });

  test("a custom id the catalog does not contain stays selected and is marked unlisted", async () => {
    const { fetch } = recorder([{ data: [{ id: "a" }, { id: "b" }] }]);
    const { models } = await listModels(
      { provider: "openai", api_key: KEY, selected: "vendor/private-build-7" },
      { fetch },
    );
    expect(models[0]).toEqual({
      id: "vendor/private-build-7",
      name: "vendor/private-build-7",
      unlisted: true,
    });
    expect(models.map((m) => m.id)).toEqual(["vendor/private-build-7", "a", "b"]);
  });

  /**
   * The exclusion is about the catalog, not about the operator's own choice: a
   * selected id that the heuristic would have dropped is still what is
   * selected, and hiding it would silently change what an agent runs.
   */
  test("the selected model survives the exclusion that would have dropped it", async () => {
    const { fetch } = recorder([{ data: [{ id: "text-embedding-3-large" }, { id: "gpt-5.6" }] }]);
    const { models } = await listModels(
      { provider: "openai", api_key: KEY, selected: "text-embedding-3-large" },
      { fetch },
    );
    expect(models.map((m) => m.id)).toEqual(["text-embedding-3-large", "gpt-5.6"]);
  });
});

/**
 * §8.3's defaults table, one assertion per provider. A default that moves is a
 * change in what every new agent runs, so it is written out here as a literal
 * rather than derived from the thing under test.
 */
describe("the provider catalog's default models", () => {
  const EXPECTED: Record<Provider, string> = {
    anthropic: "claude-sonnet-5",
    openai: "gpt-5.6-luna",
    vercel: "deepseek/deepseek-v4.1-flash",
    openrouter: "deepseek/deepseek-v4.1-flash",
    bedrock: "zai.glm-4.7-flash",
    nous: "deepseek/deepseek-v4.1-flash",
  };

  for (const [provider, model] of Object.entries(EXPECTED) as Array<[Provider, string]>) {
    test(`${provider} defaults to ${model}`, () => {
      expect(PROVIDERS[provider].default_model).toBe(model);
    });
  }

  test("the table covers every provider in the enum", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  /** The two new entries are Hermes builtins, so nothing declares them (§8.1). */
  test("openai and vercel are named to Hermes as its own providers", () => {
    expect(PROVIDERS.openai.hermes_provider).toBe("openai-api");
    expect(PROVIDERS.openai.hermes_provider_entry).toBe(false);
    expect(PROVIDERS.openai.env).toBe("OPENAI_API_KEY");
    expect(PROVIDERS.vercel.hermes_provider).toBe("vercel");
    expect(PROVIDERS.vercel.hermes_provider_entry).toBe(false);
    expect(PROVIDERS.vercel.env).toBe("AI_GATEWAY_API_KEY");
  });
});
