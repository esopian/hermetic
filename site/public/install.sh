#!/usr/bin/env bash
#
# Installs Hermetic.app and the `hermetic` CLI shim on an Apple silicon Mac.
#
#   curl -fsSL https://hermetic-site.pages.dev/install.sh | bash
#   curl -fsSL https://hermetic-site.pages.dev/install.sh | bash -s -- --version v0.1.6
#
# What it does, in order:
#   1. Checks this is macOS on arm64 (the only build there is).
#   2. Asks the GitHub API for the release and its macos-arm64-Hermetic.dmg asset.
#   3. Downloads the DMG and checks it against the sha256 digest GitHub publishes for it.
#   4. Mounts the DMG read-only, copies Hermetic.app into /Applications (or ~/Applications
#      when /Applications is not writable), and clears the quarantine flag.
#   5. Writes the same shim the app's "Install Command Line Tool…" menu item writes
#      (packages/app/src/main/cli-install.ts), to /usr/local/bin/hermetic when writable,
#      else ~/.local/bin/hermetic.
#
# It never runs sudo. Everything happens inside main(), which runs only once the whole
# file has arrived, so a cut-off download cannot execute half an installer.
#
# Options (flags or environment):
#   --version <tag>       HERMETIC_VERSION      release tag, default: the latest release
#   --app-dir <dir>       HERMETIC_APP_DIR      where Hermetic.app goes
#   --bin-dir <dir>       HERMETIC_BIN_DIR      where the `hermetic` shim goes
#   --no-cli              HERMETIC_NO_CLI=1     skip the CLI shim
#   --dry-run             HERMETIC_DRY_RUN=1    print what would happen, change nothing
#                         GITHUB_TOKEN          sent to the GitHub API if set (private repo, rate limits)
#                         HERMETIC_DMG_FILE     install from a local DMG instead (testing)

set -euo pipefail

REPO="${HERMETIC_REPO:-esopian/hermetic}"
ASSET="macos-arm64-Hermetic.dmg"
BUNDLE_ID="sh.hermetic.app"
API="https://api.github.com/repos/${REPO}"

VERSION="${HERMETIC_VERSION:-latest}"
APP_DIR="${HERMETIC_APP_DIR:-}"
BIN_DIR="${HERMETIC_BIN_DIR:-}"
NO_CLI="${HERMETIC_NO_CLI:-0}"
DRY_RUN="${HERMETIC_DRY_RUN:-0}"
DMG_FILE="${HERMETIC_DMG_FILE:-}"

WORK=""
MOUNT=""

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# Runs a command, or only prints it under --dry-run.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '    would run: %s\n' "$*"
  else
    "$@"
  fi
}

cleanup() {
  if [ -n "$MOUNT" ] && [ -d "$MOUNT" ]; then
    hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || hdiutil detach -quiet -force "$MOUNT" >/dev/null 2>&1 || true
  fi
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

# Kept inline rather than read back from this file: under `curl … | bash` there is no file.
usage() {
  cat <<'EOF'
Install Hermetic.app and the hermetic CLI on an Apple silicon Mac.

Usage: install.sh [--version <tag>] [--app-dir <dir>] [--bin-dir <dir>] [--no-cli] [--dry-run]

  --version <tag>   release tag to install (default: latest)
  --app-dir <dir>   where Hermetic.app goes (default: /Applications, else ~/Applications)
  --bin-dir <dir>   where the hermetic shim goes (default: /usr/local/bin, else ~/.local/bin)
  --no-cli          skip the CLI shim
  --dry-run         print what would happen and change nothing

Set GITHUB_TOKEN to read a private repository or avoid API rate limits.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || die "--version needs a tag, e.g. --version v0.1.6"
        VERSION="$2"
        shift 2
        ;;
      --app-dir)
        [ $# -ge 2 ] || die "--app-dir needs a directory"
        APP_DIR="$2"
        shift 2
        ;;
      --bin-dir)
        [ $# -ge 2 ] || die "--bin-dir needs a directory"
        BIN_DIR="$2"
        shift 2
        ;;
      --no-cli)
        NO_CLI=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
  done
}

check_platform() {
  [ "$(uname -s)" = "Darwin" ] || die "Hermetic is a macOS app; this is $(uname -s)."
  [ "$(uname -m)" = "arm64" ] || die "Hermetic needs an Apple silicon Mac (arm64); this is $(uname -m)."
  local tool
  for tool in curl hdiutil ditto shasum xattr defaults; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
  done
}

github_api() {
  local url="$1"
  local -a headers=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  curl -fsSL "${headers[@]}" "$url"
}

# Prints "<tag> <asset api url> <digest>" for $ASSET in the release JSON on stdin. GitHub
# pretty-prints its API responses, one field per line, and inside each asset object "url"
# comes before "name", which comes before "digest".
parse_release() {
  awk -v asset="$ASSET" '
    function value(line) { sub(/^[^:]*: *"/, "", line); sub(/",? *$/, "", line); return line }
    /"tag_name":/ && tag == "" { tag = value($0) }
    /"url": *"https:\/\/api\.github\.com\/.*\/releases\/assets\// { last_url = value($0) }
    /"name":/ && value($0) == asset { found = 1; url = last_url; next }
    found && /"digest":/ && digest == "" { digest = value($0) }
    found && /"browser_download_url":/ { found = 0 }
    END { if (url != "") print tag, url, (digest == "" ? "-" : digest) }
  '
}

