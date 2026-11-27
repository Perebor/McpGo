// MCP-11: single-store, owner-approved ChatGPT chat handoff. This module
// performs NO Send, browser navigation, Hub registration, or model execution.
// The caller must atomically persist the returned state before acknowledging.
import crypto from 'node:crypto';
import {newTask,normalizeTarget,hasUnresolvedTask} from './core.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA=/^[a-f0-9]{40}$/;
const SHA256=/^[a-f0-9]{64}$/;
const REF=/^[a-zA-Z0-9][a-zA-Z0-9_.\-/]{0,119}$/;
const CHECKPOINT_KEYS=['task_id','branch','commit','evidence_sha256','receipt_id','last_ack_id','summary'];
function assertKeys(value,keys,name){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==keys.length||
    Object.keys(value).some(k=>!keys.includes(k)))
  throw Error('Invalid '+name+' schema');
}
function digest(value){
 return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function checkpointData(value){
 assertKeys(value,CHECKPOINT_KEYS,'checkpoint');
 for(const name of ['task_id','branch','receipt_id','last_ack_id']){
  if(typeof value[name]!=='string'||!REF.test(value[name]))
   throw Error('Invalid checkpoint '+name);
 }
 if(!GIT_SHA.test(value.commit)||!SHA256.test(value.evidence_sha256))
  throw Error('Invalid checkpoint Git/evidence fingerprint');
 if(typeof value.summary!=='string'||value.summary.trim().length<12||
    value.summary.length>1800||value.summary.includes('\0'))
  throw Error('Invalid checkpoint summary');
 return value;
}
function projectPrefix(chat){
 const url=new URL(chat);
 const hit=url.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9-]+)\/c\//);
 return hit?hit[1].toLowerCase():null;
}
function assertSameScope(source,target){
 // A project-scoped conversation cannot become an unscoped or foreign chat.
 if(projectPrefix(source)!==projectPrefix(target))
  throw Error('Cross-project chat handoff denied');
}
function errorBusy(){return Error('Handoff busy/blocked: pause and reconcile the existing delivery first');}
function isPendingLedger(task){
 return Array.isArray(task.slot_ledger)&&task.slot_ledger.some(x=>
  ['unknown','clicked','verifying','sending','checking'].includes(x?.state));
}
function makeMessage(source,checkpoint){
 const content=[
  '[MCPGO_OWNER_APPROVED_HANDOFF_V1]',
  'The previous chat is retired. No previous Send or LLM result is implied by this checkpoint.',
  'Prior task: '+checkpoint.task_id,
  'Git branch: '+checkpoint.branch,
  'Git commit (owner-provided): '+checkpoint.commit,
  'Evidence SHA256 (owner-provided): '+checkpoint.evidence_sha256,
  'Receipt ID (owner-provided): '+checkpoint.receipt_id,
  'Last ACK ID (owner-provided): '+checkpoint.last_ack_id,
  'Checkpoint notes (owner-provided, independently verify):',
  checkpoint.summary.trim(),
  'Previous owner-approved continuation instruction:',
  source.message
 ].join('\n');
 if(content.length>8000)throw Error('Handoff context exceeds encrypted message length; owner must shorten it');
 return content;
}
function approvedRequest(data){
 assertKeys(data,['source_id','target_url','owner_confirmed_target','idempotency_key','checkpoint'],'handoff');
 if(typeof data.source_id!=='string'||data.source_id.length>120||!data.source_id)
  throw Error('Invalid source ID');
 if(typeof data.idempotency_key!=='string'||!UUID.test(data.idempotency_key))
  throw Error('Invalid idempotency key');
 const target=normalizeTarget(data.target_url);
 if(data.owner_confirmed_target!==target)
  throw Error('Owner approval must match exact canonical target chat URL');
 return {target,key:data.idempotency_key.toLowerCase(),checkpoint:checkpointData(data.checkpoint)};
}
/**
 * Return a NEW state snapshot. Caller must write it once using encrypted
 * writeState(); on failure retain original state and never emit a receipt.
 *
 * The old task remains in the encrypted store for receipts and historical
 * provenance. The new task is paused and never inherits an in-flight slot.
 */
export function planChatHandoff(state,data,{
 time=new Date().toISOString(),newId=crypto.randomUUID(),
 workerBusy=false,currentTaskId=null
}={}){
 if(!state||!Array.isArray(state.tasks)||!Array.isArray(state.attempts))
  throw Error('Invalid AutoSend state');
 const {target,key,checkpoint}=approvedRequest(data);
 const source=state.tasks.find(t=>t.id===data.source_id);
 if(!source)throw Error('Source task does not exist');
 const normalizedOld=normalizeTarget(source.url);
 assertSameScope(normalizedOld,target);
 if(target===normalizedOld)throw Error('New chat must be different from archived source');
 const fingerprint=digest({source_id:source.id,target_url:target,checkpoint});
 if(source.handoff_archived_at){
  if(source.handoff_idempotency_key!==key ||
     source.handoff_target_url!==target ||
     source.handoff_checkpoint_sha256!==fingerprint)
   throw Error('Conflicting handoff replay with different target/context');
  const successor=state.tasks.find(t=>t.id===source.handoff_replaced_by);
  if(!successor||successor.handoff_origin_task_id!==source.id)
   throw Error('Handoff receipt incomplete; manual recovery required');
  return {state,receipt:{
    status:'ALREADY_STAGED',source_id:source.id,target_id:successor.id,
    checkpoint_sha256:fingerprint,sendBlocked:true}};
 }
 if(state.tasks.some(t=>normalizeTarget(t.url)===target))
  throw Error('Target chat already exists in AutoSend, refuse duplicate schedule');
 if(workerBusy||currentTaskId===source.id||hasUnresolvedTask(source)||
    source.status!=='paused'||source.enabled||source.next_at||source.manual_once||
    source.smart_v2_pending_action||isPendingLedger(source))
  throw errorBusy();
 if(typeof source.message!=='string')throw Error('Encrypted source message unavailable');
 if(typeof time!=='string'||!Number.isFinite(Date.parse(time)))
  throw Error('Invalid durable handoff timestamp');
 if(typeof newId!=='string'||!newId||state.tasks.some(t=>t.id===newId))
  throw Error('Unsafe replacement task ID');
 const nextMessage=makeMessage(source,checkpoint);
 // Preserve only validated schedule configuration. Never migrate receipts,
 // a pending Smart V2 action, active slot, auto-approval or enabled state.
 const successor=newTask({...source,url:target,message:nextMessage,
                           guided_first_run:false},Date.parse(time));
 successor.id=newId;
 successor.manual_once=false;
 successor.smart_v2=false;
 successor.smart_v2_project=null;
 successor.smart_result_gate=false;
 successor.handoff_requires_owner_reconfigure=true;
 successor.handoff_origin_task_id=source.id;
 successor.handoff_idempotency_key=key;
 successor.handoff_checkpoint_sha256=fingerprint;
 successor.handoff_last_ack_id=checkpoint.last_ack_id;
 successor.handoff_created_at=time;
 const archived={...source,
   enabled:false,next_at:null,status:'paused',manual_once:false,
   handoff_archived_at:time,
   handoff_idempotency_key:key,
   handoff_checkpoint_sha256:fingerprint,
   handoff_target_url:target,
   handoff_replaced_by:newId};
 const next={...state,tasks:state.tasks.map(t=>t.id===source.id?archived:t).concat(successor)};
 return {state:next,receipt:{
    status:'STAGED_PAUSED',source_id:source.id,target_id:newId,
    checkpoint_sha256:fingerprint,sendBlocked:true}};
}
