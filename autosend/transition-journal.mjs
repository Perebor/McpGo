/** MCP-04. Bounded, append-only logical transition journal, co-committed with
 * tasks.json. It records only non-secret status metadata (never prompts/URLs).
 * It is NOT a second authority for whether Send is permitted: durable receipt,
 * task status and slot reservations in tasks.json remain authoritative.
 */
export const MAX_TRANSITIONS=256;
export const TRANSITION_KINDS=Object.freeze([
 'BASELINE_IMPORTED','TASK_CREATED','TASK_REMOVED','STATUS_CHANGED',
 'RECEIPT_CHANGED','SLOT_CHANGED','ENABLED_CHANGED','STAGE_CHANGED',
 'DELIVERY_COUNT_CHANGED'
]);
const KINDS=new Set(TRANSITION_KINDS);
const SNAP_KEYS=['status','enabled','manual','receipt','slot','deliveryStage','deliveryCount'];
const STAGES=new Set(['','preflight','click-committed','guard-refused','verifying',
 'verification-expired','manual-readonly-check','manual-confirmed','verified']);
const STATUSES=new Set(['paused','scheduled','checking','sending','verifying','unknown','blocked']);

function projection(t){
 return {
  status:STATUSES.has(t.status)?t.status:'invalid',
  enabled:t.enabled===true,manual:t.manual_once===true,
  receipt:!!t.verification,slot:!!t.active_slot_id,
  deliveryStage:STAGES.has(t.delivery_stage)?t.delivery_stage:'other',
  deliveryCount:Number.isSafeInteger(t.delivery_count)&&t.delivery_count>=0?t.delivery_count:0
 };
}
function snapshot(tasks){
 if(!Array.isArray(tasks))throw Error('Transition snapshot requires tasks');
 const map=new Map();
 for(const t of tasks){
  if(typeof t?.id!=='string'||!t.id||map.has(t.id))
   throw Error('Transition snapshot duplicate or invalid task ID');
  map.set(t.id,projection(t));
 }
 return map;
}
function strictProjection(p){
 if(p===null)return true;
 if(!p||typeof p!=='object'||Array.isArray(p)||
  Object.keys(p).length!==SNAP_KEYS.length||SNAP_KEYS.some(k=>!Object.hasOwn(p,k)))return false;
 return (STATUSES.has(p.status)||p.status==='invalid') &&
  ['enabled','manual','receipt','slot'].every(k=>typeof p[k]==='boolean') &&
  (STAGES.has(p.deliveryStage)||p.deliveryStage==='other') &&
  Number.isSafeInteger(p.deliveryCount)&&p.deliveryCount>=0;
}
/** Used by readState and writeState; old v1 stores without a journal migrate. */
export function validateTransitionJournal(journal,sequence){
 if(journal===undefined&&sequence===undefined)return true;
 if(!Array.isArray(journal)||!Number.isSafeInteger(sequence)||sequence<0||journal.length>MAX_TRANSITIONS)
  throw Error('Invalid AutoSend transition journal metadata or sequence');
 let prev=0;
 for(const e of journal){
  if(!e||typeof e!=='object'||Array.isArray(e)||
    Object.keys(e).sort().join(',')!=='at,from,kind,seq,task_id,to,version' ||
    e.version!==1||!Number.isSafeInteger(e.seq)||e.seq<=prev||
    !Number.isFinite(Date.parse(e.at))||
    typeof e.task_id!=='string'||!e.task_id||!KINDS.has(e.kind))
   throw Error('Invalid AutoSend transition journal kind/record');
  if(!strictProjection(e.from)||!strictProjection(e.to)||(e.from===null&&e.to===null))
   throw Error('Invalid AutoSend transition journal snapshot/field');
  if(prev&&e.seq!==prev+1)throw Error('Noncontiguous AutoSend transition journal sequence');
  prev=e.seq;
 }
 if((journal.length>0&&prev!==sequence)||(journal.length===0&&sequence!==0))
  throw Error('AutoSend transition journal sequence mismatch');
 return true;
}

function kind(from,to){
 if(!from)return 'TASK_CREATED';
 if(!to)return 'TASK_REMOVED';
 if(from.status!==to.status)return 'STATUS_CHANGED';
 if(from.receipt!==to.receipt)return 'RECEIPT_CHANGED';
 if(from.slot!==to.slot)return 'SLOT_CHANGED';
 if(from.enabled!==to.enabled||from.manual!==to.manual)return 'ENABLED_CHANGED';
 if(from.deliveryStage!==to.deliveryStage)return 'STAGE_CHANGED';
 return 'DELIVERY_COUNT_CHANGED';
}
/** Returns a new journal; caller persists it atomically with state and adopts
 * the returned snapshot only after writeState succeeds. No historic backfill.
 */
export function nextTransitionJournal({before,after,journal,sequence},at=new Date().toISOString()){
 validateTransitionJournal(journal,sequence);
 if(!Number.isFinite(Date.parse(at)))throw Error('Invalid journal timestamp');
 const prior=snapshot(before),next=snapshot(after);
 const legacy=journal===undefined;
 let seq=sequence??0;
 const entries=[...(journal??[])];
 const append=(type,id,from,to)=>{
  if(seq>=Number.MAX_SAFE_INTEGER)throw Error('Journal sequence exhausted');
  entries.push({version:1,seq:++seq,at,task_id:id,kind:type,from,to});
 };
 if(legacy)for(const id of [...prior.keys()].sort())
  append('BASELINE_IMPORTED',id,null,prior.get(id));
 for(const id of [...new Set([...prior.keys(),...next.keys()])].sort()){
  const from=prior.get(id)??null,to=next.get(id)??null;
  if(JSON.stringify(from)===JSON.stringify(to))continue;
  // Critical fail-closed edges. A committed click MUST have a durable receipt
  // before Send; UNKNOWN may only be reconciled or owner-confirmed, never armed.
  if(from?.status==='unknown'&&to?.status==='scheduled')
   throw Error('Unsafe UNKNOWN to scheduled transition: owner reconciliation required');
  if(to&&['sending','verifying'].includes(to.status)&&!to.receipt)
   throw Error('AutoSend FSM: committed or verifying Send requires durable receipt');
  append(kind(from,to),id,from,to);
 }
 const result={log:entries.slice(-MAX_TRANSITIONS),sequence:seq};
 validateTransitionJournal(result.log,result.sequence);
 return result;
}
