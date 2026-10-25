/** How a share card views each kind of file (`src/client/share-logic.ts`), as the desktop card does. */
import { sharePurpose, shareToggleLabel, shareView } from "../../src/client/share-logic.ts";

const ID = "sh_fxphone00001";

describe("shareView", () => {
  test.each([
    ["image/png", "image"],
    ["audio/wav", "audio"],
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
    ["video/webm", null],
    ["audio/ogg", null],
    ["text/markdown; charset=utf-8", "text"],
    ["application/json", "text"],
    ["application/x-pem-file", null],
    ["application/zip", null],
    ["video/x-matroska", null],
  ])("%s → %s", (mime, view) => {
    expect(shareView(mime, ID)).toBe(view);
  });

  test("an id that is not an outbox share is never fetched to be viewed", () => {
    expect(shareView("image/png", "not-a-share")).toBeNull();
  });
});

describe("shareToggleLabel", () => {
  test("text opens behind Preview, audio and video behind Play, and either closes with Hide", () => {
    expect(shareToggleLabel("text", false)).toBe("Preview");
    expect(shareToggleLabel("audio", false)).toBe("Play");
    expect(shareToggleLabel("video", false)).toBe("Play");
    expect(shareToggleLabel("video", true)).toBe("Hide");
  });

  test("an image and a plain file have no toggle", () => {
    expect(shareToggleLabel("image", false)).toBeNull();
    expect(shareToggleLabel(null, false)).toBeNull();
  });
});

test("sharePurpose names the read's cap", () => {
  expect(sharePurpose("image")).toBe("image");
  expect(sharePurpose("text")).toBe("text");
  expect(sharePurpose("audio")).toBe("playback");
  expect(sharePurpose("video")).toBe("playback");
});
