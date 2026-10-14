/**
 * `@hermetic/core/shared`: the pure values and pure functions two other
 * runtimes need verbatim — the browser (`packages/ui`) and the box
 * (`packages/agentd`) — without either being able to reach the rest of core.
 *
 * Everything here is browser-safe by construction and by test: no `node:*`, no
 * `bun:*`, no AWS client, no environment reads, nothing that opens a file or a
 * socket. `packages/core/test/shared-browser-safe.test.ts` walks every module
 * reachable from this one and fails on the first specifier that is not.
 *
 * Narrow on purpose. Each entry below is something a second package used to
 * restate by hand and pin with a mirror test (naming rules, fleet-target
 * equality, the root-disk bounds, the Tailscale console URLs, the provider
 * table), or a box-side constant hermeticd was reaching through the schema
 * door for. A new export needs the same justification: a value that two
 * packages must agree on, not a convenience.
 *
 * Named re-exports, never `export *`: the door is this list.
 */

// --- Naming (§6.1, §7.3) ------------------------------------------------
export {
  AGENT_NAME_RE,
  FLEET_KEY,
  agentDashboardUrl,
  agentDesktopClientUrl,
  agentDesktopUrl,
  agentHostname,
  agentHostnameMismatch,
  cloudName,
  isValidName,
  legacyCloudNames,
  staleDeviceNote,
  validateName,
} from "./naming.ts";

// --- Fleet identity ------------------------------------------------------
export { sameFleetTarget } from "./target.ts";
export type { FleetTarget } from "./target.ts";

// --- Inbox listening rule (§4.6) ------------------------------------------
export { INSTANCE_NOTIFICATION_SOURCES, hiddenByListening } from "./notifications.ts";

// --- Session origins (§9.2) ---------------------------------------------
export { SESSION_ORIGIN_NAMES } from "./session-origins.ts";
export type { SessionOriginName } from "./session-origins.ts";

// --- Background-process events in chat (§9.2) ----------------------------
export {
  PROCESS_COMMAND_MAX,
  isRoutineProcessEvent,
  processEventSentence,
  shortCommand,
} from "./process-event.ts";
export type { ProcessEventLike } from "./process-event.ts";

// --- Intentional silence (§9.2) ------------------------------------------
// Upstream's `NO_REPLY`/`[SILENT]` matcher: core keeps a silent reply out of
// the inbox, the UI draws it as a marker and holds back a streamed prefix.
export { SILENCE_TOKENS, isIntentionalSilence, isPartialSilenceMarker } from "./silence.ts";

// --- Hermes gateway internal signals (§9.2) ------------------------------
// Events Hermes Desktop consumes without drawing: core drops them before they
// become `unknown` blocks, the UI skips any already stored.
export { HERMES_INTERNAL_EVENTS, isHermesInternalEvent } from "./hermes-internal-events.ts";

// --- Bot handles and @-mentions (§9.2) -----------------------------------
// The composer's mention picker and core's `message_agent` target mapping
// must agree on which tag names which bot.
export { botAliasForms, botHandle, botMentionTag, resolveBotTarget } from "./bot-handles.ts";
export type { BotIdentity } from "./bot-handles.ts";

// --- Providers (§8.1) ----------------------------------------------------
export { PROVIDERS, PROVIDERS_LIST, PROVIDER_IDS, providerNeedsKey } from "./providers.ts";
export type { Provider, ProviderSpec } from "./providers.ts";

// --- Sizes and create presets (§7.1, §4.6) --------------------------------
export { SIZE_IDS, isSizeId } from "./sizes.ts";
export type { SizeId } from "./sizes.ts";
export {
  BUILTIN_DEFAULT_PRESET,
  BUILTIN_LOADOUT,
  BUILTIN_PRESETS,
  CREATE_PRESETS_PREF,
  LOADOUT_SLOTS,
  PRESET_ID_RE,
  PRESET_NAME_MAX,
  builtinPresetsDoc,
  findPreset,
  isBuiltinPresetId,
  normalizePresetsDoc,
  presetList,
  presetsView,
} from "./presets.ts";
export type {
  BuiltinPreset,
  CreatePresetsDoc,
  MachinePreset,
  PresetLane,
  PresetView,
  PresetsView,
} from "./presets.ts";

// --- Tailscale console (§4.7) --------------------------------------------
export {
  TAILSCALE_ADMIN_ACL_URL,
  TAILSCALE_ADMIN_DNS_URL,
  TAILSCALE_ADMIN_OAUTH_URL,
  TAILSCALE_DOWNLOAD_URL,
} from "./tailscale-urls.ts";

