/** Canonical Bot Chat identity and lifecycle. Wire contracts live at Hermes v2026.9.24. */
import { HermeticError } from "../errors.ts";
import { HERMETIC_SESSION_SOURCE, rec, records, str } from "../chat/hermes/hermes-chat-wire.ts";
import type { BoxAddress, HermesChatOptions } from "../chat/hermes/hermes-chat.ts";
import type { ChatConversation, ChatRespondInput } from "../schema/index.ts";

export interface BotRpc {
  request(method: string, params: Record<string, unknown>, deadlineMs?: number): Promise<unknown>;
  close(): void;
}
export interface ConversationOptions extends HermesChatOptions {
  create?: boolean;
  new_session?: boolean;
  session?: string;
}
export interface CanonicalDeps {
  connect(box: BoxAddress, signal?: AbortSignal): Promise<BotRpc>;
  patch(
    box: BoxAddress,
    session: string,
    body: Record<string, unknown>,
    opts: HermesChatOptions,
  ): Promise<unknown>;
  /**
   * One stored session row as the dashboard returns it
   * (`GET /api/sessions/{id}?profile=…`, `hermes_cli/web_routers/sessions.py:500-513`
   * at v2026.9.24): the full `sessions` row, `archived` included, which no
   * session RPC carries.
   */
  read(box: BoxAddress, session: string, bot: string, opts: HermesChatOptions): Promise<unknown>;
  now(): string;
}
const failure = (message: string) => new HermeticError("CHAT_PROTOCOL", message);
/**
 * One answer to "is this row Bot Chat", mirrored by `mapSessions`
 * (`hermes-chat-sessions.ts:65`), which classifies `kind: "canonical"` from the
 * same `root_title ?? title`. Two readers disagreeing about that would let a
 * row be canonical in the session list and absent from this lookup; change the
 * two together.
 */
const titleOf = (row: Record<string, unknown>) => str(row.root_title) ?? str(row.title);
const identity = (
  box: BoxAddress,
  bot: string,
  root: string,
  tip: string,
  created = false,
  kind: ChatConversation["kind"] = "canonical",
): ChatConversation => ({
  instance: box.instance,
  bot,
  root_session: root,
  session: tip,
  kind,
  created,
});

