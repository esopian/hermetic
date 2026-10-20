import { base64 } from "../../src/client/file-urls.ts";
import { decodeDataUri, fromBase64, pasteAttachments, pastedName } from "../../src/client/paste.ts";

const AT = new Date("2026-10-13T12:00:00.123Z");

function writer() {
  const written = new Map<string, Uint8Array>();
  const write = jest.fn(async (name: string, bytes: Uint8Array) => {
    written.set(name, bytes);
    return `file:///cache/${name}`;
  });
  return { written, write };
}

describe("pasteAttachments", () => {
  test("a clipboard image is one picked image entry, written to the cache with its bytes", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
    const { written, write } = writer();
    const items = await pasteAttachments(
      { type: "image", data: `data:image/jpeg;base64,${base64(jpeg)}`, size: { width: 1, height: 1 } },
      write,
      () => AT,
    );
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      name: "pasted-20261013120000123.jpg",
      uri: "file:///cache/pasted-20261013120000123.jpg",
      mime: "image/jpeg",
      kind: "image",
      size: jpeg.byteLength,
      status: "picked",
    });
    expect(item?.local_id).toMatch(/^att\d+$/);
    expect([...(written.get("pasted-20261013120000123.jpg") ?? [])]).toEqual([...jpeg]);
  });

  test("a PNG keeps its type and extension", async () => {
    const { write } = writer();
    const [item] = await pasteAttachments(
      {
        type: "image",
        data: `data:image/png;base64,${base64(new Uint8Array([0x89, 0x50]))}`,
        size: { width: 1, height: 1 },
      },
      write,
      () => AT,
    );
    expect([item?.mime, item?.kind, item?.name.endsWith(".png")]).toEqual(["image/png", "image", true]);
  });

  test("a text paste adds nothing and writes nothing (the field pastes text itself)", async () => {
    const { write } = writer();
    expect(await pasteAttachments({ type: "text", text: "hello" }, write)).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  test("data that does not decode adds nothing", async () => {
    const { write } = writer();
    for (const data of ["not a uri", "data:image/png;base64,", "data:image/png;base64,@@@@"])
      expect(
        await pasteAttachments({ type: "image", data, size: { width: 0, height: 0 } }, write),
      ).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("base64 and data URIs", () => {
  test("fromBase64 inverts base64 for every padding length", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
      expect([...(fromBase64(base64(bytes)) ?? [])]).toEqual([...bytes]);
    }
    expect(fromBase64("a")).toBeNull();
    expect(fromBase64("ab!c")).toBeNull();
  });

  test("decodeDataUri reads the type, ignores parameters, and refuses non-base64", () => {
    expect(decodeDataUri("data:IMAGE/PNG;base64,AAE=")).toEqual({
      mime: "image/png",
      bytes: new Uint8Array([0, 1]),
    });
    expect(decodeDataUri("data:image/jpeg;name=x.jpg;base64,AA==")?.mime).toBe("image/jpeg");
    expect(decodeDataUri("data:text/plain,hello")).toBeNull();
  });

  test("pastedName follows the type, with a fallback extension", () => {
    expect(pastedName("image/webp", AT)).toBe("pasted-20261013120000123.webp");
    expect(pastedName("image/heic", AT)).toBe("pasted-20261013120000123.img");
  });
});
