/**
 * The fixture swarm, as data.
 *
 * `bun run dev:fixture` is the whole dev loop for the chat view — no AWS, no
 * tailnet, no provider key — so every shape a renderer has to handle has to be
 * reachable from here. That is a stronger requirement than it sounds. The nine
 * block kinds in `../schema/chat.ts` each switch on variants of their own (a
 * tool's five `render` hints and its four statuses, a `hermetic` card's four
 * targets), and a variant with no fixture behind it is a renderer nobody has
 * ever looked at. `fixture-chat.test.ts` therefore walks the tables below and
 * asserts the coverage structurally, deriving the expected sets from the
 * schema's own exported option lists rather than from a hand-written copy that
 * would go one entry stale the day a hint is added.
 *
 * It replaces the stopgap that used to live in `../chat.ts`, and it inherits
 * that stopgap's one hard property: **fixture mode constructs no live client,
 * opens no socket and resolves no hostname.** The reason is not squeamishness
 * about AWS. A seeded fleet's agents carry tailnet names that resolve to
 * nothing, so a roster read on the real adapter spends a DNS timeout per box —
 * thirteen of them, in a test suite that is supposed to be offline, to discover
 * something the fixture already knows. Everything below answers from a table.
 *
 * It also inherits the rule `git: () => ({...})` in `../open.ts` spells out:
 * **fixture mode must not depend on the machine it runs on.** Every timestamp
 * here is a fixed ISO string rather than an offset from `Date.now()`, so two
 * developers running `bun run dev:fixture` see the same transcript and a
 * snapshot taken against it is still true next month. The fixture inbox
 * (`fixture-notifications.ts`) does the opposite deliberately — an inbox reads
 * as stale the moment its rows are not "this afternoon" — but a transcript is
 * an artefact, not a feed, and a conversation dated last August reads exactly
 * as well as one dated today.
 *
 * It lives beside the other fixture tables rather than in `../chat.ts` for the
 * reason `fixture-agents.ts` and `fixture-notifications.ts` do: nothing about
 * it is behaviour except the last hundred lines, and the module it came out of
 * is one of the ones that keeps running at the 2500-line limit (AGENTS.md
 * rule 5).
 */
import { HermeticError } from "../../errors.ts";
import { CHAT_ERROR_CODES } from "../../chat/hermes/hermes-chat.ts";
// The adapter's own key and attempt budget, not a second copy of either: a head
// replaces a status block by key, so a fixture with a key of its own would draw
// a card the portal never coalesces with the real one.
import { CHAT_RECONNECT_BLOCK_KEY } from "../../chat/hermes/hermes-chat-types.ts";
import { OBSERVE_RECONNECT_ATTEMPTS } from "../../chat/chat-observe.ts";
import type {
  BoxAddress,
  ChatSteerStatus,
  HermesChatClient,
  HermesChatOptions,
  HistoryOptions,
  ObserveOptions,
  SendOptions,
} from "../../chat/hermes/hermes-chat.ts";
import type { ChatObserveHint } from "../../chat/chat-observe.ts";
import type {
  ChatFailure,
  ChatFrame,
  ChatMessage,
  FileRequest,
  FilesCommitResult,
  Session,
  Swarm,
} from "../../schema/index.ts";
import { attachedUserBlocks, attachmentTurn } from "./fixture-chat-files.ts";
import type { FixtureChatActivity } from "./fixture-chat-activity.ts";
import {
  FIXTURE_CHAT_REPLY,
  FIXTURE_CHAT_TRANSCRIPTS,
  SOURCES,
  md,
  usage,
} from "./fixture-chat-catalog.ts";
import { FIXTURE_CHAT_SESSIONS, at, specFor, swarmFor } from "./fixture-chat-roster.ts";
import { FIXTURE_LIVE_USAGE } from "./fixture-chat-usage.ts";
import {
  createFixtureChatRequests,
  fixtureClarifyScript,
  type FixtureChatRequests,
} from "./fixture-chat-requests.ts";
import { fixtureApprovalScript } from "./fixture-chat-approval.ts";
import {
  FIXTURE_FILE_REQUEST_PENDING_MS,
  FIXTURE_FILE_REQUEST_WAIT_MS,
  fixtureFileRequestScript,
  type FixtureRequestFiles,
} from "./fixture-chat-file-request.ts";
import { fixtureFileShareScript, type FixtureShareFiles } from "./fixture-chat-file-share.ts";
import { fixtureErrorScript } from "./fixture-chat-error.ts";
import { fixtureDemoTurn } from "./fixture-chat-demo.ts";
import {
  FIXTURE_TODO_SLOW_STEP_MS,
  FIXTURE_TODO_SLOW_TRIGGER,
  FIXTURE_TODO_STEP_MS,
  fixtureTodoTurn,
} from "./fixture-chat-todos.ts";
import { latestTodoList } from "../../shared/todos.ts";
import { fixtureCommand, fixtureCommandCatalog } from "./fixture-chat-command.ts";
import { createFixtureTurnRow } from "./fixture-chat-fold.ts";
import { createFixtureSubagents, settleFixtureSubagents } from "./fixture-chat-subagent.ts";
import { processEventSentence } from "../../shared/process-event.ts";

