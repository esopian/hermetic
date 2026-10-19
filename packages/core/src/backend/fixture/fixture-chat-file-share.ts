/**
 * The fixture's files plugin handing the operator files: a turn in which the
 * agent calls `share_file` twice — a PNG chart and the CSV behind it — and
 * then names the chart again on a `MEDIA:` outbox line, raised by
 * `E2E_FILE_SHARE` in the prompt the way `fixture-chat-file-request.ts` raises
 * a request. `E2E_MEDIA_SHARE` hands over the same two files with no tool call
 * at all: the reply names each on its own `MEDIA:` line, which the plugin's
 * `transform_llm_output` hook shares and rewrites to the outbox form — the way
 * an agent following hermetic's platform hint (`HERMETIC_PLATFORM_HINT`)
 * delivers a file. `E2E_MEDIA_KINDS` hands over one file of each other kind
 * the desktop app draws — audio, video and a text file — on `MEDIA:` lines
 * written the ways the desktop parser reads (bare with spaces in the name,
 * backticked, quoted inside emphasis), plus one naming a path on the
 * operator's own laptop, which the box cannot share and which stays prose. Its
 * reply streams in small pieces through the live turn's own hold
 * (`createMediaHold`), so a path split across deltas is never shown half read.
 *
 * Both files are put into the fixture box's outbox (`MemoryFiles.share`), so
 * `files.content` serves the very bytes the card names, under the digest the
 * card shows. The cards are built by the live adapter's own `toolBlock`, from
 * the plugin's JSON result, so `share` is read exactly as it is on a real box;
 * and the reply is mapped by the same `splitMedia`/`shareAttachment` the live
 * turn and the transcript use, so each `MEDIA:` line becomes an attachment
 * chip and leaves the text.
 */
import { toolBlock } from "../../chat/hermes/hermes-chat-blocks.ts";
import { createMediaHold, shareAttachment, splitMedia } from "../../chat/hermes/hermes-chat-media.ts";
import type { ChatBlock, ChatFrame, ShareFileResult } from "../../schema/index.ts";
import { FILES_OUTBOX_DIR, MEDIA_TAG } from "../../shared/files.ts";
import { fixturePng } from "./fixture-chat-files.ts";
import { fixtureWav, fixtureWebm } from "./fixture-media-bytes.ts";

export const FIXTURE_FILE_SHARE_TRIGGER = "E2E_FILE_SHARE";
export const FIXTURE_MEDIA_SHARE_TRIGGER = "E2E_MEDIA_SHARE";
export const FIXTURE_MEDIA_KINDS_TRIGGER = "E2E_MEDIA_KINDS";

type SequencedFrame = Extract<ChatFrame, { seq: number }>;

/** The slice of `MemoryFiles` a share turn uses. */
export interface FixtureShareFiles {
  share(
    agent: string,
    file: { name: string; bytes: Uint8Array; note?: string; session_id?: string },
  ): ShareFileResult;
}

/** The table behind the chart. FIXTURE values only. */
const REVENUE_CSV =
  "month,revenue_usd,orders\n2026-07,184200,1312\n2026-08,191950,1374\n2026-09,207400,1460\n";

/** What the agent shares, in call order, with the arguments the model wrote. */
const SHARES = [
  {
    tool_id: "tl-fixture-share-chart",
    path: "/data/hermes/work/q3-revenue.png",
    name: "q3-revenue.png",
    note: "Q3 revenue by month",
    bytes: () => fixturePng(64),
  },
  {
    tool_id: "tl-fixture-share-table",
    path: "/data/hermes/work/q3-revenue.csv",
    name: "q3-revenue.csv",
    note: "The numbers behind the chart",
    bytes: () => new TextEncoder().encode(REVENUE_CSV),
  },
] as const;

export interface FixtureFileShareScript {
  /** The whole turn, its files already in the outbox when the frames are built. */
  frames(
    message: string,
    files: FixtureShareFiles,
    agent: string,
    session: string | null,
  ): SequencedFrame[];
}

export function fixtureFileShareScript(prompt: string): FixtureFileShareScript | null {
  if (prompt.includes(FIXTURE_FILE_SHARE_TRIGGER)) return shareFileScript;
  if (prompt.includes(FIXTURE_MEDIA_SHARE_TRIGGER)) return mediaLineScript;
  if (prompt.includes(FIXTURE_MEDIA_KINDS_TRIGGER)) return mediaKindsScript;
  return null;
}

