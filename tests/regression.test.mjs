import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReport, classifyExecution, summarize } from '../lib/results.mjs';
import { eligibility, acquireResource, releaseResource } from '../lib/state.mjs';
import { runLogged } from '../adapters.mjs';
const root=mkdtempSync(join(tmpdir(),'harness-test-'));
const put=(name,value)=>{const p=join(root,name);writeFileSync(p,JSON.stringify(value));return p;};
test('report counters and skips',()=>{
 assert.equal(checkReport(put('partial.json',{checked:10,passed:8,failed:0,skipped:2})).valid,true);
 for(const [i,r] of [{checked:2,passed:0,failed:0,skipped:2},{checked:1,passed:1,failed:0,skipped:-1},{checked:2,passed:1,failed:0}].entries())
 assert.equal(checkReport(put(i+'.json',r)).valid,false);
});
test('all workflow steps participate in result',()=>{
 const m={runId:'x',output:root,workflow:[{id:'extra',needs:[],reports:[]}]};
 const s={steps:{extra:{state:'failed'}},violations:[]};
 assert.equal(summarize(m,s,{status:'clean'}).exitCode,1);
 for(const status of ['remaining','unverified']) assert.equal(summarize(m,s,{status}).exitCode,2);
 s.violations.push({reason:'rejected'});
 assert.equal(summarize(m,s,{status:'clean'}).exitCode,3);
});
test('dependency and duplicate guards',()=>{
 const step={id:'test',after:['build'],needs:['build']};
 assert.equal(eligibility(step,{status:'running',steps:{}}).kind,'reject');
 assert.equal(eligibility(step,{status:'running',steps:{build:{state:'failed'}}}).kind,'skip');
 assert.equal(eligibility(step,{status:'running',steps:{test:{state:'succeeded'}}}).kind,'reject');
});
test('resource ownership lock',()=>{
 const lock=acquireResource(root,'gpu','one');
 assert.throws(()=>acquireResource(root,'gpu','two'));
 releaseResource(lock,'two');
 assert.throws(()=>acquireResource(root,'gpu','two'));
 releaseResource(lock,'one');
 releaseResource(acquireResource(root,'gpu','two'),'two');
});
test('execution classification',()=>{
 assert.equal(classifyExecution({exitCode:1},[{valid:true,failed:1}]),'failed');
 assert.equal(classifyExecution({exitCode:125,infrastructureError:'create'},[]),'incomplete');
 assert.equal(classifyExecution({exitCode:0},[{valid:false}]),'incomplete');
});
test('async timeout terminates child',async()=>{
 const result=await runLogged(process.execPath,['-e','setInterval(()=>{},1000)'],join(root,'timeout.log'),{timeoutMs:250});
 assert.equal(result.error,'TIMEOUT');
});
test('abort terminates child',async()=>{
 const controller=new AbortController();
 setTimeout(()=>controller.abort(),250);
 const result=await runLogged(process.execPath,['-e','setInterval(()=>{},1000)'],join(root,'abort.log'),{signal:controller.signal});
 assert.equal(result.error,'ABORTED');
});
test('spawn failure is recorded',async()=>{
 const result=await runLogged('harness-nonexistent-command',[],join(root,'spawn.log'));
 assert.equal(result.error,'ENOENT');assert.notEqual(result.exitCode,0);
});

test('workflow rejects reused report paths', async()=>{
 const {loadWorkflow}=await import('../lib/config.mjs');
 const path=put('workflow.json',[{id:'a',reports:['folder/report.json']},{id:'b',reports:['folder\\report.json']}]);
 assert.throws(()=>loadWorkflow(path),/unique/);
});
