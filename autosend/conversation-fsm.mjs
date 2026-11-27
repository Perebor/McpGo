import {sameChatGPTConversation} from '../playwright/chatgpt-url.mjs';
/**
 * Persistent per-conversation finite-state model derived from tasks.json.
 * Individual task records remain the authoritative durable source across
 * restarts; there is no second database to drift out of sync.
 *
 * One conversation may be UNKNOWN while 3 other conversations remain free.
 * The dedicated Playwright Extension backend serializes AutoSend tabs.
 */
export const STATES=Object.freeze({
 READY:'READY',VERIFYING_SEND:'VERIFYING_SEND',UNKNOWN:'UNKNOWN',
 PAUSED:'PAUSED',CONFLICT:'CONFLICT'
});
const UNCERTAIN=new Set(['unknown']);
const IN_FLIGHT=new Set(['checking','sending','verifying']);

export function conversationState(tasks,url,now=Date.now()) {
 const group=tasks.filter(t=>sameChatGPTConversation(t.url,url));
 if(!group.length)return {state:STATES.PAUSED,blocked:false,task_ids:[],reason:'NO_TASKS'};
 const ids=group.map(t=>t.id);
 const uncertain=group.find(t=>UNCERTAIN.has(t.status));
 if(uncertain)return {state:STATES.UNKNOWN,blocked:true,
   task_ids:ids,owner_task_id:uncertain.id,reason:'UNRESOLVED_SEND'};
 const ongoing=group.find(t=>IN_FLIGHT.has(t.status));
 if(ongoing)return {state:STATES.VERIFYING_SEND,blocked:true,
   task_ids:ids,owner_task_id:ongoing.id,reason:'SEND_OR_VERIFY_IN_PROGRESS'};
 // A restored store may already contain duplicate enabled schedules or
 // dormant receipts despite the create/start-time guards.
 const conflict=group.find(t=>(t.enabled||t.manual_once)&&
   competingScheduleForChat(group,t));
 if(conflict)return {state:STATES.CONFLICT,blocked:true,task_ids:ids,
   owner_task_id:conflict.id,reason:'COMPETING_SCHEDULE_OR_RECEIPT'};
 const active=group.some(t=>t.enabled||t.manual_once);
 return {state:active?STATES.READY:STATES.PAUSED,
  blocked:false,task_ids:ids,reason:active?'CHECK_BEFORE_SEND':'DISABLED'};
}
export function conversationStates(tasks,now=Date.now()){
 const urls=[...new Set(tasks.map(t=>t.url))];
 return Object.fromEntries(urls.map(url=>[url,conversationState(tasks,url,now)]));
}
export function eligibleToSend(task,tasks,now=Date.now()) {
 if(task.status!=='scheduled'||!(task.enabled||task.manual_once)||
    !Number.isFinite(Date.parse(task.next_at))||Date.parse(task.next_at)>now)
   return false;
 // This task is scheduled; a conflict must arise from a DIFFERENT task in
 // the same conversation. No global lock on unrelated chats.
 // Recheck the same create/start guard at dispatch, including durable
 // receipts and old duplicate enabled tasks. Never trust just task.status.
 return !competingScheduleForChat(tasks,task);
}
export function nextDue(tasks,now=Date.now(),lastId=null,allowed=()=>true){
 // Keep the full task set for same-conversation conflict checks, then
 // apply the caller's eligibility gate without starving an unrelated chat.
 const eligible=tasks.filter(t=>eligibleToSend(t,tasks,now)&&allowed(t));
 // Stable ordering prevents one chat starving another on a single Chrome
 // session, while preserving the due time for scheduled work.
 eligible.sort((a,b)=>Date.parse(a.next_at)-Date.parse(b.next_at)||
   String(a.id).localeCompare(String(b.id)));
 if(lastId&&eligible.length>1) {
  const prior=eligible.findIndex(t=>t.id===lastId);
  if(prior>=0)return eligible[(prior+1)%eligible.length];
 }
 return eligible[0]||null;
}
export function canObserveTask(task,tasks) {
 if(!task.enabled||task.status!=='scheduled')return false;
 return !competingScheduleForChat(tasks,task);
}

/** Prevent two independently armed AutoSend schedules targeting one ChatGPT conversation.
 * A PAUSED, fully resolved historical task does not block its replacement.
 * Unlike conversationState(...).blocked, a currently enabled schedule MUST block.
 */
export function competingScheduleForChat(tasks,proposed) {
 return (tasks||[]).find(t=>t!==proposed&&
   sameChatGPTConversation(t.url,proposed?.url)&&
   (t.enabled===true||t.manual_once===true||
    ['unknown','checking','sending','verifying'].includes(t.status)||
    !!t.verification||!!t.active_slot_id))||null;
}
