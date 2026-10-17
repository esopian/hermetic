/**
 * The files service's fixed points: the routes hermeticd serves on the tailnet
 * and on its local socket, the box directories, the id formats, the headers,
 * the file-name rules, the size caps and TTLs, the content sniffer and the
 * secret-slot naming. hermeticd, core and the UI must agree on every one of
 * these, so they live here once.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/files.ts`,
 * which imports this module, never the reverse
 * (`packages/core/test/shared-browser-safe.test.ts`). Randomness, base64 and
 * UTF-8 come from the globals both runtimes have: `crypto.getRandomValues`,
 * `btoa`/`atob`, `TextEncoder`/`TextDecoder`.
 */
import { HermeticError } from "../errors.ts";
import type { ErrorCode } from "./error-codes.ts";
import { HERMES_HOME } from "./hermes.ts";
import { SECRET_KEY_RE } from "./secret-env.ts";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// --- Capability -----------------------------------------------------------

/**
 * Reported in `/healthz`'s `capabilities` when hermeticd serves the files
 * routes. A laptop that does not see it treats the box as an older hermeticd
 * and hides the attach affordances rather than failing an upload.
 */
export const FILES_CAPABILITY = "files";

// --- Box directories --------------------------------------------------------

/** Where operator uploads land once committed: `inbox/<yyyy-mm-dd>/<id>/<name>`. */
export const FILES_INBOX_DIR = `${HERMES_HOME}/inbox`;
/** Staged uploads not yet committed to a turn. Swept after `FILES_TTL.stage`. */
export const FILES_STAGE_DIR = `${FILES_INBOX_DIR}/.stage`;
/** Files the agent shared with the operator (`share_file`). */
export const FILES_OUTBOX_DIR = `${HERMES_HOME}/outbox`;
/** Ephemeral secrets, on tmpfs: never on the data volume, never in a snapshot. */
export const FILES_DROP_DIR = "/run/hermetic/drop";
/** Durable secrets, re-materialised from SSM at boot. Never swept. */
export const FILES_SECRET_DIR = "/run/hermetic/files";
/**
 * hermeticd's metadata index: ids, names, digests, sizes, owners, expiry —
 * never content. A JSON document rather than SQLite so the in-memory `FakeHost`
 * can exercise it. Root-only, in hermeticd's own state directory beside
 * `fleet.json` and `update-state.json` (agentd's `STATE_DIR`).
 */
export const FILES_INDEX_PATH = "/var/lib/hermeticd/files.json";

/** UTC calendar day of `date`, `yyyy-mm-dd`. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * An inbox file's path relative to `HERMES_HOME`, as an `@file:` reference
 * names it: `inbox/<yyyy-mm-dd UTC>/<id>/<name>`. `name` must already have
 * passed `sanitizeFileName`.
 */
export function inboxRelPath(date: Date, id: string, name: string): string {
  return `inbox/${utcDay(date)}/${id}/${name}`;
}

// --- Enums ------------------------------------------------------------------

/** Which root an entry lives under. */
export const FILE_DIRS = ["inbox", "outbox", "stage", "drop", "secret"] as const;
export type FileDir = (typeof FILE_DIRS)[number];

/** What the agent asked for: a normal file, or one that must never touch the volume. */
export const FILE_SENSITIVITIES = ["normal", "secret"] as const;
export type FileSensitivity = (typeof FILE_SENSITIVITIES)[number];

/** How an entry is stored and shown: an image is previewed, a file is a chip, a secret is neither. */
export const FILE_CLASSES = ["image", "file", "secret"] as const;
export type FileClass = (typeof FILE_CLASSES)[number];

/**
 * A request slot's lifecycle. `receiving` is an upload in flight; a rejected
 * upload returns the slot to `open`. `consumed` is an ephemeral secret the
 * agent has read and hermeticd has deleted.
 */
export const FILE_REQUEST_STATES = [
  "open",
  "receiving",
  "fulfilled",
  "declined",
  "expired",
  "consumed",
] as const;
export type FileRequestState = (typeof FILE_REQUEST_STATES)[number];

/** `secret_text` is the masked KEY=value form (`request_secret`). */
export const FILE_REQUEST_KINDS = ["file", "secret_text"] as const;
export type FileRequestKind = (typeof FILE_REQUEST_KINDS)[number];

/** `request_secret`'s starting input mode; the operator may switch either way. */
export const SECRET_TEXT_INPUTS = ["auto", "single", "multi"] as const;
export type SecretTextInput = (typeof SECRET_TEXT_INPUTS)[number];
/** The operator's "Treat as" override, sent with a text-secret submit. */
export const SECRET_TEXT_AS = ["auto", "raw", "dotenv"] as const;
export type SecretTextAs = (typeof SECRET_TEXT_AS)[number];
/** How a text secret was read: one raw value, or KEY=value lines. */
export const SECRET_TEXT_FORMATS = ["raw", "dotenv"] as const;
export type SecretTextFormat = (typeof SECRET_TEXT_FORMATS)[number];
/** A key name a `request_secret` may ask for: an upper-case env name (the parser's own rule). */
export const SECRET_TEXT_KEY_RE = SECRET_KEY_RE;
/** At most this many keys (required plus optional) per `request_secret`. */
export const SECRET_TEXT_MAX_KEYS = 16;

