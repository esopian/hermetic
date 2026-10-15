/**
 * The agent handing the operator files (attachments plan Phase 4): the
 * `share_file` card's `share`, read from the plugin's result alone, and the
 * `MEDIA:` outbox lines a reply carries, read as attachment chips — live,
 * including the transformed final upstream sends after the stream, and from
 * the transcript.
 */
import { describe, expect, test } from "bun:test";
import { toolBlock, toolShare } from "../src/chat/hermes/hermes-chat-blocks.ts";
import {
  createMediaHold,
  describeShares,
  mediaHead,
  outboxOnce,
  readMediaShares,
  splitMedia,
} from "../src/chat/hermes/hermes-chat-media.ts";
import { createHermesChat, mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress, ChatFetch, ChatSocket } from "../src/chat/hermes/hermes-chat.ts";
import { ChatFrame as ChatFrameSchema } from "../src/schema/index.ts";
import type { ChatBlock, ChatFrame, FileEntry, ShareFileResult } from "../src/schema/index.ts";
import { FILES_OUTBOX_DIR, parseOutboxMediaLine } from "../src/shared/files.ts";
import {
  DASHBOARD_HTML,
  eventFrame,
  PROMPT_SUBMIT_RESULT,
  SESSION_CREATE_RESULT,
  STORED_SESSION_ID,
} from "./fixtures/hermes-frames.ts";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

