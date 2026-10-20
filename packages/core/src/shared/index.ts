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

// --- Hermes slash commands (§9.2) ----------------------------------------
// Core's send path and the composer must agree with the gateway on which
// lines are commands and how they split, or a line meant for the command
// layer reaches the model as a prompt.
export {
  DISPATCH_TYPES,
  SLASH_COMMAND_RE,
  isCompactCommand,
  isNewSessionCommand,
  looksLikeSlashCommand,
  parseCommandDispatch,
  parseSlashCommand,
} from "./slash.ts";
export type {
  AliasCommandDispatch,
  CommandDispatch,
  DispatchType,
  ExecCommandDispatch,
  ParsedSlashCommand,
  PrefillCommandDispatch,
  SendCommandDispatch,
  SkillCommandDispatch,
} from "./slash.ts";

// --- Bot handles and @-mentions (§9.2) -----------------------------------
// The composer's mention picker and core's `message_agent` target mapping
// must agree on which tag names which bot.
export { botAliasForms, botHandle, botMentionTag, resolveBotTarget } from "./bot-handles.ts";
export type { BotIdentity } from "./bot-handles.ts";

// --- Providers (§8.1) ----------------------------------------------------
export { PROVIDERS, PROVIDERS_LIST, PROVIDER_IDS, providerNeedsKey } from "./providers.ts";
export type { Provider, ProviderSpec } from "./providers.ts";

// --- External memory providers --------------------------------------------
// The create drawer's picker, core's render and hermeticd's install step must
// agree on the ids, the pins, the unit name and the paths on the data volume.
export {
  HONCHO_APT_PACKAGES,
  HONCHO_DB_NAME,
  HONCHO_DB_SOCKET_DIR,
  HONCHO_PG_BIN,
  HONCHO_PG_MAJOR,
  HONCHO_PLUGIN_CONFIG_LINK,
  MEMORY_DB_UNIT,
  MEMORY_HONCHO_CAPABILITY,
  MEMORY_LLM_ENV_PATH,
  MEMORY_LLM_KEY_ENVS,
  MEMORY_NONE_SPEC,
  MEMORY_PRISM_CAPABILITY,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDERS_LIST,
  MEMORY_PROVIDER_CAPABILITY,
  MEMORY_PROVIDER_IDS,
  MEMORY_PROVIDER_NONE,
  MEMORY_RESOURCE_ESTIMATE_NOTE,
  MEMORY_RESOURCE_FACT_KEYS,
  MEMORY_SERVICES,
  MEMORY_SERVICE_CAPABILITY,
  MEMORY_SERVICE_CONF_DIR,
  MEMORY_SERVICE_ROOT,
  MEMORY_SERVICE_UNIT,
  MEMORY_SERVICE_UNITS,
  MEMORY_WORKER_UNIT,
  PROVIDER_EMBEDDING_DIMENSION,
  PROVIDER_EMBEDDING_MODEL,
  PROVIDER_EMBEDDING_VENDORS,
  PRISM_DATA_DIR,
  PRISM_EMBEDDING_MODEL,
  PRISM_FASTEMBED_DIR,
  PRISM_PORT,
  PRISM_TIKTOKEN_DIR,
  hermesMemoryProviderName,
  hermesPluginDir,
  honchoClientConfPath,
  honchoEnvPath,
  honchoPgDataDir,
  honchoSrcDir,
  honchoTiktokenDir,
  isMemoryProvider,
  memoryProviderIsService,
  memoryResourceFacts,
  memoryServiceDir,
  OPENVIKING_DATA_DIRS,
  openvikingConfPath,
  openvikingDataDir,
  memoryServiceOf,
  providerEmbeddingModel,
} from "./memory-providers.ts";
export type {
  MemoryLlmKeyEnv,
  MemoryProvider,
  MemoryProviderSpec,
  MemoryResourceFact,
  MemoryResourceFactKey,
  MemoryResources,
  MemoryServiceId,
  MemoryServicePlugin,
  MemoryServiceSource,
  MemoryServiceSpec,
} from "./memory-providers.ts";

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

// --- Data-volume snapshot policy (§7.1) -----------------------------------
export {
  DEFAULT_SNAPSHOT_POLICY,
  SNAPSHOT_INTERVAL_HOURS,
  SNAPSHOT_RETAIN_MAX,
  SNAPSHOT_RETAIN_MIN,
  describeSnapshotPolicy,
  sameSnapshotPolicy,
  snapshotWindowDays,
} from "./snapshots.ts";
export type { SnapshotIntervalHours, SnapshotPolicy } from "./snapshots.ts";

// --- AWS Free Tier baseline (§10) ----------------------------------------
export { AWS_FREE_TIER, FREE_TIER_PRESET_ID, isFreeTierMachine } from "./free-tier.ts";
export type {
  FreeTierBaseline,
  FreeTierPlan,
  FreeTierResource,
  FreeTierTreatment,
} from "./free-tier.ts";

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
  HERMES_PROFILES_DIR,
  HERMES_WEB_DIST_DIR,
  MANAGED_ENV_BEGIN,
  MANAGED_ENV_END,
  hermesConfigGetArgv,
} from "./hermes.ts";
export { hermesConfigLeaves, hermesOwnedDrift } from "./hermes-owned.ts";
export type { OwnedKeyDrift } from "./hermes-owned.ts";
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
  PUSH_DEVICE_ROUTE_PREFIX,
  RPC_CONTENT_TYPE,
  RPC_PATHS,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
  pushDevicePath,
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

