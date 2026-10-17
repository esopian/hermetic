import { HermeticError } from "@hermetic/core/chat-client";
import type { FilesStageResult } from "@hermetic/core/schema";
import {
  ATTACHMENTS_PER_TURN,
  type AttachmentAction,
  attachmentChips,
  attachmentsReducer,
  attachmentsSummary,
  capFor,
  expiredStaged,
  inTray,
  outgoingAttachments,
  type PendingAttachment,
  type PickedFile,
  pendingAttachment,
  resendAttachments,
  roomFor,
  stageAll,
} from "../../src/client/attachments.ts";
import { FILES_LIMITS } from "@hermetic/core/shared";
import { ATTACHMENT_LIMIT, errorCopy, PERMISSION_DENIED } from "../../src/client/errors.ts";
import type { PhoneFilesStageInput } from "../../src/gateway/files.ts";

const file = (name: string, kind: PickedFile["kind"] = "file"): PickedFile => ({
  name,
  uri: `file:///cache/${name}`,
  mime: kind === "image" ? "image/jpeg" : "text/plain",
  size: 3,
  kind,
});

function staged(id: string, name: string): FilesStageResult {
  return {
    id,
    name,
    mime: "text/plain",
    bytes: 3,
    sha256: "0".repeat(64),
    class: "file",
    expires_at: "2026-10-13T11:00:00.000Z",
  } as FilesStageResult;
}

const draft = (...names: string[]): PendingAttachment[] =>
  attachmentsReducer([], {
    type: "add",
    items: names.map((n, i) => pendingAttachment(file(n), `a${i + 1}`)),
  });

describe("the draft reducer", () => {
  test("add, stage, fail, retry, remove, clear", () => {
    let s = draft("a.txt", "b.txt");
    expect(s.map((a) => [a.local_id, a.status])).toEqual([
      ["a1", "picked"],
      ["a2", "picked"],
    ]);
    s = attachmentsReducer(s, { type: "staging", local_id: "a1" });
    s = attachmentsReducer(s, { type: "staged", local_id: "a1", staged: staged("f_1", "a.txt") });
    s = attachmentsReducer(s, {
      type: "failed",
      local_id: "a2",
      error: { code: "FILE_TOO_LARGE", message: "too big" },
    });
    expect(s[0]).toMatchObject({ status: "staged", staged: { id: "f_1" } });
    expect(s[1]).toMatchObject({ status: "failed", error: { code: "FILE_TOO_LARGE" } });
    expect(attachmentsSummary(s)).toEqual({
      picked: 0,
      staging: 0,
      staged: 1,
      failed: 1,
      ready: false,
    });
    s = attachmentsReducer(s, { type: "retry", local_id: "a2" });
    expect(s[1]!.status).toBe("picked");
    expect(s[1]!.error).toBeUndefined();
    s = attachmentsReducer(s, { type: "remove", local_id: "a2" });
    expect(attachmentsSummary(s).ready).toBe(true);
    expect(attachmentsReducer(s, { type: "clear" })).toEqual([]);
  });

  test("staging drops the bytes it no longer needs", () => {
    let s = attachmentsReducer([], {
      type: "add",
      items: [pendingAttachment(file("a.txt"), "a1", new Uint8Array([1, 2, 3]))],
    });
    expect(s[0]!.bytes).toBeDefined();
    s = attachmentsReducer(s, { type: "staged", local_id: "a1", staged: staged("f_1", "a.txt") });
    expect(s[0]!.bytes).toBeUndefined();
  });

  test("an unknown id leaves the state as it was", () => {
    const s = draft("a.txt");
    expect(attachmentsReducer(s, { type: "remove", local_id: "nope" })).toBe(s);
    expect(attachmentsReducer(s, { type: "staging", local_id: "nope" })).toBe(s);
  });

  test(`at most ${ATTACHMENTS_PER_TURN} files; the rest of a pick is cut`, () => {
    const names = Array.from({ length: ATTACHMENTS_PER_TURN + 3 }, (_, i) => `f${i}.txt`);
    const s = draft(...names);
    expect(s).toHaveLength(ATTACHMENTS_PER_TURN);
    expect(roomFor(s)).toBe(0);
    expect(attachmentsReducer(s, { type: "add", items: [pendingAttachment(file("x.txt"))] })).toBe(s);
    expect(roomFor(draft("a.txt"))).toBe(ATTACHMENTS_PER_TURN - 1);
  });
});

