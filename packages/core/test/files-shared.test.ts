/**
 * The files service's shared rules (`src/shared/files.ts`): the name sanitizer,
 * the digest header, the route matchers, accept matching, the sniffer, key
 * detection, ids and secret slots. hermeticd, core and the UI all run these
 * functions, so their behaviour is pinned here rather than through any one
 * caller.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ENV_SECRET_SLOT_RE,
  FILES_LIMITS,
  FILES_ROUTES,
  FILES_SOCKET_ROUTES,
  FILES_TTL,
  FILE_SECRET_SLOT_RE,
  acceptMatches,
  envSecretSlot,
  fileSecretSlot,
  filesHttpStatus,
  formatContentDigest,
  inboxRelPath,
  isEnvSecretSlot,
  isFileId,
  isFileSecretSlot,
  isImageMime,
  isRequestId,
  isShareId,
  looksLikeKeyMaterial,
  matchFilesRoute,
  matchSocketRoute,
  newFileId,
  newRequestId,
  newShareId,
  parseContentDigest,
  sanitizeFileName,
  secretSlotFileName,
  secretTextSlug,
  shortId,
  sniffMime,
} from "../src/shared/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => new Uint8Array(b);

describe("sanitizeFileName", () => {
  const ok: Array<[string, string]> = [
    ["report.pdf", "report.pdf"],
    ["../x", "x"],
    ["a/../../b", "b"],
    ["C:\\Users\\me\\key.pem", "key.pem"],
    ["/etc/passwd", "passwd"],
    ["résumé final.docx", "résumé final.docx"],
    ["CONSOLE.txt", "CONSOLE.txt"],
    ["com10.txt", "com10.txt"],
    ["a.b.c", "a.b.c"],
  ];
  for (const [raw, name] of ok) {
    test(`accepts ${JSON.stringify(raw)} as ${JSON.stringify(name)}`, () => {
      expect(sanitizeFileName(raw)).toEqual({ ok: true, name });
    });
  }

  const bad: Array<[string, string]> = [
    ["", "empty"],
    ["dir/", "empty"],
    ["a\\", "empty"],
    [".", "dot_segment"],
    ["..", "dot_segment"],
    ["a/..", "dot_segment"],
    ["a\u0000b.txt", "control_char"],
    ["dir\u0000/ok.txt", "control_char"],
    ["tab\there", "control_char"],
    ["del\u007f", "control_char"],
    ["c1\u0085", "control_char"],
    ["\u202Etxt.exe", "bidi_control"],
    ["a\u2066b", "bidi_control"],
    ["mark\u200F.txt", "bidi_control"],
    [".env", "leading_dot"],
    [".ssh/../.bashrc", "leading_dot"],
    ["report.", "trailing_dot_or_space"],
    ["report ", "trailing_dot_or_space"],
    ["CON", "reserved_name"],
    ["con.txt", "reserved_name"],
    ["CON.txt", "reserved_name"],
    ["Lpt9.tar.gz", "reserved_name"],
    ["nul", "reserved_name"],
    ["COM1", "reserved_name"],
    ["a".repeat(129), "too_long"],
    ["é".repeat(65), "too_long"],
  ];
  for (const [raw, reason] of bad) {
    test(`rejects ${JSON.stringify(raw).slice(0, 40)} as ${reason}`, () => {
      expect(sanitizeFileName(raw)).toEqual({ ok: false, reason } as never);
    });
  }

  test("128 UTF-8 bytes is the limit, not 128 characters", () => {
    expect(sanitizeFileName("a".repeat(128)).ok).toBe(true);
    expect(sanitizeFileName("é".repeat(64)).ok).toBe(true); // 128 bytes
    expect(sanitizeFileName(`${"a".repeat(296)}.txt`)).toEqual({ ok: false, reason: "too_long" });
    expect(FILES_LIMITS.nameBytes).toBe(128);
  });

  test("NFD input comes out NFC", () => {
    const nfd = "re\u0301sume\u0301.txt";
    const res = sanitizeFileName(nfd);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.name).toBe("r\u00e9sum\u00e9.txt");
      expect(res.name).toBe(res.name.normalize("NFC"));
    }
  });

  test("fuzz: whatever it accepts is a plain, bounded, idempotent basename", () => {
    const alphabet = ["a", "Z", "0", ".", "/", "\\", " ", "-", "é", "\u0000", "\u202E", "\u0301", "_"];
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rnd() * 24);
      let raw = "";
      for (let j = 0; j < len; j++) raw += alphabet[Math.floor(rnd() * alphabet.length)];
      const res = sanitizeFileName(raw);
      if (!res.ok) continue;
      const n = res.name;
      expect(n).not.toContain("/");
      expect(n).not.toContain("\\");
      expect(n).not.toContain("\u0000");
      expect(n).not.toContain("\u202E");
      expect(n.startsWith(".")).toBe(false);
      expect(n === "." || n === "..").toBe(false);
      expect(new TextEncoder().encode(n).length).toBeLessThanOrEqual(128);
      expect(n).toBe(n.normalize("NFC"));
      expect(sanitizeFileName(n)).toEqual({ ok: true, name: n });
    }
  });
});

describe("Content-Digest", () => {
  test("round-trips a SHA-256", () => {
    const hex = createHash("sha256").update("hello").digest("hex");
    const header = formatContentDigest(hex);
    expect(header).toBe(`sha-256=:${createHash("sha256").update("hello").digest("base64")}:`);
    expect(parseContentDigest(header)).toBe(hex);
    expect(parseContentDigest(formatContentDigest(hex.toUpperCase()))).toBe(hex);
  });

  test("finds sha-256 among other algorithms, ignoring parameters and case", () => {
    const hex = createHash("sha256").update("x").digest("hex");
    const b64 = createHash("sha256").update("x").digest("base64");
    const sha512 = createHash("sha512").update("x").digest("base64");
    expect(parseContentDigest(`sha-512=:${sha512}:, sha-256=:${b64}:`)).toBe(hex);
    expect(parseContentDigest(`SHA-256=:${b64}:;x=1`)).toBe(hex);
  });

  test("anything else is null", () => {
    const b64 = createHash("sha256").update("x").digest("base64");
    const sha512 = createHash("sha512").update("x").digest("base64");
    for (const h of [
      null,
      undefined,
      "",
      `sha-512=:${sha512}:`,
      `sha-256=${b64}`,
      "sha-256=:!!notbase64!!:",
      `sha-256=:${createHash("md5").update("x").digest("base64")}:`,
      "md5=:abc:",
    ]) {
      expect(parseContentDigest(h)).toBeNull();
    }
    expect(() => formatContentDigest("nothex")).toThrow();
  });
});

describe("tailnet routes", () => {
  const f = newFileId();
  const fr = newRequestId();
  const sh = newShareId();
  const cases: Array<[string, string, unknown]> = [
    ["PUT", FILES_ROUTES.stage("my report.pdf"), { route: "stage", name: "my report.pdf" }],
    ["PUT", FILES_ROUTES.stage("a/b?c#d.txt"), { route: "stage", name: "a/b?c#d.txt" }],
    ["POST", FILES_ROUTES.commit(f), { route: "commit", id: f }],
    ["GET", FILES_ROUTES.requests, { route: "requests" }],
    ["GET", FILES_ROUTES.request(fr), { route: "request", id: fr }],
    ["PUT", FILES_ROUTES.request(fr), { route: "fulfil", id: fr }],
    ["POST", FILES_ROUTES.requestSecret(fr), { route: "requestSecret", id: fr }],
    ["POST", FILES_ROUTES.requestDecline(fr), { route: "requestDecline", id: fr }],
    ["GET", FILES_ROUTES.list, { route: "list" }],
    ["GET", FILES_ROUTES.entry(f), { route: "entry", id: f }],
    ["GET", FILES_ROUTES.entry(sh), { route: "entry", id: sh }],
    ["DELETE", FILES_ROUTES.entry(sh), { route: "delete", id: sh }],
    ["GET", FILES_ROUTES.content(f), { route: "content", id: f }],
    ["GET", FILES_ROUTES.content(sh), { route: "content", id: sh }],
  ];
  for (const [method, path, want] of cases) {
    test(`${method} ${path} round-trips`, () => {
      expect(matchFilesRoute(method, path)).toEqual(want as never);
      expect(matchFilesRoute(method.toLowerCase(), `${path}?x=1`)).toEqual(want as never);
    });
  }

  test("an encoded slash in a stage name stays one segment", () => {
    expect(FILES_ROUTES.stage("../etc/passwd")).toBe("/files/stage/..%2Fetc%2Fpasswd");
  });

  const junk: Array<[string, string]> = [
    ["GET", "/"],
    ["GET", ""],
    ["GET", "files"],
    ["GET", "/file"],
    ["POST", "/files"],
    ["GET", "/files/"],
    ["GET", "/files/stage/x.txt"],
    ["PUT", "/files/stage/"],
    ["PUT", "/files/stage/a/b"],
    ["POST", `/files/${fr}/commit`],
    ["POST", `/files/${sh}/commit`],
    ["GET", `/files/${f}/commit`],
    ["GET", "/files/f_SHORT"],
    ["GET", "/files/f_ABCDEFGHIJKL"],
    ["DELETE", FILES_ROUTES.request(fr)],
    ["GET", FILES_ROUTES.requestSecret(fr)],
    ["POST", `/files/requests/${fr}/other`],
    ["POST", `/files/requests/${f}/decline`],
    ["GET", `/files/requests/${f}`],
    ["GET", `/files/${fr}/content`],
    ["GET", `/files/${f}/content/extra`],
    ["PUT", "/files/stage/%E0%A4%A"],
    ["GET", "/healthz"],
  ];
  for (const [method, path] of junk) {
    test(`${method} ${JSON.stringify(path)} matches nothing`, () => {
      expect(matchFilesRoute(method, path)).toBeNull();
    });
  }
});

describe("socket routes", () => {
  const fr = newRequestId();
  const cases: Array<[string, string, unknown]> = [
    ["GET", FILES_SOCKET_ROUTES.hello, { route: "hello" }],
    ["POST", FILES_SOCKET_ROUTES.openRequest, { route: "openRequest" }],
    ["GET", FILES_SOCKET_ROUTES.request(fr), { route: "request", id: fr }],
    ["GET", FILES_SOCKET_ROUTES.wait(fr, 25), { route: "wait", id: fr, s: 25 }],
    ["POST", FILES_SOCKET_ROUTES.consume(fr), { route: "consume", id: fr }],
    ["POST", FILES_SOCKET_ROUTES.outbox, { route: "outbox" }],
    ["GET", FILES_SOCKET_ROUTES.files, { route: "files" }],
  ];
  for (const [method, path, want] of cases) {
    test(`${method} ${path} round-trips`, () => {
      expect(matchSocketRoute(method, path)).toEqual(want as never);
    });
  }

  test("wait's s is clamped, and defaults when absent or unreadable", () => {
    expect(matchSocketRoute("GET", FILES_SOCKET_ROUTES.wait(fr, 9999))).toEqual({
      route: "wait",
      id: fr,
      s: FILES_TTL.waitMax,
    });
    expect(matchSocketRoute("GET", FILES_SOCKET_ROUTES.wait(fr, 0))).toMatchObject({ s: 0 });
    for (const q of ["", "?s=", "?s=-1", "?s=abc", "?t=5"]) {
      expect(matchSocketRoute("GET", `/requests/${fr}/wait${q}`)).toMatchObject({
        s: FILES_TTL.waitDefault,
      });
    }
  });

  test("junk matches nothing", () => {
    for (const [m, p] of [
      ["POST", "/hello"],
      ["GET", "/requests"],
      ["GET", "/outbox"],
      ["POST", "/files"],
      ["GET", "/requests/f_abcdefghijkl"],
      ["POST", `/requests/${fr}`],
      ["POST", `/requests/${fr}/wait`],
      ["GET", `/requests/${fr}/consume`],
      ["GET", `/requests/${fr}/wait/x`],
      ["PUT", `/requests/${fr}`],
      ["GET", "/nope"],
      ["GET", "hello"],
    ] as const) {
      expect(matchSocketRoute(m, p)).toBeNull();
    }
  });
});

describe("acceptMatches", () => {
  test("empty accepts anything", () => {
    expect(acceptMatches([], "x.bin", "application/octet-stream")).toBe(true);
  });
  test("extensions are case-insensitive suffixes", () => {
    expect(acceptMatches([".pem"], "KEY.PEM", "application/x-pem-file")).toBe(true);
    expect(acceptMatches([".PEM"], "key.pem", "text/plain")).toBe(true);
    expect(acceptMatches([".pem"], "key.pem.txt", "text/plain")).toBe(false);
    expect(acceptMatches([".tar.gz"], "a.tar.gz", "application/gzip")).toBe(true);
  });
  test("MIME types match exactly or by family, against the sniffed type", () => {
    expect(acceptMatches(["application/pdf"], "x", "application/pdf")).toBe(true);
    expect(acceptMatches(["application/pdf"], "x.pdf", "text/plain")).toBe(false);
    expect(acceptMatches(["image/*"], "x", "image/png")).toBe(true);
    expect(acceptMatches(["image/*"], "x", "imagex/png")).toBe(false);
    expect(acceptMatches(["*/*"], "x", "application/zip")).toBe(true);
    expect(acceptMatches(["text/plain"], "x", "Text/Plain; charset=utf-8")).toBe(true);
    expect(acceptMatches(["application/x-pem-file", ".pem"], "k.key", "application/x-pem-file")).toBe(
      true,
    );
    expect(acceptMatches(["", "  "], "x", "text/plain")).toBe(false);
  });
});

