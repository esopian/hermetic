/** Typed Bot Mode operations. Upstream owns profiles, room logs and schedules. */
import type { z } from "zod";
import * as S from "../schema/bot-mode.ts";
import { agentDashboardUrl, cloudName } from "../schema/index.ts";
import type { ChatDeps, ChatOptions } from "./chat.ts";
import { HermeticError } from "../errors.ts";
import { validateName } from "../shared/naming.ts";
import { redactDeep, redactText } from "./chat-redact.ts";
import { isoOrNull, record, records, str } from "./hermes/hermes-chat-wire.ts";

/**
 * The adapter's one local read: every string in the Bot Mode schemas is
 * required, so a field upstream did not send becomes its default rather than
 * null. `str` treats `""` as absence (see `hermes-chat-wire.ts`), which is why
 * an empty `display_name` falls through to the profile name here.
 */
const text = (v: unknown, fallback = ""): string => str(v) ?? fallback;
const unsupported = (message: string): never => {
  throw new HermeticError("CHAT_PROTOCOL", message);
};

/**
 * The hosted-room protocol version this build speaks (`groups.capabilities`,
 * `tui_gateway/contracts/groups_bot_relay.py` at Hermes `v2026.9.14`). A
 * gateway reporting anything else is an older or newer build whose room calls
 * this module has not qualified.
 */
const ROOM_PROTOCOL_VERSION = 2;

/**
 * The routine probe: upstream's dashboard job registry for one profile
 * (`GET /api/cron/jobs?profile=…`, `hermes_cli/web_routers/cron.py` at
 * `v2026.9.14`). It is the same read `routines.list` performs, which is the
 * point — the capability is true when the call the surface actually makes
 * works, and false when it does not.
 *
 * Always profile-scoped, and never retried unscoped (`profile=all`, or the
 * parameter dropped): a refused profile-scoped read is an answer, not a reason
 * to ask a wider question. Which profile it names is `probeProfile`'s job.
 */
const routineProbePath = (profile: string): string =>
  `/api/cron/jobs?profile=${encodeURIComponent(profile)}`;

/**
 * The profile a routine probe falls back to when the gateway named none.
 *
 * `default` is upstream's implicit profile — the one that *is* `$HERMES_HOME`
 * and creates no `profiles/` entry on disk — so it is the right guess for a
 * genuinely empty roster and the wrong guess for a gateway whose profiles are
 * simply named something else. `probeProfile` prefers a name the gateway just
 * reported precisely so the wrong guess stops happening.
 */
const IMPLICIT_PROFILE = "default";

/**
 * How long one instance's probe results stay good.
 *
 * `requireDriver` runs before every `rooms.create` and `rooms.send`, and
 * `capabilities` now makes three real gateway calls rather than reading the
 * adapter's shape, so an unmemoized burst of sends would triple its own
 * traffic. Five seconds is long enough that a burst pays for the probes once,
 * and short enough that a gateway restarted into a build with hosted rooms
 * enabled — or an operator's grant being revoked — shows up on the next thing
 * they click rather than for the life of the process.
 */
const CAPABILITY_TTL_MS = 5_000;

/**
 * Failures that are the gateway's *answer* about one endpoint.
 *
 * A gateway that 404s the routine registry, or refuses a profile-scoped read,
 * has answered the question `capabilities` asked: that capability is off, that
 * answer is definitive, and it is worth remembering for the memo's lifetime.
 *
 * `FORBIDDEN` is in the set on purpose: `capabilities` used to rethrow a
 * refused `groups.capabilities`, which made "you may not manage hosted rooms"
 * indistinguishable from "this whole call failed" and took the other three
 * flags down with it. A refusal of one profile-scoped call is now that flag's
 * answer, recorded as unauthorized in `detail` so the operator can tell an
 * unauthorized surface from an unsupported one.
 */
const ENDPOINT_REFUSALS = new Set<string>(["NOT_FOUND", "FORBIDDEN", "CONFLICT"]);

