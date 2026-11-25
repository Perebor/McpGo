import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.mjs';
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8').match(/function operation\(action,body\)\{[\s\S]*?\n\}\n(?=function expireAmbiguous\()/);
assert.ok(source,'server operation not found');
const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const body={url,message:'fixture',interval_seconds:300};
test('all owner mutation operations preserve unresolved delivery and history',()=>{
 for(const status of ['unknown','paused']){
  for(const action of ['update','pause','remove','start','send_once','set_interval_offset','clear_history']){
   const task=core.newTask(body,1000);
   task.status=status;task.verification={baselineUserCount:2};task.active_slot_id='fixture-slot';
   task.slot_ledger=[{id:'fixture-slot',state:'unknown'}];
   const db={tasks:[task],attempts:[{result:'unknown'}]},before=JSON.stringify(db);
   let writes=0;
   const context={...core,db,find:()=>task,persist:()=>writes++,conversationState:()=>({blocked:false}),now:()=>new Date(2000).toISOString()};
   const op=vm.runInNewContext(source[0]+'\noperation',context);
   assert.throws(()=>op(action,{...body,id:task.id,interval_offset_seconds:180}),undefined,action+' '+status);
   assert.equal(JSON.stringify(db),before,action+' mutated unresolved receipt');assert.equal(writes,0);
  }
 }
});

test('restart quarantines an inconsistent inactive or pre-click task with durable delivery evidence',()=>{
 for(const status of ['paused','scheduled','checking']){
  const task=core.newTask(body,1000);
  task.status=status;task.enabled=true;task.next_at=new Date(2000).toISOString();
  task.verification={baselineUserCount:2};task.active_slot_id='fixture-slot';
  task.slot_ledger=[{id:'fixture-slot',state:'unknown'}];
  core.markUnknownOnBoot({tasks:[task],attempts:[]});
  assert.equal(task.status,'unknown');assert.equal(task.enabled,false);assert.equal(task.next_at,null);
  assert.equal(task.verification.baselineUserCount,2);
  assert.equal(task.slot_ledger[0].state,'unknown');assert.equal(task.active_slot_id,'fixture-slot');
 }
});
test('encrypted synthetic backup restore preserves unresolved receipt and interval configuration',async()=>{
 const os=await import('node:os'),path=await import('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-restore-fixture-'));
 try{
  const original=path.join(root,'original','tasks.json'),restored=path.join(root,'restored','tasks.json');
  const task=core.newTask({...body,interval_offset_seconds:180},1000);
  task.status='unknown';task.enabled=false;task.next_at=null;
  task.verification={baselineUserCount:2};task.active_slot_id='fixture-slot';
  task.slot_ledger=[{id:'fixture-slot',state:'unknown'}];
  const state={version:1,tasks:[task],attempts:[{result:'unknown'}]};
  core.writeState(state,original);
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(original,'utf8')).tasks[0],'message'));
  fs.mkdirSync(path.dirname(restored),{mode:0o700});
  fs.copyFileSync(original,restored);
  fs.copyFileSync(path.join(path.dirname(original),'message-key'),path.join(path.dirname(restored),'message-key'));
  fs.chmodSync(path.join(path.dirname(restored),'message-key'),0o600);
  const roundtrip=core.readState(restored);
  assert.deepEqual(roundtrip,state);
  core.markUnknownOnBoot(roundtrip);
  assert.equal(roundtrip.tasks[0].status,'unknown');assert.equal(roundtrip.tasks[0].enabled,false);
  assert.equal(roundtrip.tasks[0].interval_offset_seconds,180);
  assert.equal(roundtrip.tasks[0].slot_ledger[0].state,'unknown');
  assert.deepEqual(core.dueTasks(roundtrip,Date.now()),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
