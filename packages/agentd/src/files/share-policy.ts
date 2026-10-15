/**
 * Which paths the agent may share (`share_file`, socket `POST /outbox`), as
 * pure functions over an absolute, normalised path. `outbox.ts` runs them
 * twice: on the path as the agent wrote it, and on the path `realpath`
 * resolved as hermes — so a symlink or a `..` present at the check cannot walk
 * a share out of bounds or into a credential. The copy then reads the
 * resolved path afresh, so an account that swaps a component between the
 * check and the read can still redirect it; the read is as hermes, so that
 * reaches nothing the account could not already read and copy itself, and the
 * key-material sniff still runs on the bytes actually copied.
 *
 * An allowlist first: only a file under the account's home, `/data/hermes`,
 * and not one already in the outbox. Everything a box keeps elsewhere — the
 * tmpfs secrets under `/run/hermetic`, `/etc`, hermeticd's own state — is out
 * by construction.
 *
 * Then a credential denylist inside that root. Ported from upstream Hermes's
 * outbound-media guard, `validate_media_delivery_path`
 * (`gateway/platforms/base.py`): its `_ROOT_CREDENTIAL_PATHS` (credential
 * stores at `$HERMES_HOME`, and at every profile under it) and
 * `_MEDIA_DELIVERY_DENIED_HOME_SUBPATHS` (credential directories under the
 * home); widened with `agent/file_safety.py`'s `build_write_denied_paths`
 * basenames (`.netrc`, `.pgpass`, `.npmrc`, `.pypirc`, `.git-credentials`,
 * SSH identities) and `hermes_cli/web_routers/files.py`'s
 * `_is_sensitive_filename` (`.env`, `.env.*`, `.envrc`, matched in any
 * directory, case-insensitively) and `_SENSITIVE_MANAGED_DIR_NAMES`
 * (`mcp-tokens`, `pairing`, as any component). The control-character refusal
 * is `tools/path_security.py`'s `has_unsafe_path_chars`. hermetic adds its own:
 * key and certificate extensions anywhere (`.pem`, `.key`, `.p12`, `.pfx`) and
 * the browser profiles under `/data/hermes/browser` (cookies, logins).
 *
 * Like upstream's, this is defence in depth and not the only line: the
 * account can read these files and could copy one somewhere innocent first.
 * The content check in `outbox.ts` (`looksLikeKeyMaterial` on the head of
 * whatever is actually copied) is the part that does not depend on the name.
 */
import { posix } from "node:path";
import {
  FILES_DROP_DIR,
  FILES_OUTBOX_DIR,
  FILES_SECRET_DIR,
  HERMES_ACCOUNT_HOME,
  HERMES_HOME,
} from "@hermetic/core/shared";
import { FilesError } from "./errors.ts";

/** Control characters and Unicode line separators (`has_unsafe_path_chars`). */
function hasUnsafePathChars(path: string): boolean {
  for (const ch of path) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f || cp === 0x85 || cp === 0x2028 || cp === 0x2029) return true;
  }
  return false;
}

/** Upstream's `_ROOT_CREDENTIAL_PATHS`, relative to `$HERMES_HOME` and to each profile. */
const sqlite = (name: string): string[] => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`];
const HERMES_CREDENTIAL_PATHS: readonly string[] = [
  ".env",
  "auth.json",
  "auth.lock",
  "credentials",
  "config.yaml",
  ".anthropic_oauth.json",
  "google_token.json",
  "google_oauth_pending.json",
  "auth/google_oauth.json",
  "webhook_subscriptions.json",
  "cache/bws_cache.json",
  "cache/bws_cache.enc.json",
  "pairing",
  "mcp-tokens",
  "sessions",
  "browser-profile",
  ...sqlite("state.db"),
  ...sqlite("kanban.db"),
];

/** Under the account's home: upstream's home subpaths, plus hermetic's browser profiles. */
const HOME_CREDENTIAL_PATHS: readonly string[] = [".config", "browser", "Library/Keychains"];

/** A component anywhere in the path that makes the whole path a credential. */
const CREDENTIAL_COMPONENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".gcloud",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".envrc",
  "mcp-tokens",
  "pairing",
]);

/** SSH identities by their default names; the public half (`.pub`) is not a secret. */
const SSH_IDENTITY_RE = /^id_(?:rsa|dsa|ecdsa|ecdsa_sk|ed25519|ed25519_sk|xmss)(?:[._-].*)?$/;
const KEY_EXTENSIONS: readonly string[] = [".pem", ".key", ".p12", ".pfx"];

/** `path` is `root` or lies below it. Both absolute and normalised. */
export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Every `$HERMES_HOME`-shaped root a credential store may sit in: the home and each profile. */
function hermesRoots(path: string): string[] {
  const roots = [HERMES_HOME];
  const profiles = `${HERMES_HOME}/profiles/`;
  if (path.startsWith(profiles)) {
    const name = path.slice(profiles.length).split("/")[0];
    if (name) roots.push(`${profiles}${name}`);
  }
  return roots;
}

/** Whether a normalised absolute path names a credential: any rule above. */
export function isCredentialPath(path: string): boolean {
  const parts = path.split("/").filter((p) => p !== "");
  for (const raw of parts) {
    const part = raw.toLowerCase();
    if (part === ".env" || part.startsWith(".env.")) return true;
    if (CREDENTIAL_COMPONENTS.has(part)) return true;
  }
  const base = (parts[parts.length - 1] ?? "").toLowerCase();
  if (SSH_IDENTITY_RE.test(base) && !base.endsWith(".pub")) return true;
  if (KEY_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  for (const rel of HOME_CREDENTIAL_PATHS) {
    if (isUnder(path, `${HERMES_ACCOUNT_HOME}/${rel}`)) return true;
  }
  for (const root of hermesRoots(path)) {
    for (const rel of HERMES_CREDENTIAL_PATHS) {
      if (isUnder(path, `${root}/${rel}`)) return true;
    }
  }
  return false;
}

function refused(code: string, why: string): FilesError {
  return new FilesError(code, `share refused: ${why}`);
}

/**
 * The path as the agent wrote it, checked and normalised: absolute, free of
 * control characters, `.` and `..` folded lexically. Nothing on disk is
 * consulted.
 */
export function normaliseSharePath(raw: string): string {
  if (hasUnsafePathChars(raw)) {
    throw refused("VALIDATION", "the path contains control characters");
  }
  if (!raw.startsWith("/")) throw refused("VALIDATION", "the path must be absolute");
  const normal = posix.normalize(raw);
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

/**
 * Refuse a path the agent may not share, with the reason the tool hands back.
 * Run on the written path and again on the resolved one; never touches disk.
 */
export function checkSharePath(path: string): void {
  if (
    isUnder(path, "/run/hermetic") ||
    isUnder(path, FILES_SECRET_DIR) ||
    isUnder(path, FILES_DROP_DIR)
  ) {
    throw refused("FILE_SECRET_FORBIDDEN", "secret files never leave the box");
  }
  if (!path.startsWith(`${HERMES_ACCOUNT_HOME}/`)) {
    throw refused("FORBIDDEN", `only files under ${HERMES_ACCOUNT_HOME} can be shared`);
  }
  if (isUnder(path, FILES_OUTBOX_DIR)) {
    throw refused("CONFLICT", "that file is already a share");
  }
  if (isCredentialPath(path)) throw refused("FORBIDDEN", "credential path");
}
