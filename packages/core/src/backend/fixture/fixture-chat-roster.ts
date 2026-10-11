/**
 * The fixture swarm's roster: which boxes exist, which bots
 * they run, and the sessions each one holds. Pure data, timestamped against the
 * one clock `at` spells out, for the reasons `fixture-chat.ts`'s header gives.
 *
 * Split out of `fixture-chat.ts` (AGENTS.md rule 5) beside the transcripts in
 * `fixture-chat-catalog.ts`; `fixture-chat.test.ts` walks both.
 */
import type { BoxAddress } from "../../chat/hermes/hermes-chat.ts";
import type { Bot, Room, Session, Swarm } from "../../schema/index.ts";

/** Illustrative capacity for fixture rendering only. Live capacity is unknown. */
export const FIXTURE_WARM_SLOTS = 3;

/* ── the clock that does not move ─────────────────────────────────────────── */

/**
 * The fixture's "today". Every timestamp below is written out relative to it by
 * hand rather than computed, because a computed one is a second clock and the
 * point of this constant is that there is only one.
 */
const DAY = "2026-09-17";

export const at = (time: string): string => `${DAY}T${time}.000Z`;

/* ── the roster ───────────────────────────────────────────────────────────── */

/**
 * `avatar_seed` is `fleet_id/instance/bot` (§9.2), and the fleet is part of it
 * so that two fleets' `default@atlas` do not wear the same face. The adapter
 * derives it from the `BoxAddress` it was handed; so does this, from the same
 * address, rather than baking a fleet id into the table — the fixture seeds two
 * fleets (`fxtr0001` and `sg7k2m4p`) and `ember` exists on both.
 */
const seedOf = (box: BoxAddress, bot: string): string =>
  [box.fleet_id, box.instance, bot].filter((part): part is string => Boolean(part)).join("/");

/**
 * A bot, minus the two fields that cannot be written down: `instance`, which is
 * whichever box asked, and `avatar_seed`, which is derived from it.
 */
interface BotSpec extends Omit<Bot, "instance" | "avatar_seed"> {}

/** Everything a bot is when nothing is going on with it. */
const QUIET = {
  description: null,
  section: null,
  unread: 0,
  needs_action: false,
  muted: false,
  warm: false,
} as const;

interface SwarmSpec {
  reachable: boolean;
  unreachable_reason?: string;
  bots: readonly BotSpec[];
  rooms?: readonly Omit<Room, "instance">[];
  /** Slots the gateway has handed out right now; the total is upstream's ~3. */
  used: number;
  sections?: readonly string[];
}

/**
 * The bot every box has: the profile that *is* `$HERMES_HOME`. Its title is the
 * instance name, which is why it is a function.
 */
const defaultBot = (instance: string, over: Partial<BotSpec> = {}): BotSpec => ({
  ...QUIET,
  name: "default",
  title: instance,
  is_default: true,
  model: "claude-sonnet-5",
  last_message_at: null,
  ...over,
});

/**
 * One entry per instance the fixture fleets seed, keyed by agent name.
 *
 * Three of them are deliberately unreachable, because a rail with no offline
 * bucket in it is a rail whose `.ch-bucket.offline` styling nobody has seen.
 * They are the three agents the fleet fixture already has a reason for: `heron`
 * stopped on a failed bootstrap stage, and `juniper` and `quill` are stopped
 * instances. Anything not listed gets `THIN` — an agent created during a
 * fixture session is a real box with a default profile on it and nothing else.
 */