/** A file the agent shares: where it is on the box, and its bytes. */
interface ShareSpec {
  readonly path: string;
  readonly name: string;
  readonly note: string;
  readonly bytes: () => Uint8Array;
}

/** One share put into the outbox, as `POST /outbox` answers it. */
function putShare(
  files: FixtureShareFiles,
  agent: string,
  session: string | null,
  spec: ShareSpec,
): ShareFileResult {
  return files.share(agent, {
    name: spec.name,
    bytes: spec.bytes(),
    note: spec.note,
    ...(session !== null ? { session_id: session } : {}),
  });
}

/** The line the plugin rewrites `MEDIA:/abs/path` to once it has shared the file. */
function outboxLine(result: ShareFileResult): string {
  return `${MEDIA_TAG}${FILES_OUTBOX_DIR}/${result.share_id}/${result.name}\n`;
}

type Emit = (frame: { type: "block"; block: ChatBlock } | { type: "delta"; text: string }) => void;

/** The reply, its outbox lines as chips described from `results`, the rest streamed. */
function emitReply(reply: string, results: readonly ShareFileResult[], emit: Emit): void {
  let textOpen = false;
  for (const piece of splitMedia(reply)) {
    if (piece.kind === "share") {
      textOpen = false;
      // Described as the box's outbox listing would describe it.
      const shared = results.find((r) => r.share_id === piece.share_id);
      emit({
        type: "block",
        block: {
          ...shareAttachment(piece),
          ...(shared ? { mime: shared.mime, bytes: shared.bytes, sha256: shared.sha256 } : {}),
        },
      });
      continue;
    }
    if (!textOpen) emit({ type: "block", block: { kind: "text", markdown: "" } });
    textOpen = true;
    const cut = Math.ceil(piece.text.length / 2);
    for (const text of [piece.text.slice(0, cut), piece.text.slice(cut)])
      if (text) emit({ type: "delta", text });
  }
}

/** A turn's frame list and the `Emit` that numbers frames into it. */
function frameLog(message: string): { out: SequencedFrame[]; emit: Emit } {
  let seq = 0;
  const out: SequencedFrame[] = [];
  const emit: Emit = (frame) => out.push({ ...frame, seq: ++seq, message });
  return { out, emit };
}

const done = (out: SequencedFrame[], message: string): SequencedFrame => ({
  type: "done",
  seq: out.length + 1,
  message,
  usage: null,
  incomplete: null,
});

/** `E2E_FILE_SHARE`: two `share_file` calls, then the chart named again on a `MEDIA:` line. */
const shareFileScript: FixtureFileShareScript = {
  frames(message, files, agent, session) {
    const { out, emit } = frameLog(message);
    emit({
      type: "block",
      block: {
        kind: "reasoning",
        text: "The operator wants the Q3 chart and the table behind it. Share both.",
        duration_ms: 420,
        tokens: 18,
      },
    });
    const results: ShareFileResult[] = [];
    for (const spec of SHARES) {
      const args = { path: spec.path, note: spec.note };
      emit({
        type: "block",
        block: toolBlock({ tool_id: spec.tool_id, name: "share_file", args }, "running"),
      });
      const result = putShare(files, agent, session, spec);
      results.push(result);
      // The plugin returns `POST /outbox`'s answer as its JSON result.
      emit({
        type: "block",
        block: toolBlock(
          { tool_id: spec.tool_id, name: "share_file", args, result: JSON.stringify(result) },
          null,
        ),
      });
    }
    const reply =
      "Here is the Q3 revenue chart and the CSV behind it. September is up 8% on August.\n" +
      outboxLine(results[0] as ShareFileResult);
    emitReply(reply, results, emit);
    out.push(done(out, message));
    return out;
  },
};