describe("sniffMime", () => {
  test("magic numbers decide, whatever the name says", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), "x.txt")).toBe(
      "image/png",
    );
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0), "x.bin")).toBe("image/jpeg");
    expect(sniffMime(enc("GIF89a...."), "x")).toBe("image/gif");
    expect(sniffMime(enc("RIFF\x10\x00\x00\x00WEBPVP8 "), "x")).toBe("image/webp");
    expect(sniffMime(enc("%PDF-1.7\n"), "x.png")).toBe("application/pdf");
    expect(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04, 0x14), "x.docx")).toBe("application/zip");
    expect(sniffMime(bytes(0x1f, 0x8b, 0x08), "x.tgz")).toBe("application/gzip");
  });

  test("an image extension never makes an image", () => {
    expect(sniffMime(enc("hello"), "photo.png")).toBe("text/plain");
    expect(sniffMime(bytes(0, 1, 2, 3, 0xfe), "photo.jpg")).toBe("application/octet-stream");
    expect(isImageMime(sniffMime(enc("<svg/>"), "x.svg"))).toBe(false);
  });

  test("PEM, including OpenSSH keys", () => {
    expect(sniffMime(enc("-----BEGIN CERTIFICATE-----\nMIIB\n"), "c.crt")).toBe(
      "application/x-pem-file",
    );
    expect(sniffMime(enc("\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n"), "id_ed25519")).toBe(
      "application/x-pem-file",
    );
  });

  test("text, with the extension as a tiebreak", () => {
    expect(sniffMime(enc("plain words\n"), "notes")).toBe("text/plain");
    expect(sniffMime(enc('{"a":1}'), "a.json")).toBe("application/json");
    expect(sniffMime(enc("a,b\n1,2\n"), "t.CSV")).toBe("text/csv");
    expect(sniffMime(enc("ünïcödé"), "u.txt")).toBe("text/plain");
    // A multi-byte character cut by the head's end is still text.
    expect(sniffMime(enc("abc€").subarray(0, 5), "u.txt")).toBe("text/plain");
  });

  test("binary is octet-stream; PKCS#12 only under its own extension", () => {
    expect(sniffMime(bytes(0, 0, 0, 1, 2), "x")).toBe("application/octet-stream");
    expect(sniffMime(bytes(0x30, 0x82, 0x0a, 0x01, 0x02, 0x00), "cert.p12")).toBe(
      "application/x-pkcs12",
    );
    expect(sniffMime(bytes(0x30, 0x82, 0x0a, 0x01, 0x02, 0x00), "cert.bin")).toBe(
      "application/octet-stream",
    );
  });

  test("isImageMime is the four raster types", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG"]) {
      expect(isImageMime(m)).toBe(true);
    }
    for (const m of ["image/svg+xml", "image/heic", "text/plain"]) expect(isImageMime(m)).toBe(false);
  });
});

