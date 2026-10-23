/**
 * The chat wire types (§9.2).
 *
 * These are *hermetic's* shapes, not Hermes's. Exactly one module —
 * `../hermes-chat.ts` — knows what the box actually answers with, and it maps
 * that onto the types below. Everything above the adapter, in both heads, sees
 * only this file. That boundary is the decision that makes §4's transport
 * choice survivable: if upstream moves a route on a `hermes_ref` bump, or if
 * the transport itself is replaced, one module changes and no renderer does.
 *
 * The addressing is four levels deep and the depth is load-bearing (§9.2):
 *
 *     fleet → instance (a box, and therefore one gateway)
 *           → swarm    (that box's roster of bots)
 *           → bot      (a Hermes profile; `default` is the instance's own)
 *           → session  (a conversation, and it carries an origin)
 *
 * The first draft had one conversation per agent. That is an *addressing*
 * mistake, and addressing is what every other surface keys off, so it is the
 * expensive kind to fix late.
 */
import { z } from "zod";
import { Iso } from "./common.ts";
import { FileRequestId, ShareFileResult } from "./files.ts";
import { SESSION_ORIGIN_NAMES } from "../shared/session-origins.ts";
import { DISPATCH_TYPES } from "../shared/slash.ts";

export {
  PROCESS_COMMAND_MAX,
  isRoutineProcessEvent,
  processEventSentence,
  shortCommand,
} from "../shared/process-event.ts";
export type { ProcessEventLike } from "../shared/process-event.ts";
export { botAliasForms, botHandle, botMentionTag, resolveBotTarget } from "../shared/bot-handles.ts";
export type { BotIdentity } from "../shared/bot-handles.ts";
export { SILENCE_TOKENS, isIntentionalSilence, isPartialSilenceMarker } from "../shared/silence.ts";
export { HERMES_INTERNAL_EVENTS, isHermesInternalEvent } from "../shared/hermes-internal-events.ts";
export {
  DISPATCH_TYPES,
  SLASH_COMMAND_RE,
  looksLikeSlashCommand,
  parseCommandDispatch,
  parseSlashCommand,
} from "../shared/slash.ts";
export type {
  AliasCommandDispatch,
  CommandDispatch,
  DispatchType,
  ExecCommandDispatch,
  ParsedSlashCommand,
  PrefillCommandDispatch,
  SendCommandDispatch,
  SkillCommandDispatch,
} from "../shared/slash.ts";

/* ── addressing ───────────────────────────────────────────────────────────── */

/**
 * A bot, named absolutely. Rooms and peer-driven turns carry one on every
 * message, because in those the author is not the session's own bot.
 */
export const BotRef = z.object({
  /** The agent name — an instance is an agent box (§9.2). */
  instance: z.string().min(1),
  /** The Hermes profile name. `default` is the profile that *is* `$HERMES_HOME`. */
  bot: z.string().min(1),
});
export type BotRef = z.infer<typeof BotRef>;

/**
 * Where a session came from, which is not always here.
 *
 * The portal did not start most of the sessions it shows. A box runs messaging
 * channels, cron jobs, a dashboard and a CLI; Hermes Desktop can attach to it;
 * other bots drive turns on it. So the origin travels with the session, and the
 * composer says what sending does wherever that has a consequence.
 *
 * This is a safety field, not a decoration: a reply into a `channel` session
 * leaves the tailnet and lands in somebody's Slack, and a reply into a `peer`
 * session is answering a robot. Neither is what the operator assumed when they
 * hit Enter in a box that looks like every other box.
 *
 * The values themselves live in `shared/session-origins.ts`, where the UI can
 * read them too.
 */
export const SessionOrigin = z.enum(SESSION_ORIGIN_NAMES);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const SESSION_ORIGINS = SessionOrigin.options;

/**
 * Origins whose destination is not this portal: every value but `portal`, which
 * only this laptop's own record of sending into a session may grant.
 */
export const FOREIGN_ORIGINS: readonly SessionOrigin[] = SESSION_ORIGINS.filter((o) => o !== "portal");

export const SessionKind = z.enum(["canonical", "thread", "routine"]);
export type SessionKind = z.infer<typeof SessionKind>;

/** Who wrote a message. Declared here because the roster quotes one (`Bot.preview_role`). */
export const ChatRole = z.enum(["user", "bot", "system"]);
export type ChatRole = z.infer<typeof ChatRole>;

/* ── the roster ───────────────────────────────────────────────────────────── */

export const Bot = z.object({
  instance: z.string().min(1),
  name: z.string().min(1),
  /** The display name, which is *not* what seeds the avatar — see `avatar_seed`. */
  title: z.string().min(1),
  description: z.string().nullish(),
  /** One per instance, always. The profile that is `$HERMES_HOME` itself. */
  is_default: z.boolean(),
  model: z.string().nullish(),
  /** The operator's own grouping inside a bucket ("Clients", "Team"). */
  section: z.string().nullish(),
  /**
   * Seeded from `fleet_id/instance/bot` and never from the display name, so
   * renaming a bot does not change its face (§9.2). Core computes it; no head
   * derives its own.
   */
  avatar_seed: z.string().min(1),
  last_message_at: Iso.nullish(),
  /**
   * The session `last_message_at` was read off, when the box named one.
   *
   * It travels with the timestamp because the two are only meaningful
   * together: a turn this laptop drove has to decide whether the coordinate it
   * sees is *its own* reply or somebody else's message that landed while it
   * ran, and the session id is the only thing that can answer that. Deriving
   * it a second way — matching the coordinate against a `chat.sessions` read —
   * looks equivalent and is not: the roster maps it from the profile row's
   * `last_active` and the session list maps it from `started_at`, so the two
   * stamps describe the same conversation with different numbers and never
   * compare equal on a real box.
   *
   * Nullable: a Hermes too old to send a session summary gives a watermark
   * with nothing to attribute it to, and a turn that cannot attribute declines
   * to advance (`chat.ts`'s `boxCoordinate`).
   */
  last_message_session: z.string().nullish(),
  /**
   * The opening words of the most recent message, as the box reports them.
   *
   * The rail wants a preview under every name, and the first build of it used
   * the bot's `description` because `Bot` carried no such field and faking one
   * meant a history read per bot per repaint — which §9.2 rules out, because
   * reads are what make an all-instances feed affordable and a read that takes
   * a warm slot is not a read this design can do thirteen times.
   *
   * It turned out not to need one: the roster read already returns it, on the
   * profile row. Nullable because an older Hermes does not send it, and because
   * a bot nobody has spoken to has nothing to preview.
   */
  preview: z.string().nullish(),
  /**
   * Who wrote the message `preview` quotes, when that is known.
   *
   * The rail reads a bare silence marker (`NO_REPLY`) as the bot staying
   * silent, which is only true of a `bot` row: the operator typing "No reply"
   * is the operator's words. Upstream's preview carries no role
   * (`tui_gateway/methods_profiles.py` `_latest_message_preview` selects the
   * newest `user`/`assistant` row's `content` alone, v2026.9.24), so it is set
   * only where hermetic itself knows the row: a preview it rewrote from a
   * background-process notice (`system`, as history lifts it) or another bot's
   * delivery (`user`) — `eventPreviewOf` — or one built from a transcript row.
   * Null is "not known", never "the operator".
   */
  preview_role: ChatRole.nullish(),
  unread: z.number().int().nonnegative(),
  needs_action: z.boolean(),
  muted: z.boolean(),
  /** Holding one of the box's ~3 warm backend slots right now. */
  warm: z.boolean(),
});
export type Bot = z.infer<typeof Bot>;

