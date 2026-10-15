/**
 * Fixture chat's files: the attachments the canned transcripts show, with real
 * bytes behind them, and the turn a fixture agent answers an attached message
 * with.
 *
 * The canned `attachment` blocks used to point at hrefs nothing served. They
 * now name entries seeded into `MemoryFiles` (`seedFixtureChatFiles`), so a
 * head's `files.content` by `file_id` loads a real thumbnail and a real text
 * preview in fixture mode. The bytes are made here — a 32×32 PNG drawn in code
 * and a short markdown note — so nothing binary is checked in, and nothing in
 * them looks like a credential.
 */
import type { TurnAttachments } from "../../chat/hermes/hermes-chat-types.ts";
import type { AttachmentBlock, ChatFrame, ChatMessage, FilesCommitResult } from "../../schema/index.ts";
import { HERMES_HOME } from "../../shared/hermes.ts";
import { sha256Hex } from "../../shared/sha256.ts";

/* ── a PNG, by hand ───────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A zlib stream with uncompressed DEFLATE blocks, portable to the phone. */
function deflateStored(bytes: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(bytes.length / 0xffff));
  const out = new Uint8Array(2 + blockCount * 5 + bytes.length + 4);
  let cursor = 0;
  out[cursor++] = 0x78; // zlib header: deflate, 32K window
  out[cursor++] = 0x01; // fastest/no-compression hint

  for (let offset = 0, block = 0; block < blockCount; block++) {
    const length = Math.min(0xffff, bytes.length - offset);
    out[cursor++] = block === blockCount - 1 ? 1 : 0; // final, byte-aligned stored block
    out[cursor++] = length & 0xff;
    out[cursor++] = length >>> 8;
    const inverse = ~length & 0xffff;
    out[cursor++] = inverse & 0xff;
    out[cursor++] = inverse >>> 8;
    out.set(bytes.subarray(offset, offset + length), cursor);
    cursor += length;
    offset += length;
  }

  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  new DataView(out.buffer).setUint32(cursor, ((b << 16) | a) >>> 0);
  return out;
}

/**
 * A `size`×`size` RGB PNG: a rising line over a dark grid, the queue-depth
 * chart the transcript talks about, at thumbnail scale.
 */
