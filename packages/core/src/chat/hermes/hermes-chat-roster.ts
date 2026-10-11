/**
 * The roster: profiles, rooms and warm processes, read in one pass and mapped
 * onto `schema/chat.ts`'s `Swarm`.
 *
 * `chat.swarm` answers even when the box does not — transport failure is a
 * value here, not a throw, because a rail drawing thirteen boxes must not go
 * blank for one that is off the tailnet.
 */
import { checkAbort } from "../../abort.ts";
import {
  WARM_SLOTS_PER_GATEWAY,
  type BoxAddress,
  type HermesChatOptions,
} from "./hermes-chat-types.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import { eventPreviewOf, mapSessions } from "./hermes-chat-sessions.ts";
import { arr, describe, isHermeticCode, isoOrNull, num, rec, str } from "./hermes-chat-wire.ts";
import type { Bot, BotRef, Room, Swarm } from "../../schema/index.ts";

/** How many pages of `groups.list` to follow before deciding the box is looping. */
const MAX_ROOM_PAGES = 20;

/** What `createChatRoster` needs, and nothing more. */
export interface ChatRosterDeps {
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
}

export function createChatRoster(deps: ChatRosterDeps) {
  /**
   * The roster, which **answers even when the box does not**.
   *
   * `Swarm` carries `reachable`/`unreachable_reason` because the rail has to
   * draw a box that is off the tailnet, stopped, or still booting — a thrown
   * error there would blank the whole rail for one bad box out of thirteen. So
   * transport failure is a *value* here, and only an abort throws.
   */
  async function swarm(box: BoxAddress, opts: HermesChatOptions = {}): Promise<Swarm> {
    checkAbort(opts.signal, "chat.swarm");
    let rpc: Rpc;
    try {
      rpc = await deps.connect(box, opts.signal);
    } catch (e) {
      if (isHermeticCode(e, "ABORTED")) throw e;
      return unreachable(box, describe(e));
    }
    try {
      const profiles = await rpc.request("profiles.list", {});
      // Rooms and live processes are extras: a box that answers `profiles.list`
      // and refuses `groups.list` still has a renderable roster, and an older
      // Hermes that has never heard of one of them must not cost the operator
      // the other two.
      const groups = await allRooms(rpc);
      const agents = await rpc.request("agents.list", {}).catch(() => null);

      /**
       * The watermark comes from `profiles.list`, which was already being read
       * for the bot list: each profile row carries a `last_session` with
       * `last_active`, which is "when did this bot last speak", already
       * attributed to the bot, for no extra round trip and no attribution
       * guess. Captured live from `silent-crane` (0.21.3) — see
       * `test/fixtures/probe-session-list.json`.
       *
       * `session.list` is the fallback, and only the fallback. It is one extra
       * metadata read — no backend opened, no turn run, no warm slot taken
       * (§9.2) — and it fires only when no profile row carried a watermark at
       * all, which on a current box never happens. It is worth keeping because
       * its rows do not name a profile, so on a box whose Hermes predates
       * `last_session` a swarm of one still gets a usable watermark; on a larger
       * swarm it would attribute everything to the default bot, which is why it
       * is second and not first.
       */
      const roster = mapSwarm(box, profiles, groups, agents, null);
      if (roster.bots.length === 0 || roster.bots.some((b) => b.last_message_at !== null)) {
        return roster;
      }
      const sessions = await rpc.request("session.list", {}).catch(() => null);
      return sessions === null ? roster : mapSwarm(box, profiles, groups, agents, sessions);
    } catch (e) {
      if (isHermeticCode(e, "ABORTED")) throw e;
      return unreachable(box, describe(e));
    } finally {
      rpc.close();
    }
  }

  /**
   * Every room, not merely the first page of them.
   *
   * `groups.list` answers `{"rooms": [...], "next_offset": …}`, and a
   * `next_offset` that is not null means there is more. Every box probed so far
   * has answered `{"rooms": [], "next_offset": null}`, so the paging branch has
   * never run against a real payload — which is exactly why it is written to
   * keep what it already has rather than to be clever: a refused follow-up page,
   * an offset that does not advance, or more pages than any plausible fleet has,
   * and it stops and returns the rooms collected so far. Reading page one and
   * calling it the roster would have been the silent version of the same bug.
   */
  async function allRooms(rpc: Rpc): Promise<unknown> {
    const first = await rpc.request("groups.list", {}).catch(() => null);
    if (first === null) return null;
    const rooms: unknown[] = [...arr(rec(first)?.rooms)];
    let offset = rec(first)?.next_offset ?? null;
    for (let page = 0; offset !== null && page < MAX_ROOM_PAGES; page += 1) {
      const next = rec(await rpc.request("groups.list", { offset }).catch(() => null));
      if (next === null) break;
      rooms.push(...arr(next.rooms));
      const advanced = next.next_offset ?? null;
      // An offset that did not move is a box that will hand back page one
      // forever; stopping beats spinning.
      if (advanced === offset) break;
      offset = advanced;
    }
    return { rooms };
  }
  return { swarm };
}

