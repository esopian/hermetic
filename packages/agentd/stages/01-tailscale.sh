#!/usr/bin/env bash
#
# 01-tailscale — install Tailscale if the image does not carry it, join the
# tailnet, and record the tailnet address as a fact (§4.3).
#
# First, deliberately: a box that fails a later stage is still reachable for
# diagnosis rather than a black hole with a public IP and no way in.
#
# The auth key reaches `tailscale up` through a 0600 file on tmpfs, never argv:
# argv is world-readable in /proc/<pid>/cmdline for the life of the process, and
# would survive in anything hermeticd records (§8.3). The trap removes it even
# when the join fails.
set -euo pipefail

# The name this node asks the tailnet for. `<fleet id>-<agent>` since foundation
# v4, so two fleets in one tailnet do not fight over one MagicDNS label; a box
# launched before v3 gets no such variable and falls back to the agent name,
# which is what it is already called. `HERMETIC_NAME` stays the agent name for
# everything else.
HOSTNAME_WANTED="${HERMETIC_HOSTNAME:-$HERMETIC_NAME}"

AUTHKEY=/run/hermetic/ts-authkey
cleanup() { rm -f "$AUTHKEY"; }
trap cleanup EXIT

KEYRING=/usr/share/keyrings/tailscale-archive-keyring.gpg
LIST=/etc/apt/sources.list.d/tailscale.list
# Ubuntu 24.04 (noble) — the release the fleet pins (`_fleet.ubuntu_release`).
KEY_URL=https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg
LIST_URL=https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list

# Every network call below is bounded, and the index refresh is scoped to the
# tailscale list alone. The regional Ubuntu mirror is not reliably there — a
# real boot sat in `apt-get update` for ten hours while
# `us-east-1.ec2.ports.ubuntu.com` answered 503 for every index, because apt
# waits on a sick mirror rather than giving up. The stage runner has no
# per-stage timeout and only polls for `rerun` between stages, so a hung apt is
# a boot that never ends and an operator who cannot interrupt it. Only
# pkgs.tailscale.com is needed to install tailscale, so the Ubuntu index is not
# refreshed at all unless the install turns out to want it.
APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)

# `retry <attempts> <cmd...>` — the condition form keeps a failed attempt from
# tripping `set -e` before we have decided whether it was the last one.
retry() {
  local attempts="$1"
  shift
  local n=1
  while true; do
    if "$@"; then return 0; fi
    if [ "$n" -ge "$attempts" ]; then return 1; fi
    n=$((n + 1))
    sleep 5
  done
}

if ! command -v tailscale >/dev/null 2>&1; then
  echo "::progress 0.1 adding the tailscale apt repository"
  mkdir -p /usr/share/keyrings
  curl -fsSL --connect-timeout 10 --max-time 60 --retry 3 -o "$KEYRING" "$KEY_URL"
  curl -fsSL --connect-timeout 10 --max-time 60 --retry 3 -o "$LIST" "$LIST_URL"
  export DEBIAN_FRONTEND=noninteractive
  echo "::progress 0.2 apt-get update"
  # `SourceParts=-` is apt's documented "no parts directory": the option is a
  # directory name, and /dev/null is a character device, which apt is entitled
  # to complain about rather than read as empty.
  if ! retry 3 timeout 180 apt-get update \
    -o Dir::Etc::SourceList="$LIST" \
    -o Dir::Etc::SourceParts=- \
    -o APT::Get::List-Cleanup=0 \
    "${APT_OPTS[@]}"; then
    # Not fatal on its own: a stale index may still resolve the package, and the
    # install below is the honest test of that.
    echo "the tailscale index refresh failed; trying the install anyway"
  fi
  echo "::progress 0.45 apt-get install tailscale"
  # `-k 30`: plain `timeout` sends SIGTERM and then waits forever if the child
  # ignores it, which dpkg mid-transaction does. The kill-after turns a hung
  # install into a bounded failure the fallback below can still act on.
  if ! timeout -k 30 300 apt-get install -y tailscale "${APT_OPTS[@]}"; then
    # The one case the narrow refresh cannot cover: dependency resolution wants
    # a fresh Ubuntu index. Take the full refresh once, tolerate a partial one,
    # and let the second install be the verdict — a stage that still fails is
    # marked failed, which is what leaves the box waiting for `rerun`.
    timeout 300 apt-get update "${APT_OPTS[@]}" || true
    # A SIGTERM'd first attempt can leave packages unpacked but not configured,
    # and dpkg refuses every later transaction until someone finishes that one.
    # Nothing to do when the first attempt failed for any other reason, which is
    # why it is tolerated rather than checked.
    dpkg --configure -a || true
    timeout -k 30 300 apt-get install -y tailscale "${APT_OPTS[@]}"
  fi
