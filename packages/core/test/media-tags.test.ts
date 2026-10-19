/**
 * Desktop parity for `MEDIA:` tags. The parser cases are ported from the Hermes
 * desktop app (`apps/desktop/src/lib/chat-messages/parts.test.ts` and the
 * `renderMediaTags` cases in `lib/chat-messages.test.ts`): where the desktop
 * asserts the markdown link a tag renders to, these assert the value the tag
 * carries, which is what the link is built from. The streaming cases are the
 * desktop's split-delta cases run through the live turn's hold. Then what a
 * share's type decides: the sniffed audio and video types, the kind a card
 * draws, and what `files.content` may read for each purpose. Home paths in
 * the ported cases use the repo's allowlisted names (`/home/app`,
 * `/Users/nobody`, `scripts/lint.ts` rule 5) in place of the desktop's.
 */
import { describe, expect, test } from "bun:test";
import {
  createMediaHold,
  describeShares,
  readMediaShares,
  splitMedia,
} from "../src/chat/hermes/hermes-chat-media.ts";
import { MemoryFiles } from "../src/backend/fixture/memory-files.ts";
import {
  FILES_LIMITS,
  FILES_OUTBOX_DIR,
  contentPurposeAllows,
  contentPurposeBytes,
  isTextPreviewMime,
  mediaKindOf,
  parseOutboxMediaLine,
  sniffMime,
} from "../src/shared/files.ts";
import type { ChatBlock, FileEntry } from "../src/schema/index.ts";
import {
  mediaLinePath,
  mediaTagValues,
  partialDirectiveTail,
  unquoteMediaPath,
} from "../src/shared/media-tags.ts";

const SPACED = "/home/app/Morten - Nobly Kickoff - Opening and cue cards EN.docx";
const SH = "sh_abcdefghij12";

describe("mediaTagValues (desktop parts.test.ts, #96657)", () => {
  test("keeps the whole spaced path in one value on every surface that reads MEDIA tags", () => {
    expect(mediaTagValues(`MEDIA:${SPACED}`)).toEqual([SPACED]);
    expect(mediaTagValues(`Here you go: MEDIA:${SPACED} — enjoy`)).toEqual([SPACED]);
    expect(mediaTagValues("MEDIA:C:\\Users\\Morten\\My Report.docx")).toEqual([
      "C:\\Users\\Morten\\My Report.docx",
    ]);
    expect(mediaTagValues(`ready\nMEDIA:${SPACED}\nMEDIA:/tmp/a.png`)).toEqual([SPACED, "/tmp/a.png"]);
  });

  test("standalone and inline tags (desktop renderMediaTags cases)", () => {
    expect(mediaTagValues("here\nMEDIA:/tmp/voice.mp3\nthere")).toEqual(["/tmp/voice.mp3"]);
    expect(mediaTagValues("audio: MEDIA:/tmp/voice.mp3 done")).toEqual(["/tmp/voice.mp3"]);
    expect(mediaTagValues("MEDIA:/tmp/demo.mp4")).toEqual(["/tmp/demo.mp4"]);
    expect(
      mediaTagValues(
        "MEDIA:/Users/nobody/.hermes/cache/audio/tts_20260501_222725.mp3\n\nhow's that sound?",
      ),
    ).toEqual(["/Users/nobody/.hermes/cache/audio/tts_20260501_222725.mp3"]);
  });

  test("quoted and backticked values keep their quotes until unquoted", () => {
    const values = mediaTagValues(
      "a MEDIA:\"/tmp/My File.pdf\" b MEDIA:`/tmp/clip one.mp4` c MEDIA:'/tmp/x y.wav'",
    );
    expect(values).toEqual(['"/tmp/My File.pdf"', "`/tmp/clip one.mp4`", "'/tmp/x y.wav'"]);
    expect(values.map(unquoteMediaPath)).toEqual([
      "/tmp/My File.pdf",
      "/tmp/clip one.mp4",
      "/tmp/x y.wav",
    ]);
  });

  test("an unknown extension ends at the first blank, as on the desktop", () => {
    expect(mediaTagValues("MEDIA:/tmp/build log.weird")).toEqual(["/tmp/build"]);
  });

  test("a bare quote is not a quoted value", () => {
    expect(unquoteMediaPath('"')).toBe('"');
    expect(unquoteMediaPath("  /tmp/a.png  ")).toBe("/tmp/a.png");
  });
});