/** The shell line `request_secret` hands the agent: load the file's keys into one command's env. */
export function secretTextLoad(path: string): string {
  return `set -a; . ${path}; set +a`;
}

// --- Limits and TTLs --------------------------------------------------------

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/** Every cap the files service enforces. Bytes unless the name says otherwise. */
export const FILES_LIMITS = {
  /** Hermes's own image cap. */
  imageBytes: 25 * MiB,
  /** The default `files.max_bytes` for a file; a fleet may lower it. */
  fileBytes: 256 * MiB,
  /**
   * SSM standard-tier parameter size. The envelope the bytes travel in
   * (`SECRET_ENVELOPE_MAX_CHARS`, `secretEnvelopeFits`) is the binding cap.
   */
  secretDurableBytes: 4 * KiB,
  secretEphemeralBytes: 1 * MiB,
  secretTextBytes: 64 * KiB,
  attachmentsPerTurn: 10,
  /** A write is refused if it would leave less free than this… */
  diskFloorBytes: 2 * GiB,
  /** …or less than this percentage of the volume free. */
  diskFloorPct: 5,
  /** UTF-8 bytes of a sanitized file name. */
  nameBytes: 128,
  /** How much of a file's head the sniffer reads. */
  sniffBytes: 4 * KiB,
  /** Request slots `open` or `receiving` at once; the socket refuses a 33rd. */
  openRequests: 32,
} as const;

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Lifetimes, long-poll bounds and the sweep interval. All in seconds. */
export const FILES_TTL = {
  stage: HOUR,
  /** The default `files.retention_days`, in seconds. */
  inbox: 7 * DAY,
  outbox: DAY,
  drop: HOUR,
  /** An open request slot's default lifetime. */
  request: 2 * HOUR,
  /** The most one `wait` may hold the socket; below the plugin's 300 s tool budget. */
  waitMax: 290,
  waitDefault: 240,
  /** The plugin polls in steps this long so an interrupt is noticed quickly. */
  waitStep: 25,
  sweepInterval: 15 * 60,
  /** The longest an upload may go without a byte before it is cut off. */
  uploadIdle: 60,
  /**
   * The longest a slot may stay `receiving`. Past it the upload is aborted and
   * the slot reopened, so a client dripping a byte a minute cannot hold it.
   */
  receivingMax: 2 * HOUR,
} as const;

// --- Fleet settings ----------------------------------------------------------

/**
 * The Tailscale app capability hermeticd checks on a caller's whois when the
 * fleet's `files.require_cap` is on. A domain hermetic owns: `tailscale.com`
 * capability names are reserved.
 */
export const FILES_APP_CAP = "hermetic.dev/cap/files";

/** Bounds on `files.retention_days`, the inbox lifetime. */
export const FILES_RETENTION_DAYS = { min: 1, max: 90, default: 7 } as const;

/**
 * The fleet's files settings as written: `FleetSettings.files`, and the fleet
 * manifest's copy of it (`FleetManifest.files`), which is how they reach the
 * box. Every field is optional; absent means the default.
 */
export interface FilesSettingsSource {
  readonly require_cap?: boolean | undefined;
  readonly max_bytes?: number | undefined;
  readonly retention_days?: number | undefined;
}

/** The fleet's files settings with every default applied. */
export interface FilesSettings {
  /** hermeticd refuses a tailnet caller whose whois lacks `FILES_APP_CAP`. */
  readonly require_cap: boolean;
  /** The per-file cap for ordinary files, at most `FILES_LIMITS.fileBytes`. */
  readonly max_bytes: number;
  /** How long an inbox file is kept, in days. */
  readonly retention_days: number;
}

/**
 * Resolve the files settings from either place they are written. Here, rather
 * than restated at each reader, because core (writing the manifest and drawing
 * settings), hermeticd (enforcing them) and the UI must agree on what absent
 * means: `require_cap` off, `max_bytes` the 256 MiB default, retention 7 days.
 * Out-of-range values are clamped rather than trusted, since the box reads them
 * from a document the laptop wrote.
 */
export function resolveFilesSettings(
  source: { readonly files?: FilesSettingsSource | null | undefined } | null | undefined,
): FilesSettings {
  const files = source?.files ?? undefined;
  const maxBytes = files?.max_bytes;
  const days = files?.retention_days;
  return {
    require_cap: files?.require_cap === true,
    max_bytes:
      typeof maxBytes === "number" && Number.isInteger(maxBytes) && maxBytes > 0
        ? Math.min(maxBytes, FILES_LIMITS.fileBytes)
        : FILES_LIMITS.fileBytes,
    retention_days:
      typeof days === "number" && Number.isInteger(days)
        ? Math.min(Math.max(days, FILES_RETENTION_DAYS.min), FILES_RETENTION_DAYS.max)
        : FILES_RETENTION_DAYS.default,
  };
}

// --- Ids --------------------------------------------------------------------

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_BODY_LENGTH = 12;