fi

# A re-run — a reboot, an operator rerun, a new release of this stage — must not
# mint and spend a fresh auth key on a box that is already on the tailnet. The
# key is single-use and rate-limited, and `tailscale up` on a running node would
# churn the node key for nothing.
if tailscale status --json 2>/dev/null | grep -q '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then
  echo "::progress 0.7 already on the tailnet; not re-joining"
else
  echo "::progress 0.7 joining the tailnet as ${HOSTNAME_WANTED}"
  "$HERMETICD" stage secret --slot ts-key --out "$AUTHKEY"
  tailscale up \
    --auth-key=file:"$AUTHKEY" \
    --ssh \
    --hostname="$HOSTNAME_WANTED" \
    --advertise-tags=tag:hermetic
  rm -f "$AUTHKEY"
fi

# The tailnet address is the one that matters; the public IPv4 changes freely
# (§7.1). The runner reads this file back and puts it on the row.
ip="$(tailscale ip -4 | head -n 1 || true)"
if [ -n "$ip" ]; then
  echo "tailscale_ip=${ip}" >>"$HERMETIC_FACTS"
fi

# The name we were actually given, which is not always the name we asked for.
# A recreate leaves the old device in the tailnet's device list holding
# `${HOSTNAME_WANTED}`, so the coordination server hands this node
# `${HOSTNAME_WANTED}-2` instead — and `tailscale serve` publishes, and the TLS
# certificate is issued for, that real name. Recording it here is what lets the
# laptop show the operator a URL that actually resolves, rather than the
# canonical name nobody is listening on.
#
# Extraction without jq (which the image does not carry): flatten the document,
# then take the first `DNSName` inside the top-level `Self` object. `[^{}]*`
# cannot cross into a nested object, and `DNSName` is one of Self's first flat
# fields, so no peer's name can be matched by accident. A daemon with no name
# for us yet — every moment before the node is registered — yields nothing, and
# nothing is what gets written: an empty fact would blank a good value on the
# row, which is worse than leaving the heartbeat to fill it in.
dns="$(tailscale status --json 2>/dev/null |
  tr -d '[:space:]' |
  sed -n 's/.*"Self":{[^{}]*"DNSName":"\([^"]*\)".*/\1/p' || true)"
# `tailscale` reports a fully qualified `name.tailnet.ts.net.`; the trailing dot
# is correct DNS and wrong in a URL.
dns="${dns%.}"
if [ -n "$dns" ]; then
  echo "tailscale_dns_name=${dns}" >>"$HERMETIC_FACTS"
fi

# Nothing else on the box ever upgrades Tailscale. The install above is guarded
# by `command -v tailscale`, so a rerun is a no-op on a box that already has it;
# hermeticd's apply installs only packages that are missing; and Ubuntu's
# `unattended-upgrades` allows the Ubuntu security pocket alone, not
# pkgs.tailscale.com. Without this line a box runs whatever tailscaled the repo
# served on the day it was created, for the life of the box, and the only cure
# is `agent recreate`. Tailscale's own updater (1.60+) tracks the stable channel
# through the same apt repository the install used.
#
# Last in the stage, after both facts are written: enabling the updater can hand
# tailscaled an update to apply immediately, and a daemon restarting mid-stage
# answers `tailscale ip` and `tailscale status` with nothing, which would record
# no address and no name on a stage that still exits 0.
#
# Set on every stage run rather than only after a fresh join, so an existing box
# picks it up on `agent rerun`.
#
# Tolerated rather than checked: `--auto-update` is unknown to a tailscale older
# than 1.60, and is refused outright on a build that cannot update itself (a
# tarball or container install rather than this deb). Neither is a reason to
# fail a boot that has already reached the tailnet, and the version hermeticd
# reports on the heartbeat is what makes a box that never updates visible.
echo "::progress 0.9 enabling tailscale auto-updates"
if ! tailscale set --auto-update; then
  echo "could not enable tailscale auto-updates; this box will stay on $(tailscale version --short 2>/dev/null || echo "its installed version")"
fi

echo "::progress 1 on the tailnet at ${ip:-(pending)}"