const SWARMS: Readonly<Record<string, SwarmSpec>> = {
  /**
   * The busy box. Four bots across two operator sections, two of the gateway's
   * three slots warm, and the long transcript.
   */
  atlas: {
    reachable: true,
    used: 2,
    sections: ["Team", "Clients"],
    bots: [
      defaultBot("atlas", { warm: true, last_message_at: at("09:31:40"), model: "claude-sonnet-5" }),
      {
        ...QUIET,
        name: "scribe",
        // Friendly titles that are not the profile name, so a rename, a reset
        // and an @mention by title are all distinguishable from the handle.
        title: "Marshall",
        description: "Writes the morning digest and files it in the run log.",
        is_default: false,
        model: "claude-haiku-4-5",
        section: "Team",
        last_message_at: at("06:00:12"),
        warm: true,
        unread: 2,
      },
      {
        ...QUIET,
        name: "auditor",
        title: "NickQABot",
        description: "Reads the Bedrock grant and complains about it.",
        is_default: false,
        model: "us.anthropic.claude-sonnet-5",
        section: "Team",
        last_message_at: at("08:14:03"),
        needs_action: true,
        unread: 1,
      },
      {
        ...QUIET,
        name: "clio",
        title: "Clio",
        description: "The account bot. Answers in #acme-support, not here.",
        is_default: false,
        model: "claude-haiku-4-5",
        section: "Clients",
        last_message_at: at("07:52:30"),
        muted: true,
      },
    ],
  },
  /**
   * The box at its limit: four bots want a backend and the gateway has three.
   * That gap is the only way to seed the rail's third slot state — `used ===
   * total` with a bot still flagged warm is a bot *queued*, which upstream
   * resolves by making it wait up to thirty seconds and then failing the open
   * (§9.2). Without it the rail only ever draws `on` and empty.
   */
  corvid: {
    reachable: true,
    used: FIXTURE_WARM_SLOTS,
    sections: ["Ops", "Clients"],
    bots: [
      defaultBot("corvid", { warm: true, last_message_at: at("09:12:55") }),
      {
        ...QUIET,
        name: "rook",
        title: "Rook",
        description: "Drives the triage room and pages the others into it.",
        is_default: false,
        model: "claude-sonnet-5",
        section: "Ops",
        last_message_at: at("09:20:18"),
        warm: true,
      },
      {
        ...QUIET,
        name: "magpie",
        title: "Magpie",
        is_default: false,
        model: "claude-sonnet-5",
        section: "Clients",
        last_message_at: at("08:47:02"),
        warm: true,
        needs_action: true,
        unread: 4,
      },
      {
        ...QUIET,
        name: "wren",
        title: "Wren",
        description: "Waiting for a warm slot behind the other three.",
        is_default: false,
        model: "claude-haiku-4-5",
        section: "Ops",
        last_message_at: at("09:21:44"),
        warm: true,
      },
    ],
    rooms: [
      {
        id: "rm-corvid-triage",
        name: "#triage",
        members: [
          { instance: "corvid", bot: "default" },
          { instance: "corvid", bot: "rook" },
          { instance: "corvid", bot: "magpie" },
        ],
        round: { n: 2, of: 3 },
        needs_action: false,
      },
    ],
  },
  /**
   * The degraded box. Its fleet row has `hermes: false`, so the gateway is
   * answering and holding nothing: `0/3`, which is the empty end of the slot
   * readout and the bucket an operator is most likely to click on.
   */
  ember: {
    reachable: true,
    used: 0,
    bots: [defaultBot("ember", { last_message_at: at("09:31:02"), needs_action: true, unread: 1 })],
  },
  /** One slot warm, one room that is asking for something. */
  granite: {
    reachable: true,
    used: 1,
    bots: [
      defaultBot("granite", { warm: true, last_message_at: at("09:05:19") }),
      {
        ...QUIET,
        name: "quarry",
        title: "Quarry",
        description: "Runs the release checklist from cron and from the CLI.",
        is_default: false,
        model: "claude-sonnet-5",
        last_message_at: at("04:30:00"),
      },
    ],
    rooms: [
      {
        id: "rm-granite-release",
        name: "#release",
        members: [
          { instance: "granite", bot: "default" },
          { instance: "granite", bot: "quarry" },
        ],
        round: null,
        needs_action: true,
      },
    ],
  },
  /**
   * The background-process box: its Bot Chat is the event transcript
   * (`fixture-chat-process-events.ts`), and `lead-qa` is the bot its DM went to.
   */
  kestrel: {
    reachable: true,
    used: 1,
    bots: [
      defaultBot("kestrel", { warm: true, last_message_at: at("08:58:41") }),
      {
        ...QUIET,
        name: "lead-qa",
        title: "lead-qa",
        description: "Checks release claims before they reach the wiki",
        is_default: false,
        model: "claude-sonnet-5",
        last_message_at: null,
      },
    ],
  },
  /** The bootstrap that stopped on `02-data-volume`: no gateway ever started. */
  heron: {
    reachable: false,
    unreachable_reason:
      "hermes-gateway.service is not running: bootstrap stopped on stage 02-data-volume",
    used: 0,
    bots: [],
  },
  juniper: {
    reachable: false,
    unreachable_reason: "the instance is stopped",
    used: 0,
    bots: [],
  },
  /** `staging`'s stopped agent, so the second fleet has an offline bucket too. */
  quill: {
    reachable: false,
    unreachable_reason: "the instance is stopped",
    used: 0,
    bots: [],
  },
};

