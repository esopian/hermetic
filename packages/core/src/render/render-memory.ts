/**
 * The external memory provider's half of an agent's configuration: the server
 * a service provider runs beside Hermes (`MEMORY_SERVICE_UNIT`), its own
 * configuration, what the Hermes units need to find it, and the manifest's
 * `memory` block hermeticd installs from. Final file content, no templating —
 * see `render.ts`.
 *
 * An in-process provider (`holographic`) renders nothing here: the managed
 * `config.yaml`'s `memory.provider` (`render-hermes.ts`) is all it needs.
 *
 * **The model a service calls.** hindsight extracts facts and openviking
 * summarises sessions with a model, and neither has an account of its own: it
 * uses the agent's bound vendor and model (§8.3), mapped here onto the
 * server's own settings (`memoryLlmFor`). The key is never rendered. The
 * manifest names the variable(s) the server reads it from
 * (`memory.llm.key_env`), and hermeticd copies the agent's provider key under
 * each into `MEMORY_LLM_ENV_PATH` — tmpfs, root-only, loaded by the memory
 * unit alone, so an alias such as `OPENAI_API_KEY` for a Nous key never
 * reaches Hermes's own environment. Bedrock has no key: the server signs as
 * the instance role, and is told the region.
 *
 * **Loopback only.** Neither server authenticates its callers, so each is
 * bound to 127.0.0.1 explicitly — hindsight's own default is 0.0.0.0 — and the
 * box's nftables ruleset is the second wall, not the first.
 */
import type {
  ManifestMemory,
  MemoryLlm,
  MemoryLlmKeyEnv,
  Provider,
  RenderedFile,
} from "../schema/index.ts";
import {
  HERMES_ACCOUNT_HOME,
  MEMORY_LLM_ENV_PATH,
  MEMORY_PROVIDERS,
  MEMORY_SERVICES,
  MEMORY_SERVICE_UNIT,
  PROVIDERS,
  memoryServiceDir,
  openvikingConfPath,
} from "../schema/index.ts";
import type { MemoryProvider } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";

/** The providers that run a server, and so have a `MEMORY_SERVICES` entry. */
export type MemoryServiceProvider = keyof typeof MEMORY_SERVICES;

export function isMemoryServiceProvider(id: MemoryProvider): id is MemoryServiceProvider {
  return MEMORY_PROVIDERS[id].kind === "service";
}

/** What `memoryLlmFor` maps a vendor to for hindsight: its `HINDSIGHT_API_LLM_*` environment. */
export interface HindsightLlmSettings {
  readonly env: Readonly<Record<string, string>>;
}

/** What `memoryLlmFor` maps a vendor to for openviking: the `vlm` block of `ov.conf`. */
export interface OpenVikingLlmSettings {
  readonly vlm: { readonly provider: "litellm"; readonly model: string; readonly api_base?: string };
}

/**
 * A model id goes into a unit's `Environment=` line and into `ov.conf`, which
 * the server runs `os.path.expandvars` over. `HermesSettings.model` is
 * free-form, so the id is held to the characters model ids are spelled in: no
 * whitespace or newline (a unit line), no `%` (a systemd specifier), no `$`
 * (an expansion in either file).
 */
const MODEL_ID = /^[A-Za-z0-9._:/@+-]+$/;

export function assertModelId(provider: MemoryServiceProvider, model: string): void {
  if (MODEL_ID.test(model)) return;
  throw new HermeticError(
    "VALIDATION",
    `model ${JSON.stringify(model)} cannot be handed to the ${provider} memory server: ` +
      "a model id may contain only letters, digits and . _ : / @ + -",
    { provider, model },
  );
}

/** The variable litellm reads each keyed route's key from (`MEMORY_LLM_KEY_ENVS`). */
const LITELLM_KEY_ENV: Readonly<Partial<Record<Provider, MemoryLlmKeyEnv>>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Vendors reached through an OpenAI-compatible endpoint the memory server must be pointed at. */
function compatibleBaseUrl(vendor: Provider): string | null {
  return vendor === "nous" || vendor === "vercel" ? PROVIDERS[vendor].base_url : null;
}

/**
 * Map the agent's bound vendor and model onto a memory server's own LLM
 * settings, and the variable name(s) the box hands it the key under.
 *
 * hindsight speaks `anthropic`, `openai`, `openrouter` and `bedrock` natively;
 * Nous and Vercel are OpenAI-compatible endpoints, so they go through its
 * `openai` provider with `HINDSIGHT_API_LLM_BASE_URL`. openviking routes through
 * litellm, whose `<vendor>/<model>` route picks the client and whose
 * conventional `<VENDOR>_API_KEY` variable carries the key; Nous and Vercel
 * again ride the `openai/` route with an `api_base`.
 */
