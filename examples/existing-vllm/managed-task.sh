#!/usr/bin/env bash
set -euo pipefail
task_dir="$(cd "$(dirname "$0")" && pwd)"
export ENABLE_UCM_PATCH=1
port=${UCM_TEST_PORT:-18000}
export UCM_SERVICE_URL="http://127.0.0.1:$port"
export UCM_MODEL=${UCM_MODEL:-/models/Qwen2.5-0.5B-Instruct}
export REGRESSION_RUNS_DIR="$(pwd)/runs"
source_root=${UCM_SOURCE_DIR:-/workspace/code/unified-cache-management}
source_config=${UCM_SOURCE_CONFIG:-/workspace/kvcache_data/ucm_config.yaml}
session="$RUN_OUTPUT"
export UCM_FAKE_CACHE_DIR="$session/cache"
mkdir -p "$UCM_FAKE_CACHE_DIR"
pidfile="$session/engine.pid"
stop_engine() {
  [[ -f $pidfile ]] || return 0
  local pid
  read -r pid < "$pidfile"
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 2
  if kill -0 -- "-$pid" 2>/dev/null; then
    local owned=false member
    while read -r member; do
      if grep -azFxq "RUN_ID=$RUN_ID" "/proc/$member/environ" 2>/dev/null; then owned=true; break; fi
    done < <(ps -eo pid=,pgid= | awk -v group="$pid" '$2 == group {print $1}')
    "$owned" || return 2
    kill -TERM -- "-$pid" 2>/dev/null || true
    for ((i=0;i<15;i++)); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 -- "-$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || true
      sleep 1
    fi
    if ps -eo pgid=,stat= | awk -v group="$pid" '$1 == group && $2 !~ /^Z/ {found=1} END {exit !found}'; then return 2; fi
  fi
  rm -f -- "$pidfile"
}
if [[ $1 == cleanup ]]; then stop_engine; exit; fi
prepare() {
: "${UCM_TEST_NPU:?Set UCM_TEST_NPU to an allocated, idle device}"
export ASCEND_RT_VISIBLE_DEVICES="$UCM_TEST_NPU"
transfer=$(python - "$source_config" "$session/ucm.yaml" "$port" <<'PY'
import json, os, socket, sys
from pathlib import Path
import yaml
source, target, port = sys.argv[1:]
with socket.socket() as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
}

start_engine() {
  (cd "$source_root"; exec setsid vllm serve "$UCM_MODEL" --host 127.0.0.1 --port "$port" --kv-transfer-config "$transfer") >"$session/$1.log" 2>&1 &
  engine=$!
  printf "%s\n" "$engine" > "$pidfile"
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
case "$1" in
  start) prepare; start_engine write-engine ;;
  write)
    unset UCM_WRITE_RUN_ID UCM_WRITE_ARTIFACTS
    mkdir -p "$session/write"
    if [[ ${UCM_TEST_INJECT_WRITE_FAILURE:-0} == 1 ]]; then
      printf '%s\n' '{"checked":1,"passed":0,"failed":1,"checks":{"injected_write_failure":false}}' > "$session/write/test-report.json"
      echo "Injected write failure" >&2
      exit 1
    fi
    UCM_MANAGED_COLD_START=1 RUN_OUTPUT="$session/write" node "$task_dir/probe.mjs" ;;
  restart) stop_engine; prepare; start_engine readback-engine ;;
  readback)
    mkdir -p "$session/readback"
    UCM_WRITE_RUN_ID="$RUN_ID" UCM_WRITE_ARTIFACTS="$session/write" \
      UCM_ASU_ERROR_COUNTERS=event-only RUN_OUTPUT="$session/readback" node "$task_dir/probe.mjs" ;;
  *) exit 64 ;;
esac