/**
 * What a box the table has never heard of looks like.
 *
 * `agent create` works in fixture mode, so an operator can be looking at a box
 * that did not exist when this file was written. A real one has exactly this:
 * the default profile, nothing warm, nothing said yet.
 */
const THIN: SwarmSpec = { reachable: true, used: 0, bots: [] };

export function specFor(instance: string): SwarmSpec {
  return SWARMS[instance] ?? { ...THIN, bots: [defaultBot(instance)] };
}

/**
 * Whether the fixture's box answers at all.
 *
 * Exported for callers that have to refuse *before* doing something to a
 * conversation rather than after: an unreachable box has no transcript and no
 * hint stream, so staging an arrival on one is a no-op that looks like a bug.
 * A box the table has never heard of is reachable, because `agent create`
 * works in fixture mode and a box made this morning is not a typo.
 */
export const fixtureChatReachable = (instance: string): boolean => specFor(instance).reachable;

/** One instance's roster, addressed — the `Swarm` the surface hands out. */
export function swarmFor(box: BoxAddress): Swarm {
  const spec = specFor(box.instance);
  return {
    instance: box.instance,
    reachable: spec.reachable,
    unreachable_reason: spec.unreachable_reason ?? null,
    bots: spec.bots.map((bot) => ({
      ...bot,
      instance: box.instance,
      avatar_seed: seedOf(box, bot.name),
    })),
    rooms: (spec.rooms ?? []).map((room) => ({ ...room, instance: box.instance })),
    // The total is a constant belief about upstream and does not depend on
    // whether the box answered — see `unreachableSwarm` in `../chat.ts`, which
    // reports `0/3` rather than `0/0` for exactly the same reason.
    warm_slots: { used: spec.used, total: FIXTURE_WARM_SLOTS },
    sections: [...(spec.sections ?? [])],
  };
}

/* ── sessions ─────────────────────────────────────────────────────────────── */

/**
 * Every session, flat.
 *
 * Flat rather than nested under its bot because the assertions worth making are
 * fleet-wide — "every origin appears somewhere" is the one the composer's
 * destination handling depends on, and it is a filter over one array rather than
 * a walk over three levels of map.
 *
 * All eight `SessionOrigin` values are present, and that is the point of the
 * list's shape: seven of them are *foreign*, and three of those — a reply into
 * somebody's Slack, into a robot, into a cron job's log — change what the
 * composer's send button says. The composer has to have something of each kind
 * to react to before anybody can tell whether it does.
 */
