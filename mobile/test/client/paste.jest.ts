import { base64 } from "../../src/client/file-urls.ts";
import { decodeDataUri, pasteAttachments, pastedName } from "../../src/client/paste.ts";

const AT = new Date("2026-10-13T12:00:00.123Z");

function writer() {
  const written = new Map<string, string>();
  const write = jest.fn(async (name: string, base64: string) => {
    written.set(name, base64);
    return { uri: `file:///cache/${name}`, size: 9 };
  });
  return { written, write };
}

describe("pasteAttachments", () => {
  test("a clipboard image is one picked image entry, its base64 written to the cache", async () => {
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
      size: 9,
      status: "picked",
    });
    expect(item?.local_id).toMatch(/^att\d+$/);
    expect(written.get("pasted-20261013120000123.jpg")).toBe(base64(jpeg));
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

describe("data URIs", () => {
  test("decodeDataUri reads the type, ignores parameters, and refuses non-base64", () => {
    expect(decodeDataUri("data:IMAGE/PNG;base64,AA\nE=")).toEqual({
      mime: "image/png",
      base64: "AAE=",
    });
    expect(decodeDataUri("data:image/jpeg;name=x.jpg;base64,AA==")?.mime).toBe("image/jpeg");
    expect(decodeDataUri("data:text/plain,hello")).toBeNull();
    expect(decodeDataUri("data:image/png;base64,a")).toBeNull();
    expect(decodeDataUri("data:image/png;base64,ab!c")).toBeNull();
  });

  test("pastedName follows the type, with a fallback extension", () => {
    expect(pastedName("image/webp", AT)).toBe("pasted-20261013120000123.webp");
    expect(pastedName("image/heic", AT)).toBe("pasted-20261013120000123.img");
  });
});