/** 12 characters of `[a-z0-9]`, uniformly drawn by rejection sampling. */
function randomIdBody(): string {
  const out: string[] = [];
  // 252 is the largest multiple of 36 below 256: bytes at or above it would bias the draw.
  const limit = 256 - (256 % ID_ALPHABET.length);
  while (out.length < ID_BODY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_BODY_LENGTH * 2));
    for (const b of bytes) {
      if (b >= limit) continue;
      out.push(ID_ALPHABET[b % ID_ALPHABET.length] as string);
      if (out.length === ID_BODY_LENGTH) break;
    }
  }
  return out.join("");
}

const FILE_ID_RE = /^f_[a-z0-9]{12}$/;
const REQUEST_ID_RE = /^fr_[a-z0-9]{12}$/;
const SHARE_ID_RE = /^sh_[a-z0-9]{12}$/;

/** An uploaded or stored file: `f_` + 12 of `[a-z0-9]`. */
export function newFileId(): string {
  return `f_${randomIdBody()}`;
}
/** A request slot the agent opened: `fr_` + 12 of `[a-z0-9]`. */
export function newRequestId(): string {
  return `fr_${randomIdBody()}`;
}
/** An outbox entry the agent shared: `sh_` + 12 of `[a-z0-9]`. */
export function newShareId(): string {
  return `sh_${randomIdBody()}`;
}
export function isFileId(id: string): boolean {
  return FILE_ID_RE.test(id);
}
export function isRequestId(id: string): boolean {
  return REQUEST_ID_RE.test(id);
}
export function isShareId(id: string): boolean {
  return SHARE_ID_RE.test(id);
}

/** For display: the prefix and the last five characters, `fr_…q3f9a`. */
export function shortId(id: string): string {
  const cut = id.indexOf("_");
  if (cut < 0 || id.length - cut - 1 <= 6) return id;
  return `${id.slice(0, cut + 1)}…${id.slice(-5)}`;
}

// --- Tailnet routes (port 7434) ----------------------------------------------

const seg = encodeURIComponent;

/**
 * The files routes on hermeticd's tailnet listener (`HERMETICD_RPC_PORT`). Each
 * builder returns a path; `matchFilesRoute` is the one parser of the same paths.
 *
 * | builder              | method      | route (matcher)                      |
 * |----------------------|-------------|--------------------------------------|
 * | `stage(name)`        | PUT         | `stage`                              |
 * | `commit(id)`         | POST        | `commit`                             |
 * | `requests`           | GET         | `requests`                           |
 * | `request(id)`        | GET / PUT   | `request` / `fulfil`                 |
 * | `requestSecret(id)`  | POST        | `requestSecret`                      |
 * | `requestDecline(id)` | POST        | `requestDecline`                     |
 * | `list`               | GET         | `list`                               |
 * | `entry(id)`          | GET / DELETE| `entry` / `delete`                   |
 * | `content(id)`        | GET         | `content`                            |
 */
export const FILES_ROUTES = {
  stage: (name: string) => `/files/stage/${seg(name)}`,
  commit: (id: string) => `/files/${seg(id)}/commit`,
  requests: "/files/requests",
  request: (id: string) => `/files/requests/${seg(id)}`,
  requestSecret: (id: string) => `/files/requests/${seg(id)}/secret`,
  requestDecline: (id: string) => `/files/requests/${seg(id)}/decline`,
  list: "/files",
  entry: (id: string) => `/files/${seg(id)}`,
  content: (id: string) => `/files/${seg(id)}/content`,
} as const;

/**
 * One matched tailnet files route. A path with a malformed id, an unknown shape
 * or the wrong method for its shape matches nothing (`null`, a 404).
 *
 * `stage.name` is the decoded, *unsanitized* segment: run it through
 * `sanitizeFileName` before it names anything.
 */
export type FilesRoute =
  | { route: "stage"; name: string }
  | { route: "commit"; id: string }
  | { route: "requests" }
  | { route: "request"; id: string }
  | { route: "fulfil"; id: string }
  | { route: "requestSecret"; id: string }
  | { route: "requestDecline"; id: string }
  | { route: "list" }
  | { route: "entry"; id: string }
  | { route: "delete"; id: string }
  | { route: "content"; id: string };

