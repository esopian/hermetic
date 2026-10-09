/**
 * The fixture swarm's transcripts: the canned messages and
 * blocks `fixture-chat.ts` answers `history` from, and the reply it streams.
 * Pure data — every shape a renderer has to handle is reachable from these
 * tables, and `fixture-chat.test.ts` asserts that coverage structurally.
 *
 * Split out of `fixture-chat.ts` (AGENTS.md rule 5); the roster the sessions
 * hang off lives in `fixture-chat-roster.ts`.
 */
import type { ChatMessage } from "../../schema/index.ts";
import { at } from "./fixture-chat-roster.ts";
import { KESTREL_EVENTS_SESSION, KESTREL_EVENTS_TRANSCRIPT } from "./fixture-chat-process-events.ts";

/* ── prose the transcripts are made of ────────────────────────────────────── */

/**
 * Joined rather than written as one template literal because the markdown has
 * fenced code in it, and a fence inside a template literal is three escaped
 * backticks that nobody can read. The renderer's fenced-code path is one of
 * the three `text` variants this catalogue covers — plain prose, fenced code,
 * and cited text — so it has to be here and it has to be legible.
 */
export const md = (...lines: string[]): string => lines.join("\n");

/**
 * The answer with citation markers in it. `[1]` and `[2]` line up with the
 * first two entries of `SOURCES` below, and the pairing is the fixture: a
 * `sources` block whose numbering does not match the prose above it renders
 * fine and means nothing, which is a bug no unit test on either block alone can
 * see.
 */
const CITED = md(
  "Short answer: the cache is not the bottleneck, the volume is.",
  "",
  "A gp3 volume ships 125 MB/s of throughput until somebody provisions more [1],",
  "and this one never was. The write cache's queue depth sits at four for the",
  "whole sample, which is what a queue looks like when it is waiting on the",
  "device rather than on the application [2].",
);

const FENCED = md(
  "Here is the change I would make. It provisions throughput on the volume and",
  "leaves the cache alone:",
  "",
  "```bash",
  "aws ec2 modify-volume \\",
  "  --volume-id vol-fixture00000000012 \\",
  "  --throughput 500 \\",
  "  --iops 6000",
  "```",
  "",
  "That is a live-resize, so nothing unmounts and nothing reboots.",
);

/** The sources card that backs the cited-text variant above. */
export const SOURCES = [
  {
    title: "Amazon EBS volume types - gp3",
    href: "https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html",
    snippet: "gp3 volumes deliver a baseline 125 MiB/s regardless of volume size.",
  },
  {
    title: "gp3 throughput is 125 MB/s until provisioned",
    href: "https://repost.aws/questions/fixture-gp3-throughput",
    snippet: "Provisioned throughput is billed separately and applies without a detach.",
  },
  {
    title: "Benchmarking gp2 vs gp3 for write-heavy caches",
    href: "https://blog.example.dev/gp3-write-cache",
    snippet: null,
  },
];

/**
 * The reply `send` streams, and the only string here chosen for its *length*.
 *
 * A streaming renderer is the one part of this view that cannot be checked
 * against a still: the delta gate in `../chat.ts` holds back a partial secret
 * pattern, the browser has to keep the scroll pinned while text lands, and both
 * of those need more than a sentence to show anything. So this is four
 * paragraphs, and `chunk` below cuts it at fixed widths that land mid-word on
 * purpose — upstream splits on tokens, not on spaces, and a fixture that only
 * ever split on spaces would let a renderer that re-joins with a space pass.
 */
export const FIXTURE_CHAT_REPLY = md(
  "Right - I can see the box from here. The gateway is up, the data volume is",
  "mounted at /data, and the agent's own log has nothing in it since the last",
  "restart, which is the first good sign.",
  "",
  "I pulled the last hour of metrics before answering, because the interesting",
  "question is not whether the box is busy but whether it is busy waiting. It",
  "is: CPU sits under forty percent for the whole window while the device queue",
  "never drops below four. That is a volume that has run out of throughput, not",
  "a process that has run out of CPU.",
  "",
  "The fix is a live resize of the volume - no detach, no reboot, and the agent",
  "keeps its session. I have written it out above. If you would rather I did not",
  "touch anything in the account from here, say so and I will hand you the",
  "command instead of running it.",
);

