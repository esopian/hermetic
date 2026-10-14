/**
 * The fixture's files plugin handing the operator files: a turn in which the
 * agent calls `share_file` twice — a PNG chart and the CSV behind it — and
 * then names the chart again on a `MEDIA:` outbox line, raised by
 * `E2E_FILE_SHARE` in the prompt the way `fixture-chat-file-request.ts` raises
 * a request.
 *
 * Both files are put into the fixture box's outbox (`MemoryFiles.share`), so
 * `files.content` serves the very bytes the card names, under the digest the
 * card shows. The cards are built by the live adapter's own `toolBlock`, from
 * the plugin's JSON result, so `share` is read exactly as it is on a real box;
 * and the reply is mapped by the same `splitMedia`/`shareAttachment` the live
 * turn and the transcript use, so the `MEDIA:` line becomes an attachment chip
 * and leaves the text.
 */
import { toolBlock } from "../../chat/hermes/hermes-chat-blocks.ts";
import { shareAttachment, splitMedia } from "../../chat/hermes/hermes-chat-media.ts";
import type { ChatBlock, ChatFrame, ShareFileResult } from "../../schema/index.ts";
import { FILES_OUTBOX_DIR, MEDIA_TAG } from "../../shared/files.ts";
import { fixturePng } from "./fixture-chat-files.ts";

export const FIXTURE_FILE_SHARE_TRIGGER = "E2E_FILE_SHARE";

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
  if (!prompt.includes(FIXTURE_FILE_SHARE_TRIGGER)) return null;
  return {
    frames(message, files, agent, session) {
      let seq = 0;
      const out: SequencedFrame[] = [];
      const block = (b: ChatBlock) => out.push({ type: "block", seq: ++seq, message, block: b });
      block({
        kind: "reasoning",
        text: "The operator wants the Q3 chart and the table behind it. Share both.",
        duration_ms: 420,
        tokens: 18,
      });
      const results: ShareFileResult[] = [];
      for (const spec of SHARES) {
        const args = { path: spec.path, note: spec.note };
        block(toolBlock({ tool_id: spec.tool_id, name: "share_file", args }, "running"));
        const result = files.share(agent, {
          name: spec.name,
          bytes: spec.bytes(),
          note: spec.note,
          ...(session !== null ? { session_id: session } : {}),
        });
        results.push(result);
        // The plugin returns `POST /outbox`'s answer as its JSON result.
        block(
          toolBlock(
            { tool_id: spec.tool_id, name: "share_file", args, result: JSON.stringify(result) },
            null,
          ),
        );
      }
      const chart = results[0] as ShareFileResult;
      const reply =
        "Here is the Q3 revenue chart and the CSV behind it. September is up 8% on August.\n" +
        `${MEDIA_TAG}${FILES_OUTBOX_DIR}/${chart.share_id}/${chart.name}\n`;
      let textOpen = false;
      for (const piece of splitMedia(reply)) {
        if (piece.kind === "share") {
          textOpen = false;
          // Described as the box's outbox listing would describe it.
          const shared = results.find((r) => r.share_id === piece.share_id);
          block({
            ...shareAttachment(piece),
            ...(shared ? { mime: shared.mime, bytes: shared.bytes, sha256: shared.sha256 } : {}),
          });
          continue;
        }
        if (!textOpen) block({ kind: "text", markdown: "" });
        textOpen = true;
        const cut = Math.ceil(piece.text.length / 2);
        for (const text of [piece.text.slice(0, cut), piece.text.slice(cut)])
          if (text) out.push({ type: "delta", seq: ++seq, message, text });
      }
      out.push({ type: "done", seq: ++seq, message, usage: null, incomplete: null });
      return out;
    },
  };
}
