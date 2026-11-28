import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {modelUsageEventForAttempt,syncModelUsageLedger,readModelUsageSummary} from '../model-use-ledger.mjs';

const makeTemp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo36-usage-'));
const task=(project='TD')=>({id:crypto.randomUUID(),smart_v2_project:project,
  project_label:null,status:'paused',enabled:false,message:'DO_NOT_STORE_PRIVATE_PROMPT'});
const attempt=(result='verified')=>({id:crypto.randomUUID(),result,
  time:new Date().toISOString(),diagnostic:{url:'https://chatgpt.com/c/private',body:'SECRET_PROMPT'}});
test('MCP-12 automatically persists exactly one independently verified ChatGPT response per receipt ID',()=>{
 const dir=makeTemp();try{
  const t=task(),a={...attempt(),task_id:null};a.task_id=t.id;
  const event=modelUsageEventForAttempt(t,a);
  assert.equal(event.project,'TD');
  assert.equal(event.agent,'chatgpt_autosend');
  assert.equal(event.outcome,'CHAT_RESPONSE_OBSERVED');
  assert.equal(JSON.stringify(event).includes('SECRET'),false);
  assert.equal(JSON.stringify(event).includes('chatgpt.com'),false);
  a.model_usage_observation=event;
  const store=path.join(dir,'usage.sqlite3');
  assert.equal(syncModelUsageLedger({tasks:[t],attempts:[a]},store).inserted,1);
  assert.equal(syncModelUsageLedger({tasks:[t],attempts:[a]},store).inserted,0);
  const rows=readModelUsageSummary(store);
  assert.equal(rows.length,1);
  assert.equal(rows[0].project,'TD');
  assert.equal(rows[0].agent,'chatgpt_autosend');
  assert.equal(rows[0].observed_chat_responses,1);
  assert.equal(rows[0].provider_confirmed_model_calls,null);
  assert.equal(rows[0].input_tokens,null);
  assert.equal(rows[0].cost_measurement,'UNKNOWN');
  const bytes=fs.readFileSync(store);
  assert.equal(bytes.includes('SECRET_PROMPT'),false);
  assert.equal(bytes.includes('chatgpt.com'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MCP-12 automatic ledger separates unknown delivery, manual attestation and genuine DOM receipt',()=>{
 const dir=makeTemp();try{
  const t=task('Museum'),a=attempt('unknown'),b=attempt('verified_manual'),c=attempt('verified');
  for(const x of [a,b,c])x.task_id=t.id;
  for(const x of [a,b,c])x.model_usage_observation=modelUsageEventForAttempt(t,x);
  const store=path.join(dir,'usage.sqlite3');
  assert.equal(syncModelUsageLedger({tasks:[t],attempts:[a,b,c]},store).inserted,3);
  const row=readModelUsageSummary(store)[0];
  assert.equal(row.observed_chat_responses,1);
  assert.equal(row.delivery_unknown,1);
  assert.equal(row.owner_attested_responses,1);
  assert.equal(row.provider_confirmed_model_calls,null);
  const db=new DatabaseSync(store,{readOnly:true});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM autosend_observations').get().n,3);
  db.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MCP-12 evidence cannot be reassigned to another project, duplicate or untrusted status',()=>{
 const dir=makeTemp();try{
  const t=task(),a=attempt('verified');a.task_id=t.id;
  const event=modelUsageEventForAttempt(t,a);a.model_usage_observation=event;
  const file=path.join(dir,'usage.sqlite3');
  syncModelUsageLedger({tasks:[t],attempts:[a]},file);
  const evil={...event,project:'Museum'};
  assert.throws(()=>syncModelUsageLedger({tasks:[t],attempts:[{...a,model_usage_observation:evil}]},file),/scope|mismatch|conflict|integrity/i);
  const noEvidence=attempt('skipped');
  assert.equal(modelUsageEventForAttempt(t,noEvidence),null);
  const bogus=attempt('verified');bogus.task_id=t.id;
  bogus.model_usage_observation={...event,event_id:'invalid'};
  assert.throws(()=>syncModelUsageLedger({tasks:[t],attempts:[bogus]},file),/invalid|mismatch/i);
  assert.equal(readModelUsageSummary(file)[0].observed_chat_responses,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MCP-12 custom projects are scoped by immutable task ID, not user-editable label',()=>{
 const t={...task(''),smart_v2_project:null,project_label:'My Project'};
 const a=attempt('verified'),event=modelUsageEventForAttempt(t,a);
 assert.equal(event.project,'task:'+t.id);
 assert.equal(event.agent,'chatgpt_autosend');
 assert.equal(JSON.stringify(event).includes('My Project'),false);
});

test('MCP-12 removing a task after a committed receipt cannot erase its usage evidence',()=>{
 const dir=makeTemp();try{
  const t=task(),a={...attempt('verified'),task_id:t.id};
  a.model_usage_observation=modelUsageEventForAttempt(t,a);
  const store=path.join(dir,'usage.sqlite3');
  assert.equal(syncModelUsageLedger({tasks:[t],attempts:[a]},store).inserted,1);
  assert.equal(syncModelUsageLedger({tasks:[],attempts:[a]},store).inserted,0);
  assert.equal(readModelUsageSummary(store)[0].observed_chat_responses,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MCP-12 unrecognized legacy task identifiers never abort a valid pre-existing manual receipt',()=>{
 const legacy={...task(),id:'legacy-task-not-uuid'};
 const a={...attempt('verified_manual'),task_id:legacy.id};
 assert.equal(modelUsageEventForAttempt(legacy,a),null);
});