/* ── the transcripts ──────────────────────────────────────────────────────── */

export const usage = (input: number, output: number, cost: number, model: string) => ({
  input_tokens: input,
  output_tokens: output,
  cost_usd: cost,
  model,
});

/**
 * Every failure this fixture draws, as the one thing they actually are:
 * a `ChatMessage` with `error` set and `incomplete` true, not six block kinds.
 *
 * The string is `CODE · detail`, and the code leads because that is what a head
 * branches on — the failure card prints exactly this shape into its `<pre>`,
 * and the rest of the card is copy the renderer owns. Exported so the renderer's
 * own tests can enumerate the set instead of hand-listing six strings that would
 * drift the first time one is reworded.
 */
export const FIXTURE_CHAT_FAILURES = {
  /** Rate limited. Self-retrying; the card draws the countdown and the attempt number. */
  rate_limited: "PROVIDER_RATE_LIMITED · anthropic returned 429 - retrying, attempt 2 of 5",
  /** The profile's key was rejected. Routes to Settings. No key is in the message, and none can be. */
  credential_rejected: "PROVIDER_UNAUTHORIZED · invalid x-api-key",
  /** Hit the turn ceiling. hermetic's own default for an unattended box, not upstream's. */
  turn_ceiling: "TURN_CEILING · stopped at max_turns 500 - the work so far is on the box",
  /** The context window is full. Offers the compaction rather than just reporting the wall. */
  context_full: "CONTEXT_FULL · 198k of the model's 200k window is in this thread",
  /**
   * The box went away mid-turn. Fleet data, not a guess: the heartbeat and
   * the unit restarts are real rows.
   */
  box_went_away:
    "CHAT_UNREACHABLE · ember stopped answering mid-turn - heartbeat 4m stale, " +
    "hermes-gateway.service restarted 3 times in 2 minutes",
  /** The model is not granted. No cross-provider guessing: the grant is a foundation fact. */
  model_missing:
    "MODEL_NOT_GRANTED · bedrock ValidationException - us.anthropic.claude-sonnet-5 " +
    "is not in this foundation's Bedrock grant",
} as const;

/**
 * Session id to transcript.
 *
 * `sx-atlas-portal` carries the whole catalogue on purpose: all nine block
 * kinds, all five `render` hints plus the null one, all four `ToolStatus`
 * values and all four `HermeticCard` targets, in the order a real turn would
 * have produced them. One long transcript rather than nine short ones because
 * the collapse rule is a property of a transcript and not of a card — `ok`,
 * `warn`, `bad`, `acc` and `muted` start collapsed and `unknown` and any error
 * start expanded, and whether that reads as calm or as a wall of chevrons is
 * only visible when they are stacked.
 *
 * The other transcripts are short, and five of them exist to carry one failure
 * each. They are placed on the agent whose fleet row already tells the same
 * story — the Bedrock grant failure is on `atlas`, which the fleet fixture pins
 * to the Bedrock profile at r1, and the box that went away is `ember`.
 */