export function memoryLlmFor(
  provider: "hindsight",
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: HindsightLlmSettings };
export function memoryLlmFor(
  provider: "openviking",
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: OpenVikingLlmSettings };
export function memoryLlmFor(
  provider: MemoryServiceProvider,
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: HindsightLlmSettings | OpenVikingLlmSettings };
export function memoryLlmFor(
  provider: MemoryServiceProvider,
  vendor: Provider,
  model: string,
): { llm: MemoryLlm; settings: HindsightLlmSettings | OpenVikingLlmSettings } {
  assertModelId(provider, model);
  const keyed = PROVIDERS[vendor].auth === "api_key";
  const baseUrl = compatibleBaseUrl(vendor);
  if (provider === "hindsight") {
    // Native where hindsight has the vendor; `openai` + base URL where it is
    // an OpenAI-compatible endpoint.
    const llmProvider = baseUrl !== null ? "openai" : vendor;
    const env: Record<string, string> = {
      HINDSIGHT_API_LLM_PROVIDER: llmProvider,
      HINDSIGHT_API_LLM_MODEL: model,
      ...(baseUrl === null ? {} : { HINDSIGHT_API_LLM_BASE_URL: baseUrl }),
    };
    return {
      llm: { vendor, model, key_env: keyed ? ["HINDSIGHT_API_LLM_API_KEY"] : [] },
      settings: { env },
    };
  }
  const route = baseUrl !== null ? "openai" : vendor;
  const routeKey = keyed ? LITELLM_KEY_ENV[route] : undefined;
  const keyEnv: MemoryLlmKeyEnv[] = routeKey === undefined ? [] : [routeKey];
  return {
    llm: { vendor, model, key_env: keyEnv },
    settings: {
      vlm: {
        provider: "litellm",
        model: `${route}/${model}`,
        ...(baseUrl === null ? {} : { api_base: baseUrl }),
      },
    },
  };
}

/** What `renderMemory` and the Hermes units read off a render input. */
export interface MemoryRenderInput {
  memory?: { provider: MemoryProvider } | undefined;
  /** The agent's bound vendor — the one its own model calls go to. */
  provider: Provider;
  /** The agent's resolved model, as its `config.yaml` names it. */
  model: string;
  region: string;
}

/**
 * What the Hermes units (the dashboard's, and the gateway's drop-in) add for a
 * memory provider: ordering behind its server, and for openviking the endpoint
 * its plugin needs. `[Unit]` and `[Service]` lines, for `hermesRuntimeLines`.
 */
export interface MemoryHermesLines {
  ordering: string[];
  service: string[];
}

export function memoryHermesLines(input: Pick<MemoryRenderInput, "memory">): MemoryHermesLines {
  const id = input.memory?.provider;
  if (id === undefined || !isMemoryServiceProvider(id)) return { ordering: [], service: [] };
  /**
   * `Wants=`, not `Requires=`: a memory server that failed is an agent on
   * built-in memory, which is worse but still an agent; taking Hermes down
   * with it would be no agent at all.
   */
  const ordering = [`Wants=${MEMORY_SERVICE_UNIT}`, `After=${MEMORY_SERVICE_UNIT}`];
  const loopback = `http://127.0.0.1:${String(MEMORY_SERVICES[id].port)}`;
  /**
   * How each plugin finds its server. Environment rather than a rendered file,
   * because the plugins' own files live under `$HERMES_HOME`, and nothing
   * hermetic renders may land under the `hermes` home: root's files phase
   * writes and chowns them, and the account controls every directory entry
   * there (`account-dirs.ts`).
   *
   * - openviking: `is_available()` is false unless `OPENVIKING_ENDPOINT` is
   *   set — the plugin does not fall back to its own default URL — so without
   *   it Hermes would quietly run on built-in memory alone.
   * - hindsight: `_load_config` reads these when there is no
   *   `$HERMES_HOME/hindsight/config.json`. `local_external` makes it a client
   *   of the server above, with no key of its own. An operator-made
   *   `config.json` there overrides every one of them (upstream's precedence:
   *   the file, when present, is the whole configuration).
   */
  const service =
    id === "openviking"
      ? [`Environment=OPENVIKING_ENDPOINT=${loopback}`]
      : [
          "Environment=HINDSIGHT_MODE=local_external",
          `Environment=HINDSIGHT_API_URL=${loopback}`,
          "Environment=HINDSIGHT_BANK_ID=hermes",
          "Environment=HINDSIGHT_BUDGET=mid",
          "Environment=HINDSIGHT_TIMEOUT=120",
        ];
  return { ordering, service };
}

function bedrockRegionLines(vendor: Provider, region: string): string[] {
  if (PROVIDERS[vendor].auth !== "role") return [];
  // botocore reads `AWS_REGION`/`AWS_DEFAULT_REGION`; litellm's Bedrock client
  // reads `AWS_REGION_NAME` first. A unit inherits none of them.
  return [
    "Environment=AWS_REGION_NAME=" + region,
    "Environment=AWS_REGION=" + region,
    "Environment=AWS_DEFAULT_REGION=" + region,
  ];
}

