import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execute, cleanup, runLogged, logTail } from './adapters.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const workflow = read('workflow.json');
const [action, first, second] = process.argv.slice(2);
const statuses = { passed: 0, failed: 1, incomplete: 2, workflow_error: 3 };

function runStep(directory, manifest, id) {
  const step = workflow.find((entry) => entry.id === id);
  if (!step) throw new Error('Unknown step: ' + id);
  const recordPath = join(directory, id + '.json');
  const record = { id, startedAt: new Date().toISOString() };
  writeFileSync(recordPath, JSON.stringify(record), { flag: 'wx' });
  const execution = execute(manifest.config, directory, id, manifest.scenario, manifest.runId);
  Object.assign(record, {
    endedAt: new Date().toISOString(), exitCode: execution.status,
    error: execution.error?.code ?? null,
  });
  write(recordPath, record);
  console.log(JSON.stringify(record));
  return record;
}

function recordFor(directory, id) {
  const path = join(directory, id + '.json');
  return existsSync(path) ? read(path) : null;
}

function finish(directory, manifest, orchestratorExit, cleanupResult) {
  const build = recordFor(directory, 'build');
  const test = recordFor(directory, 'test');
  const archive = recordFor(directory, 'archive');
  const reportPath = join(directory, 'test-report.json');
  let report = null;
  try { report = read(reportPath); } catch {}
  const validReport = report && Number.isInteger(report.checked) && report.checked > 0
    && Number.isInteger(report.passed) && report.passed >= 0
    && Number.isInteger(report.failed) && report.failed >= 0
    && report.checked === report.passed + report.failed;
  const outOfOrder = (test && (!build?.endedAt || build.endedAt > test.startedAt || build.exitCode !== 0))
    || (archive && (!build?.endedAt || build.endedAt > archive.startedAt
      || (test && (!test.endedAt || test.endedAt > archive.startedAt))));
  let status = 'incomplete';
  let reason = 'required step, report, or orchestrator completion missing';
  if (outOfOrder) {
    status = 'workflow_error';
    reason = 'step order or dependency violated';
  } else if (orchestratorExit === 0 && archive?.exitCode === 0) {
    if ((Number.isInteger(build?.exitCode) && build.exitCode !== 0)
      || (Number.isInteger(test?.exitCode) && test.exitCode !== 0)) {
      status = 'failed';
      reason = build.exitCode !== 0 ? 'build failed' : 'test failed';
    } else if (build?.exitCode === 0 && test?.exitCode === 0 && validReport) {
      status = report.failed === 0 ? 'passed' : 'failed';
      reason = report.failed === 0 ? 'all checks passed' : 'assertions failed';
    }
  }
  write(join(directory, 'result.json'), { runId: manifest.runId, status, reason, orchestratorExit,
    steps: { build, test, archive }, report, cleanup: cleanupResult });
  console.log(status + ': ' + reason + ' (' + directory + ')');
  return statuses[status];
}

try {
  if (action === 'tail' || action === 'cleanup') {
    if (!/^[a-f0-9-]{36}$/.test(first ?? '')) throw new Error('Invalid run ID');
    const directory = resolve('runs', first);
    const manifest = read(join(directory, 'manifest.json'));
    if (action === 'tail') {
      if (!workflow.some(({ id }) => id === second)) throw new Error('Unknown step');
      console.log(logTail(join(directory, second + '.log')));
    } else {
      if (manifest.config.adapter !== 'docker') throw new Error('Docker recovery requires a Docker run');
      const result = cleanup(manifest.runId);
      write(join(directory, 'recovery.json'), result);
      console.log(JSON.stringify(result));
      process.exitCode = result.status === 'clean' ? 0 : 2;
    }
  } else if (action === 'step') {
    if (!/^[a-f0-9-]{36}$/.test(first ?? '')) throw new Error('Invalid run ID');
    const directory = resolve('runs', first);
    const manifest = read(join(directory, 'manifest.json'));
    process.exitCode = runStep(directory, manifest, second).exitCode ?? 2;
  } else if (action === 'run') {
    const mode = first ?? 'script';
    const scenario = second ?? 'success';
    if (!['script', 'dsh'].includes(mode)) throw new Error('Use script or dsh');
    if (!['success', 'build-failure', 'missing-report', 'timeout', 'verbose'].includes(scenario)) throw new Error('Unknown scenario');
    const config = {
      adapter: 'docker', image: 'ucm-cpu-validation:v2', taskScript: 'tasks/mock.sh', timeoutMs: 30000,
      ...read('config.json'),
    };
    config.adapter = process.env.REGRESSION_ADAPTER ?? config.adapter;
    config.image = process.env.REGRESSION_IMAGE ?? config.image;
    config.timeoutMs = Number(process.env.REGRESSION_TIMEOUT_MS ?? config.timeoutMs);
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) throw new Error('Invalid step timeout');
    if (!['docker', 'process'].includes(config.adapter)) throw new Error('Invalid adapter');
    const runId = randomUUID();
    const directory = resolve('runs', runId);
    mkdirSync(directory, { recursive: true });
    const manifest = { runId, mode, scenario, config };
    write(join(directory, 'manifest.json'), manifest);
    let orchestratorExit = 0;
    let cleanupResult;
    try {
      if (mode === 'script') {
        for (const step of workflow) {
          if (step.needs.every((id) => recordFor(directory, id)?.exitCode === 0)) {
            runStep(directory, manifest, step.id);
          }
        }
      } else {
        const prompt = [
          'Orchestrate this run using only the following task commands from the current directory.',
          'Execute only the command before the | separator. Run each selected command at most once. Do not edit files or retry.',
          'Visit the steps in the order shown below. Run a step only if every listed dependency exited 0.',
          ...workflow.map(({ id, needs }) => 'node cli.mjs step ' + runId + ' ' + id + ' | dependencies: ' + (needs.join(', ') || 'none')),
          'For diagnostics use only the bounded log command: node cli.mjs tail ' + runId + ' <step>. Do not read raw logs.',
          'Summarize the actual calls and outputs. Run ID: ' + runId,
        ].join('\n');
        const result = runLogged(config.dsh.command, [...config.dsh.args, prompt], join(directory, 'dsh.log'), {
          timeout: config.dsh.timeoutMs,
        });
        orchestratorExit = result.status;
      }
    } catch (error) {
      orchestratorExit = null;
      write(join(directory, 'orchestrator-error.json'), { message: error.message });
    } finally {
      cleanupResult = config.adapter === 'docker' ? cleanup(runId) : { status: 'not_applicable' };
    }
    process.exitCode = finish(directory, manifest, orchestratorExit, cleanupResult);
  } else {
    throw new Error('Usage: node cli.mjs run [script|dsh] [success|build-failure|missing-report]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