describe("looksLikeKeyMaterial", () => {
  test("PEM private keys of every flavour", () => {
    for (const kind of ["", "RSA ", "EC ", "ENCRYPTED ", "OPENSSH ", "DSA "]) {
      expect(looksLikeKeyMaterial(enc(`-----BEGIN ${kind}PRIVATE KEY-----\nMIIE\n`), "x.txt")).toBe(
        true,
      );
    }
    expect(looksLikeKeyMaterial(enc("-----BEGIN PGP PRIVATE KEY BLOCK-----\n"), "k.asc")).toBe(true);
    expect(looksLikeKeyMaterial(enc("fixture junk\n-----BEGIN PRIVATE KEY-----\n"), "bundle.pem")).toBe(
      true,
    );
  });

  test("PKCS#12 and DER keys by extension", () => {
    const der = bytes(0x30, 0x82, 0x04, 0xa4, 0x02, 0x01, 0x00, 0xff);
    expect(looksLikeKeyMaterial(der, "client.p12")).toBe(true);
    expect(looksLikeKeyMaterial(der, "client.PFX")).toBe(true);
    expect(looksLikeKeyMaterial(der, "server.key")).toBe(true);
    expect(looksLikeKeyMaterial(der, "blob.bin")).toBe(false);
  });

  test("certificates, public keys and prose are not keys", () => {
    expect(looksLikeKeyMaterial(enc("-----BEGIN CERTIFICATE-----\n"), "c.pem")).toBe(false);
    expect(looksLikeKeyMaterial(enc("-----BEGIN PUBLIC KEY-----\n"), "pub.pem")).toBe(false);
    expect(looksLikeKeyMaterial(enc("ssh-ed25519 AAAAC3Nz me@host\n"), "id.pub")).toBe(false);
    expect(looksLikeKeyMaterial(enc("0 is a number"), "notes.key")).toBe(false);
  });
});

