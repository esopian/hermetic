/** Stateful Bot Mode fixture. No transport or model calls; shared with the chat roster. */
import type { HermesChatClient, BoxAddress } from "../../chat/hermes/hermes-chat.ts";
import type { FixtureChatActivity } from "./fixture-chat.ts";
import type { Bot, ChatConversation, ChatMessage } from "../../schema/index.ts";
import { HermeticError } from "../../errors.ts";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

/**
 * The fixture box whose gateway is an older build.
 *
 * `bots.capabilities` reports what the gateway answered rather than what this
 * adapter can call, so the fixture needs a box that answers like a gateway
 * without hosted rooms or a dashboard job registry — otherwise every head, demo
 * and test only ever sees the everything-supported case, and the "this gateway
 * is too old" copy is never on screen. `kestrel` is the fixture's plain
 * reachable box with one default profile and nothing staged on it, so nothing
 * else in the fixture loses a scenario by it being the old one.
 */
export const FIXTURE_LEGACY_GATEWAY = "kestrel";
const isLegacyGateway = (instance: string): boolean => instance === FIXTURE_LEGACY_GATEWAY;
/**
 * `opts.activity` is the scripted external activity a fixture stages (§9.2). It
 * is optional and absent by default, so every existing caller is unchanged: with
 * it, a message that arrived from Hermes Desktop or a cron routine shows up in
 * a conversation *this wrapper owns*, and not only in a canned one nobody has
 * sent to.
 */
