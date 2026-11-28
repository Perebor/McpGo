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

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE='LOCAL_AUTOSEND_RECEIPT_NOT_PROVIDER_SIGNED';
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
 const db=openDatabase(file);
 let inserted=0;
 try{
  db.exec('BEGIN IMMEDIATE');
  const get=db.prepare('SELECT event_fingerprint FROM autosend_observations WHERE event_id=?');
  const put=db.prepare(`INSERT INTO autosend_observations(
    event_id,project,agent,task_id,outcome,observed_at,source_kind,event_fingerprint)
    VALUES(?,?,?,?,?,?,?,?)`);
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
  db.exec('COMMIT');
 }catch(e){try{db.exec('ROLLBACK')}catch{};throw e}
 finally{db.close()}
 return {inserted,inspected:events.length};
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
  return rows.map(r=>({...r,provider_confirmed_model_calls:null,
    input_tokens:null,output_tokens:null,cost_measurement:'UNKNOWN',
    evidence_source:SOURCE}));
 }finally{db.close()}
}