describe("stageAll", () => {
  test("uploads each picked file in order, reading bytes it lacks, and reports each step", async () => {
    const inputs: PhoneFilesStageInput[] = [];
    const files = {
      stage: jest.fn(async (input: PhoneFilesStageInput) => {
        inputs.push(input);
        if (input.name === "bad.txt") throw new HermeticError("FILE_DIGEST_MISMATCH", "digest");
        return staged(`f_${inputs.length}`, input.name);
      }),
    };
    const read = jest.fn(async () => new Uint8Array([7, 8, 9]));
    const actions: AttachmentAction[] = [];
    const out = await stageAll(draft("a.txt", "bad.txt"), files, {
      session_id: "s-1",
      read,
      dispatch: (a) => actions.push(a),
    });
    expect(read).toHaveBeenCalledWith("file:///cache/a.txt");
    expect(inputs.map((i) => [i.name, i.session_id, [...i.bytes]])).toEqual([
      ["a.txt", "s-1", [7, 8, 9]],
      ["bad.txt", "s-1", [7, 8, 9]],
    ]);
    expect(out.map((a) => a.status)).toEqual(["staged", "failed"]);
    expect(out[1]!.error).toEqual({ code: "FILE_DIGEST_MISMATCH", message: "digest" });
    expect(actions.map((a) => a.type)).toEqual(["staging", "staged", "staging", "failed"]);
  });

  test("leaves staged and failed entries alone", async () => {
    let s = draft("a.txt", "b.txt");
    s = attachmentsReducer(s, { type: "staged", local_id: "a1", staged: staged("f_1", "a.txt") });
    s = attachmentsReducer(s, { type: "failed", local_id: "a2", error: { code: "X", message: "x" } });
    const files = { stage: jest.fn() };
    expect(await stageAll(s, files)).toEqual(s);
    expect(files.stage).not.toHaveBeenCalled();
  });

  test("with no reader and no bytes, the file fails rather than throwing", async () => {
    const out = await stageAll(draft("a.txt"), { stage: jest.fn() });
    expect(out[0]).toMatchObject({ status: "failed", error: { code: "VALIDATION" } });
  });

  test("a file over its cap fails unread, before any upload", async () => {
    const big: PendingAttachment = {
      ...pendingAttachment(file("huge.png", "image"), "a1"),
      size: FILES_LIMITS.imageBytes + 1,
    };
    const read = jest.fn();
    const files = { stage: jest.fn() };
    const out = await stageAll([big], files, { read });
    expect(out[0]).toMatchObject({ status: "failed", error: { code: "FILE_TOO_LARGE" } });
    expect(read).not.toHaveBeenCalled();
    expect(files.stage).not.toHaveBeenCalled();
    expect(capFor({ kind: "image" })).toBe(FILES_LIMITS.imageBytes);
    expect(capFor({ kind: "file" })).toBe(FILES_LIMITS.fileBytes);
  });

  test("the picker's copy is discarded once read, and kept when the read fails", async () => {
    const discard = jest.fn();
    const files = { stage: jest.fn(async (i: PhoneFilesStageInput) => staged("f_1", i.name)) };
    await stageAll(draft("a.txt"), files, { read: async () => new Uint8Array([1]), discard });
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ uri: "file:///cache/a.txt" }));
    discard.mockClear();
    const out = await stageAll(draft("b.txt"), files, {
      read: async () => {
        throw new Error("unreadable");
      },
      discard,
    });
    // Unread: the copy stays for Retry, until the file is removed.
    expect(discard).not.toHaveBeenCalled();
    expect(out[0]!.status).toBe("failed");
    expect(out[0]!.bytes).toBeUndefined();
  });

  test("inTray: only what is still in the tray, in the staged order", () => {
    const staged = draft("a.txt", "b.txt", "c.txt");
    const tray = staged.filter((a) => a.local_id !== "a2");
    expect(inTray(staged, tray).map((a) => a.local_id)).toEqual(["a1", "a3"]);
    expect(inTray(staged, [])).toEqual([]);
  });

  test("a failed upload keeps the bytes it read, so Retry re-sends without the copy", async () => {
    let fail = true;
    const files = {
      stage: jest.fn(async (i: PhoneFilesStageInput) => {
        if (fail) throw new HermeticError("HERMETICD_UNAVAILABLE", "offline");
        return staged("f_1", i.name);
      }),
    };
    const read = jest.fn(async () => new Uint8Array([4, 5]));
    let s = await stageAll(draft("a.txt"), files, { read });
    expect(s[0]).toMatchObject({ status: "failed", bytes: new Uint8Array([4, 5]) });
    s = attachmentsReducer(s, { type: "retry", local_id: "a1" });
    fail = false;
    s = await stageAll(s, files, { read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(s[0]).toMatchObject({ status: "staged" });
    expect(s[0]!.bytes).toBeUndefined();
  });

  test("a box's FILE_TOO_LARGE does not keep the bytes", async () => {
    const files = {
      stage: jest.fn(async () => {
        throw new HermeticError("FILE_TOO_LARGE", "fleet cap");
      }),
    };
    const s = await stageAll(draft("a.txt"), files, { read: async () => new Uint8Array([1]) });
    expect(s[0]!.bytes).toBeUndefined();
  });

  test("a stop leaves the rest picked", async () => {
    const controller = new AbortController();
    const files = {
      stage: jest.fn(async () => {
        controller.abort();
        throw new HermeticError("ABORTED", "stopped");
      }),
    };
    const out = await stageAll(draft("a.txt", "b.txt"), files, {
      signal: controller.signal,
      read: async () => new Uint8Array([1]),
    });
    expect(out.map((a) => a.status)).toEqual(["failed", "picked"]);
    expect(files.stage).toHaveBeenCalledTimes(1);
  });
});