export function withFixtureBotMode(
  base: HermesChatClient,
  opts: { activity?: FixtureChatActivity | undefined } = {},
): HermesChatClient {
  let serial = 0;
  const profiles = new Map<string, Map<string, Record<string, unknown>>>(),
    rooms = new Map<string, Record<string, unknown>>(),
    logs = new Map<string, Record<string, unknown>[]>(),
    jobs = new Map<string, Record<string, unknown>[]>(),
    histories = new Map<string, Record<string, unknown>[]>();
  const retired = new Set<string>();
  const canonical = new Map<string, ChatConversation>(),
    transcripts = new Map<string, ChatMessage[]>();
  const now = () => new Date().toISOString();
  /**
   * When each bot last spoke here, and in which session.
   *
   * The fixture is the box, so this is the box's own coordinate — the pair
   * `chat.ts` attributes a turn by (`schema/chat.ts`'s `last_message_session`).
   * Without it a fixture turn is unattributable and the fixture portal
   * announces the operator's own reply back at them, which is the exact defect
   * the real path was fixed for.
   */
  const spoke = new Map<string, { at: string; session: string }>();
  const key = (box: BoxAddress, bot: string) => `${box.fleet_id ?? ""}/${box.instance}/${bot}`;
  async function roster(box: BoxAddress) {
    let map = profiles.get(key(box, ""));
    if (!map) {
      map = new Map(
        (await base.swarm(box)).bots.map((b) => [
          b.name,
          {
            name: b.name,
            description: b.description ?? "",
            soul: "",
            model: { provider: "fixture", default: b.model ?? "Fixture" },
            skills: [],
            toolsets: [],
            mcp_servers: [],
            is_default: b.is_default,
          },
        ]),
      );
      profiles.set(key(box, ""), map);
    }
    return map;
  }
  async function conversation(
    box: BoxAddress,
    bot: string,
    opts: Parameters<NonNullable<HermesChatClient["conversation"]>>[2] = {},
  ) {
    if (!(await base.swarm(box)).reachable)
      throw new HermeticError("CHAT_UNREACHABLE", `${box.instance}: fixture instance is unreachable`);
    if (!(await roster(box)).has(bot)) throw new HermeticError("NOT_FOUND", "Profile not found");
    const k = key(box, bot);
    let current = canonical.get(k);
    if (!current) {
      const sessions = await base.sessions(box, bot);
      const existing = sessions.find((s) => s.kind === "canonical" && !retired.has(`${k}/${s.id}`));
      if (existing) {
        current = {
          instance: box.instance,
          bot,
          root_session: existing.id,
          session: existing.id,
          kind: "canonical",
          created: false,
        };
        canonical.set(k, current);
      }
    }
    if (opts?.session) {
      if (current && [current.session, current.root_session].includes(opts.session)) return current;
      return {
        instance: box.instance,
        bot,
        root_session: opts.session,
        session: opts.session,
        kind: "thread" as const,
        created: false,
      };
    }
    if (opts?.new_session || (!current && opts?.create)) {
      const id = `fx-botchat-${++serial}`;
      current = {
        instance: box.instance,
        bot,
        root_session: id,
        session: id,
        kind: opts.new_session ? "thread" : "canonical",
        created: true,
      };
      transcripts.set(`${k}/${id}`, []);
      if (!opts.new_session) canonical.set(k, current);
    }
    return current ?? null;
  }
  async function rpc(box: BoxAddress, method: string, p: Record<string, unknown>): Promise<unknown> {
    const bots = await roster(box),
      name = String(p.name ?? p.profile ?? "default"),
      roomKey = key(box, String(p.room_id ?? ""));
    switch (method) {
      case "profiles.list":
        return { profiles: [...bots.values()], bot_mode_protocol: true };
      case "profiles.describe": {
        const bot = bots.get(name);
        if (!bot) throw new HermeticError("NOT_FOUND", "Profile not found");
        return bot;
      }
      case "profiles.create":
        if (bots.has(name)) throw new HermeticError("CONFLICT", "Profile already exists");
        bots.set(name, {
          name,
          description: p.description ?? "",
          soul: p.soul ?? "",
          model: { provider: p.provider ?? "fixture", default: p.model ?? "Fixture" },
          skills: [],
          toolsets: [],
          mcp_servers: [],
        });
        return { ok: true, name };
      case "profiles.configure": {
        const b = bots.get(name);
        if (!b) throw new HermeticError("NOT_FOUND", "Profile not found");
        Object.assign(b, {
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.soul !== undefined ? { soul: p.soul } : {}),
          ...(p.ui_meta !== undefined ? { ui_meta: p.ui_meta } : {}),
        });
        if (p.model !== undefined) b.model = { ...rec(b.model), default: p.model };
        return {
          ok: true,
          applied: Object.fromEntries(
            Object.keys(p)
              .filter((k) => k !== "name")
              .map((k) => [k, true]),
          ),
        };
      }
      case "groups.capabilities":
        if (isLegacyGateway(box.instance))
          return {
            protocol_version: 1,
            driver: false,
            persistent_process: false,
            authority_gateway_id: `fixture-${box.instance}`,
            room_link: { enabled: false, reason: "This gateway predates hosted rooms" },
            methods: [],
            features: [],
            max_log_limit: 0,
          };
        return {
          protocol_version: 2,
          driver: true,
          persistent_process: true,
          authority_gateway_id: `fixture-${box.instance}`,
          room_link: { enabled: false, reason: "RoomLink is not configured in fixture mode" },
          max_log_limit: 500,
          methods: [
            "groups.create",
            "groups.list",
            "groups.state",
            "groups.log",
            "groups.send",
            "groups.rename",
            "groups.stop",
            "groups.approve",
            "groups.disband",
          ],
          // The list `tui_gateway/methods_groups.py` returns at Hermes
          // v2026.9.14, so a head reading `room_features` in fixture mode sees
          // the same strings a real gateway of that build advertises.
          features: [
            "authority_epoch",
            "coordinator_fencing",
            "room_identity",
            "monotonic_log",
            "idempotent_send",
            "replayable_disband",
            "typed_events",
            "actor_identity",
            "log_replication",
            "authority_takeover",
          ],
        };
      case "groups.list":
        return {
          rooms: [...rooms.entries()]
            .filter(([k, r]) => k.startsWith(key(box, "")) && !r.disbanded_at)
            .map(([, r]) => r),
          next_offset: null,
        };
      case "groups.create": {
        if (!rooms.has(roomKey))
          rooms.set(roomKey, {
            room_id: p.room_id,
            name: p.name,
            members: p.members,
            revision: 1,
            latest_seq: 0,
            created_at: Date.now() / 1000,
            updated_at: Date.now() / 1000,
            disbanded_at: null,
          });
        return { room: rooms.get(roomKey) };
      }
      case "groups.state": {
        const r = rooms.get(roomKey);
        if (!r || r.disbanded_at) throw new HermeticError("NOT_FOUND", "Room not found");
        return { room: r, driver_status: { working: false, blocked: false, pending_actions: [] } };
      }
      case "groups.rename": {
        const r = rooms.get(roomKey);
        if (!r) throw new HermeticError("NOT_FOUND", "Room not found");
        r.name = p.name;
        return { room: r };
      }
      case "groups.disband": {
        const r = rooms.get(roomKey);
        if (!r) throw new HermeticError("NOT_FOUND", "Room not found");
        r.disbanded_at = Date.now() / 1000;
        return { tombstone: r };
      }
      case "groups.log": {
        const all = logs.get(roomKey) ?? [];
        const events = all.filter((e) => Number(e.seq) > Number(p.since_seq ?? 0));
        const page = events.slice(0, Number(p.limit ?? 200));
        return {
          events: page,
          cursor: page.at(-1)?.seq ?? p.since_seq ?? 0,
          // The room's high-water mark, reported on every page including an
          // empty one, the way `read_events` reports it upstream. It is what a
          // client aims a tail read at, so a fixture that dropped it would let
          // a first-paint bug through.
          latest_seq: Number(all.at(-1)?.seq ?? 0),
          has_more: events.length > page.length,
        };
      }
      case "groups.send": {
        const r = rooms.get(roomKey);
        if (!r || r.disbanded_at) throw new HermeticError("NOT_FOUND", "Room not found");
        const events = logs.get(roomKey) ?? [];
        const held = events.find((e) => e.event_id === p.event_id);
        if (held) {
          // Upstream is idempotent on identical content and fails closed on
          // different content under the same id. Both answers are load-bearing
          // for the head, so the fixture gives both.
          if (rec(held.payload).text !== rec(p.payload).text)
            throw new HermeticError(
              "CHAT_PROTOCOL",
              `${box.instance}: event_id already exists with different content`,
            );
          return { accepted: true, event: { ...held, idempotent: true } };
        }
        const append = (kind: string, text: string, member_id?: string) =>
          events.push({
            room_id: p.room_id,
            seq: events.length + 1,
            event_id: member_id ? `${p.event_id}-${member_id}` : p.event_id,
            kind,
            actor: { kind: member_id ? "member" : "user", id: member_id ?? "operator" },
            payload: { text, ...(member_id ? { member_id } : {}) },
            created_at: Date.now() / 1000,
          });
        append("message.user", String(rec(p.payload).text));
        for (const m of rows(r.members))
          append(
            "message.member",
            `${m.display_name}: fixture response to the shared discussion.`,
            String(m.member_id),
          );
        logs.set(roomKey, events);
        r.latest_seq = events.length;
        return {
          accepted: true,
          event: { ...events.find((e) => e.event_id === p.event_id), idempotent: false },
        };
      }
      case "groups.stop":
      case "groups.retry":
      case "groups.approve":
        return { ok: true, cancelled: 0, retried: true, approved: true };
      default:
        throw new HermeticError("CHAT_PROTOCOL", `Unsupported fixture operation ${method}`);
    }
  }
  async function rest(box: BoxAddress, method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, "http://fixture"),
      p = rec(body),
      bot = url.searchParams.get("profile") ?? "default",
      k = key(box, bot),
      list = jobs.get(k) ?? [];
    jobs.set(k, list);
    // The old build has no `/api/cron/*` router at all, so it answers the way a
    // FastAPI app answers an unrouted path: 404, which `botModeRest` maps to
    // `NOT_FOUND` and `capabilities` reads as "routines unsupported".
    if (url.pathname.startsWith("/api/cron/") && isLegacyGateway(box.instance))
      throw new HermeticError("NOT_FOUND", `${box.instance}: dashboard GET failed (HTTP 404)`);
    if (url.pathname.startsWith("/api/profiles/") && method === "DELETE") {
      (await roster(box)).delete(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      return { ok: true };
    }
    const parts = url.pathname.split("/"),
      id = parts[4],
      action = parts[5];
    if (!id) {
      if (method === "GET") return list;
      if (method === "POST") {
        const job = {
          ...p,
          id: `job-${++serial}`,
          enabled: true,
          state: "scheduled",
          next_run_at: now(),
        };
        list.push(job);
        return job;
      }
    }
    const job = list.find((j) => j.id === id);
    if (!job) throw new HermeticError("NOT_FOUND", "Job not found");
    if (action === "runs") return { runs: histories.get(`${k}/${id}`) ?? [] };
    if (method === "DELETE") {
      list.splice(list.indexOf(job), 1);
      return { ok: true };
    }
    if (method === "PUT") Object.assign(job, rec(p.updates));
    if (action === "pause") {
      job.enabled = false;
      job.state = "paused";
    }
    if (action === "resume") {
      job.enabled = true;
      job.state = "scheduled";
    }
    if (action === "trigger") {
      job.enabled = true;
      job.state = "scheduled";
      job.last_run_at = now();
      job.last_status = "completed";
      const runs = histories.get(`${k}/${id}`) ?? [];
      runs.unshift({
        id: `run-${++serial}`,
        status: "completed",
        started_at: now(),
        title: "Fixture job completed",
      });
      histories.set(`${k}/${id}`, runs);
    }
    return job;
  }
  return {
    ...base,
    botModeRpc: rpc,
    botModeRest: rest,
    conversation,
    async sessions(box, bot, opts) {
      const original = await base.sessions(box, bot, opts);
      const k = key(box, bot);
      const c = canonical.get(k);
      const found = original.map((s) =>
        retired.has(`${k}/${s.id}`)
          ? { ...s, kind: "thread" as const, title: `Archived ${s.title}` }
          : s,
      );
      for (const stored of transcripts.keys()) {
        if (!stored.startsWith(`${k}/`)) continue;
        const id = stored.slice(k.length + 1);
        if (found.some((s) => s.id === id)) continue;
        found.push({
          id,
          instance: box.instance,
          bot,
          kind: c?.session === id ? "canonical" : "thread",
          origin: "portal",
          title: c?.session === id ? "Bot Chat" : "Additional chat",
          unread: 0,
          turn_count: (transcripts.get(stored) ?? []).length,
          last_message_at: now(),
        });
      }
      return found;
    },
    send(box, bot, text, opts = {}) {
      return (async function* () {
        const c = await conversation(box, bot, { ...opts, create: true });
        const session = opts.session ?? c?.session ?? "fixture";
        const k = `${key(box, bot)}/${session}`;
        const messages = transcripts.get(k) ?? (await base.history(box, bot, { session }));
        messages.push({
          id: `user-${++serial}`,
          session,
          role: "user",
          at: now(),
          blocks: [{ kind: "text", markdown: text }],
        });
        transcripts.set(k, messages);
        let answer = "";
        for await (const frame of base.send(box, bot, text, opts)) {
          if (frame.type === "delta") answer += frame.text;
          if (frame.type === "done") {
            const at = now();
            messages.push({
              id: frame.message,
              session,
              role: "bot",
              at,
              blocks: [{ kind: "text", markdown: answer }],
            });
            spoke.set(key(box, bot), { at, session });
          }
          yield frame;
        }
      })();
    },
    async swarm(box, opts) {
      const original = await base.swarm(box, opts),
        map = await roster(box);
      const bots: Bot[] = [...map.values()].map((p) => {
        const existing = original.bots.find((b) => b.name === p.name);
        const said = spoke.get(key(box, String(p.name)));
        return {
          ...(existing ?? original.bots[0]),
          name: String(p.name),
          instance: box.instance,
          title: existing?.title ?? String(p.name),
          description: String(p.description ?? ""),
          model: String(rec(p.model).default ?? "Fixture"),
          is_default: p.name === "default",
          avatar_seed: key(box, String(p.name)),
          section: null,
          last_message_at: said?.at ?? existing?.last_message_at ?? null,
          last_message_session: said?.session ?? existing?.last_message_session ?? null,
          unread: 0,
          needs_action: false,
          muted: false,
          warm: false,
        } as Bot;
      });
      return {
        ...original,
        bots,
        rooms: [...rooms.entries()]
          .filter(([k, r]) => k.startsWith(key(box, "")) && !r.disbanded_at)
          .map(([, r]) => ({
            id: String(r.room_id),
            name: String(r.name),
            instance: box.instance,
            members: rows(r.members).map((m) => ({ instance: box.instance, bot: String(m.profile) })),
            needs_action: false,
          })),
      };
    },
    async history(box, bot, historyOpts = {}) {
      const c = await conversation(box, bot, historyOpts);
      const id = historyOpts.session ?? c?.session;
      const owned = id === undefined ? undefined : transcripts.get(`${key(box, bot)}/${id}`);
      if (id === undefined || owned === undefined) return base.history(box, bot, historyOpts);
      const extras = opts.activity?.extras({ instance: box.instance, bot }, id) ?? [];
      const known = new Set(owned.map((m) => m.id));
      return [...owned, ...extras.filter((m) => !known.has(m.id))];
    },
    async compact(box, bot, opts = {}) {
      const c = await conversation(box, bot, opts);
      if (!c) throw new HermeticError("NOT_FOUND", "No Bot Chat");
      return { conversation: c, status: "compressed", compressed: true };
    },
    async archive(box, bot, session) {
      const c = await conversation(box, bot, { session });
      retired.add(`${key(box, bot)}/${session}`);
      if (c?.kind === "canonical") canonical.delete(key(box, bot));
      return { instance: box.instance, bot, session, archived: true };
    },
    async respond() {
      return { status: "ok" };
    },
  };
}