describe("ids", () => {
  test("formats and predicates", () => {
    const f = newFileId();
    const fr = newRequestId();
    const sh = newShareId();
    expect(f).toMatch(/^f_[a-z0-9]{12}$/);
    expect(fr).toMatch(/^fr_[a-z0-9]{12}$/);
    expect(sh).toMatch(/^sh_[a-z0-9]{12}$/);
    expect([isFileId(f), isRequestId(f), isShareId(f)]).toEqual([true, false, false]);
    expect([isFileId(fr), isRequestId(fr), isShareId(fr)]).toEqual([false, true, false]);
    expect([isFileId(sh), isRequestId(sh), isShareId(sh)]).toEqual([false, false, true]);
    for (const bad of [
      "f_",
      "f_ABCDEFGHIJKL",
      "f_abcdefghijk",
      "f_abcdefghijklm",
      "x_abcdefghijkl",
      "",
    ]) {
      expect(isFileId(bad)).toBe(false);
    }
  });

  test("ids do not repeat", () => {
    const seen = new Set(Array.from({ length: 2000 }, newFileId));
    expect(seen.size).toBe(2000);
  });

  test("shortId", () => {
    expect(shortId("fr_7k2m4p9q3f9a")).toBe("fr_…q3f9a");
    expect(shortId("f_7k2m4p9q3f9a")).toBe("f_…q3f9a");
    expect(shortId("plain")).toBe("plain");
    expect(shortId("x_abc")).toBe("x_abc");
  });

  test("inboxRelPath is the UTC day", () => {
    expect(inboxRelPath(new Date("2026-10-13T23:30:00-07:00"), "f_abcdefghijkl", "a.png")).toBe(
      "inbox/2026-10-14/f_abcdefghijkl/a.png",
    );
  });
});