const BOX: BoxAddress = {
  instance: "sindri",
  baseUrl: "https://fxtr0001-sindri.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const SH = "sh_abcdefghij12";
const SH2 = "sh_zyxwvutsrq98";
const LINE = `MEDIA:${FILES_OUTBOX_DIR}/${SH}/chart.png`;
const SHARE: ShareFileResult = {
  share_id: SH,
  name: "chart.png",
  bytes: 2048,
  mime: "image/png",
  sha256: "a".repeat(64),
};
const ENTRY: FileEntry = {
  id: SH,
  dir: "outbox",
  class: "image",
  name: "chart.png",
  bytes: 2048,
  mime: "image/png",
  sha256: "a".repeat(64),
  created_at: "2026-10-14T10:00:00.000Z",
  expires_at: "2026-10-15T10:00:00.000Z",
  from: { kind: "agent" },
};
const ENTRY2: FileEntry = {
  ...ENTRY,
  id: SH2,
  class: "file",
  name: "data.csv",
  bytes: 99,
  mime: "text/csv",
  sha256: "b".repeat(64),
};

function tool(payload: Record<string, unknown>, force: "running" | null = null): ToolBlock {
  const block = toolBlock(payload, force);
  if (block.kind !== "tool") throw new Error("not a tool block");
  return block;
}

describe("parseOutboxMediaLine", () => {
  test("only the exact outbox form names a share", () => {
    expect(parseOutboxMediaLine(LINE)).toEqual({ share_id: SH, name: "chart.png" });
    expect(parseOutboxMediaLine(`  ${LINE}\r`)).toEqual({ share_id: SH, name: "chart.png" });
    for (const line of [
      "MEDIA:/tmp/chart.png",
      `MEDIA:${FILES_OUTBOX_DIR}/${SH}`,
      `MEDIA:${FILES_OUTBOX_DIR}/${SH}/a/b.png`,
      `MEDIA:${FILES_OUTBOX_DIR}/sh_short/chart.png`,
      `MEDIA:${FILES_OUTBOX_DIR}/${SH}/.env`,
      `MEDIA:${FILES_OUTBOX_DIR}/${SH}/../x`,
      `see ${LINE}`,
      `media:${FILES_OUTBOX_DIR}/${SH}/chart.png`,
    ])
      expect(parseOutboxMediaLine(line)).toBeNull();
  });
});

describe("the share_file card", () => {
  test("renders as file_share, and its share is the plugin's result", () => {
    const running = tool(
      { tool_id: "c1", name: "share_file", args: { path: "/tmp/chart.png" } },
      "running",
    );
    expect(running.render).toBe("file_share");
    expect(running.share).toBeNull();
    const done = tool({
      tool_id: "c1",
      name: "share_file",
      args: { path: "/tmp/chart.png" },
      result: JSON.stringify({ ...SHARE, warning: "plugin is older than hermeticd" }),
    });
    expect(done.share).toEqual(SHARE);
    // An already-parsed result, as a history row holds it.
    expect(tool({ tool_id: "c1", name: "share_file", result: SHARE }).share).toEqual(SHARE);
  });

  test("a refusal, a partial or a garbled result is no share", () => {
    const refusal = { status: "error", error: { code: "FILE_FORBIDDEN", message: "credential path" } };
    expect(tool({ name: "share_file", result: JSON.stringify(refusal) }).share).toBeNull();
    expect(toolShare({ ...SHARE, sha256: "nope" })).toBeNull();
    expect(toolShare({ ...SHARE, share_id: "f_abcdefabcdef" })).toBeNull();
    expect(toolShare("not json")).toBeNull();
    expect(toolShare(null)).toBeNull();
  });

  test("the model's arguments never become the share", () => {
    const block = tool({ tool_id: "c1", name: "share_file", args: SHARE, result: null });
    expect(block.share).toBeNull();
  });

  test("other tools carry no share key", () => {
    expect("share" in tool({ name: "bash", result: JSON.stringify(SHARE) })).toBe(false);
  });
});

describe("splitMedia", () => {
  test("an outbox line becomes a share and leaves the text; other MEDIA lines stay", () => {
    const text = `Here it is:\n${LINE}\nMEDIA:/tmp/other.png\nThanks.`;
    expect(splitMedia(text)).toEqual([
      { kind: "text", text: "Here it is:\n" },
      { kind: "share", share_id: SH, name: "chart.png" },
      { kind: "text", text: "MEDIA:/tmp/other.png\nThanks." },
    ]);
  });

  test("a line inside a code fence is text, and a share named twice is kept once", () => {
    const text = `\`\`\`\n${LINE}\n\`\`\`\n${LINE}\n${LINE}`;
    expect(splitMedia(text)).toEqual([
      { kind: "text", text: `\`\`\`\n${LINE}\n\`\`\`\n` },
      { kind: "share", share_id: SH, name: "chart.png" },
    ]);
  });

  test("a fence closes only as the plugin closes it", () => {
    const fenced = (inner: string) => `\`\`\`\`md\n${inner}\n${LINE}\n\`\`\`\`\n${LINE}\n`;
    // A shorter run, or one with an info string, is content inside the fence.
    for (const inner of ["```", "````js", "~~~~"]) {
      expect(splitMedia(fenced(inner))).toEqual([
        { kind: "text", text: fenced(inner).slice(0, -(LINE.length + 1)) },
        { kind: "share", share_id: SH, name: "chart.png" },
      ]);
    }
    // A longer closing run, with trailing blanks and a CR, closes it.
    expect(splitMedia(`~~~\n${LINE}\n~~~~~  \r\n${LINE}`)).toEqual([
      { kind: "text", text: `~~~\n${LINE}\n~~~~~  \r\n` },
      { kind: "share", share_id: SH, name: "chart.png" },
    ]);
    // A fence never closed masks to the end.
    expect(splitMedia(`\`\`\`\n${LINE}`)).toEqual([{ kind: "text", text: `\`\`\`\n${LINE}` }]);
    // The hold agrees: a MEDIA line after a shorter inner run is still fenced.
    const hold = createMediaHold();
    expect(hold.push("````\n```\nMEDIA:/tmp/a.png\nok")).toBe("````\n```\nMEDIA:/tmp/a.png\nok");
  });

  test("a bot message's text blocks are split in place", () => {
    const blocks = readMediaShares([{ kind: "text", markdown: `Done.\n${LINE}` }]);
    expect(blocks).toEqual([
      { kind: "text", markdown: "Done.\n" },
      {
        kind: "attachment",
        name: "chart.png",
        mime: "image/png",
        bytes: 0,
        href: `outbox/${SH}/chart.png`,
        file_id: SH,
        sha256: null,
      },
    ]);
    // Described from one outbox listing.
    const [described] = describeShares([{ blocks }], [ENTRY]);
    expect(described?.blocks[1]).toMatchObject({ bytes: 2048, sha256: "a".repeat(64) });
    expect(describeShares([{ blocks }], null)[0]?.blocks).toEqual(blocks);
  });

  test("the listing's name wins, and a share the listing does not hold is no chip", () => {
    const blocks = readMediaShares([{ kind: "text", markdown: `Done.\n${LINE}\nBye.` }]);
    const renamed = { ...ENTRY, name: "q3-chart.png" };
    expect(describeShares([{ blocks }], [renamed])[0]?.blocks[1]).toEqual({
      kind: "attachment",
      name: "q3-chart.png",
      mime: "image/png",
      bytes: 2048,
      href: `outbox/${SH}/q3-chart.png`,
      file_id: SH,
      sha256: "a".repeat(64),
    });
    // The listing answered, without this share: the chip goes, the prose stays.
    expect(describeShares([{ blocks }], [ENTRY2])[0]?.blocks).toEqual([
      { kind: "text", markdown: "Done.\n" },
      { kind: "text", markdown: "Bye." },
    ]);
  });
});

describe("the live hold", () => {
  test("prose streams; a MEDIA line and the rest of its paragraph wait", () => {
    const hold = createMediaHold();
    expect(hold.push("Here is the ")).toBe("Here is the ");
    expect(hold.push("chart:\nME")).toBe("chart:\n");
    expect(hold.push("DIA:/tmp/c")).toBe("");
    expect(hold.push("hart.png\nand more")).toBe("");
    expect(hold.holding()).toBe(true);
    // Not transformed: the paragraph as streamed; the original line stays text.
    expect(hold.settle(hold.raw())).toEqual([{ kind: "text", text: "MEDIA:/tmp/chart.png\nand more" }]);
  });

  test("a line that only began like one is released", () => {
    const hold = createMediaHold();
    expect(hold.push("M")).toBe("");
    expect(hold.push("EDIUM rare\n")).toBe("MEDIUM rare\n");
    expect(hold.holding()).toBe(false);
  });

  test("only a line that could still become a shared path is held", () => {
    for (const line of [
      "MEDIA:/tmp/a.png",
      "media:/tmp/a.png",
      "  **MEDIA: /tmp/a.png**",
      "___Media:\t`/tmp/a b.png`___",
      'MEDIA:"~/a.png"',
    ])
      expect(mediaHead(line)).toBe("yes");
    for (const line of ["", "  ", "**", "MED", "media:", "MEDIA:  ", "MEDIA:`", "MEDIA:~"])
      expect(mediaHead(line)).toBe("maybe");
    for (const line of [
      "MEDIA: see below",
      "MEDIUM",
      "****MEDIA:/tmp/a.png",
      "MEDIA:./a.png",
      "MEDIA:~a",
      "see MEDIA:/tmp/a.png",
    ])
      expect(mediaHead(line)).toBe("no");

    const hold = createMediaHold();
    expect(hold.push("Note:\nMEDIA: s")).toBe("Note:\nMEDIA: s");
    expect(hold.push("ee below\nmore")).toBe("ee below\nmore");
    expect(hold.holding()).toBe(false);
    expect(hold.push("\n**media:/tmp/x.png**\nand after")).toBe("\n");
    expect(hold.holding()).toBe(true);
  });

  test("the transformed final replaces the held tail", () => {
    const hold = createMediaHold();
    hold.push("Here is the chart:\nMEDIA:/tmp/chart.png\n");
    expect(hold.settle(`Here is the chart:\n${LINE}\n`)).toEqual([
      { kind: "share", share_id: SH, name: "chart.png" },
    ]);
  });

  test("a final that rewrote shown prose adds only its shares", () => {
    const hold = createMediaHold();
    hold.push("Hello there.\nMEDIA:/tmp/chart.png");
    expect(hold.settle(`Hi.\n${LINE}`)).toEqual([{ kind: "share", share_id: SH, name: "chart.png" }]);
  });

  test("a final that rewrote shown prose still emits the held prose", () => {
    const hold = createMediaHold();
    expect(hold.push("Hello there.\nMEDIA:/tmp/chart.png\nThat is all.")).toBe("Hello there.\n");
    // Matched from the final's MEDIA line on, as the final now reads.
    expect(hold.settle(`Hi.\n${LINE}\nThat is all!`)).toEqual([
      { kind: "share", share_id: SH, name: "chart.png" },
      { kind: "text", text: "That is all!" },
    ]);
    // A final with no MEDIA line to match: its shares (none), then the tail as streamed.
    hold.push("Hello.\nMEDIA:/tmp/chart.png\nBye.");
    expect(hold.settle("Something else entirely.")).toEqual([
      { kind: "text", text: "MEDIA:/tmp/chart.png\nBye." },
    ]);
  });

  test("a paragraph a tool call ends is read as it stands", () => {
    const hold = createMediaHold();
    hold.push(`Shared.\n${LINE}\n`);
    expect(hold.end()).toEqual([{ kind: "share", share_id: SH, name: "chart.png" }]);
    expect(hold.holding()).toBe(false);
  });

  test("the outbox is read once, and a failure or a stall is no description", async () => {
    let calls = 0;
    const once = outboxOnce(
      () => {
        calls += 1;
        return Promise.resolve([ENTRY]);
      },
      "sindri",
      undefined,
    );
    expect(await once()).toEqual([ENTRY]);
    expect(await once()).toEqual([ENTRY]);
    expect(calls).toBe(1);
    expect(await outboxOnce(() => Promise.reject(new Error("down")), "sindri", undefined)()).toBeNull();
    const stall = outboxOnce(() => new Promise(() => undefined), "sindri", undefined, 10);
    expect(await stall()).toBeNull();
    expect(await outboxOnce(undefined, "sindri", undefined)()).toBeNull();
  });
});

/* ── through a live turn ──────────────────────────────────────────────────── */

/** A client whose socket answers `prompt.submit` with `events`, in order. */
function liveClient(events: readonly string[], outbox?: () => Promise<readonly FileEntry[]>) {
  const fetchImpl: ChatFetch = () =>
    Promise.resolve(
      new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
  let lists = 0;
  const openSocket = (): ChatSocket => {
    const buffer: string[] = [];
    let done = false;
    let wake: (() => void) | null = null;
    const push = (frame: string): void => {
      buffer.push(frame);
      const w = wake;
      wake = null;
      w?.();
    };
    const results: Record<string, unknown> = {
      "session.create": SESSION_CREATE_RESULT,
      "prompt.submit": PROMPT_SUBMIT_RESULT,
    };
    return {
      opened: Promise.resolve(),
      frames: (async function* () {
        for (;;) {
          while (buffer.length > 0) yield buffer.shift() as string;
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
      send(data: string) {
        const doc = JSON.parse(data) as { id: number; method: string };
        push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result: results[doc.method] ?? {} }));
        if (doc.method === "prompt.submit") for (const e of events) push(e);
      },
      close: () => {
        done = true;
        const w = wake;
        wake = null;
        w?.();
      },
    };
  };
  const client = createHermesChat({
    fetch: fetchImpl,
    openSocket,
    now: () => "2026-10-14T10:00:00.000Z",
    slotWaitMs: 2000,
    pooled: false,
    ...(outbox
      ? {
          listOutbox: (instance: string) => {
            expect(instance).toBe("sindri");
            lists += 1;
            return outbox();
          },
        }
      : {}),
  });
  return { client, lists: () => lists };
}

async function turn(client: ReturnType<typeof liveClient>["client"]) {
  const frames: ChatFrame[] = [];
  for await (const frame of client.send(BOX, "default", "chart please")) frames.push(frame);
  for (const frame of frames) expect(ChatFrameSchema.safeParse(frame).success).toBe(true);
  const text = frames.flatMap((f) => (f.type === "delta" ? [f.text] : [])).join("");
  const blocks = frames.flatMap((f) => (f.type === "block" ? [f.block] : []));
  return { frames, text, blocks };
}

describe("a live turn", () => {
  test("the transformed final's outbox line is a chip, described from the outbox", async () => {
    const { client, lists } = liveClient(
      [
        eventFrame("message.delta", 1, { text: "Here is the chart:\n" }),
        eventFrame("message.delta", 2, { text: "MEDIA:/data/hermes/work/chart.png\n" }),
        eventFrame("message.complete", 3, {
          text: `Here is the chart:\n${LINE}\n`,
          status: "complete",
          response_transformed: true,
        }),
      ],
      () => Promise.resolve([ENTRY]),
    );
    const { frames, text, blocks } = await turn(client);
    expect(text).toBe("Here is the chart:\n");
    expect(text).not.toContain("MEDIA:");
    expect(blocks.filter((b) => b.kind === "attachment")).toEqual([
      {
        kind: "attachment",
        name: "chart.png",
        mime: "image/png",
        bytes: 2048,
        href: `outbox/${SH}/chart.png`,
        file_id: SH,
        sha256: "a".repeat(64),
      },
    ]);
    expect(lists()).toBe(1);
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("a transformed final with no deltas before it is mapped whole", async () => {
    const { client } = liveClient([
      eventFrame("message.complete", 1, {
        text: `Two files.\n${LINE}\nMEDIA:${FILES_OUTBOX_DIR}/${SH2}/data.csv\n`,
        status: "complete",
        response_transformed: true,
      }),
    ]);
    const { text, blocks } = await turn(client);
    expect(text).toBe("Two files.\n");
    expect(
      blocks
        .filter((b) => b.kind === "attachment")
        .map((b) => b.kind === "attachment" && [b.file_id, b.bytes, b.mime, b.sha256]),
    ).toEqual([
      [SH, 0, "image/png", null],
      [SH2, 0, "text/csv", null],
    ]);
  });

  test("a MEDIA line nothing shared stays text, after the prose it followed", async () => {
    const { client, lists } = liveClient(
      [
        eventFrame("message.delta", 1, { text: "Saved it.\nMEDIA:/tmp/x.png\nBye" }),
        eventFrame("message.complete", 2, {
          text: "Saved it.\nMEDIA:/tmp/x.png\nBye",
          status: "complete",
        }),
      ],
      () => Promise.resolve([ENTRY]),
    );
    const { text, blocks } = await turn(client);
    expect(text).toBe("Saved it.\nMEDIA:/tmp/x.png\nBye");
    expect(blocks.some((b) => b.kind === "attachment")).toBe(false);
    expect(lists()).toBe(0);
  });

  test("the outbox listing failing still draws the chip, undescribed", async () => {
    const { client } = liveClient(
      [
        eventFrame("message.complete", 1, {
          text: LINE,
          status: "complete",
          response_transformed: true,
        }),
      ],
      () => Promise.reject(new Error("box unreachable")),
    );
    const { blocks, frames } = await turn(client);
    expect(
      blocks.filter((b) => b.kind === "attachment").map((b) => b.kind === "attachment" && b.bytes),
    ).toEqual([0]);
    expect(frames.at(-1)?.type).toBe("done");
  });

  test("a paragraph a tool call ends lets go of what it held, in order", async () => {
    const { client } = liveClient([
      eventFrame("message.delta", 1, { text: `Sharing.\n${LINE}\n` }),
      eventFrame("tool.start", 2, { tool_id: "c1", name: "share_file", args: { path: "/tmp/b.csv" } }),
      eventFrame("tool.complete", 3, {
        tool_id: "c1",
        name: "share_file",
        result: JSON.stringify({ ...SHARE, share_id: SH2, name: "b.csv", mime: "text/csv" }),
      }),
      eventFrame("message.delta", 4, { text: "Done." }),
      eventFrame("message.complete", 5, { text: "Done.", status: "complete" }),
    ]);
    const { blocks, text } = await turn(client);
    const order = blocks
      .filter((b) => b.kind === "attachment" || b.kind === "tool")
      .map((b) =>
        b.kind === "tool" ? `${b.status}:${b.share?.share_id ?? "-"}` : `chip:${b.file_id}`,
      );
    expect(order).toEqual([`chip:${SH}`, "running:-", `ok:${SH2}`]);
    expect(text).toBe("Sharing.\nDone.");
  });

  test("the chip takes the listing's name; a share the listing lacks draws none", async () => {
    const { client } = liveClient(
      [
        eventFrame("message.complete", 1, {
          text: `Two.\n${LINE}\nMEDIA:${FILES_OUTBOX_DIR}/${SH2}/data.csv\nEnd.`,
          status: "complete",
          response_transformed: true,
        }),
      ],
      () => Promise.resolve([{ ...ENTRY, name: "q3.png" }]),
    );
    const { blocks, text } = await turn(client);
    expect(
      blocks.flatMap((b) => (b.kind === "attachment" ? [[b.file_id, b.name, b.href]] : [])),
    ).toEqual([[SH, "q3.png", `outbox/${SH}/q3.png`]]);
    expect(text).toBe("Two.\nEnd.");
  });

  test("a listing read earlier in the turn is read again for a later share", async () => {
    let reads = 0;
    const { client, lists } = liveClient(
      [
        eventFrame("message.delta", 1, { text: `Sharing.\n${LINE}\n` }),
        eventFrame("tool.start", 2, { tool_id: "c1", name: "terminal", args: {} }),
        eventFrame("message.delta", 3, { text: "And:\nMEDIA:/tmp/data.csv\n" }),
        eventFrame("message.complete", 4, {
          text: `And:\nMEDIA:${FILES_OUTBOX_DIR}/${SH2}/data.csv\n`,
          status: "complete",
          response_transformed: true,
        }),
      ],
      () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? [ENTRY] : [ENTRY, ENTRY2]);
      },
    );
    const { blocks } = await turn(client);
    expect(blocks.flatMap((b) => (b.kind === "attachment" ? [[b.file_id, b.bytes]] : []))).toEqual([
      [SH, 2048],
      [SH2, 99],
    ]);
    expect(lists()).toBe(2);
  });

  test("a transformed final after reasoning closed the paragraph repeats nothing", async () => {
    const { client } = liveClient([
      eventFrame("message.delta", 1, { text: "Hi there.\nMEDIA:/tmp/a.png\n" }),
      eventFrame("thinking.delta", 2, { text: "hmm" }),
      eventFrame("reasoning.available", 3, {}),
      eventFrame("message.complete", 4, {
        text: `Hi there.\n${LINE}\n`,
        status: "complete",
        response_transformed: true,
      }),
    ]);
    const { text, blocks } = await turn(client);
    expect(text).toBe("Hi there.\nMEDIA:/tmp/a.png\n");
    expect(blocks.flatMap((b) => (b.kind === "attachment" ? [b.file_id] : []))).toEqual([SH]);
  });

  test("nothing held, reasoning between, a transformed final: nothing repeats", async () => {
    const { client } = liveClient([
      eventFrame("message.delta", 1, { text: "Hi there." }),
      eventFrame("thinking.delta", 2, { text: "hmm" }),
      eventFrame("reasoning.available", 3, {}),
      eventFrame("message.complete", 4, {
        text: "Hi there.",
        status: "complete",
        response_transformed: true,
      }),
    ]);
    const { text, blocks } = await turn(client);
    expect(text).toBe("Hi there.");
    expect(blocks.filter((b) => b.kind === "reasoning")).toHaveLength(1);
  });

  test("a stopped turn draws a held chip undescribed, without waiting on the box", async () => {
    let lists = 0;
    const stop = new AbortController();
    const { client } = liveClient(
      [eventFrame("message.delta", 1, { text: `Here.\n${LINE}\n` })],
      () => {
        lists += 1;
        return new Promise(() => undefined);
      },
    );
    const frames: ChatFrame[] = [];
    for await (const frame of client.send(BOX, "default", "chart please", { signal: stop.signal })) {
      frames.push(frame);
      if (frame.type === "delta") stop.abort();
    }
    const chips = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "attachment" ? [[f.block.file_id, f.block.bytes]] : [],
    );
    expect(chips).toEqual([[SH, 0]]);
    expect(lists).toBe(0);
    expect(frames.at(-1)).toMatchObject({ type: "done", incomplete: true });
  });

  test("reasoning that closes a paragraph lets go of its held tail first", async () => {
    const { client } = liveClient([
      eventFrame("message.delta", 1, { text: "Look:\nMEDIA:/tmp/a.png\nmore" }),
      eventFrame("thinking.delta", 2, { text: "hmm" }),
      eventFrame("message.delta", 3, { text: " Next." }),
      eventFrame("message.complete", 4, {
        text: `Look:\n${LINE}\nmore Next.`,
        status: "complete",
        response_transformed: true,
      }),
    ]);
    const { frames, text } = await turn(client);
    const reasoningAt = frames.findIndex((f) => f.type === "block" && f.block.kind === "reasoning");
    const tailAt = frames.findIndex((f) => f.type === "delta" && f.text.includes("MEDIA:/tmp/a.png"));
    expect(tailAt).toBeGreaterThan(-1);
    expect(tailAt).toBeLessThan(reasoningAt);
    // Nothing shown repeats; the share the final names still arrives, once.
    expect(text).toBe("Look:\nMEDIA:/tmp/a.png\nmore Next.");
    const chips = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "attachment" ? [f.block.file_id] : [],
    );
    expect(chips).toEqual([SH]);
  });

  test("a subagent block lets go of the held tail first", async () => {
    const { client } = liveClient([
      eventFrame("message.delta", 1, { text: "Look:\nMEDIA:/tmp/a.png\n" }),
      eventFrame("message.delta", 2, { text: "x" }, "child-session"),
      eventFrame("message.complete", 3, { text: "Look:\nMEDIA:/tmp/a.png\n", status: "complete" }),
    ]);
    const { frames } = await turn(client);
    const subagentAt = frames.findIndex(
      (f) => f.type === "block" && f.block.kind === "unknown" && f.block.name === "subagent",
    );
    const tailAt = frames.findIndex((f) => f.type === "delta" && f.text.includes("MEDIA:/tmp/a.png"));
    expect(subagentAt).toBeGreaterThan(-1);
    expect(tailAt).toBeGreaterThan(-1);
    expect(tailAt).toBeLessThan(subagentAt);
  });
});

