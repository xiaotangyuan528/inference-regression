import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const temporary=mkdtempSync(join(root,'runs','suite-'));
const base={adapter:'docker',image:process.env.REGRESSION_IMAGE??'ucm-cpu-validation:v2',taskScript:join(root,'tasks/mock.sh'),taskCwd:root,workflow:join(root,'workflow.json'),runsDir:temporary,timeoutMs:10000};
function run(mode,scenario,extra={}) {
 const path=join(temporary,'config.json');
 writeFileSync(path,JSON.stringify({...base,...extra}));
 const p=spawnSync(process.execPath,[join(root,'cli.mjs'),'run',mode,scenario,'--config',path],{cwd:dirname(root),encoding:'utf8',timeout:120000});
 assert.equal(p.error,undefined,p.error?.message);
 const id=p.stdout.match(/RUN_ID=([\w-]+)/)?.[1];
 assert.ok(id,p.stdout+p.stderr);
 const result=JSON.parse(readFileSync(join(temporary,id,'result.json'),'utf8'));
 assert.equal(p.status,result.exitCode,p.stdout+p.stderr);
 assert.equal(result.cleanup.status,'clean');
 return result;
}
for(const [scenario,expected] of [['success',0],['partial-skips',0],['all-skipped',2],['failed-test',1],['build-failure',2],['missing-report',2],['timeout',2],['verbose',0]]) {
 test('Docker '+scenario,()=>assert.equal(run('script',scenario,scenario==='timeout'?{timeoutMs:1000}:{}).exitCode,expected));
}
test('Docker unavailable image is incomplete',()=>assert.equal(run('script','success',{image:'inference-regression-missing:never'}).exitCode,2));
test('extra required step cannot be ignored',()=>{
 const workflow=JSON.parse(readFileSync(base.workflow));
 workflow.push({id:'extra',after:['archive'],needs:[],reports:[]});
 const path=join(temporary,'extra.json');writeFileSync(path,JSON.stringify(workflow));
 const r=run('script','success',{workflow:path});
 assert.equal(r.exitCode,2);assert.equal(r.steps.extra.exitCode,64);
});
test('adapter throw completes step record',()=>{
 const r=run('script','success',{mounts:[{source:join(root,'comma,path'),target:'/data'}]});
 assert.equal(r.exitCode,2);assert.ok(r.steps.build.endedAt);
});
function decision(code) {return {image:base.image,command:['python3','-c',code],network:'none',timeoutMs:10000};}
test('isolated decision protocol follows workflow',()=>{
 const code='import json,sys; s=json.loads(sys.argv[-1].splitlines()[-1]); pending=[x["id"] for x in s["workflow"] if x["id"] not in s["states"]]; print(json.dumps({"action":"run","step":pending[0]} if pending else {"action":"finish"}))';
 assert.equal(run('dsh','success',{dsh:decision(code)}).exitCode,0);
});
test('out of order decision is workflow error',()=>{
 const r=run('dsh','success',{dsh:decision('print(\'{"action":"run","step":"archive"}\')')});
 assert.equal(r.exitCode,3);assert.equal(Object.keys(r.steps).length,0);
});
test('premature finish is workflow error',()=>assert.equal(run('dsh','success',{dsh:decision('print(\'{"action":"finish"}\')')}).exitCode,3));
test('decision timeout is incomplete',()=>assert.equal(run('dsh','success',{dsh:{...decision('import time; time.sleep(60)'),timeoutMs:1000}}).exitCode,2));

test('overlap rejection and recovery after forced controller termination',async()=>{
 const configPath=join(temporary,'recovery-config.json');
 writeFileSync(configPath,JSON.stringify({...base,timeoutMs:60000}));
 const child=spawn(process.execPath,[join(root,'cli.mjs'),'run','script','timeout','--config',configPath],{stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);
 let id;
 try {
  for(let i=0;i<100;i++){
   id=output.match(/RUN_ID=([\w-]+)/)?.[1];
   if(id){
    const ps=spawnSync('docker',['ps','-q','--filter','label=inference-regression.run='+id],{encoding:'utf8'});
    if(ps.stdout.trim())break;
   }
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(id,output);
  const duplicate=spawnSync(process.execPath,[join(root,'cli.mjs'),'run','script','success','--config',configPath],{encoding:'utf8'});
  assert.equal(duplicate.status,2);
 } finally {
  const exited=new Promise(resolve=>child.once('close',resolve));
  child.kill('SIGKILL');await exited;
 }
 const recovery=spawnSync(process.execPath,[join(root,'cli.mjs'),'cleanup',id,'--config',configPath],{encoding:'utf8',timeout:30000});
 assert.equal(recovery.status,0,recovery.stdout+recovery.stderr);
 const left=spawnSync('docker',['ps','-aq','--filter','label=inference-regression.run='+id],{encoding:'utf8'});
 assert.equal(left.stdout.trim(),'');
 assert.equal(run('script','success').exitCode,0);
});
