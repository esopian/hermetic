/**
 * The composer's attachment pipeline (`chat-attachments.ts`) against a fake
 * bridge: a drop is sent in 1 MiB chunks at the right offsets and staged by
 * upload id; the 64 MiB drop cap and the ten-file cap are chips, not calls;
 * removing a chip stops its work or deletes what the box staged; and only
 * `blob:` URLs this page minted pass `safeImageSrc`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useReducer } from "react";
import { FILES_LIMITS } from "@hermetic/core/shared";
import { act, cleanup, render, waitFor } from "./dom.ts";
import { stubUploadFetch } from "./chat-fixtures.tsx";
import {
  attachmentErrorText,
  chunkOffsets,
  summarize,
  toBase64,
  useDraftAttachments,
} from "../src/chat/chat-attachments.ts";
import type { AttachmentsApi, AttachmentsControl } from "../src/chat/chat-attachments.ts";
import { fresh, key } from "../src/chat/chat-conversation-record.ts";
import type { Conversation } from "../src/chat/chat-conversation-record.ts";
import { safeImageSrc } from "../src/chat/chat-logic.ts";
import {
  isMintedBlobUrl,
  mintBlobUrl,
  pinBlobUrl,
  revokeBlobUrl,
  setBlobBudget,
} from "../src/chat/page-blob-urls.ts";
import { resetThumbnails, useThumbnail } from "../src/chat/thumbnails.ts";
import type { Thumbnail } from "../src/chat/thumbnails.ts";
import { DRAG_IDLE_MS, useFileDrop } from "../src/chat/components/AttachTray.tsx";
import { NO_ATTACHMENTS } from "../src/chat/chat-attachments.ts";
import { fireEvent } from "./dom.ts";
import type { StageHandlers } from "../src/api/files.ts";
import { setFleetTarget } from "../src/api/client.ts";

const TARGET = { instance: "atlas", bot: "scribe", session: null };

interface Fake {
  api: AttachmentsApi;
  calls: { name: string; args: unknown[] }[];
  stages: { upload_id: string; not_secret: boolean; handlers: StageHandlers; closed: boolean }[];
}

function fakeApi(
  picks: { upload_id: string; name: string; size: number }[] = [
    { upload_id: "up_native", name: "n.pdf", size: 9 },
  ],
): Fake {
  const calls: Fake["calls"] = [];
  const stages: Fake["stages"] = [];
  let n = 0;
  const rec =
    <T,>(name: string, answer: (...args: never[]) => T) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return Promise.resolve(answer(...(args as never[])));
    };
  const api: AttachmentsApi = {
    uploadOpen: rec("uploadOpen", () => {
      const upload_id = `up_${++n}`;
      return { upload_id, url: `http://127.0.0.1:1/upload/${upload_id}` };
    }) as never,
    chunkDiscard: rec("chunkDiscard", () => ({ discarded: true })) as never,
    filesCapability: rec("filesCapability", () => ({ files: true, hermeticd_version: "x" })) as never,
    filesDiscard: rec("filesDiscard", () => ({ deleted: true })) as never,
    pickNative: rec("pickNative", () => ({ files: picks })) as never,
    stageUpload: (_instance, upload_id, opts, handlers) => {
      const row = { upload_id, not_secret: opts.not_secret === true, handlers, closed: false };
      stages.push(row);
      calls.push({ name: "stageUpload", args: [upload_id] });
      return () => {
        row.closed = true;
      };
    },
  };
  return { api, calls, stages };
}

function mount(fake: Fake) {
  const records = new Map<string, Conversation>();
  let control: AttachmentsControl | null = null;
  let record: Conversation | null = null;
  let cancelAll: ((instance?: string) => void) | null = null;
  function Probe() {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    const files = useDraftAttachments({
      get: (t) => {
        const k = key(t);
        let r = records.get(k);
        if (!r) records.set(k, (r = fresh(t)));
        return r;
      },
      changed: bump,
      permits: () => true,
      api: fake.api,
    });
    control = files.forTarget(TARGET);
    cancelAll = files.cancelAll;
    record = records.get(key(TARGET)) ?? null;
    return null;
  }
  render(<Probe />);
  return {
    files: () => control!,
    record: () => record!,
    cancelAll: (instance?: string) => cancelAll!(instance),
  };
}

function staged(id: string): Parameters<StageHandlers["onDone"]>[0] {
  return {
    type: "staged",
    file: {
      id,
      dir: "stage",
      class: "file",
      name: "a.bin",
      bytes: 3,
      mime: "application/octet-stream",
      sha256: "0".repeat(64),
      created_at: "2026-10-13T00:00:00Z",
      expires_at: null,
      from: "operator",
    },
  } as never;
}

let restoreFetch: () => void = () => undefined;
beforeEach(() => {
  restoreFetch = stubUploadFetch();
});

afterEach(() => {
  restoreFetch();
  cleanup();
  setBlobBudget(null);
  resetThumbnails();
});

const discarded = (fake: Fake, name = "chunkDiscard") =>
  fake.calls.filter((c) => c.name === name).map((c) => c.args[c.args.length - 1]);

function sent(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    file_id: `f_${from + i}`,
    name: `r${from + i}.txt`,
    size: 1,
    mime: "text/plain",
  }));
}

describe("pure helpers", () => {
  test("chunk offsets step by 1 MiB and an empty file is one chunk", () => {
    const MiB = FILES_LIMITS.chunkBytes;
    expect(chunkOffsets(0)).toEqual([0]);
    expect(chunkOffsets(MiB)).toEqual([0]);
    expect(chunkOffsets(2 * MiB + 1)).toEqual([0, MiB, 2 * MiB]);
  });
  test("base64 round-trips", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(atob(toBase64(bytes))).toBe(String.fromCharCode(...bytes));
  });
  test("refusals read as words", () => {
    expect(attachmentErrorText("FILE_DIGEST_MISMATCH", "", { size: 1, mime: "" })).toBe(
      "Upload corrupted — retry",
    );
    expect(
      attachmentErrorText("FILE_TOO_LARGE", "", { size: 300 * 1024 * 1024, mime: "application/zip" }),
    ).toBe("too large · 300.0 MB > 256 MB");
  });
  test("safeImageSrc takes a blob: URL only while this page holds it", () => {
    const url = mintBlobUrl(new Blob(["x"]));
    expect(safeImageSrc(url)).toBe(url);
    expect(safeImageSrc("blob:https://elsewhere/abc")).toBeNull();
    revokeBlobUrl(url);
    expect(safeImageSrc(url)).toBeNull();
  });
});

describe("the pipeline", () => {
  test("a drop is opened as one streamed upload, staged by its id, and taken by a send", async () => {
    const fake = fakeApi();
    const h = mount(fake);
    const MiB = FILES_LIMITS.chunkBytes;
    const file = new File([new Uint8Array(2 * MiB + 5)], "big.bin");
    act(() => h.files().addFiles([file]));
    expect(h.files().items[0]?.state).toBe("uploading");
    await waitFor(() => expect(fake.stages).toHaveLength(1));
    expect(fake.calls.find((c) => c.name === "uploadOpen")?.args).toEqual(["big.bin", 2 * MiB + 5]);
    expect(fake.calls.some((c) => c.name === "chunkAppend")).toBe(false);
    expect(fake.stages[0]!.upload_id).toBe("up_1");
    expect(summarize(h.files().items)).toEqual({ ready: 0, uploading: 1, failed: 0 });
    act(() => fake.stages[0]!.handlers.onDone(staged("f_one")));
    expect(h.files().items[0]?.state).toBe("staged");
    let sent: ReturnType<AttachmentsControl["take"]> = [];
    act(() => {
      sent = h.files().take();
    });
    expect(sent.map((s) => s.file_id)).toEqual(["f_one"]);
    expect(h.files().items).toHaveLength(0);
    // A send takes the ids; nothing on the box is deleted.
    expect(fake.calls.some((c) => c.name === "filesDiscard")).toBe(false);
    act(() => h.files().restore(sent));
    expect(h.files().items[0]?.file_id).toBe("f_one");
  });

  test("a drop of any size streams, and the eleventh file is a chip that never reaches the bridge", async () => {
    const fake = fakeApi();
    const h = mount(fake);
    const huge = { name: "huge.iso", size: FILES_LIMITS.chunkUploadBytes + 1, type: "" } as File;
    act(() => h.files().addFiles([huge]));
    expect(h.files().items[0]?.state).toBe("uploading");
    const many = Array.from({ length: 10 }, (_, i) => new File(["x"], `f${i}.txt`));
    act(() => h.files().addFiles(many));
    const errors = h.files().items.filter((a) => a.state === "error");
    expect(errors.map((a) => a.error?.message)).toEqual(["max 10 files per message"]);
    expect(fake.calls.filter((c) => c.name === "uploadOpen")).toHaveLength(10);
  });

  test("removing a chip closes its stage, and removing a staged one deletes it on the box", async () => {
    const fake = fakeApi();
    const h = mount(fake);
    act(() => h.files().addFiles([new File(["a"], "a.txt"), new File(["b"], "b.txt")]));
    await waitFor(() => expect(fake.stages).toHaveLength(2));
    const [first, second] = h.files().items;
    act(() => h.files().remove(first!.local_id));
    expect(fake.stages[0]!.closed).toBe(true);
    act(() => fake.stages[1]!.handlers.onDone(staged("f_two")));
    act(() => h.files().remove(second!.local_id));
    expect(fake.calls.find((c) => c.name === "filesDiscard")?.args).toEqual(["atlas", "f_two"]);
    expect(h.files().items).toHaveLength(0);
  });

  test("FILE_LOOKS_SECRET offers Attach anyway, which stages the bytes again with not_secret", async () => {
    const fake = fakeApi();
    const h = mount(fake);
    act(() => h.files().addFiles([new File(["k"], "id_ed25519")]));
    await waitFor(() => expect(fake.stages).toHaveLength(1));
    act(() =>
      fake.stages[0]!.handlers.onDone({ type: "error", code: "FILE_LOOKS_SECRET", message: "x" }),
    );
    const chip = h.files().items[0]!;
    expect(chip.secretOverride).toBe("retry");
    act(() => h.files().retry(chip.local_id, { not_secret: true }));
    await waitFor(() => expect(fake.stages).toHaveLength(2));
    expect(fake.stages[1]!.not_secret).toBe(true);
  });

  test("a native pick stages its upload id without sending bytes", async () => {
    const fake = fakeApi();
    const h = mount(fake);
    act(() => h.files().pick());
    await waitFor(() => expect(fake.stages).toHaveLength(1));
    expect(fake.stages[0]!.upload_id).toBe("up_native");
    expect(fake.calls.some((c) => c.name === "chunkAppend")).toBe(false);
  });

  test("an upload is freed in the main process when its chip is removed mid-stage or its stage fails", async () => {
    const fake = fakeApi();
    const h = mount(fake);
    act(() => h.files().addFiles([new File(["a"], "a.txt"), new File(["b"], "b.txt")]));
    await waitFor(() => expect(fake.stages).toHaveLength(2));
    // Removed while the box is staging it: the stage closes and the upload is freed.
    act(() => h.files().remove(h.files().items[0]!.local_id));
    expect(fake.stages[0]!.closed).toBe(true);
    expect(discarded(fake)).toEqual(["up_1"]);
    // A stage the box refused leaves the upload held; the chip lets go of it.
    act(() =>
      fake.stages[1]!.handlers.onDone({ type: "error", code: "DISK_FULL", message: "full" } as never),
    );
    expect(discarded(fake)).toEqual(["up_1", "up_2"]);
    // A successful stage consumed its upload: nothing to free.
    act(() => h.files().retry(h.files().items[0]!.local_id));
    await waitFor(() => expect(fake.stages).toHaveLength(3));
    act(() => fake.stages[2]!.handlers.onDone(staged("f_b")));
    act(() => h.files().remove(h.files().items[0]!.local_id));
    expect(discarded(fake)).toEqual(["up_1", "up_2"]);
  });

  test("files over the cap are one chip, not one per file", () => {
    const fake = fakeApi();
    const h = mount(fake);
    const many = Array.from({ length: 13 }, (_, i) => new File(["x"], `f${i}.txt`));
    act(() => h.files().addFiles(many));
    const limits = h.files().items.filter((a) => a.error?.code === "LIMIT");
    expect(limits.map((a) => a.name)).toEqual(["3 more files not attached"]);
    act(() => h.files().addFiles([new File(["y"], "late.txt")]));
    expect(
      h
        .files()
        .items.filter((a) => a.error?.code === "LIMIT")
        .map((a) => a.name),
    ).toEqual(["4 more files not attached"]);
  });

  test("restore fills only the room left; the rest are one chip that deletes them on the box", () => {
    const fake = fakeApi();
    const h = mount(fake);
    act(() => h.files().restore(sent(7)));
    act(() => h.files().restore(sent(5, 7)));
    const items = h.files().items;
    expect(items.filter((a) => a.state === "staged")).toHaveLength(10);
    const limit = items.find((a) => a.error?.code === "LIMIT")!;
    expect(limit.name).toBe("2 more files not attached");
    expect(limit.dropped).toEqual(["f_10", "f_11"]);
    act(() => h.files().remove(limit.local_id));
    expect(discarded(fake, "filesDiscard")).toEqual(["f_10", "f_11"]);
    expect(h.files().items).toHaveLength(10);
  });

  test("Pick again, attach anyway vouches only for the flagged file", async () => {
    const fake = fakeApi([
      { upload_id: "up_key", name: "id_ed25519", size: 9 },
      { upload_id: "up_other", name: "other.pem", size: 4 },
    ]);
    const h = mount(fake);
    act(() => h.files().pick());
    await waitFor(() => expect(fake.stages).toHaveLength(2));
    act(() =>
      fake.stages[0]!.handlers.onDone({ type: "error", code: "FILE_LOOKS_SECRET", message: "x" }),
    );
    const flagged = h.files().items.find((a) => a.secretOverride === "repick")!;
    act(() => h.files().retry(flagged.local_id, { not_secret: true }));
    await waitFor(() => expect(fake.stages).toHaveLength(4));
    expect(fake.stages.slice(2).map((s) => [s.upload_id, s.not_secret])).toEqual([
      ["up_key", true],
      ["up_other", false],
    ]);
  });
});

/**
 * The native dialog answers whenever the operator is done with it. By then the
 * store that opened it may be gone (`cancelAll` on the provider's unmount, which
 * is also what a fleet switch does) or the window may be on another fleet:
 * either way its picks are discarded in the main process and nothing is staged.
 */