describe("mediaLinePath: a line that is one MEDIA tag", () => {
  test("bare, spaced, quoted, backticked and emphasised forms read the same path", () => {
    for (const line of [
      "MEDIA:/tmp/AI Brain/report.pdf",
      "  MEDIA: /tmp/AI Brain/report.pdf  ",
      'MEDIA:"/tmp/AI Brain/report.pdf"',
      "MEDIA:'/tmp/AI Brain/report.pdf'",
      "MEDIA:`/tmp/AI Brain/report.pdf`",
      '**MEDIA:"/tmp/AI Brain/report.pdf"**',
      "__MEDIA:/tmp/AI Brain/report.pdf__",
      "MEDIA:/tmp/AI Brain/report.pdf\r",
    ])
      expect(mediaLinePath(line)).toBe("/tmp/AI Brain/report.pdf");
  });

  test("anything else on the line, or a quote left open, is not one tag", () => {
    for (const line of [
      "see MEDIA:/tmp/a.png",
      'MEDIA:"/tmp/a.png',
      "**MEDIA:/tmp/a.png*",
      "MEDIA:",
      "MEDIA:   ",
      "media:/tmp/a.png",
    ])
      expect(mediaLinePath(line)).toBeNull();
  });
});

describe("parseOutboxMediaLine reads the desktop forms of an outbox line", () => {
  const path = (name: string) => `${FILES_OUTBOX_DIR}/${SH}/${name}`;

  test("quoted, backticked, emphasised and spaced names are shares", () => {
    expect(parseOutboxMediaLine(`MEDIA:${path("standup recap.wav")}`)).toEqual({
      share_id: SH,
      name: "standup recap.wav",
    });
    expect(parseOutboxMediaLine(`MEDIA:"${path("release notes.md")}"`)).toEqual({
      share_id: SH,
      name: "release notes.md",
    });
    expect(parseOutboxMediaLine(`MEDIA:\`${path("clip.webm")}\``)).toEqual({
      share_id: SH,
      name: "clip.webm",
    });
    expect(parseOutboxMediaLine(`**MEDIA:${path("chart.png")}**`)).toEqual({
      share_id: SH,
      name: "chart.png",
    });
  });

  test("the media={false} rule: a path that is not in the outbox stays text", () => {
    for (const line of [
      "MEDIA:/Users/nobody/Desktop/elsewhere.png",
      "MEDIA:C:\\Users\\operator\\shot.png",
      "MEDIA:~/notes.md",
      `Here: MEDIA:${path("chart.png")}`,
      `MEDIA:"${path("chart.png")}`,
    ])
      expect(parseOutboxMediaLine(line)).toBeNull();
    const pieces = splitMedia(
      `Mine:\nMEDIA:/Users/nobody/Desktop/elsewhere.png\nMEDIA:"${path("a b.png")}"\n`,
    );
    expect(pieces).toEqual([
      { kind: "text", text: "Mine:\nMEDIA:/Users/nobody/Desktop/elsewhere.png\n" },
      { kind: "share", share_id: SH, name: "a b.png" },
    ]);
  });
});

