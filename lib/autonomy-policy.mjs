export function decisionIssue(decision, state) {
  const { current, waits, retries, sameHealthCount } = state;
  if (decision.action === 'check_health' && sameHealthCount >= 2) return 'Health checks returned unchanged observations twice. Choose another action using available evidence.';
  if (decision.action === 'wait' && (waits >= 2 || current.healthFresh === false)) return 'Wait budget exhausted or health must be refreshed after the previous intervention.';
  if (decision.action === 'retry' && (retries >= 1 || !current.healthObserved || current.configValid !== true || current.healthFresh === false)) return 'Retry requires a fresh health check, verified valid configuration and remaining retry budget.';
  if (decision.action !== 'finish') return null;
  if (!['recovered', 'failed', 'incomplete'].includes(decision.status)) return 'Finish must include a separate status field: recovered, failed, or incomplete.';
  if (current.configValid === false) return decision.status === 'failed' ? null : 'Confirmed invalid configuration conflicts with the proposed final status.';
  if (!current.healthObserved || !current.configObserved) return 'Gather both health and configuration evidence before concluding.';
  if (current.healthFresh === false) return 'A fresh health check is required after waiting or retrying.';
  if (current.ready === true) return decision.status === 'recovered' ? null : 'Latest health check confirms readiness. Explain a different current failure or revise the final status.';
  if (current.ready === null || current.configValid === null) return decision.status === 'incomplete' ? null : 'Available checks do not establish failure or recovery. The final status conflicts with incomplete evidence.';
  if (decision.status === 'recovered') return 'No fresh ready health evidence supports recovery.';
  return null;
}
