import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, posix } from 'node:path';

const integer = value => Number.isSafeInteger(value) && value > 0;
export function loadConfig(path, env = process.env) {
  const input = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(path);
  const config = {
    adapter: 'docker', image: 'ucm-cpu-validation:v2', taskScript: 'tasks/mock.sh',
    timeoutMs: 30000, taskCwd: '.', runsDir: 'runs', workflow: 'workflow.json',
    resourceKey: 'default', network: 'none', ...input,
  };
  config.adapter = env.REGRESSION_ADAPTER ?? config.adapter;
  config.image = env.REGRESSION_IMAGE ?? config.image;
  config.timeoutMs = Number(env.REGRESSION_TIMEOUT_MS ?? config.timeoutMs);
  config.runsDir = env.REGRESSION_RUNS_DIR ?? config.runsDir;
  for (const key of ['taskCwd','taskScript','runsDir','workflow']) {
    config[key] = resolve(base, config[key]);
  }
  if (!['docker','process'].includes(config.adapter)) throw Error('Unknown adapter');
  if (!integer(config.timeoutMs)) throw Error('timeoutMs must be a positive safe integer');
  if (typeof config.resourceKey !== 'string' || !config.resourceKey) throw Error('resourceKey required');
  config.mounts ??= [];
  for (const mount of config.mounts) {
    mount.source = resolve(base, mount.source);
    if (!mount.target?.startsWith('/')) throw Error('Mount target must be absolute in the container');
    mount.target = posix.normalize(mount.target);
    if (mount.target === '/' || ['/task.sh','/out'].some(target => mount.target === target || target.startsWith(mount.target + '/') || mount.target.startsWith(target + '/'))) {
      throw Error('Mount conflicts with managed paths');
    }
  }
  config.dsh ??= {};
  config.dsh.timeoutMs ??= 180000;
  config.dsh.maxDecisions ??= 16;
  if (!integer(config.dsh.timeoutMs) || !integer(config.dsh.maxDecisions)) throw Error('Invalid dsh limits');
  return config;
}

export function loadWorkflow(path) {
  const steps = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(steps) || !steps.length) throw Error('Workflow must contain steps');
  const seen = new Set();
  const reportPaths = new Set();
  return steps.map((raw, index) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(raw.id) || seen.has(raw.id)) throw Error('Invalid or duplicate step ID');
    const needs = raw.needs ?? [];
    // Legacy array order is an explicit completion dependency, including skipped steps.
    const after = raw.after ?? (index ? [steps[index - 1].id] : []);
    for (const list of [needs, after]) {
      if (!Array.isArray(list) || list.some(id => !seen.has(id))) throw Error('Dependencies must reference preceding steps');
    }
    const reports = raw.reports ?? (raw.id === 'test' ? ['test-report.json'] : []);
    if (!Array.isArray(reports) || reports.some(p =>
      typeof p !== 'string' || isAbsolute(p) || p.split(/[\\/]/).includes('..'))) {
      throw Error('Report paths must stay inside task output');
    }
    for (const path of reports) {
      const normalized = posix.normalize(path.replace(/\\/g,'/'));
      if (reportPaths.has(normalized)) throw Error('Report paths must be unique per step');
      reportPaths.add(normalized);
    }
    seen.add(raw.id);
    return { id: raw.id, needs, after, reports };
  });
}