describe("streaming: a path split across deltas is never shown half read", () => {
  test("desktop's spaced-path split settles on the complete share", () => {
    const chunks = ["ready\nMEDIA:/tmp/AI", " Brain/re", "port.pdf", "\nall done"];
    const hold = createMediaHold();
    const shown = chunks.map((chunk) => hold.push(chunk));
    expect(shown).toEqual(["ready\n", "", "", ""]);
    // The plugin shared the file and rewrote its line.
    const final = `ready\nMEDIA:${FILES_OUTBOX_DIR}/${SH}/report.pdf\nall done`;
    expect(hold.settle(final)).toEqual([
      { kind: "share", share_id: SH, name: "report.pdf" },
      { kind: "text", text: "all done" },
    ]);
  });

  test("desktop's tag completed by a later delta", () => {
    const hold = createMediaHold();
    expect(hold.push("ok\nMEDIA:")).toBe("ok\n");
    expect(hold.push("/tmp/voice.mp3")).toBe("");
    expect(hold.settle(`ok\nMEDIA:${FILES_OUTBOX_DIR}/${SH}/voice.mp3`)).toEqual([
      { kind: "share", share_id: SH, name: "voice.mp3" },
    ]);
  });

  test("a quoted spaced path split inside its quotes is held too", () => {
    const hold = createMediaHold();
    let shown = "";
    for (const chunk of ['Notes:\n**MEDIA:"/data/hermes/work/rel', 'ease notes.md"**', "\nBye."])
      shown += hold.push(chunk);
    expect(shown).toBe("Notes:\n");
    expect(hold.settle(`Notes:\nMEDIA:${FILES_OUTBOX_DIR}/${SH}/release notes.md\nBye.`)).toEqual([
      { kind: "share", share_id: SH, name: "release notes.md" },
      { kind: "text", text: "Bye." },
    ]);
  });
});

const bytes = (...b: number[]) => new Uint8Array(b);
const enc = (s: string) => new TextEncoder().encode(s);
const at = (prefix: Uint8Array, s: string) => {
  const out = new Uint8Array(prefix.length + s.length);
  out.set(prefix);
  out.set(enc(s), prefix.length);
  return out;
};

describe("sniffMime: audio and video by their magic numbers", () => {
  test("each container is named from its bytes", () => {
    expect(sniffMime(enc("RIFF\0\0\0\0WAVEfmt "), "x.bin")).toBe("audio/wav");
    expect(sniffMime(enc("OggS\0\x02"), "x")).toBe("audio/ogg");
    expect(sniffMime(enc("fLaC\0\0\0\x22"), "x")).toBe("audio/flac");
    expect(sniffMime(enc("ID3\x04\0\0"), "x")).toBe("audio/mpeg");
    expect(sniffMime(bytes(0xff, 0xfb, 0x90, 0x64), "x")).toBe("audio/mpeg");
    expect(sniffMime(bytes(0xff, 0xf1, 0x50, 0x80), "x")).toBe("audio/aac");
    expect(sniffMime(at(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84), "webm"), "a.webm")).toBe(
      "video/webm",
    );
    expect(sniffMime(at(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84), "webm"), "a.weba")).toBe(
      "audio/webm",
    );
    expect(sniffMime(at(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88), "matroska"), "a")).toBe(
      "video/x-matroska",
    );
    expect(sniffMime(at(bytes(0, 0, 0, 0x20), "ftypisom\0\0\x02\0"), "a.mp4")).toBe("video/mp4");
    expect(sniffMime(at(bytes(0, 0, 0, 0x20), "ftypM4A \0\0\0\0"), "a")).toBe("audio/mp4");
    expect(sniffMime(at(bytes(0, 0, 0, 0x14), "ftypqt  \0\0\0\0"), "a")).toBe("video/quicktime");
  });

  test("the name never makes a file media, and JPEG is still JPEG", () => {
    expect(sniffMime(enc("hello"), "song.mp3")).toBe("text/plain");
    expect(sniffMime(bytes(0, 1, 2, 3, 0xff), "clip.mp4")).toBe("application/octet-stream");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0), "x")).toBe("image/jpeg");
  });
});