/**
 * A room, which is **within one instance** and cannot span boxes (§9.2).
 *
 * Upstream supports members on different machines, but only because Hermes
 * Desktop holds a persistent connection to each registered gateway and couriers
 * between them. hermetic has no Desktop and no equivalent, so a cross-box room
 * is not deferred work — it is work that needs a component this project has
 * decided not to build. The consolation is real: a single-instance room runs in
 * upstream's driver mode, so it keeps going with the portal closed.
 */
export const Room = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instance: z.string().min(1),
  members: z.array(BotRef),
  /** Round-robin position, when the room is mid-round. */
  round: z.object({ n: z.number().int(), of: z.number().int() }).nullish(),
  needs_action: z.boolean(),
});
export type Room = z.infer<typeof Room>;

/**
 * One instance's roster.
 *
 * `warm_slots` is in the schema rather than the renderer because of the shape
 * of upstream's limit: ~3 backends warm per gateway, idle ones reaped after 10
 * minutes, and an open that **fails after 30 seconds** of waiting for a slot.
 * On a laptop that is a pause. On thirteen unattended boxes it is a dead click,
 * so the queue has to be visible from the first second rather than the
 * thirtieth (§9.2).
 */
export const Swarm = z.object({
  instance: z.string().min(1),
  reachable: z.boolean(),
  /** Why not, when `reachable` is false: off the tailnet, box stopped, no Hermes. */
  unreachable_reason: z.string().nullish(),
  bots: z.array(Bot),
  rooms: z.array(Room),
  warm_slots: z.object({
    used: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable(),
  }),
  /** The operator's section names, in the order the rail should show them. */
  sections: z.array(z.string()),
});
export type Swarm = z.infer<typeof Swarm>;

