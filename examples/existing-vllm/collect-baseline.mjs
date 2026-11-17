import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// Read-only collection. No model calls, service lifecycle operations or environment dump.
const repo = resolve(process.argv[2] || process.cwd());
const ucm = resolve(process.env.UCM_SOURCE_DIR || '/workspace/code/unified-cache-management');
const config = process.env.UCM_SOURCE_CONFIG || '/workspace/kvcache_data/ucm_config.yaml';
const model = process.env.UCM_MODEL || '/models/Qwen2.5-0.5B-Instruct';
mkdirSync(join(repo, 'runs'), { recursive: true });
const out = mkdtempSync(join(repo, 'runs', 'baseline.'));
const checks = {};
function command(name, bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024, windowsHide: true });
  // stderr is intentionally omitted: failures may echo confidential configuration.
  checks[name] = { exitCode: r.status, error: r.error?.code || null,
    signal: r.signal, output: r.stdout || '', available: r.status === 0 };
}
function fingerprint(path) {
  try { return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }; }
  catch (e) { return { path, unavailable: e.code }; }
}
for (const [label, path] of [['framework', repo], ['ucm', ucm]]) {
  command(label + '_commit', 'git', ['-C', path, 'rev-parse', 'HEAD']);
  command(label + '_changes', 'git', ['-C', path, 'status', '--porcelain']);
}
command('system', 'uname', ['-smr']);
command('workspace_mount', 'findmnt', ['-T', repo, '-o', 'TARGET,SOURCE,FSTYPE']);
command('npu', 'npu-smi', ['info']);
command('cmake', 'cmake', ['--version']);
command('compiler', 'g++', ['--version']);
command('dsh', process.env.UCM_DSH_BIN || 'dsh', ['--version']);
command('packages', 'python', ['-c', `import json,sys,importlib.metadata as m
names=['vllm','vllm-ascend','torch','torch-npu','pytest','pybind11','PyYAML']
result={'python':sys.version,'executable':sys.executable,'packages':{}}
for name in names:
 try: result['packages'][name]=m.version(name)
 except m.PackageNotFoundError: result['packages'][name]=None
print(json.dumps(result))`]);
command('fake_configuration', 'python', ['-c', `import sys,json,yaml
cfg=yaml.safe_load(open(sys.argv[1]))
keys=['store_pipeline','asu_mode','asu_trans_provider_backend','asu_fake_backend_complete_immediately','enable_event_sync','use_layerwise','persist_token_threshold']
print(json.dumps([{'connector':c.get('ucm_connector_name'),'settings':{k:c.get('ucm_connector_config',{}).get(k) for k in keys}} for c in cfg.get('ucm_connectors',[])]))`, config]);
const paths = ['cli.mjs','adapters.mjs','lib/dsh.mjs','examples/existing-vllm/managed-config.json',
  'examples/existing-vllm/managed-workflow.json','examples/existing-vllm/managed-task.sh',
  'examples/existing-vllm/probe.mjs','examples/existing-vllm/run-dsh.mjs'];
const report = { collectedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  repo, ucm, model, modelExists: existsSync(model), checks,
  fingerprints: [...paths.map(p => fingerprint(join(repo,p))), fingerprint(config), fingerprint(join(model,'config.json'))],
  limitations: ['Does not prove compiled binary matches source HEAD.',
    'Build flags, container image digest and model weight revision require build/deployment evidence.',
    'Mount information alone does not prove persistence after Pod deletion.',
    'No inference or DSH orchestration is executed.'] };
writeFileSync(join(out,'baseline.json'), JSON.stringify(report,null,2), { mode: 0o600 });
const summary = { evidence: out, frameworkCommit: checks.framework_commit.output.trim(),
  ucmCommit: checks.ucm_commit.output.trim(), node: process.version,
  unavailable: Object.entries(checks).filter(([,v])=>!v.available).map(([k])=>k), modelExists: report.modelExists };
writeFileSync(join(out,'summary.json'), JSON.stringify(summary,null,2), { mode: 0o600 });
console.log(JSON.stringify(summary,null,2));
