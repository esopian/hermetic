/**
 * Signs the desktop app's update artifacts, in the release workflow, before
 * they are published: `bun scripts/sign-update.ts packages/app/artifacts`.
 *
 * For every `*-update.json` Electrobun wrote, decompress the `.tar.zst` it
 * names, hash the tar, and write `<channel>-<platform>-<arch>-<hash>.sig` next
 * to it (`packages/core/src/release/app-update-signature.ts` holds the format).
 * The app downloads that file and refuses to install a build it does not
 * verify against the public key it was built with.
 *
 * The private key arrives only as `UPDATE_SIGNING_KEY` (a repository secret)
 * and is never written or printed. Each signature is checked against the
 * compiled-in public key before it is written, so a secret that does not match
 * the key in the source fails the release here instead of shipping updates no
 * installed app can verify. No manifest at all fails it too.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appUpdateSignatureFile,
  signAppUpdate,
  verifyAppUpdate,
} from "../packages/core/src/release/app-update-signature.ts";

const dir = process.argv[2];
const key = process.env["UPDATE_SIGNING_KEY"] ?? "";
if (dir === undefined) throw new Error("usage: bun scripts/sign-update.ts <artifacts-dir>");
if (key === "") throw new Error('UPDATE_SIGNING_KEY is not set (CONTRIBUTING.md "Update signing")');

const manifests = readdirSync(dir).filter((f) => f.endsWith("-update.json"));
if (manifests.length === 0) throw new Error(`no *-update.json in ${dir}; nothing to sign`);

for (const name of manifests) {
  const manifest = (await Bun.file(join(dir, name)).json()) as {
    identifier: string;
    channel: string;
    platform: string;
    arch: string;
    version: string;
    hash: string;
    artifact: { file: string };
  };
  const tar = Bun.zstdDecompressSync(await Bun.file(join(dir, manifest.artifact.file)).bytes());
  const digest = new Bun.CryptoHasher("sha256").update(tar).digest("hex");
  const target = {
    identifier: manifest.identifier,
    channel: manifest.channel,
    platform: manifest.platform,
    arch: manifest.arch,
    version: manifest.version,
    hash: manifest.hash,
  };
  const signature = signAppUpdate(key, target, digest);
  if (!verifyAppUpdate(signature, target, digest)) {
    throw new Error("UPDATE_SIGNING_KEY does not match APP_UPDATE_PUBLIC_KEY; refusing to sign");
  }
  const out = appUpdateSignatureFile(target);
  writeFileSync(join(dir, out), `${signature}\n`);
  console.log(`signed ${manifest.artifact.file} (${manifest.version}, tar sha256 ${digest}) -> ${out}`);
}