export function fixturePng(size = 32): Uint8Array {
  const row = 1 + size * 3;
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const line = size - 1 - Math.floor((x * x) / size);
      const on = Math.abs(y - line) <= 1;
      const grid = x % 8 === 0 || y % 8 === 0;
      const at = y * row + 1 + x * 3;
      raw[at] = on ? 0xf5 : grid ? 0x2a : 0x14;
      raw[at + 1] = on ? 0xa6 : grid ? 0x2e : 0x17;
      raw[at + 2] = on ? 0x23 : grid ? 0x36 : 0x1f;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter, no interlace
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateStored(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/* ── the seeded entries ───────────────────────────────────────────────────── */

const IOSTAT_NOTE = [
  "# granite iostat, 2026-09-17",
  "",
  "Device   r/s    w/s   rkB/s    wkB/s  aqu-sz  %util",
  "nvme1n1  12.0  844.0   192.0 124928.0    4.02  99.60",
  "",
  "The data volume is pinned at its gp3 baseline throughput (125 MiB/s).",
  "Raising it to 500 MiB/s and 6000 IOPS clears the queue.",
  "",
].join("\n");

interface SeededFile {
  id: string;
  agent: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Every file the canned transcripts attach, by the name a catalog row uses. */
export const FIXTURE_CHAT_FILES = {
  iostat: {
    id: "f_fxiostat0917",
    agent: "atlas",
    name: "granite-iostat-2026-09-17.md",
    mime: "text/markdown",
    bytes: new TextEncoder().encode(IOSTAT_NOTE),
  },
  queueDepth: {
    id: "f_fxqueuedpth1",
    agent: "atlas",
    name: "queue-depth.png",
    mime: "image/png",
    bytes: fixturePng(),
  },
} as const satisfies Record<string, SeededFile>;

const SEEDED_DAY = "2026-09-17";

function relOf(file: SeededFile): string {
  return `inbox/${SEEDED_DAY}/${file.id}/${file.name}`;
}

function sha256(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** The transcript's block for one seeded file. */
export function fixtureAttachmentBlock(file: SeededFile): AttachmentBlock {
  return {
    kind: "attachment",
    name: file.name,
    mime: file.mime,
    bytes: file.bytes.byteLength,
    href: relOf(file),
    file_id: file.id,
    sha256: sha256(file.bytes),
  };
}

/**
 * The inbox entry for each canned transcript file, for the fixture box to hold.
 * Committed long ago and never expiring, so a fixture session opened on any day
 * still loads them. Plain records rather than a write into `MemoryBackend`:
 * this module is in the phone's fixture door, which must not reach `backend/`
 * (`test/chat-client-portable.test.ts`); `memory-fixture.ts` does the seeding.
 */
export function fixtureChatFileEntries() {
  return (Object.values(FIXTURE_CHAT_FILES) as SeededFile[]).map((file) => {
    const rel = relOf(file);
    return {
      id: file.id,
      agent: file.agent,
      name: file.name,
      bytes: file.bytes,
      mime: file.mime,
      sha256: sha256(file.bytes),
      class: file.mime.startsWith("image/") ? ("image" as const) : ("file" as const),
      state: "inbox" as const,
      created_at: `${SEEDED_DAY}T09:20:00.000Z`,
      expires_at: "2099-01-01T00:00:00.000Z",
      rel,
      path: `${HERMES_HOME}/${rel}`,
    };
  });
}

/* ── a turn that carries attachments ──────────────────────────────────────── */

/** The operator's row for an attached turn: their text, then one chip per file. */
export function attachedUserBlocks(
  text: string,
  files: readonly FilesCommitResult[],
): Array<{ kind: "text"; markdown: string } | AttachmentBlock> {
  return [
    ...(text ? [{ kind: "text" as const, markdown: text }] : []),
    ...files.map(
      (file): AttachmentBlock => ({
        kind: "attachment",
        name: file.name,
        mime: file.mime,
        bytes: file.bytes,
        href: file.rel,
        file_id: file.id,
        sha256: file.sha256,
      }),
    ),
  ];
}

/** What a fixture agent says to an attached turn: how many files, and which. */
export function attachmentReply(files: readonly FilesCommitResult[]): string {
  const count = files.length === 1 ? "1 attached file" : `${files.length} attached files`;
  return `I have the ${count}: ${files.map((f) => f.name).join(", ")}. Reading them now.`;
}

/** The replayed turn for an attached message: the acknowledgement, streamed, then `done`. */
export function* attachmentTurn(
  message: string,
  files: readonly FilesCommitResult[],
): Generator<Extract<ChatFrame, { seq: number }>> {
  let seq = 0;
  yield { type: "block", seq: ++seq, message, block: { kind: "text", markdown: "" } };
  const reply = attachmentReply(files);
  for (let i = 0; i < reply.length; i += 11) {
    yield { type: "delta", seq: ++seq, message, text: reply.slice(i, i + 11) };
  }
  yield { type: "done", seq: ++seq, message, usage: null, incomplete: null };
}

/**
 * A turn's attachments with the commit wrapped, for a fixture layer that keeps
 * its own copy of the operator's row (`fixture-bot-mode.ts`): each commit
 * that lands turns the row into the message and its chips, and a refused one
 * takes the row back out — the box writes no row for a turn it never ran.
 */
export function chipsAsCommitted(
  attachments: TurnAttachments,
  text: string,
  row: ChatMessage,
  transcript: ChatMessage[],
): TurnAttachments {
  const done: FilesCommitResult[] = [];
  return {
    ids: attachments.ids,
    async commit(id, session, signal) {
      try {
        const file = await attachments.commit(id, session, signal);
        done.push(file);
        row.blocks = attachedUserBlocks(text, done);
        return file;
      } catch (e) {
        const at = transcript.indexOf(row);
        if (at >= 0) transcript.splice(at, 1);
        throw e;
      }
    },
  };
}
