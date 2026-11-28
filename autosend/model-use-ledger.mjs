/**
 * MCP-12: automatic, independent delivery-observation accounting in SQLite.
 *
 * Counts owner-local AutoSend DOM-confirmed CHATGPT replies, unknown delivery
 * and manual attestation as DISTINCT outcomes. Does NOT claim provider-billed
 * model invocations, exact token usage, money, or Git work verification.
 *
 * The source receipt is an idempotent AutoSend attempt persisted in tasks.json
 * before this optional SQLite mirror. Replays after an interrupted mirror
 * cannot double count; conflicts fail closed. No URL, message or prompt stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {KNOWN_WORK_POLICIES} from './work-result.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE='LOCAL_AUTOSEND_RECEIPT_NOT_PROVIDER_SIGNED';
const WORK_SOURCE='LOCAL_GITHUB_CI_ADAPTER_TEMPORAL_LINK';
const SHA=/^[a-f0-9]{40}$/;
const FP=/^[a-f0-9]{64}$/;
const OUTCOMES=Object.freeze({
 verified:'CHAT_RESPONSE_OBSERVED',
 verified_manual:'OWNER_ATTESTED',
 unknown:'DELIVERY_UNKNOWN'
});
const TABLE=`CREATE TABLE IF NOT EXISTS autosend_observations(
 event_id TEXT PRIMARY KEY,
 project TEXT NOT NULL, agent TEXT NOT NULL,task_id TEXT NOT NULL,
 outcome TEXT NOT NULL,observed_at TEXT NOT NULL,
 source_kind TEXT NOT NULL,event_fingerprint TEXT NOT NULL
)`;
const IDX=`CREATE INDEX IF NOT EXISTS autosend_usage_by_actor
 ON autosend_observations(project,agent)`;
const WORK_TABLE=`CREATE TABLE IF NOT EXISTS verified_work_links(
 result_fingerprint TEXT PRIMARY KEY, task_id TEXT NOT NULL,project TEXT NOT NULL,
 agent TEXT NOT NULL,receipt_event_id TEXT NOT NULL,repo TEXT NOT NULL,
 git_sha TEXT NOT NULL,pr_number INTEGER NOT NULL,proof_fingerprint TEXT NOT NULL,
 result_observed_at TEXT NOT NULL, evidence_source TEXT NOT NULL,
 event_fingerprint TEXT NOT NULL,
 UNIQUE(project,repo,git_sha)
)`;
const WORK_IDX=`CREATE INDEX IF NOT EXISTS verified_work_by_actor
 ON verified_work_links(project,agent)`;

function projectScope(task){
 if(task?.smart_v2_project==='TD'||task?.smart_v2_project==='Museum')
  return task.smart_v2_project;
 return 'task:'+task.id;
}
export function modelUsageEventForAttempt(task,attempt){
 if(!task||!UUID.test(String(task.id||''))||!attempt||
    !UUID.test(String(attempt.id||'')))return null; // Legacy fixture IDs: never break a delivery.
 const outcome=OUTCOMES[attempt.result];
 if(!outcome)return null;
 const when=attempt.time;
 if(typeof when!=='string'||!Number.isFinite(Date.parse(when))||when.length>40)
  throw Error('Invalid AutoSend receipt timestamp');
 return Object.freeze({version:1,event_id:'autosend:'+attempt.id,
   project:projectScope(task),agent:'chatgpt_autosend',task_id:task.id,
   outcome,observed_at:when,source_kind:SOURCE});
}
/**
 * Chronological association, NOT proof that this chat caused the Git commit.
 * The upstream WORK_RESULT is independently verified by the GitHub/CI adapter.
 * Only one existing DOM-verified receipt from the exact same task may anchor
 * it. All absent, stale, manual or ambiguous evidence fails closed.
 */
