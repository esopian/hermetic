#!/usr/bin/env bash
#
# 06-verify — the last stage asserts what `ready` is supposed to mean (§4.3):
# the data volume is mounted, the box is on the tailnet, both Hermes units are
# running, and Hermes can answer.
#
# It exists so `ready` is a claim the box checked rather than "no stage threw".
# Hermes gets up to 60 s, shared across both units: `05-service` only asked
# systemd to start them, and a first start builds caches.
#
# Two units, because an agent is two processes (§6.4): `hermes-dashboard.service`
# is the dashboard hermetic renders, and `hermes-gateway.service` is the one
# upstream's installer wrote — the messaging channels and the cron runner.
# Waiting on the gateway cannot hang a box that has no channels configured yet:
# with zero messaging platforms enabled the gateway says so and stays up for
# cron execution, so `active` is reached on a brand-new agent exactly as it is
# on a configured one.
#
# The last check is the one that was missing. A box could pass the first three
# and still meet its operator with "No inference provider configured" on the
# first message, because nothing had written Hermes a config naming a provider
# or a model. `verify-hermes` is that check; it lives in hermeticd rather than
# here because it reads the manifest to know what this agent's provider needs.
set -euo pipefail

echo "::progress 0.1 checking ${HERMETIC_DATA_MOUNT}"
if ! findmnt "$HERMETIC_DATA_MOUNT" >/dev/null; then
  echo "${HERMETIC_DATA_MOUNT} is not mounted" >&2
  exit 1
fi

echo "::progress 0.4 checking the tailnet"
# No jq on the box, and none is worth installing for one field: BackendState is
# a top-level string in `tailscale status --json`.
if ! tailscale status --json | grep -q '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then
  echo "tailscale is not in BackendState Running" >&2
  exit 1
fi

echo "::progress 0.6 waiting for hermes-dashboard.service and hermes-gateway.service"
# One deadline for both, not one each: the two start in parallel and 60 s is a
# statement about how long a first start takes, not about how many units there
# are.
deadline=$((SECONDS + 60))
for unit in hermes-dashboard.service hermes-gateway.service; do
  until systemctl is-active --quiet "$unit"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "${unit} is not active after 60s: $(systemctl is-active "$unit" || true)" >&2
      exit 1
    fi
    sleep 5
  done
done

echo "::progress 0.85 checking hermes has a provider, a model and its key"
"$HERMETICD" stage verify-hermes

echo "::progress 1 data volume, tailnet, both hermes units and hermes config all verified"
