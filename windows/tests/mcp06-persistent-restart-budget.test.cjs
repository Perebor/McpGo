'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {claimRestartAttempt}=require('../app/health-contract.cjs');
const {Runtime}=require('../app/runtime.cjs');

const NOW=Date.parse('2026-11-27T08:03:00.000Z');
function sandbox(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp06-persist-'));
 try{return fn(dir)}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
const claim=(file,service,now=NOW)=>claimRestartAttempt(file,service,now);
test('MCP-06 grants no more than 3 claims per service in an hour across process restarts',()=>{
 sandbox(dir=>{
  const file=path.join(dir,'recovery-budget.json');
  assert.equal(claim(file,'terminal').claimed,true);
  assert.equal(claim(file,'terminal',NOW+1000).claimed,true);
  assert.equal(claim(file,'terminal',NOW+2000).claimed,true);
  const a=claim(file,'terminal',NOW+3000);
  assert.equal(a.claimed,false);assert.equal(a.reason,'RETRY_BUDGET_EXHAUSTED');
  assert.equal(claim(file,'messaging',NOW+3000).claimed,true,'separate service budget');
  assert.equal(claim(file,'terminal',NOW+3602001).claimed,true,'expired attempts may age out');
  const raw=fs.readFileSync(file,'utf8');
  assert.equal(raw.includes('chatgpt.com'),false);
  assert.equal(raw.includes('token'),false);
  const saved=JSON.parse(raw);
  assert.equal(saved.version,1);assert.deepEqual(Object.keys(saved.attempts).sort(),['messaging','terminal']);
 });
});
test('MCP-06 refuses corrupt, symlink, suspiciously large or future budget records',()=>{
 sandbox(dir=>{
  const f=path.join(dir,'recovery-budget.json');
  for(const payload of ['{','{"version":4,"attempts":{}}',
   '{"version":1,"attempts":{"terminal":[1e99]}}',
   '{"version":1,"attempts":{"terminal":[9999999999999]}}',
   '{"version":1,"attempts":{"unknown":[1000]}}',
   'a'.repeat(10000)]){
   fs.writeFileSync(f,payload);
   assert.equal(claim(f,'terminal').claimed,false,'bad stored state must fail closed');
  }
  fs.unlinkSync(f);
  try{
   fs.symlinkSync(path.join(dir,'target'),f,'file');
   assert.equal(claim(f,'terminal').claimed,false,'symlink');
  }catch(e){
   if(process.platform!=='win32'||!['EPERM','EACCES'].includes(e.code))throw e;
   // Windows can forbid symlink creation without Developer Mode.
   fs.mkdirSync(f);assert.equal(claim(f,'terminal').claimed,false,'directory instead of file');
  }
 });
});
test('MCP-06 an existing recovery lock fails closed without deleting it',()=>{
 sandbox(dir=>{
  const f=path.join(dir,'recovery-budget.json');
  fs.writeFileSync(f+'.lock','other supervisor');
  const result=claim(f,'terminal');
  assert.equal(result.claimed,false);
  assert.equal(result.reason,'RESTART_BUDGET_UNAVAILABLE');
  assert.equal(fs.readFileSync(f+'.lock','utf8'),'other supervisor');
  assert.equal(fs.existsSync(f),false);
 });
});
test('MCP-06 supervisor cannot bypass retry budget by creating a new Runtime or stop/start',()=>{
 sandbox(dir=>{
  const make=()=>{
   const r=new Runtime({resourceRoot:dir,userData:dir,nodeExecutable:process.execPath,credentials:async()=>null});
   r.running=true;r.report=()=>({});
   const entry={state:'exited: 1',attempts:0,child:null,timer:null};
   r.entries.set('terminal',entry);
   return {r,entry};
  };
  let fixture=make();
  fixture.r.schedule('terminal',fixture.entry);
  assert.ok(fixture.entry.timer);
  clearTimeout(fixture.entry.timer);
  fixture.r.running=false;
  fixture=make();
  fixture.r.schedule('terminal',fixture.entry);
  assert.ok(fixture.entry.timer);
  clearTimeout(fixture.entry.timer);
  fixture=make();
  fixture.r.schedule('terminal',fixture.entry);
  assert.ok(fixture.entry.timer);
  clearTimeout(fixture.entry.timer);
  fixture=make();
  fixture.r.schedule('terminal',fixture.entry);
  assert.equal(fixture.entry.timer,null);
  assert.equal(fixture.entry.state,'blocked: RETRY_BUDGET_EXHAUSTED');
 });
});
test('MCP-06 supervisor fails closed when budget store is corrupt or unwriteable',()=>{
 sandbox(dir=>{
  fs.writeFileSync(path.join(dir,'recovery-budget.json'),'damaged');
  const r=new Runtime({resourceRoot:dir,userData:dir,nodeExecutable:process.execPath,credentials:async()=>null});
  r.running=true;r.report=()=>({});
  const entry={state:'exited: 1',attempts:0,child:null,timer:null};
  r.entries.set('terminal',entry);
  r.schedule('terminal',entry);
  assert.equal(entry.timer,null);
  assert.equal(entry.state,'blocked: NEED_OWNER');
 });
});