download_release() {
  local endpoint json fields tag asset_url digest
  if [ "$VERSION" = "latest" ]; then
    endpoint="${API}/releases/latest"
  else
    endpoint="${API}/releases/tags/${VERSION}"
  fi

  say "Looking up release ${VERSION} of ${REPO}"
  if ! json="$(github_api "$endpoint")"; then
    die "could not read ${endpoint}. The release may not exist, the repository may be private (set GITHUB_TOKEN), or the API rate limit was hit."
  fi
  fields="$(printf '%s\n' "$json" | parse_release)"
  [ -n "$fields" ] || die "release ${VERSION} has no ${ASSET} asset"
  read -r tag asset_url digest <<<"$fields"
  say "Release ${tag}"

  local dmg="${WORK}/${ASSET}"
  local -a headers=(-H "Accept: application/octet-stream")
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  say "Downloading ${ASSET}"
  curl -fL --progress-bar "${headers[@]}" -o "$dmg" "$asset_url" || die "download failed: ${asset_url}"

  if [ "$digest" = "-" ]; then
    warn "GitHub published no digest for ${ASSET}; skipping the checksum check."
  else
    local want="${digest#sha256:}" have
    have="$(shasum -a 256 "$dmg" | awk '{print $1}')"
    [ "$have" = "$want" ] || die "checksum mismatch for ${ASSET}: expected ${want}, got ${have}"
    say "Checksum OK (sha256 ${want:0:12}…)"
  fi
  DMG_FILE="$dmg"
}

pick_app_dir() {
  if [ -n "$APP_DIR" ]; then
    return
  fi
  if [ -w /Applications ]; then
    APP_DIR="/Applications"
  else
    APP_DIR="${HOME}/Applications"
    warn "/Applications is not writable by $(id -un); installing to ${APP_DIR} instead."
  fi
}

install_app() {
  MOUNT="${WORK}/mnt"
  mkdir -p "$MOUNT"
  say "Mounting the disk image"
  hdiutil attach -nobrowse -readonly -noautoopen -quiet -mountpoint "$MOUNT" "$DMG_FILE" ||
    die "could not mount ${DMG_FILE}"

  local src="${MOUNT}/Hermetic.app"
  [ -d "$src" ] || die "the disk image has no Hermetic.app"

  local dest="${APP_DIR}/Hermetic.app"
  if [ -e "$dest" ]; then
    # Only ever replace a Hermetic bundle; anything else at that path is someone else's.
    local id
    id="$(defaults read "${dest}/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
    [ "$id" = "$BUNDLE_ID" ] || die "${dest} exists and is not Hermetic (bundle id '${id}'); move it and retry"
    if pgrep -xq Hermetic 2>/dev/null; then
      die "Hermetic is running. Quit it and run the installer again."
    fi
    say "Replacing ${dest}"
    run rm -rf "$dest"
  else
    say "Installing to ${dest}"
  fi

  run mkdir -p "$APP_DIR"
  run ditto "$src" "$dest"
  # The build is unsigned (ad-hoc signature only), so a quarantined copy will not open.
  run xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

  hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true
  MOUNT=""
  INSTALLED_APP="$dest"
}

install_cli() {
  if [ "$NO_CLI" = "1" ]; then
    return
  fi
  local binary="${INSTALLED_APP}/Contents/Resources/app/bin/hermetic"
  if [ "$DRY_RUN" != "1" ] && [ ! -x "$binary" ]; then
    warn "no CLI found at ${binary}; skipping the shim. Use the app's Install Command Line Tool… item."
    return
  fi

  if [ -z "$BIN_DIR" ]; then
    if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
      BIN_DIR="/usr/local/bin"
    else
      BIN_DIR="${HOME}/.local/bin"
    fi
  fi
  local target="${BIN_DIR}/hermetic"

  # Same shim as packages/app/src/main/cli-install.ts, so the menu item and this script
  # agree on what is there. Replace only a file that is already a Hermetic shim.
  if [ -e "$target" ] && ! grep -q 'Hermetic.app' "$target" 2>/dev/null; then
    warn "${target} exists and is not a Hermetic shim; leaving it alone."
    return
  fi

  say "Linking the CLI at ${target}"
  run mkdir -p "$BIN_DIR"
  if [ "$DRY_RUN" = "1" ]; then
    printf '    would write: %s -> exec "%s"\n' "$target" "$binary"
  else
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$binary" >"$target"
    chmod 755 "$target"
  fi

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) warn "${BIN_DIR} is not on your PATH. Add this to your shell profile: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
  esac
}

main() {
  parse_args "$@"
  check_platform

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/hermetic-install.XXXXXX")"
  trap cleanup EXIT INT TERM

  if [ -n "$DMG_FILE" ]; then
    [ -f "$DMG_FILE" ] || die "HERMETIC_DMG_FILE does not exist: ${DMG_FILE}"
    say "Using local disk image ${DMG_FILE}"
  else
    download_release
  fi

  pick_app_dir
  INSTALLED_APP=""
  install_app
  install_cli

  if [ "$DRY_RUN" = "1" ]; then
    say "Dry run finished; nothing was changed."
    return
  fi
  say "Hermetic is installed at ${INSTALLED_APP}"
  printf '\n  Open it:        open "%s"\n' "$INSTALLED_APP"
  printf '  Check the CLI:  hermetic --version\n'
  printf '  Next steps:     https://hermetic-site.pages.dev/docs/quick-start/\n\n'
}

main "$@"
