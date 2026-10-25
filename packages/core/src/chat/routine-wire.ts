/**
 * Routines (Hermes cron jobs) over a box's dashboard REST API
 * (`/api/cron/jobs`), as one portable sequence the desktop (`chat/bot-mode.ts`,
 * `routines.*`) and the phone (`mobile/`, through `@hermetic/core/chat-client`)
 * both run, so the two cannot read or write a job differently.
 *
 * Inputs are already validated against the `Routine*Input` schemas. The caller
 * binds the box, its options and its signal into `rest`.
 *
 * Portable: no node, bun, AWS or environment (`test/chat-client-portable.test.ts`).
 */
import { HermeticError } from "../errors.ts";
import * as S from "../schema/bot-mode.ts";
import { isoOrNull, record, records, str } from "./hermes/hermes-chat-wire.ts";

/** One dashboard REST call to one box, its address and options already bound. */
export type RoutineRest = (method: string, path: string, body?: unknown) => Promise<unknown>;

const text = (v: unknown, fallback = ""): string => str(v) ?? fallback;
const unsupported = (message: string): never => {
  throw new HermeticError("CHAT_PROTOCOL", message);
};

const path = (p: { bot: string; id?: string }, suffix = "") =>
  `/api/cron/jobs${p.id ? `/${encodeURIComponent(p.id)}` : ""}${suffix}?profile=${encodeURIComponent(p.bot)}`;

/**
 * The schedule as a string the gateway accepts back, so an edit round-trips:
 * a cron job's expression rather than its display (upstream keeps "every
 * monday 9am" as the display of `0 9 * * 1`), an interval in minutes and a
 * one-shot's run time.
 */
function scheduleText(r: Record<string, unknown>): string {
  if (typeof r.schedule === "string") return r.schedule;
  const s = record(r.schedule);
  if (s.kind === "cron" && typeof s.expr === "string") return s.expr;
  if (s.kind === "interval" && typeof s.minutes === "number") return `every ${s.minutes}m`;
  if (s.kind === "once" && typeof s.run_at === "string") return s.run_at;
  return text(s.display, text(s.value, text(s.expr, JSON.stringify(s))));
}
const contextFrom = (v: unknown) =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter(
    (x): x is string => typeof x === "string",
  );

/** One `/api/cron/jobs` row as a `BotRoutine`. */
export function routineFrom(p: { instance: string; bot: string }, v: unknown): S.BotRoutine {
  const r = record(v),
    repeat = record(r.repeat);
  return S.BotRoutine.parse({
    instance: p.instance,
    bot: p.bot,
    id: text(r.id),
    name: text(r.name, "Scheduled job").replace(/^\[bot:[^\]]+\]\s*/, ""),
    prompt: text(r.prompt),
    schedule: scheduleText(r),
    deliver: r.deliver === "bot-chat" ? "bot" : r.deliver === "local" || !r.deliver ? "local" : "other",
    paused: r.enabled === false || r.state === "paused",
    // Both are timestamps, read by whoever renders them as one, so a value
    // that is not a time is dropped rather than passed through: a head that
    // formats "soon" as a date prints garbage, and null already means "the
    // gateway did not say". Seconds, milliseconds and date strings all pass.
    next_run_at: isoOrNull(r.next_run_at),
    last_run_at: isoOrNull(r.last_run_at),
    last_status:
      typeof r.last_status === "string" ? r.last_status : typeof r.state === "string" ? r.state : null,
    repeat: {
      times: typeof repeat.times === "number" && repeat.times > 0 ? repeat.times : null,
      completed: typeof repeat.completed === "number" ? repeat.completed : 0,
    },
    continuity: contextFrom(r.context_from).some((ref) => ref.toLowerCase() === "self"),
  });
}

/** An IANA zone the gateway configured, or null when Hermes runs on the box's own clock. */
export function zoneOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v.trim() });
    return v.trim();
  } catch {
    return null;
  }
}

export function routineCalls(rest: RoutineRest) {
  return {
    async list(p: S.RoutinesListInput): Promise<{ jobs: S.BotRoutine[]; timezone: string | null }> {
      const [r, config] = await Promise.all([
        rest("GET", path(p)),
        // The profile's `timezone` is the clock its schedules run on. A failed
        // read is not a failed list: the jobs are still right, only their zone
        // is unknown.
        rest("GET", `/api/config?profile=${encodeURIComponent(p.bot)}`).catch(() => null),
      ]);
      const jobs = Array.isArray(r) ? r : record(r).jobs;
      if (!Array.isArray(jobs)) return unsupported("Gateway returned no routine registry");
      return {
        jobs: records(jobs).map((v) => routineFrom(p, v)),
        timezone: zoneOrNull(record(config).timezone),
      };
    },
    async create(p: S.RoutineCreateInput): Promise<S.BotRoutine> {
      const job = await rest("POST", path(p), {
        name: p.name,
        prompt: p.prompt,
        schedule: p.schedule,
        deliver: p.deliver === "bot" ? "bot-chat" : "local",
        ...(p.continuity ? { context_from: ["self"] } : {}),
      });
      if (!p.repeat) return routineFrom(p, job);
      // Upstream's create body has no run cap (`CronJobCreate`); `update_job`
      // takes one. A cap that did not land would leave a job running forever
      // that was asked to stop, so the job goes with it.
      const id = text(record(job).id);
      try {
        return routineFrom(p, await rest("PUT", path({ ...p, id }), { updates: { repeat: p.repeat } }));
      } catch (e) {
        const removed = await rest("DELETE", path({ ...p, id })).then(
          () => true,
          () => false,
        );
        if (removed || !(e instanceof HermeticError)) throw e;
        throw new HermeticError(e.code, `${e.message}. “${p.name}” was created without its run cap.`);
      }
    },
    async update(p: S.RoutineUpdateInput): Promise<S.BotRoutine> {
      const { instance, bot, id, paused, deliver, continuity, ...updates } = p;
      let r: unknown;
      // `context_from` may also chain other jobs; continuity adds or drops only "self".
      const context =
        continuity === undefined
          ? undefined
          : contextFrom(record(await rest("GET", path(p))).context_from)
              .filter((ref) => ref.toLowerCase() !== "self")
              .concat(continuity ? ["self"] : []);
      if (Object.keys(updates).length || deliver !== undefined || context !== undefined)
        r = await rest("PUT", path(p), {
          updates: {
            ...updates,
            ...(deliver ? { deliver: deliver === "bot" ? "bot-chat" : "local" } : {}),
            ...(context ? { context_from: context } : {}),
          },
        });
      if (paused !== undefined) r = await rest("POST", path(p, paused ? "/pause" : "/resume"), {});
      if (r === undefined) r = await rest("GET", path(p));
      return routineFrom({ instance, bot }, r);
    },
    async delete(p: S.RoutineDeleteInput): Promise<{ deleted: true }> {
      const result = record(await rest("DELETE", path(p)));
      if (result.ok !== true) return unsupported("Gateway did not confirm routine removal");
      return { deleted: true as const };
    },
    async run(p: S.RoutineRunInput): Promise<S.BotRoutine> {
      return routineFrom(p, await rest("POST", path(p, "/trigger"), {}));
    },
    async history(p: S.RoutineHistoryInput): Promise<{ runs: S.BotRoutineRun[] }> {
      const r = record(await rest("GET", `${path(p, "/runs")}&limit=${p.limit ?? 20}`));
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
    },
  };
}
