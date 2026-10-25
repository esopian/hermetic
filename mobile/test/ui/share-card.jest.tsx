/**
 * Files the agent shared (`blocks/ShareCard.tsx`): a `share_file` call and a
 * `MEDIA:` chip naming the outbox both draw one card — tag, name, size, short
 * sha, retention, Save — an image share shows its picture, a refused share
 * shows the box's words, and Save brings the bytes onto the phone and opens
 * the share sheet.
 */
import { act, fireEvent, screen } from "@testing-library/react-native";
import { Share } from "react-native";
import type { ChatBlock, ToolBlock } from "@hermetic/core/chat-client";
import { sha256Hex } from "@hermetic/core/shared";
import { Block } from "../../src/chat/blocks/Block.tsx";
import { saveBoxFile } from "../../src/chat/blocks/save-box-file.ts";
import { clearBoxImageCache } from "../../src/chat/blocks/use-box-file.ts";
import { sections } from "../../src/client/chat-activity.ts";
import type { PhoneFiles } from "../../src/gateway/files.ts";
import { flush } from "../helpers/fakes.ts";
import { tool } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const mockWritten: { name: string; bytes: Uint8Array }[] = [];
jest.mock("expo-file-system", () => ({
  Paths: { cache: "/cache" },
  File: class {
    name: string;
    exists = false;
    constructor(_dir: string, name: string) {
      this.name = name;
    }
    get uri() {
      return `file:///cache/${this.name}`;
    }
    create() {}
    delete() {}
    write(bytes: Uint8Array) {
      mockWritten.push({ name: this.name, bytes });
    }
  },
}));

const CSV = new TextEncoder().encode("month,revenue\n2026-09,207400\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const WAV = new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ");
const WAV_FILE = { id: "sh_fxphone00002", bytes: WAV, name: "recap.wav", mime: "audio/wav" };

function fakeFiles(fail?: string) {
  const content = jest.fn(async (id: string) => {
    if (fail) throw Object.assign(new Error(`${fail}: the box refused`), { code: fail });
    const [bytes, mime] =
      id === "sh_fxphone00000"
        ? [PNG, "image/png"]
        : id === WAV_FILE.id
          ? [WAV, "audio/wav"]
          : [CSV, "text/csv"];
    return { bytes, mime, sha256: sha256Hex(bytes) };
  });
  return { files: { content } as unknown as PhoneFiles, content };
}

function shareTool(
  over: Partial<ToolBlock> = {},
  file = { id: "sh_fxphone00001", bytes: CSV, name: "q3-revenue.csv", mime: "text/csv" },
): ToolBlock {
  const share = {
    share_id: file.id,
    name: file.name,
    bytes: file.bytes.byteLength,
    mime: file.mime,
    sha256: sha256Hex(file.bytes),
  };
  return tool({
    tool_id: `tl-${file.id}`,
    name: "share_file",
    args: { path: `/data/hermes/work/${file.name}`, note: "the numbers" },
    status: "ok",
    render: "file_share",
    result: JSON.stringify(share),
    share,
    ...over,
  });
}

async function draw(block: ChatBlock, files: PhoneFiles | null) {
  await renderUi(<Block block={block} now={NOW} />, scope({ files }));
  await act(flush);
}

beforeEach(() => {
  clearBoxImageCache();
  mockWritten.length = 0;
});

describe("the transcript's split", () => {
  test("a share stands alone instead of folding into Tools complete", () => {
    const list = sections([
      tool({ tool_id: "a", status: "ok" }),
      shareTool(),
      tool({ tool_id: "b", status: "ok" }),
    ]);
    expect(list.map((s) => [s.activity, s.blocks.length])).toEqual([
      [true, 1],
      [false, 1],
      [true, 1],
    ]);
  });

  test("a running share is still a step", () => {
    const running = shareTool({ status: "running", share: null, result: null });
    expect(sections([running])[0]?.activity).toBe(true);
  });
});