export function createCanonicalSessions(deps: CanonicalDeps) {
  const flights = new Map<string, Promise<ChatConversation | null>>();
  async function find(rpc: BotRpc, box: BoxAddress, bot: string): Promise<ChatConversation | null> {
    const response = rec(
      await rpc.request("session.list", {
        profile: bot,
        title: "Bot Chat",
        include_hidden: true,
        limit: 100,
      }),
    );
    if (!Array.isArray(response?.sessions))
      throw failure("Bot Chat lookup returned no session registry");
    // Upstream's title summary (`_session_row_summary`) omits `profile` at this
    // pin, so the read is already profile-scoped and this guard sees nothing —
    // it is here for the shapes that do carry the field, which `mapSessions`
    // (`hermes-chat-sessions.ts:59`) filters on for the same reason.
    if (records(response.sessions).some((row) => str(row.profile) && row.profile !== bot))
      throw failure("Bot Chat lookup returned another profile’s session");
    // The title index is UNIQUE, so at this pin the filter can only ever keep
    // one row. The `> 1` check is a cheap invariant against that changing, not
    // protection against something this gateway can produce today.
    const found = records(response.sessions).filter((row) => titleOf(row) === "Bot Chat");
    if (found.length > 1)
      throw failure("Bot Chat registry has more than one owner; repair upstream before continuing");
    const row = found[0];
    if (!row) return null;
    // `id` is what the title summary sends; `stored_session_id` is the same
    // durable identity under the name the fuller session shapes use, and
    // `mapSessions` reads both.
    const root = str(row.id) ?? str(row.stored_session_id);
    if (!root) throw failure("Bot Chat registry named no durable session");
    return identity(box, bot, root, str(row.resolved_id) ?? root);
  }

  async function resolve(
    box: BoxAddress,
    bot: string,
    opts: ConversationOptions,
  ): Promise<ChatConversation | null> {
    const rpc = await deps.connect(box, opts.signal);
    try {
      if (opts.session) {
        const canonical = await find(rpc, box, bot);
        if (canonical && [canonical.root_session, canonical.session].includes(opts.session))
          return canonical;
        return identity(box, bot, opts.session, opts.session, false, "thread");
      }
      if (opts.new_session) {
        const created = rec(
          await rpc.request("session.create", { profile: bot, source: HERMETIC_SESSION_SOURCE }),
        );
        const stored = str(created?.stored_session_id);
        const runtime = str(created?.session_id);
        if (!stored || !runtime) throw failure("New session returned no durable/runtime identity");
        // Eager title persists an otherwise lazy empty session before history opens.
        const titled = rec(
          await rpc.request("session.title", {
            profile: bot,
            session_id: runtime,
            title: `Chat ${deps.now()} ${stored}`,
          }),
        );
        if (titled?.pending === true)
          throw failure("Gateway cannot persist an empty session yet; update Hermes");
        return identity(box, bot, stored, stored, true, "thread");
      }
      if (opts.create) {
        const roster = rec(await rpc.request("profiles.list", { include_sessions: true }));
        if (roster?.bot_mode_protocol !== true)
          throw failure("This gateway does not support canonical Bot Mode");
        const owner = records(roster.profiles).find((row) => row.name === bot);
        if (!owner) throw failure(`Profile ${bot} is absent from this gateway`);
        if (!rec(owner.ui_meta)?.["hermes-bots"]) {
          const configured = rec(
            await rpc.request("profiles.configure", {
              name: bot,
              ui_meta: { "hermes-bots": { version: 1 } },
              ui_meta_expected_revisions: {
                "hermes-bots": rec(owner.ui_meta_revisions)?.["hermes-bots"] ?? 0,
              },
            }),
          );
          if (configured?.ok !== true || rec(configured.applied)?.ui_meta !== true)
            throw failure("Bot Mode metadata could not be saved; reload before retrying");
        }
      }
      const existing = await find(rpc, box, bot);
      if (existing || !opts.create) return existing;
      const roster = rec(await rpc.request("profiles.list", { include_sessions: true }));
      if (roster?.bot_mode_protocol !== true)
        throw failure("This gateway does not support canonical Bot Mode; update Hermes");
      const owner = records(roster.profiles).find((row) => row.name === bot);
      if (!owner) throw failure(`Profile ${bot} is absent from this gateway`);
      if (str(rec(owner.canonical_session)?.id))
        throw failure(
          "Bot Chat is present in the roster but missing from the registry; retry after the gateway recovers",
        );
      try {
        const created = rec(
          await rpc.request("session.create", {
            profile: bot,
            source: HERMETIC_SESSION_SOURCE,
            title: "Bot Chat",
            hidden: true,
            follow_profile_config: true,
          }),
        );
        const stored = str(created?.stored_session_id);
        const runtime = str(created?.session_id);
        if (!stored || !runtime)
          throw failure("Bot Chat creation returned no durable/runtime identity");
        const titled = rec(
          await rpc.request("session.title", { profile: bot, session_id: runtime, title: "Bot Chat" }),
        );
        if (titled?.pending === true || titled?.title !== "Bot Chat")
          throw failure("Gateway could not persist Bot Chat before its first turn; update Hermes");
        return identity(box, bot, stored, stored, true);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/already in use|title.*(?:conflict|unique)/i.test(error.message)
        )
          throw error;
        const winner = await find(rpc, box, bot);
        if (!winner) throw await unlistedHolder(box, bot, error.message, opts);
        return winner;
      }
    } finally {
      rpc.close();
    }
  }

  /**
   * The `CONFLICT` for a "Bot Chat" title held by a session the title lookup
   * does not return, rather than an endless create-collide-look retry.
   *
   * The lookup drops archived rows (`_session_list_by_title`,
   * `tui_gateway/methods_session.py:461-479` at v2026.9.24). Since Hermes
   * v2026.9.21 (b6207cb5903) a new Bot Chat's title write retires an archived
   * hidden holder's name in the same transaction (`hermes_state_titles.py:105-117`),
   * so this only happens there for a row that has not landed yet. An older
   * gateway keeps the archived holder's title, and every new Bot Chat collides
   * with it. An archived holder that is not hidden (archived in Hermes, not by
   * hermetic) keeps its title on every gateway: upstream releases only the two
   * together. Upstream's refusal names the holder ("already in use by session
   * <id>", `hermes_state_titles.py:119`), so its row is read for `archived` and
   * `hidden` and the hint says which case this is; when the row cannot be
   * read, it names both. A row with no `hidden` at all is read as hidden — the
   * flag is what hermetic archives with — so it gets the older-gateway hint.
   * Never auto-unarchived: an operator who archived that session did it on
   * purpose.
   */
  async function unlistedHolder(
    box: BoxAddress,
    bot: string,
    refusal: string,
    opts: HermesChatOptions,
  ): Promise<HermeticError> {
    const holder = /already in use by session ([A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9_])?)/.exec(
      refusal,
    )?.[1];
    const direct = `\`hermetic chat ${box.instance}/${bot} --session ${holder ?? "<id>"}\``;
    const row =
      holder === undefined
        ? undefined
        : await deps.read(box, holder, bot, opts).then(rec, () => undefined);
    const flag = (value: unknown) =>
      value === true || value === 1 ? true : value === false || value === 0 ? false : null;
    if (flag(row?.archived) === true && flag(row?.hidden) === false)
      return new HermeticError(
        "CONFLICT",
        `Bot Chat for ${bot} is held by archived session ${holder}, which still holds the title: Hermes releases an archived Bot Chat's title only when it is also hidden. Unarchive it in Hermes to resume it, retitle it there, or address it directly with ${direct}.`,
      );
    if (flag(row?.archived) === true)
      return new HermeticError(
        "CONFLICT",
        `Bot Chat for ${bot} is held by archived session ${holder}, whose title this gateway has not released (Hermes v2026.9.21 and later release an archived, hidden Bot Chat's title on the next claim). Unarchive it in Hermes to resume it, address it directly with ${direct}, or upgrade the gateway to Hermes v2026.9.21 or later.`,
      );
    const which = holder === undefined ? "a session" : `session ${holder}`;
    return new HermeticError(
      "CONFLICT",
      `Bot Chat for ${bot} is taken by ${which}, which this gateway does not list. If it is archived (a gateway older than Hermes v2026.9.21 keeps an archived Bot Chat's title), unarchive it in Hermes; otherwise address it directly with ${direct}, or free the title in Hermes.`,
    );
  }

  async function conversation(
    box: BoxAddress,
    bot: string,
    opts: ConversationOptions = {},
  ): Promise<ChatConversation | null> {
    if (opts.new_session && opts.session)
      throw new HermeticError("VALIDATION", "Choose an existing session or a new session, not both");
    if (!opts.create || opts.new_session || opts.session) return resolve(box, bot, opts);
    const key = JSON.stringify([box.baseUrl, bot]);
    const pending = flights.get(key);
    if (pending) return pending;
    const run = resolve(box, bot, opts);
    flights.set(key, run);
    try {
      return await run;
    } finally {
      if (flights.get(key) === run) flights.delete(key);
    }
  }

  async function compact(
    box: BoxAddress,
    bot: string,
    opts: ConversationOptions & { focus_topic?: string } = {},
  ) {
    const current = await conversation(box, bot, opts);
    if (!current) throw new HermeticError("NOT_FOUND", "This bot has no Bot Chat to compact");
    const rpc = await deps.connect(box, opts.signal);
    try {
      const resumed = rec(
        await rpc.request("session.resume", {
          profile: bot,
          source: HERMETIC_SESSION_SOURCE,
          session_id: current.session,
          defer_history: true,
          omit_messages: true,
        }),
      );
      const runtime = str(resumed?.session_id);
      if (!runtime) throw failure("Session resume returned no runtime identity");
      const result = rec(
        await rpc.request(
          "session.compress",
          {
            profile: bot,
            session_id: runtime,
            ...(opts.focus_topic ? { focus_topic: opts.focus_topic } : {}),
          },
          180_000,
        ),
      );
      const status = str(result?.status) ?? (result?.compressed === false ? "blocked" : "unknown");
      const refreshed = current.kind === "canonical" ? await find(rpc, box, bot) : current;
      return {
        conversation: refreshed ?? current,
        status,
        compressed: status === "compressed" || result?.compressed === true,
      };
    } finally {
      rpc.close();
    }
  }

  async function archive(box: BoxAddress, bot: string, session: string, opts: HermesChatOptions = {}) {
    const current = await conversation(box, bot, { ...opts, session });
    if (!current) throw new HermeticError("NOT_FOUND", "Session not found");
    // Retire the exact registry root without deleting history. No title: upstream refuses a
    // user rename of a hidden Bot Chat and applies `title` first, so it would 400 the whole
    // PATCH. The next Bot Chat's title write retires this archived hidden holder's name in
    // the same transaction (`hermes_state_titles.py`, v2026.9.24).
    const result = rec(
      await deps.patch(box, current.root_session, { profile: bot, archived: true, hidden: true }, opts),
    );
    if (result?.ok !== true || result.archived !== true)
      throw failure("Gateway did not confirm session archival");
    return { instance: box.instance, bot, session: current.root_session, archived: true as const };
  }

  async function respond(
    box: BoxAddress,
    input: ChatRespondInput,
    opts: HermesChatOptions = {},
  ): Promise<{ status: "ok" | "expired"; remaining?: string[] }> {
    const rpc = await deps.connect(box, opts.signal);
    try {
      // Rehydrate exact owner; never answer a request merely because its ID appeared in a browser.
      const snapshot = rec(
        await rpc.request("session.resume", {
          profile: input.bot,
          source: HERMETIC_SESSION_SOURCE,
          session_id: input.session,
          defer_history: true,
          omit_messages: true,
        }),
      );
      const runtime = str(snapshot?.session_id);
      if (!runtime) throw failure("Session resume returned no runtime identity");
      const method = input.kind === "approval" ? "approval" : "clarify";
      const pending = records(snapshot?.open_requests).find(
        (row) => String(row.id) === input.request_id && row.method === method,
      );
      if (!pending) {
        if (input.kind !== "approval") return { status: "expired" };
        const approvals = rec(
          await rpc.request("approval.pending", { profile: input.bot, session_id: runtime }),
        );
        if (!records(approvals?.approvals).some((row) => String(row.request_id) === input.request_id))
          return { status: "expired" };
        const result = rec(
          await rpc.request("approval.respond", {
            profile: input.bot,
            session_id: runtime,
            request_id: input.request_id,
            choice: input.choice,
          }),
        );
        return {
          status: typeof result?.resolved === "number" && result.resolved > 0 ? "ok" : "expired",
        };
      }
      const params = rec(pending.params);
      if (params?.session_id !== runtime)
        throw failure("Pending request does not belong to the selected session");
      if (input.kind === "question" && Array.isArray(params.questions)) {
        if (
          !input.question_id ||
          !records(params.questions).some((row) => row.qid === input.question_id)
        )
          throw new HermeticError("VALIDATION", "Choose the exact pending question");
        const result = rec(
          await rpc.request("clarify.lock", {
            profile: input.bot,
            request_id: input.request_id,
            question_id: input.question_id,
            answer: input.answer,
          }),
        );
        if (result?.status !== "ok" && result?.status !== "expired")
          throw failure("Gateway returned no question response status");
        return {
          status: result.status,
          ...(Array.isArray(result.remaining)
            ? { remaining: result.remaining.filter((v): v is string => typeof v === "string") }
            : {}),
        };
      }
      const result = rec(
        await rpc.request("request.answer", {
          profile: input.bot,
          id: input.request_id,
          result: input.kind === "approval" ? { choice: input.choice } : { answer: input.answer },
        }),
      );
      if (result?.status !== "ok" && result?.status !== "expired")
        throw failure("Gateway returned no request response status");
      return { status: result.status };
    } finally {
      rpc.close();
    }
  }
  return { conversation, compact, archive, respond };
}