// --- The box: paths, units, ports hermeticd and the stages agree on -------
export {
  HERMES_ACCOUNT,
  HERMES_ACCOUNT_HOME,
  HERMES_BIN,
  HERMES_DASHBOARD_PORT,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  HERMES_HOME,
  HERMES_USER_PREFIX,
  HERMES_LAZY_TARGET,
  HERMES_AGENT_VENV,
  HERMES_INSTALL_DIR,
  HERMES_LEGACY_DASHBOARD_UNIT,
  HERMES_MANAGED_CONFIG,
  HERMES_MANAGED_DIR,
  HERMES_REVISION_ENV,
  HERMES_TUI_DIR,
  HERMES_USER_CONFIG,
  HERMES_USER_ENV,
  HERMES_WEB_DIST_DIR,
  hermesConfigGetArgv,
} from "./hermes.ts";
export {
  AGENT_CONFIG_SCHEMA_VERSION,
  APT_LOCK_TIMEOUT_SECONDS,
  DEFAULT_ROOT_GIB,
  ROOT_GIB_MAX,
  ROOT_GIB_MIN,
  USER_DATA_JSON_PATH,
  isProviderKeySlot,
  providerKeyRefOf,
} from "./box.ts";
export {
  FLEET_MANIFEST_KEY,
  autoUpdateHermeticd,
  isChromeRef,
  isReleaseObjectKey,
  orderStages,
} from "./release.ts";
export {
  BROWSER_CDP_ENV,
  CHROME_INSTALL_ROOT,
  browserCdpUrl,
  chromeBinaryPath,
  chromeInstallDir,
} from "./browser.ts";
export {
  HERMETICD_RPC_PORT,
  RPC_CONTENT_TYPE,
  RPC_PATHS,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
} from "./rpc.ts";

// --- Terminal shell integration (issue #18) --------------------------------
export {
  DETACHABLE_PROGRAMS,
  SHELL_INTEGRATION_SCRIPT,
  SHELL_MARKER_OSC,
  SSH_LOGIN_USER,
  parseShellMarker,
  sanitizeProgramName,
} from "./shell-markers.ts";
export type { ShellMarker } from "./shell-markers.ts";

// --- Files service (attachments, requests, shares) -----------------------
// The routes, ids, name rules, caps and sniffer hermeticd, core and the UI
// must agree on for every file that crosses between laptop and box.
export {
  CONTENT_DIGEST_HEADER,
  ENV_SECRET_SLOT_RE,
  FILES_CAPABILITY,
  FILES_DROP_DIR,
  FILES_ERROR_CODES,
  FILES_HTTP_STATUS,
  FILES_INBOX_DIR,
  FILES_INDEX_PATH,
  FILES_LIMITS,
  FILES_NAME_HEADER,
  FILES_NOT_SECRET_HEADER,
  FILES_OUTBOX_DIR,
  FILES_ROUTES,
  FILES_SECRET_DIR,
  FILES_SESSION_HEADER,
  FILES_SOCKET_PATH,
  FILES_SOCKET_ROUTES,
  FILES_STAGE_DIR,
  FILES_TTL,
  FILE_CLASSES,
  FILE_DIRS,
  FILE_REQUEST_KINDS,
  FILE_REQUEST_STATES,
  FILE_SECRET_SLOT_RE,
  FILE_SENSITIVITIES,
  SECRET_ENVELOPE_MAX_CHARS,
  acceptMatches,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
  envSecretSlot,
  fileSecretSlot,
  filesHttpStatus,
  formatContentDigest,
  inboxRelPath,
  isEnvSecretSlot,
  isFileId,
  isFileSecretSlot,
  isImageMime,
  isRequestId,
  isShareId,
  looksLikeKeyMaterial,
  matchFilesRoute,
  matchSocketRoute,
  newFileId,
  newRequestId,
  newShareId,
  parseContentDigest,
  sanitizeFileName,
  secretEnvelopeFits,
  secretSlotFileName,
  shortId,
  sniffMime,
} from "./files.ts";
export type {
  FileClass,
  FileDir,
  FileNameRejection,
  FileRequestKind,
  FileRequestState,
  FileSensitivity,
  FilesErrorCode,
  FilesRoute,
  FilesSocketRoute,
  SanitizedFileName,
  SecretEnvelope,
} from "./files.ts";