/**
 * Failures that are not an answer at all.
 *
 * `CHAT_PROTOCOL` is the REST mapper's catch-all: every status that is not 404,
 * 409 or 403 lands there, which means a gateway 500, a truncated body and an
 * expired session token are all spelled the same way. This set used to sit
 * inside `ENDPOINT_REFUSALS`, so each of those read as "this capability is
 * unavailable" and was then cached for five seconds — one transient server
 * fault and the portal hid a feature the gateway has. They are `unknown`
 * instead: the flag stays off because nothing confirmed it, no reason is
 * phrased as a verdict on the gateway, and the sweep is not memoized.
 *
 * A failure outside both sets — the box unreachable, the caller's abort — says
 * nothing about any capability *and* nothing about the endpoint, so it is
 * rethrown and `capabilities` fails rather than reporting on a box it never
 * reached.
 */
const ENDPOINT_UNKNOWNS = new Set<string>(["CHAT_PROTOCOL"]);

/**
 * Upstream's wire spelling of `EventConflictError` — one `event_id` reused with
 * different immutable content (`gateway/hosted_rooms.py` `append_event` at
 * Hermes `v2026.9.14`).
 *
 * The message is the only thing that identifies it. `methods_groups.py` maps
 * every `HostedRoomError` a send can raise onto one numeric code (4111), and
 * `hermes-chat-rpc.ts` maps every numeric RPC error onto `CHAT_PROTOCOL`, so a
 * conflict, a disbanded room and a stale authority all arrive spelled the same
 * way. A conflict is worth separating: it is the caller's own identity mistake
 * — this id already belongs to a different message — and retrying it can never
 * succeed, which is the opposite of what a transport failure asks for.
 */
const EVENT_CONFLICT = /event_id already exists/i;

/**
 * Whether a failure is the caller hanging up rather than the gateway speaking.
 *
 * A cancelled probe — fleet switch, dialog teardown, unlisten — says nothing
 * about any capability, so it must never be rewritten into one. The signal is
 * decisive: once the caller has aborted, whatever the in-flight call happened
 * to reject with is a consequence of the abort, not a verdict.
 */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof HermeticError) return error.code === "ABORTED";
  return error instanceof Error && error.name === "AbortError";
}

/**
 * The abort, as core's one error type. An `ABORTED` `HermeticError` is passed
 * through untouched (it carries the phase it stopped in); a `DOMException` from
 * `throwIfAborted`, or a transport rejection that lost a race with the abort,
 * becomes one.
 */
const asAbort = (error: unknown): HermeticError =>
  error instanceof HermeticError && error.code === "ABORTED"
    ? error
    : new HermeticError("ABORTED", "Bot Mode operation was aborted by its caller");

/** What one probe learned, and how much of it the caller may believe. */
interface ProbeResult {
  value: unknown;
  reason: string | null;
  /** `answered`: the gateway replied. `refused`: it answered *no*. `unknown`: nothing learned. */
  outcome: "answered" | "refused" | "unknown";
}

/**
 * Run one passive capability probe.
 *
 * `what` names the surface in the recorded reason, and the refusal code decides
 * the wording, because "this gateway is too old", "you are not allowed to read
 * this" and "we could not find out" are three different problems with three
 * different fixes and an operator reading one flag needs to know which they
 * have.
 */
async function probe(
  what: string,
  read: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    return { value: await read(), reason: null, outcome: "answered" };
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    if (!(error instanceof HermeticError)) throw error;
    if (ENDPOINT_UNKNOWNS.has(error.code))
      return {
        value: null,
        reason: `${what} could not be determined: ${error.message}`,
        outcome: "unknown",
      };
    if (!ENDPOINT_REFUSALS.has(error.code)) throw error;
    const kind =
      error.code === "FORBIDDEN"
        ? "unauthorized for this session"
        : error.code === "NOT_FOUND"
          ? "unsupported by this gateway"
          : "unavailable";
    return { value: null, reason: `${what} is ${kind}: ${error.message}`, outcome: "refused" };
  }
}

/**
 * How one flag reads, given what its probe did and whether the answer was the
 * shape this build needs. An answered probe whose body is unusable is a
 * `refused`, not an `unknown`: the gateway did reply, and this build has
 * decided it cannot work with what it said.
 */