describe("a native dialog that answers late", () => {
  const MAIN = { account_id: "123456789012", region: "us-east-1", fleet_id: "fxtr0001" };
  const STAGING = { account_id: "123456789012", region: "us-east-1", fleet_id: "sg7k2m4p" };
  const LATE = [
    { upload_id: "up_late", name: "private.pdf", size: 9 },
    { upload_id: "up_late2", name: "notes.txt", size: 3 },
  ];

  afterEach(() => setFleetTarget(null));

  /** A bridge whose `pickNative` waits for the test to answer or fail it. */
  function deferred() {
    const fake = fakeApi();
    let answer!: (files: typeof LATE) => void;
    let refuse!: (e: Error) => void;
    const pending = new Promise<{ files: typeof LATE }>((resolve, reject) => {
      answer = (files) => resolve({ files });
      refuse = reject;
    });
    fake.api.pickNative = ((instance: string) => {
      fake.calls.push({ name: "pickNative", args: [instance] });
      return pending;
    }) as never;
    const settle = async (run: () => void) => {
      await act(async () => {
        run();
        await pending.catch(() => undefined);
        await Promise.resolve();
      });
    };
    return { fake, answer, refuse, settle };
  }

  test("a pick still open when the store is torn down stages nothing and frees its uploads", async () => {
    setFleetTarget(MAIN);
    const { fake, answer, settle } = deferred();
    const h = mount(fake);
    const record = h.record();
    act(() => h.files().pick());
    expect(fake.calls.filter((c) => c.name === "pickNative").length).toBe(1);
    act(() => h.cancelAll());
    cleanup();
    await settle(() => answer(LATE));
    expect(fake.stages.length).toBe(0);
    expect(discarded(fake)).toEqual(["up_late", "up_late2"]);
    expect(record.attachments.length).toBe(0);
  });

  test("a pick that answers after the window moved to another fleet stages nothing", async () => {
    setFleetTarget(MAIN);
    const { fake, answer, settle } = deferred();
    const h = mount(fake);
    act(() => h.files().pick());
    setFleetTarget(STAGING);
    await settle(() => answer(LATE));
    expect(fake.stages.length).toBe(0);
    expect(discarded(fake)).toEqual(["up_late", "up_late2"]);
    expect(h.record().attachments.length).toBe(0);
  });

  test("cancelling one instance abandons its pick; a failed dialog then adds no chip", async () => {
    setFleetTarget(MAIN);
    const { fake, refuse, settle } = deferred();
    const h = mount(fake);
    act(() => h.files().pick());
    act(() => h.cancelAll("atlas"));
    await settle(() => refuse(Object.assign(new Error("dialog failed"), { code: "INTERNAL" })));
    expect(fake.stages.length).toBe(0);
    expect(h.record().attachments.length).toBe(0);
  });

  test("a pick on the same fleet, with another instance cancelled, still stages", async () => {
    setFleetTarget(MAIN);
    const { fake, answer, settle } = deferred();
    const h = mount(fake);
    act(() => h.files().pick());
    act(() => h.cancelAll("orca"));
    await settle(() => answer(LATE));
    expect(fake.stages.map((s) => s.upload_id)).toEqual(["up_late", "up_late2"]);
    expect(discarded(fake)).toEqual([]);
  });
});