describe("secret slots", () => {
  test("derived from a file name", () => {
    expect(fileSecretSlot("github-app.pem")).toBe("file-github-app-pem");
    expect(fileSecretSlot("  My Key (prod).PEM ")).toBe("file-my-key-prod-pem");
    expect(fileSecretSlot("†††")).toBe("file-secret");
    expect(envSecretSlot("Stripe keys")).toBe("env-stripe-keys");
    const long = fileSecretSlot(`${"a".repeat(47)}-${"b".repeat(10)}`);
    expect(long).toBe(`file-${"a".repeat(47)}`);
    expect(isFileSecretSlot(long)).toBe(true);
  });

  test("every derived slot passes its regex", () => {
    for (const n of ["a", "x.pem", "-", "A-B", "é.key", "a".repeat(300), "0-0-0-"]) {
      expect(FILE_SECRET_SLOT_RE.test(fileSecretSlot(n))).toBe(true);
      expect(ENV_SECRET_SLOT_RE.test(envSecretSlot(n))).toBe(true);
    }
  });

  test("regexes", () => {
    expect(isFileSecretSlot("file-a")).toBe(true);
    expect(isFileSecretSlot(`file-${"a".repeat(48)}`)).toBe(true);
    expect(isFileSecretSlot(`file-${"a".repeat(49)}`)).toBe(false);
    for (const bad of ["file-", "file--a", "file-a-", "file-A", "env-a", "provider-key", "file-a/b"]) {
      expect(isFileSecretSlot(bad)).toBe(false);
    }
    expect(isEnvSecretSlot("env-github")).toBe(true);
    expect(isEnvSecretSlot("file-github")).toBe(false);
  });

  test("secretSlotFileName", () => {
    expect(secretSlotFileName("env-github")).toBe("github.env");
    expect(secretSlotFileName("file-github-app-pem")).toBe("github-app-pem");
    expect(secretSlotFileName("provider-key")).toBeNull();
  });
});