describe("share card", () => {
  test("name, size, short sha, how long the box keeps it, and Save", async () => {
    const { files } = fakeFiles();
    await draw(shareTool(), files);
    expect(screen.getByText("q3-revenue.csv")).toBeTruthy();
    expect(screen.getByText("CSV")).toBeTruthy();
    const sha = sha256Hex(CSV).slice(0, 4);
    expect(screen.getByText(new RegExp(`sha ${sha}… · on box 24 h$`))).toBeTruthy();
    expect(screen.getByLabelText("Save q3-revenue.csv")).toBeTruthy();
    // A file that is not an image is never fetched to be drawn.
    expect(screen.queryByTestId("picture-image")).toBeNull();
  });

  test("an image share shows its picture, fetched from the box", async () => {
    const { files, content } = fakeFiles();
    await draw(
      shareTool({}, { id: "sh_fxphone00000", bytes: PNG, name: "q3-revenue.png", mime: "image/png" }),
      files,
    );
    expect(content).toHaveBeenCalledWith("sh_fxphone00000", expect.anything());
    expect(screen.getByTestId("picture-image").props.source.uri).toMatch(/^data:image\/png;base64,/);
  });

  test("Save writes the digest-checked bytes to the cache and opens the share sheet", async () => {
    const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
    const { files, content } = fakeFiles();
    await draw(shareTool(), files);
    await fireEvent.press(screen.getByLabelText("Save q3-revenue.csv"));
    await act(flush);
    expect(content).toHaveBeenCalledWith("sh_fxphone00001", { maxBytes: expect.any(Number) });
    expect(mockWritten).toEqual([{ name: "sh_fxphone00001-q3-revenue.csv", bytes: CSV }]);
    expect(share).toHaveBeenCalledWith({ url: "file:///cache/sh_fxphone00001-q3-revenue.csv" });
    expect(screen.getByText("✓ ready to save · q3-revenue.csv")).toBeTruthy();
    share.mockRestore();
  });

  test("a share the box no longer holds says so and disables Save", async () => {
    const { files } = fakeFiles("FILE_NOT_FOUND");
    await draw(shareTool(), files);
    await fireEvent.press(screen.getByLabelText("Save q3-revenue.csv"));
    await act(flush);
    expect(screen.getByText(/no longer on the box/)).toBeTruthy();
    expect(screen.getByLabelText("Save q3-revenue.csv").props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  test("another refusal is said under the card", async () => {
    const { files } = fakeFiles("FILE_DIGEST_MISMATCH");
    await draw(shareTool(), files);
    await fireEvent.press(screen.getByLabelText("Save q3-revenue.csv"));
    await act(flush);
    expect(screen.getByText(/^not saved — /)).toBeTruthy();
  });

  test("a text share opens its contents behind Preview, read under the text cap", async () => {
    const { files, content } = fakeFiles();
    await draw(shareTool(), files);
    expect(content).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Preview q3-revenue.csv"));
    await act(flush);
    expect(content).toHaveBeenCalledWith("sh_fxphone00001", {
      signal: expect.anything(),
      maxBytes: 256 * 1024,
    });
    expect(screen.getByText(/2026-09,207400/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Hide q3-revenue.csv"));
    expect(screen.queryByText(/2026-09,207400/)).toBeNull();
  });

  test("an audio share plays from the cache directory once Play is tapped", async () => {
    const { files, content } = fakeFiles();
    await draw(shareTool({}, WAV_FILE), files);
    expect(content).not.toHaveBeenCalled();
    expect(screen.queryByTestId("share-player")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Play recap.wav"));
    await act(flush);
    expect(mockWritten).toEqual([{ name: "sh_fxphone00002-recap.wav", bytes: WAV }]);
    expect(screen.getByTestId("share-player")).toBeTruthy();
  });

  test("a share too large to play says to Save it instead", async () => {
    const { files } = fakeFiles("FILE_TOO_LARGE");
    await draw(shareTool({}, WAV_FILE), files);
    await fireEvent.press(screen.getByLabelText("Play recap.wav"));
    await act(flush);
    expect(screen.getByText("too large to play here — Save instead")).toBeTruthy();
    expect(screen.queryByTestId("share-player")).toBeNull();
  });

  test("without a files client the card is read-only", async () => {
    await draw(shareTool(), null);
    expect(screen.getByLabelText("Save q3-revenue.csv").props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  test("a refused share is the box's words, not a card", async () => {
    await draw(
      shareTool({ status: "bad", share: null, result: "share refused: credential path" }),
      fakeFiles().files,
    );
    expect(screen.getByText("share refused: credential path")).toBeTruthy();
    expect(screen.queryByLabelText(/^Save /)).toBeNull();
  });
});

describe("MEDIA: outbox chip", () => {
  test("is the same card, from what the chip carries", async () => {
    await draw(
      {
        kind: "attachment",
        name: "q3-revenue.csv",
        mime: "text/csv",
        bytes: CSV.byteLength,
        href: "outbox/sh_fxphone00001/q3-revenue.csv",
        file_id: "sh_fxphone00001",
        sha256: sha256Hex(CSV),
      },
      fakeFiles().files,
    );
    expect(screen.getByTestId("share-sh_fxphone00001")).toBeTruthy();
    expect(screen.getByLabelText("Save q3-revenue.csv")).toBeTruthy();
  });
});

describe("saveBoxFile", () => {
  test("names the cached copy by share id, so two shares with one name never collide", async () => {
    const { files } = fakeFiles();
    const write = jest.fn((name: string) => `file:///c/${name}`);
    const share = jest.fn(async () => undefined);
    await saveBoxFile(files, "sh_fxphone00001", "a/b.csv", { write, share });
    expect(write).toHaveBeenCalledWith("sh_fxphone00001-a_b.csv", CSV);
    expect(share).toHaveBeenCalledWith("file:///c/sh_fxphone00001-a_b.csv");
  });
});
