/**
 * Routine schedules: the strings Hermes accepts, in plain English, and when
 * they fire next — all on the profile's clock, not the laptop's.
 *
 * The forms are upstream's `parse_schedule` (`cron/jobs.py`, Hermes
 * v2026.9.24): a five-field cron expression; `every 2h` / `every 90m`, a
 * recurring interval (a bare `2h` is recurring too); `in 30m`, one run that
 * long after saving; and an ISO timestamp, one run then — read in Hermes's own
 * zone when it carries no offset, which is why the picker sends it naive.
 */

/** Every date this module formats is in this locale (renderer rule 4). */
export const LOCALE = "en-US";
/** This laptop's zone, for the "your time" hint beside an instance time. */
export const LAPTOP_ZONE = Intl.DateTimeFormat(LOCALE).resolvedOptions().timeZone;

/** A run or job status as one of the four colours the rail draws. */
export function runTone(status: string | null | undefined): "ok" | "bad" | "run" | "idle" {
  if (!status) return "idle";
  if (/fail|error|timeout|cancel|abort/i.test(status)) return "bad";
  if (/running|started|in_progress|pending/i.test(status)) return "run";
  return "ok";
}
const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const UNIT_MS = { m: MIN, h: HOUR, d: DAY } as const;
type Unit = keyof typeof UNIT_MS;

export type Kind =
  | "once"
  | "at"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "interval"
  | "cron";
export const KINDS: readonly (readonly [Kind, string])[] = [
  ["once", "Once in…"],
  ["at", "Once at…"],
  ["hourly", "Every hour"],
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["interval", "Interval"],
  ["cron", "Advanced (cron)"],
];

/** The picker's whole state; each kind reads the fields it needs. */
export interface Picker {
  kind: Kind;
  /** `HH:MM`, 24-hour. */
  time: string;
  /** 0 = Sunday. */
  days: number[];
  dom: number;
  minute: number;
  n: number;
  unit: Unit;
  expr: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

// ── the zone's wall clock ─────────────────────────────────────────────────

const partsFormat = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  dow: number;
}
export function wall(t: number, zone: string): Wall {
  let f = partsFormat.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    partsFormat.set(zone, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(t)) o[p.type] = p.value;
  return {
    y: Number(o.year),
    mo: Number(o.month),
    d: Number(o.day),
    h: Number(o.hour) % 24,
    mi: Number(o.minute),
    dow: WEEKDAYS.indexOf(o.weekday ?? ""),
  };
}
/** The instant a wall-clock time in `zone` names. */
export function zoned(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const w = wall(t, zone);
    t += want - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  }
  return t;
}
const dayNumber = (t: number, zone: string) => {
  const w = wall(t, zone);
  return Date.UTC(w.y, w.mo - 1, w.d) / DAY;
};

// ── cron ──────────────────────────────────────────────────────────────────

interface Cron {
  mi: Set<number>;
  h: Set<number>;
  dom: Set<number>;
  mo: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}
function field(s: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let lo = min,
      hi = max;
    if (m[1] !== "*") {
      const [a, b] = (m[1] ?? "").split("-").map(Number);
      lo = a ?? min;
      hi = b ?? (m[2] ? max : lo);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
/** Numeric five-field cron only: names (`MON-FRI`) and a sixth field read as not-ours. */
export function parseCron(expr: string): Cron | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mo, dow] = [
    field(f[0] ?? "", 0, 59),
    field(f[1] ?? "", 0, 23),
    field(f[2] ?? "", 1, 31),
    field(f[3] ?? "", 1, 12),
    field(f[4] ?? "", 0, 7),
  ];
  if (!mi || !h || !dom || !mo || !dow) return null;
  return {
    mi,
    h,
    dom,
    mo,
    dow: new Set([...dow].map((v) => v % 7)),
    domAny: f[2] === "*",
    dowAny: f[4] === "*",
  };
}
/** The next `n` firings after `from`, walking the zone's wall clock. */
export function cronNext(c: Cron, from: number, n: number, zone: string): number[] {
  const out: number[] = [];
  let t = Math.floor(from / MIN) * MIN + MIN;
  for (let i = 0; i < 200_000 && out.length < n; i++) {
    const w = wall(t, zone),
      toMidnight = ((24 - w.h) * 60 - w.mi) * MIN;
    const dm = c.dom.has(w.d),
      dw = c.dow.has(w.dow);
    // Standard cron: with both day fields restricted, either one matches.
    const day = c.domAny && c.dowAny ? true : c.domAny ? dw : c.dowAny ? dm : dm || dw;
    if (!c.mo.has(w.mo) || !day) t += toMidnight;
    else if (!c.h.has(w.h)) t += (60 - w.mi) * MIN;
    else if (!c.mi.has(w.mi)) t += MIN;
    else {
      out.push(t);
      t += MIN;
    }
  }
  return out;
}

