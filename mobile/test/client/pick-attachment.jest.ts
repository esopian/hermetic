const mockLibrary = jest.fn();
const mockCamera = jest.fn();
const mockCameraPermission = jest.fn();
const mockDocument = jest.fn();
const mockBytes = jest.fn(async () => new Uint8Array([1, 2, 3]));
/** The fake file system: each file's URI and size. */
const mockFs = new Map<string, number>();

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: (...a: unknown[]) => mockLibrary(...a),
  launchCameraAsync: (...a: unknown[]) => mockCamera(...a),
  requestCameraPermissionsAsync: () => mockCameraPermission(),
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
}));
jest.mock("expo-document-picker", () => ({
  getDocumentAsync: (...a: unknown[]) => mockDocument(...a),
}));
jest.mock("expo-file-system", () => ({
  File: class {
    at: string;
    constructor(at: string) {
      this.at = at;
    }
    get exists() {
      return mockFs.has(this.at);
    }
    get size() {
      return mockFs.get(this.at) ?? 0;
    }
    delete() {
      mockFs.delete(this.at);
    }
    bytes() {
      return mockBytes();
    }
  },
  Paths: { cache: { uri: "file:///cache/" } },
}));

import {
  discardPicked,
  insideCache,
  kindOf,
  photoName,
  pickDocument,
  pickFromLibrary,
  readBytes,
  takePhoto,
} from "../../src/client/pick-attachment.ts";

beforeEach(() => {
  jest.clearAllMocks();
  mockFs.clear();
});

test("photoName: the library's name, with the extension following a converted photo", () => {
  expect(photoName("IMG_1.HEIC", "file:///x/abc.jpg", "image/jpeg")).toBe("IMG_1.jpg");
  expect(photoName("IMG_1.JPEG", "file:///x/abc.jpg", "image/jpeg")).toBe("IMG_1.JPEG");
  expect(photoName(null, "file:///x/My%20Shot.png", "image/png")).toBe("My Shot.png");
  expect(photoName(undefined, "file:///x/", undefined)).toBe("photo.jpg");
});

test("pickFromLibrary: images only, compatible representation, capped at the room left", async () => {
  mockLibrary.mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: "file:///x/a.jpg",
        fileName: "a.HEIC",
        mimeType: "image/jpeg",
        fileSize: 10,
        width: 1,
        height: 1,
      },
      {
        uri: "file:///x/b.jpg",
        fileName: "b.jpg",
        mimeType: "image/jpeg",
        fileSize: 20,
        width: 1,
        height: 1,
      },
    ],
  });
  const picked = await pickFromLibrary(1);
  expect(mockLibrary).toHaveBeenCalledWith(
    expect.objectContaining({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      selectionLimit: 1,
      preferredAssetRepresentationMode: "compatible",
    }),
  );
  expect(picked).toEqual([
    { name: "a.jpg", uri: "file:///x/a.jpg", mime: "image/jpeg", size: 10, kind: "image" },
  ]);
  expect(await pickFromLibrary(0)).toEqual([]);
});

test("a cancelled pick is nothing", async () => {
  mockLibrary.mockResolvedValue({ canceled: true, assets: null });
  mockDocument.mockResolvedValue({ canceled: true, assets: null });
  mockCamera.mockResolvedValue({ canceled: true, assets: null });
  mockCameraPermission.mockResolvedValue({ granted: true });
  expect(await pickFromLibrary()).toEqual([]);
  expect(await pickDocument()).toEqual([]);
  expect(await takePhoto()).toBeNull();
});

test("takePhoto asks for the camera, and a refusal is PERMISSION_DENIED", async () => {
  mockCameraPermission.mockResolvedValue({ granted: false });
  await expect(takePhoto()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(mockCamera).not.toHaveBeenCalled();
  mockCameraPermission.mockResolvedValue({ granted: true });
  mockCamera.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///x/cam.jpg", mimeType: "image/jpeg", fileSize: 5, width: 1, height: 1 }],
  });
  expect(await takePhoto()).toEqual({
    name: "cam.jpg",
    uri: "file:///x/cam.jpg",
    mime: "image/jpeg",
    size: 5,
    kind: "image",
  });
});