/** Split a request target into its path segments, decoded. `null` on a malformed escape. */
function pathSegments(target: string): string[] | null {
  const q = target.indexOf("?");
  const path = q < 0 ? target : target.slice(0, q);
  if (!path.startsWith("/")) return null;
  const raw = path.slice(1).split("/");
  try {
    return raw.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** An inbox or outbox entry: an uploaded file or a share. */
function isEntryId(id: string): boolean {
  return isFileId(id) || isShareId(id);
}

/**
 * Parse a tailnet files request. `target` is a pathname, optionally with a
 * query (ignored here).
 */
export function matchFilesRoute(method: string, target: string): FilesRoute | null {
  const parts = pathSegments(target);
  if (parts === null || parts[0] !== "files") return null;
  const m = method.toUpperCase();
  const [, a, b, c] = parts;
  switch (parts.length) {
    case 1:
      return m === "GET" ? { route: "list" } : null;
    case 2:
      if (a === "requests") return m === "GET" ? { route: "requests" } : null;
      if (a === undefined || !isEntryId(a)) return null;
      if (m === "GET") return { route: "entry", id: a };
      if (m === "DELETE") return { route: "delete", id: a };
      return null;
    case 3:
      if (a === "stage") {
        return m === "PUT" && b !== undefined && b !== "" ? { route: "stage", name: b } : null;
      }
      if (a === "requests") {
        if (b === undefined || !isRequestId(b)) return null;
        if (m === "GET") return { route: "request", id: b };
        if (m === "PUT") return { route: "fulfil", id: b };
        return null;
      }
      if (a === undefined) return null;
      if (b === "commit") return m === "POST" && isFileId(a) ? { route: "commit", id: a } : null;
      if (b === "content") return m === "GET" && isEntryId(a) ? { route: "content", id: a } : null;
      return null;
    case 4:
      if (a !== "requests" || b === undefined || !isRequestId(b) || m !== "POST") return null;
      if (c === "secret") return { route: "requestSecret", id: b };
      if (c === "decline") return { route: "requestDecline", id: b };
      return null;
    default:
      return null;
  }
}

// --- Local socket routes ----------------------------------------------------

/**
 * hermeticd's local socket for the Hermes plugin. Only the `hermes` uid may
 * connect (peer credentials). It never accepts upload bytes, so the agent can
 * never fulfil its own request.
 *
 * `/run/hermetic` is mode 0711 so `hermes` can traverse to the socket without
 * listing the directory or reaching anything else in it.
 */
export const FILES_SOCKET_PATH = "/run/hermetic/files.sock";

/** The socket routes. `wait` clamps its `s` to `[0, FILES_TTL.waitMax]`. */
export const FILES_SOCKET_ROUTES = {
  /** GET: version handshake (`FilesHello`). */
  hello: "/hello",
  /** POST: open a request slot (`OpenFileRequestBody`). */
  openRequest: "/requests",
  /** GET: the slot's current state (`FileWaitResult`, never blocking). */
  request: (id: string) => `/requests/${seg(id)}`,
  /** GET: long-poll until the slot leaves `open`/`receiving` or `s` seconds pass. */
  wait: (id: string, s: number) => `/requests/${seg(id)}/wait?s=${Math.trunc(s)}`,
  /** POST: the agent has read an ephemeral secret; hermeticd deletes it. */
  consume: (id: string) => `/requests/${seg(id)}/consume`,
  /** POST: share a file to the operator (`ShareFileBody`). */
  outbox: "/outbox",
  /** GET: inbox, open requests and outbox, metadata only. */
  files: "/files",
} as const;

export type FilesSocketRoute =
  | { route: "hello" }
  | { route: "openRequest" }
  | { route: "request"; id: string }
  | { route: "wait"; id: string; s: number }
  | { route: "consume"; id: string }
  | { route: "outbox" }
  | { route: "files" };

/** `s` from a wait target's query: absent or unreadable is the default, then clamped. */
function waitSeconds(target: string): number {
  const q = target.indexOf("?");
  if (q < 0) return FILES_TTL.waitDefault;
  for (const pair of target.slice(q + 1).split("&")) {
    const [k, v] = pair.split("=");
    if (k !== "s" || v === undefined || !/^\d{1,6}$/.test(v)) continue;
    return Math.min(Number(v), FILES_TTL.waitMax);
  }
  return FILES_TTL.waitDefault;
}

/** Parse a socket request. `target` is a pathname, optionally with a query. */
export function matchSocketRoute(method: string, target: string): FilesSocketRoute | null {
  const parts = pathSegments(target);
  if (parts === null) return null;
  const m = method.toUpperCase();
  const [a, b, c] = parts;
  if (parts.length === 1) {
    if (a === "hello") return m === "GET" ? { route: "hello" } : null;
    if (a === "requests") return m === "POST" ? { route: "openRequest" } : null;
    if (a === "outbox") return m === "POST" ? { route: "outbox" } : null;
    if (a === "files") return m === "GET" ? { route: "files" } : null;
    return null;
  }
  if (a !== "requests" || b === undefined || !isRequestId(b)) return null;
  if (parts.length === 2) return m === "GET" ? { route: "request", id: b } : null;
  if (parts.length !== 3) return null;
  if (c === "wait") return m === "GET" ? { route: "wait", id: b, s: waitSeconds(target) } : null;
  if (c === "consume") return m === "POST" ? { route: "consume", id: b } : null;
  return null;
}

// --- Headers and digests ----------------------------------------------------

/** RFC 9530 `Content-Digest`, required on every upload. */
export const CONTENT_DIGEST_HEADER = "content-digest";
/** Optional on a stage: the chat session the upload is for. */
export const FILES_SESSION_HEADER = "x-hermetic-session";
/**
 * Optional on a request fulfil: the file's name, URL-encoded
 * (`encodeURIComponent`). A stage takes its name from the path instead. Absent,
 * the box falls back to the request's `name_hint`, then to `upload`; either
 * way the name goes through `sanitizeFileName`.
 */
export const FILES_NAME_HEADER = "x-hermetic-filename";
/**
 * `1` on an upload the operator has confirmed is not a secret. Without it,
 * private key material (`looksLikeKeyMaterial`) is refused on a stage
 * (`FILE_LOOKS_SECRET`) and, on a request fulfil, stored as an ephemeral secret
 * instead of on the data volume (D6).
 */
export const FILES_NOT_SECRET_HEADER = "x-hermetic-not-secret";
/**
 * On a text-secret fulfil (`PUT /files/requests/:id` for a `secret_text`
 * slot): the operator's "Treat as" choice, `auto`, `raw` or `dotenv`
 * (`SECRET_TEXT_AS`). hermeticd parses the body with it, authoritatively.
 * Absent means `auto`.
 */
export const FILES_SECRET_AS_HEADER = "x-hermetic-secret-as";

const HEX_RE = /^[0-9a-f]{64}$/;

/** `sha-256=:<base64>:` from a lowercase or uppercase hex SHA-256 (RFC 9530). */
export function formatContentDigest(sha256Hex: string): string {
  const hex = sha256Hex.toLowerCase();
  if (!HEX_RE.test(hex))
    throw new HermeticError("VALIDATION", "formatContentDigest: not a SHA-256 hex digest");
  let bin = "";
  for (let i = 0; i < 64; i += 2) bin += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return `sha-256=:${btoa(bin)}:`;
}

/**
 * The SHA-256 a `Content-Digest` header carries, as lowercase hex, or `null`.
 * Other algorithms may be listed alongside and are ignored; only `sha-256`
 * counts, and it must decode to exactly 32 bytes.
 */
export function parseContentDigest(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const member of header.split(",")) {
    const eq = member.indexOf("=");
    if (eq < 0) continue;
    if (member.slice(0, eq).trim().toLowerCase() !== "sha-256") continue;
    // Drop any structured-field parameters after the byte sequence.
    const value = (member.slice(eq + 1).split(";")[0] ?? "").trim();
    if (value.length < 2 || !value.startsWith(":") || !value.endsWith(":")) return null;
    let bin: string;
    try {
      bin = atob(value.slice(1, -1));
    } catch {
      return null;
    }
    if (bin.length !== 32) return null;
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex;
  }
  return null;
}

// --- File names -------------------------------------------------------------

export type FileNameRejection =
  | "empty"
  | "dot_segment"
  | "control_char"
  | "bidi_control"
  | "leading_dot"
  | "trailing_dot_or_space"
  | "reserved_name"
  | "too_long";

export type SanitizedFileName = { ok: true; name: string } | { ok: false; reason: FileNameRejection };

/** C0, DEL and C1 controls. NUL is one of them. */
function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

/** Bidi overrides, embeddings, isolates and marks: the `‮txt.exe` trick. */
function isBidiControl(cp: number): boolean {
  return (
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0x200e ||
    cp === 0x200f ||
    cp === 0x061c
  );
}

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Turn a name from the operator (or the agent) into one safe to create on the
 * box and to show in a UI, or say why not. Used on both sides of every upload:
 * the laptop checks before sending, hermeticd checks again before writing.
 *
 * NFC-normalised; the basename only (the last segment after `/` or `\`), so
 * `../x` becomes `x`. Rejected: empty, `.`/`..`, any control character
 * (including NUL) or bidi control anywhere in the input, a leading dot (`.env`,
 * so nothing lands hidden), a trailing dot or space, a Windows reserved stem
 * (`CON`, `com1.txt`), more than `FILES_LIMITS.nameBytes` UTF-8 bytes.
 */
export function sanitizeFileName(raw: string): SanitizedFileName {
  const nfc = raw.normalize("NFC");
  for (const ch of nfc) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isControl(cp)) return { ok: false, reason: "control_char" };
    if (isBidiControl(cp)) return { ok: false, reason: "bidi_control" };
  }
  const name = nfc.split(/[/\\]/).pop() ?? "";
  if (name === "") return { ok: false, reason: "empty" };
  if (name === "." || name === "..") return { ok: false, reason: "dot_segment" };
  if (name.startsWith(".")) return { ok: false, reason: "leading_dot" };
  if (name.endsWith(".") || name.endsWith(" ")) return { ok: false, reason: "trailing_dot_or_space" };
  if (WINDOWS_RESERVED_RE.test(name)) return { ok: false, reason: "reserved_name" };
  if (new TextEncoder().encode(name).length > FILES_LIMITS.nameBytes) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, name };
}

// --- Content sniffing -------------------------------------------------------

const RASTER_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The raster types Hermes's image tool takes. SVG is not one of them. */
export function isImageMime(mime: string): boolean {
  return RASTER_IMAGE_MIMES.has(mime.toLowerCase().split(";")[0]?.trim() ?? "");
}

/** Lowercase extension with its dot (`.pem`), or `""`. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function startsWithBytes(head: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (head.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (head[at + i] !== sig[i]) return false;
  return true;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** The head as Latin-1, for marker searches that must not throw on binary. */
function latin1(head: Uint8Array): string {
  let s = "";
  for (const b of head) s += String.fromCharCode(b);
  return s;
}

/**
 * Whether the head reads as UTF-8 text: decodes strictly (allowing a sequence
 * cut off at the end of the head) and holds no control characters beyond tab,
 * newline, carriage return and form feed.
 */
function isUtf8Text(head: Uint8Array): boolean {
  // Up to three trailing bytes may be the start of a character the read cut in half.
  for (let trim = 0; trim <= 3 && trim <= head.length; trim++) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - trim));
    } catch {
      continue;
    }
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0c) continue;
      if (isControl(cp)) return false;
    }
    return true;
  }
  return false;
}

/** Text types an extension may name, once the bytes have already proven to be text. */
const TEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".md": "text/markdown",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".toml": "application/toml",
};

const PEM_BEGIN_RE = /^\s*-----BEGIN [A-Z0-9 ]+-----/;

/**
 * The type of a file from its first bytes (`FILES_LIMITS.sniffBytes` is
 * plenty). Magic numbers decide; the extension only breaks ties between text
 * types, and never makes anything an image. PKCS#12 has no magic of its own, so
 * a DER sequence is called one only under a `.p12`/`.pfx` name.
 */
export function sniffMime(head: Uint8Array, name: string): string {
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(head, ascii("GIF87a")) || startsWithBytes(head, ascii("GIF89a"))) {
    return "image/gif";
  }
  if (startsWithBytes(head, ascii("RIFF")) && startsWithBytes(head, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  if (startsWithBytes(head, ascii("%PDF-"))) return "application/pdf";
  if (
    startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(head, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(head, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  if (startsWithBytes(head, [0x1f, 0x8b])) return "application/gzip";
  const ext = extensionOf(name);
  if ((ext === ".p12" || ext === ".pfx") && head[0] === 0x30) return "application/x-pkcs12";
  if (isUtf8Text(head)) {
    // PEM armour covers certificates, keys and OpenSSH private keys alike.
    if (PEM_BEGIN_RE.test(latin1(head.subarray(0, 256)).replace(/^﻿|^\xEF\xBB\xBF/, ""))) {
      return "application/x-pem-file";
    }
    return TEXT_EXTENSIONS[ext] ?? "text/plain";
  }
  return "application/octet-stream";
}

const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

/**
 * Whether a file looks like private key material, so hermeticd stores it as a
 * secret unless the operator overrides (D6): a PEM `PRIVATE KEY` block of any
 * flavour (RSA, EC, ENCRYPTED, OPENSSH, PGP), a DER sequence under a
 * `.p12`/`.pfx`/`.key` name, or a `.pem`/`.key` whose head says so.
 */
export function looksLikeKeyMaterial(head: Uint8Array, name: string): boolean {
  if (PRIVATE_KEY_RE.test(latin1(head))) return true;
  const ext = extensionOf(name);
  if ((ext === ".p12" || ext === ".pfx" || ext === ".key") && head[0] === 0x30 && !isUtf8Text(head)) {
    return true;
  }
  return false;
}

/**
 * Whether a file satisfies a request's `accept` list. Empty accepts anything.
 * An entry is `.ext` (a case-insensitive suffix of the name) or a MIME type,
 * `type/sub` or `type/*`, compared against the *sniffed* type.
 */
export function acceptMatches(accept: readonly string[], name: string, mime: string): boolean {
  if (accept.length === 0) return true;
  const lowerName = name.toLowerCase();
  const lowerMime = (mime.split(";")[0] ?? "").trim().toLowerCase();
  for (const raw of accept) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry.startsWith(".")) {
      if (lowerName.endsWith(entry)) return true;
      continue;
    }
    if (entry === "*/*") return true;
    if (entry.endsWith("/*")) {
      if (lowerMime.startsWith(entry.slice(0, -1))) return true;
      continue;
    }
    if (entry === lowerMime) return true;
  }
  return false;
}