// ── schedule strings ──────────────────────────────────────────────────────

type Parsed =
  | { type: "every"; ms: number }
  | { type: "in"; ms: number }
  | { type: "at"; t: number }
  | { type: "cron"; c: Cron }
  | { type: "other" };
export function parseSchedule(s: string, zone: string): Parsed {
  const v = s.trim();
  let m = /^(?:every\s+)?(\d+)\s*([mhd])$/i.exec(v);
  if (m) return { type: "every", ms: Number(m[1]) * UNIT_MS[(m[2] ?? "m").toLowerCase() as Unit] };
  m = /^in\s+(\d+)\s*([mhd])$/i.exec(v);
  if (m) return { type: "in", ms: Number(m[1]) * UNIT_MS[(m[2] ?? "m").toLowerCase() as Unit] };
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (m) {
    const t = m[6]
      ? Date.parse(v)
      : zoned(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), zone);
    return Number.isNaN(t) ? { type: "other" } : { type: "at", t };
  }
  const c = parseCron(v);
  return c ? { type: "cron", c } : { type: "other" };
}

const unitWords = (ms: number) => {
  for (const [u, w] of [
    ["d", "day"],
    ["h", "hour"],
    ["m", "minute"],
  ] as const) {
    const n = ms / UNIT_MS[u];
    if (Number.isInteger(n)) return n === 1 ? w : `${n} ${w}s`;
  }
  return `${Math.round(ms / MIN)} minutes`;
};
const ordinal = (n: number) =>
  n +
  (n % 10 === 1 && n !== 11
    ? "st"
    : n % 10 === 2 && n !== 12
      ? "nd"
      : n % 10 === 3 && n !== 13
        ? "rd"
        : "th");
/** A weekday's name; 2023-01-01 was a Sunday. */
const dayName = (d: number, width: "long" | "short") =>
  new Intl.DateTimeFormat(LOCALE, { weekday: width, timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + d));
const clock = (h: number, m: number) =>
  new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    Date.UTC(2020, 0, 1, h, m),
  );
const pad = (n: number) => String(n).padStart(2, "0");

function cronWords(expr: string): string | null {
  const [mi = "", ho = "", dom = "", mon = "", dow = ""] = expr.trim().split(/\s+/);
  const num = (s: string) => /^\d+$/.test(s),
    rest = dom === "*" && mon === "*" && dow === "*";
  let m: RegExpExecArray | null;
  if (mi === "*" && ho === "*" && rest) return "Every minute";
  if ((m = /^\*\/(\d+)$/.exec(mi)) && ho === "*" && rest) return `Every ${m[1]} minutes`;
  if (num(mi) && ho === "*" && rest)
    return mi === "0" ? "Every hour, on the hour" : `Every hour at :${pad(Number(mi))}`;
  if (num(mi) && (m = /^\*\/(\d+)$/.exec(ho)) && rest)
    return `Every ${m[1]} hours${mi === "0" ? "" : ` at :${pad(Number(mi))}`}`;
  if (num(mi) && num(ho) && mon === "*") {
    const at = clock(Number(ho), Number(mi));
    if (dom === "*" && dow === "*") return `Every day at ${at}`;
    if (dom === "*" && dow === "1-5") return `Weekdays at ${at}`;
    if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `Weekends at ${at}`;
    if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
      const ds = dow.split(",").map((d) => Number(d) % 7);
      return ds.length === 1
        ? `Every ${dayName(ds[0] ?? 0, "long")} at ${at}`
        : `${ds.map((d) => dayName(d, "short")).join(", ")} at ${at}`;
    }
    if (num(dom) && dow === "*") return `Monthly on the ${ordinal(Number(dom))} at ${at}`;
  }
  return null;
}
/** The schedule in words; a form this module does not read is shown as written. */
export function describeSchedule(s: string, zone: string): string {
  const p = parseSchedule(s, zone);
  if (p.type === "every") return `Every ${unitWords(p.ms)}`;
  if (p.type === "in") return `Once, in ${unitWords(p.ms).replace(/^(minute|hour|day)$/, "1 $1")}`;
  if (p.type === "at") return `Once, ${formatStamp(p.t, zone)}`;
  if (p.type === "cron") return cronWords(s) ?? "Custom schedule";
  return s;
}
/**
 * The next `n` runs, or [] when the string is not one this module reads. An
 * interval counts from `now`: upstream anchors it at save time.
 */