/** `E2E_MEDIA_SHARE`: no tool call; each file on its own `MEDIA:` line of the reply. */
const mediaLineScript: FixtureFileShareScript = {
  frames(message, files, agent, session) {
    const { out, emit } = frameLog(message);
    emit({
      type: "block",
      block: {
        kind: "reasoning",
        text: "The operator wants the Q3 chart and the table behind it. Name both in the reply.",
        duration_ms: 380,
        tokens: 19,
      },
    });
    // The plugin's hook shares every `MEDIA:/abs/path` line as the reply ends.
    const results = SHARES.map((spec) => putShare(files, agent, session, spec));
    const reply =
      "Here is the Q3 revenue chart and the CSV behind it.\n" +
      results.map(outboxLine).join("") +
      "September is up 8% on August.\n";
    emitReply(reply, results, emit);
    out.push(done(out, message));
    return out;
  },
};

/** The release notes `E2E_MEDIA_KINDS` shares. FIXTURE values only. */
const RELEASE_NOTES =
  "# Release notes\n\n- Faster chart rendering\n- The standup recap is now an audio file\n- FIXTURE build 2026.10\n";

/** `E2E_MEDIA_KINDS`'s files, and how the model wrote each one's `MEDIA:` line. */
const KINDS: readonly (ShareSpec & { readonly line: (path: string) => string })[] = [
  {
    path: "/data/hermes/work/standup recap.wav",
    name: "standup recap.wav",
    note: "Standup recap",
    bytes: () => fixtureWav(),
    line: (path) => `MEDIA:${path}`,
  },
  {
    path: "/data/hermes/work/build preview.webm",
    name: "build preview.webm",
    note: "Build preview",
    bytes: () => fixtureWebm(),
    line: (path) => `MEDIA:\`${path}\``,
  },
  {
    path: "/data/hermes/work/release notes.md",
    name: "release notes.md",
    note: "Release notes",
    bytes: () => new TextEncoder().encode(RELEASE_NOTES),
    line: (path) => `**MEDIA:"${path}"**`,
  },
];

/** A path on the operator's laptop: the box has no such file, so the plugin leaves the line be. */
export const FIXTURE_FOREIGN_MEDIA_PATH = "/Users/nobody/Desktop/elsewhere.png";

/** How many characters each streamed delta of `E2E_MEDIA_KINDS`'s reply carries. */
export const FIXTURE_MEDIA_KINDS_DELTA = 9;

/**
 * `E2E_MEDIA_KINDS`: audio, video and a text file on `MEDIA:` lines, and one
 * line naming a path on another machine. The reply streams as the model wrote
 * it, in pieces small enough to split every path, through the live turn's
 * hold; the plugin's rewrite then settles it, so each shared line becomes a
 * chip and the foreign line stays text.
 */
const mediaKindsScript: FixtureFileShareScript = {
  frames(message, files, agent, session) {
    const { out, emit } = frameLog(message);
    emit({
      type: "block",
      block: {
        kind: "reasoning",
        text: "Send the recap, the preview clip and the notes. The screenshot is on their laptop.",
        duration_ms: 350,
        tokens: 21,
      },
    });
    const results = KINDS.map((spec) => putShare(files, agent, session, spec));
    const lines = KINDS.map((spec) => `${spec.line(spec.path)}\n`).join("");
    const head = "Here are today's files.\n";
    const tail = "That last one is on your laptop, not on this box.\n";
    const foreign = `MEDIA:${FIXTURE_FOREIGN_MEDIA_PATH}\n`;
    const written = head + lines + foreign + tail;
    // What the plugin's `transform_llm_output` hook hands back.
    const transformed = head + results.map(outboxLine).join("") + foreign + tail;

    let textOpen = false;
    const text = (delta: string) => {
      if (!delta) return;
      if (!textOpen) emit({ type: "block", block: { kind: "text", markdown: "" } });
      textOpen = true;
      emit({ type: "delta", text: delta });
    };
    const hold = createMediaHold();
    for (let at = 0; at < written.length; at += FIXTURE_MEDIA_KINDS_DELTA) {
      text(hold.push(written.slice(at, at + FIXTURE_MEDIA_KINDS_DELTA)));
    }
    for (const piece of hold.settle(transformed)) {
      if (piece.kind === "text") {
        text(piece.text);
        continue;
      }
      textOpen = false;
      const shared = results.find((r) => r.share_id === piece.share_id);
      emit({
        type: "block",
        block: {
          ...shareAttachment(piece),
          ...(shared ? { mime: shared.mime, bytes: shared.bytes, sha256: shared.sha256 } : {}),
        },
      });
    }
    out.push(done(out, message));
    return out;
  },
};
