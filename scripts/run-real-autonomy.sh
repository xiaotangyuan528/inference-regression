#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${HARNESS_TOOLS_ROOT:?Set HARNESS_TOOLS_ROOT}"
source "$HARNESS_TOOLS_ROOT/env.sh"
source "$HARNESS_TOOLS_ROOT/model-key.env"
: "${UCM_DSH_API_KEY:?Missing local API key}"
: "${UCM_DSH_UPSTREAM:?Set model endpoint}"
: "${UCM_DSH_MODEL:?Set model ID}"
export UCM_DSH_API_KEY UCM_DSH_UPSTREAM UCM_DSH_MODEL
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
mkdir -p runs
session=$(mktemp -d "$repo/runs/real-autonomy-launch.XXXXXX")
printf '{}\n' > "$session/config.json"
export UCM_WORKFLOW_CONFIG="$session/config.json"
export UCM_DSH_DRIVER="$repo/scripts/real-autonomy-batch.mjs"
export UCM_DSH_BIN="$(command -v dsh)"
printf 'LAUNCH_DIRECTORY=%s\n' "$session"
set +e
node examples/existing-vllm/run-dsh.mjs 2>&1 | tee "$session/launch.log"
rc=${PIPESTATUS[0]}
set -e
printf '%s\n' "$rc" > "$session/exit-code"
printf 'REAL_BATCH_EXIT=%s\n' "$rc"
exit "$rc"
