/**
 * Fixture mode's kanban boards (§9.2, issue #117): an in-memory store per
 * instance, answering `/api/plugins/kanban/*` the way Hermes v0.21.5's plugin
 * does (`plugins/kanban/dashboard/plugin_api.py`). Seeded from the design
 * prototype (`.context/kanban-lab/data.js`), so the fixture app matches its
 * screenshots: same ids, titles, statuses, block reasons and summaries.
 *
 * What each `main` fleet box answers:
 * - `atlas`, `corvid`: on, with the prototype's cards.
 * - `ember`, `kestrel`: off — every kanban route 404s, as an unmounted plugin router does.
 * - `fathom`: unknown — every kanban route answers HTTP 500.
 * - `heron`: answers its first board read (the prototype's stale card), then
 *   nothing, so the next read shows that card stale. The roster calls heron unreachable.
 * - any other box the roster calls unreachable (`juniper`, `quill`): unreachable.
 * - everything else: on, with an empty board.
 *
 * `createFixtureKanbanStore()` is also the staging surface a fixture chat turn
 * uses to make an agent "create" a card: `create`, `set`, `get`.
 */
import type { BoxAddress, HermesChatClient } from "../../chat/hermes/hermes-chat.ts";
import type { KanbanTask } from "../../schema/kanban.ts";
import { CHAT_ERROR_CODES } from "../../chat/hermes/hermes-chat-types.ts";
import { HermeticError } from "../../errors.ts";
import type { ErrorCode } from "../../shared/error-codes.ts";
import { fixtureChatReachable } from "./fixture-chat-roster.ts";

const API = "/api/plugins/kanban";
const OFF = new Set(["ember", "kestrel"]);
const UNKNOWN = new Set(["fathom"]);
/** Answers its first board read, then goes dark: the stale row. */
const FLAKY = "heron";

const PROFILES: Record<string, string[]> = {
  atlas: ["default", "researcher"],
  corvid: ["default", "coder"],
};
const BOARDS: Record<string, string[]> = { atlas: ["default", "site-redesign"] };

// --- the prototype's cards (data.js), minutes ago -------------------------

interface Proto {
  id: string;
  inst: string;
  status: KanbanTask["status"];
  title: string;
  body: string;
  assignee: string | null;
  priority: number;
  ws: { kind: KanbanTask["workspace_kind"]; path: string; branch?: string; deleted?: boolean };
  skills: string[];
  model?: string | null;
  goal?: boolean;
  goal_turns?: [number, number];
  created_by: string;
  age: number;
  started?: number;
  ended?: number;
  hb?: number;
  summary: string | null;
  run_n: number;
  block_kind?: "needs_input" | "gave_up";
  block_reason?: string;
  sched_reason?: string;
  reviewer?: string;
  specifying?: boolean;
  decomposing?: boolean;
  files?: string[];
  waits_on?: [string, string];
  children?: [string, string, string][];
}

