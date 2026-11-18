#!/usr/bin/env bash
set -euo pipefail
umask 077
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${UCM_WORK_ROOT:?Set host workspace root}"
: "${UCM_DOCKER_TEMPLATE:?Set stopped template container}"
: "${UCM_SERVICE_URL:?Set service URL}"
: "${UCM_MODEL:?Set container model path}"
: "${UCM_RESOURCE_KEY:?Set shared resource lock key}"
cd "$repo"
node --version
test -f examples/existing-vllm/probe.mjs
state=$(docker inspect "$UCM_DOCKER_TEMPLATE" --format '{{.State.Running}}')
if [ "$state" = true ]; then
  echo "请先停止本次验证的模板服务：docker stop $UCM_DOCKER_TEMPLATE"
  exit 2
fi
mkdir -p runs
config=$(mktemp "$repo/runs/docker-tp8-config.XXXXXX.json")
node -e 'const fs=require("node:fs"),p=require("node:path"); const root=process.cwd(); fs.writeFileSync(process.argv[1],JSON.stringify({adapter:"process",taskShell:process.execPath,taskScript:p.join(root,"examples/docker-ascend-tp8/task.mjs"),cleanupScript:p.join(root,"examples/docker-ascend-tp8/cleanup.sh"),taskCwd:root,workflow:p.join(root,"examples/existing-vllm/managed-workflow.json"),runsDir:p.join(root,"runs"),resourceKey:process.env.UCM_RESOURCE_KEY,timeoutMs:900000},null,2));' "$config"
mode=${1:-script}
case "$mode" in
  script) exec node cli.mjs run script success --config "$config" ;;
  dsh) export UCM_WORKFLOW_CONFIG="$config"; exec node examples/existing-vllm/run-dsh.mjs ;;
  *) echo 'Use run.sh script or run.sh dsh'; exit 2 ;;
esac