export const Session = z.object({
  id: z.string().min(1),
  instance: z.string().min(1),
  bot: z.string().min(1),
  kind: SessionKind,
  origin: SessionOrigin,
  /** `#acme-support`, `granite@atlas` — what the origin was, concretely. */
  origin_detail: z.string().nullish(),
  title: z.string().min(1),
  /** The opening words of the session's most recent message, when the box sends them. */
  preview: z.string().nullish(),
  last_message_at: Iso.nullish(),
  unread: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof Session>;

/** Durable registry identity survives compaction; session names its current tip. */
export const ChatConversation = z.object({
  instance: z.string().min(1),
  bot: z.string().min(1),
  root_session: z.string().min(1),
  session: z.string().min(1),
  kind: SessionKind,
  created: z.boolean(),
});
export type ChatConversation = z.infer<typeof ChatConversation>;

/* ── blocks ───────────────────────────────────────────────────────────────── */

/**
 * A rendering *hint*, not a type. The adapter sets it from the tool name; a
 * head that does not recognise one falls back to the raw payload. New
 * renderers can therefore be added without a schema change, and an upstream
 * tool this file has never heard of still renders as something.
 *
 * `message_agent` is Bot Mode's bot-to-bot DM (`tools/bot_mode_dm.py`): a head
 * draws it as a "Messaged <bot>" marker rather than a tool step, and falls back
 * to the tool row when its arguments are not the `{target, message}` it knows.
 *
 * `file_request` (`request_file`, `await_file`) and `secret_request`
 * (`request_secret`) are the files plugin asking the operator for something. A
 * head draws a request card from hermeticd's copy of the slot named by the
 * block's `request_id` — never from the tool's arguments, which are the
 * model's words — and falls back to the tool row while that id is unknown.
 *
 * `file_share` (`share_file`) is the agent handing the operator a file through
 * the box's outbox. A head draws a file card from the block's `share` — the
 * plugin's result, validated — never from the tool's arguments, and falls back
 * to the tool row when `share` is null (a refusal, or a result it cannot read).
 *
 * `kanban_task` (`kanban_create`) is the agent filing a card on the box's
 * kanban board. A head draws a task card keyed on the result's `task_id` (the
 * result as upstream returned it: an object, or the string when it did not
 * parse as JSON) and falls back to the tool row while there is no id.
 */
export const ToolRender = z.enum([
  "diff",
  "terminal",
  "table",
  "image",
  "screenshot",
  "message_agent",
  "file_request",
  "secret_request",
  "file_share",
  "kanban_task",
]);
export type ToolRender = z.infer<typeof ToolRender>;

export const ToolStatus = z.enum(["running", "ok", "warn", "bad"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/**
 * The `state` inside an adapter-minted `chat.status` activity block.
 *
 * `connecting` is local: the socket is being dialled and nothing has been
 * asked yet. The other four are upstream's own `prompt.submit` reply verbatim
 * — the gateway answers `{"status":"streaming"}` when it took the prompt
 * (`tui_gateway/methods_prompt.py`), and `queued` / `redirected` / `steered`
 * when the session was mid-turn and `display.busy_input_mode` decided what to
 * do with the interruption (`tui_gateway/session_auto_continue.py`). Only
 * `streaming` is renamed, to `submitted`, because "streaming" up here would
 * claim content had started when nothing has arrived yet.
 *
 * A reply with no status, or one this build has never heard of, reads as
 * `submitted`: the box accepted the request, and guessing at a busy-mode that
 * did not exist when this was written would be worse than under-claiming.
 */
export const ChatStatusState = z.enum(["connecting", "submitted", "queued", "redirected", "steered"]);
export type ChatStatusState = z.infer<typeof ChatStatusState>;

/** Which hermetic surface a `hermetic` block points at. */
export const HermeticCard = z.enum(["agent", "op", "plan", "fleet"]);
export type HermeticCard = z.infer<typeof HermeticCard>;

const TextBlock = z.object({ kind: z.literal("text"), markdown: z.string() });

/**
 * Why the gateway withdrew a server request (`request.cancel {id, method,
 * reason}`, `tui_gateway/contracts/server_requests.py` `RequestCancelReason`),
 * in upstream's own spelling: `timeout` (the request's own wait ran out),
 * `interrupted` (the turn was stopped), `shutdown` (the gateway is exiting),
 * `resolved` (a choice was committed — by this laptop or another surface;
 * upstream does not say which), `session_closed` (the wait was withdrawn with
 * no answer). Anything else reads as `other`.
 */
export const RequestCloseReason = z.enum([
  "timeout",
  "interrupted",
  "shutdown",
  "resolved",
  "session_closed",
  "other",
]);
export type RequestCloseReason = z.infer<typeof RequestCloseReason>;

/**
 * One item of Hermes's task list (`tools/todo_tool.py`), statuses mapped onto
 * `ProcessTaskStatus`'s words so `todoSummary` reads both. `parent` names an
 * earlier item's id, or is null.
 */
export const TodoItem = z.object({
  id: z.string(),
  content: z.string().max(4000),
  status: z.enum(["done", "active", "pending", "cancelled"]),
  parent: z.string().nullish(),
});
export type TodoItem = z.infer<typeof TodoItem>;

/** A whole task list as of `revision` (monotonic per session; null when upstream gave none). */
export const TodoSnapshot = z.object({
  todos: z.array(TodoItem).max(256),
  revision: z.number().int().nonnegative().nullable(),
});
export type TodoSnapshot = z.infer<typeof TodoSnapshot>;

/** A replaceable progress snapshot, distinct from transcript prose and final usage. */
const ActivityBlock = z.object({
  kind: z.literal("activity"),
  category: z.enum(["connection", "queue", "history", "generation", "notice", "usage"]),
  key: z.string().min(1),
  title: z.string(),
  detail: z.string().nullish(),
  state: z.enum(["running", "done", "warning", "error"]),
  request_id: z.string().nullish(),
  /**
   * Tells a head whether this block is a replaceable "what is happening
   * now" snapshot (`status`) or something the turn did, that belongs in the
   * step list (`work`). Nullish for older stored payloads minted before
   * this field existed; a head falls back to its own category/key guess.
   */
  role: z.enum(["status", "work"]).nullish(),
  /**
   * Set only on the "Request closed" notice a `request.cancel` becomes (key
   * `request:<id>`): why the gateway withdrew the request. A dedicated field
   * rather than `detail`, because `detail` is copy a head may print and this is
   * a value a head branches on ("Timed out" vs "Cancelled"). Null everywhere
   * else, and on a notice minted before this field existed.
   */
  reason: RequestCloseReason.nullish(),
  /** The task list, on the `todo.updated` notice and the resume seed (key `tasks`). */
  todos: TodoSnapshot.nullish(),
  /** Retained for inspection and redacted by the same boundary as every other block. */
  payload: z.unknown().optional(),
});

const ReasoningBlock = z.object({
  kind: z.literal("reasoning"),
  text: z.string(),
  duration_ms: z.number().int().nonnegative().nullish(),
  tokens: z.number().int().nonnegative().nullish(),
});

const ToolBlock = z.object({
  kind: z.literal("tool"),
  /**
   * Upstream's own id for this call, when it gave one.
   *
   * A running tool and its completion arrive as two separate blocks, and there
   * is no frame type that *updates* one — so a head has to recognise the second
   * as the first one finishing. Without an id the only key available is the
   * tool's name, which is wrong the moment an agent makes two parallel calls to
   * the same tool: the first result supersedes both cards, and the second never
   * lands. Nullable because upstream does not promise it on every frame; a head
   * falls back to the name when it is absent, and accepts that the parallel case
   * renders badly rather than not at all.
   */
  tool_id: z.string().nullish(),
  name: z.string().min(1),
  /** The MCP server it came from, when it came from one. */
  server: z.string().nullish(),
  args: z.unknown(),
  result: z.unknown().nullish(),
  status: ToolStatus,
  exit_code: z.number().int().nullish(),
  duration_ms: z.number().int().nonnegative().nullish(),
  render: ToolRender.nullish(),
  /**
   * The files request slot (`fr_…`) a `file_request`/`secret_request` block is
   * about, and the only thing core takes from such a call. Read from
   * `await_file`'s arguments, from the plugin's result, or — for a request
   * opened inside the running tool — looked up from the box's slot list and
   * sent again on the same `tool_id` (`hermes-chat-file-requests.ts`). Null
   * while unknown; a head then shows the card as waiting for the box.
   */
  request_id: FileRequestId.nullish(),
  /**
   * What a `file_share` block shared: the plugin's result (`POST /outbox`'s
   * answer), set only when it parses as a `ShareFileResult`. Never read from
   * the tool's arguments, which are the model's words. Null on a running call,
   * a refusal, or a result this build cannot read; a head then draws the tool
   * row. The bytes are fetched by `share_id` through `files.content`.
   */
  share: ShareFileResult.nullish(),
  /** The list a completed `todo_list`/`todo` call left, when its result parses. */
  todos: TodoSnapshot.nullish(),
});

/**
 * A file in a message: one the operator attached to a turn, or one the agent
 * produced.
 *
 * `file_id` is set when the file is an entry in the box's files service
 * (`f_…`, read from its inbox path). `href` is then the entry's path relative
 * to `$HERMES_HOME` (`inbox/<date>/<f_id>/<name>`), *not* a URL: a head
 * fetches the bytes through `files.content` by id and must never load `href`.
 * Without a `file_id`, `href` is whatever the box named — a path or a URL —
 * and a head treats it as untrusted.
 *
 * `bytes` is `0` when the transcript did not say (an `@image:` line from
 * another client), and approximate when it came from the human size in the
 * turn's attachment block. `sha256` is the full digest when core knew it, and
 * the 12-hex prefix the attachment block carries when it was read back from
 * history.
 */
const AttachmentBlock = z.object({
  kind: z.literal("attachment"),
  name: z.string().min(1),
  mime: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  href: z.string().min(1),
  file_id: z.string().nullish(),
  sha256: z.string().nullish(),
});
export type AttachmentBlock = z.infer<typeof AttachmentBlock>;

/** The answers an approval can take, in the gateway's order (`server.py` `_approval_request_payload`). */
export const ApprovalChoice = z.enum(["once", "session", "always", "deny"]);
export type ApprovalChoice = z.infer<typeof ApprovalChoice>;

/**
 * A command waiting on the operator's approval.
 *
 * `choices` is what the gateway offered, in its order, and is the only guard
 * there is: upstream accepts any choice it is sent (non-`deny` = grant), so a
 * head renders exactly these and nothing else. Core always fills it — from the
 * request's own `choices` when present (unknown values dropped), else by the
 * gateway's fill rule. The default only covers a block stored before the field
 * existed, and is the narrowest answer set: a block that never said it offered
 * `session`/`always` is never shown them.
 */
const ApprovalBlock = z.object({
  kind: z.literal("approval"),
  tool: z.string().min(1),
  summary: z.string(),
  detail: z.string().nullish(),
  expires_at: Iso.nullish(),
  request_id: z.string().nullish(),
  choices: z.array(ApprovalChoice).default(["once", "deny"]),
  /** The command was flagged by the smart approver; only a one-shot answer is offered. */
  smart_denied: z.boolean().optional(),
  /**
   * The pattern an "always" answer would persist (the request's
   * `description`), for the confirm step that names it.
   */
  pattern: z.string().optional(),
  payload: z.unknown().optional(),
});

/**
 * One question of a batch clarify, as the gateway sends it: `id` is the
 * gateway's `qid` (the key an answer is locked under), `answer` is the lock
 * already recorded for it when the request was replayed from `open_requests`.
 */
const QuestionEntry = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  choices: z.array(z.string()),
  multi_select: z.boolean(),
  answer: z.string().nullable(),
});

/**
 * A clarify request is one block however many questions it carries. A batch
 * lists every question in `questions` (in the gateway's order) and mirrors the
 * first one into `prompt`/`choices` so a renderer that predates batches still
 * shows something; a single question leaves `questions` absent.
 */
const QuestionBlock = z.object({
  kind: z.literal("question"),
  prompt: z.string(),
  choices: z.array(z.string()),
  multi_select: z.boolean().optional(),
  questions: z.array(QuestionEntry).optional(),
  request_id: z.string().nullish(),
  expires_at: Iso.nullish(),
  payload: z.unknown().optional(),
});

const SourcesBlock = z.object({
  kind: z.literal("sources"),
  items: z.array(z.object({ title: z.string(), href: z.string(), snippet: z.string().nullish() })),
});

/**
 * A card that points at a hermetic surface, carrying a **ref and never data**.
 *
 * An `agent` card holds `{ agent: "ember" }` and the head reads the live fleet
 * stream for the rest. So the card is still correct three hours later, and it
 * is correct even when the model that produced it was wrong about the fleet.
 */
const HermeticBlock = z.object({
  kind: z.literal("hermetic"),
  card: HermeticCard,
  ref: z.string().min(1),
});

/**
 * The fallthrough, and **the contract** — not a failure mode.
 *
 * Upstream will emit tools this repo has never heard of, and it will do so on a
 * `hermes_ref` bump that changes nothing else. The adapter maps what it
 * recognises and drops everything else here, where a head renders it as name /
 * arguments / result / verdict. The rule this encodes: a version bump can never
 * blank a transcript.
 */
const UnknownBlock = z.object({
  kind: z.literal("unknown"),
  name: z.string().min(1),
  payload: z.unknown(),
});

/**
 * Which of Hermes' injected notices a `process_event` block was parsed from.
 *
 * Hermes wakes a bot by appending a `user`-role row to its session when a
 * background process finishes, a watch pattern matches, an async subagent
 * returns, the MCP servers reload (`tools/process_registry.py`
 * `format_process_notification`, `gateway/run.py`), or a cron job delivers its
 * output to Bot Chat (`cron/scheduler_delivery.py`). Role alternation rules out
 * a system row mid-loop, so the row is stored as the user's. None of them was
 * typed by the operator; `chat/hermes/process-notice.ts` recognises them.
 * Any other `[IMPORTANT: …]` row stays a plain user message.
 */
export const ProcessEventType = z.enum([
  "completion",
  "watch_match",
  "watch_disabled",
  "delegation",
  "mcp_reload",
  "cron",
  /** A webhook delivery mirrored into the session (`[Webhook delivery: <route>]`). */
  "webhook",
  /** A recurring heartbeat instruction firing (`hermes_cli/heartbeat.py`). */
  "heartbeat",
  /** A `/loop` wakeup (`hermes_cli/loops.py`). */
  "loop",
  /** A standing-goal continuation, or its failed quality gate (`hermes_cli/goals.py`). */
  "goal",
  /** The session was handed off from another client (`gateway/run_startup.py`). */
  "handoff",
  /** An interrupted turn resumed after a crash or a gateway restart. */
  "resume",
  /** One of the loop's fixed `[System: …]` continuation prompts (`agent/conversation_loop.py`). */
  "nudge",
  /** The tool-call iteration budget ran out (`agent/context_compressor.py`). */
  "iteration_limit",
  /** Earlier turns were compacted into a summary (`agent/context_compressor.py`). */
  "compaction",
  /** The active task list re-injected after compaction (`tools/todo_tool.py`). */
  "todo",
  /** The chat's model or provider changed (`tui_gateway/server.py`). */
  "model_switch",
  /** The personality overlay was set or cleared (`tui_gateway/agent_callbacks.py`). */
  "personality",
  /** A kanban card this chat subscribed to moved (`tui_gateway/session_notifications.py`). */
  "kanban",
]);
export type ProcessEventType = z.infer<typeof ProcessEventType>;

/**
 * The one classification every head colours and filters by, decided in core so
 * the thread, the rail, the CLI and the inbox cannot disagree: `ok` (exited 0,
 * every subagent succeeded), `failed` (non-zero exit, failed to start, lost, a
 * subagent that did not succeed), `terminated` (killed by Hermes or SIGTERM),
 * `info` (watch matches and one-line notices), `warn` (something the operator
 * should notice but that did not fail: a resumed turn, an oversized tool call,
 * the tool-call limit).
 */
export const ProcessOutcome = z.enum(["ok", "failed", "terminated", "info", "warn"]);
export type ProcessOutcome = z.infer<typeof ProcessOutcome>;

/**
 * Which fixed form of an injected notice upstream wrote, for the events that
 * have more than one. A head maps it to a fixed label; never free text.
 * `mirrored` is a cron or webhook delivery copied into a session it did not
 * start; `crash`/`gateway` say what interrupted a resumed turn.
 */
export const ProcessNoticeVariant = z.enum([
  "mirrored",
  "continuing",
  "gate_failed",
  "crash",
  "gateway",
  "output_limit",
  "network_cut",
  "tool_too_large",
  "reasoning_only",
  "continue_now",
  "fragment",
  "dropped_tool_call",
  "empty_tool_response",
  "set",
  "cleared",
]);
export type ProcessNoticeVariant = z.infer<typeof ProcessNoticeVariant>;

/** Which kanban event a `kanban` notice reports (`session_notifications.py` `_KANBAN_EVENT_FORMATTERS`). */
export const KanbanNoticeKind = z.enum([
  "completed",
  "blocked",
  "gave_up",
  "crashed",
  "timed_out",
  "status",
]);
export type KanbanNoticeKind = z.infer<typeof KanbanNoticeKind>;

/** Upstream's todo markers: `[x]` completed, `[>]` in_progress, `[ ]` pending, `[~]` cancelled, `[?]` anything else. */
export const ProcessTaskStatus = z.enum(["done", "active", "pending", "cancelled", "unknown"]);
export type ProcessTaskStatus = z.infer<typeof ProcessTaskStatus>;

const ProcessNoticeTask = z.object({
  status: ProcessTaskStatus,
  text: z.string(),
  /** The item's id as upstream printed it (`2.`), without the dot; null when absent. */
  id: z.string().nullish(),
  /** Nesting depth, from upstream's two-space indent per level. */
  depth: z.number().int().nonnegative(),
});

/**
 * The structured reading of an injected notice that is not a process or
 * delegation result (heartbeat, loop, goal, handoff, resume, nudge, compaction,
 * todo, model and personality switches, mirrored cron and webhook deliveries).
 * Every field is what the text states, or null.
 */
const ProcessNotice = z.object({
  variant: ProcessNoticeVariant.nullish(),
  /**
   * The one thing the notice is about: the heartbeat instruction, the loop
   * task, the goal, the handoff title, the re-sent prompt, the tool names of an
   * oversized call, the new model, the persona's first line.
   */
  subject: z.string().nullish(),
  /**
   * A short qualifier: the heartbeat interval (`30m`), the loop wakeup
   * (`#4 · every 5m`), the handoff source (`CLI`), what interrupted a resumed
   * turn (`gateway restart`), the model's provider.
   */
  detail: z.string().nullish(),
  /** The folded payload: the goal's injected prompt, a gate's output, a compaction summary, the full persona. */
  body: z.string().nullish(),
  /** A `todo` notice's items, in upstream's order. */
  tasks: z.array(ProcessNoticeTask).nullish(),
  /** A `kanban` notice's card (`t_…`). */
  task_id: z.string().nullish(),
  /** The board slug, when the notice named one (`[board]`). */
  board: z.string().nullish(),
  /** The card's assignee profile, when the notice named one (`@who`). */
  assignee: z.string().nullish(),
  /** What happened to the card; null when the wording is one this build does not know. */
  kanban_kind: KanbanNoticeKind.nullish(),
});

const ProcessDelegationTask = z.object({
  /** 1-based, as upstream prints it (`TASK 2/3`). */
  index: z.number().int().positive(),
  goal: z.string().nullish(),
  status: z.string(),
  ok: z.boolean(),
  summary: z.string().nullish(),
  duration_s: z.number().nonnegative().nullish(),
  api_calls: z.number().int().nonnegative().nullish(),
});

/**
 * A Hermes background-process notice, parsed out of the `user`-role row it was
 * injected as. The message carrying it has role `system` and this one block.
 *
 * Every field but `event`, `outcome` and `raw` is nullable: the notice is text
 * written for a model, and a field the parser could not read is left empty
 * rather than guessed. `raw` is the row's text verbatim, redacted by the same
 * boundary as every other block, so a head can always fall back to it.
 */
const ProcessEventBlock = z.object({
  kind: z.literal("process_event"),
  event: ProcessEventType,
  outcome: ProcessOutcome,
  /** Hermes' process session id (`proc_…`), matching the `terminal` tool call that started it. */
  process_id: z.string().nullish(),
  /** Upstream's status phrase verbatim: `completed normally`, `exited`, `terminated by Hermes`, … */
  status: z.string().nullish(),
  exit_code: z.number().int().nullish(),
  /** `SIGTERM` when upstream appended `, SIGTERM` to the exit code. */
  signal: z.string().nullish(),
  /** The full command line, unshortened. */
  command: z.string().nullish(),
  /** The output the notice carried (upstream already keeps only a tail), the matched lines of a watch match, or a cron job's output. */
  output_tail: z.string().nullish(),
  /** Lines in `output_tail`. */
  output_lines: z.number().int().nonnegative().nullish(),
  /** Only when the notice states it (async delegation). Never estimated here. */
  duration_s: z.number().nonnegative().nullish(),
  /** The inner text of a one-line notice (`watch_disabled`, `mcp_reload`), or a `cron` job's name. */
  message: z.string().nullish(),
  watch: z
    .object({
      pattern: z.string(),
      /** Earlier matches upstream suppressed by rate limit; 0 when it said nothing. */
      suppressed: z.number().int().nonnegative(),
    })
    .nullish(),
  delegation: z
    .object({
      id: z.string(),
      batch: z.boolean(),
      /** The single-task status line's status; null for a batch. */
      status: z.string().nullish(),
      total: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      api_calls: z.number().int().nonnegative().nullish(),
      /** The batch's per-task results, or the one task of a single delegation. */
      tasks: z.array(ProcessDelegationTask),
      /** The batch-level error when it failed with no per-task results. */
      error: z.string().nullish(),
    })
    .nullish(),
  /**
   * Set when the command was a bot-to-bot DM delivery (`bot_mode_dm.py
   * --run-delivery … hermes -p <profile> chat …`): the output is the other
   * bot's reply, not a log.
   */
  dm: z
    .object({
      /** The profile (bot) the DM went to, and so the bot that replied. */
      to_profile: z.string().min(1),
      /** The output minus leading tool-warning lines. */
      reply: z.string(),
      /** The leading tool-warning lines stripped from the reply, trimmed. */
      warnings: z.array(z.string()),
    })
    .nullish(),
  /** Set on the events `ProcessNotice` describes; null on process and delegation results. */
  notice: ProcessNotice.nullish(),
  raw: z.string(),
});
export type ProcessEventBlock = z.infer<typeof ProcessEventBlock>;

/** Upstream's subagent lifecycle (`SubagentStatus`), plus two states hermetic names. */
export const SubagentStatus = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "error",
  "timeout",
  "interrupted",
  /** A background delegation's handle, read from history: accepted, result not in this row. */
  "dispatched",
  /**
   * No longer observable: the child left the gateway's live roster without a
   * `complete` this laptop saw, or completed with a status this build does
   * not recognise. Results arrive with the next turn; never read as success.
   */
  "unobserved",
]);
export type SubagentStatus = z.infer<typeof SubagentStatus>;

