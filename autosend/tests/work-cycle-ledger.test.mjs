import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {modelUsageEventForAttempt,syncModelUsageLedger,readModelUsageSummary,readVerifiedWorkLinks} from '../model-use-ledger.mjs';
import {inspectWorkResult,commitObservedWorkResult} from '../work-result.mjs';
const sha='a'.repeat(40),fp='b'.repeat(64),repo='Perebor/Museum';
const policy={project:'Museum',repo,requiredWorkflows:['Museum starter checks','Fictional museum XSS Chromium guard']};
const now=Date.parse('2026-11-28T07:45:00.000Z');
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo12-work-link-'));
function setup({work='VERIFIED',receipt='verified'}={}){
 const task={id:crypto.randomUUID(),smart_v2_project:'Museum',
  last_success_at:'2026-11-28T07:20:00.000Z',status:'paused',enabled:false};
 const attempt={id:crypto.randomUUID(),task_id:task.id,result:receipt,
   time:'2026-11-28T07:40:00.000Z'};
 attempt.model_usage_observation=modelUsageEventForAttempt(task,attempt);
 const outcome={kind:'report',fingerprint:fp,
   report:{status:'IN_PROGRESS',action:'CONTINUE_CURRENT'},
   workEvidence:{source:'assistant_self_report',files_changed:2,tests_passed:8,tests_failed:0}};
 const proof={verified:true,testsVerified:true,source:'github_ci_verified',project:'Museum',
   repo,fingerprint:fp,sha,prNumber:17,provenAt:'2026-11-28T07:42:00.000Z',
   workflows:policy.requiredWorkflows.map((name,i)=>({name,runId:100+i}))};
 return {task,attempt,outcome,proof};
}
async function applyProof(fixture,{verified=true}={}){
 const {task,outcome,proof}=fixture;
 const result=await inspectWorkResult(task,outcome,
  {policy,now,verify:verified?async()=>proof:async()=>null});
 assert.ok(commitObservedWorkResult(task,result,now));
 return result;
}
test('MCP-12 real independent Git/CI proof links exact SHA and PR to one prior DOM-verified receipt',async()=>{
 const x=setup();await applyProof(x);
 const dir=temp();try{
  const file=path.join(dir,'usage.sqlite3');
  const first=syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file);
  assert.equal(first.inserted,1);
  assert.equal(first.linked,1);
  const links=readVerifiedWorkLinks(file,{project:'Museum'});
  assert.equal(links.length,1);
  assert.equal(links[0].task_id,x.task.id);
  assert.equal(links[0].receipt_event_id,'autosend:'+x.attempt.id);
  assert.equal(links[0].git_sha,sha);
  assert.equal(links[0].repo,repo);
  assert.equal(links[0].pr_number,17);
  assert.match(links[0].proof_fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(links[0].evidence_source,'LOCAL_GITHUB_CI_ADAPTER_TEMPORAL_LINK');
  assert.equal(readModelUsageSummary(file)[0].verified_git_work_links,1);
  assert.equal(readModelUsageSummary(file)[0].provider_confirmed_model_calls,null);
  assert.equal(readModelUsageSummary(file)[0].cost_measurement,'UNKNOWN');
  assert.equal(syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file).linked,0,
    'Replay of same real work result and receipt cannot inflate usage');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MCP-12 no link for self-reported Git, manual/UNKNOWN receipts, future work or disconnected task',async()=>{
 for(const mode of ['SELF_REPORT','verified_manual','unknown','future','foreign']){
  const x=setup({receipt:['verified_manual','unknown'].includes(mode)?mode:'verified'});
  await applyProof(x,{verified:mode!=='SELF_REPORT'});
  if(mode==='future')x.attempt.time='2026-11-28T08:00:00.000Z';
  if(mode==='foreign')x.attempt.task_id=crypto.randomUUID();
  const dir=temp();try{
   const file=path.join(dir,'usage.sqlite3');
   if(['future','foreign'].includes(mode)){
    assert.throws(()=>syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file),
      /scope|mismatch|invalid|conflict/i,'Tampered receipt must reject atomically');
   }else syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file);
   assert.equal(readVerifiedWorkLinks(file,{project:'Museum'}).length,0,mode);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});
test('MCP-12 conflicting Git SHA or receipt attribution fails closed and never changes committed link',async()=>{
 const x=setup();await applyProof(x);const dir=temp();try{
  const file=path.join(dir,'usage.sqlite3');
  syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file);
  const prior=readVerifiedWorkLinks(file,{project:'Museum'})[0];
  x.task.work_result_git.sha='f'.repeat(40);
  assert.throws(()=>syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file),
    /conflict|integrity|invalid|mismatch/i);
  assert.deepEqual(readVerifiedWorkLinks(file,{project:'Museum'})[0],prior);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MCP-12 source work evidence is stored without messages, prompt body or provider-cost claims',async()=>{
 const x=setup();await applyProof(x);
 assert.equal(JSON.stringify(x.task.work_result).includes(sha),false,'Legacy work result metadata contract unchanged');
 const dir=temp();try{
  const file=path.join(dir,'usage.sqlite3');
  x.task.message='TOP_SECRET_OWNER_PROMPT';
  x.attempt.diagnostic={body:'TOP_SECRET_OWNER_PROMPT',url:'https://chatgpt.com/c/private'};
  syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file);
  const bytes=fs.readFileSync(file);
  assert.equal(bytes.includes('TOP_SECRET_OWNER_PROMPT'),false);
  assert.equal(bytes.includes('chatgpt.com'),false);
  const db=new DatabaseSync(file,{readOnly:true});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verified_work_links').get().n,1);
  db.close();
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('MCP-12 the same Git commit cannot be counted twice through another report or receipt',async()=>{
 const x=setup();await applyProof(x);
 const dir=temp();try{
  const file=path.join(dir,'usage.sqlite3');
  syncModelUsageLedger({tasks:[x.task],attempts:[x.attempt]},file);
  const next=setup();
  // A second independently verified work report mentions the same commit
  // inside the same project but a distinct owner-approved task and receipt.
  await applyProof(next);
  assert.notEqual(next.task.id,x.task.id);
  syncModelUsageLedger({tasks:[x.task,next.task],attempts:[x.attempt,next.attempt]},file);
  const row=readModelUsageSummary(file).find(v=>v.project==='Museum');
  assert.equal(row.observed_chat_responses,2);
  assert.equal(row.verified_git_work_links,1,
    'An unchanged Git SHA cannot count as two independently changed commits');
  assert.equal(readVerifiedWorkLinks(file,{project:'Museum'}).length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('MCP-12 old preview.36 receipt-only SQLite remains readable without new link table',()=>{
 const dir=temp();try{
  const file=path.join(dir,'usage.sqlite3');
  const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE autosend_observations(
    event_id TEXT PRIMARY KEY,project TEXT NOT NULL,agent TEXT NOT NULL,
    task_id TEXT NOT NULL,outcome TEXT NOT NULL,observed_at TEXT NOT NULL,
    source_kind TEXT NOT NULL,event_fingerprint TEXT NOT NULL)`);
  db.close();
  assert.deepEqual(readVerifiedWorkLinks(file,{project:'Museum'}),[]);
  assert.deepEqual(readModelUsageSummary(file),[]);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