const TASKS: Proto[] = [
  {
    id: "t_3fa91c02",
    inst: "atlas",
    status: "running",
    title: "Write the Q3 churn summary from the billing exports",
    body: "Read the three CSV exports in ~/work/churn/in, compute monthly logo and revenue churn for July–September, and write churn-q3.md with a table and five bullet takeaways. Flag any month where the export looks truncated.",
    assignee: "researcher",
    priority: 1,
    ws: { kind: "dir", path: "~/work/churn" },
    skills: ["csv", "writing"],
    model: null,
    goal: false,
    created_by: "chat · atlas/default",
    age: 18,
    started: 6,
    hb: 0.6,
    summary: null,
    run_n: 1,
  },
  {
    id: "t_8b20d6e1",
    inst: "atlas",
    status: "blocked",
    block_kind: "needs_input",
    block_reason:
      "The vendor list spans $29–$399/mo. What is the monthly budget ceiling, and is self-hosting acceptable?",
    title: "Find three alternatives to our status-page vendor",
    body: "Compare at least five status-page products against our current vendor on price, custom domain, SSO and incident templates. Recommend three, with a one-paragraph reason each.",
    assignee: "researcher",
    priority: 0,
    ws: { kind: "dir", path: "~/work/statuspage" },
    skills: ["web"],
    model: null,
    goal: false,
    created_by: "chat · atlas/default",
    age: 52,
    started: 40,
    summary: "Shortlisted 7 vendors; waiting on a budget before ranking.",
    run_n: 1,
  },
  {
    id: "t_c41e77aa",
    inst: "atlas",
    status: "review",
    title: "Draft the launch post for v0.3",
    body: "Write a 600-word launch post for hermetic v0.3 from the release notes in ~/work/launch/notes.md. Plain voice, no superlatives. Save as post.md.",
    assignee: "default",
    reviewer: "default · sdlc-review",
    priority: 2,
    ws: { kind: "dir", path: "~/work/launch" },
    skills: ["writing"],
    model: "anthropic · claude-opus-5-5",
    goal: true,
    goal_turns: [4, 12],
    created_by: "dashboard",
    age: 95,
    started: 70,
    summary: "Drafted post.md (612 words). Judge accepted on turn 4; sent to review.",
    run_n: 2,
    children: [
      ["t_c41e77ab", "Pull quotes from the v0.3 notes", "done"],
      ["t_c41e77ac", "Pick a header image", "done"],
    ],
  },
  {
    id: "t_0a5d9e33",
    inst: "atlas",
    status: "triage",
    title: "clean up the downloads folder rules somehow",
    body: "",
    assignee: "default",
    priority: 0,
    ws: { kind: "dir", path: "~/work/downloads" },
    skills: [],
    model: null,
    goal: false,
    created_by: "dashboard",
    age: 1,
    summary: null,
    run_n: 0,
    specifying: true,
  },
  {
    id: "t_77e1b4f0",
    inst: "atlas",
    status: "todo",
    title: "Tag last month's invoices by client",
    body: "For every invoice in invoices-sep.csv, add a client column from the customer map and write invoices-sep-tagged.csv.",
    assignee: "default",
    priority: 0,
    ws: { kind: "dir", path: "~/work/invoices" },
    skills: ["csv"],
    model: null,
    goal: false,
    created_by: "decomposer",
    age: 30,
    summary: null,
    run_n: 0,
    waits_on: ["t_5c9a02bd", "Export September invoices from Stripe to CSV"],
  },
  {
    id: "t_5c9a02bd",
    inst: "atlas",
    status: "ready",
    title: "Export September invoices from Stripe to CSV",
    body: "Use the stripe skill to export all September invoices (paid and open) to invoices-sep.csv.",
    assignee: "default",
    priority: 2,
    ws: { kind: "scratch", path: "~/.hermes/kanban/workspaces/t_5c9a02bd" },
    skills: ["stripe"],
    model: null,
    goal: false,
    created_by: "decomposer",
    age: 30,
    summary: null,
    run_n: 0,
  },
  {
    id: "t_e2f81a6c",
    inst: "atlas",
    status: "scheduled",
    sched_reason: "Run after Friday's deploy window (2026-10-24 09:00)",
    title: "Weekly dependency audit",
    body: "Run the dependency audit across the three repos and open one summary issue.",
    assignee: "default",
    priority: 0,
    ws: { kind: "dir", path: "~/work/audit" },
    skills: ["github"],
    model: null,
    goal: false,
    created_by: "cron · weekly-audit",
    age: 300,
    summary: null,
    run_n: 0,
  },
  {
    id: "t_91b0c3d4",
    inst: "atlas",
    status: "done",
    title: "Write a 3-line haiku about kanban boards to haiku.txt",
    body: "Create a haiku (5-7-5) about kanban boards and write it to haiku.txt in the workspace root, one line per line.",
    assignee: "default",
    priority: 0,
    ws: { kind: "scratch", path: "~/.hermes/kanban/workspaces/t_91b0c3d4", deleted: true },
    skills: [],
    model: "bedrock · claude-haiku-4-5",
    goal: false,
    created_by: "dashboard",
    age: 62,
    started: 61,
    ended: 60,
    summary:
      "Created a 3-line haiku about kanban boards (5-7-5). Written to haiku.txt in the workspace.",
    run_n: 1,
    files: ["haiku.txt"],
  },
  {
    id: "t_4d6f0e12",
    inst: "atlas",
    status: "done",
    title: "Summarise the review comments on PR #118",
    body: "Read every review comment on PR #118 and group them into must-fix, nice-to-have and disagreements.",
    assignee: "researcher",
    priority: 0,
    ws: { kind: "dir", path: "~/work/pr118" },
    skills: ["github"],
    model: null,
    goal: false,
    created_by: "chat · atlas/default",
    age: 180,
    started: 176,
    ended: 170,
    summary: "14 comments → 4 must-fix, 7 nice-to-have, 3 disagreements. Wrote summary.md.",
    run_n: 1,
    files: ["summary.md"],
  },
  {
    id: "t_ab33c901",
    inst: "atlas",
    status: "blocked",
    block_kind: "gave_up",
    block_reason: "Crashed twice: playwright exited 1 — net::ERR_BLOCKED_BY_CLIENT on speakers page.",
    title: "Scrape the conference speaker list",
    body: "Collect name, company and talk title for every speaker on the conference site into speakers.csv.",
    assignee: "researcher",
    priority: 1,
    ws: { kind: "dir", path: "~/work/speakers" },
    skills: ["browser"],
    model: null,
    goal: false,
    created_by: "dashboard",
    age: 140,
    started: 130,
    summary: null,
    run_n: 2,
  },
  {
    id: "t_19c4e5f7",
    inst: "corvid",
    status: "running",
    title: "Fix the flaky test in the payments suite",
    body: "payments/refund.test.ts fails about 1 in 20 runs on CI. Find the cause, fix it, and prove it with 200 consecutive local runs.",
    assignee: "coder",
    priority: 3,
    ws: { kind: "worktree", path: "~/src/shop", branch: "kanban/t_19c4e5f7" },
    skills: ["github", "testing"],
    model: null,
    goal: true,
    goal_turns: [3, 12],
    created_by: "dashboard",
    age: 25,
    started: 22,
    hb: 0.3,
    summary: "Race between the refund webhook and the ledger write; trying a transactional outbox.",
    run_n: 1,
  },
  {
    id: "t_6e0b8a21",
    inst: "corvid",
    status: "ready",
    title: "Bump pnpm to 9.12 across the repos",
    body: "Update packageManager in each repo, regenerate the lockfile, open one PR per repo.",
    assignee: null,
    priority: 0,
    ws: { kind: "worktree", path: "~/src", branch: "kanban/t_6e0b8a21" },
    skills: ["github"],
    model: null,
    goal: false,
    created_by: "dashboard",
    age: 210,
    summary: null,
    run_n: 0,
  },
  {
    id: "t_d27f3a90",
    inst: "corvid",
    status: "done",
    title: "Investigate the 502s on /api/upload",
    body: "Find why /api/upload returns 502 for files over 50 MB.",
    assignee: "coder",
    priority: 2,
    ws: { kind: "dir", path: "~/work/upload-502" },
    skills: [],
    model: null,
    goal: false,
    created_by: "chat · corvid/default",
    age: 400,
    started: 395,
    ended: 380,
    summary:
      "nginx client_max_body_size was 50m on the edge; raised to 200m and documented in findings.md.",
    run_n: 1,
    files: ["findings.md"],
  },
  {
    id: "t_aa04c7d8",
    inst: "corvid",
    status: "triage",
    title: "Port the release script to bun",
    body: "",
    assignee: "coder",
    priority: 0,
    ws: { kind: "worktree", path: "~/src/shop", branch: "kanban/t_aa04c7d8" },
    skills: [],
    model: null,
    goal: false,
    created_by: "dashboard",
    age: 3,
    summary: null,
    run_n: 0,
    decomposing: true,
  },
  // HERON_STALE: what heron's one good read returns.
  {
    id: "t_b7d3e019",
    inst: "heron",
    status: "running",
    title: "Nightly backup verification",
    body: "",
    assignee: "default",
    priority: 0,
    ws: { kind: "dir", path: "~/work/backup" },
    skills: [],
    created_by: "cron",
    age: 50,
    started: 48,
    hb: 9,
    summary: null,
    run_n: 1,
  },
];

