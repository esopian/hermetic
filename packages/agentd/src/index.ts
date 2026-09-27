/**
 * hermeticd — the node agent (§4.1–4.4, §6.3–6.5). It may import ONLY
 * `@hermetic/core/schema`, never core's AWS-client or command layers: it must
 * not be able to reach fleet-level operations (§3.1). `tests/boundaries.test.ts`
 * enforces this by grepping imports.
 */
export { AgentdError, EXIT_ERROR, EXIT_MANIFEST_REFUSED, EXIT_OK, exitCodeFor } from "./errors.ts";
export type { AgentdErrorCode } from "./errors.ts";

export { EXEC_ENV_ALLOWLIST, execEnv, must, realHost } from "./host.ts";
export type { ExecEvent, ExecOptions, ExecResult, FileStat, Host, StatfsResult } from "./host.ts";

export { collector, opEvent } from "./events.ts";
export type { Emit } from "./events.ts";

export {
  MANIFEST_PATH,
  SUPPORTED_SCHEMA_VERSION,
  parseManifest,
  parseManifestJson,
  readAppliedConfigHash,
  readBundleManifest,
} from "./manifest.ts";

export {
  USER_DATA_FIELDS,
  USER_DATA_JSON_PATH,
  assertNoSecrets,
  extractUserDataJson,
  httpImds,
  loadUserData,
  parseUserData,
} from "./userdata.ts";
export type { Imds, UserData } from "./userdata.ts";

export {
  FLEET_CACHE_PATH,
  STATE_DIR,
  agentParamPrefix,
  cacheFleetManifest,
  paramPath,
  parseFleetManifest,
  readCachedFleetManifest,
  readUsableFleetManifest,
} from "./fleet.ts";

export {
  fetchFleetManifest,
  hermeticdActor,
  makeAws,
  realAws,
  realS3,
  tableName,
} from "./aws.ts";
export type {
  Aws,
  AwsDeps,
  CommandSink,
  EventAction,
  EventInput,
  HeartbeatInput,
  TransitionInput,
} from "./aws.ts";

export { REDACTED, looksSecret, redactArgv, redactEnv, redactValue } from "./redact.ts";

export {
  HERMES_BIN,
  HERMES_INSTALL_DIR,
  HERMES_REPO,
  SECRETS_ENV_DIR,
  SECRETS_ENV_PATH,
  apply,
  materialiseSecrets,
  parseDpkgQuery,
  resetAptIndexState,
  sha256,
} from "./apply/index.ts";
export type { ApplyOptions, ApplyResult } from "./apply/index.ts";

export {
  CHROME_MARKER_FILE,
  CHROME_ZIP_PATH,
  chromeMarkerPath,
  ensureChromeBuild,
} from "./browser-source.ts";
export type { ChromeBuild, ChromeBuildOptions } from "./browser-source.ts";

export {
  CDP_TIMEOUT_MS,
  browserUnit,
  cdpVersionUrl,
  probeBrowsers,
  reportBrowsers,
} from "./browser-health.ts";

export { tailscaleIpv4, tailscaleSelf } from "./tailscale.ts";
export type { TailscaleSelf } from "./tailscale.ts";

export {
  DATA_MOUNT,
  DEVICE_POLL_MS,
  DEVICE_WAIT_MS,
  isBlank,
  mountDataVolume,
  pickDataDevice,
  sizeToBytes,
  waitForDataDevice,
} from "./disk.ts";

export {
  ACK_ATTEMPTS,
  COMMAND_POLL_MS,
  FACTS_DIR,
  INSTALL_TMP_PREFIX,
  GIVE_UP_MS,
  HERMETICD_PATH,
  MARKER_DIR,
  PROGRESS_THROTTLE_MS,
  STAGES_DIR,
  STAGE_LOG_DIR,
  factsPath,
  installStages,
  markerPath,
  parseFacts,
  parseProgress,
  releaseStages,
  reportBootFailure,
  resumeStages,
  runStages,
  sha256Hex,
  stageEnv,
  stageIdOf,
  stageLogPath,
} from "./stages.ts";
export type { Stage, StagesDeps, StagesOutcome } from "./stages.ts";

export {
  BOOTSTRAP_UNIT,
  BOOTSTRAP_UNIT_PATH,
  bootstrap,
  bootstrapUnitBody,
  installBootstrapUnit,
} from "./bootstrap.ts";
export type { BootstrapDeps } from "./bootstrap.ts";

export {
  DASHBOARD_TIMEOUT_MS,
  DEGRADE_AFTER_TICKS,
  DISK_FULL_PCT,
  HEARTBEAT_INTERVAL_MS,
  RECOVER_AFTER_TICKS,
  HERMES_HEALTH_URL,
  cpuPercent,
  dashboardUrl,
  diskPercent,
  makeHeartbeat,
  parseMeminfo,
  parseProcStat,
} from "./heartbeat.ts";
export type { Heartbeat, HeartbeatDeps, HeartbeatTick } from "./heartbeat.ts";

export {
  NIGHTLY_UTC_HOUR,
  msUntilNightly,
  nightlyMinuteFor,
  stagesUpToDate,
  update,
} from "./update/index.ts";
export type { UpdateDeps, UpdateOptions, UpdateResult } from "./update/index.ts";

export { makeUpdateGate } from "./update-request.ts";
export type { UpdateGate, UpdateGateDeps } from "./update-request.ts";

export {
  HERMETICD_RPC_PORT,
  TAILSCALE_BIND_TIMEOUT_MS,
  makeRpcHandler,
  mapJournalLine,
  serveRpc,
  tailscaleWhois,
  waitForTailscaleAddress,
} from "./rpc.ts";
export type { RpcDeps, RpcHandler, Whois, WhoisResolver } from "./rpc.ts";

export {
  HERMETICD_VERSION,
  SECRET_SLOTS,
  UPDATE_POLL_MS,
  assertTmpfs,
  bootstrapUnitActive,
  bootstrapUnitBusy,
  fatalMessage,
  log,
  maybeUpdate,
  parseArgv,
  run,
  runUpdateLoop,
  stderrEmit,
  updateTick,
  writeSecretFile,
} from "./main.ts";
export type {
  Context,
  RunDeps,
  SecretSlot,
  UnitBusy,
  UpdateLoopDeps,
  UpdateTickOutcome,
} from "./main.ts";
