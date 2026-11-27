'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {
 assessUpgradeSafety,snapshotSensitiveState,compareSensitiveState
}=require('../app/upgrade-safety.cjs');
const NOW=Date.parse('2026-11-27T09:00:00Z');
function sandbox(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp07-guard-'));
 try{return fn(dir)}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
function valid(dir){
 const base=path.join(dir,'AutoSend');
 fs.mkdirSync(base,{recursive:true});
 const task={id:'test-id',url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
   status:'paused',enabled:false,verification:null,active_slot_id:null,
   next_at:null,delivery_count:7};
 fs.writeFileSync(path.join(base,'tasks.json'),JSON.stringify({
  version:1,tasks:[task],attempts:[],transition_sequence:1,transition_log:[]}));
 fs.writeFileSync(path.join(base,'control-token'),'secret-token-test');
 fs.writeFileSync(path.join(base,'message-key'),'key-bytes-test');
 return {stateFile:path.join(base,'tasks.json'),task};
}
function live(task){return {ok:true,tasks:[{
 id:task.id,status:task.status,enabled:task.enabled,
 delivery_count:task.delivery_count,verification:null,active_slot_id:null
 }],busyTask:null}}
function evidence(now=NOW){return {checkedAt:now-1000,th:{
 active:0,interactive_sessions:0
 },bh:{browserQueue:{active:false,waiting:0}}}}
test('MCP-07 owner paused tasks + idle terminal/browser + matching live API => BACKUP_READY not auto-install',()=>{
 sandbox(dir=>{
  const {stateFile,task}=valid(dir);
  const x=assessUpgradeSafety({stateFile,live:live(task),healthEvidence:evidence(),now:NOW});
  assert.equal(x.status,'READY_FOR_BACKUP');
  assert.equal(x.nextSafeAction,'CREATE_VERIFIED_BACKUP');
  assert.equal(x.canInstall,false,'preflight must never authorize running unsigned installer');
  assert.equal(x.taskCount,1);
 });
});
test('MCP-07 reject owner-enabled, in-flight, ambiguous receipts and changing task identities',()=>{
 sandbox(dir=>{
  const {stateFile,task}=valid(dir);
  for(const patch of [{enabled:true,status:'scheduled'},
   {status:'unknown',verification:{lastEvidence:'UNKNOWN'}},
   {status:'sending',enabled:true},
   {active_slot_id:'slot-unresolved'},
   {manual_once:true}]){
   const mutated={...task,...patch};
   fs.writeFileSync(stateFile,JSON.stringify({version:1,tasks:[mutated],attempts:[]}));
   const x=assessUpgradeSafety({stateFile,live:live(task),healthEvidence:evidence(),now:NOW});
   assert.equal(x.status,'BLOCKED','unsafe owner state: '+JSON.stringify(patch));
   assert.equal(x.nextSafeAction,'NEED_OWNER');
  }
  fs.writeFileSync(stateFile,JSON.stringify({version:1,tasks:[task],attempts:[]}));
  const forged=live(task);forged.tasks[0].id='other-task';
  assert.equal(assessUpgradeSafety({stateFile,live:forged,healthEvidence:evidence(),now:NOW}).status,'UNKNOWN');
 });
});
test('MCP-07 never assume quiescence if terminal job active, browser queue busy or telemetry stale',()=>{
 sandbox(dir=>{
  const {stateFile,task}=valid(dir);
  const e=evidence();
  for(const telemetry of [
   {...e,th:{active:1,interactive_sessions:0}},
   {...e,th:{active:0,interactive_sessions:1}},
   {...e,bh:{browserQueue:{active:true,waiting:0}}},
   {...e,bh:{browserQueue:{active:false,waiting:1}}}
  ]){
   const x=assessUpgradeSafety({stateFile,live:live(task),healthEvidence:telemetry,now:NOW});
   assert.equal(x.status,'BLOCKED');
   assert.equal(x.nextSafeAction,'WAIT_FOR_IDLE');
  }
  assert.equal(assessUpgradeSafety({stateFile,live:live(task),healthEvidence:evidence(NOW-60000),now:NOW}).status,'UNKNOWN');
  assert.equal(assessUpgradeSafety({stateFile,live:null,healthEvidence:evidence(),now:NOW}).status,'UNKNOWN');
 });
});
test('MCP-07 refuses missing, corrupt and directory/symlink task stores',()=>{
 sandbox(dir=>{
  const {stateFile,task}=valid(dir);
  const options={stateFile,live:live(task),healthEvidence:evidence(),now:NOW};
  fs.writeFileSync(stateFile,'corrupt-json');
  assert.equal(assessUpgradeSafety(options).status,'BLOCKED');
  fs.unlinkSync(stateFile);
  assert.equal(assessUpgradeSafety(options).status,'BLOCKED');
  fs.mkdirSync(stateFile);
  assert.equal(assessUpgradeSafety(options).status,'BLOCKED');
 });
});
test('MCP-07 sensitive-state fingerprints detect drift without disclosing keys or chat URLs',()=>{
 sandbox(dir=>{
  const {stateFile}=valid(dir);
  const selected=['AutoSend/tasks.json','AutoSend/control-token','AutoSend/message-key'];
  const before=snapshotSensitiveState(dir,selected);
  assert.equal(before.version,1);
  assert.equal(before.files.length,3);
  assert.equal(JSON.stringify(before).includes('secret-token-test'),false);
  assert.equal(JSON.stringify(before).includes('chatgpt.com'),false);
  assert.equal(compareSensitiveState(dir,before).status,'PRESERVED');
  fs.writeFileSync(path.join(dir,'AutoSend','control-token'),'tampered-token');
  const mismatch=compareSensitiveState(dir,before);
  assert.equal(mismatch.status,'DRIFT');
  assert.equal(mismatch.nextSafeAction,'NEED_OWNER');
  assert.equal(mismatch.filesChanged.includes('AutoSend/control-token'),true);
  assert.equal(fs.readFileSync(stateFile,'utf8').includes('test-id'),true,'comparison never writes');
 });
});
test('MCP-07 no path traversal or outside-profile reads from fingerprint allowlist',()=>{
 sandbox(dir=>{
  valid(dir);
  for(const rel of ['../outside','C:\\Windows\\System32\\secret','/tmp/absolute','AutoSend/../control-token','AutoSend//tasks.json']){
   assert.throws(()=>snapshotSensitiveState(dir,[rel]),/INVALID_UPGRADE_FILE/);
  }
  assert.throws(()=>snapshotSensitiveState(dir,['AutoSend/tasks.json','AutoSend/tasks.json']),/DUPLICATE_UPGRADE_FILE/);
 });
});
