'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {
 snapshotSensitiveState,compareSensitiveState
}=require('../app/upgrade-safety.cjs');
const {
 backupProfileState,restoreProfileState,verifyProfileBackup
}=require('../app/upgrade-transaction.cjs');
const FILES=['AutoSend/tasks.json','AutoSend/control-token','AutoSend/message-key'];
function sandbox(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp07-transaction-'));
 try{
  const profile=path.join(dir,'profile');fs.mkdirSync(path.join(profile,'AutoSend'),{recursive:true});
  for(const [name,value] of [
   ['tasks.json',JSON.stringify({version:1,tasks:[{status:'paused',enabled:false,delivery_count:7}],attempts:[]})],
   ['control-token','test-token-confidential'],['message-key','test-key-confidential']])
   fs.writeFileSync(path.join(profile,'AutoSend',name),value);
  return fn({dir,profile,archive:path.join(dir,'backup-20261127')});
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
}
test('MCP-07 offline versioned backup preserves content and restores confirmed downgrade',()=>{
 sandbox(({dir,profile,archive})=>{
  const before=snapshotSensitiveState(profile,FILES);
  const a=backupProfileState({profileRoot:profile,backupDir:archive,files:FILES,version:'preview.24'});
  assert.equal(a.version,'preview.24');assert.equal(a.files.length,3);
  assert.equal(verifyProfileBackup(archive).status,'PRESERVED');
  assert.equal(JSON.stringify(a).includes('confidential'),false);
  for(const name of FILES)fs.writeFileSync(path.join(profile,...name.split('/')),'upgraded fixture');
  const upgraded=snapshotSensitiveState(profile,FILES);
  assert.equal(compareSensitiveState(profile,before).status,'DRIFT');
  assert.equal(restoreProfileState({profileRoot:profile,backupDir:archive,
   confirmed:true,quiescent:true,expectedLiveSnapshot:upgraded}).status,'RESTORED');
  assert.equal(compareSensitiveState(profile,before).status,'PRESERVED');
  assert.equal(verifyProfileBackup(archive).status,'PRESERVED');
 });
});
test('MCP-07 rollback refuses unapproved, busy, stale / changed live profile',()=>{
 sandbox(({profile,archive})=>{
  backupProfileState({profileRoot:profile,backupDir:archive,files:FILES,version:'preview.24'});
  const before=snapshotSensitiveState(profile,FILES);
  for(const changes of [{confirmed:false,quiescent:true},{confirmed:true,quiescent:false},
   {confirmed:true,quiescent:true,expectedLiveSnapshot:undefined}]){
   assert.throws(()=>restoreProfileState({profileRoot:profile,backupDir:archive,
    expectedLiveSnapshot:before,...changes}),/UPGRADE_RESTORE_(UNSAFE|UNCONFIRMED|STALE)/);
  }
  fs.writeFileSync(path.join(profile,'AutoSend','tasks.json'),'changed after snapshot');
  assert.throws(()=>restoreProfileState({profileRoot:profile,backupDir:archive,
   confirmed:true,quiescent:true,expectedLiveSnapshot:before}),/UPGRADE_RESTORE_STALE/);
 });
});
test('MCP-07 archive tampering or symlinks block entire restore before write',()=>{
 sandbox(({profile,archive})=>{
  backupProfileState({profileRoot:profile,backupDir:archive,files:FILES,version:'preview.24'});
  const live=snapshotSensitiveState(profile,FILES);
  fs.writeFileSync(path.join(archive,'AutoSend','control-token'),'tampered');
  assert.equal(verifyProfileBackup(archive).status,'DRIFT');
  assert.throws(()=>restoreProfileState({profileRoot:profile,backupDir:archive,
   confirmed:true,quiescent:true,expectedLiveSnapshot:live}),/UPGRADE_RESTORE_INTEGRITY/);
  assert.equal(compareSensitiveState(profile,live).status,'PRESERVED');
 });
});
test('MCP-07 archive path must be separate, new and not a nested profile path',()=>{
 sandbox(({profile,archive})=>{
  assert.throws(()=>backupProfileState({profileRoot:profile,backupDir:path.join(profile,'inside'),files:FILES,
   version:'preview.24'}),/UPGRADE_BACKUP_UNSAFE_PATH/);
  const a=backupProfileState({profileRoot:profile,backupDir:archive,files:FILES,version:'preview.24'});
  assert.equal(a.version,'preview.24');
  assert.throws(()=>backupProfileState({profileRoot:profile,backupDir:archive,files:FILES,
   version:'preview.25'}),/UPGRADE_BACKUP_EXISTS/);
 });
});
test('MCP-07 fault injected mid-restore rolls back earlier file replacements',()=>{
 sandbox(({profile,archive})=>{
  backupProfileState({profileRoot:profile,backupDir:archive,files:FILES,version:'preview.24'});
  for(const name of FILES)fs.writeFileSync(path.join(profile,...name.split('/')),'upgraded fixture');
  const live=snapshotSensitiveState(profile,FILES);
  let count=0;
  assert.throws(()=>restoreProfileState({profileRoot:profile,backupDir:archive,confirmed:true,
   quiescent:true,expectedLiveSnapshot:live,
   beforeReplace:()=>{if(++count===2)throw Error('INJECTED_RESTORE_FAILURE')}}),/INJECTED_RESTORE_FAILURE/);
  assert.equal(compareSensitiveState(profile,live).status,'PRESERVED',
   'failed restore must not leave a partially downgraded profile');
 });
});

test('MCP-07 post-replace failure restores original complete profile (not partial downgrade)',()=>{
 sandbox(({profile,archive})=>{
  backupProfileState({profileRoot:profile,backupDir:archive,files:FILES,version:'preview.24'});
  for(const name of FILES)fs.writeFileSync(path.join(profile,...name.split('/')),'upgraded fixture');
  const before=snapshotSensitiveState(profile,FILES);let count=0;
  assert.throws(()=>restoreProfileState({
   profileRoot:profile,backupDir:archive,confirmed:true,quiescent:true,
   expectedLiveSnapshot:before,afterReplace:()=>{if(++count===2)throw Error('INJECTED_AFTER_REPLACE')}
  }),/INJECTED_AFTER_REPLACE/);
  assert.equal(compareSensitiveState(profile,before).status,'PRESERVED');
  assert.equal(verifyProfileBackup(archive).status,'PRESERVED');
 });
});