function memoryUnit(
  id: MemoryServiceProvider,
  serviceEnv: readonly string[],
  execStart: string,
): string {
  const dir = memoryServiceDir(id);
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "[Unit]",
    "Description=Hermes memory server (" + MEMORY_PROVIDERS[id].label + ")",
    "After=network-online.target",
    "Wants=network-online.target",
    /**
     * The venv, the data and the models are all on the data volume, which is
     * mounted `nofail`: without this the server could start against an empty
     * root-filesystem directory the volume then mounts over (the browser
     * units' reason, `render-browser.ts`).
     */
    "RequiresMountsFor=/data",
    /**
     * `MEMORY_LLM_ENV_PATH` is on tmpfs and written by hermeticd beside
     * `secrets.env`, so it is gone after every reboot until the secrets unit
     * has run again.
     */
    "After=hermetic-secrets.service",
    "Requires=hermetic-secrets.service",
    "",
    "[Service]",
    "Type=simple",
    "User=hermes",
    "Group=hermes",
    "Environment=HOME=" + HERMES_ACCOUNT_HOME,
    "WorkingDirectory=" + dir,
    /**
     * Unconditional, like `secrets.env`: hermeticd always writes it, empty for
     * a Bedrock agent, so the unit's shape does not depend on the vendor.
     */
    "EnvironmentFile=" + MEMORY_LLM_ENV_PATH,
    ...serviceEnv,
    "ExecStart=" + execStart,
    "Restart=always",
    "RestartSec=5",
    "NoNewPrivileges=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export interface RenderedMemory {
  files: RenderedFile[];
  units: string[];
  /** Absent for an agent with no external provider. */
  manifestMemory: ManifestMemory | undefined;
  hermesUnitLines: MemoryHermesLines;
}

export function renderMemory(input: MemoryRenderInput): RenderedMemory {
  const hermesUnitLines = memoryHermesLines(input);
  const id = input.memory?.provider;
  if (id === undefined) return { files: [], units: [], manifestMemory: undefined, hermesUnitLines };
  if (!isMemoryServiceProvider(id)) {
    return { files: [], units: [], manifestMemory: { provider: id }, hermesUnitLines };
  }
  const spec = MEMORY_SERVICES[id];
  const dir = memoryServiceDir(id);
  const bin = `${dir}/venv/bin/${spec.command}`;
  const region = bedrockRegionLines(input.provider, input.region);
  const files: RenderedFile[] = [];
  let llm: MemoryLlm;
  let unitFile: string;

  if (id === "hindsight") {
    const mapped = memoryLlmFor("hindsight", input.provider, input.model);
    llm = mapped.llm;
    unitFile = memoryUnit(
      id,
      [
        "Environment=HINDSIGHT_API_HOST=127.0.0.1",
        "Environment=HINDSIGHT_API_PORT=" + String(spec.port),
        // Embedded Postgres, under `$HOME/.pg0` — on the data volume.
        "Environment=HINDSIGHT_API_DATABASE_URL=pg0",
        ...Object.entries(mapped.settings.env).map(([k, v]) => `Environment=${k}=${v}`),
        // The first start downloads the embedding and reranking models.
        "Environment=HINDSIGHT_API_MODEL_INIT_TIMEOUT=1800",
        "Environment=HF_HOME=" + dir + "/hf",
        ...region,
      ],
      bin,
    );
    // The plugin's settings are environment on the Hermes units (`memoryHermesLines`).
  } else {
    const mapped = memoryLlmFor("openviking", input.provider, input.model);
    llm = mapped.llm;
    unitFile = memoryUnit(id, region, `${bin} --config ${openvikingConfPath}`);
    /**
     * Strict JSON, and no `$` anywhere: the server runs `os.path.expandvars`
     * over the file before parsing it. No key either — litellm reads the
     * vendor's variable from the unit's `EnvironmentFile`. `auth_mode: null`
     * is the dev mode, which the server refuses unless the host is loopback.
     *
     * Under `/etc/hermetic`, root-owned and group `hermes` at 0640 — readable
     * by the server, writable by root alone — and never on the data volume:
     * nothing hermetic renders lands under the `hermes` home
     * (`MEMORY_SERVICE_CONF_DIR`). The paths it *names* are the service's
     * data, which stays there.
     */
    files.push({
      path: openvikingConfPath,
      mode: "0640",
      owner: "root",
      group: "hermes",
      content:
        JSON.stringify(
          {
            server: { host: "127.0.0.1", port: spec.port, auth_mode: null },
            storage: { workspace: `${dir}/data` },
            embedding: {
              dense: {
                provider: "local",
                model: "bge-small-zh-v1.5-f16",
                cache_dir: `${dir}/models`,
              },
            },
            vlm: mapped.settings.vlm,
          },
          null,
          2,
        ) + "\n",
      restart_units: [MEMORY_SERVICE_UNIT],
    });
  }

  files.unshift({
    path: `/etc/systemd/system/${MEMORY_SERVICE_UNIT}`,
    mode: "0644",
    content: unitFile,
  });
  return {
    files,
    units: [MEMORY_SERVICE_UNIT],
    manifestMemory: { provider: id, pin: spec.pin, llm },
    hermesUnitLines,
  };
}