describe("blob URLs and thumbnails", () => {
  test("a pinned URL survives the budget; the oldest unpinned one goes, by count and by bytes", () => {
    setBlobBudget({ urls: 2, bytes: 1_000 });
    const a = mintBlobUrl(new Blob(["a"]));
    const release = pinBlobUrl(a);
    const b = mintBlobUrl(new Blob(["b"]));
    const c = mintBlobUrl(new Blob(["c"]));
    expect([isMintedBlobUrl(a), isMintedBlobUrl(b), isMintedBlobUrl(c)]).toEqual([true, false, true]);
    release();
    // Back under the count with `a` let go, nothing else goes.
    expect(isMintedBlobUrl(a)).toBe(true);
    setBlobBudget({ urls: 10, bytes: 10 });
    const big = mintBlobUrl(new Blob(["0123456789"]));
    expect([isMintedBlobUrl(a), isMintedBlobUrl(c), isMintedBlobUrl(big)]).toEqual([
      false,
      false,
      true,
    ]);
    revokeBlobUrl(big);
  });

  test("a chip on screen keeps its picture under pressure, and a failed read is tried again", async () => {
    resetThumbnails({ failedRetryMs: 30 });
    setBlobBudget({ urls: 1, bytes: 1_000 });
    let reads = 0;
    const read = (async () => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error("unreachable"), { code: "INTERNAL" });
      return { mime: "image/png", data_b64: btoa("png") };
    }) as never;
    let thumb: Thumbnail | null = null;
    function Chip() {
      thumb = useThumbnail("atlas", "f_img", "fleet1", read);
      return null;
    }
    render(<Chip />);
    // The first read fails; the chip asks again once the retry delay passes.
    await waitFor(() => expect(thumb?.state).toBe("ready"));
    expect(reads).toBe(2);
    const url = (thumb as unknown as { url: string }).url;
    // Another mint would evict it were it not pinned by the mounted chip.
    const other = mintBlobUrl(new Blob(["x"]));
    expect(isMintedBlobUrl(url)).toBe(true);
    expect(isMintedBlobUrl(other)).toBe(true);
    cleanup();
    // Unmounted, the pin is gone and the over-budget registry lets it go.
    expect(isMintedBlobUrl(url)).toBe(false);
  });
});

describe("the drop overlay", () => {
  const files = { types: ["Files"], files: [] };
  function Pane() {
    const drop = useFileDrop(NO_ATTACHMENTS, "atlas");
    return (
      <div data-testid="pane" {...drop.handlers}>
        {drop.overlay}
      </div>
    );
  }
  const shown = () => document.querySelector(".ch-drop") !== null;

  test("goes on a window dragend even when the hovered node never sent its leave", () => {
    const { getByTestId } = render(<Pane />);
    fireEvent.dragEnter(getByTestId("pane"), { dataTransfer: files });
    expect(shown()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("dragend"));
    });
    expect(shown()).toBe(false);
  });

  test("goes when dragover stops firing", async () => {
    const { getByTestId } = render(<Pane />);
    fireEvent.dragEnter(getByTestId("pane"), { dataTransfer: files });
    fireEvent.dragOver(getByTestId("pane"), { dataTransfer: files });
    expect(shown()).toBe(true);
    await waitFor(() => expect(shown()).toBe(false), { timeout: DRAG_IDLE_MS + 1_000 });
  });
});
