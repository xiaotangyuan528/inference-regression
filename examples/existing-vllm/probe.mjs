import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const base = process.env.UCM_SERVICE_URL ?? 'http://127.0.0.1:8000';
const cache = process.env.UCM_FAKE_CACHE_DIR ?? '/tmp/asu-fake-store';
const out = process.env.RUN_OUTPUT;
const modelName = process.env.UCM_MODEL ?? '/models/Qwen2.5-0.5B-Instruct';
const writeMetric = 'kv:kv_client_store_requests_total';
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');

async function request(path, payload) {
  const response = await fetch(base + path, {
    method: payload ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: payload && JSON.stringify(payload),
    signal: AbortSignal.timeout(payload ? 180000 : 10000),
  });
  if (!response.ok) throw Error(path + ' returned HTTP ' + response.status);
  return response.text();
}

function cacheFiles() {
  return readdirSync(cache, { recursive: true }).filter(name => {
    if (!name.endsWith('.bin')) return false;
    try {
      const stat = statSync(join(cache, name));
      return stat.isFile() && stat.size > 0;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

function counters(raw) {
  const result = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([\w:]+)(\{.*\})?\s+(\S+)(?:\s+\d+)?$/);
    if (!match || !Number.isFinite(Number(match[3]))) continue;
    const [, name, labels = '', value] = match;
    if (!/^(kv:kv_client_|ucm:asu_|vllm:(?:external_)?prefix_cache_)/.test(name)) continue;
    if (!name.endsWith('_total')) continue;
    if (labels.includes('model_name=') && !labels.includes('model_name=' + JSON.stringify(modelName))) continue;
    result.set(name + labels, Number(value));
  }
  return result;
}

async function snapshot(label) {
  const raw = await request('/metrics');
  writeFileSync(join(out, 'metrics-' + label + '.txt'), raw);
  const files = cacheFiles();
  save('files-' + label + '.json', files);
  return { files, counters: counters(raw) };
}

function delta(before, after) {
  const result = {};
  for (const [key, previous] of before.counters) {
    const current = after.counters.get(key);
    if (current === undefined || current < previous) throw Error('Counter missing or reset: ' + key);
    const name = key.split('{', 1)[0];
    result[name] = (result[name] ?? 0) + current - previous;
  }
  return result;
}

try {
  await request('/health');
  const models = JSON.parse(await request('/v1/models'));
  save('models.json', models);
  if (!models.data.some(model => model.id === modelName)) throw Error('Expected model absent: ' + modelName);

  const code = 'BLUE-' + randomUUID().slice(0, 8);
  const context = Array.from({ length: 80 }, (_, index) =>
    'Record ' + (index + 1) + ': the archive contains ordinary weather observations.').join('\n');
  const payload = {
    model: modelName,
    messages: [
      { role: 'system', content: 'Reply with exactly this verification code: ' + code },
      { role: 'user', content: context + '\nReply with only this verification code: ' + code },
    ],
    temperature: 0, max_tokens: 32, stream: false,
  };
  save('request.json', payload);
  const before = await snapshot('before');
  const observations = [];
  let previous = before;
  for (const index of [1, 2]) {
    const reply = JSON.parse(await request('/v1/chat/completions', payload));
    save('response-' + index + '.json', reply);
    await wait(3000);
    const after = await snapshot('after-' + index);
    const oldFiles = new Set(previous.files);
    observations.push({
      answer: reply.choices[0].message.content,
      newFiles: after.files.filter(file => !oldFiles.has(file)),
      deltas: delta(previous, after),
    });
    previous = after;
  }
  save('observations.json', observations);
  if (!(writeMetric in observations[0].deltas)) throw Error('Missing baseline kvclient write counter');

  const checks = {
    first_answer: observations[0].answer?.trim() === code,
    second_answer: observations[1].answer?.trim() === code,
    kvclient_write_observed: observations[0].deltas[writeMetric] > 0
      && observations[0].newFiles.length > 0,
  };
  const checked = Object.keys(checks).length;
  const passed = Object.values(checks).filter(Boolean).length;
  const report = { checked, passed, failed: checked - passed, checks, cache_readback: 'not_verified' };
  save('test-report.json', report);
  console.log(JSON.stringify(report));
  process.exitCode = report.failed ? 1 : 0;
} catch (error) {
  save('probe-error.json', { message: error.message });
  console.error(error.message);
  process.exitCode = 2;
}
