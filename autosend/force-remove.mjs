import crypto from 'node:crypto';

// Force deletion is a scheduler operation, NEVER a browser operation.
// An in-flight task is hidden immediately but keeps its click receipt until
// the existing operation settles. Archived diagnostics contain NO message/URL.
export function visibleTasks(state){
 return (state.tasks||[]).filter(task=>!task.force_remove_requested_at && !task.handoff_archived_at);
}
function archiveAndRemove(state,task,time){
 const history=state.force_removed_tasks ||= [];
 if(!history.some(x=>x.task_id===task.id)){
  history.push({
   task_id:task.id,
   chat_sha256:crypto.createHash('sha256').update(String(task.url||'')).digest('hex'),
   previous_status:task.status,
   had_unresolved_receipt:task.status==='unknown'||!!task.verification||
    !!task.active_slot_id||['checking','sending','verifying'].includes(task.status),
   action_id_sha256:task.verification?.actionId?
    crypto.createHash('sha256').update(String(task.verification.actionId)).digest('hex'):null,
   requested_at:task.force_remove_requested_at||new Date(time).toISOString(),
   archived_at:new Date(time).toISOString(),
   last_delivery_stage:task.delivery_stage||null
  });
 }
 state.tasks=state.tasks.filter(x=>x.id!==task.id);
}
export function requestForceRemove(state,id,confirmed,now=Date.now(),options={}){
 if(confirmed!==true)throw Error('Требуется явное подтверждение принудительного удаления.');
 const t=state.tasks.find(x=>x.id===id);
 if(!t){
  if((state.force_removed_tasks||[]).some(x=>x.task_id===id))
   return {removed:true,alreadyRemoved:true,pending:false};
  throw Error('Расписание не найдено.');
 }
 if(t.force_remove_requested_at)
  return {removed:true,pending:true,alreadyRequested:true};
 const inFlight=options.inflight===true||['checking','sending','verifying'].includes(t.status);
 if(inFlight){
  t.force_remove_requested_at=new Date(now).toISOString();
  t.enabled=false;
  t.next_at=null;
  t.manual_once=false;
  // Never change status/verification/slot while a browser operation exists.
  return {removed:true,pending:true,
   note:'Скрыто. Отправка могла уже начаться; квитанция сохранена до окончания проверки.'};
 }
 archiveAndRemove(state,t,now);
 return {removed:true,pending:false,
  note:'Удалено из AutoSend. Неизвестная доставка не считается подтверждённой.'};
}
export function finalizeForcedRemovals(state,now=Date.now()){
 let count=0;
 for(const task of [...state.tasks]){
  if(!task.force_remove_requested_at)continue;
  if(['checking','sending','verifying'].includes(task.status))continue;
  archiveAndRemove(state,task,now);
  count++;
 }
 return count;
}
