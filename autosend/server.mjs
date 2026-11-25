import http from 'node:http';
import crypto from 'node:crypto';
import {deliverViaPlaywright,reconcileViaPlaywright,observeExistingChat} from './delivery.mjs';
import {probeBrowserHealth} from './browser-health.mjs';
import {safeEvidence,explainEvidence} from './chat-state.mjs';
import {verificationReceipt,canReconcile,expired,scheduleNextCheck,finishUnknown,finishVerified,recheckUnknown,restoreAttemptEvidence} from './reconciliation.mjs';
import {readState,writeState,newTask,arm,pause,dueTasks,markUnknownOnBoot,validateInput,rescheduleAfterAttempt,getOrCreateControlToken,setIntervalOffset,hasUnresolvedTask,assertTaskMutable} from './core.mjs';
import {stableSlotId,recordSlot,safeSlotStatus} from './schedule.mjs';
import {trackSmartContinuation} from './smart-continuation.mjs';
import {conversationState,conversationStates,eligibleToSend,nextDue,canObserveTask} from './conversation-fsm.mjs';
import {checkPreview} from './preview-check.mjs';

const PORT=Number(process.env.MCPHUB_AUTOSEND_PORT || 8972);
let backendOnline=false;let backendLastError='';let browserOnline=false;let browserLastError='';let browserLastSeen=null;let workerBusy=false;
const CHECK_MS=Number(process.env.MCPHUB_AUTOSEND_CHECK_MS||10000);
const CONTROL_TOKEN=getOrCreateControlToken();
const db=readState();
markUnknownOnBoot(db);
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
function view(){return {ok:true,tasks:db.tasks,attempts:db.attempts.slice(-100).reverse(),
 historySummary:historySummary(),
 conversations:conversationStates(db.tasks),
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
  browserOnline=result.chatFound===true;
  if(browserOnline)browserLastSeen=now();
  return {...result,checkedAt:now()};
 }finally{workerBusy=false;}
}
function operation(action,body){
 switch(action){
  case 'create':{
   const t=newTask(body);db.tasks.push(t);persist();return {task:t};
  }
  case 'update':{
   const t=find(body.id);assertTaskMutable(t);
   Object.assign(t,validateInput(body));t.schedule_revision=(t.schedule_revision||0)+1;delete t.watchdog;delete t.verification;pause(t);t.manual_once=false;t.safe_retry_count=0;t.last_error='';persist();return {task:t};
  }
  case 'set_interval_offset':{
   const t=find(body.id);
   setIntervalOffset(t,body.interval_offset_seconds);
   persist();return {task:t};
  }
  case 'start':{
   const t=find(body.id);assertTaskMutable(t);
   const other=conversationState(db.tasks.filter(x=>x.id!==t.id),t.url);
   if(other.blocked)throw Error('В этом чате уже есть незавершённая или неизвестная отправка. Проверь её прежде, чем включать новую.');
   delete t.watchdog;arm(t);t.manual_once=false;t.safe_retry_count=0;persist();return {task:t};
  }
  case 'pause':{
   const t=find(body.id);assertTaskMutable(t);
   delete t.watchdog;pause(t);t.manual_once=false;persist();return {task:t};
  }
  case 'remove':{
   const t=find(body.id);assertTaskMutable(t);
   db.tasks=db.tasks.filter(x=>x.id!==body.id);persist();return {removed:body.id};
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
   const other=conversationState(db.tasks.filter(x=>x.id!==t.id),t.url);
   if(other.blocked)throw Error('В этом разговоре уже есть неподтверждённое действие; отправка другого задания блокирована.');
   t.manual_once=!t.enabled;t.status='scheduled';t.next_at=now();t.last_error='';persist();return {queued:true};
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
 const candidates=db.tasks.filter(t=>canObserveTask(t,db.tasks)&&t.schedule_mode==='after_response');
 if(!candidates.length)return false;
 const t=candidates[continuationCursor++%candidates.length];
 workerBusy=true;
 try{
  const probe=await observeExistingChat(t,{eventWaitMs:0});
  if(probe.status!=='ok')return false;
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
  const result=await reconcileViaPlaywright(t,t.verification);
  if(result.status==='verified'){
   const proof=result.evidence;
   finishVerified(t);
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
 }finally{workerBusy=false;}
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
  if(!backendOnline)browserOnline=false;
 }catch(e){backendOnline=false;browserOnline=false;backendLastError='Не удалось проверить локальный backend';}
}
let lastScheduledTaskId=null;
async function runScheduled(){
 if(workerBusy)return false;
 // A pending proof in chat A never blocks independent chat B. Browser tool
 // calls themselves remain serialized by the shared Chrome MCP proxy.
 const t=nextDue(db.tasks,Date.now(),lastScheduledTaskId);
 if(!t)return false;
 // If the dedicated backend is not running, leave the due slot pending.
 const health=await probeBrowserHealth();
 if(!health.connected){
  if(t.last_error!==health.reason){t.last_error=health.reason;persist();}
  return false;
 }
 lastScheduledTaskId=t.id;
 workerBusy=true;
 const scheduledAt=t.next_at||now();
 const slotId=stableSlotId(t,scheduledAt);
 const previous=safeSlotStatus(t,slotId);
 if(previous){
  // Never retry a slot already recorded, even if a client forced its due time.
  if(['committed','unknown','checking'].includes(previous)){
   finishUnknown(t,'Запуск уже выполнялся или его результат неизвестен. Повтор Send запрещён.');
  }else rescheduleAfterAttempt(t);
  recordAttempt(t,'skipped','Дублирующий идентификатор запланированного запуска заблокирован.');
  persist();return true;
 }
 t.active_scheduled_at=scheduledAt;t.active_slot_id=slotId;
 recordSlot(t,slotId,scheduledAt,'checking');
 t.status='checking';t.last_attempt_at=now();t.next_at=null;t.delivery_stage='preflight';persist();
 try {
  const result=await deliverViaPlaywright(t,async baseline=>{
   t.verification=verificationReceipt(baseline);
   // ID is durable BEFORE click, and the scheduler guards the page click inside a single evaluation.
   // Lost HTTP responses cannot trigger an automatic replay.
   const actionId='autosend:'+crypto.randomUUID();
   t.verification.actionId=actionId;
   recordSlot(t,slotId,scheduledAt,'committed');
   t.status='sending';t.delivery_stage='click-committed';t.last_stage_at=now();persist();
   return actionId;
  });
  if(result.status==='verified'){
   finishVerified(t);
  } else if(result.status==='refused'&&result.reason==='guard-refused'&&t.verification){
   // The page-side guard positively confirmed that no click happened. Only
   // this definitive response allows us to retire a reserved operation ID;
   // network errors and ambiguous responses ALWAYS remain in verification.
   const oldActionId=t.verification.actionId;
   t.verification=null;
   recordSlot(t,slotId,scheduledAt,'refused');
   t.status='scheduled';
   t.delivery_stage='guard-refused';
   rescheduleAfterAttempt(t);
   t.last_slot_id=slotId;t.last_scheduled_at=scheduledAt;
   t.active_slot_id=null;t.active_scheduled_at=null;
   t.last_error=result.error||'Send отклонён проверкой; безопасно отложен.';
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
   // Busy or uncertain page: no click occurred. Skip this slot, check next interval.
   recordSlot(t,slotId,scheduledAt,'skipped');
   rescheduleAfterAttempt(t);
   t.last_slot_id=slotId;t.last_scheduled_at=scheduledAt;
   t.active_slot_id=null;t.active_scheduled_at=null;
   t.last_error=(
    result.reason==='busy'?'Агент занят · ':
    result.reason==='interrupted'?'Соединение прервано · ':
    result.reason==='stalled'?'Возможное зависание · ':'Проверка отложена · '
   )+(result.error||'следующая проверка по расписанию');
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
   rescheduleAfterAttempt(t);
   t.last_slot_id=slotId;t.last_scheduled_at=scheduledAt;
   t.active_slot_id=null;t.active_scheduled_at=null;
   t.last_error='Сбой до нажатия Send; запуск пропущен без повторного клика.';
  }else{
   finishUnknown(t,'Нельзя безопасно определить исход попытки',
    safeEvidence({code:'OBSERVATION_FAILED',clickCommitted:true,messageFound:false}));
  }
  persist();
 }finally{workerBusy=false;}
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
  await runScheduled();
  if(Date.now()-lastContinuationCheck>=15000){
   lastContinuationCheck=Date.now();
   await monitorContinuations();
  }
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