describe("what a share's type lets the page do", () => {
  test("mediaKindOf: image, audio, video, or a file card", () => {
    expect(mediaKindOf("image/png")).toBe("image");
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(mediaKindOf("audio/ogg; codecs=opus")).toBe("audio");
    expect(mediaKindOf("video/webm")).toBe("video");
    expect(mediaKindOf("video/x-matroska")).toBe("file");
    expect(mediaKindOf("image/svg+xml")).toBe("file");
    expect(mediaKindOf("application/pdf")).toBe("file");
  });

  test("a text preview is text, and never a PEM file", () => {
    expect(isTextPreviewMime("text/markdown")).toBe(true);
    expect(isTextPreviewMime("text/csv")).toBe(true);
    expect(isTextPreviewMime("application/json")).toBe(true);
    expect(isTextPreviewMime("application/x-pem-file")).toBe(false);
    expect(isTextPreviewMime("application/pdf")).toBe(false);
  });

  test("each purpose admits its own types under its own cap", () => {
    expect(contentPurposeAllows("image", "image/png")).toBe(true);
    expect(contentPurposeAllows("image", "audio/wav")).toBe(false);
    expect(contentPurposeAllows("playback", "audio/wav")).toBe(true);
    expect(contentPurposeAllows("playback", "video/mp4")).toBe(true);
    expect(contentPurposeAllows("playback", "image/png")).toBe(false);
    expect(contentPurposeAllows("text", "text/markdown")).toBe(true);
    expect(contentPurposeAllows("text", "audio/wav")).toBe(false);
    expect(contentPurposeBytes("image")).toBe(FILES_LIMITS.imageBytes);
    expect(contentPurposeBytes("playback")).toBe(FILES_LIMITS.playbackBytes);
    expect(contentPurposeBytes("text")).toBe(FILES_LIMITS.textPreviewBytes);
  });

  test("the fixture box refuses a type the purpose does not admit, before reading it", async () => {
    const files = new MemoryFiles({ hasAgent: (n) => n === "atlas", now: () => new Date() });
    const wav = files.share("atlas", { name: "tone.wav", bytes: enc("RIFF\0\0\0\0WAVEfmt ") });
    expect(wav.mime).toBe("audio/wav");
    const read = (purpose: "image" | "playback" | "text") =>
      files
        .content("atlas", wav.share_id, { maxBytes: 1 << 20, purpose })
        .then((c) => c.mime)
        .catch((e: { code?: string }) => e.code);
    expect(await read("playback")).toBe("audio/wav");
    expect(await read("image")).toBe("FILE_TYPE_REJECTED");
    expect(await read("text")).toBe("FILE_TYPE_REJECTED");
  });
});

/*
 * The upstream MEDIA bugs (NousResearch/hermes-agent, checked 2026-10-19),
 * each held as a requirement on the port: one test per issue, named for it.
 */
