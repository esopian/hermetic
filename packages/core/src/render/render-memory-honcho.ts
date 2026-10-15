/**
 * honcho's half of `render-memory.ts`: the settings its server is started with
 * (`honchoEnvPath`), the Hermes plugin's client configuration
 * (`honchoClientConfPath`), and the pieces of its three units — the API under
 * `MEMORY_SERVICE_UNIT`, the deriver under `MEMORY_WORKER_UNIT` and the
 * Postgres under `MEMORY_DB_UNIT`. Pure data; `render-memory.ts` assembles the
 * API and worker units in the shape every memory server shares (`memoryUnit`),
 * and this module renders the database's, which shares nothing with them.
 *
 * Read against Honcho v3.3.0 (`MEMORY_SERVICES.honcho.source`): its settings
 * are pydantic-settings classes with per-section prefixes and `__` nesting
 * (`src/config.py`), so everything here is environment, in one file both
 * processes load. No secret is in it: the provider key arrives through
 * `MEMORY_LLM_ENV_PATH` (`LLM_OPENAI_API_KEY`), and the database has no
 * password to keep — it listens on a Unix socket in a 0700 directory and
 * authenticates `local` connections by peer.
 */
import type { Provider } from "../schema/index.ts";
import {
  HONCHO_DB_NAME,
  HONCHO_DB_SOCKET_DIR,
  HONCHO_PG_BIN,
  MEMORY_DB_UNIT,
  MEMORY_SERVICES,
  MEMORY_SERVICE_UNIT,
  PROVIDERS,
  PROVIDER_EMBEDDING_DIMENSION,
  honchoPgDataDir,
  honchoTiktokenDir,
  providerEmbeddingModel,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";

/** The loopback URL the API listens on, and the one the Hermes plugin is pointed at. */
export const HONCHO_LOOPBACK_URL = `http://127.0.0.1:${String(MEMORY_SERVICES.honcho.port)}`;

/**
 * `DB_CONNECTION_URI`: the `hermes` role, over the socket in
 * `HONCHO_DB_SOCKET_DIR` (libpq's `host=` names a directory), no password.
 * Honcho's engine needs the `postgresql+psycopg` dialect.
 */
export const HONCHO_DB_URI = `postgresql+psycopg://hermes@/${HONCHO_DB_NAME}?host=${HONCHO_DB_SOCKET_DIR}`;

/**
 * The connection pool each of the two processes keeps (`DB_POOL_SIZE` +
 * `DB_MAX_OVERFLOW`, one engine per process, `src/db.py`), and the server's
 * `max_connections` above their total. Upstream's 10 + 20 per process is
 * sized for a shared cluster; on a box running one agent it would only hold
 * memory. The headroom covers the API's `provision_db.py` (its own process,
 * before the API starts), Postgres's three reserved superuser slots, and an
 * operator's `psql`.
 */
export const HONCHO_DB_POOL_SIZE = 5;
export const HONCHO_DB_MAX_OVERFLOW = 10;
export const HONCHO_PG_MAX_CONNECTIONS = 50;

/** Every model setting Honcho has, one per function that calls a model (`src/config.py`). */
const HONCHO_MODEL_CONFIGS = [
  "DERIVER_MODEL_CONFIG",
  "SUMMARY_MODEL_CONFIG",
  ...(["minimal", "low", "medium", "high", "max"] as const).map(
    (level) => `DIALECTIC_LEVELS__${level}__MODEL_CONFIG`,
  ),
  "DREAM_DEDUCTION_MODEL_CONFIG",
  "DREAM_INDUCTION_MODEL_CONFIG",
] as const;

/**
 * Map the agent's vendor and model onto Honcho's model and embedding settings.
 * The caller has already refused a vendor with no embeddings endpoint
 * (`assertMemoryLlm`) and checked the model id (`assertModelId`).
 *
 * - Every function runs on the `openai` transport, which is any
 *   OpenAI-compatible endpoint; a gateway vendor sets `LLM_OPENAI_BASE_URL`,
 *   which the default OpenAI client reads (`src/llm/registry.py`). The
 *   upstream defaults name only a transport and a model — no thinking budget,
 *   no fallback — so replacing the model is the whole mapping.
 * - Embeddings do not read `LLM_OPENAI_BASE_URL`, so a gateway also sets the
 *   embedding override. The key falls back to `LLM_OPENAI_API_KEY` for both.
 * - `STRUCTURED_OUTPUT_MODE=json_object` on the gateway vendors: their model
 *   is whatever the agent runs, and upstream documents `json_object` for
 *   OpenAI-compatible providers that may lack `json_schema` — the deriver's
 *   failure there is a 400 it turns into *no observations*, silently
 *   (`src/llm/backends/openai.py`), where `json_object` injects the schema
 *   into the prompt and repairs the answer. OpenAI itself serves `json_schema`
 *   for its own models, so it keeps upstream's default. Set on every function:
 *   it only acts where a call asks for structured output, and the validator
 *   accepts it on the `openai` transport.
 */
export function honchoLlmEnv(vendor: Provider, model: string): Record<string, string> {
  const embeddingModel = providerEmbeddingModel(vendor);
  if (embeddingModel === null) {
    // Refused before anything is written (`assertMemoryLlm`); a render must
    // still not emit a server that cannot embed.
    throw new HermeticError(
      "MEMORY_LLM_UNSUPPORTED",
      `memory provider honcho cannot embed through ${vendor}`,
      { provider: "honcho", vendor },
    );
  }
  const baseUrl = vendor === "openai" ? null : PROVIDERS[vendor].base_url;
  const env: Record<string, string> = {};
  if (baseUrl !== null) env["LLM_OPENAI_BASE_URL"] = baseUrl;
  for (const prefix of HONCHO_MODEL_CONFIGS) {
    env[`${prefix}__TRANSPORT`] = "openai";
    env[`${prefix}__MODEL`] = model;
    if (baseUrl !== null) env[`${prefix}__STRUCTURED_OUTPUT_MODE`] = "json_object";
  }
  env["EMBEDDING_MODEL_CONFIG__TRANSPORT"] = "openai";
  env["EMBEDDING_MODEL_CONFIG__MODEL"] = embeddingModel;
  if (baseUrl !== null) env["EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL"] = baseUrl;
  /**
   * The schema is migrated at `vector(1536)` and the server refuses to start on
   * any other width. Stating it makes Honcho send `dimensions=` on every
   * embedding call (`resolve_send_dimensions`); `never` keeps that parameter
   * off the wire, since 1536 is the model's native width anyway and a gateway
   * need not pass it through. Each answer's width is still checked.
   */
  env["EMBEDDING_VECTOR_DIMENSIONS"] = String(PROVIDER_EMBEDDING_DIMENSION);
  env["EMBEDDING_MODEL_CONFIG__DIMENSIONS_MODE"] = "never";
  return env;
}

/**
 * `honchoEnvPath`: the server's settings, final content. Every value is a
 * constant or has been through `assertModelId`, so no line needs quoting.
 */
export function honchoEnvFile(llmEnv: Readonly<Record<string, string>>): string {
  const lines = [
    "# Rendered by hermetic. Final file, no templating.",
    // Honcho reads `.env` (with override) and `config.toml` from its working
    // directory; this file and the key file are the only configuration.
    "PYTHON_DOTENV_DISABLED=1",
    "HONCHO_CONFIG_TOML_DISABLED=1",
    "PYTHONUNBUFFERED=1",
    `DB_CONNECTION_URI=${HONCHO_DB_URI}`,
    `DB_POOL_SIZE=${String(HONCHO_DB_POOL_SIZE)}`,
    `DB_MAX_OVERFLOW=${String(HONCHO_DB_MAX_OVERFLOW)}`,
    // Loopback only: nothing but Hermes, on this box, can reach the API.
    "AUTH_USE_AUTH=false",
    // Off by default upstream; stated so a changed default cannot turn on an
    // outbound report or (metrics) a listener on every interface.
    "SENTRY_ENABLED=false",
    "TELEMETRY_ENABLED=false",
    "METRICS_ENABLED=false",
    // No Redis on the box.
    "CACHE_ENABLED=false",
    "VECTOR_STORE_TYPE=pgvector",
    // Pre-warmed at install: tiktoken would otherwise download its encodings
    // on first use.
    `TIKTOKEN_CACHE_DIR=${honchoTiktokenDir}`,
    "DERIVER_WORKERS=1",
    ...Object.entries(llmEnv).map(([k, v]) => `${k}=${v}`),
  ];
  return lines.join("\n") + "\n";
}

/**
 * `honchoClientConfPath`, which hermeticd links to `HONCHO_PLUGIN_CONFIG_LINK`.
 * Root-level keys, which the plugin reads for any host (`client.py`).
 *
 * - `peerName` without `pinUserPeer`: a gateway user keeps the peer the
 *   plugin derives for them, and a session with no runtime user falls back to
 *   this one rather than failing to start.
 * - `aiPeer` is the agent, so two agents sharing a workspace name never share
 *   a self.
 * - `enabled: true` makes the file explicit, and an explicit file without
 *   `observationMode` gets the legacy `unified` mode, so it is stated.
 */
export function honchoClientConf(agentName: string): string {
  return (
    JSON.stringify(
      {
        enabled: true,
        baseUrl: HONCHO_LOOPBACK_URL,
        workspace: "hermes",
        aiPeer: agentName,
        peerName: "user",
        sessionStrategy: "per-session",
        observationMode: "directional",
      },
      null,
      2,
    ) + "\n"
  );
}

/** The `[Unit]` lines the API and the worker add: both need the database. */
export function honchoDbDependency(): string[] {
  return [`Requires=${MEMORY_DB_UNIT}`, `After=${MEMORY_DB_UNIT}`];
}

/** The worker also waits for the API, whose `ExecStartPre` runs the migrations. */
export function honchoWorkerOrdering(): string[] {
  return [...honchoDbDependency(), `After=${MEMORY_SERVICE_UNIT}`];
}

/**
 * `MEMORY_DB_UNIT`: the honcho cluster, run by the `hermes` account from the
 * data volume, with no TCP listener at all (`listen_addresses` empty) and its
 * socket in a runtime directory only the account can enter. hermeticd creates
 * the cluster (`initdb`) and the database; this only runs it.
 *
 * The shape is the one PostgreSQL documents for systemd (`Type=notify`,
 * `KillMode=mixed`, `KillSignal=SIGINT` — a fast shutdown) and Ubuntu's build
 * supports. A finite start timeout, not the manual's `infinity`: the Hermes
 * units order after the API, which orders after this, so a database that
 * never reported ready would hold the agent's boot forever. Five minutes is
 * room for crash recovery on a store this size; past it the unit fails,
 * `Restart=on-failure` tries again, and Hermes starts on built-in memory
 * meanwhile (its `Wants=`).
 */
export function honchoDbUnit(): string {
  const exec = [
    `${HONCHO_PG_BIN}/postgres`,
    `-D ${honchoPgDataDir}`,
    "-c listen_addresses=",
    `-c unix_socket_directories=${HONCHO_DB_SOCKET_DIR}`,
    `-c max_connections=${String(HONCHO_PG_MAX_CONNECTIONS)}`,
    // Postgres's own default, stated: the box's memory budget counts on it.
    "-c shared_buffers=128MB",
  ].join(" ");
  return [
    "# Rendered by hermetic. Final file, no templating.",
    "[Unit]",
    "Description=Hermes memory database (Honcho's PostgreSQL)",
    // The cluster is on the data volume, mounted `nofail` (`memoryUnit`'s reason).
    "RequiresMountsFor=/data",
    "",
    "[Service]",
    "Type=notify",
    "User=hermes",
    "Group=hermes",
    `RuntimeDirectory=${HONCHO_DB_SOCKET_DIR.replace(/^\/run\//, "")}`,
    "RuntimeDirectoryMode=0700",
    "ExecStart=" + exec,
    "KillMode=mixed",
    "KillSignal=SIGINT",
    "TimeoutStartSec=300",
    "TimeoutStopSec=300",
    "Restart=on-failure",
    "RestartSec=5",
    "NoNewPrivileges=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}
