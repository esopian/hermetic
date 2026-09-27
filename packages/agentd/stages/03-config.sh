#!/usr/bin/env bash
#
# 03-config — pull this agent's rendered config bundle from S3 and leave the
# validated agent manifest at $HERMETIC_CONFIG_DIR/manifest.json (§4.3).
#
# S3 and the instance role are hermeticd's business: there is no `aws` CLI on
# the box, and the manifest is refused rather than half-understood if its
# schema_version is newer than this build.
set -euo pipefail

echo "::progress 0.2 fetching the config bundle"
"$HERMETICD" stage fetch-config --out "$HERMETIC_CONFIG_DIR/manifest.json"
echo "::progress 1 agent manifest written to ${HERMETIC_CONFIG_DIR}/manifest.json"
