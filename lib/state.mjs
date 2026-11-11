import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const read = path => JSON.parse(readFileSync(path, 'utf8'));
export function write(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
}
export function acquireResource(root, key, runId) {
  mkdirSync(root, { recursive: true });
  const lock = join(root, createHash('sha256').update(key).digest('hex') + '.lock');
  writeFileSync(lock, JSON.stringify({ runId, pid: process.pid }), { flag: 'wx' });
  return lock;
}
export function releaseResource(lock, runId) {
  if (existsSync(lock) && read(lock).runId === runId) unlinkSync(lock);
}
export function eligibility(step, state) {
  if (state.status !== 'running') return { kind: 'reject', reason: 'Run is closed' };
  if (state.steps[step.id]) return { kind: 'reject', reason: 'Step already recorded' };
  for (const id of [...step.after, ...step.needs]) {
    const result = state.steps[id];
    if (!result || result.state === 'running') return { kind: 'reject', reason: 'Awaiting ' + id };
  }
  if (step.needs.some(id => state.steps[id].state !== 'succeeded')) {
    return { kind: 'skip', reason: 'Unsuccessful dependency' };
  }
  return { kind: 'run' };
}
