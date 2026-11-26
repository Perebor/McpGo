import http from 'node:http';
import crypto from 'node:crypto';
import {deliverViaPlaywright,reconcileViaPlaywright,observeExistingChat} from './delivery.mjs';
import {probeBrowserHealth} from './browser-health.mjs';
import {safeEvidence,explainEvidence} from './chat-state.mjs';
import {verificationReceipt,canReconcile,expired,scheduleNextCheck,finishUnknown,finishVerified,recheckUnknown,restoreAttemptEvidence} from './reconciliation.mjs';
import {readState,writeState,newTask,arm,pause,dueTasks,markUnknownOnBoot,validateInput,rescheduleAfterAttempt,getOrCreateControlToken,setIntervalOffset,hasUnresolvedTask,assertTaskMutable} from './core.mjs';
import {stableSlotId,recordSlot,safeSlotStatus} from './schedule.mjs';
import {trackSmartContinuation} from './smart-continuation.mjs';
import {conversationState,conversationStates,eligibleToSend,nextDue,canObserveTask,competingScheduleForChat} from './conversation-fsm.mjs';
import {checkPreview} from './preview-check.mjs';
import {deferBusyIntervalRetry,confirmedBusyRetryReason} from './busy-retry.mjs';
import {chooseSmartAction,smartTaskMessage,promoteSmartReceipt,validateSmartConfiguration,resumeSmartTaskFromOwnerPause} from './smart-v2.mjs';
import {readSmartBrowserOutcome} from './smart-v2-browser.mjs';
import {requestForceRemove,finalizeForcedRemovals,visibleTasks} from './force-remove.mjs';
import {assessWorkReadiness,commitWorkReadiness,workEfficiency} from './smart-work-ready.mjs';
import {TabApproval,mayAutoObserve,mayAutoDispatch} from './tab-approval.mjs';
import {PersistentTabRecovery,loadTabConsent,allowedTarget} from './persistent-tabs.mjs';
import {autosendMcp} from './browser-client.mjs';