export const FIXTURE_CHAT_TRANSCRIPTS: Readonly<Record<string, readonly ChatMessage[]>> = {
  "sx-atlas-portal": [
    {
      id: "mx-atlas-portal-1",
      session: "sx-atlas-portal",
      role: "user",
      author: null,
      at: at("09:24:00"),
      blocks: [
        {
          kind: "text",
          markdown:
            "Walk the gp3 numbers on granite and tell me whether the write cache is the problem.",
        },
      ],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-portal-2",
      session: "sx-atlas-portal",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("09:24:06"),
      blocks: [
        {
          kind: "reasoning",
          text:
            "The operator is asking about the cache, but the cache is a symptom if the " +
            "device is saturated. Check queue depth against CPU before answering, and do " +
            "not touch the account until they ask for a change.",
          duration_ms: 4120,
          tokens: 218,
        },
        // A `running` tool and its completion arrive as two blocks with the same
        // `tool_id`. That pair is the whole reason `tool_id` is in the schema, so
        // the fixture has to contain it: a renderer keyed on the tool *name*
        // passes every other test in this file and fails this one.
        {
          kind: "tool",
          tool_id: "tl-fixture-0001",
          name: "bash",
          server: null,
          args: { command: "iostat -x 1 5 /dev/nvme1n1" },
          result: null,
          status: "running",
          exit_code: null,
          duration_ms: null,
          render: "terminal",
        },
        {
          kind: "tool",
          tool_id: "tl-fixture-0001",
          name: "bash",
          server: null,
          args: { command: "iostat -x 1 5 /dev/nvme1n1" },
          result: md(
            "Device   r/s    w/s   rkB/s    wkB/s  aqu-sz  %util",
            "nvme1n1  12.0  844.0   192.0 124928.0    4.02  99.60",
            "nvme1n1  11.0  851.0   176.0 125184.0    4.11  99.80",
          ),
          status: "ok",
          exit_code: 0,
          duration_ms: 5210,
          render: "terminal",
        },
        {
          kind: "tool",
          tool_id: "tl-fixture-0002",
          name: "metrics.window",
          server: "hermetic",
          args: { agent: "granite", window: "1h" },
          result: {
            columns: ["minute", "cpu_pct", "aqu_sz", "write_kbps"],
            rows: [
              ["09:00", 34, 4.0, 124928],
              ["09:15", 37, 4.1, 125184],
              ["09:30", 36, 4.0, 124800],
            ],
          },
          status: "ok",
          exit_code: 0,
          duration_ms: 812,
          render: "table",
        },
        { kind: "text", markdown: CITED },
        { kind: "sources", items: SOURCES },
      ],
      usage: usage(18422, 964, 0.0412, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-portal-3",
      session: "sx-atlas-portal",
      role: "user",
      author: null,
      at: at("09:26:30"),
      blocks: [{ kind: "text", markdown: "Show me the diff you would apply." }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-portal-4",
      session: "sx-atlas-portal",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("09:26:41"),
      blocks: [
        {
          kind: "tool",
          tool_id: "tl-fixture-0003",
          name: "edit",
          server: null,
          args: { path: "/data/ops/volumes.tf" },
          result: md(
            "--- a/ops/volumes.tf",
            "+++ b/ops/volumes.tf",
            '@@ -11,7 +11,9 @@ resource "aws_ebs_volume" "granite_data" {',
            '   type              = "gp3"',
            "   size              = 500",
            "-  # throughput defaults to 125 MiB/s",
            "+  throughput        = 500",
            "+  iops              = 6000",
            '   availability_zone = "us-west-2a"',
            " }",
          ),
          status: "ok",
          exit_code: 0,
          duration_ms: 94,
          render: "diff",
        },
        { kind: "text", markdown: FENCED },
        {
          kind: "attachment",
          name: "granite-iostat-2026-09-17.md",
          mime: "text/markdown",
          bytes: 8241,
          href: "/api/chat/attachments/fixture/granite-iostat-2026-09-17.md",
        },
      ],
      usage: usage(21105, 612, 0.0288, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
    {
      /**
       * The approval card, gold and never collapsed: it is the loudest thing
       * in a transcript, because the operator's next click either does or
       * does not change an AWS account.
       */
      id: "mx-atlas-portal-5",
      session: "sx-atlas-portal",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("09:27:02"),
      blocks: [
        {
          kind: "approval",
          tool: "bash",
          summary: "Run `aws ec2 modify-volume` against vol-fixture00000000012",
          detail: md(
            "aws ec2 modify-volume \\",
            "  --volume-id vol-fixture00000000012 \\",
            "  --throughput 500 \\",
            "  --iops 6000",
            "",
            "Live resize. No detach, no reboot, and the change is billed from the",
            "moment it applies.",
          ),
          expires_at: at("09:32:02"),
        },
      ],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      /** The question card. Choices, never free text: the bot is picking, not interviewing. */
      id: "mx-atlas-portal-6",
      session: "sx-atlas-portal",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("09:28:15"),
      blocks: [
        {
          kind: "question",
          prompt:
            "The snapshot from 06:00 is two hours older than the metrics. Which do you want me to trust?",
          choices: ["The 06:00 snapshot", "The live metrics", "Take a fresh snapshot first"],
        },
      ],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-portal-7",
      session: "sx-atlas-portal",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("09:29:31"),
      blocks: [
        {
          kind: "tool",
          tool_id: "tl-fixture-0004",
          name: "browser.screenshot",
          server: "playwright",
          args: { url: "https://grafana.fixture.invalid/d/ebs/granite", width: 1280, height: 720 },
          result: {
            href: "/api/chat/attachments/fixture/granite-grafana.png",
            width: 1280,
            height: 720,
          },
          status: "ok",
          exit_code: 0,
          duration_ms: 3140,
          render: "screenshot",
        },
        {
          kind: "tool",
          tool_id: "tl-fixture-0005",
          name: "image.generate",
          server: "pencil",
          args: { prompt: "queue depth over time, one line, no legend" },
          result: { href: "/api/chat/attachments/fixture/queue-depth.png", width: 1024, height: 1024 },
          // Warn rather than ok: it produced an image and then told us the
          // palette it was asked for was not available. A tool that half worked
          // is the status nobody seeds and every renderer has to draw.
          status: "warn",
          exit_code: 0,
          duration_ms: 9820,
          render: "image",
        },
        {
          kind: "attachment",
          name: "queue-depth.png",
          mime: "image/png",
          bytes: 421_776,
          href: "/api/chat/attachments/fixture/queue-depth.png",
        },
      ],
      usage: usage(23980, 344, 0.0161, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
    {
      /**
       * The four `hermetic` cards, stacked. Each carries a **ref and never
       * data**, which is what makes the card still correct three hours later
       * and correct even when the model that produced it was wrong about the
       * fleet: the head reads the live stream for everything except the id.
       */
      id: "mx-atlas-portal-8",
      session: "sx-atlas-portal",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("09:30:07"),
      blocks: [
        { kind: "text", markdown: "For context, here is everything this touches:" },
        { kind: "hermetic", card: "agent", ref: "granite" },
        { kind: "hermetic", card: "op", ref: "fxr000000001" },
        { kind: "hermetic", card: "plan", ref: "rollout:granite" },
        // The fleet the `main` fixture seeds. A card carries a ref, and the ref
        // for a fleet is its `fleet_id` - never its alias, which is display only.
        { kind: "hermetic", card: "fleet", ref: "fxtr0001" },
      ],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      /**
       * The two endings a turn can have that are not a clean answer: a tool that
       * failed, and a tool this repo has never heard of.
       *
       * The `unknown` block is **the contract, not a failure mode** (§9.2).
       * Upstream emits tools on a `hermes_ref` bump that change nothing else,
       * and the rule the block encodes is that a version bump can never blank a
       * transcript. It renders as name / arguments / result / verdict, always
       * expanded, and it is in the busiest transcript precisely so that it is
       * seen next to the cards that do have renderers.
       */
      id: "mx-atlas-portal-9",
      session: "sx-atlas-portal",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("09:31:40"),
      blocks: [
        {
          kind: "tool",
          tool_id: "tl-fixture-0006",
          name: "ebs_advisor",
          server: "acme-tools",
          args: { volume: "vol-fixture00000000012" },
          result: "ebs_advisor: command not found",
          status: "bad",
          exit_code: 127,
          duration_ms: 118,
          // No hint: the fallback path, which is a renderer in its own right and
          // the one every tool upstream adds next will land on first.
          render: null,
        },
        {
          kind: "unknown",
          name: "workspace.checkpoint",
          payload: {
            checkpoint_id: "ckpt-fixture-0007",
            files_touched: 3,
            verdict: "saved",
            note: "emitted by a hermes build this adapter has never been taught to read",
          },
        },
        {
          kind: "activity",
          category: "history",
          key: "history:fixture",
          title: "Conversation loaded",
          state: "done",
          detail: null,
        },
      ],
      usage: usage(24400, 96, 0.0044, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
  ],

  "sx-atlas-desktop": [
    {
      id: "mx-atlas-desktop-1",
      session: "sx-atlas-desktop",
      role: "user",
      author: null,
      at: at("08:39:50"),
      blocks: [{ kind: "text", markdown: "Summarise the volume report in three lines." }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-desktop-2",
      session: "sx-atlas-desktop",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("08:40:11"),
      blocks: [
        {
          kind: "text",
          markdown: md(
            "- Two volumes are loose: `vol-fixture0000000dorado` and `vol-fixture000000pelican`.",
            "- Together they are 800 GiB and $64.00 a month.",
            "- Neither has been attached to anything for over three months.",
          ),
        },
      ],
      usage: usage(4120, 88, 0.0031, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
  ],

  /** The turn ceiling, hit from the CLI where nobody was watching. */
  "sx-atlas-cli": [
    {
      id: "mx-atlas-cli-1",
      session: "sx-atlas-cli",
      role: "user",
      author: null,
      at: at("07:10:00"),
      blocks: [{ kind: "text", markdown: "Rebuild the index from the 06:00 volume snapshot." }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-cli-2",
      session: "sx-atlas-cli",
      role: "bot",
      author: { instance: "atlas", bot: "default" },
      at: at("07:18:52"),
      blocks: [
        {
          kind: "text",
          markdown: "Reindexed 412 of 900 shards before I ran out of turns. Nothing was rolled back.",
        },
        {
          kind: "tool",
          tool_id: "tl-fixture-0008",
          name: "bash",
          server: null,
          args: { command: "./reindex.sh --from /data/snapshots/06-00" },
          result: "shard 412/900 ok (8m41s elapsed)",
          status: "warn",
          exit_code: 0,
          duration_ms: 521_000,
          render: "terminal",
        },
      ],
      usage: usage(198_400, 12_880, 1.2233, "claude-sonnet-5"),
      error: FIXTURE_CHAT_FAILURES.turn_ceiling,
      incomplete: true,
    },
  ],

  /** Rate limited, and self-retrying - the one warn-class failure. */
  "sx-atlas-scribe-routine": [
    {
      id: "mx-atlas-scribe-1",
      session: "sx-atlas-scribe-routine",
      role: "system",
      author: null,
      at: at("06:00:00"),
      blocks: [{ kind: "text", markdown: "cron: 06:00 daily digest" }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-scribe-2",
      session: "sx-atlas-scribe-routine",
      role: "bot",
      author: { instance: "atlas", bot: "scribe" },
      at: at("06:00:12"),
      blocks: [{ kind: "text", markdown: "Collecting yesterday's runs" }],
      usage: usage(2200, 40, 0.0009, "claude-haiku-4-5"),
      error: FIXTURE_CHAT_FAILURES.rate_limited,
      incomplete: true,
    },
  ],

  /** The model the fleet's role may not invoke. `atlas` is on Bedrock. */
  "sx-atlas-auditor-portal": [
    {
      id: "mx-atlas-auditor-1",
      session: "sx-atlas-auditor-portal",
      role: "user",
      author: null,
      at: at("08:13:40"),
      blocks: [{ kind: "text", markdown: "Re-run the grant audit on the newest model." }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-auditor-2",
      session: "sx-atlas-auditor-portal",
      role: "bot",
      author: { instance: "atlas", bot: "auditor" },
      at: at("08:14:03"),
      blocks: [{ kind: "hermetic", card: "fleet", ref: "fxtr0001" }],
      usage: null,
      error: FIXTURE_CHAT_FAILURES.model_missing,
      incomplete: true,
    },
  ],

  "sx-atlas-clio-channel": [
    {
      id: "mx-atlas-clio-1",
      session: "sx-atlas-clio-channel",
      role: "user",
      author: null,
      at: at("07:51:12"),
      blocks: [{ kind: "text", markdown: "When does the restore window close?" }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-atlas-clio-2",
      session: "sx-atlas-clio-channel",
      role: "bot",
      author: { instance: "atlas", bot: "clio" },
      at: at("07:52:30"),
      blocks: [
        {
          kind: "text",
          markdown: "22:00 UTC tonight. I have put a reminder in the channel an hour before.",
        },
      ],
      usage: usage(3300, 52, 0.0012, "claude-haiku-4-5"),
      error: null,
      incomplete: null,
    },
  ],

  "sx-corvid-portal": [
    {
      id: "mx-corvid-portal-1",
      session: "sx-corvid-portal",
      role: "user",
      author: null,
      at: at("09:12:30"),
      blocks: [{ kind: "text", markdown: "What is staged on you right now?" }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-corvid-portal-2",
      session: "sx-corvid-portal",
      role: "bot",
      author: { instance: "corvid", bot: "default" },
      at: at("09:12:55"),
      blocks: [
        {
          kind: "text",
          markdown:
            "A profile change, saved and not applied: openrouter to anthropic, model " +
            "`claude-sonnet-5`. It lands on the next `hermetic apply`.",
        },
        { kind: "hermetic", card: "plan", ref: "rollout:corvid" },
        { kind: "hermetic", card: "agent", ref: "corvid" },
      ],
      usage: usage(5120, 140, 0.0051, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
  ],

  /**
   * A peer-driven turn: the author is not the session's own bot, which is
   * exactly why `ChatMessage.author` exists. A renderer that assumes the bot is
   * the session's bot draws this one wrong and nothing else.
   */
  "sx-corvid-rook-peer": [
    {
      id: "mx-corvid-rook-1",
      session: "sx-corvid-rook-peer",
      role: "bot",
      author: { instance: "corvid", bot: "magpie" },
      at: at("09:19:40"),
      blocks: [
        {
          kind: "text",
          markdown: "Handing you the 4am page - the customer replied and it is not a billing issue.",
        },
      ],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-corvid-rook-2",
      session: "sx-corvid-rook-peer",
      role: "bot",
      author: { instance: "corvid", bot: "rook" },
      at: at("09:20:18"),
      blocks: [
        { kind: "text", markdown: "Taking it. Opening triage." },
        {
          kind: "tool",
          tool_id: "tl-fixture-0009",
          name: "room.open",
          server: "hermes",
          args: { room: "#triage", members: ["default", "rook", "magpie"] },
          result: { room_id: "rm-corvid-triage", round: { n: 1, of: 3 } },
          status: "ok",
          exit_code: 0,
          duration_ms: 240,
          render: null,
        },
      ],
      usage: usage(6400, 120, 0.0048, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
  ],

  "sx-corvid-magpie-room": [
    {
      id: "mx-corvid-magpie-room-1",
      session: "sx-corvid-magpie-room",
      role: "bot",
      author: { instance: "corvid", bot: "rook" },
      at: at("09:18:02"),
      blocks: [{ kind: "text", markdown: "Round 2: what does the export actually contain?" }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-corvid-magpie-room-2",
      session: "sx-corvid-magpie-room",
      role: "bot",
      author: { instance: "corvid", bot: "magpie" },
      at: at("09:19:06"),
      blocks: [
        {
          kind: "tool",
          tool_id: "tl-fixture-0010",
          name: "read",
          server: null,
          args: { path: "/data/exports/acme-2026-09-16.csv", limit: 4 },
          result: {
            columns: ["invoice", "period", "amount_usd", "state"],
            rows: [
              ["INV-4471", "2026-08", 1240.0, "settled"],
              ["INV-4472", "2026-09", 1240.0, "pending"],
            ],
          },
          status: "ok",
          exit_code: 0,
          duration_ms: 61,
          render: "table",
        },
        {
          kind: "text",
          markdown: "Two invoices, one settled and one pending. Nothing in it explains the page.",
        },
      ],
      usage: usage(9100, 210, 0.0079, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
  ],

  /** The profile's key was rejected. Nothing reached the agent. */
  "sx-corvid-magpie-channel": [
    {
      id: "mx-corvid-magpie-channel-1",
      session: "sx-corvid-magpie-channel",
      role: "user",
      author: null,
      at: at("08:46:30"),
      blocks: [{ kind: "text", markdown: "Re-send the billing export to the channel." }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-corvid-magpie-channel-2",
      session: "sx-corvid-magpie-channel",
      role: "bot",
      author: { instance: "corvid", bot: "magpie" },
      at: at("08:47:02"),
      blocks: [],
      usage: null,
      error: FIXTURE_CHAT_FAILURES.credential_rejected,
      incomplete: true,
    },
  ],

  "sx-corvid-wren-portal": [
    {
      id: "mx-corvid-wren-1",
      session: "sx-corvid-wren-portal",
      role: "user",
      author: null,
      at: at("09:21:44"),
      blocks: [{ kind: "text", markdown: "Are you awake?" }],
      usage: null,
      error: null,
      incomplete: null,
    },
  ],

  /** The box went away mid-turn, and what had streamed is kept. */
  "sx-ember-portal": [
    {
      id: "mx-ember-portal-1",
      session: "sx-ember-portal",
      role: "user",
      author: null,
      at: at("09:30:30"),
      blocks: [{ kind: "text", markdown: "What is filling /data?" }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-ember-portal-2",
      session: "sx-ember-portal",
      role: "bot",
      author: { instance: "ember", bot: "default" },
      at: at("09:31:02"),
      blocks: [
        {
          kind: "tool",
          tool_id: "tl-fixture-0011",
          name: "bash",
          server: null,
          args: { command: "du -xh --max-depth=1 /data | sort -h | tail -5" },
          result: md("2.1G\t/data/logs", "14G\t/data/hermes", "61G\t/data/models"),
          status: "ok",
          exit_code: 0,
          duration_ms: 1840,
          render: "terminal",
        },
        // The half-sentence the socket died inside. It is kept rather than
        // dropped, which is the whole of `incomplete`: Hermes wrote its own
        // transcript on the box, so nothing is lost there either.
        { kind: "text", markdown: "`/data/models` is 61G of it, and most of that is" },
      ],
      usage: usage(7700, 180, 0.0066, "claude-sonnet-5"),
      error: FIXTURE_CHAT_FAILURES.box_went_away,
      incomplete: true,
    },
  ],

  /** The context window is full, and compaction is the offer. */
  "sx-granite-portal": [
    {
      id: "mx-granite-portal-1",
      session: "sx-granite-portal",
      role: "user",
      author: null,
      at: at("09:04:40"),
      blocks: [{ kind: "text", markdown: "Keep going with the refactor." }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-granite-portal-2",
      session: "sx-granite-portal",
      role: "bot",
      author: { instance: "granite", bot: "default" },
      at: at("09:05:19"),
      blocks: [],
      usage: usage(198_004, 0, 0.594, "claude-sonnet-5"),
      error: FIXTURE_CHAT_FAILURES.context_full,
      incomplete: true,
    },
  ],

  "sx-granite-quarry-cli": [
    {
      id: "mx-granite-quarry-1",
      session: "sx-granite-quarry-cli",
      role: "user",
      author: null,
      at: at("04:29:30"),
      blocks: [{ kind: "text", markdown: "Run the release checklist." }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-granite-quarry-2",
      session: "sx-granite-quarry-cli",
      role: "bot",
      author: { instance: "granite", bot: "quarry" },
      at: at("04:30:00"),
      blocks: [
        {
          kind: "tool",
          tool_id: "tl-fixture-0012",
          name: "bash",
          server: null,
          args: { command: "bun run check" },
          result: "148 pass, 0 fail (38.2s)",
          status: "ok",
          exit_code: 0,
          duration_ms: 38_200,
          render: "terminal",
        },
        { kind: "hermetic", card: "op", ref: "fxr000000002" },
      ],
      usage: usage(11_200, 260, 0.0098, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
  ],

  "sx-kestrel-portal": [
    {
      id: "mx-kestrel-portal-1",
      session: "sx-kestrel-portal",
      role: "user",
      author: null,
      at: at("08:58:10"),
      blocks: [{ kind: "text", markdown: "Did the Bitwarden rotation land?" }],
      usage: null,
      error: null,
      incomplete: null,
    },
    {
      id: "mx-kestrel-portal-2",
      session: "sx-kestrel-portal",
      role: "bot",
      author: { instance: "kestrel", bot: "default" },
      at: at("08:58:41"),
      blocks: [
        {
          kind: "tool",
          tool_id: "tl-fixture-0013",
          name: "bash",
          server: null,
          args: { command: "systemctl show -p ExecMainStartTimestamp hermes-gateway" },
          result: "ExecMainStartTimestamp=Thu 2026-09-17 08:56:02 UTC",
          status: "ok",
          exit_code: 0,
          duration_ms: 77,
          render: "terminal",
        },
        {
          kind: "text",
          // The one credential-shaped string in this file, and it is the
          // `FIXTURE` sentinel: `chat.ts` masks it on the way out, so
          // `bun run dev:fixture` shows the redaction door working rather than
          // requiring somebody to believe a unit test about it.
          markdown:
            "Yes - the gateway restarted at 08:56 with the new key (sk-ant-FIXTUREFIXTUREFIXTURE).",
        },
      ],
      usage: usage(4400, 96, 0.0037, "claude-sonnet-5"),
      error: null,
      incomplete: null,
    },
  ],

  // Background-process events (§9.2), built from upstream's notice text in
  // their own module so the parse is the one the history reader runs.
  [KESTREL_EVENTS_SESSION]: KESTREL_EVENTS_TRANSCRIPT,
};