export const FIXTURE_CHAT_SESSIONS: readonly Session[] = [
  {
    id: "sx-atlas-portal",
    instance: "atlas",
    bot: "default",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "gp3 write cache on granite",
    last_message_at: at("09:31:40"),
    unread: 0,
    turn_count: 9,
  },
  {
    id: "sx-atlas-desktop",
    instance: "atlas",
    bot: "default",
    kind: "thread",
    origin: "desktop",
    origin_detail: "Hermes Desktop - operator laptop",
    title: "Reading the volume report",
    last_message_at: at("08:40:11"),
    unread: 0,
    turn_count: 2,
  },
  {
    id: "sx-atlas-cli",
    instance: "atlas",
    bot: "default",
    kind: "thread",
    origin: "cli",
    origin_detail: "hermetic chat atlas",
    title: "Rebuild the index from the volume snapshot",
    last_message_at: at("07:18:52"),
    unread: 0,
    turn_count: 4,
  },
  {
    // Opened by a hermetic — a colleague's — and never sent into from this
    // laptop. Detail-less, because a real `session.list` row never carries one.
    id: "sx-atlas-hermetic",
    instance: "atlas",
    bot: "default",
    kind: "thread",
    origin: "hermetic",
    origin_detail: null,
    title: "Snapshot retention for granite",
    last_message_at: at("07:44:09"),
    unread: 0,
    turn_count: 3,
  },
  {
    id: "sx-atlas-scribe-routine",
    instance: "atlas",
    bot: "scribe",
    kind: "routine",
    origin: "routine",
    origin_detail: "cron: 06:00 daily digest",
    title: "Daily digest",
    last_message_at: at("06:00:12"),
    unread: 2,
    turn_count: 1,
  },
  {
    id: "sx-atlas-auditor-portal",
    instance: "atlas",
    bot: "auditor",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Bedrock grant audit",
    last_message_at: at("08:14:03"),
    unread: 1,
    turn_count: 3,
  },
  {
    id: "sx-atlas-clio-channel",
    instance: "atlas",
    bot: "clio",
    kind: "thread",
    origin: "channel",
    origin_detail: "#acme-support",
    title: "Acme - restore window",
    last_message_at: at("07:52:30"),
    unread: 0,
    turn_count: 6,
  },
  {
    id: "sx-corvid-portal",
    instance: "corvid",
    bot: "default",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Pending profile change",
    last_message_at: at("09:12:55"),
    unread: 0,
    turn_count: 2,
  },
  {
    id: "sx-corvid-rook-peer",
    instance: "corvid",
    bot: "rook",
    kind: "thread",
    origin: "peer",
    origin_detail: "magpie@corvid",
    title: "Hand-off: the 4am page",
    last_message_at: at("09:20:18"),
    unread: 0,
    turn_count: 3,
  },
  {
    id: "sx-corvid-magpie-room",
    instance: "corvid",
    bot: "magpie",
    kind: "thread",
    origin: "room",
    origin_detail: "#triage",
    title: "#triage - round 2 of 3",
    last_message_at: at("09:19:06"),
    unread: 3,
    turn_count: 5,
  },
  {
    id: "sx-corvid-magpie-channel",
    instance: "corvid",
    bot: "magpie",
    kind: "thread",
    origin: "channel",
    origin_detail: "#acme-support",
    title: "Acme - billing export",
    last_message_at: at("08:47:02"),
    unread: 1,
    turn_count: 4,
  },
  {
    id: "sx-corvid-wren-portal",
    instance: "corvid",
    bot: "wren",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Waiting on a slot",
    last_message_at: at("09:21:44"),
    unread: 0,
    turn_count: 1,
  },
  {
    id: "sx-ember-portal",
    instance: "ember",
    bot: "default",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Disk pressure on /data",
    last_message_at: at("09:31:02"),
    unread: 1,
    turn_count: 2,
  },
  {
    id: "sx-granite-portal",
    instance: "granite",
    bot: "default",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Long refactor - 198k of context",
    last_message_at: at("09:05:19"),
    unread: 0,
    turn_count: 41,
  },
  {
    id: "sx-granite-quarry-cli",
    instance: "granite",
    bot: "quarry",
    kind: "routine",
    origin: "cli",
    origin_detail: "hermetic chat granite --bot quarry",
    title: "Release checklist",
    last_message_at: at("04:30:00"),
    unread: 0,
    turn_count: 2,
  },
  {
    // kestrel's Bot Chat: the background-process transcript. Canonical, so
    // `#chat/kestrel/default` opens it; the Bitwarden thread below is a
    // portal thread beside it.
    id: "sx-kestrel-events",
    instance: "kestrel",
    bot: "default",
    kind: "canonical",
    origin: "portal",
    origin_detail: null,
    title: "Bot Chat",
    last_message_at: at("00:28:02"),
    unread: 0,
    turn_count: 12,
  },
  {
    id: "sx-kestrel-portal",
    instance: "kestrel",
    bot: "default",
    kind: "thread",
    origin: "portal",
    origin_detail: null,
    title: "Bitwarden rotation",
    last_message_at: at("08:58:41"),
    unread: 0,
    turn_count: 2,
  },
];

/**
 * Every swarm the table can produce, addressed to the `main` fixture fleet.
 *
 * A convenience for tests and for anything that wants the roster without an
 * address to hand; the client itself always builds from the `BoxAddress` it was
 * given, because the fleet is part of `avatar_seed`.
 */
export const FIXTURE_CHAT_INSTANCES: readonly string[] = Object.keys(SWARMS);
