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
 * other bots drive turns on it. So the origin travels with the session and the
 * composer restates the destination whenever it is not `portal`.
 *
 * This is a safety field, not a decoration: a reply into a `channel` session
 * leaves the tailnet and lands in somebody's Slack, and a reply into a `peer`
 * session is answering a robot. Neither is what the operator assumed when they
 * hit Enter in a box that looks like every other box.
 */
export const SessionOrigin = z.enum(["portal", "desktop", "cli", "routine", "peer", "room", "channel"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const SESSION_ORIGINS = SessionOrigin.options;

/** Origins whose destination is not this portal, and which the composer must restate. */
export const FOREIGN_ORIGINS: readonly SessionOrigin[] = SESSION_ORIGINS.filter((o) => o !== "portal");

export const SessionKind = z.enum(["canonical", "thread", "routine"]);
export type SessionKind = z.infer<typeof SessionKind>;

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
 */
export const ToolRender = z.enum(["diff", "terminal", "table", "image", "screenshot"]);
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
});

const AttachmentBlock = z.object({
  kind: z.literal("attachment"),
  name: z.string().min(1),
  mime: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  href: z.string().min(1),
});

const ApprovalBlock = z.object({
  kind: z.literal("approval"),
  tool: z.string().min(1),
  summary: z.string(),
  detail: z.string().nullish(),
  expires_at: Iso.nullish(),
  request_id: z.string().nullish(),
  payload: z.unknown().optional(),
});

const QuestionBlock = z.object({
  kind: z.literal("question"),
  prompt: z.string(),
  choices: z.array(z.string()),
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

export const ChatBlock = z.discriminatedUnion("kind", [
  TextBlock,
  ActivityBlock,
  ReasoningBlock,
  ToolBlock,
  AttachmentBlock,
  ApprovalBlock,
  QuestionBlock,
  SourcesBlock,
  HermeticBlock,
  UnknownBlock,
]);
export type ChatBlock = z.infer<typeof ChatBlock>;

export const CHAT_BLOCK_KINDS = [
  "text",
  "activity",
  "reasoning",
  "tool",
  "attachment",
  "approval",
  "question",
  "sources",
  "hermetic",
  "unknown",
] as const;

/* ── messages ─────────────────────────────────────────────────────────────── */

export const ChatRole = z.enum(["user", "bot", "system"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatUsage = z.object({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  /** USD. Null when the provider did not say and hermetic will not guess. */
  cost_usd: z.number().nonnegative().nullish(),
  model: z.string().nullish(),
});
export type ChatUsage = z.infer<typeof ChatUsage>;

export const ChatMessage = z.object({
  id: z.string().min(1),
  session: z.string().min(1),
  role: ChatRole,
  /** Rooms and peer-driven turns have one; a plain bot chat does not need it. */
  author: BotRef.nullish(),
  at: Iso,
  blocks: z.array(ChatBlock),
  usage: ChatUsage.nullish(),
  error: z.string().nullish(),
  /** The turn stopped before it finished: aborted, timed out, lost the socket. */
  incomplete: z.boolean().nullish(),
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

export const ChatObserveEvent = z.discriminatedUnion("type", [
  ObserveSnapshotEvent,
  ObserveMessageEvent,
  ObserveReconnectEvent,
  ObserveErrorEvent,
]);
export type ChatObserveEvent = z.infer<typeof ChatObserveEvent>;