// --- Secret slots -----------------------------------------------------------

/**
 * The name a request is answered under (`files.put`): the last segment of the
 * agent's `name_hint` (`~/keys/deploy.pem` → `deploy.pem`), sanitized as the
 * box would, else the dropped file's own (already sanitized) name. The box
 * re-runs the accept check and the key sniff (D6) against the name it is
 * sent, and both read the extension, so the hint is used only when it has the
 * dropped file's extension and passes the accept list itself: what was checked
 * on the laptop is then what the box checks. A hint with another extension
 * (`cert` for a dropped `client.p12`, which only its extension marks as key
 * material), or none the box would take, gives way to the dropped name. The
 * request card previews the same rule, so what it says is what `put` sends.
 */
export function requestFileName(
  slot: { name_hint?: string | undefined; accept: readonly string[] },
  dropped: string,
  mime: string,
): string {
  const hint = slot.name_hint?.split(/[/\\]/).pop() ?? "";
  if (hint === "") return dropped;
  const clean = sanitizeFileName(hint);
  if (!clean.ok) return dropped;
  if (extensionOf(clean.name) !== extensionOf(dropped)) return dropped;
  return acceptMatches(slot.accept, clean.name, mime) ? clean.name : dropped;
}

/** A durable file secret's SSM slot under the agent: `file-<slug>`, slug ≤ 48. */
export const FILE_SECRET_SLOT_RE = /^file-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** A durable text (KEY=value) secret's SSM slot: `env-<slug>`, slug ≤ 48. */
export const ENV_SECRET_SLOT_RE = /^env-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