describe("upstream MEDIA requirements", () => {
  const SH2 = "sh_zyxwvutsrq98";
  const outboxLine = (id: string, name: string) => `MEDIA:${FILES_OUTBOX_DIR}/${id}/${name}`;
  const attachments = (blocks: readonly ChatBlock[]) =>
    blocks.filter((b): b is Extract<ChatBlock, { kind: "attachment" }> => b.kind === "attachment");

  // #141584, PR #138551
  test("a stream split inside a MEDIA path never shows the partial path", () => {
    const hold = createMediaHold();
    let shown = "";
    for (const chunk of ["Sent.\nMEDIA:/tmp/rep", "orts/q3 fin", "al.pdf", "\nAnything else?"]) {
      shown += hold.push(chunk);
      expect(shown).not.toContain("MEDIA:");
    }
    expect(shown).toBe("Sent.\n");
    expect(hold.settle(`Sent.\n${outboxLine(SH, "q3 final.pdf")}\nAnything else?`)).toEqual([
      { kind: "share", share_id: SH, name: "q3 final.pdf" },
      { kind: "text", text: "Anything else?" },
    ]);
    // A reply that is only the tag never shows it either.
    const only = createMediaHold();
    expect(only.push("MEDIA:/tmp/scratch/")).toBe("");
    expect(only.settle(outboxLine(SH, "a.png"))).toEqual([
      { kind: "share", share_id: SH, name: "a.png" },
    ]);
  });

  // PR #138551: the same hold for the gateway's [[…]] directives.
  test("a directive split across deltas is never shown half written", () => {
    const hold = createMediaHold();
    const shown = ["Your note [[audio_", "as_v", "oice]] is ready"].map((c) => hold.push(c));
    expect(shown).toEqual(["Your note ", "", "[[audio_as_voice]] is ready"]);
    const doc = createMediaHold();
    expect(doc.push("Report [[as_doc")).toBe("Report ");
    expect(doc.settle("Report [[as_document]]")).toEqual([{ kind: "text", text: "[[as_document]]" }]);
    // Only an unfinished directive waits: a lone bracket and other brackets stream.
    expect(partialDirectiveTail("see [")).toBe(0);
    expect(partialDirectiveTail("see [[")).toBe(2);
    expect(partialDirectiveTail("see [[link]]")).toBe(0);
    expect(partialDirectiveTail("[[audio_as_voice]]")).toBe(0);
  });

  // #120021, #78383
  test("MEDIA:/tmp/AI Brain/report.pdf gives one candidate", () => {
    expect(mediaTagValues("MEDIA:/tmp/AI Brain/report.pdf")).toEqual(["/tmp/AI Brain/report.pdf"]);
    expect(mediaLinePath("MEDIA:/tmp/AI Brain/report.pdf")).toBe("/tmp/AI Brain/report.pdf");
    // No extensionless fallback: a whole line without a known extension is still one path.
    expect(mediaLinePath("MEDIA:/tmp/AI Brain/report")).toBe("/tmp/AI Brain/report");
    // The box shares one file once (`test_plugin.py`), so its lines name one share: one chip.
    const line = outboxLine(SH, "report.pdf");
    expect(splitMedia(`${line}\n**${line}**\nMEDIA: "${line.slice(6)}"`)).toEqual([
      { kind: "share", share_id: SH, name: "report.pdf" },
    ]);
  });

  // #123567
  test("two MEDIA: lines give two attachments", () => {
    const blocks = readMediaShares([
      {
        kind: "text",
        markdown: `[[audio_as_voice]]\n${outboxLine(SH, "voice.ogg")}\nAnd the chart:\n${outboxLine(SH2, "chart.png")}`,
      },
    ]);
    expect(attachments(blocks).map((b) => b.file_id)).toEqual([SH, SH2]);
  });

  // #34632
  test("a drive path parses", () => {
    expect(mediaLinePath("MEDIA:C:\\Users\\x\\file.pdf")).toBe("C:\\Users\\x\\file.pdf");
    expect(mediaLinePath('MEDIA:"D:/Work Files/Q3 report.pdf"')).toBe("D:/Work Files/Q3 report.pdf");
    expect(mediaTagValues("see MEDIA:C:\\Users\\x\\My File.pdf now")).toEqual([
      "C:\\Users\\x\\My File.pdf",
    ]);
    // Parsed, but not the box's file: it stays text.
    expect(parseOutboxMediaLine("MEDIA:C:\\Users\\x\\file.pdf")).toBeNull();
  });

  // #71559
  test("a /relay/media/ URL is not trusted from its path shape", () => {
    for (const url of [
      "https://evil.example/relay/media/abc.png",
      "https://cdn.example/files/relay/media/photo.png",
      `https://evil.example${FILES_OUTBOX_DIR}/${SH}/a.png`,
    ]) {
      expect(parseOutboxMediaLine(`MEDIA:${url}`)).toBeNull();
      expect(attachments(readMediaShares([{ kind: "text", markdown: `MEDIA:${url}` }]))).toEqual([]);
    }
  });

  // #128855
  test("a refused path does not render as a working attachment", () => {
    // The plugin refused it, so the line is as the model wrote it: text, no chip.
    const refused = readMediaShares([{ kind: "text", markdown: "MEDIA:/data/hermes/.hermes/.env" }]);
    expect(refused).toEqual([{ kind: "text", markdown: "MEDIA:/data/hermes/.hermes/.env" }]);
    // A share the box's outbox does not hold draws no chip, so nothing renders
    // that the box would not serve.
    const listed: FileEntry = {
      id: SH2,
      dir: "outbox",
      class: "file",
      name: "kept.csv",
      bytes: 1,
      mime: "text/csv",
      sha256: "b".repeat(64),
      created_at: "2026-10-14T10:00:00.000Z",
      expires_at: "2026-10-15T10:00:00.000Z",
      from: { kind: "agent" },
    };
    const blocks = readMediaShares([
      { kind: "text", markdown: `${outboxLine(SH, "gone.pdf")}\n${outboxLine(SH2, "kept.csv")}` },
    ]);
    const [described] = describeShares([{ blocks }], [listed]);
    expect(attachments(described?.blocks ?? []).map((b) => b.file_id)).toEqual([SH2]);
  });
});
