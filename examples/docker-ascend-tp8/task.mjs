import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const workRoot = process.env.UCM_WORK_ROOT;
const template = process.env.UCM_DOCKER_TEMPLATE;
const base = process.env.UCM_SERVICE_URL;
const model = process.env.UCM_MODEL;

function docker(args, timeout = 30000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr || 'Docker command failed');
  return result.stdout.trim();
}

export function inside(path, hostRoot) {
  const suffix = relative(resolve(hostRoot), resolve(path));
  if (!suffix || isAbsolute(suffix) || suffix.split(sep).includes('..')) throw Error('Output must be under UCM_WORK_ROOT');
  return '/workspace/' + suffix.split(sep).join('/');
}

async function main() {
  if (![workRoot, template, base, model].every(value => typeof value === 'string' && value.length > 0)) throw Error('Set UCM_WORK_ROOT, UCM_DOCKER_TEMPLATE, UCM_SERVICE_URL and UCM_MODEL');
  const step = process.argv[2];
  const out = process.env.RUN_OUTPUT;
  const id = process.env.RUN_ID;
  if (!out || !/^[a-f0-9-]{36}$/.test(id || '')) throw Error('Framework RUN_OUTPUT and RUN_ID required');
  const name = 'zsx-regression-' + id;
  const ownedLabel = 'inference-regression.run';
  if (step === 'cleanup') {
    const names = docker(['ps', '-aq', '--filter', 'name=^/' + name + '$']);
    if (!names) return;
    const record = JSON.parse(docker(['inspect', name]))[0];
    if (record.Config.Labels?.[ownedLabel] !== id) throw Error('Container ownership mismatch');
    docker(['stop', '-t', '10', name], 15000);
    docker(['rm', name], 10000);
    if (docker(['ps', '-aq', '--filter', 'name=^/' + name + '$'])) throw Error('Container remains after cleanup');
    return;
  }
  mkdirSync(out, { recursive: true });
  const session = inside(out, workRoot);
  const recordPath = join(out, 'container.json');
  if (step === 'start') {
    const source = JSON.parse(docker(['inspect', template]))[0];
    if (source.State.Running) throw Error('Stop the template service before running this workflow');
    const env = Object.fromEntries(source.Config.Env.map(value => {
      const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
    }));
    const transfer = JSON.parse(env.UCM_TRANSFER);
    const hostConfig = join(workRoot, env.SESSION.replace(/^\/workspace\//, ''), 'ucm.json');
    const config = JSON.parse(readFileSync(hostConfig, 'utf8'));
    const store = config.ucm_connectors?.[0]?.ucm_connector_config;
    if (store?.store_pipeline !== 'ASU' || store.asu_mode !== 'client' || store.asu_trans_provider_backend !== 'fake') {
      throw Error('Template must use ASU client FAKE');
    }
    mkdirSync(join(out, 'cache'));
    store.asu_fake_backend_path = session + '/cache';
    transfer.kv_connector_extra_config.UCM_CONFIG_FILE = session + '/ucm.json';
    writeFileSync(join(out, 'ucm.json'), JSON.stringify(config, null, 2));
    const command = source.Config.Cmd;
    if (command?.[0] !== '-lc' || command.length !== 2) throw Error('Unsupported template command');
    const args = ['create', '--name', name, '--label', ownedLabel + '=' + id,
      '--network', 'host', '--shm-size', '8g', '--memory', '64g', '--cpus', '16', '--volumes-from', template,
      '--workdir', source.Config.WorkingDir];
    for (const device of source.HostConfig.Devices || []) {
      args.push('--device', device.PathOnHost + ':' + device.PathInContainer + ':' + device.CgroupPermissions);
    }
    const overrides = { ...env, SESSION: session, UCM_TRANSFER: JSON.stringify(transfer),
      HCCL_NPU_SOCKET_PORT_RANGE: 'auto', HCCL_HOST_SOCKET_PORT_RANGE: 'auto' };
    for (const [key, value] of Object.entries(overrides)) args.push('-e', key + '=' + value);
    args.push('--entrypoint', '/bin/bash', source.Image, ...command);
    docker(args);
    writeFileSync(recordPath, JSON.stringify({ name, image: source.Image, template, runId: id }, null, 2));
    docker(['start', name]);
  } else {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (record.name !== name || record.runId !== id) throw Error('Run ownership mismatch');
    if (step === 'restart') {
      copyFileSync(join(out, 'engine.log'), join(out, 'engine-before-restart.log'));
      docker(['stop', '-t', '30', name], 40000);
      docker(['start', name]);
    }
  }
  if (['start', 'restart'].includes(step)) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = JSON.parse(docker(['inspect', name]))[0];
      if (!state.State.Running) throw Error('Engine exited; see output/engine.log');
      try {
        const response = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
        if (response.ok) { console.log(step + ': engine ready'); return; }
      } catch {}
      await wait(5000);
    }
    throw Error('Engine readiness timeout');
  }
  if (!['write', 'readback'].includes(step)) throw Error('Unknown step: ' + step);
  const probePath = join(out, 'probe.mjs');
  if (!existsSync(probePath)) {
    const source = readFileSync(join(root, 'examples/existing-vllm/probe.mjs'), 'utf8');
    if (!source.includes('length: 80') || !source.includes('temperature: 0, max_tokens: 32, stream: false,')) throw Error('Probe source changed; review adaptation');
    writeFileSync(probePath, source.replace('length: 80', 'length: 16').replace('temperature: 0, max_tokens: 32, stream: false,',
      'temperature: 0, max_tokens: 64, stream: false, chat_template_kwargs: { enable_thinking: false },'));
  }
  const output = join(out, step);
  mkdirSync(output, { recursive: true });
  const probeEnv = { ...process.env, RUN_OUTPUT: output, UCM_SERVICE_URL: base, UCM_MODEL: model,
    UCM_FAKE_CACHE_DIR: join(out, 'cache'), UCM_MANAGED_COLD_START: '1', UCM_ASU_ERROR_COUNTERS: 'event-only' };
  delete probeEnv.UCM_WRITE_RUN_ID;
  delete probeEnv.UCM_WRITE_ARTIFACTS;
  if (step === 'readback') Object.assign(probeEnv, { UCM_WRITE_RUN_ID: id, UCM_WRITE_ARTIFACTS: join(out, 'write') });
  const result = spawnSync(process.execPath, [probePath], { env: probeEnv, stdio: 'inherit', timeout: 450000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