describe("secretTextSlug", () => {
  test("derives from the first key, dropping one credential suffix", () => {
    expect(secretTextSlug(["GITHUB_TOKEN"])).toBe("github");
    expect(secretTextSlug(["OPENAI_API_KEY", "OTHER"])).toBe("openai");
    expect(secretTextSlug(["STRIPE_SECRET_KEY"])).toBe("stripe");
    expect(secretTextSlug(["DB_PASSWORD"])).toBe("db");
    expect(secretTextSlug(["SLACK_WEBHOOK_SECRET"])).toBe("slack-webhook");
    expect(secretTextSlug(["DATABASE_URL"])).toBe("database-url");
    expect(secretTextSlug(["_PRIVATE"])).toBe("private");
  });

  test("a key that is only a suffix keeps it", () => {
    expect(secretTextSlug(["TOKEN"])).toBe("token");
    expect(secretTextSlug(["API_KEY"])).toBe("api");
    expect(secretTextSlug(["__"])).toBe("secret");
  });

  test("a given slug wins, slugged like a slot, a trailing .env dropped", () => {
    expect(secretTextSlug(["GITHUB_TOKEN"], "Prod GitHub")).toBe("prod-github");
    expect(secretTextSlug(["GITHUB_TOKEN"], "deploy.env")).toBe("deploy");
    expect(secretTextSlug(["GITHUB_TOKEN"], "../../etc/passwd")).toBe("etc-passwd");
    expect(secretTextSlug(["GITHUB_TOKEN"], "  ")).toBe("github");
  });

  test("always an env slot's slug, which maps back to <slug>.env", () => {
    for (const [keys, slug] of [
      [["A"], undefined],
      [["X".repeat(64)], undefined],
      [["GITHUB_TOKEN"], "é".repeat(100)],
      [["K"], "a".repeat(300)],
    ] as const) {
      const stem = secretTextSlug(keys, slug);
      const slot = envSecretSlot(stem);
      expect(ENV_SECRET_SLOT_RE.test(slot)).toBe(true);
      expect(slot).toBe(`env-${stem}`);
      expect(secretSlotFileName(slot)).toBe(`${stem}.env`);
    }
  });
});

describe("HTTP statuses", () => {
  test("the files codes map as documented", () => {
    expect(filesHttpStatus("FILE_TOO_LARGE")).toBe(413);
    expect(filesHttpStatus("FILE_DIGEST_MISMATCH")).toBe(422);
    expect(filesHttpStatus("FILE_TYPE_REJECTED")).toBe(415);
    expect(filesHttpStatus("FILE_NAME_INVALID")).toBe(400);
    expect(filesHttpStatus("FILE_REQUEST_FULFILLED")).toBe(409);
    expect(filesHttpStatus("FILE_REQUEST_EXPIRED")).toBe(410);
    expect(filesHttpStatus("FILE_NOT_FOUND")).toBe(404);
    expect(filesHttpStatus("DISK_FULL")).toBe(507);
    expect(filesHttpStatus("FILE_SECRET_FORBIDDEN")).toBe(403);
    expect(filesHttpStatus("NOT_A_CODE")).toBe(500);
  });
});
