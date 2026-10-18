/**
 * Pictures in the transcript (`blocks/Picture.tsx`, `ImageViewer.tsx`): an
 * image attachment's thumbnail, a markdown image, a tool's screenshot, each
 * loaded from the conversation's box through the files client, and the
 * full-screen viewer a tap opens.
 */
import { act, fireEvent, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ChatBlock } from "@hermetic/core/chat-client";
import { sha256Hex } from "@hermetic/core/shared";
import { Block } from "../../src/chat/blocks/Block.tsx";
import { clearBoxImageCache } from "../../src/chat/blocks/use-box-file.ts";
import type { PhoneFiles } from "../../src/gateway/files.ts";
import { flush } from "../helpers/fakes.ts";
import { tool } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

/** A few bytes with a PNG signature: `Image` is not decoded under jest. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeFiles(mime = "image/png", fail?: { code: string }) {
  const content = jest.fn(async (_id: string) => {
    if (fail) throw Object.assign(new Error(fail.code), { code: fail.code });
    return { bytes: PNG, mime, sha256: sha256Hex(PNG) };
  });
  const files = { content } as unknown as PhoneFiles;
  return { files, content };
}

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function draw(block: ChatBlock, files: PhoneFiles | null) {
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <Block block={block} now={NOW} />
    </SafeAreaProvider>,
    scope({ files }),
  );
  await act(flush);
}

const imageUri = (): string => {
  const image = screen.getAllByTestId("picture-image")[0];
  return (image?.props.source as { uri: string } | undefined)?.uri ?? "";
};

beforeEach(() => clearBoxImageCache());

describe("attachment", () => {
  test("an image on the box: a thumbnail from its bytes above the chip", async () => {
    const { files, content } = fakeFiles();
    await draw(
      {
        kind: "attachment",
        name: "queue-depth.png",
        mime: "image/png",
        bytes: PNG.byteLength,
        href: "inbox/2026-09-17/f_fxqueuedpth1/queue-depth.png",
        file_id: "f_fxqueuedpth1",
        sha256: sha256Hex(PNG),
      },
      files,
    );
    expect(content).toHaveBeenCalledWith("f_fxqueuedpth1", expect.anything());
    expect(screen.getByLabelText("Open queue-depth.png")).toBeTruthy();
    expect(imageUri()).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByText("queue-depth.png")).toBeTruthy();
  });

  test("a picture whose bytes do not match the chip's sha256 is withheld", async () => {
    const { files } = fakeFiles();
    await draw(
      {
        kind: "attachment",
        name: "chart.png",
        mime: "image/png",
        bytes: 3,
        href: "inbox/x/f_fxqueuedpth1/chart.png",
        file_id: "f_fxqueuedpth1",
        sha256: "0".repeat(64),
      },
      files,
    );
    expect(screen.getByText(/preview withheld/)).toBeTruthy();
    expect(screen.queryAllByTestId("picture-image")).toHaveLength(0);
  });

  test("a file the box no longer has says so", async () => {
    await draw(
      {
        kind: "attachment",
        name: "old.png",
        mime: "image/png",
        bytes: 3,
        href: "inbox/x/f_fxqueuedpth1/old.png",
        file_id: "f_fxqueuedpth1",
      },
      fakeFiles("image/png", { code: "FILE_NOT_FOUND" }).files,
    );
    expect(screen.getByText(/no longer on the box/)).toBeTruthy();
  });

  test("a non-image attachment fetches nothing", async () => {
    const { files, content } = fakeFiles();
    await draw(
      {
        kind: "attachment",
        name: "notes.md",
        mime: "text/markdown",
        bytes: 10,
        href: "inbox/x/f_fxiostat0917/notes.md",
        file_id: "f_fxiostat0917",
      },
      files,
    );
    expect(content).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("picture-image")).toHaveLength(0);
  });
});

describe("markdown image", () => {
  test("a box image is drawn between the words with its alt as a caption", async () => {
    const { files, content } = fakeFiles();
    await draw(
      {
        kind: "text",
        markdown: "Here it is:\n\n![Queue depth](/files/f_fxqueuedpth1/content)\n\nDone.",
      },
      files,
    );
    expect(content).toHaveBeenCalledWith("f_fxqueuedpth1", expect.anything());
    expect(screen.getByText("Queue depth")).toBeTruthy();
    expect(screen.getByText("Here it is:")).toBeTruthy();
    expect(imageUri()).toMatch(/^data:image\/png;base64,/);
  });

  test("an https image is a placeholder naming its host, fetched only after Load image", async () => {
    const { files, content } = fakeFiles();
    await draw(
      {
        kind: "text",
        markdown:
          "![web chart](https://cdn.example.com/a.png?q=1) and ![sneaky](http://evil.example/x.png?leak=1)",
      },
      files,
    );
    expect(content).not.toHaveBeenCalled();
    // Nothing is fetched on render: no image element at all, only the placeholder.
    expect(screen.queryAllByTestId("picture-image")).toHaveLength(0);
    expect(screen.getByTestId("picture-external")).toBeTruthy();
    expect(screen.getByText("cdn.example.com")).toBeTruthy();
    expect(screen.getByText("web chart · image not fetched — not served by the box")).toBeTruthy();
    // Refused outright: its alt text, and the URL nowhere in the tree.
    expect(screen.getByText("image not loaded · sneaky")).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).not.toContain("evil.example/x.png");

    await fireEvent.press(screen.getByLabelText("Load image from cdn.example.com"));
    await act(flush);
    expect(screen.queryByTestId("picture-external")).toBeNull();
    expect(imageUri()).toBe("https://cdn.example.com/a.png?q=1");
    expect(content).not.toHaveBeenCalled();
  });

  test("the tap is per block: a second external image stays a placeholder", async () => {
    await draw(
      {
        kind: "text",
        markdown: "![one](https://a.example/1.png)\n\n![two](https://b.example/2.png)",
      },
      fakeFiles().files,
    );
    await fireEvent.press(screen.getByLabelText("Load image from a.example"));
    await act(flush);
    expect(screen.getAllByTestId("picture-image")).toHaveLength(1);
    expect(screen.getAllByTestId("picture-external")).toHaveLength(1);
    expect(screen.getByLabelText("Load image from b.example")).toBeTruthy();
  });
});

describe("tool image and screenshot", () => {
  test("an external screenshot URL waits for Load image", async () => {
    const { files, content } = fakeFiles();
    await draw(
      tool({
        name: "browser.screenshot",
        status: "ok",
        render: "screenshot",
        result: { url: "https://shots.example.net/s.png" },
      }),
      files,
    );
    await fireEvent.press(screen.getByRole("button"));
    expect(screen.queryAllByTestId("picture-image")).toHaveLength(0);
    expect(screen.getByText("shots.example.net")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Load image from shots.example.net"));
    await act(flush);
    expect(imageUri()).toBe("https://shots.example.net/s.png");
    expect(content).not.toHaveBeenCalled();
  });

  test("a screenshot naming a file on the box is drawn once the card is opened", async () => {
    const { files } = fakeFiles();
    await draw(
      tool({
        name: "browser.screenshot",
        status: "ok",
        render: "screenshot",
        result: {
          href: "/api/chat/attachments/fixture/granite-grafana.png",
          file_id: "f_fxgrafana001",
        },
      }),
      files,
    );
    await fireEvent.press(screen.getByRole("button"));
    await act(flush);
    expect(screen.getByLabelText("Open browser.screenshot")).toBeTruthy();
    expect(imageUri()).toMatch(/^data:image\/png;base64,/);
  });

  test("an image result naming only a portal path is named, not fetched", async () => {
    const { files, content } = fakeFiles();
    await draw(
      tool({
        name: "image.generate",
        status: "ok",
        render: "image",
        result: { href: "/api/chat/attachments/fixture/queue-depth.png" },
      }),
      files,
    );
    await fireEvent.press(screen.getByRole("button"));
    expect(content).not.toHaveBeenCalled();
    expect(screen.getByText(/image not fetched — \/api\/chat\/attachments/)).toBeTruthy();
  });
});

describe("viewer", () => {
  test("a tap opens the picture full screen; Close shuts it", async () => {
    const { files } = fakeFiles();
    await draw(
      {
        kind: "attachment",
        name: "queue-depth.png",
        mime: "image/png",
        bytes: PNG.byteLength,
        href: "inbox/x/f_fxqueuedpth1/queue-depth.png",
        file_id: "f_fxqueuedpth1",
      },
      files,
    );
    expect(screen.queryByTestId("image-viewer")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Open queue-depth.png"));
    expect(screen.getByTestId("image-viewer")).toBeTruthy();
    expect(screen.getByLabelText("Close image")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Close image"));
    expect(screen.queryByTestId("image-viewer")).toBeNull();
  });
});
