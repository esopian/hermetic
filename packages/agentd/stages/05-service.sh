#!/usr/bin/env bash
#
# 05-service — hand the box to systemd (§4.3). `apply` wrote the unit files;
# this is where hermeticd stops being a boot script and becomes a service.
#
# `enable --now` is idempotent: on a reboot the unit is already enabled and
# already running, and systemd says so without restarting it.
set -euo pipefail

echo "::progress 0.3 reloading systemd"
systemctl daemon-reload
echo "::progress 0.6 enabling hermeticd.service"
systemctl enable --now hermeticd.service
echo "::progress 1 hermeticd.service enabled"
