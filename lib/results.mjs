import { join } from 'node:path';
import { read } from './state.mjs';

export function checkReport(path) {
  try {
    const report = read(path);
    const skipped = Object.hasOwn(report, 'skipped') ? report.skipped : 0;
    const counts = [report.checked, report.passed, report.failed, skipped];
    if (!counts.every(n => Number.isSafeInteger(n) && n >= 0) ||
        report.checked !== report.passed + report.failed + skipped ||
        report.passed + report.failed === 0) {
      return { valid: false, reason: 'Invalid counts or all tests skipped' };
    }
    return { valid: true, ...report, skipped };
  } catch (error) { return { valid: false, reason: error.message }; }
}
export function classifyExecution(execution, reports) {
  if (execution.error || execution.infrastructureError || execution.exitCode === null) return 'incomplete';
  if (reports.some(report => !report.valid)) return 'incomplete';
  if (reports.some(report => report.failed > 0)) return 'failed';
  if (execution.exitCode !== 0) return 'incomplete';
  return 'succeeded';
}
export function summarize(manifest, state, cleanup) {
  let incomplete = state.interrupted || state.orchestratorError || cleanup.status !== 'clean';
  let failed = false;
  const reports = {};
  for (const step of manifest.workflow) {
    const record = state.steps[step.id];
    if (!record || record.state === 'running' || record.state === 'incomplete') incomplete = true;
    if (record?.state === 'failed') failed = true;
    if (record?.state === 'skipped') {
      const legitimate = step.needs.some(id =>
        ['failed','incomplete','skipped'].includes(state.steps[id]?.state));
      if (!legitimate) incomplete = true;
    }
    if (record && !['skipped','running'].includes(record.state)) {
      reports[step.id] = step.reports.map(path => checkReport(join(manifest.output, path)));
      if (reports[step.id].some(report => !report.valid)) incomplete = true;
      if (reports[step.id].some(report => report.valid && report.failed > 0)) failed = true;
    }
  }
  // Operational incompleteness takes precedence; original failed checks remain in reports.
  const exitCode = state.violations.length ? 3 : incomplete ? 2 : failed ? 1 : 0;
  return { runId: manifest.runId, status: ['passed','failed','incomplete','workflow_error'][exitCode],
    exitCode, steps: state.steps, violations: state.violations, reports, cleanup,
    interrupted: state.interrupted, orchestratorError: state.orchestratorError };
}
