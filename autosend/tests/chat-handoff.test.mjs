import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {newTask,writeState,readState,arm,dueTasks,assertTaskMutable} from '../core.mjs';
import {planChatHandoff} from '../chat-handoff.mjs';

const OLD='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000001';
const NEW='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000002';
const THIRD='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000003';
const KEY='e99f2c39-2222-4222-8222-222222222222';
const COMMIT='a'.repeat(40);
const PROOF='b'.repeat(64);
function make(){
 const source=newTask({url:OLD,message:'Продолжи проект по инструкции',project_label:'Fixture',interval_seconds:600},10000);
 source.id='fixture-old'; source.last_success_at='2026-11-25T01:00:00.000Z';
 source.last_action_id='confirmed-action';
 source.delivery_count=12;
 source.slot_ledger=[{id:'slot-ok',state:'verified'}];
 source.smart_v2=true; source.smart_v2_project='TD';
 source.smart_v2_last_action='CONTINUE_DEVELOPMENT';
 return {version:1,tasks:[source],attempts:[{task_id:source.id,result:'verified'}]};
}
function checkpoint(summary='Owner approved context'){
 return {task_id:'MCP-11',branch:'work/mcp11-branch',commit:COMMIT,
         evidence_sha256:PROOF,receipt_id:'receipt-123',last_ack_id:'ack-456',summary};
}
function request(overrides={}){
 return {source_id:'fixture-old',target_url:NEW,owner_confirmed_target:NEW,
         idempotency_key:KEY,checkpoint:checkpoint(),...overrides};
}
function migrate(state=make(),data=request()){
 return planChatHandoff(state,data,{time:'2026-11-27T18:00:00.000Z',
                                 newId:'fixture-new',workerBusy:false,currentTaskId:null});
}
test('owner-approved handoff creates one paused target and permanently archives old chat without Send',()=>{
 const original=make(),before=JSON.stringify(original);
 const {state:after,receipt}=migrate(original);
 assert.equal(JSON.stringify(original),before,'planning must not mutate live store before persist');
 assert.equal(receipt.status,'STAGED_PAUSED');
 assert.equal(receipt.source_id,'fixture-old');
 assert.equal(receipt.target_id,'fixture-new');
 assert.equal(after.tasks.length,2);
 const [source,target]=after.tasks;
 assert.equal(source.handoff_archived_at,'2026-11-27T18:00:00.000Z');
 assert.equal(source.handoff_replaced_by,target.id);
 assert.equal(source.enabled,false);assert.equal(source.status,'paused');assert.equal(source.next_at,null);
 assert.equal(source.delivery_count,12);assert.equal(source.last_action_id,'confirmed-action');
 assert.equal(source.slot_ledger[0].state,'verified');
 assert.equal(target.url,NEW);
 assert.equal(target.status,'paused');assert.equal(target.enabled,false);
 assert.equal(target.manual_once,false);assert.equal(target.next_at,null);
 assert.equal(target.delivery_count,0);
 assert.equal(target.handoff_origin_task_id,source.id);
 assert.equal(target.handoff_last_ack_id,'ack-456');
 assert.match(target.message,/MCP-11/);
 assert.match(target.message,/receipt-123/);
 assert.match(target.message,/Owner approved context/);
 assert.equal(target.smart_v2,false,'do not auto-enable model or re-use prior context markers');
 assert.equal(target.first_cycle_started_at,undefined);
 assert.throws(()=>arm(target),/handoff|approval|подтвержд|провер/i);
 const damaged={...target,enabled:true,status:'scheduled',next_at:new Date(0).toISOString()};
 assert.deepEqual(dueTasks({tasks:[damaged]},Date.now()),[]);
 assert.equal(after.attempts.length,1);
 assert.equal(dueTasks(after,Date.now()).length,0);
 assert.throws(()=>assertTaskMutable(source),/архив/i);
 assert.throws(()=>arm(source),/архив/i);
});
test('handoff persists encrypted context and receipts after restart with identical replay receipt',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo11-'));
 try{
  const file=path.join(root,'tasks.json');
  const {state,receipt}=migrate();
  writeState(state,file);
  const bytes=fs.readFileSync(file,'utf8');
  assert.ok(!bytes.includes('Owner approved context'));
  assert.ok(!bytes.includes('Продолжи проект'));
  const restored=readState(file);
  assert.deepEqual(restored,state);
  const next=planChatHandoff(restored,request(),{time:'2026-11-27T18:02:00.000Z'});
  assert.equal(next.receipt.status,'ALREADY_STAGED');
  assert.equal(next.receipt.target_id,receipt.target_id);
  assert.equal(next.state.tasks.length,2);
  assert.equal(next.state.tasks[0].handoff_archived_at,state.tasks[0].handoff_archived_at);
 } finally {fs.rmSync(root,{recursive:true,force:true})}
});
test('same idempotency key with modified target or checkpoint fails without an extra task',()=>{
 const {state}=migrate();
 for(const altered of [
  request({target_url:THIRD,owner_confirmed_target:THIRD}),
  request({checkpoint:checkpoint('changed owner context')})
 ]){
  assert.throws(()=>migrate(state,altered),/conflict|replay|different/i);
  assert.equal(state.tasks.length,2);
 }
});
test('owner-approval, source/scope, target collision and path validation are fail closed',()=>{
 for(const bad of [
   {owner_confirmed_target:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000009'},
   {target_url:'https://chatgpt.com/share/some-copy',owner_confirmed_target:'https://chatgpt.com/share/some-copy'},
   {target_url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000002',owner_confirmed_target:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000002'},
   {target_url:OLD,owner_confirmed_target:OLD},
   {owner_confirmed_target:null},
   {checkpoint:{...checkpoint(),commit:'not-a-sha'}},
   {checkpoint:{...checkpoint(),summary:'x'.repeat(3000)}},
   {idempotency_key:'not-idempotent'},
   {checkpoint:{...checkpoint(),arbitrary_shell:'powershell.exe'}}]){
  const state=make(),before=JSON.stringify(state);
  assert.throws(()=>migrate(state,request(bad)),undefined,JSON.stringify(Object.keys(bad)));
  assert.equal(JSON.stringify(state),before);
 }
 const state=make();
 state.tasks.push({...newTask({url:NEW,message:'existing',interval_seconds:600}),id:'existing-chat'});
 assert.throws(()=>migrate(state),/already|exists|занят|друг/i);
});
test('inflight receipt, ambiguous states and busy worker prohibit handoff',()=>{
 const states=[
  t=>{t.status='unknown'},
  t=>{t.verification={attempt:'committed'}},
  t=>{t.active_slot_id='in-flight'},
  t=>{t.smart_v2_pending_action='CONTINUE_DEVELOPMENT'},
  t=>{t.enabled=true;t.status='scheduled';t.next_at=new Date().toISOString()},
  t=>{t.slot_ledger=[{id:'clicked',state:'unknown'}]},
 ];
 for(const change of states){
  const before=make();change(before.tasks[0]);const snapshot=JSON.stringify(before);
  assert.throws(()=>migrate(before),/paused|unresolved|busy|blocked|verification|slot|pending|unknown/i);
  assert.equal(JSON.stringify(before),snapshot);
 }
 assert.throws(()=>planChatHandoff(make(),request(),{workerBusy:true}),/busy|занят/i);
 assert.throws(()=>planChatHandoff(make(),request(),{currentTaskId:'fixture-old'}),/busy|занят/i);
});
test('archived task is excluded even if a damaged persistent record is re-enabled',()=>{
 const {state}=migrate();
 state.tasks[0].enabled=true;state.tasks[0].status='scheduled';state.tasks[0].next_at=new Date(0).toISOString();
 assert.deepEqual(dueTasks(state,Date.now()),[]);
 assert.throws(()=>assertTaskMutable(state.tasks[0]),/архив/i);
});