const SLUG_MAX = 48;

/** Lowercase, non-alphanumerics to single dashes, trimmed, ≤ 48; `secret` if nothing is left. */
function slotSlug(name: string): string {
  const slug = trimDashes(
    trimDashes(name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, SLUG_MAX),
  );
  return slug === "" ? "secret" : slug;
}

/** Strips leading and trailing `-` in one linear pass (a `-+$` regex backtracks quadratically on a long dash run). */
function trimDashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 45) start++;
  while (end > start && s.charCodeAt(end - 1) === 45) end--;
  return s.slice(start, end);
}

/** The SSM slot for a durable file secret named `name`: `github-app.pem` → `file-github-app-pem`. */
export function fileSecretSlot(name: string): string {
  return `file-${slotSlug(name)}`;
}
/** The SSM slot for a durable text secret: `Stripe keys` → `env-stripe-keys`. */
export function envSecretSlot(name: string): string {
  return `env-${slotSlug(name)}`;
}

/** What a key name's tail says about it rather than what it is for; dropped from a derived slug, longest first. */
const SECRET_TEXT_SLUG_SUFFIXES = [
  "-api-token",
  "-api-key",
  "-access-token",
  "-access-key",
  "-secret-key",
  "-password",
  "-passwd",
  "-secret",
  "-token",
  "-key",
] as const;