const COMMENTS: Record<string, [string, number, string][]> = {
  t_3fa91c02: [["auto-specifier", 17, "Specified — named the output file and the three months."]],
  t_8b20d6e1: [
    [
      "researcher",
      30,
      "Shortlist: Instatus, Better Stack, Statuspage, Cachet (self-host), Upptime (self-host), Hund, Sorry™.",
    ],
    ["researcher", 12, "Blocked: need a budget ceiling before I rank them."],
  ],
  t_c41e77aa: [["auto-decomposer", 94, "Decomposed into 2 subtasks; this card orchestrates."]],
  t_91b0c3d4: [["auto-decomposer", 61, "Specified — updated title, body and promoted to todo."]],
};

const pid = (id: string) => 90000 + (parseInt(id.slice(2, 6), 16) % 9000);

/** data.js `events(t)`, oldest first, as `[minutes ago, kind, payload]`. */
function protoEvents(t: Proto): [number, string, Record<string, unknown>][] {
  const e: [number, string, Record<string, unknown>][] = [];
  const add = (min: number, kind: string, detail = "", extra: Record<string, unknown> = {}) =>
    e.push([min, kind.replaceAll(" ", "_"), { ...(detail ? { detail } : {}), ...extra }]);
  add(t.age, "created", `by ${t.created_by} · ${t.ws.kind}`);
  if (t.status === "triage") {
    if (t.specifying) add(0.5, "specifier claimed", "rewriting title and body");
    if (t.decomposing) add(1, "decomposer claimed", "splitting into subtasks");
    return e;
  }
  if (t.created_by === "dashboard") add(t.age - 0.5, "specified", "changed: title, body");
  add(t.age - 0.6, "promoted", t.waits_on ? "to todo" : "to ready");
  if (t.waits_on) {
    add(t.age - 0.7, "dependency wait", t.waits_on[0]);
    return e;
  }
  if (t.status === "scheduled") {
    add(t.age - 1, "scheduled", t.sched_reason, { reason: t.sched_reason });
    return e;
  }
  if (!t.assignee) {
    add(t.age - 1, "dispatcher skipped", "no assignee — parked");
    return e;
  }
  if (t.started === undefined) return e;
  const started = t.started;
  if (t.run_n > 1 && t.block_kind === "gave_up") {
    add(started, "claimed", "run 1");
    add(started - 0.1, "worker started", "pid 41022");
    add(started - 3, "crashed", "exit 1");
    add(started - 4, "claimed", "run 2");
    add(started - 4.1, "worker started", "pid 41388");
    add(started - 7, "crashed", "exit 1");
    add(started - 7.1, "gave up", "failure limit 2 reached → blocked", { reason: t.block_reason });
    return e;
  }
  add(started, "claimed", `by a worker · run ${t.run_n}`);
  if (t.ws.kind === "scratch")
    add(started - 0.05, "tip", "scratch workspaces are deleted on completion");
  add(started - 0.1, "worker started", `pid ${pid(t.id)}`);
  if (t.goal && t.goal_turns) add(started - 2, "judge", `turn ${t.goal_turns[0] - 1} — not yet`);
  const end = t.ended ?? 0;
  const span = started - end;
  for (let i = 1; i <= Math.min(3, Math.floor(span)); i++) add(started - (i * span) / 4, "heartbeat");
  if (t.status === "running" && t.hb !== undefined) add(t.hb, "heartbeat");
  if (t.status === "blocked")
    add(started - 8, "blocked", "needs input", { kind: t.block_kind, reason: t.block_reason });
  if (t.status === "review") {
    add(started - 20, "review requested", `reviewer ${t.reviewer}`);
    add(2, "claimed", "by reviewer");
  }
  if (t.status === "done") add(end, "completed");
  if (t.status === "done" && t.ws.deleted)
    add(end - 0.01, "workspace deleted", `scratch · ${(t.files ?? []).join(", ")} removed`);
  // data.js appends in its own order and reverses for display; sort so ids run oldest first.
  return e.sort((a, b) => b[0] - a[0]);
}