describe("history", () => {
  test("a bot row's outbox lines are chips, a user row's are not, and a share card keeps its share", () => {
    const messages = mapHistory(BOX, STORED_SESSION_ID, {
      messages: [
        { id: 1, role: "user", content: `look at ${LINE}\n${LINE}` },
        {
          id: 2,
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "share_file", arguments: JSON.stringify({ path: "/tmp/chart.png" }) },
            },
          ],
        },
        {
          id: 3,
          role: "tool",
          tool_call_id: "c1",
          tool_name: "share_file",
          content: JSON.stringify(SHARE),
        },
        { id: 4, role: "assistant", content: `Here it is.\n${LINE}\nMEDIA:/tmp/kept.png` },
      ],
    });
    const user = messages.find((m) => m.role === "user")!;
    expect(user.blocks.some((b) => b.kind === "attachment" && b.file_id === SH)).toBe(false);
    const card = messages
      .flatMap((m) => m.blocks)
      .find((b) => b.kind === "tool" && b.name === "share_file");
    expect(card?.kind === "tool" && card.share).toEqual(SHARE);
    const reply = messages.at(-1)!;
    expect(reply.blocks).toEqual([
      { kind: "text", markdown: "Here it is.\n" },
      {
        kind: "attachment",
        name: "chart.png",
        mime: "image/png",
        bytes: 0,
        href: `outbox/${SH}/chart.png`,
        file_id: SH,
        sha256: null,
      },
      { kind: "text", markdown: "MEDIA:/tmp/kept.png" },
    ]);
  });
});