export function workCycleLinkForTask(task,attempts){
 const w=task?.work_result,g=task?.work_result_git;
 const policy=KNOWN_WORK_POLICIES[task?.smart_v2_project];
 if(!policy||!UUID.test(String(task?.id||''))||
    w?.status!=='VERIFIED'||w.taskId!==task.id||
    w.project!==policy.project||!FP.test(w.fingerprint||'')||
    !FP.test(w.proofFingerprint||'')||
    g?.proofFingerprint!==w.proofFingerprint||
    g.resultFingerprint!==w.fingerprint||
    g.repo!==policy.repo||!SHA.test(g.sha||'')||
    !Number.isSafeInteger(g.prNumber)||g.prNumber<1||
    !Array.isArray(task?.work_result_seen)||
    !task.work_result_seen.some(x=>x?.fingerprint===w.fingerprint&&x.status==='VERIFIED')||
    !Number.isSafeInteger(task?.work_result_metrics?.verified)||
    task.work_result_metrics.verified<1)return null;
 const completed=Date.parse(w.updatedAt||''),proven=Date.parse(g.provenAt||'');
 if(!Number.isFinite(completed)||!Number.isFinite(proven)||proven>completed||
    completed-proven>7*24*3600*1000)return null;
 const candidates=(Array.isArray(attempts)?attempts:[])
  .filter(a=>{
   if(a?.task_id!==task.id||a.result!=='verified')return false;
   const observed=Date.parse(a.time||'');
   if(!Number.isFinite(observed)||observed>completed||
      completed-observed>7*24*3600*1000)return false;
   const source=modelUsageEventForAttempt(task,a);
   return source&&JSON.stringify(a.model_usage_observation)===JSON.stringify(source);
  }).sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
 if(candidates.length===0)return null;
 // Two receipts at the same instant are ambiguous; never select arbitrarily.
 if(candidates.length>1&&candidates[0].time===candidates[1].time)return null;
 return Object.freeze({result_fingerprint:w.fingerprint,task_id:task.id,
  project:policy.project,agent:'chatgpt_autosend',
  receipt_event_id:'autosend:'+candidates[0].id,
  repo:g.repo,git_sha:g.sha,pr_number:g.prNumber,
  proof_fingerprint:g.proofFingerprint,result_observed_at:w.updatedAt,
  evidence_source:WORK_SOURCE});
}
function fileSafe(file){
 if(typeof file!=='string' || !file.endsWith('.sqlite3'))throw Error('Invalid usage ledger path');
 const dir=path.dirname(file);
 if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(fs.lstatSync(dir).isSymbolicLink())throw Error('Refusing symlinked usage data directory');
 if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))
  throw Error('Refusing unsafe usage ledger file');
 return file;
}
function fingerprint(event){
 return crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
}
function openDatabase(file,{readOnly=false}={}){
 const checked=fileSafe(file);
 const db=new DatabaseSync(checked,{readOnly});
 if(!readOnly){
  db.exec('PRAGMA busy_timeout=10000');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(TABLE);
  db.exec(IDX);
  db.exec(WORK_TABLE);
  db.exec(WORK_IDX);
 }
 return db;
}
export function syncModelUsageLedger(state,file){
 if(!Array.isArray(state?.tasks)||!Array.isArray(state?.attempts))
  throw Error('Invalid AutoSend ledger state');
 const tasks=new Map(state.tasks.filter(t=>UUID.test(String(t?.id||''))).map(t=>[t.id,t]));
 const events=[];
 for(const a of state.attempts){
  if(!a?.model_usage_observation)continue; // do not infer old attempts
  const t=tasks.get(a.task_id);
  const event=a.model_usage_observation;
  if(t){
   const expected=modelUsageEventForAttempt(t,a);
   if(!expected||JSON.stringify(expected)!==JSON.stringify(event))
    throw Error('AutoSend usage scope or source mismatch');
   events.push(expected);
   continue;
  }
  // An owner can force-remove a completed task without deleting immutable
  // historical attempts. Recover only the exact previously tagged receipt,
  // never infer from a raw legacy attempt or an untrusted message.
  if(!UUID.test(String(a.task_id||''))||!UUID.test(String(a.id||''))||
     !event||event.version!==1||
     event.event_id!=='autosend:'+a.id||event.task_id!==a.task_id||
     event.agent!=='chatgpt_autosend'||
     !['TD','Museum','task:'+a.task_id].includes(event.project)||
     event.outcome!==OUTCOMES[a.result]||
     event.observed_at!==a.time||event.source_kind!==SOURCE)
   throw Error('Invalid orphaned AutoSend usage scope or receipt');
  events.push(event);
 }
 const links=state.tasks.map(t=>workCycleLinkForTask(t,state.attempts)).filter(Boolean);
 const db=openDatabase(file);
 let inserted=0,linked=0;
 try{
  db.exec('BEGIN IMMEDIATE');
  const get=db.prepare('SELECT event_fingerprint FROM autosend_observations WHERE event_id=?');
  const put=db.prepare(`INSERT INTO autosend_observations(
    event_id,project,agent,task_id,outcome,observed_at,source_kind,event_fingerprint)
    VALUES(?,?,?,?,?,?,?,?)`);
  const getLink=db.prepare('SELECT event_fingerprint FROM verified_work_links WHERE result_fingerprint=?');
  const getGit=db.prepare('SELECT result_fingerprint FROM verified_work_links WHERE project=? AND repo=? AND git_sha=?');
  const putLink=db.prepare(`INSERT INTO verified_work_links(
    result_fingerprint,task_id,project,agent,receipt_event_id,repo,git_sha,
    pr_number,proof_fingerprint,result_observed_at,evidence_source,event_fingerprint)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const event of events){
   const f=fingerprint(event);
   const existing=get.get(event.event_id);
   if(existing){
    if(existing.event_fingerprint!==f)throw Error('Conflicting AutoSend usage event; no replay');
    continue;
   }
   put.run(event.event_id,event.project,event.agent,event.task_id,
     event.outcome,event.observed_at,event.source_kind,f);
   inserted++;
  }
  for(const work of links){
   // A work link is valid only if the receipt was recorded in this same
   // transaction or a previous committed sync. No orphaned associations.
   const receipt=db.prepare('SELECT task_id,outcome,project FROM autosend_observations WHERE event_id=?')
    .get(work.receipt_event_id);
   if(!receipt||receipt.task_id!==work.task_id||receipt.project!==work.project||
      receipt.outcome!=='CHAT_RESPONSE_OBSERVED')continue;
   const f=fingerprint(work),existing=getLink.get(work.result_fingerprint);
   if(existing){
    if(existing.event_fingerprint!==f)throw Error('Conflicting verified Git work association');
    continue;
   }
   // Git SHA denotes one specific commit. A changed chat report cannot count
   // the same independently verified Git commit twice.
   if(getGit.get(work.project,work.repo,work.git_sha))continue;
   putLink.run(work.result_fingerprint,work.task_id,work.project,work.agent,
    work.receipt_event_id,work.repo,work.git_sha,work.pr_number,
    work.proof_fingerprint,work.result_observed_at,work.evidence_source,f);
   linked++;
  }
  db.exec('COMMIT');
 }catch(e){try{db.exec('ROLLBACK')}catch{};throw e}
 finally{db.close()}
 return {inserted,inspected:events.length,linked};
}
export function readModelUsageSummary(file){
 if(!fs.existsSync(file))return [];
 const db=openDatabase(file,{readOnly:true});
 try {
  const rows=db.prepare(`SELECT project,agent,
    SUM(CASE WHEN outcome='CHAT_RESPONSE_OBSERVED' THEN 1 ELSE 0 END) AS observed_chat_responses,
    SUM(CASE WHEN outcome='OWNER_ATTESTED' THEN 1 ELSE 0 END) AS owner_attested_responses,
    SUM(CASE WHEN outcome='DELIVERY_UNKNOWN' THEN 1 ELSE 0 END) AS delivery_unknown,
    COUNT(*) AS evidence_events
    FROM autosend_observations GROUP BY project,agent ORDER BY project,agent`).all();
  const verified=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='verified_work_links'").get()?
    db.prepare(`SELECT project,agent,COUNT(*) AS n FROM verified_work_links
    GROUP BY project,agent`).all():[];
  const totals=new Map(verified.map(x=>[x.project+'\\x00'+x.agent,x.n]));
  return rows.map(r=>({...r,verified_git_work_links:totals.get(r.project+'\\x00'+r.agent)||0,
    work_links_meaning:'TEMPORALLY_ASSOCIATED_NOT_CAUSALLY_PROVEN',
    provider_confirmed_model_calls:null,
    input_tokens:null,output_tokens:null,cost_measurement:'UNKNOWN',
    evidence_source:SOURCE}));
 }finally{db.close()}
}

/** Owner-local, read-only exact Git evidence; not an API/billing receipt. */
export function readVerifiedWorkLinks(file,{project}={}){
 if(project!==undefined&&!['TD','Museum'].includes(project))
  throw Error('Unsupported work-link project');
 if(!fs.existsSync(file))return [];
 const db=openDatabase(file,{readOnly:true});
 try{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='verified_work_links'").get())
   return [];
  const sql='SELECT task_id,project,agent,receipt_event_id,repo,git_sha,pr_number,'+
   'proof_fingerprint,result_observed_at,evidence_source FROM verified_work_links';
  return (project?db.prepare(sql+' WHERE project=? ORDER BY result_observed_at').all(project):
   db.prepare(sql+' ORDER BY result_observed_at').all());
 }finally{db.close()}
}