export function nextRuns(s: string, zone: string, n: number, now: number): number[] {
  const p = parseSchedule(s, zone);
  if (p.type === "cron") return cronNext(p.c, now, n, zone);
  if (p.type === "every") return Array.from({ length: n }, (_, i) => now + (i + 1) * p.ms);
  if (p.type === "in") return [now + p.ms];
  if (p.type === "at") return p.t > now ? [p.t] : [];
  return [];
}

// ── the picker ────────────────────────────────────────────────────────────

export function defaultPicker(zone: string, now: number): Picker {
  const w = wall(now + DAY, zone);
  return {
    kind: "weekdays",
    time: "08:00",
    days: [1],
    dom: 1,
    minute: 0,
    n: 30,
    unit: "m",
    expr: "0 8 * * 1-5",
    date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`,
  };
}
export function toSchedule(p: Picker): string {
  const [h = 8, m = 0] = p.time.split(":").map(Number);
  switch (p.kind) {
    case "once":
      return `in ${p.n}${p.unit}`;
    case "at":
      return p.date ? `${p.date}T${p.time}` : "";
    case "hourly":
      return `${p.minute} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${[...p.days].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `${m} ${h} ${p.dom} * *`;
    case "interval":
      return `every ${p.n}${p.unit}`;
    case "cron":
      return p.expr;
  }
}
/** The picker that writes `s`, or the cron/advanced form when no preset does. */
export function fromSchedule(s: string, zone: string, now: number): Picker {
  const b = defaultPicker(zone, now),
    p = parseSchedule(s, zone);
  const span = (ms: number): Pick<Picker, "n" | "unit"> => {
    const unit: Unit = ms % DAY === 0 ? "d" : ms % HOUR === 0 ? "h" : "m";
    return { n: ms / UNIT_MS[unit], unit };
  };
  if (p.type === "every") return { ...b, kind: "interval", ...span(p.ms) };
  if (p.type === "in") return { ...b, kind: "once", ...span(p.ms) };
  if (p.type === "at") {
    const w = wall(p.t, zone);
    return {
      ...b,
      kind: "at",
      date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`,
      time: `${pad(w.h)}:${pad(w.mi)}`,
    };
  }
  const [mi = "", ho = "", dom = "", mon = "", dow = ""] = s.trim().split(/\s+/),
    num = (x: string) => /^\d+$/.test(x);
  if (p.type === "cron" && num(mi) && mon === "*") {
    const time = `${pad(Number(ho))}:${pad(Number(mi))}`;
    if (ho === "*" && dom === "*" && dow === "*") return { ...b, kind: "hourly", minute: Number(mi) };
    if (num(ho) && dom === "*" && dow === "*") return { ...b, kind: "daily", time };
    if (num(ho) && dom === "*" && dow === "1-5") return { ...b, kind: "weekdays", time };
    if (num(ho) && dom === "*" && /^[0-6](,[0-6])*$/.test(dow))
      return { ...b, kind: "weekly", time, days: dow.split(",").map(Number) };
    if (num(ho) && num(dom) && dow === "*") return { ...b, kind: "monthly", time, dom: Number(dom) };
  }
  return { ...b, kind: "cron", expr: s };
}
/** Switching kind keeps what carries over and seeds what the new kind needs. */
export function withKind(p: Picker, kind: Kind): Picker {
  if (kind === p.kind) return p;
  const next = { ...p, kind };
  if (kind === "cron") next.expr = parseCron(toSchedule(p)) ? toSchedule(p) : "0 8 * * 1-5";
  if (kind === "once") Object.assign(next, { n: 30, unit: "m" });
  if (kind === "interval") Object.assign(next, { n: 2, unit: "h" });
  return next;
}
/** What stops the picker's schedule from saving, or "". */
export function scheduleProblem(p: Picker, zone: string, now: number): string {
  if (p.kind === "weekly" && !p.days.length) return "Pick at least one day.";
  if (p.kind === "at" && !p.date) return "Pick a date.";
  if ((p.kind === "once" || p.kind === "interval") && !(p.n >= 1))
    return "Enter a number of at least 1.";
  if (p.kind === "monthly" && !(p.dom >= 1 && p.dom <= 31)) return "Day of month is 1–31.";
  if (p.kind === "hourly" && !(p.minute >= 0 && p.minute <= 59)) return "Minute is 0–59.";
  const s = toSchedule(p),
    parsed = parseSchedule(s, zone);
  if (parsed.type === "other") return "Not a cron expression (minute hour day month weekday).";
  if (parsed.type === "at" && parsed.t <= now) return "That time has already passed.";
  if (parsed.type === "cron" && !cronNext(parsed.c, now, 1, zone).length)
    return "This schedule never fires.";
  return "";
}

// ── formatting ────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.DateTimeFormat>();
function format(opts: Intl.DateTimeFormatOptions, zone: string): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { timeZone: zone, ...opts });
    formats.set(key, f);
  }
  return f;
}
export const formatTime = (t: number, zone: string) =>
  format({ hour: "numeric", minute: "2-digit" }, zone).format(t);
/** `Fri, Oct 23, 8:00 AM`. */
export const formatStamp = (t: number, zone: string) =>
  format(
    { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
    zone,
  ).format(t);
export const zoneAbbr = (t: number, zone: string) =>
  format({ timeZoneName: "short" }, zone)
    .formatToParts(t)
    .find((p) => p.type === "timeZoneName")?.value ?? zone;
export const weekdayShort = (t: number, zone: string) => format({ weekday: "short" }, zone).format(t);
/** `Today`, `Tomorrow`, a weekday within the week, else `Oct 30`. */
export function dayLabel(t: number, zone: string, now: number, short = false): string {
  const dd = dayNumber(t, zone) - dayNumber(now, zone);
  if (dd === 0) return "Today";
  if (dd === 1) return short ? "Tmrw" : "Tomorrow";
  if (dd === -1) return "Yesterday";
  if (dd > 1 && dd < 7) return format({ weekday: short ? "short" : "long" }, zone).format(t);
  return format({ month: "short", day: "numeric" }, zone).format(t);
}
export function relative(t: number, now: number): string {
  const d = t - now,
    a = Math.abs(d),
    rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto", style: "short" });
  if (a < HOUR) return rtf.format(Math.round(d / MIN), "minute");
  if (a < 36 * HOUR) return rtf.format(Math.round(d / HOUR), "hour");
  return rtf.format(Math.round(d / DAY), "day");
}
/** `11:00 AM your time` when the laptop's clock reads differently, else "". */
export function laptopTime(t: number, zone: string, laptop: string): string {
  if (formatTime(t, laptop) === formatTime(t, zone) && dayNumber(t, laptop) === dayNumber(t, zone))
    return "";
  const day = dayNumber(t, laptop) !== dayNumber(t, zone) ? `${weekdayShort(t, laptop)} ` : "";
  return `${day}${formatTime(t, laptop)} your time`;
}
/** Seven columns from today, 24 hour cells each, counting the runs in them. */
export function weekGrid(runs: number[], zone: string, now: number): number[][] {
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
    today = dayNumber(now, zone);
  for (const t of runs) {
    const col = cells[dayNumber(t, zone) - today];
    if (col) col[wall(t, zone).h] = (col[wall(t, zone).h] ?? 0) + 1;
  }
  return cells;
}
