/**
 * The desktop head as a library.
 *
 * `packages/ui` reads the bridge contract from here as types only — the
 * boundary matrix allows the UI no value from this package — and
 * `tests/parity.test.ts` reads what the handlers declared about themselves.
 *
 * `src/main/index.ts` is deliberately not re-exported: it is the one module
 * allowed to import `electrobun/bun`, which only means something inside a
 * built app.
 */
export {
  RPC_DECLARATIONS,
  MACHINERY_RPC,
  HANDLER_NAMES,
  unhandledMethods,
  type RpcDeclaration,
} from "./rpc/registry.ts";
export {
  OpRegistry,
  MAX_BUFFERED_EVENTS,
  type Accepted,
  type OpSummary,
  type OpMessage,
  type OpStatus,
  type OpStartOptions,
} from "./ops.ts";
export { FleetPoller, getPoller, POLL_INTERVAL_MS, type FleetEvent } from "./poller.ts";
export { INTERNAL_MESSAGE, type ErrorBody, type Failure } from "./errors.ts";
export { RequestValidationError } from "./validation.ts";
/**
 * The desktop bridge's contract. `packages/ui` reads it as types
 * only — the boundary matrix allows the UI no value from this package — so the
 * page and the main process describe the same requests and the same pushes
 * from one declaration.
 */
export {
  MACHINERY_REQUEST_NAMES,
  MESSAGE_FOR_REQUEST,
  REQUEST_NAMES,
  type BunMessages,
  type BunRequests,
  type HermeticRPC,
  type RequestName as RpcRequestName,
  type StreamMessageName,
  type StreamingRequestName,
  type WebviewMessageName,
  type WebviewMessages,
} from "./rpc/schema.ts";
export { AppState, openState, type InitSessionLike } from "./state.ts";
export { installShutdown, shutdown, SIGNAL_EXIT_CODES, type ShutdownTarget } from "./shutdown.ts";
/** §9.2: the observations this head holds, and their fan-in envelope. */
export {
  createChatOwner,
  type ChatConversationRef,
  type ChatOwner,
  type ChatResumeResult,
  type OwnedChatEvent,
} from "./chat-owner.ts";
export { CHAT_STREAM_MAX_QUEUED, type ChatStreamFrame } from "./chat-stream.ts";
export { NOT_INITIALIZED_HEADER } from "./init-op.ts";
export { ALREADY_INITIALIZED, IdentityRequest } from "./handlers/init.ts";
