/*
 * Release facts the landing page prints: the version, the tag its download links point at, and
 * the commit it was built from. Read once at build time; nothing here runs in the browser.
 *
 * The version is the repo root's package.json, read as a file rather than imported, so the site
 * never depends on anything under packages/. `astro build` and `astro check` run from site/, so
 * the root is one directory up from the working directory.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO = "esopian/hermetic";
export const REPO_URL = `https://github.com/${REPO}`;

function rootVersion(): string {
  const path = resolve(process.cwd(), "../package.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const { version } = parsed;
    if (typeof version === "string" && version.length > 0) return version;
  }
  throw new Error(`${path} has no "version" string`);
}

const { GITHUB_SHA, HERMETIC_RELEASE_TAG } = process.env;

function shortSha(): string {
  if (GITHUB_SHA !== undefined && GITHUB_SHA.length > 0) return GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export const version = rootVersion();
export const tag = HERMETIC_RELEASE_TAG ?? `v${version}`;
export const sha = shortSha();
export const releasesUrl = `${REPO_URL}/releases`;
export const dmgUrl = `${REPO_URL}/releases/download/${tag}/macos-arm64-Hermetic.dmg`;