/**
 * The stem a `request_secret` is stored under: `<slug>.env` on tmpfs and, when
 * durable, the `env-<slug>` SSM slot, which `secretSlotFileName` maps back to
 * the same file. A given `slug` is slugged like a slot name (a trailing `.env`
 * dropped first); without one, `keys[0]` is lower-cased with `_` as `-` and one
 * credential suffix dropped, so `GITHUB_TOKEN` → `github`, `OPENAI_API_KEY` →
 * `openai`, `DATABASE_URL` → `database-url`. A key that is nothing but a
 * suffix keeps it (`TOKEN` → `token`). Always a valid slot slug.
 */
export function secretTextSlug(keys: readonly string[], slug?: string): string {
  if (slug !== undefined && slug.trim() !== "") return slotSlug(slug.trim().replace(/\.env$/i, ""));
  const base = slotSlug(keys[0] ?? "");
  for (const suffix of SECRET_TEXT_SLUG_SUFFIXES) {
    if (base.length > suffix.length && base.endsWith(suffix)) {
      return slotSlug(base.slice(0, -suffix.length));
    }
  }
  return base;
}

export function isFileSecretSlot(slot: string): boolean {
  return FILE_SECRET_SLOT_RE.test(slot);
}
export function isEnvSecretSlot(slot: string): boolean {
  return ENV_SECRET_SLOT_RE.test(slot);
}

/**
 * The file a durable slot materialises to under `FILES_SECRET_DIR`, or `null`
 * for something that is not a slot. An env slot is `<slug>.env`. A file slot is
 * its bare slug. The env mapping is exact and the box holds it to that: an
 * `env-<slug>` envelope must name `<slug>.env`, which is the file
 * `request_secret` reports (`secretTextSlug`). A file slot's slug is lossy (`file-github-app-pem` does not say whether
 * the name was `github-app.pem` or `github_app.pem`), so a file slot's original
 * name travels separately — in hermeticd's index and the SSM parameter's
 * description — and is the name the agent is shown.
 */
export function secretSlotFileName(slot: string): string | null {
  if (isEnvSecretSlot(slot)) return `${slot.slice("env-".length)}.env`;
  if (isFileSecretSlot(slot)) return slot.slice("file-".length);
  return null;
}

// --- Durable secret envelope ------------------------------------------------

/**
 * The most a durable secret's SSM value may hold: the standard tier's 4 KB.
 * This, not `FILES_LIMITS.secretDurableBytes`, is the real cap — the envelope
 * spends some of it on the name, the digest and base64's 4/3 — so check
 * `secretEnvelopeFits` before writing. Measured in UTF-8 bytes, which is never
 * less than the character count SSM documents, so a fit here fits there.
 */
export const SECRET_ENVELOPE_MAX_CHARS = 4096;

/** A durable secret as it travels laptop → SSM SecureString → hermeticd. */
export type SecretEnvelope = { name: string; bytes: Uint8Array; sha256: string };

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** The envelope's JSON. Key order is fixed, so `secretEnvelopeFits` can size it without the bytes. */
function envelopeJson(name: string, sha256: string, b64: string): string {
  return JSON.stringify({ v: 1, name, sha256, b64 });
}

/**
 * `{"v":1,"name":…,"sha256":…,"b64":…}`: the JSON envelope a durable secret is
 * stored as, so the box learns the original file name and digest and binary
 * content (a DER key) survives a string-typed parameter. The caller passes the
 * SHA-256 hex it computed, because shared code has no synchronous hash; the box
 * re-hashes the decoded bytes and compares. Throws on a digest that is not hex.
 */
