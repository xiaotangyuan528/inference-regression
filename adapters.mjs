
import { spawn } from 'node:child_process';
import { openSync, closeSync, appendFileSync, readFileSync, readSync, fstatSync } from 'node:fs';
import { join } from 'node:path';

export function runLogged(command, args, log, { signal, timeoutMs = 30000, cwd, env } = {}) {
  const fd = openSync(log, 'w');
  return new Promise(resolve => {
    let child, timer, stopping = false, executionError = null;
    const stop = reason => {
      if (stopping) return;
      stopping = true;
      executionError ??= reason;
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('close', code => { if (code !== 0) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    };
    const abort = () => stop('ABORTED');
    if (signal?.aborted) {
      closeSync(fd);
      resolve({ exitCode: null, error: 'ABORTED' });
      return;
    }
    try {
      child = spawn(command, args, {
        cwd, env, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32',
      });
    } catch (error) {
      closeSync(fd);
      resolve({ exitCode: null, error: error.code ?? 'SPAWN_ERROR', errorMessage: error.message });
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    child.on('error', error => {
      executionError = error.code ?? 'SPAWN_ERROR';
      appendFileSync(log, '\n' + error.message);
    });
    child.once('close', (code, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      closeSync(fd);
      resolve({ exitCode: code, error: executionError, signal: terminationSignal });
    });
  });
}
export function logTail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const length = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, length).toString('utf8').trimEnd().split(/\r?\n/).slice(-50).join('\n');
  } finally { closeSync(fd); }
}

const label = runId => 'inference-regression.run=' + runId;
export async function execute(manifest, step, signal) {
  const { config, output, directory, runId, scenario } = manifest;
  if (config.adapter === 'process') {
    return runLogged('sh', [config.taskScript, step.id, scenario], join(directory, step.id + '.log'), {
      signal, timeoutMs: config.timeoutMs, cwd: config.taskCwd,
      env: { ...process.env, RUN_OUTPUT: output, RUN_ID: runId },
    });
  }
  return container(manifest, step.id, [
    '--network', config.network, '--entrypoint', '/bin/sh',
    '--mount', bind(config.taskScript, '/task.sh', true),
    '--mount', bind(output, '/out', false),
    ...config.mounts.flatMap(m => ['--mount', bind(m.source, m.target, m.readOnly !== false)]),
    '-e', 'RUN_OUTPUT=/out', '-e', 'RUN_ID=' + runId,
    config.image, '/task.sh', step.id, scenario,
  ], config.timeoutMs, signal);
}
function bind(source, target, readonly) {
  if ([source, target].some(p => p.includes(',') || p.includes('"'))) throw Error('Unsupported Docker mount path');
  return 'type=bind,source=' + source + ',target=' + target + (readonly ? ',readonly' : '');
}

export async function container(manifest, id, args, timeoutMs, signal) {
  const name = 'inference-regression-' + manifest.runId + '-' + id;
  const created = await runLogged('docker', [
    'create', '--name', name, '--label', label(manifest.runId), '--pull', 'never', ...args,
  ], join(manifest.directory, id + '-create.log'), { signal, timeoutMs });
  if (created.error || created.exitCode !== 0) {
    return { ...created, infrastructureError: 'container_create' };
  }
  const execution = await runLogged('docker', ['start', '-a', name],
    join(manifest.directory, id + '.log'), { signal, timeoutMs });
  if (execution.error) {
    await runLogged('docker', ['rm','-f',name], join(manifest.directory,id+'-stop.log'), { timeoutMs: 15000 });
    return execution;
  }
  const inspection = await runLogged('docker', ['inspect','--format','{{json .State}}',name],
    join(manifest.directory,id+'-state.log'), { timeoutMs: 10000 });
  if (inspection.error || inspection.exitCode !== 0) {
    return { exitCode: null, infrastructureError: 'container_inspect' };
  }
  try {
    const state = JSON.parse(readFileSync(join(manifest.directory,id+'-state.log'),'utf8'));
    if (state.Running || state.Status !== 'exited' || state.Error || state.OOMKilled) {
      return { exitCode: null, infrastructureError: 'container_state', containerState: state };
    }
    return { exitCode: state.ExitCode, error: null };
  } catch (error) { return { exitCode: null, infrastructureError: error.message }; }
}

export async function cleanup(manifest) {
  if (manifest.config.adapter === 'process' && manifest.mode !== 'dsh') {
    return { status: 'clean', scope: 'tracked foreground processes; task-created external resources require task cleanup' };
  }
  const list = async suffix => {
    const path = join(manifest.directory, 'cleanup-' + suffix + '.log');
    const result = await runLogged('docker', ['ps','-aq','--filter','label='+label(manifest.runId)], path, { timeoutMs: 10000 });
    if (result.error || result.exitCode !== 0) throw Error('Docker cleanup query failed');
    return readFileSync(path,'utf8').trim().split(/\s+/).filter(Boolean);
  };
  try {
    const initial = await list('before');
    for (const id of initial) {
      await runLogged('docker',['rm','-f',id],join(manifest.directory,'cleanup-'+id+'.log'),{timeoutMs:15000});
    }
    const remaining = await list('after');
    return { status: remaining.length ? 'remaining' : 'clean', containers: initial, remaining };
  } catch (error) { return { status: 'unverified', error: error.message }; }
}
