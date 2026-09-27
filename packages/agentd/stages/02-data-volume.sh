#!/usr/bin/env bash
#
# 02-data-volume — attach and mount `/data` (§4.3).
#
# Every dangerous decision here — is this device blank? may it be formatted? —
# lives in TypeScript (`src/disk.ts`), because it is the one place on the box
# where a wrong answer destroys an agent's whole memory. This stage only says
# when it happens.
set -euo pipefail

echo "::progress 0.1 preparing ${HERMETIC_DATA_MOUNT}"
"$HERMETICD" stage disk-prepare --mount "$HERMETIC_DATA_MOUNT"
echo "::progress 1 ${HERMETIC_DATA_MOUNT} mounted"