/** data.js `runs(t)`, oldest first. Durations in seconds. */
function protoRuns(t: Proto, at: (min: number) => number): Record<string, unknown>[] {
  if (t.started === undefined) return [];
  const run = (n: number, outcome: string, startMin: number, seconds: number | null, extra = {}) => ({
    id: n,
    profile: t.assignee,
    status: outcome,
    outcome: outcome === "running" ? null : outcome,
    summary: null,
    error: null,
    worker_pid: outcome === "running" ? pid(t.id) : null,
    started_at: at(startMin),
    ended_at: seconds === null ? null : at(startMin) + seconds,
    ...extra,
  });
  if (t.block_kind === "gave_up")
    return [
      run(1, "crashed", t.started, 171, { error: "playwright exited 1" }),
      run(2, "crashed", t.started - 4, 182, {
        error: (t.block_reason ?? "").replace("Crashed twice: ", ""),
      }),
    ];
  const r: Record<string, unknown>[] = [];
  if (t.run_n > 1)
    r.push(
      run(1, "released", t.started, 660, {
        summary: "Judge: draft too long (980 words). Released for another turn.",
      }),
    );
  const outcome = t.status === "running" ? "running" : t.status === "blocked" ? "blocked" : "completed";
  const seconds =
    t.status === "running" ? null : Math.max(60, Math.round((t.started - (t.ended ?? 0)) * 60));
  r.push(run(t.run_n, outcome, t.started, seconds, { summary: t.summary }));
  return r;
}