/** What a head colours by: the raw `status` folded once, in core. */
export const SubagentVerdict = z.enum(["running", "done", "failed", "stopped", "unknown"]);
export type SubagentVerdict = z.infer<typeof SubagentVerdict>;

/** The most tool rows a subagent block keeps; `tool_count` carries the real total. */
export const SUBAGENT_TOOLS_MAX = 24;

const SubagentToolRow = z.object({
  name: z.string(),
  preview: z.string(),
  is_error: z.boolean().optional(),
});

/**
 * One delegated child (`delegate_task`), as one whole block.
 *
 * Every change re-emits the whole block under the same `subagent_id`, so a
 * head's replace-by-key merge (`subagent:<subagent_id>`) is all the reducer it
 * needs. `status` is upstream's value kept verbatim; `verdict` is the fold a
 * head colours by (`timeout`/`error` are failures, an unrecognised status is
 * `unknown` and never success). `tools` holds the last `SUBAGENT_TOOLS_MAX`
 * calls; `tool_count` is the wire's own count, not the cap. `result` is only
 * ever filled from history (`delegate_task`'s result envelope): the live wire
 * does not carry cost or a classified failure reason. `output_tail` is the
 * child's last tool outputs as its `complete` event reported them.
 *
 * `origin` says where the row came from: the live event stream, a roster
 * re-read after a reconnect (`replay`), or a persisted tool result
 * (`history`, with a synthetic `hist:<tool_id>:<task_index>` id when the
 * envelope names none). `tool_id` is the parent `delegate_task` tool block,
 * when known. `depth` is upstream's, zero-based: 0 is a child of the turn's
 * own agent, 1 a child of that child.
 */
