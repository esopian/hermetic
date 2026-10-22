/**
 * The desktop app's update signature: what the release workflow signs and what
 * the app checks before it installs a downloaded build (§3.6).
 *
 * Electrobun's updater checks a release by HTTPS alone (its manifest `hash` is a
 * cache key, not a digest), so this is the only thing standing between "can
 * publish a GitHub release asset" and "can replace the app on every install".
 * The release workflow signs each update with the Ed25519 private key held as
 * the `UPDATE_SIGNING_KEY` repository secret (`scripts/sign-update.ts`); the
 * public half is compiled in below. Nothing about it is OS-specific.
 *
 * What is signed is a short text statement rather than the archive itself:
 * the update's identity (app, channel, platform, arch, version, Electrobun
 * hash) and the SHA-256 of the *decompressed* `.tar`. The decompressed tar is
 * what both of Electrobun's download paths end in — the full `.tar.zst`, or a
 * chain of delta patches that rebuilds the same bytes — so one signature
 * covers both. Binding the version means an older signed build cannot be
 * replayed as a newer one.
 *
 * Here rather than in the app package so the signing script, which may import
 * only core (`tests/boundaries.test.ts`), and the app share one format and one
 * key.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { HermeticError } from "../errors.ts";

/**
 * The update-signing public key: Ed25519, SPKI DER, base64. Rotating it means
 * a new key pair, this constant and the `UPDATE_SIGNING_KEY` secret changed
 * together, and every install older than the rotation updating by hand once
 * (CONTRIBUTING.md "Update signing").
 */
export const APP_UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEAgvWgqD9r4NKZdzLtuJILS5pVLkF/mUKU706QigfevH0=";

/** One platform's update, as Electrobun's `*-update.json` names it. */
export interface AppUpdateTarget {
  identifier: string;
  channel: string;
  platform: string;
  arch: string;
  version: string;
  hash: string;
}

const FIELDS = ["identifier", "channel", "platform", "arch", "version", "hash"] as const;

/** Every field becomes a line and a file-name part, so it may hold nothing that could split either. */
const SAFE = /^[A-Za-z0-9._+-]{1,64}$/;

function checked(target: AppUpdateTarget): AppUpdateTarget {
  for (const field of FIELDS) {
    if (!SAFE.test(target[field]))
      throw new HermeticError("VALIDATION", `update ${field} is not a plain token`);
  }
  return target;
}

/** The release asset holding the signature, next to `<channel>-<platform>-<arch>-update.json`. */
export function appUpdateSignatureFile(target: AppUpdateTarget): string {
  const t = checked(target);
  return `${t.channel}-${t.platform}-${t.arch}-${t.hash}.sig`;
}

/** The exact bytes signed. */
export function appUpdateSignedMessage(target: AppUpdateTarget, tarSha256: string): string {
  const t = checked(target);
  if (!/^[0-9a-f]{64}$/.test(tarSha256))
    throw new HermeticError("VALIDATION", "tar digest is not a SHA-256 hex string");
  const lines = [
    "hermetic-app-update-v1",
    ...FIELDS.map((f) => `${f}=${t[f]}`),
    `tar-sha256=${tarSha256}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Signs one update; the signature is base64, the asset's whole content. */
export function signAppUpdate(
  privateKeyPem: string,
  target: AppUpdateTarget,
  tarSha256: string,
): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new HermeticError("VALIDATION", "update signing key is not Ed25519");
  return sign(null, Buffer.from(appUpdateSignedMessage(target, tarSha256)), key).toString("base64");
}

/**
 * Whether `signature` is the release key's over this update and digest. False
 * for anything malformed, never a throw: every failure means the same thing to
 * the caller — do not install this.
 */
export function verifyAppUpdate(
  signature: string,
  target: AppUpdateTarget,
  tarSha256: string,
  publicKey: string = APP_UPDATE_PUBLIC_KEY,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    const raw = Buffer.from(signature.trim(), "base64");
    if (raw.length !== 64) return false;
    return verify(null, Buffer.from(appUpdateSignedMessage(target, tarSha256)), key, raw);
  } catch {
    return false;
  }
}

/** SHA-256 of a file, streamed: an app tar is a few hundred MB. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}