const PORT=Number(process.env.MCPHUB_AUTOSEND_PORT || 8972);
let backendOnline=false;let backendLastError='';let browserOnline=false;let browserLastError='';let browserLastSeen=null;let workerBusy=false;
const approvedTabs=new TabApproval();
const tabRecovery=new PersistentTabRecovery({
 client:autosendMcp(),config:null,approval:approvedTabs,
 verify:t=>checkPreview(t,(task,options)=>observeExistingChat(task,{...options,client:autosendMcp()}))
});
let lastTabRecoveryCheck=0;
const CHECK_MS=Number(process.env.MCPHUB_AUTOSEND_CHECK_MS||10000);
const CONTROL_TOKEN=getOrCreateControlToken();
const db=readState();
markUnknownOnBoot(db);
finalizeForcedRemovals(db);
writeState(db);
const MAX_IN_FLIGHT=240000;
function persist(){writeState(db)}
function now(){return new Date().toISOString()}
function find(id){const t=db.tasks.find(t=>t.id===id);if(!t)throw Error('Расписание не найдено.');return t}
function authenticated(req){
 const provided=req.headers['x-mcphub-token'];
 return req.headers['x-mcphub-client']==='native' && !req.headers.origin &&
  typeof provided==='string'&&/^[a-f0-9]{64}$/.test(provided)&&
  crypto.timingSafeEqual(Buffer.from(provided,'hex'),Buffer.from(CONTROL_TOKEN,'hex'));
}
function reply(res,code,obj,origin=null){
 const out=Buffer.from(JSON.stringify(obj));
 const headers={'Content-Type':'application/json; charset=utf-8','Content-Length':out.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'};
 if(origin){headers['Access-Control-Allow-Origin']=origin;headers.Vary='Origin';}
 res.writeHead(code,headers);res.end(out);
}
function historySummary(){
 const counts={verified:0,skipped:0,unknown:0,other:0};
 for(const a of db.attempts){
  if(['verified','verified_manual'].includes(a.result))counts.verified++;
  else if(['busy','deferred','skipped'].includes(a.result))counts.skipped++;
  else if(a.result==='unknown')counts.unknown++;
  else counts.other++;
 }
 return counts;
}
function view(){return {ok:true,tasks:visibleTasks(db).map(t=>({...t,work_efficiency:workEfficiency(t),browserConfirmed:approvedTabs.has(t.id)})),attempts:db.attempts.slice(-100).reverse(),
 historySummary:historySummary(),
 conversations:conversationStates(visibleTasks(db)),
 deliverySupported:true,deliveryReason:!backendOnline?'Ожидание Playwright Extension AutoSend: '+(backendLastError||'проверяем подключение'):
  browserOnline?'Выделенная группа AutoSend доступна; проверьте выбранный чат.':
  'Выделенный Playwright backend запущен; выберите чат через расширение.',
 extensionConnected:backendOnline&&browserOnline,extensionTransport:'Playwright MCP · расширение Chrome',
 // Native client decodes this as a structured ChromePageDiagnostic, not a string.
 extensionDiagnostic:null,extensionLastSeen:browserLastSeen,
 extensionVersion:'Playwright Extension',requiredExtensionVersion:'Playwright Extension',busyTask:db.tasks.find(t=>['checking','sending','verifying'].includes(t.status))?.id||'',serverTime:now()};}
async function previewTask(id){
 if(workerBusy)return {ready:false,reason:'Браузер занят текущей операцией.',sendBlocked:true};
 const t=find(id);
 workerBusy=true;
 try{
  let health;
  try{health=await probeBrowserHealth();}
  catch(e){return {ready:false,chatFound:false,
    reason:'Выделенный Playwright backend недоступен: '+String(e.message||e).slice(0,120),sendBlocked:true};}
  if(!health.connected)return {ready:false,chatFound:false,reason:health.reason,sendBlocked:true};
  const result=await checkPreview(t,observeExistingChat);
  approvedTabs.update(t.id,result.chatFound===true);
  browserOnline=approvedTabs.size>0;
  if(result.chatFound===true)browserLastSeen=now();
  return {...result,checkedAt:now()};
 }finally{workerBusy=false;}
}
async function recoverApprovedTabs(){
 if(workerBusy)return false;
 const consent=loadTabConsent();
 if(!consent)return false;
 if(Date.now()-lastTabRecoveryCheck<60000)return false;
 if(!db.tasks.some(t=>allowedTarget(t,consent)))return false;
 lastTabRecoveryCheck=Date.now();
 workerBusy=true;
 try{
  tabRecovery.config=consent;
  const result=await tabRecovery.run(db.tasks);
  browserOnline=approvedTabs.size>0;
  if(result.approved>0)browserLastSeen=now();
  return result;
 }catch{return false}
 finally{workerBusy=false}
}
function operation(action,body){
 switch(action){
  case 'create':{
   const t=newTask(body);db.tasks.push(t);persist();return {task:t};
  }
  case 'update':{
   const t=find(body.id);assertTaskMutable(t);
   const updated=validateInput(body);
   if(t.smart_v2){
    const expectedSlug=t.smart_v2_project==='TD'?'td-astra6':'moi-muzei-istoriia';
    if(!updated.url.includes(expectedSlug))throw Error('Smart V2: нельзя переместить расписание в другой проект.');
    validateSmartConfiguration({...t,...updated});
   }
   Object.assign(t,updated);approvedTabs.update(t.id,false);browserOnline=approvedTabs.size>0;t.schedule_revision=(t.schedule_revision||0)+1;
   if(t.smart_v2){t.smart_v2_last_action=null;t.smart_v2_pending_action=null;}
   delete t.watchdog;delete t.verification;pause(t);t.manual_once=false;t.safe_retry_count=0;t.last_error='';persist();return {task:t};
  }
  case 'set_result_trigger':{
   const t=find(body.id);
   assertTaskMutable(t);
   if(workerBusy||currentScheduledTaskId===t.id)
    throw Error('AutoSend: задача сейчас обрабатывается; переключение без риска Send невозможно.');
   if(t.smart_v2!==true||!['TD','Museum'].includes(t.smart_v2_project))
    throw Error('Нужен Smart V2, привязанный к проекту TD/Museum.');
   if(t.smart_v2_pending_action)
    throw Error('Ожидается квитанция предыдущего Smart V2 действия.');
   if(body.enabled!==true)throw Error('Для выбора событийного режима требуется enabled:true.');
   if(t.smart_result_gate&&t.schedule_mode==='after_response')
    return {task:t,alreadyEnabled:true,sendBlocked:true};
   t.schedule_mode='after_response';
   t.delay_seconds=30;t.max_continuations=200;
   t.interval_offset_seconds=null;t.smart_result_gate=true;
   t.next_at=null;t.smart_work_expected_action=null;
   t.smart_work_ready_evidence=null;t.smart_work_ready_marker=null;
   t.work_metrics||={useful_runs:0,reported_files_changed:0,reported_tests_passed:0,
    reported_tests_failed:0,source:'assistant_self_report'};
   t.smart_seen_busy=false;t.smart_ready_since=null;
   t.schedule_revision=(t.schedule_revision||0)+1;
   t.last_error=t.smart_v2_last_action?
    'Ожидание отчёта об изменениях и тестах — без запуска по таймеру.':
    'Событийный режим установлен. Нет предыдущего Smart V2 отчёта: начальный запуск — только вручную.';
   persist();
   return {task:t,sendBlocked:true,eventDriven:true,
    note:'Переключено без отправки. Проверка только после результата предыдущего задания.'};
  }
  case 'set_interval_offset':{
   const t=find(body.id);
   setIntervalOffset(t,body.interval_offset_seconds);
   persist();return {task:t};
  }
  case 'set_smart_v2':{
   const t=find(body.id);
   if(workerBusy||hasUnresolvedTask(t))throw Error('Smart V2: операция выполняется или квитанция отправки не подтверждена.');
   if(body.enabled===true){
    const candidate={...t,smart_v2_project:body.project};
    validateSmartConfiguration(candidate);
    if((body.project==='TD'&&!t.url.includes('td-astra6'))||
       (body.project==='Museum'&&!t.url.includes('moi-muzei-istoriia')))
     throw Error('Smart V2: указанный проект не соответствует разговору.');
    t.smart_v2=true;t.smart_v2_project=body.project;
    t.smart_v2_last_action=null;t.smart_v2_pending_action=null;
    delete t.smart_v2_pause_reason;
   }else if(body.enabled===false){
    t.smart_v2=false;t.smart_v2_last_action=null;t.smart_v2_pending_action=null;
    t.smart_v2_project=null;
    delete t.smart_v2_pause_reason;
   }else throw Error('Smart V2: enabled должен быть true/false');
   persist();return {task:t,changed:true,sendBlocked:true};
  }
  case 'start':{
   const t=find(body.id);assertTaskMutable(t);
   // Repeated clicks must not create a second immediate dispatch.
   if(t.enabled&&t.status==='scheduled')return {task:t,alreadyEnabled:true};
   if(t.manual_once&&t.status==='scheduled')
    throw Error('Сначала дождись окончания уже поставленной однократной отправки.');
   const competing=competingScheduleForChat(db.tasks,t);
   if(competing)throw Error('Нельзя включить второе расписание этого чата. Уже существует '+
    (competing.status==='unknown'?'неподтверждённая отправка':'действующее или незавершённое расписание')+
    ' (ID '+competing.id.slice(0,8)+', статус '+competing.status+'). '+
    'Сначала проверь прошлую отправку и выключи/удали прежний дубль.');
   if(t.smart_v2)resumeSmartTaskFromOwnerPause(t);
   delete t.watchdog;arm(t);t.manual_once=false;t.safe_retry_count=0;persist();
   // Try the first interval slot promptly, without waiting for the 10s tick.
   // The same scheduler/receipt guards handle the Send, never this handler.
   if((t.schedule_mode||'interval')==='interval')
    setImmediate(()=>{void schedulerTick().catch(()=>{});});
   return {task:t};
  }
  case 'pause':{
   const t=find(body.id);assertTaskMutable(t);
   delete t.watchdog;pause(t);t.manual_once=false;persist();return {task:t};
  }
  case 'remove':{
   const t=find(body.id);assertTaskMutable(t);
   db.tasks=db.tasks.filter(x=>x.id!==body.id);persist();return {removed:body.id};
  }
  case 'force_remove':{
   const result=requestForceRemove(db,body.id,body.confirmed,Date.now(),{
    inflight:currentScheduledTaskId===body.id});
   persist();return {...result,sendBlocked:true};
  }
  case 'recheck_unknown':{
   const t=find(body.id);
   if(workerBusy || db.tasks.some(x=>x.url===t.url && x.id!==t.id &&
      ['checking','sending','verifying'].includes(x.status)))
    throw Error('Дождись окончания проверки в этом разговоре.');
   recheckUnknown(t);persist();
   return {checking:true,sendBlocked:true};
  }
  case 'confirm_received':{
   // Explicit user attestation ONLY after checking ChatGPT personally.
   // This operation NEVER types/clicks/navigates and NEVER rearms a schedule.
   const t=find(body.id);
   if(t.status!=='unknown')throw Error('Подтвердить вручную можно только неизвестную попытку.');
   if(db.tasks.some(x=>x.id!==t.id && x.url===t.url &&
      ['checking','sending','verifying'].includes(x.status)))
    throw Error('В этом разговоре сейчас проверяется другая отправка.');
   const evidence=t.verification?.lastEvidence||null;
   t.enabled=false;t.manual_once=false;
   finishVerified(t);
   promoteSmartReceipt(t);
   t.status='paused';t.next_at=null;t.delivery_stage='manual-confirmed';
   t.last_error='Подтверждено пользователем вручную. Расписание осталось на паузе.';
   recordAttempt(t,'verified_manual',
     'Пользователь подтвердил, что сообщение присутствует в чате; автоматического доказательства не было.',
     evidence);
   persist();
   return {confirmed:true,sendBlocked:true,paused:true};
  }
  case 'clear_history':{
   if(db.tasks.some(hasUnresolvedTask))throw Error('История содержит данные незавершённой доставки; сначала завершите проверку.');
   const cleared=db.attempts.length;
   db.attempts=[];
   persist();
   return {cleared};
  }
  case 'send_once':{
   const t=find(body.id);assertTaskMutable(t);
   if(t.manual_once && t.status==='scheduled')throw Error('Однократная отправка уже ожидает выполнения.');
   const competing=competingScheduleForChat(db.tasks,t);
   if(competing)throw Error('В том же чате уже есть другое действующее или неопределённое задание (ID '+
    competing.id.slice(0,8)+', '+competing.status+'). Повторная Send запрещена.');
   // An explicit owner send_once is allowed to bootstrap an already-enabled
    // result-gated Smart V2 task. Automatic result-driven sends still require
    // verified work evidence; the flag is cleared after the one attempt.
    t.manual_once=!t.enabled||(t.smart_v2===true&&t.smart_result_gate===true&&t.schedule_mode==='after_response');
    t.status='scheduled';t.next_at=now();t.last_error='';persist();return {queued:true};
  }
  default:throw Error('Неизвестное действие.');
 }
}
function expireAmbiguous(){
 let changed=false;
 for(const t of db.tasks){
  // A prior non-proof sending record cannot be replayed. Fresh click receipts
  // are always reconciled read-only; none may trigger another Send.
  if(t.status==='sending' && Date.now()-Date.parse(t.last_attempt_at||0)>240000){
   if(t.verification){
    t.status='verifying';t.next_at=null;changed=true;
   }else{
    finishUnknown(t,'Сохранённая попытка не содержит baseline.');
    changed=true;
   }
  }
 }
 if(changed)persist();
}
// Only explicit smart-continuation schedules need an observation between
// deadlines. Regular intervals NEVER preempt their due time or reload Chrome.
let lastContinuationCheck=0,continuationCursor=0;
async function monitorContinuations(){
 if(workerBusy)return false;
 const candidates=db.tasks.filter(t=>!t.force_remove_requested_at&&canObserveTask(t,db.tasks)&&t.schedule_mode==='after_response'&&mayAutoObserve(t,approvedTabs.has(t.id)));
 if(!candidates.length)return false;
 const t=candidates[continuationCursor++%candidates.length];
 workerBusy=true;
 try{
  const probe=await observeExistingChat(t,{eventWaitMs:0});
  if(probe.status!=='ok'){
   if(['CHAT_TAB_MISSING','AMBIGUOUS_CHAT_TABS'].includes(probe.code)){
    approvedTabs.update(t.id,false);browserOnline=approvedTabs.size>0;
   }
   return false;
  }
  if(t.smart_result_gate&&t.smart_v2){
   if(!t.smart_v2_last_action)return false;
   const observed=await readSmartBrowserOutcome(t);
   if(observed.kind==='foreign_user'){
    pause(t);t.last_error='В разговоре сообщение владельца; событийный AutoSend остановлен.';
    persist();return true;
   }
   const decision=assessWorkReadiness(t,observed);
   if(decision.pause){
    pause(t);t.smart_v2_pause_reason=decision.reason;
    t.last_error='Smart V2: работа заблокирована или требуется решение владельца.';
    persist();return true;
   }
   if(decision.ready&&commitWorkReadiness(t,decision)){
    t.last_error='Готовность по отчёту задачи (self-report); следующий Send ожидает повторной read-only проверки.';
    persist();return true;
   }
   return false;
  }
  if(trackSmartContinuation(t,probe.observation)){persist();return true;}
  return false;
 }catch{return false;}
 finally{workerBusy=false;}
}
function recordAttempt(t,result,error='',evidence=null){
 const proof=evidence||t.verification?.lastEvidence||null;
 const finished=Date.now();
 const started=Date.parse(t.last_attempt_at||'');
 db.attempts.push({id:crypto.randomUUID(),task_id:t.id,time:new Date(finished).toISOString(),
   result,error,stage:t.delivery_stage||null,
   slot_id:t.active_slot_id||t.last_slot_id||null,
   scheduled_at:t.active_scheduled_at||t.last_scheduled_at||null,
   started_at:t.last_attempt_at||null,
   duration_ms:Number.isFinite(started)?Math.max(0,finished-started):null,
   diagnostic:proof?safeEvidence(proof):null});
 db.attempts=db.attempts.slice(-500);
}
async function reconcilePending(){
 const t=db.tasks.find(x=>canReconcile(x));
 if(!t)return false;
 if(workerBusy)return true;
 workerBusy=true;
 try{
  // Older builds overwrote positive DOM insertion evidence on the next
  // unsuccessful poll. Recover it from THIS click's timestamped journal;
  // still require a fresh exact user bubble and assistant activity.
  if(restoreAttemptEvidence(t,db.attempts))persist();
  const result=await reconcileViaPlaywright({...t,message:smartTaskMessage(t)},t.verification);
  if(result.status==='verified'){
   const proof=result.evidence;
   finishVerified(t);
   promoteSmartReceipt(t);
   approvedTabs.update(t.id,true);browserOnline=true;browserLastSeen=now();
   recordAttempt(t,'verified','',proof);
  }else if(expired(t)){
   finishUnknown(t,'Интерфейс чата не показал однозначное подтверждение.',result.evidence);
   recordAttempt(t,'unknown',t.last_error);
  }else{
   scheduleNextCheck(t,result.reason,Date.now(),result.evidence);
  }
  persist();
 }catch(e){
  if(expired(t)){
   finishUnknown(t,'Нет достоверной информации после браузерной ошибки',
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
   recordAttempt(t,'unknown',t.last_error);
  }else{
   scheduleNextCheck(t,'Ошибка чтения состояния страницы',Date.now(),
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
  }
  persist();
 }finally{if(finalizeForcedRemovals(db))persist();workerBusy=false;}
 return true;
}
// The periodic AutoSend readiness probe must not attach Chrome tabs. With
// Playwright Extension a 'read-only' browser_tabs(list) can open a fresh
// chrome-extension://.../connect.html and spawn another group every 30 seconds.
async function checkExtensionBackend(){
 // Passive port check only; never opens a Chrome tab or extension group.
 try{
  const health=await probeBrowserHealth();
  backendOnline=health.connected;
  backendLastError=health.reason;
  if(!backendOnline){approvedTabs.reset();browserOnline=false;}
 }catch(e){backendOnline=false;browserOnline=false;backendLastError='Не удалось проверить локальный backend';}
}
let lastScheduledTaskId=null;
let currentScheduledTaskId=null;
async function runScheduled(){
 if(workerBusy)return false;
 workerBusy=true;
 try {
 // A pending proof in chat A never blocks independent chat B. Browser tool
 // calls themselves remain serialized by the shared Chrome MCP proxy.
 const current=Date.now();
 const blocked=nextDue(db.tasks,current,lastScheduledTaskId);
 if(blocked&&!mayAutoDispatch(blocked,approvedTabs.has(blocked.id))){
  const reason='Не подтверждена вкладка этого чата в текущей сессии. Выберите её в Playwright Extension и нажмите «Проверить без отправки».';
  if(blocked.last_error!==reason){blocked.last_error=reason;persist();}
 }
 const t=nextDue(db.tasks,current,lastScheduledTaskId,x=>mayAutoDispatch(x,approvedTabs.has(x.id)));
 if(!t)return false;
 currentScheduledTaskId=t.id;
 // If the dedicated backend is not running, leave the due slot pending.
 const health=await probeBrowserHealth();
 if(t.force_remove_requested_at)return false;
 if(!health.connected){
  if(t.last_error!==health.reason){t.last_error=health.reason;persist();}
  return false;
 }
 lastScheduledTaskId=t.id;
 if(t.smart_v2){
  try{
   validateSmartConfiguration(t);
   const observed=t.smart_v2_last_action?await readSmartBrowserOutcome(t):{kind:'first'};
   if(t.force_remove_requested_at)return true;
   let decision;
   if(t.smart_result_gate&&t.schedule_mode==='after_response'&&!t.manual_once){
    const check=assessWorkReadiness(t,observed,{forDispatch:true});
    if(!check.ready){
     if(check.pause||observed.kind==='foreign_user'){
      pause(t);t.smart_v2_pause_reason=check.reason||'foreign_user';
      t.last_error='Событийный Smart V2 остановлен: '+(check.reason||'вмешательство владельца');
     }else if(['busy','unavailable','unstable'].includes(observed.kind)){
      t.next_at=new Date(Date.now()+60000).toISOString();
      t.last_error='Событийный Smart V2: временно занято, повторная проверка через минуту без Send.';
     }else{
      t.next_at=null;t.last_error='Нет актуального доказательства результата; новая отправка запрещена.';
     }
     persist();return true;
    }
    decision={action:check.action,send:true};
   }else decision=chooseSmartAction(t,observed);
   if(!decision.send){
    if(decision.pause){
     pause(t);
     t.smart_v2_pause_reason=decision.reason||'NEED_OWNER';
     t.last_error=decision.reason==='foreign_user'
      ?'Smart V2: владелец написал сообщение вручную. Расписание приостановлено; для возобновления включи его снова.'
      :'Smart V2: требуется решение владельца или нет подтверждённого отчёта.';
    }else{
     t.next_at=new Date(Date.now()+60000).toISOString();
     t.last_error='Smart V2: предыдущий ответ занят, изменился или недоступен. Проверка через минуту без Send.';
    }
    persist();return true;
   }
   t.smart_v2_pending_action=decision.action;
   persist();
  }catch{
   t.next_at=new Date(Date.now()+60000).toISOString();
   t.last_error='Smart V2: ошибка подготовки; повтор через минуту без Send.';
   persist();return true;
  }
 }
 let scheduledAt,slotId,previous;
 try{
  scheduledAt=t.next_at||now();
  slotId=stableSlotId(t,scheduledAt);
  previous=safeSlotStatus(t,slotId);
 }catch{
  // This failure happened before any slot reservation or click.
  t.smart_v2_pending_action=null;
  t.next_at=new Date(Date.now()+60000).toISOString();
  t.last_error='AutoSend: ошибка подготовки слота до Send. Повторная проверка через минуту, без отправки.';
  persist();return false;
 }
 if(previous){
  // Never retry a slot already recorded, even if a client forced its due time.
  if(['committed','unknown','checking'].includes(previous)){
   finishUnknown(t,'Запуск уже выполнялся или его результат неизвестен. Повтор Send запрещён.');
  }else rescheduleAfterAttempt(t);
  recordAttempt(t,'skipped','Дублирующий идентификатор запланированного запуска заблокирован.');
  persist();return true;
 }
 if(t.force_remove_requested_at)return false;
 t.active_scheduled_at=scheduledAt;t.active_slot_id=slotId;
 recordSlot(t,slotId,scheduledAt,'checking');
 t.status='checking';t.last_attempt_at=now();t.next_at=null;t.delivery_stage='preflight';persist();
 try {
  const outboundText=smartTaskMessage(t);
  const outboundSentinel=String(outboundText).match(/^AUTO_V2_SENTINEL: ([a-f0-9]{20})$/m)?.[1]||null;
  if(t.smart_v2_pending_action&&!outboundSentinel)throw Error('Missing Smart V2 outbound sentinel');
  const result=await deliverViaPlaywright({...t,message:outboundText},async baseline=>{
   if(t.force_remove_requested_at)throw Error('AutoSend: владелец отменил задачу до нажатия Send.');
   // Durable identity of the EXACT outbound prompt before the click.
   if(t.smart_v2_pending_action)t.smart_v2_pending_sentinel=outboundSentinel;
   t.verification=verificationReceipt(baseline);
   // ID is durable BEFORE click, and the scheduler guards the page click inside a single evaluation.
   // Lost HTTP responses cannot trigger an automatic replay.
   const actionId='autosend:'+crypto.randomUUID();
   t.verification.actionId=actionId;
   recordSlot(t,slotId,scheduledAt,'committed');
   t.status='sending';t.delivery_stage='click-committed';t.last_stage_at=now();persist();
   return actionId;
  });
  if(['CHAT_TAB_MISSING','AMBIGUOUS_CHAT_TABS'].includes(result?.evidence?.code)){
   approvedTabs.update(t.id,false);browserOnline=approvedTabs.size>0;
  }
  if(result.status==='verified'){
   finishVerified(t);
   promoteSmartReceipt(t);
   approvedTabs.update(t.id,true);browserOnline=true;browserLastSeen=now();
  } else if(result.status==='refused'&&result.reason==='guard-refused'&&t.verification){
   // The page-side guard positively confirmed that no click happened. Only
   // this definitive response allows us to retire a reserved operation ID;
   // network errors and ambiguous responses ALWAYS remain in verification.
   const oldActionId=t.verification.actionId;
   t.verification=null;
   t.smart_v2_pending_action=null;
   recordSlot(t,slotId,scheduledAt,'refused');
   t.status='scheduled';
   t.delivery_stage='guard-refused';
   rescheduleAfterAttempt(t);
   t.last_slot_id=slotId;t.last_scheduled_at=scheduledAt;
   t.active_slot_id=null;t.active_scheduled_at=null;
   const busyRetry=deferBusyIntervalRetry(t,confirmedBusyRetryReason(result),Date.now());
   t.last_error=(result.error||'Send отклонён проверкой; безопасно отложен.')+
     (busyRetry?' Следующая проверка через ~1 минуту.':'');
   t.last_action_id=oldActionId;
  } else if(t.verification || t.status==='sending' || result.status==='pending'){
   // The click may have happened. Never retry it: schedule read-only DOM
   // reconciliation, even if an MCP error interrupted the first observation.
   if(t.verification){
    scheduleNextCheck(t,result.error,Date.now(),result.evidence);
   }else{
    finishUnknown(t,'Невозможно восстановить baseline исходной попытки.');
   }
  } else {
   // Confirmed active generation: recheck after ~60 seconds, without
   // changing the configured interval or queueing missed messages.
   // Unknown/unavailable chat state retains its existing conservative cadence.
   recordSlot(t,slotId,scheduledAt,'skipped');
   t.smart_v2_pending_action=null;
   rescheduleAfterAttempt(t);
   t.last_slot_id=slotId;t.last_scheduled_at=scheduledAt;
   t.active_slot_id=null;t.active_scheduled_at=null;
   const fastBusyRetry=deferBusyIntervalRetry(t,confirmedBusyRetryReason(result),Date.now());
   t.last_error=(
    result.reason==='busy'?'Агент занят · ':
    result.reason==='interrupted'?'Соединение прервано · ':
    result.reason==='stalled'?'Возможное зависание · ':'Проверка отложена · '
   )+(result.error||'следующая проверка по расписанию')+
     (fastBusyRetry?' Следующая проверка через ~1 минуту.':'');
  }
  recordAttempt(t,t.status==='verifying'?'verifying':
    result.status==='deferred'?(result.reason==='busy'?'busy':'deferred'):result.status,
    t.last_error,result.evidence);
  persist();
 }catch(e){
  if(t.verification){
   scheduleNextCheck(t,'Проверка прервана',Date.now(),
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
  }else if(t.status==='checking'){
   recordSlot(t,slotId,scheduledAt,'skipped');
   t.smart_v2_pending_action=null;
   rescheduleAfterAttempt(t);
   t.last_slot_id=slotId;t.last_scheduled_at=scheduledAt;
   t.active_slot_id=null;t.active_scheduled_at=null;
   t.last_error='Сбой до нажатия Send; запуск пропущен без повторного клика.';
  }else{
   finishUnknown(t,'Нельзя безопасно определить исход попытки',
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
  }
  persist();
 }
 }finally{
  currentScheduledTaskId=null;
  if(finalizeForcedRemovals(db))persist();
  workerBusy=false;
 }
}

const server=http.createServer(async(req,res)=>{
 const host=req.headers.host;
 if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(host))
  return reply(res,403,{error:'Only local host'});
 if(!authenticated(req))
  return reply(res,403,{error:'Local control token required'});
 if(req.method==='GET' && req.url==='/api/status') return reply(res,200,view());
 if(req.method!=='POST' || req.url!=='/api/tasks')
  return reply(res,404,{error:'Not found'});
 if(!String(req.headers['content-type']||'').startsWith('application/json'))
  return reply(res,415,{error:'JSON only'});
 try {
  let bytes=0;const chunks=[];
  for await(const chunk of req){
   bytes+=chunk.length;
   if(bytes>30000)throw Error('Слишком большой запрос.');
   chunks.push(chunk);
  }
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(body.action==='preview')return reply(res,200,{ok:true,...await previewTask(body.id)});
  return reply(res,200,{ok:true,...operation(body.action,body)});
 } catch(e) {
  return reply(res,400,{error:String(e.message||e).slice(0,500)});
 }
});
server.listen(PORT,'127.0.0.1',()=>console.log('McpGo AutoSend Playwright Extension API on 127.0.0.1:'+PORT));
let schedulerTickRunning=false;
async function schedulerTick(){
 if(schedulerTickRunning)return;
 schedulerTickRunning=true;
 try{
  expireAmbiguous();
  // One read-only confirmation and one independent scheduled task may run
  // during the same tick. Verifying chat A does NOT starve ready chat B.
  await reconcilePending();
  // Exact owner-approved tabs only. No Send, never resumes paused tasks.
  await recoverApprovedTabs();
  await runScheduled();
  if(Date.now()-lastContinuationCheck>=15000){
   lastContinuationCheck=Date.now();
   await monitorContinuations();
  }
  if(finalizeForcedRemovals(db))persist();
 } finally{schedulerTickRunning=false}
}
const timer=setInterval(()=>{
 void schedulerTick().catch(()=>{
   // Do not force an operation retry after an unhandled scheduler error.
   // Durable task/verification receipts are recovered by markUnknownOnBoot.
 });
},CHECK_MS);timer.unref();
const healthTimer=setInterval(()=>{void checkExtensionBackend();},30000);healthTimer.unref();void checkExtensionBackend();
process.on('SIGTERM',()=>{clearInterval(timer);clearInterval(healthTimer);server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref()});