const SubagentBlock = z.object({
  kind: z.literal("subagent"),
  subagent_id: z.string().min(1),
  delegation_id: z.string().optional(),
  parent_id: z.string().optional(),
  child_session_id: z.string().optional(),
  depth: z.number().int().nonnegative(),
  task_index: z.number().int().nonnegative(),
  task_count: z.number().int().positive(),
  goal: z.string(),
  model: z.string().optional(),
  status: SubagentStatus,
  verdict: SubagentVerdict,
  started_at: Iso.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
  tool_count: z.number().int().nonnegative().optional(),
  tools: z.array(SubagentToolRow),
  progress: z.string().optional(),
  thinking: z.string().optional(),
  files_read: z.array(z.string()).optional(),
  files_written: z.array(z.string()).optional(),
  output_tail: z.array(SubagentToolRow).optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      reasoning_tokens: z.number().int().nonnegative().optional(),
      api_calls: z.number().int().nonnegative().optional(),
    })
    .optional(),
  result: z
    .object({
      cost_usd: z.number().nonnegative().optional(),
      failure_reason: z.string().optional(),
      exit_reason: z.string().optional(),
      truncated: z.boolean().optional(),
      error: z.string().optional(),
    })
    .optional(),
  origin: z.enum(["live", "replay", "history"]),
  tool_id: z.string().optional(),
});
export type SubagentBlock = z.infer<typeof SubagentBlock>;

