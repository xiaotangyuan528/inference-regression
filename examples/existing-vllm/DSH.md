# Run the managed workflow with DSH

Use a Linux Pod with the existing vLLM/ASU FAKE setup, Python with PyYAML,
Node.js compatible with your DSH release, and an authorized Anthropic-compatible
model gateway. The test uses a dedicated NPU, an independent cache directory,
and port 18000 by default. Set UCM_TEST_PORT to use another free port.

```bash
cd /path/to/inference-regression
git pull --ff-only origin main

(
  set -e
  export UCM_TEST_NPU='<allocated idle NPU>'
  export UCM_DSH_UPSTREAM='<full authorized /v1/messages URL>'
  export UCM_DSH_MODEL='<gateway model ID>'
  read -rs -p 'Gateway API key: ' UCM_DSH_API_KEY
  printf '\n'
  export UCM_DSH_API_KEY
  node examples/existing-vllm/run-dsh.mjs
)
```

Ensure dsh is on PATH or set UCM_DSH_BIN. The launcher binds an ephemeral
loopback port and gives the child a per-run proxy key. The upstream key is
read from the launch environment and is not written to the generated patch.
The proxy buffers responses, adds missing Anthropic SSE event names, and
retries a zero-byte HTTP 200 SSE response once.

The managed Workflow runs start, write, restart, and readback. DSH proposes
each decision and the framework validates and executes it. Verify exit 0,
four successful steps, clean engine cleanup, and the final finish decision.
Inspect runs/<run-id>/result.json, decision-*.json and the reports in
output/write and output/readback. DSH_GATEWAY_EVIDENCE identifies the
directory containing proxy metadata.

For the deterministic comparison, use the same environment and run:

```bash
node cli.mjs run script success --config examples/existing-vllm/managed-config.json
```

The four-step DSH flow passed in the target Pod with the earlier diagnostic
proxy. This packaged launcher was checked with a simulated gateway, including
SSE framing and retry, and still needs a run in the target Pod. Write failure,
illegal decision and DSH timeout with engine cleanup remain separate acceptance
cases.
