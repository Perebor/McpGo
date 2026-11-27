import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextTransitionJournal,validateTransitionJournal} from '../transition-journal.mjs';

const now='2026-11-27T06:35:00.000Z';
const task=(id,status='paused',extra={})=>({id,status,enabled:false,manual_once:false,
  delivery_stage:'',delivery_count:0,verification:null,active_slot_id:null,...extra,
  message:'DO_NOT_JOURNAL',url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001'});
const advance=(before,after,previous={})=>nextTransitionJournal({before,after,...previous},now);

test('MCP-04 legacy tasks migrate with truthful baseline, not fabricated historical sends',()=>{
 const t=task('one');
 const result=advance([t],[t]);
 assert.equal(result.sequence,1);
 assert.equal(result.log.length,1);
 assert.equal(result.log[0].kind,'BASELINE_IMPORTED');
 assert.equal(result.log[0].from,null);
 assert.equal(result.log[0].to.status,'paused');
 assert.equal(result.log[0].to.deliveryCount,0);
 assert.doesNotMatch(JSON.stringify(result),/DO_NOT_JOURNAL|chatgpt.com/);
 assert.equal(validateTransitionJournal(result.log,result.sequence),true);
});

test('MCP-04 recording only persisted changes yields typed click, verification, unknown, manual recovery',()=>{
 let before=[];let taskNow=task('one');
 let history=advance(before,[taskNow],{journal:[],sequence:0});
 assert.equal(history.log.at(-1).kind,'TASK_CREATED');
 const cases=[
  [{status:'checking',enabled:true,active_slot_id:'slot1',delivery_stage:'preflight'},'STATUS_CHANGED'],
  [{status:'sending',enabled:true,verification:{baselineUserCount:1},delivery_stage:'click-committed'},'STATUS_CHANGED'],
  [{status:'verifying',enabled:true,delivery_stage:'verifying'},'STATUS_CHANGED'],
  [{status:'unknown',enabled:false,delivery_stage:'verification-expired'},'STATUS_CHANGED'],
  [{status:'verifying',enabled:false,delivery_stage:'manual-readonly-check'},'STATUS_CHANGED'],
  [{status:'paused',enabled:false,verification:null,active_slot_id:null,delivery_stage:'verified',delivery_count:1},'STATUS_CHANGED']
 ];
 for(const [delta,kind] of cases){
  const next={...taskNow,...delta};
  history=advance([taskNow],[next],{journal:history.log,sequence:history.sequence});
  assert.equal(history.log.at(-1).kind,kind);
  assert.equal(history.log.at(-1).from.status,taskNow.status);
  assert.equal(history.log.at(-1).to.status,next.status);
  taskNow=next;
 }
 assert.equal(history.log.length,7);
 assert.equal(history.sequence,7);
 assert.equal(history.log[2].to.receipt,true,'committed receipt is visible as a boolean');
 assert.equal(history.log[4].to.status,'unknown');
 assert.equal(history.log[4].to.receipt,true,'unknown receipt is never silently discarded');
 assert.equal(history.log.at(-1).to.deliveryCount,1);
 assert.equal(validateTransitionJournal(history.log,history.sequence),true);
});

test('MCP-04 journal records independent receipt/stage change and task removal',()=>{
 const a=task('a');let result=advance([a],[{...a,verification:{baselineUserCount:2}}],{journal:[],sequence:0});
 assert.equal(result.log.at(-1).kind,'RECEIPT_CHANGED');
 const after={...a,verification:{baselineUserCount:2},delivery_stage:'manual-readonly-check'};
 result=advance([{...a,verification:{baselineUserCount:2}}],[after],{journal:result.log,sequence:result.sequence});
 assert.equal(result.log.at(-1).kind,'STAGE_CHANGED');
 result=advance([after],[],{journal:result.log,sequence:result.sequence});
 assert.equal(result.log.at(-1).kind,'TASK_REMOVED');
 assert.equal(result.log.at(-1).to,null);
});

test('MCP-04 an unchanged persisted snapshot never makes up transitions and restart resumes sequence',()=>{
 const t=task('same');const migrated=advance([t],[t]);
 const noop=advance([t],[t],{journal:migrated.log,sequence:migrated.sequence});
 assert.deepEqual(noop,migrated);
 const resumed=advance([t],[{...t,enabled:true}],{journal:noop.log,sequence:noop.sequence});
 assert.equal(resumed.log.at(-1).kind,'ENABLED_CHANGED');
 assert.equal(resumed.log.at(-1).seq,2);
});

test('MCP-04 journal is bounded but sequence cannot reset across compaction',()=>{
 let t=task('bounded'),hist=advance([], [t],{journal:[],sequence:0});
 for(let i=0;i<320;i++){
  const next={...t,enabled:!t.enabled};
  hist=advance([t],[next],{journal:hist.log,sequence:hist.sequence});t=next;
 }
 assert.equal(hist.sequence,321);
 assert.equal(hist.log.length,256);
 assert.equal(hist.log[0].seq,66);
 assert.equal(hist.log.at(-1).seq,321);
 assert.equal(validateTransitionJournal(hist.log,hist.sequence),true);
});

test('MCP-04 malformed or stale journal metadata blocks mutation rather than resetting evidence',()=>{
 const t=task('x');
 const journal=advance([t],[t]);
 assert.throws(()=>advance([t],[t],{journal:journal.log,sequence:0}),/sequence/i);
 assert.throws(()=>advance([t],[t],{journal:[{...journal.log[0],kind:'FAKE_SEND'}],sequence:1}),/kind/i);
 assert.throws(()=>advance([t],[t],{journal:[{...journal.log[0],task_id:'x',to:{...journal.log[0].to,message:'secret'}}],sequence:1}),/snapshot|field/i);
});
test('MCP-04 FSM rejects unsafe restart of UNKNOWN without owner-confirmed resolution',()=>{
 const uncertain=task('unknown-id','unknown',{verification:{baselineUserCount:1}});
 const unsafe={...uncertain,status:'scheduled',enabled:true,verification:null};
 assert.throws(()=>advance([uncertain],[unsafe],{journal:[],sequence:0}),/UNKNOWN.*scheduled|unsafe.*transition/i);
});

test('MCP-04 FSM refuses persisting click-committed or verifying without a receipt',()=>{
 const checking=task('receipt-id','checking',{enabled:true,active_slot_id:'slot'});
 assert.throws(()=>advance([checking],[{...checking,status:'sending'}],{journal:[],sequence:0}),/receipt/i);
 assert.throws(()=>advance([checking],[{...checking,status:'verifying'}],{journal:[],sequence:0}),/receipt/i);
 const safe={...checking,status:'sending',verification:{baselineUserCount:1}};
 const result=advance([checking],[safe],{journal:[],sequence:0});
 assert.equal(result.log.at(-1).to.receipt,true);
});