/**
 * A Hermes slash command the operator typed, answered by the gateway's command
 * layer (`slash.exec` / `command.dispatch`) rather than by the model.
 *
 * Its own kind, so a head draws it apart from the agent's prose: the model
 * never saw the line and never wrote the output. `state` is `done` when the
 * command layer answered, `error` when it refused (unknown, unavailable or
 * failed — `output` is its message), and `unsupported` when it answered with
 * a directive this chat cannot carry out. `prefill` is the text a `prefill`
 * directive (`/undo`) handed back for the composer, kept so the operator can
 * copy it. Live only: the gateway does not store a command's answer in the
 * session, so a transcript re-read does not bring it back.
 */
const CommandBlock = z.object({
  kind: z.literal("command"),
  /** The command as dispatched, slash included: `/help`. */
  command: z.string().min(1),
  output: z.string(),
  /** `slash.exec`'s `warning`: a side effect the gateway could not mirror. */
  warning: z.string().nullish(),
  state: z.enum(["done", "error", "unsupported"]),
  /** The directive the gateway answered with, when it answered with one. */
  dispatch: z.enum(DISPATCH_TYPES).nullish(),
  prefill: z.string().nullish(),
});
export type CommandBlock = z.infer<typeof CommandBlock>;

export const ChatBlock = z.discriminatedUnion("kind", [
  TextBlock,
  CommandBlock,
  ActivityBlock,
  ReasoningBlock,
  ToolBlock,
  AttachmentBlock,
  ApprovalBlock,
  QuestionBlock,
  SourcesBlock,
  HermeticBlock,
  ProcessEventBlock,
  SubagentBlock,
  UnknownBlock,
]);
export type ChatBlock = z.infer<typeof ChatBlock>;

export const CHAT_BLOCK_KINDS = [
  "text",
  "command",
  "activity",
  "reasoning",
  "tool",
  "attachment",
  "approval",
  "question",
  "sources",
  "hermetic",
  "process_event",
  "subagent",
  "unknown",
] as const;

/* ── messages ─────────────────────────────────────────────────────────────── */

export const ChatUsage = z.object({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  /** USD. Null when the provider did not say and hermetic will not guess. */
  cost_usd: z.number().nonnegative().nullish(),
  model: z.string().nullish(),
  /**
   * The context window as of this turn's last model call, as the gateway reports
   * it: `context_used` is the last prompt's size (the window's occupancy, not a
   * running total), `context_max` the model's window, `context_percent` the
   * rounded share of one in the other. All absent when the gateway said nothing,
   * so a head shows no figure rather than a guessed one (§9.2).
   */
  context_used: z.number().int().nonnegative().nullish(),
  context_max: z.number().int().positive().nullish(),
  context_percent: z.number().min(0).max(100).nullish(),
  /** The gateway counted locally rather than reading the provider's usage. */
  context_estimated: z.boolean().nullish(),
});
export type ChatUsage = z.infer<typeof ChatUsage>;