// --- Avatars (§9.2, §9.4) ---------------------------------------------------
// The desktop and the phone draw a bot's face from the same seed and the same
// geometry; the pairing link carries the viewer's style choice across.
export { AVATAR_STYLES, DEFAULT_AVATAR_STYLE, isAvatarStyle } from "./avatar/style.ts";
export type { AvatarStyle } from "./avatar/style.ts";
// The seed and palette, then each style's geometry and still frames. Both
// heads draw from these; only the drawing (DOM or react-native-svg) is theirs.
export {
  RESERVED_HUE,
  avatarMotion,
  avatarPalette,
  avatarSeed,
  avatarSeeds,
  rngFor,
} from "./avatar/seed.ts";
export type {
  AvatarActivity,
  AvatarMotion,
  AvatarPalette,
  AvatarStatus,
  Rng,
} from "./avatar/seed.ts";
export { BLOB_VIEWBOX, blobFrame, blobPath, blobShape } from "./avatar/blob.ts";
export type { BlobFrame, BlobPoint, BlobShape } from "./avatar/blob.ts";
export {
  SIGIL_HOME,
  SIGIL_N,
  SIGIL_VIEWBOX,
  sigilCells,
  sigilFrame,
  transformFor,
} from "./avatar/sigil.ts";
export type { SigilCell, SigilFrame } from "./avatar/sigil.ts";
export {
  PIXEL_STILL,
  PIXEL_STOPPED,
  PIXEL_VIEWBOX,
  pixelFrame,
  pixelParts,
} from "./avatar/pixel.ts";
export type { PixelFrame, PixelParts, PixelRect } from "./avatar/pixel.ts";

// --- QR codes (the mobile pairing link) -------------------------------------
export { encodeQr, qrToSvg, qrToTerminal } from "./qr.ts";
export type { QrMatrix } from "./qr.ts";

// --- The phone's pairing link (no secret; the phone parses the same code) ---
export {
  MOBILE_LINK_ACCEPTED_VERSIONS,
  MOBILE_LINK_MAX_AGENTS,
  MOBILE_LINK_MAX_LENGTH,
  MOBILE_LINK_PREFIX,
  MOBILE_LINK_PREF_KEYS,
  MOBILE_LINK_VERSION,
  encodeMobileLink,
  parseMobileLink,
} from "./mobile-link.ts";
export type {
  MobileLinkAgentEntry,
  MobileLinkInput,
  MobileLinkPayload,
  MobileLinkPrefs,
} from "./mobile-link.ts";

// --- SHA-256 (chat message ids) ---------------------------------------------
// The chat adapter's transcript row ids are a SHA-256 prefix, and the adapter
// runs on the phone and the box as well as the laptop, so the hash cannot be
// `node:crypto`. Pinned byte-equal to it in `test/sha256.test.ts`.
export { createSha256, type Sha256, sha256Hex } from "./sha256.ts";

// --- Expo push (hermeticd's gateway watcher, §9.4) -------------------------
// The box sends; the payload shapes, batching and the ticket/receipt parse are
// plain values a second runtime may need verbatim, and nothing here opens a
// socket of its own — the caller hands in `fetch`.
export {
  EXPO_DEVICE_NOT_REGISTERED,
  EXPO_PUSH_BATCH,
  EXPO_PUSH_TIMEOUT_MS,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_BATCH,
  EXPO_RECEIPTS_URL,
  chunk,
  expoPushSender,
  expoReceiptFetcher,
  isDeviceNotRegistered,
  receiptOf,
} from "./expo-push.ts";
export type {
  ExpoFetch,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushSender,
  ExpoPushTicket,
  ExpoReceiptFetcher,
} from "./expo-push.ts";
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
  FILES_APP_CAP,
  FILES_RETENTION_DAYS,
  FILES_SECRET_AS_HEADER,
  MEDIA_TAG,
  SECRET_ENVELOPE_MAX_CHARS,
  SECRET_TEXT_AS,
  SECRET_TEXT_FORMATS,
  SECRET_TEXT_INPUTS,
  SECRET_TEXT_KEY_RE,
  SECRET_TEXT_MAX_KEYS,
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
  outboxRelPath,
  parseContentDigest,
  parseOutboxMediaLine,
  requestFileName,
  sanitizeFileName,
  secretEnvelopeFits,
  secretSlotFileName,
  secretTextLoad,
  secretTextSlug,
  shortId,
  resolveFilesSettings,
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
  FilesSettings,
  FilesSettingsSource,
  FilesSocketRoute,
  OutboxMediaRef,
  SanitizedFileName,
  SecretEnvelope,
  SecretTextAs,
  SecretTextFormat,
  SecretTextInput,
} from "./files.ts";

// --- Text secrets (plan §06b) ----------------------------------------------
// The paste/drop parser the request card previews with and the box re-reads
// the canonical form with; both must accept and refuse the same text.
export {
  SECRET_ENV_ERROR_CODES,
  SECRET_ENV_WARNING_CODES,
  SECRET_KEY_RE,
  SECRET_TEXT_MAX_BYTES,
  canonicalSecretEnv,
  detectSecretFormat,
  parseSecretEnv,
  readCanonicalSecretEnv,
} from "./secret-env.ts";
export type {
  SecretEnvChip,
  SecretEnvEntry,
  SecretEnvErrorCode,
  SecretEnvIssue,
  SecretEnvResult,
  SecretEnvSpec,
  SecretEnvWarningCode,
  SecretFormat,
  SecretInputMode,
} from "./secret-env.ts";

// --- Developer tools (§9.2) ----------------------------------------------
// The stream inspector's Diff view: which wire fields the adapter keeps,
// renames, drops or makes up, pinned against the mappers by a core test.
export { DEVTOOLS_FIELD_MAP, devtoolsFieldMap } from "./devtools-field-map.ts";
export type {
  DevtoolsEventMap,
  DevtoolsFieldFate,
  DevtoolsFieldRule,
} from "./devtools-field-map.ts";