test("pickDocument: any type, copied to the cache, kind from the type", async () => {
  mockDocument.mockResolvedValue({
    canceled: false,
    assets: [
      { uri: "file:///c/report.pdf", name: "report.pdf", mimeType: "application/pdf", size: 99 },
      { uri: "file:///c/pic.png", name: "pic.png", mimeType: "image/png" },
    ],
  });
  const picked = await pickDocument();
  expect(mockDocument).toHaveBeenCalledWith({
    type: "*/*",
    multiple: true,
    copyToCacheDirectory: true,
  });
  expect(picked).toEqual([
    {
      name: "report.pdf",
      uri: "file:///c/report.pdf",
      mime: "application/pdf",
      size: 99,
      kind: "file",
    },
    { name: "pic.png", uri: "file:///c/pic.png", mime: "image/png", size: 0, kind: "image" },
  ]);
});

test("readBytes reads the file through expo-file-system", async () => {
  expect([...(await readBytes("file:///c/a.txt"))]).toEqual([1, 2, 3]);
  expect(mockBytes).toHaveBeenCalled();
});

test("discardPicked deletes the picker's copy in the cache, and nothing outside it", () => {
  mockFs.set("file:///cache/DocumentPicker/id_rsa", 10);
  mockFs.set("file:///documents/keep.txt", 10);
  discardPicked({ uri: "file:///cache/DocumentPicker/id_rsa" });
  discardPicked({ uri: "file:///documents/keep.txt" });
  discardPicked({ uri: "file:///cache/gone.txt" });
  expect([...mockFs.keys()]).toEqual(["file:///documents/keep.txt"]);
});

test("picks past the room left are discarded at once", async () => {
  mockFs.set("file:///cache/ImagePicker/a.jpg", 10);
  mockFs.set("file:///cache/ImagePicker/b.jpg", 20);
  mockLibrary.mockResolvedValue({
    canceled: false,
    assets: [
      { uri: "file:///cache/ImagePicker/a.jpg", mimeType: "image/jpeg", width: 1, height: 1 },
      { uri: "file:///cache/ImagePicker/b.jpg", mimeType: "image/jpeg", width: 1, height: 1 },
    ],
  });
  const picked = await pickFromLibrary(1);
  // No size from the picker: the file system's.
  expect(picked).toEqual([
    {
      name: "a.jpg",
      uri: "file:///cache/ImagePicker/a.jpg",
      mime: "image/jpeg",
      size: 10,
      kind: "image",
    },
  ]);
  expect([...mockFs.keys()]).toEqual(["file:///cache/ImagePicker/a.jpg"]);
});

test("kindOf: the type decides, else the extension", () => {
  expect(kindOf("a.bin", "image/png")).toBe("image");
  expect(kindOf("a.png", "application/octet-stream")).toBe("file");
  expect(kindOf("photo.JPEG", undefined)).toBe("image");
  expect(kindOf("notes.txt", undefined)).toBe("file");
  expect(kindOf("heic.heic", undefined)).toBe("file");
});

test("insideCache: whole segments under the cache, nothing that climbs out", () => {
  const cache = "file:///cache/";
  expect(insideCache("file:///cache/DocumentPicker/a.txt", cache)).toBe(true);
  expect(insideCache("file:///cache/DocumentPicker/a.txt", "file:///cache")).toBe(true);
  expect(insideCache("file:///cachex/a.txt", "file:///cache")).toBe(false);
  expect(insideCache("file:///cache/", cache)).toBe(false);
  expect(insideCache("file:///cache/../Documents/keep.txt", cache)).toBe(false);
  expect(insideCache("file:///cache/./a.txt", cache)).toBe(false);
  expect(insideCache("file:///cache/%2e%2e/Documents/keep.txt", cache)).toBe(false);
  expect(insideCache("file:///cache/a%2F..%2Fb", cache)).toBe(false);
  expect(insideCache("file:///cache//a.txt", cache)).toBe(false);
  expect(insideCache("file:///cache/a.txt?x=1", cache)).toBe(false);
  expect(insideCache("file:///cache/%E0%A4%A", cache)).toBe(false);
  expect(insideCache("file:///cache/a.txt", null)).toBe(false);
});

test("discardPicked refuses a path that climbs out of the cache", () => {
  mockFs.set("file:///cache/../Documents/keep.txt", 1);
  discardPicked({ uri: "file:///cache/../Documents/keep.txt" });
  expect(mockFs.has("file:///cache/../Documents/keep.txt")).toBe(true);
});
