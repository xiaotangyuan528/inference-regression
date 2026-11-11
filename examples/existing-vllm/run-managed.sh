#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${UCM_TEST_NPU:?Set UCM_TEST_NPU to an allocated, idle device}"
export ASCEND_RT_VISIBLE_DEVICES="$UCM_TEST_NPU"
export ENABLE_UCM_PATCH=1
port=${UCM_TEST_PORT:-18000}
export UCM_SERVICE_URL="http://127.0.0.1:$port"
export UCM_MODEL=${UCM_MODEL:-/models/Qwen2.5-0.5B-Instruct}
export REGRESSION_RUNS_DIR="$(pwd)/runs"
source_root=${UCM_SOURCE_DIR:-/workspace/code/unified-cache-management}
source_config=${UCM_SOURCE_CONFIG:-/workspace/kvcache_data/ucm_config.yaml}
mkdir -p runs
session=$(mktemp -d "$(pwd)/runs/managed.XXXXXXXX")
export UCM_FAKE_CACHE_DIR="$session/cache"
mkdir "$UCM_FAKE_CACHE_DIR"
echo "ENGINE_EVIDENCE=$session"
engine=
stop_engine() {
  if [[ -z $engine ]]; then return; fi
  kill -TERM -- "-$engine" 2>/dev/null || true
  for ((i=0;i<15;i++)); do
    kill -0 -- "-$engine" 2>/dev/null || break
    sleep 1
  done
  kill -KILL -- "-$engine" 2>/dev/null || true
  wait "$engine" 2>/dev/null || true
  engine=
}
trap stop_engine EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

transfer=$(python - "$source_config" "$session/ucm.yaml" "$port" <<'PY'
import json, os, socket, sys
from pathlib import Path
import yaml
source, target, port = sys.argv[1:]
with socket.socket() as sock:
    sock.bind(("127.0.0.1", int(port)))
cfg = yaml.safe_load(Path(source).read_text())
connector, = cfg["ucm_connectors"]
store = connector["ucm_connector_config"]
if (store.get("store_pipeline"), store.get("asu_mode"), store.get("asu_trans_provider_backend")) != ("ASU", "client", "fake"):
    raise SystemExit("Expected an ASU client with FAKE backend")
store["asu_fake_backend_path"] = os.environ["UCM_FAKE_CACHE_DIR"]
store["asu_fake_backend_complete_immediately"] = False
Path(target).write_text(yaml.safe_dump(cfg))
transfer = {"kv_connector": "UCMConnector", "kv_connector_module_path": "ucm.integration.vllm.ucm_connector",
            "kv_role": "kv_both", "kv_connector_extra_config": {"UCM_CONFIG_FILE": target}}
print(json.dumps(transfer))
PY
)
git -C "$source_root" rev-parse HEAD > "$session/ucm-commit.txt"
unset UCM_WRITE_RUN_ID

start_engine() {
  (cd "$source_root"; exec setsid vllm serve "$UCM_MODEL" --host 127.0.0.1 --port "$port" --kv-transfer-config "$transfer") >"$session/$1.log" 2>&1 &
  engine=$!
  for ((i=0;i<300;i++)); do
    if ! kill -0 "$engine" 2>/dev/null; then
      echo "Engine exited. See $session/$1.log" >&2
      return 2
    fi
    if curl --noproxy '*' -fsS --max-time 2 "$UCM_SERVICE_URL/health" >/dev/null 2>&1; then return; fi
    sleep 2
  done
  echo "Engine readiness timed out. See $session/$1.log" >&2
  return 2
}
run_probe() {
  node cli.mjs run script success --config examples/existing-vllm/config.json
}
start_engine write-engine
run_probe | tee "$session/write-run.log"
export UCM_WRITE_RUN_ID="$(sed -n 's/^RUN_ID=//p' "$session/write-run.log")"
test -n "$UCM_WRITE_RUN_ID"
stop_engine
start_engine readback-engine
export UCM_ASU_ERROR_COUNTERS=event-only
run_probe | tee "$session/readback-run.log"
