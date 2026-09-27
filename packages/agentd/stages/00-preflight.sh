#!/usr/bin/env bash
#
# 00-preflight — a check that the tools the rest of the bootstrap shells out to
# actually exist, then the directories every later stage assumes, the hostname,
# and an apt that cannot hang (§4.3).
#
# Stages orchestrate; anything that can destroy data, touch AWS or hold a secret
# stays in TypeScript behind `hermeticd stage …`. This one is deliberately the
# most boring file in the release: if it fails, nothing else has run yet.
set -euo pipefail

# First, before anything here uses any of them. A check that runs at the end of
# the stage cannot prevent the failure it names: the mirror rewrite below is
# built out of `sed`, so an image without one would die with sed's own error
# message rather than with this one. `tar` and `xz` are on the list because
# `hermeticd apply` unpacks the Node release as a `.tar.xz` — Ubuntu ships both,
# and naming their absence here is what turns "tar: unrecognized option -J"
# three stages later into a preflight failure that says which image is wrong.
echo "::progress 0.05 checking the image has the tools the bootstrap shells out to"
missing=()
for tool in apt-get systemctl curl sed tar xz; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "this image is missing ${missing[*]}; hermetic expects a stock Ubuntu server AMI" >&2
  exit 1
fi

echo "::progress 0.1 creating the hermetic directories"
# /run/hermetic is where `hermeticd stage secret` drops a 0600 auth key, so it
# is created 0700 explicitly: `mkdir -p` honours the umask (0755 on a stock
# Ubuntu) and would leave the directory listable by every account on the box.
install -d -m 0700 /run/hermetic
mkdir -p /var/log/hermetic /var/lib/hermeticd /etc/hermetic

# Setting it here means every later log line, on the box and on the tailnet,
# names the agent rather than the AMI's `ip-10-0-1-23`.
#
# `HERMETIC_HOSTNAME` and not `HERMETIC_NAME`: since foundation v4 the two are
# different strings. The row key stays the agent name; the *host* is
# `<fleet id>-<agent>` (core's `cloudName`), so two fleets in one tailnet do not
# fight over one MagicDNS label. It must agree with what `01-tailscale` asks
# the tailnet for, and with what cloud-init already set — a box launched before
# v3 carries no such variable and falls back to the agent name, which is what
# it is already called.
HOSTNAME_WANTED="${HERMETIC_HOSTNAME:-$HERMETIC_NAME}"
echo "::progress 0.5 setting the hostname to ${HOSTNAME_WANTED}"
hostnamectl set-hostname "$HOSTNAME_WANTED"

# cloud-init points apt at the regional EC2 mirror pool
# (`<region>.ec2.ports.ubuntu.com`, `<region>.ec2.archive.ubuntu.com`), and that
# pool is not uniformly healthy: on a real boot one IPv4 member answered 200,
# another answered 503 for every index, and the IPv6 members simply hung. Stock
# apt has no timeouts and no retries, so a sick member is not an error — it is a
# ten-hour `apt-get update`, or worse, an update that returns with only `W:`
# warnings and no `noble`/`noble-updates` index behind it. That partial index is
# the failure that hurts, because the boot looks fine and then `hermeticd
# apply`'s `apt-get install` cannot find `x11vnc`, `novnc` or
# `chromium-browser`, all of which live in `universe`.
#
# So: bound every apt call on the box once, here, rather than have each caller
# repeat the flags, and hand the regional URI to apt's `mirror` method with the
# canonical host — `ports.ubuntu.com` / `archive.ubuntu.com`, which answered 200
# every time — listed behind it. `mirror+file:` keeps the regional preference
# (priority 1 is still tried first) and falls back per file instead of failing
# when the member of the day is sick.
echo "::progress 0.7 bounding apt and giving the regional mirror a fallback"
cat >/etc/apt/apt.conf.d/90hermetic <<'CONF'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
CONF
chmod 0644 /etc/apt/apt.conf.d/90hermetic

MIRRORS=/etc/apt/mirrors.txt
# deb822 first, then the legacy one-liner file; either may be absent.
apt_sources=()
for candidate in /etc/apt/sources.list.d/*.sources /etc/apt/sources.list; do
  if [ -f "$candidate" ]; then apt_sources+=("$candidate"); fi
done

host_of() {
  local rest="${1#*://}"
  printf '%s' "${rest%%/*}"
}

if [ "${#apt_sources[@]}" -eq 0 ]; then
  echo "apt: no source files to rewrite"
elif grep -qs "mirror+file:${MIRRORS%.txt}" "${apt_sources[@]}"; then
  # Idempotent from the other end too: a reboot or an operator rerun finds the
  # list already installed and does not rewrite a rewritten file.
  echo "apt: mirror list already in place"
else
  # URIs never contain whitespace, so newline-separated is a safe list. There is
  # normally exactly one regional URI; a box with two gets a list each rather
  # than an arbitrary winner.
  regional="$(grep -hEo 'https?://[a-z0-9-]+\.ec2\.(ports|archive)\.ubuntu\.com(/[^[:space:]]*)?' \
    "${apt_sources[@]}" | sort -u || true)"
  if [ -z "$regional" ]; then
    echo "apt: no regional ec2 mirror configured"
  else
    n=0
    while read -r uri; do
      n=$((n + 1))
      if [ "$n" -eq 1 ]; then list="$MIRRORS"; else list="${MIRRORS%.txt}-${n}.txt"; fi
      # The canonical host is the regional one with the `<region>.ec2.` prefix
      # dropped; scheme and path are the same repository either way.
      canonical="$(printf '%s' "$uri" | sed -E 's#^(https?://)[a-z0-9-]+\.ec2\.#\1#')"
      printf '%s\tpriority:1\n%s\tpriority:2\n' "$uri" "$canonical" >"$list"
      chmod 0644 "$list"
      # Escape everything that means something to an ERE — both `sed -E`
      # expressions below interpolate this — plus `#`, which is their
      # delimiter. Escaping only `.` was right for the URIs Ubuntu's images
      # happen to carry today and wrong for the first one that carries
      # anything else: a `+`, a `?` or a `(` in a mirror path turns a literal
      # match into a pattern matching something else, and an unbalanced one
      # makes sed refuse to compile at all — which fails stage 00 and so the
      # whole boot. `/` needs no escape (the delimiter is `#`) and neither
      # does `:`. The `%` delimiter here is chosen so the `#` inside the
      # bracket expression is not read as the end of the expression.
      pattern="$(printf '%s' "$uri" | sed 's%[][(){}.*+?|^$\#]%\\&%g')"
      for file in "${apt_sources[@]}"; do
        # deb822: the whole `URIs:` line is replaced, and only on stanzas that
        # name this regional host — the `ports.ubuntu.com` security stanza
        # beside it is left alone. Legacy: just the URI token of a
        # `deb`/`deb-src` line.
        sed -i -E \
          -e "\\#^URIs:[[:space:]].*${pattern}#s#^URIs:.*\$#URIs: mirror+file:${list}#" \
          -e "\\#^deb(-src)?[[:space:]]#s#${pattern}([[:space:]])#mirror+file:${list}\\1#" \
          "$file"
      done
      echo "apt: $(host_of "$uri") now falls back to $(host_of "$canonical")"
    done <<EOF
$regional
EOF
  fi
fi

echo "::progress 1 preflight ok"