/**
 * The roster.
 *
 * Every read here is a guess that has to survive being wrong, because the box
 * the probe reached had exactly one profile, no rooms and no live processes
 * (§8.1) — the shapes of a *populated* roster were read from upstream's source,
 * not observed. Every field falls back rather than throwing.
 */
export function mapSwarm(
  box: BoxAddress,
  profiles: unknown,
  groups: unknown,
  agents: unknown,
  sessions: unknown,
): Swarm {
  const processes = arr(rec(agents)?.processes);
  // A profile is warm when a live process names it. Upstream reports the live
  // set but not the limit, so `used` is observed and `total` is unknown.
  const warm = new Set<string>();
  for (const p of processes) {
    const row = rec(p);
    const name = str(row?.profile) ?? str(row?.profile_name) ?? str(row?.name);
    if (name) warm.add(name);
  }

  const rows = arr(rec(profiles)?.profiles);

  /**
   * The name of the profile that *is* `$HERMES_HOME`, which is where a session
   * that names no profile belongs.
   *
   * `default` creates no `profiles/` entry on disk, so on every box probed so
   * far it is the only profile there is and every session is its. Attributing
   * an unnamed session to it is therefore right in the case that exists today
   * and, on a larger swarm, wrong only in the direction of a watermark that is
   * too recent for one bot rather than absent for all of them.
   */
  const parsed = rows.map(rec);
  const fallbackBot =
    str(parsed.find((row) => row?.is_default === true)?.name) ?? str(parsed[0]?.name) ?? "default";

  /**
   * When each bot last spoke, from the session list — the **fallback** source.
   *
   * The primary is the profile row's own session summaries — `last_session`
   * and `canonical_session` (see `botWatermark`).
   * This fold exists for a box whose Hermes does not carry one, and it is
   * weaker in a way worth naming: a real `session.list` row names no profile at
   * all — captured live, the fields are `id`, `title`, `preview`, `started_at`,
   * `message_count`, `source` and nothing else — so every session here lands on
   * the default bot. On a swarm of one, which is every box probed, that is
   * exactly right. On a larger swarm it would over-attribute, which is why it
   * only runs when the primary gave nothing.
   *
   * Why either exists at all: the `chat.message` source (§4.9) raises a
   * notification by diffing this field against a stored watermark on every
   * roster read, so a
   * hardcoded null is not "unknown", it is "this bot has never spoken", forever,
   * for every bot. No notification can fire and two dependent branches go dead.
   */
  const lastSpoke = new Map<string, Watermark>();
  for (const session of mapSessions(box, fallbackBot, sessions)) {
    const at = session.last_message_at;
    if (!at) continue;
    const seen = lastSpoke.get(session.bot);
    // `Iso` is always UTC with milliseconds, so lexical order is chronological.
    if (seen === undefined || at > seen.at) lastSpoke.set(session.bot, { at, session: session.id });
  }

  const bots: Bot[] = [];
  for (const entry of rows) {
    const row = rec(entry);
    const name = str(row?.name);
    if (!name) continue;
    // Read once: the timestamp and the session id must never come from two
    // different evaluations, let alone two different sources.
    const watermark = watermarkOf(row, lastSpoke.get(name));
    bots.push({
      instance: box.instance,
      name,
      title: profileTitle(row, name),
      description: str(row?.description) || null,
      is_default: row?.is_default === true,
      model: str(row?.model),
      // Upstream has no notion of the operator's own grouping; §9.2's sections
      // are hermetic's, stored locally, and merged in above this adapter.
      section: null,
      avatar_seed: avatarSeed(box, name),
      /**
       * The box's fact, not the laptop's.
       *
       * This used to sit in the group below, justified alongside `unread` and
       * `muted` as per-operator state that the box does not know. That was
       * wrong, and the wrongness was load-bearing: when a bot last spoke is
       * something only the box can answer, and calling it local is what left it
       * hardcoded to null and silently killed the `chat.message` source.
       */
      last_message_at: watermark?.at ?? null,
      /**
       * Which session that timestamp came from, so a turn can tell its own
       * reply from a message that arrived while it ran (`schema/chat.ts`).
       * Read off the same summary as the timestamp — never matched back from a
       * second call, which maps a different field and gives a different number.
       */
      last_message_session: watermark?.session ?? null,
      /**
       * Free, from the roster read that was already happening: the profile row's
       * `last_session` carries `preview` beside `last_active`. §9.2 rules out the
       * alternative — a history read per bot per repaint takes a warm slot, and a
       * read that takes a warm slot is not one this design can do thirteen times.
       *
       * The session fold cannot supply it, because a `session.list` row names no
       * profile (see `lastSpoke`), so a bot on a Hermes too old to send
       * `last_session` gets a watermark but no preview rather than somebody
       * else's words.
       */
      ...botPreview(row),
      /**
       * These two *are* per-operator state, living in local SQLite (§9.2).
       * Whether this laptop has read a message, and whether this operator has
       * muted a bot, are this laptop's opinions; the box has never been told
       * either. Zero is what it said, not a guess standing in for what it did
       * not say. `needs_action` is the same: it is raised above this adapter
       * from an `approval` or `question` block, never reported by the roster.
       */
      unread: 0,
      needs_action: false,
      muted: false,
      warm: warm.has(name),
    });
  }

  const rooms: Room[] = [];
  for (const entry of arr(rec(groups)?.rooms)) {
    const row = rec(entry);
    const id = str(row?.id) ?? str(row?.room_id);
    if (!id) continue;
    rooms.push({
      id,
      name: str(row?.name) ?? str(row?.title) ?? id,
      instance: box.instance,
      members: arr(row?.members ?? row?.participants).flatMap((m) => memberRef(box, m)),
      round: roundOf(rec(row?.round)),
      needs_action: row?.needs_action === true,
    });
  }

  return {
    instance: box.instance,
    reachable: true,
    unreachable_reason: null,
    bots,
    rooms,
    warm_slots: {
      used: warm.size,
      total: WARM_SLOTS_PER_GATEWAY,
    },
    sections: [],
  };
}