// The tables and the activity store keep their homes in the split modules; this
// stays the one door every head and test opens.
export {
  FIXTURE_CHAT_FAILURES,
  FIXTURE_CHAT_REPLY,
  FIXTURE_CHAT_TRANSCRIPTS,
} from "./fixture-chat-catalog.ts";
export {
  FIXTURE_CHAT_INSTANCES,
  FIXTURE_CHAT_SESSIONS,
  FIXTURE_WARM_SLOTS,
  fixtureChatReachable,
} from "./fixture-chat-roster.ts";
export { createFixtureChatActivity } from "./fixture-chat-activity.ts";
export type { FixtureChatActivity, FixtureChatWhere } from "./fixture-chat-activity.ts";

/* ── behaviour ────────────────────────────────────────────────────────────── */

export interface FixtureChatOptions {
  /**
   * Milliseconds between streamed frames.
   *
   * Zero - the default, and therefore what the suite gets - streams the whole
   * turn without yielding to a timer. The heads' `chatDelayMs` knob
   * (`OpenOptions.fixtureOptions`) is the same lever `slowStackMs` is for the
   * foundation fixture, and it defaults the same way for the same reason: a
   * fixture that is slow by default is a test suite that is slow by default.
   */
  delayMs?: number | undefined;
  /** Injected so a test can assert the pacing without waiting for it. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Scripted external activity (§9.2). Absent means a fixture with
   * no arrivals and a hint stream that says nothing — which is a supported
   * gateway, and leaves an observation on its poll floor.
   */
  activity?: FixtureChatActivity | undefined;
  /**
   * Frames to hand over before the turn "loses its socket", or zero for a turn
   * that never does — which is the default, and therefore what the suite and
   * every ordinary `bun run dev:fixture` get. The heads' `chatCutAfter` knob
   * (`OpenOptions.fixtureOptions`) sets it.
   *
   * §9.2's continuation rule is the one chat behaviour a fixture cannot reach
   * by describing a box, because it is not a state the box is in: it is a
   * socket dying mid-turn and the client picking the turn back up from its
   * cursor. Without this knob the reconnect UX could only be looked at against
   * a real gateway that had to be killed at the right moment.
   */
  cutAfter?: number | undefined;
  /**
   * The open clarify requests a parked turn waits on (`fixture-chat-requests.ts`).
   * Absent means a registry of this client's own, which `respond` answers from.
   */
  requests?: FixtureChatRequests | undefined;
  /**
   * The fixture boxes' files service, where the `E2E_FILE_REQUEST*` and
   * `E2E_*SECRET*` turns open their slots (`fixture-chat-file-request.ts`),
   * and, when it can share, where the `E2E_FILE_SHARE` turn puts its files
   * (`fixture-chat-file-share.ts`). Absent, those prompts are ordinary turns.
   */
  files?: (FixtureRequestFiles & Partial<FixtureShareFiles>) | undefined;
  /** How long a request turn waits for the operator; the timeout trigger's wait. */
  fileRequestWaitMs?: { open?: number | undefined; pending?: number | undefined } | undefined;
}

/**
 * How long the fixture hangs between the two reconnect frames.
 *
 * Long enough that a developer watching the portal sees the running state at
 * all, short enough that a test which does not inject a `sleep` is not paying
 * for it twice. It goes through the injectable `sleep` for exactly that reason.
 */
const FIXTURE_RECONNECT_PAUSE_MS = 150;

/**
 * How long a `*_TIMEOUT` request waits before the gateway withdraws it: long
 * enough for a head to draw the card and be looked at, short enough for a test
 * to wait out. A slowed fixture (`delayMs`) stretches it, so the card is still
 * there for the turn's own pace.
 */
const FIXTURE_REQUEST_TIMEOUT_MS = 1000;

/**
 * Cut a string into fixed-width pieces.
 *
 * Fixed width and not word boundaries, and that is deliberate: upstream streams
 * tokens, so a sentence arrives split mid-word, and the delta gate in
 * `../chat.ts` exists because a secret split that way is clean in every frame
 * and whole in the browser. A fixture that only ever split on spaces would let
 * a renderer that re-joins frames with a space pass, and would let the gate's
 * hold-back logic go untested against the only input that needs it.
 */
