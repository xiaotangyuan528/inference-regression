import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--docker')) {
  throw new Error('Usage: node scripts/verify-core.mjs [--docker]');
}
const runs = join(root, 'runs');
mkdirSync(runs, { recursive: true });
const directory = mkdtempSync(join(runs, 'core-check.'));
const suites = [
  ['核心回归', ['--test', 'tests/regression.test.mjs']],
  ['轻量服务自检', ['scripts/real-autonomy-batch.mjs', '--self-test']],
];
if (args.includes('--docker')) suites.push(['Docker 回归', ['--test', 'tests/docker.test.mjs']]);

const results = [];
for (const [name, command] of suites) {
  console.log(name);
  const run = spawnSync(process.execPath, command, {
    cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: directory },
  });
  results.push({ name, exitCode: run.status, signal: run.signal, error: run.error?.message });
}
writeFileSync(join(directory, 'summary.json'), JSON.stringify(results, null, 2));
console.log('报告目录', directory);
process.exitCode = results.every(result => result.exitCode === 0) ? 0 : 1;