/**
 * Upstream's classified failure (`agent/error_surface.py` `_surface`), carried
 * on `message.complete.error_surface` and on a persisted failed turn. Advisory:
 * a head offers recovery actions from it, never decides correctness by it.
 * `resets_at` is epoch seconds, as upstream sends it.
 */
export const ChatErrorSurface = z.object({
  layer: z.string(),
  code: z.string(),
  retryable: z.boolean(),
  provider: z.string().optional(),
  model: z.string().optional(),
  auth_kind: z.string().optional(),
  /** The provider's display name, on an auth failure (`error_surface.py`). */
  provider_label: z.string().optional(),
  resets_at: z.number().optional(),
  message: z.string().optional(),
});
export type ChatErrorSurface = z.infer<typeof ChatErrorSurface>;

/**
 * A failed turn, live or re-read: hermetic's error `code` and the message, plus
 * upstream's surface when the box classified the failure. The one shape a head
 * renders a failure card from, whichever path it arrived by.
 */
export const ChatFailure = z.object({
  code: z.string().min(1),
  message: z.string(),
  surface: ChatErrorSurface.optional(),
});
export type ChatFailure = z.infer<typeof ChatFailure>;

export const ChatMessage = z.object({
  id: z.string().min(1),
  session: z.string().min(1),
  role: ChatRole,
  /** Rooms and peer-driven turns have one; a plain bot chat does not need it. */
  author: BotRef.nullish(),
  at: Iso,
  blocks: z.array(ChatBlock),
  usage: ChatUsage.nullish(),
  /** The failure as text, kept for older readers; `failure` is the structured form. */
  error: z.string().nullish(),
  /** Set beside `error` when the row is a failed turn. */
  failure: ChatFailure.nullish(),
  /** The turn stopped before it finished: aborted, timed out, lost the socket. */
  incomplete: z.boolean().nullish(),
  /**
   * Set on a `user` row that is another bot's `message_agent` delivery rather
   * than the operator speaking: Hermes stores it on the user role, signed
   * `Message from 🤖 <name> (@<handle>): …`. The signature is lifted into this
   * field and the row's text is the message alone
   * (`chat/hermes/bot-delivery.ts`). `handle` is null for the legacy signature,
   * which named the sender only. `connection` is set only for a relayed
   * sender (`(@<handle>@<connection>)`): the handle then names a bot on that
   * connection, never a local one, so a head must not resolve it locally.
   */
  from_bot: z
    .object({
      name: z.string().min(1),
      handle: z.string().min(1).nullable(),
      connection: z.string().min(1).nullish(),
    })
    .nullish(),
  /**
   * Set on a `user` row the operator sent as a mid-turn steer rather than as a
   * new prompt: Hermes stores it as its own user row after the newest tool
   * result, typed `display_kind: "steer"` and wrapped in its out-of-band marker
   * (`chat/hermes/steer-marker.ts`). The marker is stripped, so the row's text
   * is what the operator typed. Omitted on every other row.
   */
  steered: z.boolean().nullish(),
  /**
   * Set on a `user` row that invoked one or more skills (`/review the diff`):
   * Hermes stores the whole expanded skill body as the user's text
   * (`agent/skill_commands.py`), typed `display_kind: "skill_invocation"`.
   * The row's text becomes the instruction the operator typed alongside it;
   * `raw` keeps the stored text. Omitted on every other row.
   */
  skill: z
    .object({
      names: z.array(z.string().min(1)).min(1),
      instruction: z.string().nullable(),
      raw: z.string(),
    })
    .nullish(),
  /**
   * Set on a `user` row that replied to an earlier message on a messaging
   * platform: upstream prefixes `[Replying to: "<quote>"]` (`gateway/run_inbound.py`).
   * The prefix is lifted here and the row's text is the operator's alone.
   */
  reply_to: z.object({ quote: z.string() }).nullish(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/* ── the stream ───────────────────────────────────────────────────────────── */

/**
 * One frame of a live turn.
 *
 * A turn is **not** an `OpEvent` and is never registered in `OpRegistry`
 * (§9.2). Ops are long, restartable, replayable and persisted; a turn is a live
 * pipe to a process already running elsewhere. The precedent is
 * `GET /api/agents/:name/logs` — one-shot SSE, nothing buffered server-side.
 *
 * Nothing buffered *here*, that is. The gateway keeps the session's own event
 * log, so a turn whose box socket drops reconnects and asks for everything
 * after its cursor (§9.2): the half-built reply is extended, not replaced. The
 * transcript re-read is the fallback — the log no longer reaches the cursor,
 * the gateway restarted, the pin does not offer the method, the budget is
 * spent — and it is also what a browser that loses the portal's SSE response
 * does, because this hop is the one with nothing to resume from.
 *
 * `seq` is upstream's own ordering, passed through rather than re-derived, so a
 * reconnecting client can tell a replayed frame from a new one.
 *
 * **It numbers the upstream event, not the frame, and it is never a frame
 * counter.** Several frames routinely carry one `seq`, because one event fans
 * out: a real turn against a box opened with two frames at `seq: 0` and emitted
 * three at `seq: 6` — flush the reasoning, open the text block, append the
 * delta that carried the whole reply. Gaps are normal too; the same turn ran
 * `0, 0, 2, 6, 6, 6, 8, 10`.
 *
 * A consumer that treats `seq` as increasing once per frame — dropping anything
 * that does not advance it — silently discards the answer. That is not a
 * hypothetical: it shipped into the portal behind five thousand green tests and
 * survived until a turn ran against a real box, because fixture frames
 * increment one per frame and real ones do not. Compare with `<`, never `<=`,
 * and catch an exact replay some other way.
 */
const BlockFrame = z.object({
  type: z.literal("block"),
  seq: z.number().int().nonnegative(),
  message: z.string().min(1),
  block: ChatBlock,
});

/** An append to the last text block. The common case, and the small one. */
const DeltaFrame = z.object({
  type: z.literal("delta"),
  seq: z.number().int().nonnegative(),
  message: z.string().min(1),
  text: z.string(),
});

const DoneFrame = z.object({
  type: z.literal("done"),
  seq: z.number().int().nonnegative(),
  message: z.string().min(1),
  usage: ChatUsage.nullish(),
  incomplete: z.boolean().nullish(),
});

/**
 * A turn that failed. Carries a `HermeticError` code, because a head must be
 * able to tell "the box is off the tailnet" from "the model refused" from "no
 * warm slot" without reading English.
 */
const ErrorFrame = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string(),
  /**
   * The same failure as `ChatMessage.failure`, with upstream's surface when the
   * box sent one. The Hermes adapter always fills it; optional because an
   * error minted before the turn reached the box (or by an older producer)
   * may not, and a head then falls back to `code`/`message`.
   */
  failure: ChatFailure.optional(),
});

export const ChatFrame = z.discriminatedUnion("type", [BlockFrame, DeltaFrame, DoneFrame, ErrorFrame]);
export type ChatFrame = z.infer<typeof ChatFrame>;

/* ── observation ──────────────────────────────────────────────────────────── */

/**
 * One event of a continuous observation (§9.2).
 *
 * An observation is **not** a turn and not an op. A turn is a live pipe to a
 * prompt this laptop submitted; an observation is a laptop watching a
 * conversation it may never write to, so that a message sent from Hermes
 * Desktop, from the CLI or by a cron routine reaches the operator without
 * somebody happening to refresh a panel.
 *
 * The union has exactly one authoritative member. `snapshot` is the transcript
 * as the box holds it, read through the same durable route `chat.history` uses,
 * and it *replaces* whatever the consumer had. `message` is the incremental
 * form of the same read, deduplicated against the previous snapshot, and it
 * appends rather than replacing. Nothing here is an independent log: upstream
 * owns the transcript and hermetic reconciles against it rather than
 * accumulating one it believes.
 *
 * A `snapshot` is emitted on an observer's first read **and** on every later
 * read whose `session` differs from the one the held read came from. The
 * canonical session rolls over — a conversation is archived and `chat.open`
 * establishes a new one — and the new transcript is a different conversation,
 * not news about the old one; announcing it as a run of `message` deltas would
 * label a whole transcript as arrivals and leave the consumer holding two
 * sessions' rows under one session's name. So there is one `snapshot` per
 * session an observer sees, and it replaces: on receiving one, a consumer must
 * discard what it held for the previous session rather than merging into it.
 * `null` counts as a session here — a bot that had none and now has one has
 * rolled over, and so has one whose session was retired back to none.
 *
 * The consequence for a consumer that wants only the authoritative member: it
 * may ignore every `message` and wait for the next `snapshot`, but "the next
 * `snapshot`" is no longer the next reconcile — it is the next rollover, which
 * may never come. Following `message` is how a consumer stays current inside
 * one session; `snapshot` is how it learns the session changed underneath it.
 */
const ObserveSnapshotEvent = z.object({
  type: z.literal("snapshot"),
  instance: z.string().min(1),
  bot: z.string().min(1),
  /** The session the transcript came from, or null when the bot has none yet. */
  session: z.string().min(1).nullable(),
  messages: z.array(ChatMessage),
  at: Iso,
});

const ObserveMessageEvent = z.object({
  type: z.literal("message"),
  instance: z.string().min(1),
  bot: z.string().min(1),
  session: z.string().min(1).nullable(),
  message: ChatMessage,
});

/**
 * The upstream stream dropped and will be retried, with the delay already
 * decided. Emitted so a head can say "reconnecting" rather than going quiet,
 * and so a test can assert the retry budget is bounded without waiting for it.
 */
const ObserveReconnectEvent = z.object({
  type: z.literal("reconnect"),
  instance: z.string().min(1),
  bot: z.string().min(1),
  /** 1 for the first retry. Never exceeds the service's attempt bound. */
  attempt: z.number().int().positive(),
  delay_ms: z.number().int().nonnegative(),
  code: z.string().min(1),
  message: z.string(),
});

/**
 * The observation is over and said why: the retry budget was spent, or the
 * failure was one retrying cannot fix (an instance that is no longer listened
 * to, a fleet that no longer matches). Terminal — the stream ends after it.
 */
const ObserveErrorEvent = z.object({
  type: z.literal("error"),
  instance: z.string().min(1),
  bot: z.string().min(1),
  code: z.string().min(1),
  message: z.string(),
});

/**
 * A delegated child's whole block, changed (§9.2) — the first documented
 * exception to an observation carrying only durable reads (`busy` is the
 * other).
 *
 * A background `delegate_task` ends the parent turn at once and its children
 * keep running, so their progress has no turn left to ride on, and nothing
 * durable records it until the results turn lands. This carries the same
 * `SubagentBlock` the turn would have emitted. Routing: `session` is the
 * observed conversation (as on `message`); a head finds the row it updates by
 * the block's merge key `subagent:<subagent_id>` across every segment of that
 * conversation, and appends it to the turn holding `block.tool_id`'s tool
 * block (else the latest turn) when no row has that key yet.
 */
const ObserveSubagentEvent = z.object({
  type: z.literal("subagent"),
  instance: z.string().min(1),
  bot: z.string().min(1),
  session: z.string().min(1).nullable(),
  block: SubagentBlock,
});

/**
 * Whether a turn is running in the observed conversation (§9.2) — the second
 * documented exception to an observation carrying only durable reads.
 *
 * `busy: true` means the box's gateway reports a turn running, or one waiting
 * on a person (an approval, a clarify question), in this conversation;
 * `false` means it reports none; `null` means it could not be asked (a timeout,
 * a gateway that predates the read). It is a live advisory read of the
 * gateway's in-memory state, not a transcript fact: it is never stored, and it
 * can be stale by the time it arrives.
 *
 * It is how a head knows a turn *it did not start* is running — one Hermes
 * began by itself (a background process's completion notice), or one another
 * client started — which no durable read can say until the reply lands. A head
 * that sends while it reads `true` should ask for `queued` (`ChatSendInput`)
 * rather than let the gateway's busy-input mode interrupt that turn.
 *
 * Emitted after a read when the value changes, and again on every probe while
 * it is `true`, so a head that cleared it locally is corrected within one
 * reconcile. A joiner is handed the held value right after the held snapshot.
 * `session` is the conversation's session as on `message`.
 */
const ObserveBusyEvent = z.object({
  type: z.literal("busy"),
  instance: z.string().min(1),
  bot: z.string().min(1),
  session: z.string().min(1).nullable(),
  busy: z.boolean().nullable(),
  at: Iso,
});

export const ChatObserveEvent = z.discriminatedUnion("type", [
  ObserveSnapshotEvent,
  ObserveMessageEvent,
  ObserveReconnectEvent,
  ObserveErrorEvent,
  ObserveSubagentEvent,
  ObserveBusyEvent,
]);
export type ChatObserveEvent = z.infer<typeof ChatObserveEvent>;