/** data.js `workerLog(t)`. */
function protoLog(t: Proto): string | null {
  if (t.started === undefined) return null;
  const lines = [
    `[worker] task ${t.id} claimed by ${t.assignee} · workspace ${t.ws.kind}:${t.ws.path}`,
    `[worker] skills: ${t.skills.join(", ") || "(profile default)"}`,
    `[hermes] session kanban-${t.id.slice(2)} started · model ${t.model ?? "profile default"}`,
    `[tool] read_file ${t.ws.path}/…`,
    `[tool] terminal: ls -la ${t.ws.path}`,
  ];
  if (t.block_kind === "gave_up")
    lines.push(
      "[tool] browser.goto https://conf.example/speakers",
      "[error] net::ERR_BLOCKED_BY_CLIENT",
      "[worker] exit 1",
    );
  else if (t.status === "running") lines.push("[heartbeat] ok", "[tool] terminal: …", "[heartbeat] ok");
  else if (t.status === "blocked")
    lines.push("[tool] kanban_block kind=needs_input", "[worker] released claim");
  else
    lines.push(
      `[tool] write_file ${(t.files ?? ["out.md"])[0]}`,
      "[tool] kanban_complete",
      "[worker] exit 0",
    );
  return lines.join("\n");
}

// --- the store ------------------------------------------------------------

interface Card {
  task: KanbanTask;
  comments: { id: number; author: string; body: string; created_at: number }[];
  events: { id: number; kind: string; payload: Record<string, unknown>; created_at: number }[];
  runs: Record<string, unknown>[];
  log: string | null;
  parents: string[];
  children: string[];
}

/** What a fixture chat turn passes to `create`; the rest takes upstream's defaults. */
export interface FixtureKanbanCreate {
  title: string;
  body?: string | null;
  assignee?: string | null;
  workspace_kind?: KanbanTask["workspace_kind"];
  created_by?: string | null;
  session_id?: string | null;
}

export interface FixtureKanbanStore {
  create(instance: string, card: FixtureKanbanCreate): KanbanTask;
  set(instance: string, id: string, patch: Partial<KanbanTask>): KanbanTask;
  get(instance: string, id: string): KanbanTask | undefined;
  /** The plugin's REST surface over this store (`withFixtureKanban`). */
  rest(box: BoxAddress, method: string, path: string, body?: unknown): unknown;
}