/**
 * When this bot last spoke, from its own profile row.
 *
 * `profiles.list` carries a `last_session` object per profile, and it is the
 * right source for the roster: already attributed to the bot, already in the
 * call the bot list needs anyway, no grouping and no guess. Captured verbatim
 * from a live 0.21.3 box in `test/fixtures/probe-session-list.json`:
 *
 *     "last_session": { "id": …, "title": …, "preview": …,
 *                       "started_at": 1789663310.4430764,
 *                       "last_active": 1789663313.0670137, "message_count": 2 }
 *
 * `last_active` is the field that means what this schema field means.
 * `started_at` is when the conversation *opened*, so it is a floor rather than
 * a watermark — a bot mid-way through a long session looks quieter than it is —
 * and it is taken only when `last_active` is absent, because a floor beats a
 * null that reads as "never spoke".
 */
function botWatermark(row: Record<string, unknown> | null): Watermark | null {
  /**
   * Both sessions, not merely `last_session`. A live 0.21.3 box answers
   * `profiles.list` with a `canonical_session` beside `last_session`, and
   * `last_session` is the most recent session that *has messages* — so a bot
   * whose only recent words are in Bot Chat can have a canonical watermark
   * newer than `last_session`'s, which is exactly the turn the `chat.message`
   * source must notice.
   *
   * A session with no messages contributes nothing: `started_at` on an empty
   * Bot Chat is when the portal *created* it, and reporting that as "this bot
   * spoke" would raise a notification for a conversation nobody has said
   * anything in. Observed on `silent-crane/clown`, whose canonical session is
   * `message_count: 0` and newer than every session it has ever spoken in.
   */
  const stamps = [rec(row?.last_session), rec(row?.canonical_session)]
    .filter((s): s is Record<string, unknown> => s !== null && spoke(s))
    .map((s) => ({ at: isoOrNull(s.last_active ?? s.updated_at ?? s.started_at), session: str(s.id) }))
    .filter((s): s is Watermark => s.at !== null);
  // `Iso` is always UTC with milliseconds, so lexical order is chronological.
  return stamps.length === 0 ? null : stamps.reduce((a, b) => (a.at > b.at ? a : b));
}