describe("the turn's attachments", () => {
  test("every staged file in order, with the box's commit; null when none", async () => {
    let s = draft("a.txt", "b.txt", "c.txt");
    s = attachmentsReducer(s, { type: "staged", local_id: "a3", staged: staged("f_3", "c.txt") });
    s = attachmentsReducer(s, { type: "staged", local_id: "a1", staged: staged("f_1", "a.txt") });
    const commit = jest.fn(async () => ({}) as never);
    const out = outgoingAttachments(s, { commit });
    expect(out?.ids).toEqual(["f_1", "f_3"]);
    expect(out?.staged?.map((f) => f.name)).toEqual(["a.txt", "c.txt"]);
    await out!.commit("f_1", "s-1", undefined);
    expect(commit).toHaveBeenCalledWith("f_1", "s-1", undefined);
    expect(outgoingAttachments(draft("a.txt"), { commit })).toBeNull();
  });

  test("chips are the desktop's local echo: href is the file id", () => {
    expect(attachmentChips([staged("f_1", "a.txt")])).toEqual([
      {
        kind: "attachment",
        name: "a.txt",
        mime: "text/plain",
        bytes: 3,
        href: "f_1",
        file_id: "f_1",
        sha256: "0".repeat(64),
      },
    ]);
  });
});

describe("error copy", () => {
  test.each([
    "FILE_TOO_LARGE",
    "FILE_DIGEST_MISMATCH",
    "FILE_NAME_INVALID",
    "FILE_LOOKS_SECRET",
    "FILE_NOT_FOUND",
    "DISK_FULL",
    ATTACHMENT_LIMIT,
    PERMISSION_DENIED,
  ])("%s has its own title", (code) => {
    const copy = errorCopy(Object.assign(new Error("m"), { code }));
    expect(copy.title).not.toBe("Something went wrong.");
    expect(copy.detail).toBeTruthy();
  });
});

describe("resending a failed turn's files", () => {
  const chip = (id: string | null, name = "a.txt") => ({
    kind: "attachment" as const,
    name,
    mime: "text/plain",
    bytes: 3,
    href: id ?? "x",
    file_id: id,
  });
  const NOW = Date.parse("2026-10-13T10:30:00.000Z");

  test("the same ids again, through the box's commit, with the chips", async () => {
    const commit = jest.fn(async () => ({}) as never);
    const out = resendAttachments(
      { files: [chip("f_1"), chip("f_2", "b.txt")], recorded: false },
      { commit },
      (id) => staged(id, "a.txt"),
      NOW,
    );
    expect(out?.ids).toEqual(["f_1", "f_2"]);
    expect(out?.chips?.map((c) => c.name)).toEqual(["a.txt", "b.txt"]);
    await out!.commit("f_2", "s-1", undefined);
    expect(commit).toHaveBeenCalledWith("f_2", "s-1", undefined);
  });

  test("no files: null", () => {
    expect(
      resendAttachments({ files: [], recorded: false }, { commit: jest.fn() }, () => undefined, NOW),
    ).toBeNull();
  });

  test("this phone's echo with a staged file past its expiry is refused", () => {
    const expired = { ...staged("f_1", "a.txt"), expires_at: "2026-10-13T10:00:00.000Z" };
    expect(() =>
      resendAttachments(
        { files: [chip("f_1")], recorded: false },
        { commit: jest.fn() },
        () => expired,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: "FILE_NOT_FOUND" }));
    // The box's own row: its files were committed, so the stage expiry does not apply.
    expect(
      resendAttachments(
        { files: [chip("f_1")], recorded: true },
        { commit: jest.fn() },
        () => expired,
        NOW,
      )?.ids,
    ).toEqual(["f_1"]);
  });

  test("a chip with no file id cannot go again", () => {
    expect(() =>
      resendAttachments(
        { files: [chip(null)], recorded: true },
        { commit: jest.fn() },
        () => undefined,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: "FILE_NOT_FOUND" }));
  });
});

describe("expiredStaged", () => {
  test("staged files at or near their expiry, by local id", () => {
    const now = Date.parse("2026-10-13T11:00:00.000Z");
    const at = (iso: string) => ({ ...staged("f", "a.txt"), expires_at: iso });
    let s = draft("a.txt", "b.txt", "c.txt", "d.txt");
    s = attachmentsReducer(s, {
      type: "staged",
      local_id: "a1",
      staged: at("2026-10-13T10:00:00.000Z"),
    });
    s = attachmentsReducer(s, {
      type: "staged",
      local_id: "a2",
      staged: at("2026-10-13T11:00:30.000Z"),
    });
    s = attachmentsReducer(s, {
      type: "staged",
      local_id: "a3",
      staged: at("2026-10-13T11:30:00.000Z"),
    });
    expect(expiredStaged(s, now)).toEqual(["a1", "a2"]);
  });
});
