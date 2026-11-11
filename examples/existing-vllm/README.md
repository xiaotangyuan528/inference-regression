# Existing vLLM service probe

From the repository root inside the Pod:

```sh
node cli.mjs run script success --config examples/existing-vllm/config.json
```

Uses Node.js 20+, sh, and a running vLLM service. Defaults to
http://127.0.0.1:8000, /models/Qwen2.5-0.5B-Instruct, and /tmp/asu-fake-store.
Override with UCM_SERVICE_URL, UCM_MODEL (served model ID), and UCM_FAKE_CACHE_DIR.
Run during a quiet window because the metrics are server-wide counters.

The probe sends two identical long prompts, checks the exact answer, and
requires both a positive kvclient write counter delta and new nonempty
FAKE cache files after the first request. The second request captures cache
metrics for diagnosis. External cache readback is not part of the pass criteria.

Open result.json and output/test-report.json in the printed run directory.
Exit 0 means the three checks passed, 1 means a check failed, and 2 means
the execution or evidence was incomplete. Raw responses, metrics and file
snapshots are saved under output/. Export the run directory before deleting
the Pod if its filesystem is ephemeral.