const blank = (id: string, now: number, c: FixtureKanbanCreate): KanbanTask => ({
  id,
  title: c.title,
  body: c.body ?? null,
  status: "ready",
  assignee: c.assignee ?? null,
  priority: 0,
  created_by: c.created_by ?? "dashboard",
  created_at: now,
  started_at: null,
  completed_at: null,
  last_heartbeat_at: null,
  worker_pid: null,
  workspace_kind: c.workspace_kind ?? "scratch",
  workspace_path: null,
  branch_name: null,
  skills: null,
  model_override: null,
  provider_override: null,
  goal_mode: false,
  goal_max_turns: null,
  block_kind: null,
  last_failure_error: null,
  consecutive_failures: 0,
  latest_summary: null,
  comment_count: 0,
  link_counts: { parents: 0, children: 0 },
  session_id: c.session_id ?? null,
  result: null,
});

export function createFixtureKanbanStore(nowMs: () => number = Date.now): FixtureKanbanStore {
  const nowS = () => Math.floor(nowMs() / 1000);
  const seededAt = nowS();
  const at = (min: number) => Math.round(seededAt - min * 60);
  const boards = new Map<string, Map<string, Card>>();
  /** Linked cards that are not on the board (an orchestrator's finished subtasks). */
  const refs = new Map<string, { title: string; status: string }>();
  let serial = 0;
  let eventId = 0;
  let flakyServed = false;
  const board = (instance: string) => {
    let b = boards.get(instance);
    if (!b) boards.set(instance, (b = new Map()));
    return b;
  };

  for (const t of TASKS) {
    const [provider, model] = t.model ? t.model.split(" · ") : [null, null];
    const comments = (COMMENTS[t.id] ?? []).map(([author, min, body]) => ({
      id: ++serial,
      author,
      body,
      created_at: at(min),
    }));
    const parents = t.waits_on ? [t.waits_on[0]] : [];
    const children = (t.children ?? []).map(([id, title, status]) => {
      refs.set(id, { title, status });
      return id;
    });
    board(t.inst).set(t.id, {
      task: {
        ...blank(t.id, at(t.age), { title: t.title, created_by: t.created_by }),
        body: t.body || null,
        status: t.status,
        assignee: t.assignee,
        priority: t.priority,
        started_at: t.started === undefined ? null : at(t.started),
        completed_at: t.ended === undefined ? null : at(t.ended),
        last_heartbeat_at: t.hb === undefined ? null : at(t.hb),
        worker_pid: t.status === "running" ? pid(t.id) : null,
        workspace_kind: t.ws.kind,
        workspace_path: t.ws.path,
        branch_name: t.ws.branch ?? null,
        skills: t.skills,
        model_override: model ?? null,
        provider_override: provider ?? null,
        goal_mode: t.goal ?? false,
        goal_max_turns: t.goal_turns?.[1] ?? null,
        block_kind: t.block_kind ?? null,
        last_failure_error: t.block_kind === "gave_up" ? (t.block_reason ?? null) : null,
        consecutive_failures: t.block_kind === "gave_up" ? 2 : 0,
        latest_summary: t.summary,
        comment_count: comments.length,
        link_counts: { parents: parents.length, children: children.length },
      },
      comments,
      events: protoEvents(t).map(([min, kind, payload]) => ({
        id: ++eventId,
        kind,
        payload,
        created_at: at(min),
      })),
      runs: protoRuns(t, at),
      log: protoLog(t),
      parents,
      children,
    });
  }
  // The parent side of `t_77e1b4f0`'s dependency.
  for (const [, cards] of boards)
    for (const card of cards.values())
      for (const parent of card.parents) {
        const p = cards.get(parent);
        if (p && !p.children.includes(card.task.id)) {
          p.children.push(card.task.id);
          p.task.link_counts = { ...p.task.link_counts, children: p.children.length };
        }
      }

  const event = (card: Card, kind: string, payload: Record<string, unknown> = {}) =>
    card.events.push({ id: ++eventId, kind, payload, created_at: nowS() });
  const notFound = (id: string) => new HermeticError("NOT_FOUND", `task ${id} not found (HTTP 404)`);
  const cardOf = (instance: string, id: string) => {
    const card = board(instance).get(id);
    if (!card) throw notFound(id);
    return card;
  };

  function create(instance: string, c: FixtureKanbanCreate): KanbanTask {
    const id = `t_f${(++serial).toString(16).padStart(7, "0")}`;
    const card: Card = {
      task: blank(id, nowS(), c),
      comments: [],
      events: [],
      runs: [],
      log: null,
      parents: [],
      children: [],
    };
    board(instance).set(id, card);
    event(card, "created", { detail: `by ${card.task.created_by} · ${card.task.workspace_kind}` });
    return card.task;
  }
  function set(instance: string, id: string, patch: Partial<KanbanTask>): KanbanTask {
    const card = cardOf(instance, id);
    if (patch.status && patch.status !== card.task.status) {
      event(card, "status", { status: patch.status });
      // A worker claiming the card opens a run; leaving `running` closes it.
      const open = card.runs.at(-1);
      if (open?.status === "running") {
        const outcome = patch.status === "done" ? "completed" : patch.status;
        Object.assign(open, { status: outcome, outcome, ended_at: nowS() });
      }
      if (patch.status === "running")
        card.runs.push({
          id: card.runs.length + 1,
          profile: patch.assignee ?? card.task.assignee,
          status: "running",
          outcome: null,
          summary: null,
          error: null,
          worker_pid: null,
          started_at: nowS(),
          ended_at: null,
        });
    }
    card.task = { ...card.task, ...patch, id };
    return card.task;
  }
  const get = (instance: string, id: string) => board(instance).get(id)?.task;

  function answer(instance: string, method: string, path: string, body: unknown): unknown {
    const url = new URL(path, "http://fixture");
    const p = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const [, , id, action] = url.pathname.slice(API.length).split("/");
    const route = `${method} ${id === undefined ? url.pathname.slice(API.length) : `/tasks/:id${action ? `/${action}` : ""}`}`;
    const cards = board(instance);
    switch (route) {
      case "GET /board": {
        const live = [...cards.values()].map((c) => c.task).filter((t) => t.status !== "archived");
        return {
          columns: ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"].map(
            (name) => ({ name, tasks: live.filter((t) => t.status === name) }),
          ),
          tenants: [],
          assignees: [...new Set(live.flatMap((t) => t.assignee ?? []))].sort(),
          latest_event_id: eventId,
          now: nowS(),
        };
      }
      case "GET /profiles":
        return {
          profiles: (PROFILES[instance] ?? ["default"]).map((name) => ({
            name,
            is_default: name === "default",
          })),
        };
      case "GET /boards": {
        const slugs = BOARDS[instance] ?? ["default"];
        return {
          boards: slugs.map((slug) => ({ slug, is_current: slug === "default" })),
          current: "default",
        };
      }
      case "POST /tasks": {
        const task = create(instance, {
          title: String(p.title ?? ""),
          body: typeof p.body === "string" ? p.body : null,
          assignee: typeof p.assignee === "string" && p.assignee ? p.assignee : null,
          workspace_kind: (p.workspace_kind as KanbanTask["workspace_kind"]) ?? "scratch",
          created_by: "dashboard",
        });
        return {
          task: set(instance, task.id, {
            status: p.triage === true ? "triage" : "ready",
            priority: typeof p.priority === "number" ? p.priority : 0,
            workspace_path: typeof p.workspace_path === "string" ? p.workspace_path : null,
            skills: Array.isArray(p.skills) ? (p.skills as string[]) : null,
            goal_mode: p.goal_mode === true,
            goal_max_turns: typeof p.goal_max_turns === "number" ? p.goal_max_turns : null,
          }),
        };
      }
    }
    const card = cardOf(instance, id ?? "");
    const tid = card.task.id;
    switch (route) {
      case "GET /tasks/:id": {
        const linked = [...card.parents, ...card.children].map((lid) => {
          const t = cards.get(lid)?.task;
          return t ? { id: lid, title: t.title, status: t.status } : { id: lid, ...refs.get(lid) };
        });
        return {
          task: card.task,
          comments: card.comments,
          events: card.events,
          attachments: [],
          links: { parents: card.parents, children: card.children },
          link_tasks: linked.filter((l) => l.title !== undefined),
          runs: card.runs,
        };
      }
      case "PATCH /tasks/:id": {
        const status = p.status;
        if (status === "running")
          throw new HermeticError("CHAT_PROTOCOL", `${instance}: dashboard PATCH failed (HTTP 400)`);
        if (
          status === "ready" &&
          (card.task.status === "blocked" || card.task.status === "scheduled")
        ) {
          // upstream `unblock_task`: block_kind is kept so a same-kind re-block reads as a loop.
          card.task = { ...card.task, status: "ready" };
          event(card, "unblocked");
          return { task: card.task };
        }
        return {
          task:
            typeof status === "string"
              ? set(instance, tid, { status: status as KanbanTask["status"] })
              : card.task,
        };
      }
      case "DELETE /tasks/:id":
        cards.delete(tid);
        return { deleted: true, task_id: tid };
      case "POST /tasks/:id/comments": {
        card.comments.push({
          id: ++serial,
          author: String(p.author ?? "dashboard"),
          body: String(p.body ?? ""),
          created_at: nowS(),
        });
        card.task = { ...card.task, comment_count: card.comments.length };
        event(card, "commented", { author: p.author ?? "dashboard" });
        return { ok: true };
      }
      case "POST /tasks/:id/reassign": {
        const assignee = typeof p.profile === "string" && p.profile ? p.profile : null;
        card.task = { ...card.task, assignee };
        event(card, "assigned", { assignee });
        return { ok: true, task_id: tid, assignee };
      }
      case "GET /tasks/:id/log": {
        const content = card.log ?? "";
        const tail = Number(url.searchParams.get("tail") ?? 0);
        return {
          task_id: tid,
          path: `~/.hermes/kanban/logs/${tid}.log`,
          exists: card.log !== null,
          size_bytes: content.length,
          content: tail > 0 ? content.slice(-tail) : content,
          truncated: tail > 0 && content.length > tail,
        };
      }
    }
    throw new HermeticError("NOT_FOUND", `${instance}: dashboard ${method} failed (HTTP 404)`);
  }

  return {
    create,
    set,
    get,
    rest(box, method, path, body) {
      const fail = (code: ErrorCode, status: string) =>
        new HermeticError(code, `${box.instance}: dashboard ${method} failed (${status})`);
      if (OFF.has(box.instance)) throw fail("NOT_FOUND", "HTTP 404");
      if (UNKNOWN.has(box.instance)) throw fail("CHAT_PROTOCOL", "HTTP 500");
      if (box.instance === FLAKY) {
        if (flakyServed || new URL(path, "http://fixture").pathname !== `${API}/board`)
          throw fail(CHAT_ERROR_CODES.UNREACHABLE, "the box did not answer");
        flakyServed = true;
      } else if (!fixtureChatReachable(box.instance))
        throw fail(CHAT_ERROR_CODES.UNREACHABLE, "the box did not answer");
      return answer(box.instance, method, path, body);
    },
  };
}

/** `base`, with `/api/plugins/kanban/*` answered from `store`. */
export function withFixtureKanban(base: HermesChatClient, store: FixtureKanbanStore): HermesChatClient {
  const inner = base.botModeRest;
  return {
    ...base,
    async botModeRest(box, method, path, body, opts) {
      if (path.startsWith(`${API}/`)) return store.rest(box, method, path, body);
      if (!inner) throw new HermeticError("CHAT_PROTOCOL", "Bot Mode dashboard API is unavailable");
      return inner(box, method, path, body, opts);
    },
  };
}
