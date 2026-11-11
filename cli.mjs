
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig, loadWorkflow } from './lib/config.mjs';
import { read, write, acquireResource, releaseResource, eligibility } from './lib/state.mjs';
import { checkReport, classifyExecution, summarize } from './lib/results.mjs';
import { execute, cleanup, logTail } from './adapters.mjs';
import { decide } from './lib/dsh.mjs';

const project = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const optionIndex = args.indexOf('--config');
const configPath = optionIndex >= 0 ? resolve(args.splice(optionIndex, 2)[1] ?? '') : join(project,'config.json');
const [action, first, second] = args;
let config;

function directoryFor(id) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw Error('Invalid run ID');
  return join(config.runsDir, id);
}
function save(manifest, state) { write(join(manifest.directory,'state.json'),state); }
function violation(manifest, state, step, reason) {
  state.violations.push({ step, reason, time: new Date().toISOString() });
  save(manifest,state);
}

async function runStep(manifest, state, step, signal) {
  const allowed = eligibility(step,state);
  if (allowed.kind === 'reject') {
    violation(manifest,state,step.id,allowed.reason);
    return;
  }
  const record = { state: allowed.kind === 'skip' ? 'skipped' : 'running', startedAt: new Date().toISOString() };
  state.steps[step.id] = record;
  save(manifest,state);
  try {
    if (allowed.kind === 'skip') {
      record.reason = allowed.reason;
      return;
    }
    const execution = await execute(manifest,step,signal);
    Object.assign(record,execution);
    const reports = step.reports.map(path => checkReport(join(manifest.output,path)));
    record.state = classifyExecution(execution,reports);
    record.reports = reports;
  } catch (error) {
    record.state = 'incomplete';
    record.exitCode = null;
    record.error = error.code ?? 'EXECUTION_ERROR';
    record.errorMessage = error.message;
  } finally {
    record.endedAt = new Date().toISOString();
    save(manifest,state);
    write(join(manifest.directory,step.id+'.json'),record);
  }
  console.log(JSON.stringify({ runId: manifest.runId, step: step.id, state: record.state, exitCode: record.exitCode }));
}

async function main() {
  if (['tail','cleanup','step'].includes(action)) {
    const directory = directoryFor(first);
    const manifest = read(join(directory,'manifest.json'));
    if (action === 'tail') {
      if (!manifest.workflow.some(step => step.id === second)) throw Error('Unknown step');
      console.log(logTail(join(directory,second+'.log')));
      return 0;
    }
    if (action === 'step') {
      // Step execution is owned by one controller. Independent callers must not race its state.
      const event = { step: second, reason: 'External step requests are unsupported', time: new Date().toISOString() };
      write(join(directory,'external-violation-'+randomUUID()+'.json'),event);
      throw Object.assign(Error(event.reason),{exitCode:3});
    }
    if (manifest.pid) {
      let alive = false;
      try { process.kill(manifest.pid,0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) throw Error('Controller may still be alive; recovery refused');
    }
    const result = await cleanup(manifest);
    write(join(directory,'recovery.json'),result);
    if (result.status === 'clean' && manifest.resourceLock) releaseResource(manifest.resourceLock,manifest.runId);
    console.log(JSON.stringify(result));
    return result.status === 'clean' ? 0 : 2;
  }
  if (action !== 'run') throw Error('Usage: node cli.mjs run script|dsh [scenario] [--config path]');
  const mode = first ?? 'script';
  if (!['script','dsh'].includes(mode)) throw Error('Invalid orchestrator');
  const workflow = loadWorkflow(config.workflow);
  const runId = randomUUID();
  const directory = join(config.runsDir,runId);
  const resourceLock = acquireResource(config.runsDir,config.resourceKey,runId);
  const state = { status:'running', steps:{}, violations:[], interrupted:false, orchestratorError:null };
  const manifest = { runId, mode, directory, output:join(directory,'output'), config, workflow,
    scenario:second ?? 'success', resourceLock, pid:process.pid };
  const aborter = new AbortController();
  const interrupt = () => {
    state.interrupted = true;
    state.status = 'stopping';
    aborter.abort();
  };
  process.on('SIGINT',interrupt);
  process.on('SIGTERM',interrupt);
  let cleaned = {status:'unverified'};
  try {
    mkdirSync(manifest.output,{recursive:true});
    write(join(directory,'manifest.json'),manifest);
    save(manifest,state);
    console.log('RUN_ID=' + runId);
    if (mode === 'script') {
      for (const step of workflow) {
        if (aborter.signal.aborted) break;
        await runStep(manifest,state,step,aborter.signal);
      }
    } else {
      let finished = false, preview = null;
      for (let turn=0; turn<config.dsh.maxDecisions && !aborter.signal.aborted; turn++) {
        const decision = await decide(manifest,state,turn,aborter.signal,preview);
        preview = null;
        write(join(directory,'decision-'+turn+'.json'),decision);
        if (decision.action === 'finish') {
          if (workflow.some(step => !state.steps[step.id] || state.steps[step.id].state === 'running')) {
            violation(manifest,state,null,'Premature finish');
          }
          finished = true;
          break;
        }
        const step = workflow.find(step => step.id === decision.step);
        if (!step) {
          violation(manifest,state,decision.step ?? null,'Unknown step');
          break;
        }
        if (decision.action === 'run') await runStep(manifest,state,step,aborter.signal);
        else if (decision.action === 'tail' && state.steps[step.id]?.endedAt) {
          preview = { step:step.id, text:logTail(join(directory,step.id+'.log')) };
        } else violation(manifest,state,step.id,'Invalid action or log request');
        if (state.violations.length) break;
      }
      if (!finished && !state.violations.length && !state.interrupted) state.orchestratorError = 'Decision limit exceeded';
    }
  } catch (error) {
    state.orchestratorError = error.message;
  } finally {
    state.status = 'closing';
    if (existsSync(directory)) {
      save(manifest,state);
      cleaned = await cleanup(manifest);
      // Independent CLI attempts are durable and count as workflow violations.
      const { readdirSync } = await import('node:fs');
      for (const name of readdirSync(directory).filter(n=>n.startsWith('external-violation-'))) {
        state.violations.push(read(join(directory,name)));
      }
      state.status = 'closed';
      save(manifest,state);
    }
    if (cleaned.status === 'clean') releaseResource(resourceLock,runId);
    process.removeListener('SIGINT',interrupt);
    process.removeListener('SIGTERM',interrupt);
  }
  const result = summarize(manifest,state,cleaned);
  write(join(directory,'result.json'),result);
  console.log(JSON.stringify({runId,status:result.status,exitCode:result.exitCode,directory}));
  return result.exitCode;
}

try { config = loadConfig(configPath); process.exitCode = await main(); }
catch(error) { console.error(error.message); process.exitCode = error.exitCode ?? 2; }