/**
 * A bot's coordinate and the conversation it was read from, carried together
 * because neither is usable without the other (`schema/chat.ts`'s
 * `last_message_session`).
 */
interface Watermark {
  at: string;
  session: string | null;
}

/**
 * The profile row's own summary, or the session fold when it has none.
 *
 * One function rather than two `??` chains, so the timestamp and the session id
 * can never come from different sources — which is the whole point of carrying
 * the id at all.
 */
function watermarkOf(
  row: Record<string, unknown> | null,
  fallback: Watermark | undefined,
): Watermark | null {
  return botWatermark(row) ?? fallback ?? null;
}

/** Whether a session summary describes a conversation anything was said in. */
function spoke(session: Record<string, unknown>): boolean {
  const count = num(session.message_count) ?? num(session.turn_count);
  return count === null ? true : count > 0;
}

/**
 * The opening words of **the canonical Bot Chat**, which is the conversation
 * this rail entry opens (§9.2: the rail separates Bots — canonical Bot Chat —
 * from Sessions).
 *
 * `last_session` is the bot's most recent session of *any* kind, so quoting it
 * here put a room's or a CLI thread's words under a rail entry that opens Bot
 * Chat: `silent-crane/clown` showed "Received loud and clear, five by five…"
 * beside a Bot Chat with nothing in it. The preview has to describe the
 * conversation the click leads to, or it is a quote from somewhere the operator
 * cannot get to from here.
 *
 * `last_session` survives only as the fallback for a gateway that names no
 * canonical session at all — an older Hermes, where it is the only preview
 * there is. A canonical session that is present and empty previews as nothing,
 * which is what the thread itself says.
 *
 * A preview that opens with a background-process notice reads as the event
 * (`eventPreview`), never as the raw `[IMPORTANT: …` Hermes stored as the
 * user's row. The role travels with it only when that rewrite proves one;
 * upstream's own preview names none (`Bot.preview_role`).
 */
function botPreview(row: Record<string, unknown> | null): Pick<Bot, "preview" | "preview_role"> {
  const canonical = rec(row?.canonical_session);
  if (canonical) return eventPreviewOf(str(canonical.preview));
  return eventPreviewOf(str(rec(row?.last_session)?.preview));
}

/**
 * The name a profile row presents, in Hermes Desktop's precedence
 * (`apps/desktop/src/plugins/hermes-bots/labels.ts` `displayName` at
 * `v2026.9.24`): the Bot Mode title an operator set (`ui_meta['hermes-bots']
 * .title`, what `bots.update` writes), then the core profile's `display_name`,
 * then the profile name. Desktop's last two steps — "Hermes" for `default` and
 * title-casing — are presentation, and hermetic's heads present the raw name
 * (`botLabel`). `display_name` is the empty string far more often than it is
 * absent, which is why every step is a trimmed truthiness check.
 */
export function profileTitle(row: Record<string, unknown> | null, name: string): string {
  const meta = rec(rec(row?.ui_meta)?.["hermes-bots"]);
  const pick = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return pick(meta?.title) || pick(row?.display_name) || pick(row?.title) || name;
}

function unreachable(box: BoxAddress, reason: string): Swarm {
  return {
    instance: box.instance,
    reachable: false,
    unreachable_reason: reason,
    bots: [],
    rooms: [],
    warm_slots: { used: 0, total: WARM_SLOTS_PER_GATEWAY },
    sections: [],
  };
}

/**
 * §9.2's identity key. Seeded from the fleet, the instance and the bot name and
 * never from the display title, so renaming a bot does not change its face.
 */
function avatarSeed(box: BoxAddress, bot: string): string {
  return [box.fleet_id, box.instance, bot].filter((p): p is string => Boolean(p)).join("/");
}

export function memberRef(box: BoxAddress, member: unknown): BotRef[] {
  if (typeof member === "string" && member) return [{ instance: box.instance, bot: member }];
  const row = rec(member);
  const bot = str(row?.bot) ?? str(row?.name) ?? str(row?.profile);
  if (!bot) return [];
  return [{ instance: str(row?.instance) ?? box.instance, bot }];
}

function roundOf(round: Record<string, unknown> | null): { n: number; of: number } | null {
  if (!round) return null;
  const n = num(round.n) ?? num(round.index);
  const of = num(round.of) ?? num(round.total);
  if (n === null || of === null) return null;
  return { n: Math.trunc(n), of: Math.trunc(of) };
}
