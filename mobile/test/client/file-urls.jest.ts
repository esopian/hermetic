/**
 * Where a transcript picture may come from (`src/client/file-urls.ts`), and
 * the markdown image split (`markdown-images.ts`): a file on the
 * conversation's box or an `https:` image, and nothing else.
 */
import {
  base64,
  boxFileIdOf,
  dataUri,
  fileContentUrl,
  imageSourceOf,
  classifyImageUrl,
  toolImageHref,
  toolImageSource,
} from "../../src/client/file-urls.ts";
import { parseMarkdown } from "../../src/client/markdown.ts";
import { hasImage, splitImages } from "../../src/client/markdown-images.ts";

describe("fileContentUrl", () => {
  test("is hermeticd's content route on the box's tailnet port", () => {
    expect(fileContentUrl("fxtr0001-atlas.hermetic.ts.net", "f_fxqueuedpth1")).toBe(
      "http://fxtr0001-atlas.hermetic.ts.net:7434/files/f_fxqueuedpth1/content",
    );
    expect(fileContentUrl("fd7a::1", "sh_fxphone00000")).toBe(
      "http://[fd7a::1]:7434/files/sh_fxphone00000/content",
    );
  });
});

describe("boxFileIdOf", () => {
  test.each([
    ["f_fxqueuedpth1", "f_fxqueuedpth1"],
    ["sh_kestreltime1", "sh_kestreltime1"],
    ["/files/f_fxqueuedpth1/content", "f_fxqueuedpth1"],
    ["/files/sh_kestreltime1/content?x=1", "sh_kestreltime1"],
  ])("%s names %s", (ref, id) => {
    expect(boxFileIdOf(ref)).toBe(id);
  });

  test.each([
    "/files/../etc/passwd/content",
    "/files/f_short/content",
    "/files/f_fxqueuedpth1",
    "files/f_fxqueuedpth1/content",
    "http://evil.example:7434/files/f_fxqueuedpth1/content",
    "fr_fxphone00001",
    "",
  ])("%s names nothing", (ref) => {
    expect(boxFileIdOf(ref)).toBeNull();
  });
});

describe("classifyImageUrl / imageSourceOf", () => {
  test("a box file is box (load at once), an https image external with its host (load on a tap)", () => {
    expect(classifyImageUrl("/files/f_fxqueuedpth1/content")).toEqual({
      kind: "box",
      id: "f_fxqueuedpth1",
    });
    expect(classifyImageUrl("sh_kestreltime1")).toEqual({ kind: "box", id: "sh_kestreltime1" });
    expect(classifyImageUrl("https://cdn.example.com/a.png?x=1")).toEqual({
      kind: "external",
      uri: "https://cdn.example.com/a.png?x=1",
      host: "cdn.example.com",
    });
    expect(imageSourceOf("https://example.com/a.png")?.kind).toBe("external");
  });

  test.each([
    "http://example.com/a.png",
    "//example.com/a.png",
    "/api/chat/attachments/fixture/queue-depth.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://",
    "https:// spaced.example/a.png",
    "a.png",
    "",
    null,
    undefined,
  ])("%s is refused", (url) => {
    expect(classifyImageUrl(url)).toEqual({ kind: "refused" });
    expect(imageSourceOf(url)).toBeNull();
  });
});

describe("toolImageSource", () => {
  test("a file_id on the box wins over a portal href", () => {
    expect(
      toolImageSource({
        href: "/api/chat/attachments/fixture/granite-grafana.png",
        file_id: "f_fxgrafana001",
      }),
    ).toEqual({ kind: "box", id: "f_fxgrafana001" });
  });

  test("an https href or url, or the result itself", () => {
    expect(toolImageSource({ url: "https://example.com/s.png" })).toEqual({
      kind: "external",
      uri: "https://example.com/s.png",
      host: "example.com",
    });
    expect(toolImageSource("/files/f_fxqueuedpth1/content")).toEqual({
      kind: "box",
      id: "f_fxqueuedpth1",
    });
  });

  test("a portal path or nothing names no picture, and the href is kept for the line", () => {
    const portal = { href: "/api/chat/attachments/fixture/granite-grafana.png" };
    expect(toolImageSource(portal)).toBeNull();
    expect(toolImageHref(portal)).toBe(portal.href);
    expect(toolImageSource(null)).toBeNull();
    expect(toolImageHref({})).toBeNull();
  });
});

describe("base64 / dataUri", () => {
  test("matches the engine's encoding, padding included", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      expect(base64(new TextEncoder().encode(text))).toBe(Buffer.from(text).toString("base64"));
    }
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(dataUri("image/png", new Uint8Array([1, 2, 3]))).toBe("data:image/png;base64,AQID");
  });
});

describe("splitImages", () => {
  const spansOf = (md: string) => {
    const node = parseMarkdown(md)[0];
    if (node?.type !== "p") throw new Error("not a paragraph");
    return node.spans;
  };

  test("cuts a paragraph around each image", () => {
    const spans = spansOf("Before ![the chart](/files/f_fxqueuedpth1/content) after");
    expect(hasImage(spans)).toBe(true);
    expect(splitImages(spans)).toEqual([
      { kind: "spans", spans: [{ type: "text", text: "Before " }] },
      { kind: "image", alt: "the chart", href: "/files/f_fxqueuedpth1/content" },
      { kind: "spans", spans: [{ type: "text", text: " after" }] },
    ]);
  });

  test("an image alone is one piece; a link after '! ' stays a link", () => {
    expect(splitImages(spansOf("![x](https://e.com/a.png)"))).toEqual([
      { kind: "image", alt: "x", href: "https://e.com/a.png" },
    ]);
    const plain = spansOf("Wow! [docs](https://e.com)");
    expect(hasImage(plain)).toBe(false);
    expect(splitImages(plain)).toEqual([{ kind: "spans", spans: plain }]);
  });
});