function chunk(text: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

/**
 * A frame that carries upstream's per-session `seq`, which is every frame but
 * an error: a failure is the transport speaking, not an event on the session,
 * so it has no place in an event log and cannot be continued from.
 */
type SequencedFrame = Extract<ChatFrame, { seq: number }>;

/**
 * The turn `send` replays: reasoning, a paragraph streamed token by token, a
 * tool that runs and then completes, a second paragraph, the sources card, and
 * a `done` carrying usage.
 *
 * The order is the one the adapter's own emitter produces (`hermes-chat.ts`):
 * a `block` frame with empty markdown *opens* a text block and `delta` frames
 * append to it, and any non-text block closes it. A head that renders deltas
 * into whatever text block is last will draw this correctly; one that appends
 * to the first text block it ever saw will draw the second paragraph inside the
 * first, above the tool it was written about.
 */
function* turn(message: string): Generator<SequencedFrame> {
  let seq = 0;
  const next = () => ++seq;

  yield {
    type: "block",
    seq: next(),
    message,
    block: {
      kind: "reasoning",
      text:
        "They want the box looked at, not a lecture. Read the metrics first, answer " +
        "in plain words, and do not change anything in the account without asking.",
      duration_ms: 3180,
      tokens: 164,
    },
  };

  // Cut rather than split, so the two halves still concatenate to exactly the
  // reply: a `split` on a marker eats the marker, and a stream that loses two
  // characters at the tool boundary is a stream nothing can be asserted against.
  const cut = FIXTURE_CHAT_REPLY.indexOf("The fix is");
  const first = FIXTURE_CHAT_REPLY.slice(0, cut);
  const second = FIXTURE_CHAT_REPLY.slice(cut);

  yield { type: "block", seq: next(), message, block: { kind: "text", markdown: "" } };
  for (const piece of chunk(first, 11)) {
    yield { type: "delta", seq: next(), message, text: piece };
  }

  yield {
    type: "block",
    seq: next(),
    message,
    block: {
      kind: "tool",
      tool_id: "tl-fixture-live",
      name: "bash",
      server: null,
      args: { command: "iostat -x 1 3" },
      result: null,
      status: "running",
      exit_code: null,
      duration_ms: null,
      render: "terminal",
    },
  };
  yield {
    type: "block",
    seq: next(),
    message,
    block: {
      kind: "tool",
      tool_id: "tl-fixture-live",
      name: "bash",
      server: null,
      args: { command: "iostat -x 1 3" },
      result: md(
        "Device   r/s    w/s   rkB/s    wkB/s  aqu-sz  %util",
        "nvme1n1  12.0  844.0   192.0 124928.0    4.02  99.60",
      ),
      status: "ok",
      exit_code: 0,
      duration_ms: 3120,
      render: "terminal",
    },
  };

  yield { type: "block", seq: next(), message, block: { kind: "text", markdown: "" } };
  for (const piece of chunk(second, 11)) {
    yield { type: "delta", seq: next(), message, text: piece };
  }

  yield { type: "block", seq: next(), message, block: { kind: "sources", items: SOURCES } };
  yield {
    type: "done",
    seq: next(),
    message,
    usage: usage(12_040, 486, 0.0208, "claude-sonnet-5"),
    incomplete: null,
  };
}

/**
 * The chat client fixture mode gets.
 *
 * Every method answers from the tables above. Nothing here constructs a socket,
 * a `fetch` or a hostname, and there is no flag that makes it do so — the
 * stopgap this replaces existed because a roster read on the real adapter spent
 * a DNS timeout per seeded box, and that property is load-bearing rather than
 * incidental.
 *
 * A box the roster says is unreachable stays unreachable through every method:
 * its session list is empty, its transcript is empty, and a turn against it is
 * one `CHAT_UNREACHABLE` frame rather than a hang. That is the same answer the
 * real client gives for a box that is off the tailnet, which is what makes the
 * offline bucket in the rail worth developing against.
 */
/**
 * The dashboard session token a fixture box hands `agent desktop` (§7.4).
 *
 * `FIXTURE` is in the value on purpose and is not decoration: §8.3's leak grep
 * reads every credential-shaped string a fixture prints, and a fixture token
 * that looked like upstream's `secrets.token_urlsafe(32)` would be indexed as a
 * real one the first time somebody pasted a transcript into an issue.
 */
export const fixtureSessionToken = (instance: string): string =>
  `FIXTURE-HERMES-SESSION-TOKEN-${instance}`;

export function fixtureChatClient(opts: FixtureChatOptions = {}): HermesChatClient {
  const delayMs = opts.delayMs ?? 0;
  const sleep =
    opts.sleep ??
    ((ms: number) => (ms > 0 ? new Promise<void>((done) => setTimeout(done, ms)) : Promise.resolve()));
  const pace = (): Promise<void> => (delayMs > 0 ? sleep(delayMs) : Promise.resolve());
  const requestTimeoutMs = Math.max(FIXTURE_REQUEST_TIMEOUT_MS, delayMs * 20);

  const reachable = (instance: string): boolean => specFor(instance).reachable;
  const activity = opts.activity;
  const cutAfter = opts.cutAfter ?? 0;
  const requests = opts.requests ?? createFixtureChatRequests();
  /** The fixture boxes' files service, for the request turns. */
  const files = opts.files;
  const fileWaits = opts.fileRequestWaitMs ?? {};
  /** Delegated children: the `E2E_SUBAGENT*` triggers and child control. */
  const subagents = createFixtureSubagents({
    delayMs,
    sleep,
    activity,
    now: () => new Date().toISOString(),
  });

  /**
   * The canonical session a read falls back to when the caller named none —
   * §9.2's addressing bottoms out at a session, and "the bot" alone is not an
   * address. Resolved here rather than twice, because `history` and `observe`
   * have to agree about which conversation they are looking at.
   */
  const canonicalOf = (instance: string, bot: string): string | undefined =>
    FIXTURE_CHAT_SESSIONS.find(
      (s) => s.instance === instance && s.bot === bot && s.kind === "canonical",
    )?.id;

  /**
   * What this client has been sent, keyed `instance bot session`.
   *
   * A real box records a turn: the prompt and the reply are rows in its durable
   * transcript the moment they exist, and the next `history` read returns them.
   * A fixture that streamed a reply and then answered `history` as if nothing
   * had happened made one whole path undemonstrable — a locally sent message
   * reconciled by an observation is supposed to be recognised as the one
   * already on screen, and a transcript that never gains it cannot show that
   * either working or broken.
   *
   * Per client instance, not module-level: the canned tables above are shared
   * by every test in the process and this one is written to.
   */
  const sent = new Map<string, ChatMessage[]>();
  const sentKey = (instance: string, bot: string, session: string): string =>
    `${instance} ${bot} ${session}`;
  const sentRows = (instance: string, bot: string, session: string): ChatMessage[] => {
    const k = sentKey(instance, bot, session);
    const found = sent.get(k) ?? [];
    sent.set(k, found);
    return found;
  };

  /**
   * The clock for rows that are made rather than written down.
   *
   * Taken from the activity store when there is one, so a turn this client was
   * sent and a message staged as having arrived from elsewhere are stamped off
   * the same counter and the transcript sorts back into the order things
   * happened. Without a store there is nothing else to order against, so a
   * private counter of the same shape does. Neither reads a clock: see
   * `FixtureChatActivity.stamp`.
   */
  let minted = 0;
  const mint = (): string => {
    if (activity) return activity.stamp();
    const n = minted++;
    const mm = String(Math.floor(n / 60) % 60).padStart(2, "0");
    const ss = String(n % 60).padStart(2, "0");
    return at(`12:${mm}:${ss}`);
  };

  /** Turns taken against this client, so each one's reply is its own row. */
  let turns = 0;

  /**
   * The turns streaming right now, keyed `instance bot`, each with the session
   * it is writing to — what `steer` looks for, standing in for the gateway's
   * own `running` flag. A turn is in flight from its first frame until its
   * generator settles, abort included.
   */
  const inflight = new Map<string, (string | null)[]>();
  const flightKey = (instance: string, bot: string): string => `${instance} ${bot}`;
  /** Steers delivered, so each one's user row has an id of its own. */
  let steers = 0;

  /** The refusal the real adapter raises for a box whose dashboard does not answer. */
  const unanswered = (instance: string): HermeticError => {
    const why = specFor(instance).unreachable_reason ?? "the box did not answer";
    return new HermeticError(
      CHAT_ERROR_CODES.UNREACHABLE,
      `${instance}: dashboard did not answer (${why})`,
      { instance },
    );
  };

  return {
    token(box: BoxAddress, _opts?: HermesChatOptions): Promise<string> {
      // A box the roster calls unreachable refuses here too, with the code the
      // real adapter raises for the same box: `agent desktop --fixture` is worth
      // having only if the failure it shows is the failure an operator will meet.
      if (!reachable(box.instance)) return Promise.reject(unanswered(box.instance));
      // Per box, so a fixture that shows two boxes never shows one token twice,
      // and a `FIXTURE` sentinel, because §8.3's leak grep is entitled to assume
      // every credential-shaped string a fixture prints is one of these.
      return Promise.resolve(fixtureSessionToken(box.instance));
    },

    swarm(box: BoxAddress, _opts?: HermesChatOptions): Promise<Swarm> {
      const swarm = swarmFor(box);
      /**
       * A real roster previews a bot whose newest row is a background-process
       * notice as the event's sentence (`eventPreview`, `hermes-chat-sessions.ts`),
       * never as the raw `[IMPORTANT: …`. The roster table cannot import the
       * event transcript (that module imports the table), so the preview is
       * derived here, from the same canned rows `history` answers with.
       */
      return Promise.resolve({
        ...swarm,
        bots: swarm.bots.map((bot) => {
          if (bot.preview != null) return bot;
          const id = canonicalOf(box.instance, bot.name);
          const last = id === undefined ? undefined : FIXTURE_CHAT_TRANSCRIPTS[id]?.at(-1);
          const block = last?.blocks.find((b) => b.kind === "process_event");
          return block?.kind === "process_event"
            ? { ...bot, preview: processEventSentence(block), preview_role: "system" as const }
            : bot;
        }),
      });
    },

    sessions(box: BoxAddress, bot: string, _opts?: HermesChatOptions): Promise<Session[]> {
      if (!reachable(box.instance)) return Promise.resolve([]);
      return Promise.resolve(
        FIXTURE_CHAT_SESSIONS.filter((s) => s.instance === box.instance && s.bot === bot).map((s) => ({
          ...s,
        })),
      );
    },

    history(box: BoxAddress, bot: string, opts: HistoryOptions = {}): Promise<ChatMessage[]> {
      if (!reachable(box.instance)) return Promise.resolve([]);
      // Without a session the box answers from the bot's canonical one, which is
      // what the thread view opens on: §9.2's addressing bottoms out at a
      // session, and "the bot" alone is not an address.
      const id = opts.session ?? canonicalOf(box.instance, bot);
      /**
       * Two lanes join the canned transcript: what this client was sent, and
       * what arrived from somewhere else. Both are appended rather than
       * replacing it, because the box is authoritative for all three and an
       * observation has to be able to tell one durable read from the next.
       *
       * Sorted by timestamp so the tail reads in the order it happened whether
       * the operator sent first or the routine did. `sort` is stable, so rows
       * that share a stamp keep the order they were made in.
       */
      const tail =
        id === undefined
          ? []
          : [
              ...sentRows(box.instance, bot, id),
              ...(activity?.extras({ instance: box.instance, bot }, id) ?? []),
            ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const found = id === undefined ? [] : [...(FIXTURE_CHAT_TRANSCRIPTS[id] ?? []), ...tail];
      const limit = opts.limit;
      // The *tail*, not the head: a limited read is the last N turns, because a
      // transcript is read from the bottom.
      const kept =
        limit !== undefined && limit >= 0 ? found.slice(Math.max(0, found.length - limit)) : found;
      return Promise.resolve(kept.map((m) => ({ ...m })));
    },

    /** The live gateway's figure for a conversation still attached there (`FIXTURE_LIVE_USAGE`). */
    liveUsage(box: BoxAddress, _bot: string, session: string) {
      if (!reachable(box.instance)) return Promise.resolve(null);
      const live = FIXTURE_LIVE_USAGE[session];
      return Promise.resolve(live ? { ...live } : null);
    },

    /** A turn of this client's own in flight in one of `sessions`, read from `inflight`. */
    busy(box: BoxAddress, bot: string, sessions: readonly string[]) {
      if (!reachable(box.instance)) return Promise.resolve(null);
      const flying = inflight.get(flightKey(box.instance, bot)) ?? [];
      return Promise.resolve(flying.some((session) => session !== null && sessions.includes(session)));
    },

    /** The fixture box's slash-command catalog (`fixture-chat-command.ts`), the same for every bot. */
    commands(box: BoxAddress) {
      if (!reachable(box.instance)) return Promise.reject(unanswered(box.instance));
      return Promise.resolve(fixtureCommandCatalog());
    },

    send(
      box: BoxAddress,
      bot: string,
      typed: string,
      opts: SendOptions = {},
    ): AsyncIterable<ChatFrame> {
      const instance = box.instance;
      return (async function* () {
        if (!reachable(instance)) {
          const why = specFor(instance).unreachable_reason ?? "the box did not answer";
          yield {
            type: "error",
            code: CHAT_ERROR_CODES.UNREACHABLE,
            message: `${instance}: ${why}`,
          } as const;
          return;
        }
        // A slash command is answered by the (fixture) command layer, never
        // sent as a prompt; a `send` directive's message is the prompt instead.
        const command = fixtureCommand(typed, opts.attachments?.ids.length ?? 0);
        const commandId = command ? `mx-fixture-live-${++turns}` : null;
        if (command && commandId) {
          for (const block of command.blocks) {
            await pace();
            yield { type: "block", seq: 0, message: commandId, block } as const;
          }
          if (command.prompt === null) {
            yield { type: "done", seq: 0, message: commandId, usage: null } as const;
            return;
          }
        }
        const text = command?.prompt ?? typed;
        /**
         * The message id counts turns rather than reading a clock, for the same
         * reason every timestamp above does: two developers streaming the same
         * fixture turn get the same frames. It is *per turn* rather than one
         * constant because the id is what the transcript row is keyed on, and
         * an observation's cursor drops a second row that reuses an id it has
         * already seen — one constant meant a second turn never reached the
         * transcript at all.
         */
        const id = commandId ?? `mx-fixture-live-${++turns}`;
        const session = opts.session ?? canonicalOf(instance, bot) ?? null;
        /**
         * The turn's attachments, committed into the fixture box's inbox the
         * way the real adapter commits them: before anything else happens, so
         * an unknown or expired id ends the turn with the box's own refusal and
         * leaves no row behind.
         */
        const attached: FilesCommitResult[] = [];
        if (opts.attachments && opts.attachments.ids.length > 0) {
          try {
            for (const fileId of opts.attachments.ids) {
              attached.push(await opts.attachments.commit(fileId, session ?? "", opts.signal));
            }
          } catch (e) {
            yield {
              type: "error",
              code: e instanceof HermeticError ? String(e.code) : CHAT_ERROR_CODES.PROTOCOL,
              message: e instanceof Error ? e.message : String(e),
            } as const;
            return;
          }
        }
        const flying = inflight.get(flightKey(instance, bot)) ?? [];
        inflight.set(flightKey(instance, bot), flying);
        flying.push(session);
        /**
         * The reply as the transcript will hold it, folded from the same frames
         * the caller is being handed: deltas land in the text block they were
         * opened against, and a tool's completion replaces the row that
         * announced it running. Copied rather than referenced, because the
         * frames have already left and nothing here may edit them afterwards.
         */
        const row = createFixtureTurnRow();
        const { blocks, fold } = row;
        if (session !== null) {
          sentRows(instance, bot, session).push({
            id: `mx-fixture-local-${turns}`,
            session,
            role: "user",
            at: mint(),
            blocks:
              attached.length > 0
                ? attachedUserBlocks(text, attached)
                : [{ kind: "text", markdown: text }],
          });
        }
        /**
         * The turn as the box's own event log holds it, materialised before a
         * single frame is handed over.
         *
         * Upstream stamps a `seq` on every event as it is produced and keeps
         * it, which is what makes `session.events.since` answerable at all: the
         * events exist whether or not a socket was there to carry them. Pulling
         * the generator lazily would model something else — a box that stops
         * thinking when nobody is listening — and the cut below would then have
         * nothing to continue from.
         */
        const clarify = fixtureClarifyScript(text);
        const approval = fixtureApprovalScript(text);
        const failing = fixtureErrorScript(text, () => Date.now() / 1000);
        const asking = files ? fixtureFileRequestScript(text) : null;
        const sharing = files?.share ? fixtureFileShareScript(text) : null;
        const demo = fixtureDemoTurn(text);
        const todo = fixtureTodoTurn(text, () =>
          session === null
            ? null
            : (latestTodoList([
                ...(FIXTURE_CHAT_TRANSCRIPTS[session] ?? []),
                ...sentRows(instance, bot, session),
              ])?.snapshot ?? null),
        );
        const todoStepMs = text.includes(FIXTURE_TODO_SLOW_TRIGGER)
          ? FIXTURE_TODO_SLOW_STEP_MS
          : delayMs > 0
            ? delayMs * 6
            : FIXTURE_TODO_STEP_MS;
        const log =
          clarify || approval || failing || asking || sharing || todo
            ? []
            : attached.length > 0
              ? [...attachmentTurn(id, attached)]
              : demo
                ? demo(id)
                : [...turn(id)];
        /** The fixture's stand-in for `session.events.since`: everything past a cursor. */
        const eventsSince = (lastSeen: number): SequencedFrame[] =>
          log.filter((frame) => frame.seq > lastSeen);

        /** The highest seq the caller has actually been handed — the turn's cursor. */
        let cursor = 0;
        const deliver = async function* (
          batch: readonly SequencedFrame[],
        ): AsyncGenerator<SequencedFrame> {
          for (const frame of batch) {
            // An abort ends the replay where it is. `../chat.ts` flushes whatever
            // the delta gate was holding, so the words already streamed survive -
            // which is the behaviour an operator who pressed stop expects.
            if (opts.signal?.aborted) return;
            await pace();
            yield frame;
            cursor = frame.seq;
            if (frame.type === "block") fold(frame.block);
            if (frame.type === "delta") row.delta(frame.text);
          }
        };

        /**
         * The reconnect card, minted here rather than by the box.
         *
         * It carries the cursor as its `seq` so it sorts where it happened, and
         * `role: "status"` so a head replaces it by key instead of stacking two
         * cards — the running one becomes the done one in place.
         */
        const reconnect = (state: "running" | "done"): SequencedFrame => ({
          type: "block",
          seq: cursor,
          message: id,
          block: {
            kind: "activity",
            category: "connection",
            key: CHAT_RECONNECT_BLOCK_KEY,
            role: "status",
            state,
            title: state === "running" ? "Reconnecting…" : "Reconnected",
            detail: state === "running" ? `attempt 1 of ${OBSERVE_RECONNECT_ATTEMPTS}` : null,
            request_id: null,
          },
        });

        /** The clarify or approval request this turn is parked on, if it raised one. */
        let asked: { close(): void } | null = null;
        /** How this turn failed, if it did: stored beside the row, as a box stores it. */
        let failed: ChatFailure | null = null;

        try {
          /** A delegating turn (`fixture-chat-subagent.ts`), paced like any other. */
          const delegated = subagents.script(text);
          if (delegated) {
            // The resolved session, not the caller's: one that named none is
            // talking to the canonical conversation, and its children and
            // results belong to that one alone.
            const where = { instance, bot, session: session ?? undefined };
            for await (const frame of delegated.frames(id, where, opts.signal)) {
              // Breaking out returns the script, which stops its waits and
              // retires its children; `deliver` alone only skips one frame.
              if (opts.signal?.aborted) break;
              yield* deliver([frame]);
            }
            return;
          }
          /**
           * A clarify turn (`fixture-chat-requests.ts`): the question card, then
           * a park on the request until `respond` settles it, then the rest.
           * Its second half depends on the answer, so it cannot be materialised
           * up front, and the simulated cut below does not apply to it.
           *
           * The park is an awaited promise and nothing else: the request settles
           * `aborted` when the turn's signal fires, and the turn then ends where
           * it is, as any other aborted fixture turn does.
           */
          if (clarify) {
            const parked = requests.open(clarify.questions, opts.signal, {
              batch: clarify.batch,
              timeoutMs: clarify.timeout ? requestTimeoutMs : undefined,
            });
            asked = parked;
            yield* deliver(clarify.ask(id, parked.request_id));
            const outcome = await parked.settled;
            if (outcome.kind !== "aborted")
              yield* deliver(clarify.resume(id, outcome, cursor, parked.request_id));
            return;
          }
          /**
           * An approval turn (`fixture-chat-approval.ts`): the same park, on a
           * command the operator may refuse.
           */
          if (approval) {
            const parked = requests.openApproval(
              opts.signal,
              approval.timeout ? requestTimeoutMs : undefined,
            );
            asked = parked;
            yield* deliver(approval.ask(id, parked.request_id));
            const outcome = await parked.settled;
            if (outcome.kind !== "aborted")
              yield* deliver(approval.resume(id, outcome, cursor, parked.request_id));
            return;
          }
          /**
           * A request turn (`fixture-chat-file-request.ts`): the slot opened on
           * the fixture box for this turn's session, the running card naming
           * it, then a park on the slot until it is answered, declined or
           * expires — or, past the wait, a `pending` result with the slot left
           * open for a late delivery.
           */
          if (asking && files) {
            let slot: FileRequest;
            try {
              slot = files.openRequest(instance, asking.body, {
                ...(session !== null ? { session_id: session } : {}),
              });
            } catch (e) {
              yield* deliver(asking.refused(id, e instanceof Error ? e.message : String(e)));
              return;
            }
            yield* deliver(asking.ask(id, slot.request_id));
            const settled = await files.waitFor(instance, slot.request_id, {
              ...(opts.signal ? { signal: opts.signal } : {}),
              timeoutMs: asking.timeout
                ? (fileWaits.pending ?? Math.max(FIXTURE_FILE_REQUEST_PENDING_MS, delayMs * 20))
                : (fileWaits.open ?? FIXTURE_FILE_REQUEST_WAIT_MS),
            });
            if (opts.signal?.aborted) return;
            yield* deliver(asking.resume(id, settled, cursor, instance));
            return;
          }
          /**
           * A share turn (`fixture-chat-file-share.ts`): two `share_file` cards
           * whose files are put into the fixture box's outbox, and a reply whose
           * `MEDIA:` outbox line becomes an attachment chip.
           */
          if (sharing && files?.share) {
            const share = files.share.bind(files);
            yield* deliver(sharing.frames(id, { share }, instance, session));
            return;
          }
          /** A task-list turn (`fixture-chat-todos.ts`), its steps a watchable beat apart. */
          if (todo) {
            for (const [i, batch] of todo(id).entries()) {
              if (i > 0) await sleep(todoStepMs);
              if (opts.signal?.aborted) return;
              yield* deliver(batch);
            }
            return;
          }
          /**
           * A failing turn (`fixture-chat-error.ts`): optionally some text, then
           * an `error` frame carrying the classified failure. The frame has no
           * seq, so it does not go through `deliver`; the row it leaves behind
           * is written below, with the failure beside it.
           */
          if (failing) {
            if (failing.text !== null)
              yield* deliver([
                { type: "block", seq: 1, message: id, block: { kind: "text", markdown: "" } },
                { type: "delta", seq: 2, message: id, text: failing.text },
              ]);
            if (opts.signal?.aborted) return;
            await pace();
            failed = failing.failure;
            yield {
              type: "error",
              code: failing.failure.code,
              message: failing.failure.message,
              failure: failing.failure,
            };
            return;
          }
          /**
           * The simulated cut (§9.2): the socket dies partway through, and the
           * turn is picked up from its cursor rather than started again.
           *
           * Nothing here fakes an RPC — there is no socket to lose and no
           * gateway to ask. What it reproduces is the only part a head can see:
           * the two status frames, and then the rest of the turn arriving
           * exactly once, in seq order, finishing `done` without `incomplete`.
           * A turn that had to be re-read instead of continued would end
           * incomplete, and that is the distinction the UX exists to draw.
           */
          if (cutAfter > 0 && cutAfter < log.length) {
            yield* deliver(log.slice(0, cutAfter));
            if (!opts.signal?.aborted) {
              // Through `deliver` like every other frame, so the fold rule that
              // keeps a status card out of the durable row is the one rule and
              // not a second copy of it living here.
              yield* deliver([reconnect("running")]);
              await sleep(FIXTURE_RECONNECT_PAUSE_MS);
              yield* deliver([reconnect("done")]);
              yield* deliver(eventsSince(cursor));
            }
          } else {
            yield* deliver(log);
          }
        } finally {
          // A turn abandoned before its question was answered leaves no request
          // behind for a later `respond` to settle.
          asked?.close();
          flying.splice(flying.indexOf(session), 1);
          // Also on abort: a turn the operator stopped still happened, and the
          // half of it the box had already written down is still in its
          // transcript when the next read comes.
          if (session !== null && (blocks.length > 0 || failed !== null)) {
            sentRows(instance, bot, session).push({
              id,
              session,
              role: "bot",
              at: mint(),
              blocks: settleFixtureSubagents(blocks),
              ...(failed ? { error: failed.message, failure: failed } : {}),
            });
          }
        }
      })();
    },

    /**
     * The hint stream (§9.2): a queue a test pushes into, and no
     * transport of any kind.
     *
     * It ends when the scripted `drop` closes it or when the observer's signal
     * fires, which are the two ways a real one ends — a dashboard restart and a
     * tab closing. A box the roster calls unreachable ends it immediately, so
     * the bounded-reconnect path is reachable from a fixture without waiting
     * for a timeout that a fixture has no way to produce.
     */
    observe(box: BoxAddress, bot: string, opts: ObserveOptions = {}): AsyncIterable<ChatObserveHint> {
      const where = { instance: box.instance, bot };
      const session = opts.session ?? canonicalOf(box.instance, bot) ?? null;
      return (async function* () {
        if (!reachable(box.instance) || !activity) return;
        const pending: ChatObserveHint[] = [];
        let done = false;
        let wake: (() => void) | null = null;
        const nudge = (): void => {
          const w = wake;
          wake = null;
          w?.();
        };
        const close = activity.open(where, {
          push: () => {
            pending.push({ session });
            nudge();
          },
          close: () => {
            done = true;
            nudge();
          },
        });
        const unlisten = subagents.listen(where, (hint) => {
          // Another conversation's children are not this watch's, and a
          // child no conversation claims is nobody's.
          if (hint.session !== session) return;
          pending.push(hint);
          nudge();
        });
        const onAbort = (): void => {
          done = true;
          nudge();
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          for (;;) {
            while (pending.length > 0) {
              const head = pending.shift();
              if (head !== undefined) yield head;
            }
            if (done || opts.signal?.aborted === true) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          opts.signal?.removeEventListener("abort", onAbort);
          close();
          unlisten();
        }
      })();
    },

    /**
     * Settles the clarify or approval request a parked turn is waiting on. An
     * unknown or already-settled one is `expired`, as on a real box.
     */
    respond(_box, input) {
      try {
        return Promise.resolve(requests.respond(input));
      } catch (e) {
        return Promise.reject(e);
      }
    },

    abort(_box: BoxAddress, _bot: string, _opts?: SendOptions): Promise<void> {
      // Nothing to interrupt: `send`'s generator stops on its own signal. The
      // real client posts `session.interrupt` here; a fixture has no box to
      // post to, and answering is the honest result either way (§5's "aborted
      // says the stop was delivered, not that a turn was in flight").
      return Promise.resolve();
    },

    /**
     * A steer lands only on a turn this client is streaming, and is then
     * `redirected` — the gateway's answer for a correction folded into the
     * running model turn — and written down as a user row, which is what a real
     * box's transcript gains. The reply already in flight is not rewritten: a
     * fixture's reply is canned, and the row is what a head can check.
     */
    steer(
      box: BoxAddress,
      bot: string,
      text: string,
      opts: SendOptions = {},
    ): Promise<ChatSteerStatus> {
      const flying = inflight.get(flightKey(box.instance, bot)) ?? [];
      const session = opts.session ? flying.find((s) => s === opts.session) : flying[0];
      if (session === undefined) return Promise.resolve("idle");
      if (session !== null) {
        sentRows(box.instance, bot, session).push({
          id: `mx-fixture-steer-${++steers}`,
          session,
          role: "user",
          at: mint(),
          blocks: [{ kind: "text", markdown: text }],
          // History reads a real box's steer row this way (`steer-marker.ts`).
          steered: true,
        });
      }
      return Promise.resolve("redirected");
    },

    /** A delegated child's steer and stop (`fixture-chat-subagent.ts`). */
    subagentSteer: (box, bot, subagentId, text) =>
      Promise.resolve(subagents.steer(box.instance, bot, subagentId, text)),
    subagentInterrupt: (box, bot, subagentId) =>
      Promise.resolve(subagents.interrupt(box.instance, bot, subagentId)),
  };
}
