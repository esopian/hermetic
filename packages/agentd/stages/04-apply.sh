#!/usr/bin/env bash
#
# 04-apply — the idempotent config apply (§6.3 step 4): packages, files, units,
# commands, and the runtime secrets Hermes needs.
#
# `hermeticd apply` fetches the Bitwarden token and the provider key itself, so
# no secret is ever an argument, an environment variable of this shell, or a
# line in this stage's log.
set -euo pipefail

echo "::progress 0.05 applying the agent manifest"
"$HERMETICD" apply --manifest "$HERMETIC_CONFIG_DIR/manifest.json"
echo "::progress 1 manifest applied"