export function encodeSecretEnvelope(envelope: SecretEnvelope): string {
  const sha256 = envelope.sha256.toLowerCase();
  if (!HEX_RE.test(sha256))
    throw new HermeticError("VALIDATION", "encodeSecretEnvelope: not a SHA-256 hex digest");
  return envelopeJson(envelope.name, sha256, bytesToBase64(envelope.bytes));
}

/**
 * The envelope `text` holds, or `null`: wrong version, a name `sanitizeFileName`
 * would change or reject, a digest that is not hex, or base64 that does not
 * decode. Does *not* check the digest against the bytes — the caller hashes.
 */
export function decodeSecretEnvelope(text: string): SecretEnvelope | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const { v, name, sha256, b64 } = doc as Record<string, unknown>;
  if (v !== 1 || typeof name !== "string" || typeof sha256 !== "string" || typeof b64 !== "string") {
    return null;
  }
  const clean = sanitizeFileName(name);
  if (!clean.ok || clean.name !== name || !HEX_RE.test(sha256)) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { name, bytes, sha256 };
}

/** Whether a secret of `byteLength` bytes named `name` encodes within `SECRET_ENVELOPE_MAX_CHARS`. */
export function secretEnvelopeFits(name: string, byteLength: number): boolean {
  const frame = new TextEncoder().encode(envelopeJson(name, "0".repeat(64), "")).length;
  return frame + 4 * Math.ceil(byteLength / 3) <= SECRET_ENVELOPE_MAX_CHARS;
}

// --- Errors -----------------------------------------------------------------

/** Every code a files route may answer with, in a `FilesErrorBody`. */
export const FILES_ERROR_CODES = [
  "VALIDATION",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL",
  "FILE_NAME_INVALID",
  "FILE_TOO_LARGE",
  "FILE_TYPE_REJECTED",
  "FILE_DIGEST_MISMATCH",
  "FILE_NOT_FOUND",
  "FILE_REQUEST_FULFILLED",
  "FILE_REQUEST_CLOSED",
  "FILE_REQUEST_EXPIRED",
  "FILE_SECRET_FORBIDDEN",
  "FILE_LOOKS_SECRET",
  "DISK_FULL",
] as const satisfies readonly ErrorCode[];
export type FilesErrorCode = (typeof FILES_ERROR_CODES)[number];

/** The HTTP status hermeticd answers each files error with. */
export const FILES_HTTP_STATUS: Readonly<Record<FilesErrorCode, number>> = {
  VALIDATION: 400,
  FILE_NAME_INVALID: 400,
  FORBIDDEN: 403,
  FILE_SECRET_FORBIDDEN: 403,
  NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  CONFLICT: 409,
  FILE_REQUEST_FULFILLED: 409,
  FILE_REQUEST_CLOSED: 409,
  FILE_LOOKS_SECRET: 409,
  FILE_REQUEST_EXPIRED: 410,
  FILE_TOO_LARGE: 413,
  FILE_TYPE_REJECTED: 415,
  FILE_DIGEST_MISMATCH: 422,
  INTERNAL: 500,
  DISK_FULL: 507,
};

/** `FILES_HTTP_STATUS[code]`, or 500 for a code the files routes do not use. */
export function filesHttpStatus(code: string): number {
  return (FILES_HTTP_STATUS as Readonly<Record<string, number>>)[code] ?? 500;
}

// --- Outbox MEDIA lines ------------------------------------------------------

/** The tag Hermes reads a delivered file from: one `MEDIA:<abs path>` per line. */
export const MEDIA_TAG = "MEDIA:";

/** An outbox share named by a `MEDIA:` line. */
export interface OutboxMediaRef {
  readonly share_id: string;
  readonly name: string;
}

/**
 * The share a line names, when the line is exactly
 * `MEDIA:${FILES_OUTBOX_DIR}/<sh_…>/<name>` — the form the files plugin
 * rewrites a shared `MEDIA:` line into — or `null` for anything else, which
 * stays plain text. Surrounding whitespace is ignored; nothing else is: a
 * second path segment, a name `sanitizeFileName` would change, or a share id
 * of the wrong shape is not an outbox line. One parser, so core (mapping a
 * reply to attachment chips) and the UI agree on which lines those are.
 */
export function parseOutboxMediaLine(line: string): OutboxMediaRef | null {
  const text = line.trim();
  const prefix = `${MEDIA_TAG}${FILES_OUTBOX_DIR}/`;
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  const cut = rest.indexOf("/");
  if (cut < 0) return null;
  const share_id = rest.slice(0, cut);
  const name = rest.slice(cut + 1);
  if (!isShareId(share_id) || name.includes("/")) return null;
  const clean = sanitizeFileName(name);
  if (!clean.ok || clean.name !== name) return null;
  return { share_id, name };
}

/** An outbox entry's path relative to `HERMES_HOME`: `outbox/<sh_…>/<name>`. */
export function outboxRelPath(share_id: string, name: string): string {
  return `outbox/${share_id}/${name}`;
}