const verdict = (result: ProbeResult, usable: boolean): S.BotCapabilityStatus =>
  result.outcome === "unknown"
    ? "unknown"
    : result.outcome === "answered" && usable
      ? "supported"
      : "refused";

/**
 * The profile the routine probe scopes itself to.
 *
 * `GET /api/cron/jobs` takes a profile, and a profile the gateway does not have
 * 404s — which is indistinguishable from a gateway with no job registry at all.
 * Hardcoding `default` therefore reported "routines unsupported" on any box
 * whose profiles are named something else. The probe names a profile the roster
 * just reported instead: the one the gateway calls its default, else the
 * lexicographically first, which stays the same choice even if the gateway
 * reorders its roster between reads. Only a genuinely empty roster falls back
 * to the implicit profile.
 */
function probeProfile(roster: unknown): string {
  const rows = records(record(roster).profiles);
  const flagged = text(rows.find((row) => row.is_default === true)?.name);
  if (flagged) return flagged;
  const names = rows.map((row) => text(row.name)).filter((name) => name.length > 0);
  return names.sort()[0] ?? IMPLICIT_PROFILE;
}

export function createBotMode(
  deps: Pick<ChatDeps, "guardFleet" | "getAgent" | "instanceListening" | "hermes">,
) {
  async function box(instance: string) {
    validateName(instance);
    const { fleet } = await deps.guardFleet();
    const watched = () => deps.instanceListening?.list(fleet.fleet_id).includes(instance);
    if (!watched())
      throw new HermeticError(
        "VALIDATION",
        `${instance}: listen to this instance before using Bot Mode`,
      );
    const agent = await deps.getAgent(instance);
    if (!watched()) throw new HermeticError("VALIDATION", `${instance}: instance is no longer watched`);
    return {
      instance,
      fleet_id: fleet.fleet_id,
      baseUrl: agentDashboardUrl(agent, fleet.tailnet, cloudName(fleet.fleet_id, instance)),
    };
  }
  async function rpc(
    instance: string,
    method: string,
    params: Record<string, unknown>,
    opts: ChatOptions = {},
  ) {
    const address = await box(instance);
    if (!deps.hermes.botModeRpc) return unsupported("Bot Mode RPC is unavailable on this gateway");
    return deps.hermes.botModeRpc(address, method, params, opts);
  }
  async function rest(
    instance: string,
    method: string,
    path: string,
    body?: unknown,
    opts: ChatOptions = {},
  ) {
    const address = await box(instance);
    if (!deps.hermes.botModeRest)
      return unsupported("Bot Mode dashboard API is unavailable on this gateway");
    return deps.hermes.botModeRest(address, method, path, body, opts);
  }
  function operation<I extends z.ZodType, O>(
    schema: I,
    work: (input: z.infer<I>, opts: ChatOptions) => Promise<O>,
  ) {
    return async (input: z.input<I>, opts: ChatOptions = {}): Promise<O> => {
      const parsed = schema.safeParse(input);
      if (!parsed.success)
        throw new HermeticError(
          "VALIDATION",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      try {
        opts.signal?.throwIfAborted();
        const result = await work(parsed.data, opts);
        opts.signal?.throwIfAborted();
        return redactDeep(result) as O;
      } catch (error) {
        // The caller hanging up is not a failure of the gateway and not a
        // verdict on anything: it propagates as the abort it is, never as a
        // protocol error a capability probe could read as an answer.
        if (isAbort(error, opts.signal)) throw asAbort(error);
        if (error instanceof HermeticError)
          throw new HermeticError(error.code, redactText(error.message));
        throw new HermeticError(
          "CHAT_PROTOCOL",
          redactText(error instanceof Error ? error.message : "Bot Mode operation failed"),
        );
      }
    };
  }
  /**
   * One instance's last probe sweep, keyed by fleet and instance so a fleet
   * switch cannot serve another fleet's gateway answers.
   */
  const memo = new Map<string, { at: number; value: S.BotModeCapabilities }>();
  const capabilities = operation(
    S.BotCapabilitiesInput,
    async (p, opts): Promise<S.BotModeCapabilities> => {
      const address = await box(p.instance);
      const memoKey = `${address.fleet_id}/${p.instance}`;
      const cached = memo.get(memoKey);
      if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value;

      // Sequential, not a fan-out: three probes racing would leave the losers'
      // rejections unhandled the moment one of them reported a dead box. The
      // roster goes first because the routine probe needs a profile from it.
      const roster = await probe(
        "The profile roster",
        () => rpc(p.instance, "profiles.list", { include_sessions: false }, opts),
        opts.signal,
      );
      const listed = Array.isArray(record(roster.value).profiles);
      const profilesStatus = verdict(roster, listed);

      /**
       * Whether the routine probe could name a profile the gateway vouched for.
       * When the roster did not answer, the probe still runs — profile-scoped,
       * never widened — because a registry that answers is real evidence. Only
       * its *negative* is downgraded: a 404 for a profile nobody confirmed
       * exists says "that profile is not here", not "this gateway has no job
       * registry", and reporting the latter is the bug.
       */
      const qualified = roster.outcome === "answered";
      const scope = qualified ? probeProfile(roster.value) : IMPLICIT_PROFILE;
      const registry = await probe(
        "The routine registry",
        () => rest(p.instance, "GET", routineProbePath(scope), undefined, opts),
        opts.signal,
      );
      const jobs = Array.isArray(registry.value) ? registry.value : record(registry.value).jobs;
      const listedJobs = Array.isArray(jobs);
      const probed = verdict(registry, listedJobs);
      const routinesStatus: S.BotCapabilityStatus =
        qualified || probed === "supported" ? probed : "unknown";

      const rooms = await probe(
        "The hosted-room protocol",
        () => rpc(p.instance, "groups.capabilities", { profile: IMPLICIT_PROFILE }, opts),
        opts.signal,
      );
      const groups = record(rooms.value);
      const version = typeof groups.protocol_version === "number" ? groups.protocol_version : null;
      const hostedStatus = verdict(rooms, version === ROOM_PROTOCOL_VERSION);
      const hosted = hostedStatus === "supported";
      // `driver` is the whole answer for a room on this instance: it is whether
      // the gateway's hosted-room service is running, which is the same check
      // upstream's room handlers make before accepting work. `persistent_process`
      // is not read here. Upstream copies it out of the RoomLink peer catalog
      // (`tui_gateway/methods_groups.py` at `v2026.9.24`), so it is false whenever
      // RoomLink is disabled, which says nothing about local rooms.
      const driver = hosted && groups.driver === true;
      // A driver claim can only be read off a protocol this build understands,
      // so an unknown hosted-room probe leaves the driver unknown too.
      const driverStatus: S.BotCapabilityStatus =
        hostedStatus === "unknown" ? "unknown" : driver ? "supported" : "refused";
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === "string") : [];
      const hostedReason =
        rooms.reason ??
        (hosted
          ? null
          : version === null
            ? "This gateway did not report a hosted-room protocol version"
            : `This gateway speaks hosted-room protocol version ${version}; version ${ROOM_PROTOCOL_VERSION} is required`);
      const routinesReason =
        routinesStatus === "supported"
          ? null
          : routinesStatus === "unknown" && qualified === false
            ? `The routine registry could not be determined: no profile roster to scope the read to (${roster.reason ?? "the roster probe gave no answer"})`
            : (registry.reason ?? (listedJobs ? null : "This gateway returned no routine registry"));
      const value: S.BotModeCapabilities = {
        instance: p.instance,
        profiles: profilesStatus === "supported",
        routines: routinesStatus === "supported",
        hosted_rooms: hosted,
        room_driver: driverStatus === "supported",
        room_methods: strings(groups.methods),
        protocol_version: version,
        room_features: strings(groups.features),
        membership_edit: false,
        cross_instance_rooms: false,
        cross_instance_relay: false,
        reason: rooms.reason,
        detail: {
          profiles: roster.reason ?? (listed ? null : "This gateway returned no profile roster"),
          routines: routinesReason,
          hosted_rooms: hostedReason,
          room_driver: driver
            ? null
            : (hostedReason ?? "This gateway's hosted-room driver is not running"),
        },
        status: {
          profiles: profilesStatus,
          routines: routinesStatus,
          hosted_rooms: hostedStatus,
          room_driver: driverStatus,
        },
      };
      // Only an answer is worth remembering. A sweep carrying an `unknown` is a
      // sweep that learned nothing about that flag, and caching it for five
      // seconds would turn one gateway hiccup into five seconds of a feature
      // the operator has being reported as a feature they do not.
      if (Object.values(value.status).every((s) => s !== "unknown"))
        memo.set(memoKey, { at: Date.now(), value });
      return value;
    },
  );
  const get = operation(S.BotProfileInput, async (p, opts): Promise<S.BotProfile> => {
    const r = record(await rpc(p.instance, "profiles.describe", { name: p.bot }, opts));
    return S.BotProfile.parse({
      instance: p.instance,
      bot: p.bot,
      description: text(r.description),
      soul: text(r.soul),
      model: { provider: text(record(r.model).provider), default: text(record(r.model).default) },
      skills: records(r.skills),
      toolsets: records(r.toolsets),
      mcp_servers: records(r.mcp_servers),
    });
  });
  const create = operation(S.BotCreateInput, async (p, opts) => {
    const { instance, ...input } = p;
    const created = record(await rpc(instance, "profiles.create", input, opts));
    if (created.ok !== true) return unsupported("Gateway did not create the profile");
    const configured = record(
      await rpc(
        instance,
        "profiles.configure",
        { name: p.name, ui_meta: { "hermes-bots": { version: 1 } } },
        opts,
      ),
    );
    if (configured.ok !== true || record(configured.applied).ui_meta !== true)
      return unsupported(
        "Profile was created but Bot Mode metadata could not be saved; inspect the profile before retrying",
      );
    return get({ instance, bot: p.name }, opts);
  });
  /**
   * The `ui_meta` half of a title change: the profile's current `hermes-bots`
   * namespace with `title` merged in (or deleted, for a reset), sent with the
   * revision it was read at.
   *
   * Upstream merges `ui_meta` one top-level key at a time
   * (`_configure_ui_meta`, `tui_gateway/methods_profiles.py` at `v2026.9.24`),
   * so sending `{ "hermes-bots": { title } }` alone would replace the whole
   * namespace and drop every other key Desktop keeps there. The expected
   * revision makes the read-merge-write one compare-and-swap: if Desktop saved
   * that namespace in between, the gateway rejects the write instead of this
   * one silently undoing it.
   */
  async function titleMeta(instance: string, bot: string, title: string | null, opts: ChatOptions) {
    const listed = record(await rpc(instance, "profiles.list", { include_sessions: false }, opts));
    const row = records(listed.profiles).find((entry) => entry.name === bot);
    if (!row) throw new HermeticError("NOT_FOUND", `${bot}: profile not found on ${instance}`);
    const meta: Record<string, unknown> = { ...record(record(row.ui_meta)["hermes-bots"]) };
    if (title) meta.title = title;
    else delete meta.title;
    meta.custom = true;
    const revision = record(row.ui_meta_revisions)["hermes-bots"];
    return {
      ui_meta: { "hermes-bots": meta },
      ui_meta_expected_revisions: { "hermes-bots": typeof revision === "number" ? revision : 0 },
    };
  }
  const update = operation(S.BotUpdateInput, async (p, opts) => {
    const { instance, bot, title, ...changes } = p;
    const meta = title === undefined ? {} : await titleMeta(instance, bot, title, opts);
    const r = record(
      await rpc(instance, "profiles.configure", { name: bot, ...changes, ...meta }, opts),
    );
    if (title !== undefined) {
      const applied = record(r.applied);
      const conflict = record(record(applied.ui_meta_conflicts)["hermes-bots"]);
      if (Object.keys(conflict).length > 0)
        throw new HermeticError(
          "CONFLICT",
          `${bot}: its Bot Mode settings changed elsewhere since they were read (revision ${String(conflict.expected)} expected, ${String(conflict.actual)} found). Reload before renaming again.`,
        );
      if (applied.ui_meta === false)
        throw new HermeticError("CONFLICT", `${bot}: the gateway did not save the new name`);
      if (applied.ui_meta !== true)
        return unsupported("This gateway does not store Bot Mode titles; update Hermes");
    }
    if (r.confirm_required === true)
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        text(r.confirm_message, "Confirm this model change"),
      );
    if (r.ok !== true || Object.values(record(r.applied)).some((v) => v === false))
      throw new HermeticError(
        "CONFLICT",
        "Some profile changes were rejected. Reload before saving again.",
      );
    return get({ instance, bot }, opts);
  });
  const remove = operation(S.BotDeleteInput, async (p, opts) => {
    if (p.bot === "default")
      throw new HermeticError("VALIDATION", "The default profile cannot be removed");
    const result = record(
      await rest(p.instance, "DELETE", `/api/profiles/${encodeURIComponent(p.bot)}`, undefined, opts),
    );
    if (result.ok !== true) return unsupported("Gateway did not confirm profile removal");
    return { deleted: true as const };
  });
  const member = (v: Record<string, unknown>) => ({
    member_id: text(v.member_id),
    profile: text(v.profile),
    handle: text(v.handle),
    display_name: text(v.display_name, text(v.profile)),
  });
  function room(instance: string, response: unknown): S.HostedRoom {
    const result = record(response),
      r = record(result.room ?? response),
      driver = record(result.driver_status);
    return S.HostedRoom.parse({
      instance,
      id: r.room_id,
      name: r.name,
      members: records(r.members).map(member),
      revision: r.revision ?? 0,
      latest_seq: r.latest_seq ?? 0,
      created_at: isoOrNull(r.created_at) ?? "",
      updated_at: isoOrNull(r.updated_at) ?? "",
      disbanded_at: isoOrNull(r.disbanded_at),
      working: driver.working === true,
      blocked: driver.blocked === true,
      pending_actions: records(driver.pending_actions),
    });
  }
  const roomParams = (p: { room: string }) => ({ profile: "default", room_id: p.room });
  async function requireDriver(instance: string, opts: ChatOptions) {
    const c = await capabilities({ instance }, opts);
    if (!c.hosted_rooms || !c.room_driver)
      unsupported(
        c.detail.room_driver ??
          c.detail.hosted_rooms ??
          c.reason ??
          "This gateway's hosted-room driver is not running",
      );
  }
  const rooms = {
    list: operation(S.RoomsListInput, async (p, o) => {
      const r = record(
        await rpc(
          p.instance,
          "groups.list",
          { profile: "default", limit: p.limit ?? 100, offset: p.offset ?? 0 },
          o,
        ),
      );
      return {
        rooms: records(r.rooms).map((v) => room(p.instance, v)),
        next_offset: typeof r.next_offset === "number" ? r.next_offset : null,
      };
    }),
    get: operation(S.RoomGetInput, async (p, o) =>
      room(p.instance, await rpc(p.instance, "groups.state", roomParams(p), o)),
    ),
    create: operation(S.RoomCreateInput, async (p, o) => {
      if (p.members.some((m) => m.instance !== p.instance))
        return unsupported(
          "Cross-instance rooms require qualified RoomLink configuration. Choose bots on one instance.",
        );
      await requireDriver(p.instance, o);
      const roster = record(await rpc(p.instance, "profiles.list", { include_sessions: false }, o));
      if (p.members.some((m) => !records(roster.profiles).some((b) => b.name === m.bot)))
        throw new HermeticError("VALIDATION", "Every member must be a profile on this instance");
      return room(
        p.instance,
        await rpc(
          p.instance,
          "groups.create",
          {
            profile: "default",
            room_id: p.room,
            name: p.name,
            members: p.members.map((m) => ({
              member_id: m.bot,
              profile: m.bot,
              handle: m.bot,
              display_name: m.bot,
            })),
          },
          o,
        ),
      );
    }),
    rename: operation(S.RoomRenameInput, async (p, o) =>
      room(
        p.instance,
        await rpc(
          p.instance,
          "groups.rename",
          { ...roomParams(p), name: p.name, event_id: p.event_id },
          o,
        ),
      ),
    ),
    delete: operation(S.RoomDeleteInput, async (p, o) => {
      const result = record(await rpc(p.instance, "groups.disband", roomParams(p), o));
      if (record(result.tombstone).room_id !== p.room || !record(result.tombstone).disbanded_at)
        return unsupported("Gateway did not confirm room disbanding");
      return { deleted: true as const };
    }),
    history: operation(S.RoomHistoryInput, async (p, o): Promise<S.RoomHistoryPage> => {
      const since = p.since_seq ?? 0;
      const r = record(
        await rpc(
          p.instance,
          "groups.log",
          { ...roomParams(p), since_seq: since, limit: p.limit ?? 200 },
          o,
        ),
      );
      const cursor = typeof r.cursor === "number" ? r.cursor : 0;
      return S.RoomHistoryPage.parse({
        events: records(r.events).map((v) =>
          S.HostedRoomEvent.parse({
            room_id: v.room_id,
            seq: v.seq,
            event_id: v.event_id,
            kind: v.kind,
            actor: v.actor,
            text: typeof record(v.payload).text === "string" ? record(v.payload).text : null,
            member_id:
              typeof record(v.payload).member_id === "string" ? record(v.payload).member_id : null,
            created_at: isoOrNull(v.created_at) ?? "",
          }),
        ),
        cursor,
        // The room's own high-water mark, which the gateway reports on every
        // page including an empty one — the only way a client can aim a read at
        // the recent end of a long room, because the protocol has no reverse
        // read. A gateway that reports none leaves this at the page's own
        // cursor: never a value ahead of the log, which upstream refuses.
        latest_seq: typeof r.latest_seq === "number" ? r.latest_seq : Math.max(cursor, since),
        has_more: r.has_more === true,
      });
    }),
    send: operation(S.RoomSendInput, async (p, o): Promise<S.RoomSendReceipt> => {
      await requireDriver(p.instance, o);
      let answer: unknown;
      try {
        answer = await rpc(
          p.instance,
          "groups.send",
          { ...roomParams(p), event_id: p.event_id, payload: { text: p.text } },
          o,
        );
      } catch (error) {
        if (error instanceof HermeticError && EVENT_CONFLICT.test(error.message))
          throw new HermeticError(
            "CONFLICT",
            `${p.room}: this message id already carries different content in this room; the message posted under it stands`,
          );
        throw error;
      }
      const r = record(answer);
      if (r.accepted !== true) return unsupported("Gateway did not accept the room message");
      return S.RoomSendReceipt.parse({
        accepted: true,
        event_id: p.event_id,
        // Upstream answers a repeated `event_id` with the event it already
        // holds, flagged `idempotent`. That flag is the difference between a
        // retry that posted a second message and a retry that reconciled with
        // the first, and it is the only evidence a caller has of which one
        // happened.
        duplicate: record(r.event).idempotent === true,
      });
    }),
    control: operation(S.RoomControlInput, async (p, o) => {
      const result = record(
        await rpc(
          p.instance,
          `groups.${p.action}`,
          { ...roomParams(p), ...(p.task_id ? { task_id: p.task_id } : {}) },
          o,
        ),
      );
      if (p.action === "stop" ? typeof result.cancelled !== "number" : result.retried !== true)
        return unsupported("Gateway did not confirm room control");
      return { accepted: true as const };
    }),
    respond: operation(S.RoomRespondInput, async (p, o) => {
      const { instance, room: roomId, ...rest } = p;
      const result = record(
        await rpc(instance, "groups.approve", { profile: "default", room_id: roomId, ...rest }, o),
      );
      if (result.approved !== true) return unsupported("Gateway did not confirm this approval");
      return { accepted: true as const };
    }),
  };
  const path = (p: { bot: string; id?: string }, suffix = "") =>
    `/api/cron/jobs${p.id ? `/${encodeURIComponent(p.id)}` : ""}${suffix}?profile=${encodeURIComponent(p.bot)}`;
  function routine(p: { instance: string; bot: string }, v: unknown): S.BotRoutine {
    const r = record(v),
      schedule = record(r.schedule);
    return S.BotRoutine.parse({
      ...p,
      id: text(r.id),
      name: text(r.name, "Scheduled job").replace(/^\[bot:[^\]]+\]\s*/, ""),
      prompt: text(r.prompt),
      schedule:
        typeof r.schedule === "string"
          ? r.schedule
          : text(schedule.display, text(schedule.value, text(schedule.expr, JSON.stringify(schedule)))),
      deliver:
        r.deliver === "bot-chat" ? "bot" : r.deliver === "local" || !r.deliver ? "local" : "other",
      paused: r.enabled === false || r.state === "paused",
      // Both are timestamps, read by whoever renders them as one, so a value
      // that is not a time is dropped rather than passed through: a head that
      // formats "soon" as a date prints garbage, and null already means "the
      // gateway did not say". Seconds, milliseconds and date strings all pass.
      next_run_at: isoOrNull(r.next_run_at),
      last_run_at: isoOrNull(r.last_run_at),
      last_status:
        typeof r.last_status === "string"
          ? r.last_status
          : typeof r.state === "string"
            ? r.state
            : null,
    });
  }
  const routines = {
    list: operation(S.RoutinesListInput, async (p, o) => {
      const r = await rest(p.instance, "GET", path(p), undefined, o);
      const jobs = Array.isArray(r) ? r : record(r).jobs;
      if (!Array.isArray(jobs)) return unsupported("Gateway returned no routine registry");
      return { jobs: records(jobs).map((v) => routine(p, v)) };
    }),
    create: operation(S.RoutineCreateInput, async (p, o) =>
      routine(
        p,
        await rest(
          p.instance,
          "POST",
          path(p),
          {
            name: p.name,
            prompt: p.prompt,
            schedule: p.schedule,
            deliver: p.deliver === "bot" ? "bot-chat" : "local",
          },
          o,
        ),
      ),
    ),
    update: operation(S.RoutineUpdateInput, async (p, o) => {
      const { instance, bot, id, paused, deliver, ...updates } = p;
      let r: unknown;
      if (Object.keys(updates).length || deliver !== undefined)
        r = await rest(
          instance,
          "PUT",
          path(p),
          {
            updates: {
              ...updates,
              ...(deliver ? { deliver: deliver === "bot" ? "bot-chat" : "local" } : {}),
            },
          },
          o,
        );
      if (paused !== undefined)
        r = await rest(instance, "POST", path(p, paused ? "/pause" : "/resume"), {}, o);
      if (r === undefined) r = await rest(instance, "GET", path(p), undefined, o);
      return routine({ instance, bot }, r);
    }),
    delete: operation(S.RoutineDeleteInput, async (p, o) => {
      const result = record(await rest(p.instance, "DELETE", path(p), undefined, o));
      if (result.ok !== true) return unsupported("Gateway did not confirm routine removal");
      return { deleted: true as const };
    }),
    run: operation(S.RoutineRunInput, async (p, o) =>
      routine(p, await rest(p.instance, "POST", path(p, "/trigger"), {}, o)),
    ),
    history: operation(S.RoutineHistoryInput, async (p, o) => {
      const r = record(
        await rest(p.instance, "GET", `${path(p, "/runs")}&limit=${p.limit ?? 20}`, undefined, o),
      );
      return {
        runs: records(r.runs).map((v) =>
          S.BotRoutineRun.parse({
            id: text(v.id),
            status: text(v.status, text(v.end_reason, "recorded")),
            started_at: isoOrNull(v.started_at),
            finished_at: isoOrNull(v.ended_at),
            text: text(v.preview, text(v.title)),
            error: typeof v.error === "string" ? v.error : null,
          }),
        ),
      };
    }),
  };
  return { bots: { capabilities, get, create, update, delete: remove }, rooms, routines };
}
