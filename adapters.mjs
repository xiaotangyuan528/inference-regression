import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readSync, fstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function runLogged(command, args, log, options) {
  const fd = openSync(log, 'w');
  let result;
  try {
    result = spawnSync(command, args, { ...options, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  if (result.error) appendFileSync(log, '\n' + result.error.message + '\n');
  return result;
}

export function logTail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(4096, size));
    const read = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, read).toString('utf8').trimEnd().split(/\r?\n/).slice(-50).join('\n');
  } finally {
    closeSync(fd);
  }
}

export function execute(config, directory, id, scenario, runId) {
  const script = resolve(config.taskScript);
  const name = 'inference-regression-' + runId + '-' + id;
  const inDocker = config.adapter === 'docker';
  const args = inDocker ? [
    'run', '--rm', '--name', name, '--label', 'inference-regression.run=' + runId,
    '--network', 'none', '--pull', 'never',
    '--mount', 'type=bind,source=' + script + ',target=/task.sh,readonly',
    '--mount', 'type=bind,source=' + directory + ',target=/out',
    '--env', 'RUN_OUTPUT=/out', '--entrypoint', '/bin/sh', config.image, '/task.sh', id, scenario,
  ] : [script, id, scenario];
  return runLogged(inDocker ? 'docker' : 'sh', args, join(directory, id + '.log'), {
    timeout: config.timeoutMs, env: { ...process.env, RUN_OUTPUT: directory },
  });
}

export function cleanup(runId) {
  const list = () => spawnSync('docker', [
    'ps', '-aq', '--filter', 'label=inference-regression.run=' + runId,
  ], { encoding: 'utf8', timeout: 10000 });
  const output = (result) => (result.stdout ?? '').trim().split(/\s+/).filter(Boolean);
  const initial = list();
  const errors = [];
  const describe = (result) => result.error?.message ?? (result.stderr ?? '').trim();
  if (initial.status !== 0) return { status: 'unverified', errors: [describe(initial)] };
  const containers = output(initial);
  for (const id of containers) {
    const result = spawnSync('docker', ['rm', '-f', id], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) errors.push(describe(result));
  }
  const remaining = list();
  if (remaining.status !== 0) return { status: 'unverified', containers, errors: [...errors, describe(remaining)] };
  const ids = output(remaining);
  return { status: ids.length ? 'remaining' : 'clean', containers, remaining: ids, errors };
}
