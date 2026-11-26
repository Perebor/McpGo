import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {validateSchedule,nextCalendarSlot,nextAfterRun,recordSlot} from './schedule.mjs';

const root = path.join(os.homedir(), 'Library/Application Support/McpGo/AutoSend');
export const stateFile = process.env.MCPHUB_AUTOSEND_STATE || path.join(root,'tasks.json');
export const profileDir = path.join(root,'chrome-profile');
export const MIN_INTERVAL = 60;
export const MAX_INTERVAL = 604800;
export function normalizeTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 1000) throw Error('Укажи URL существующего разговора ChatGPT.');
  let u;
  try { u=new URL(raw.trim()); }
  catch { throw Error('Некорректная ссылка. Используй https://chatgpt.com/c/<ID>.'); }
  if (u.protocol!=='https:' || u.hostname!=='chatgpt.com' || u.port || u.username || u.password || u.hash)
    throw Error('Поддерживается только ссылка HTTPS на chatgpt.com.');
  if (u.pathname.startsWith('/share/'))
    throw Error('Ссылка /share/ — опубликованная копия. Нужна исходная ссылка /c/ на этот разговор.');
  // Both ordinary and project-scoped ChatGPT conversations are supported.
  // A project uses /g/g-p-<project-slug>/c/<conversation-uuid>.
  const chatPath=/^(?:\/g\/g-p-[a-zA-Z0-9][a-zA-Z0-9-]{2,160})?\/c\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/;
  if(!chatPath.test(u.pathname))
    throw Error('Нужен URL разговора ChatGPT: /c/UUID или /g/g-p-<проект>/c/UUID.');
  // no_universal_links, refresh_account, startup_account_refresh are client hints,
  // not part of the conversation identity. Drop ALL query parameters.
  return 'https://chatgpt.com'+u.pathname.replace(/\/$/,'').toLowerCase();
}
export const DIRECT_WEB_CHAT_DELIVERY_SUPPORTED=true;
export const DIRECT_WEB_CHAT_REASON='Отправка выполняется через отдельную группу официального Playwright Extension, только в уже выбранной вкладке разговора; при занятости попытка откладывается.';

export function validateInput(body){
  if (!body || typeof body !== 'object') throw Error('Недопустимые параметры.');
  const url=normalizeTarget(body.url);
  if(typeof body.message!=='string' || body.message.trim().length<1 || body.message.length>8000)
    throw Error('Текст должен быть от 1 до 8000 символов.');
  const schedule=validateSchedule(body);
  const seconds=Number(body.interval_seconds??60);
  if(!Number.isInteger(seconds) || seconds<MIN_INTERVAL || seconds>MAX_INTERVAL) throw Error('Интервал должен быть от 1 минуты до 7 дней.');
  const phase=validateIntervalOffset(body.interval_offset_seconds,seconds,schedule.schedule_mode);
  if(body.guided_first_run!=null&&typeof body.guided_first_run!=='boolean')
    throw Error('Неверный тип упрощённого запуска.');
  const guided=body.guided_first_run===true;
  if(body.project_label!=null&&typeof body.project_label!=='string')
    throw Error('Название проекта должно быть текстом.');
  const projectLabel=String(body.project_label||'').trim();
  if(projectLabel.length>64||(guided&&!projectLabel))
    throw Error('Укажи название проекта до 64 символов.');
  return {url,message:body.message,interval_seconds:seconds,...schedule,
    interval_offset_seconds:phase,project_label:projectLabel||null,guided_first_run:guided};
}
// Optional phase in seconds on the UTC interval grid; null preserves legacy cadence.
export function validateIntervalOffset(value,interval,mode='interval'){
 if(value==null)return null;
 if(mode!=='interval'||!Number.isInteger(interval)||interval<MIN_INTERVAL||interval>MAX_INTERVAL||
    !Number.isInteger(value)||value<0||value>=interval)
  throw Error('Смещение: целое число секунд от 0 до интервала (не включительно).');
 return value;
}
// Do not erase an unresolved receipt through an unrelated mutation.
export function hasUnresolvedTask(task){
 return ['unknown','checking','sending','verifying'].includes(task.status)||
  !!task.verification||!!task.active_slot_id;
}
export function assertTaskMutable(task){
 if(hasUnresolvedTask(task))throw Error('Незавершённая или неизвестная доставка. Сначала завершите проверку исходной попытки; повтор Send запрещён.');
}
export function setIntervalOffset(task,value){
 if(task.enabled||task.status!=='paused'||(task.schedule_mode||'interval')!=='interval'||
    task.manual_once||task.verification||task.active_slot_id)
  throw Error('Смещение можно изменить только у выключенного интервального задания без незавершённой попытки.');
 task.interval_offset_seconds=validateIntervalOffset(value,task.interval_seconds,task.schedule_mode||'interval');
 return task.interval_offset_seconds;
}
export function newTask(data, now=Date.now()) {
  const d=validateInput(data);
  return {id:crypto.randomUUID(),...d,enabled:false,next_at:null,status:'paused',last_error:'',
    schedule_revision:1,slot_ledger:[],continuations_sent:0,smart_seen_busy:false,
    last_attempt_at:null,last_success_at:null,delivery_count:0,created_at:new Date(now).toISOString()};
}
export function sanitize(t){
  return {...t,message:t.message}; // Owner-only native endpoint: text is needed for editing/review.
}
export function ensurePrivateDir(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.chmodSync(dir,0o700);
}
// AES-256-GCM protects saved message content from accidental JSON disclosure.
// Key and state are both private to the OS user; this is not a defence against
// malware with full access to the user's account. Failing decryption is fatal:
// never silently create/replay scheduled messages after losing the key.
function messageKey(file,create){
  const keyFile=path.join(path.dirname(file),'message-key');
  if(!fs.existsSync(keyFile)&&create){
    let fd;
    try{
      fd=fs.openSync(keyFile,'wx',0o600);
      fs.writeFileSync(fd,crypto.randomBytes(32));fs.fsyncSync(fd);
      fs.closeSync(fd);fd=undefined;
      if(process.platform!=='win32'){
        const dirFd=fs.openSync(path.dirname(keyFile),'r');
        try{fs.fsyncSync(dirFd);}finally{fs.closeSync(dirFd);}
      }
    }catch(e){if(e.code!=='EEXIST')throw e;}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  const stat=fs.lstatSync(keyFile);
  if(!stat.isFile()||stat.isSymbolicLink()||
     (process.platform!=='win32'&&(stat.mode&0o077)!==0)||
     (typeof process.getuid==='function'&&stat.uid!==process.getuid()))
    throw Error('Unsafe AutoSend message encryption key permissions');
  const key=fs.readFileSync(keyFile);
  if(key.length!==32)throw Error('Invalid AutoSend message encryption key');
  return key;
}
function seal(message,id,key){
 const iv=crypto.randomBytes(12);
 const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 cipher.setAAD(Buffer.from(id,'utf8'));
 const data=Buffer.concat([cipher.update(message,'utf8'),cipher.final()]);
 return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),
  ciphertext:data.toString('base64')};
}
function unseal(entry,id,key){
 if(entry?.v!==1 || typeof entry.iv!=='string'||typeof entry.tag!=='string'||typeof entry.ciphertext!=='string')
  throw Error('Invalid encrypted AutoSend record');
 const dec=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(entry.iv,'base64'));
 dec.setAAD(Buffer.from(id,'utf8'));dec.setAuthTag(Buffer.from(entry.tag,'base64'));
 return Buffer.concat([dec.update(Buffer.from(entry.ciphertext,'base64')),dec.final()]).toString('utf8');
}
export function readState(file=stateFile){
  ensurePrivateDir(path.dirname(file));
  if(!fs.existsSync(file)) return {version:1,tasks:[],attempts:[]};
  if(fs.lstatSync(file).isSymbolicLink()) throw Error('Refusing symlink task store');
  const obj=JSON.parse(fs.readFileSync(file,'utf8'));
  if(obj.version!==1 || !Array.isArray(obj.tasks) || !Array.isArray(obj.attempts)) throw Error('Unexpected task store format');
  if(obj.tasks.some(t=>t.sealed_message)){
    const key=messageKey(file,false);
    for(const t of obj.tasks){
      if(t.sealed_message){
        if(Object.hasOwn(t,'message'))throw Error('Ambiguous encrypted AutoSend message');
        t.message=unseal(t.sealed_message,t.id,key);
        delete t.sealed_message;
      }
    }
  }
  return obj;
}
export function writeState(state,file=stateFile){
  const dir=path.dirname(file);ensurePrivateDir(dir);
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink()) throw Error('Refusing symlink task store');
  const tmp=path.join(dir,'.tasks-'+crypto.randomUUID()+'.tmp');
  let fd;
  try {
    fd=fs.openSync(tmp,'wx',0o600);
    const tasks=state.tasks.map(t=>({...t}));
    if(tasks.some(t=>typeof t.message==='string')){
      const key=messageKey(file,true);
      for(const t of tasks)if(typeof t.message==='string'){
        t.sealed_message=seal(t.message,t.id,key);
        delete t.message;
      }
    }
    fs.writeFileSync(fd,JSON.stringify({...state,tasks},null,2)+'\n');
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,file);
    // Persist the atomic rename as well as file contents before Send.
    // Windows does not permit opening directories as file descriptors.
    if(process.platform!=='win32'){
      const parent=fs.openSync(dir,'r');
      try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    }
  } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}
}
export function getOrCreateControlToken(file=path.join(path.dirname(stateFile),'control-token')){
  ensurePrivateDir(path.dirname(file));
  if(!fs.existsSync(file)){
    try{fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}
    catch(e){if(e.code!=='EEXIST')throw e;}
  }
  const info=fs.lstatSync(file);
  if(!info.isFile() || info.isSymbolicLink() ||
     (process.platform!=='win32'&&(info.mode&0o077)!==0) ||
     (typeof process.getuid==='function'&&info.uid!==process.getuid()))
    throw Error('Unsafe local AutoSend control-token permissions');
  const token=fs.readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid AutoSend control token');
  return token;
}
export function arm(task,now=Date.now()) {
  // Enabling an interval schedule arms the first attempt immediately.
  // Subsequent attempts still use the configured cadence and safety checks.
  const next=(task.schedule_mode||'interval')==='interval'
    ?new Date(now).toISOString():nextCalendarSlot(task,now);
  if(next===null && task.schedule_mode!=='after_response')
    throw Error('В расписании нет будущих запусков. Проверь дату и время.');
  task.enabled=true;task.status='scheduled';task.last_error='';task.next_at=next;
  task.continuations_sent=0;task.smart_seen_busy=false;task.smart_ready_since=null;
}
export function rescheduleAfterAttempt(task,now=Date.now()){
  // A manual send-once must NEVER transform into an enabled recurring task
  // when the first attempt is deferred before clicking Send.
  const manualOnly=task.manual_once===true&&!task.enabled;
  const next=nextAfterRun(task,now);
  if(next){task.status='scheduled';task.next_at=next;if(!manualOnly)task.enabled=true;}
  else if(task.schedule_mode==='after_response'&&!manualOnly){
    task.status='scheduled';task.next_at=null;
    // A committed work report has not been consumed by a confirmed pre-click
    // refusal. Revalidate its exact fingerprint after a bounded delay.
    // Never rearm when a click receipt exists or on a manual first-run.
    if(!task.verification&&!task.manual_once&&task.smart_result_gate===true&&
       task.smart_v2===true&&task.smart_v2_last_action&&
       /^[a-f0-9]{64}$/.test(String(task.smart_work_ready_marker||''))&&
       ['CONTINUE_DEVELOPMENT','FIX_DEFECT'].includes(task.smart_work_expected_action))
      task.next_at=new Date(now+60000).toISOString();
    // A confirmed pre-click deferral must not strand the owner's first-run
    // request. Never clear it while there is an unresolved click receipt.
    if(!task.verification)task.manual_once=false;
  }else{pause(task);task.manual_once=false;}
}
export function pause(task){task.enabled=false;task.next_at=null;task.status='paused'}
export function markUnknownOnBoot(state){
  for(const t of state.tasks){
    // Migrate away the legacy auto-reload/watchdog state. Never revive it:
    // the new scheduler only observes its dedicated extension tab group.
    delete t.watchdog;
    delete t.continuationMarker;
    // A response observed before a process restart is not proof of a fresh
    // response afterwards. Do not auto-continue stale busy/ready markers.
    if(t.schedule_mode==='after_response'){
      t.smart_seen_busy=false;t.smart_ready_since=null;t.smart_last_marker=null;
      // Event-ready report was durably committed before shutdown: preserve
      // the due slot, but runScheduled still revalidates fingerprint and
      // safety before any Send. Idle/no-report does not auto-arm.
      const readyEvent=t.smart_result_gate===true&&!!t.smart_work_ready_marker&&
       !!t.smart_work_expected_action&&t.status==='scheduled'&&!!t.next_at;
      if(t.status==='scheduled'&&!readyEvent)t.next_at=null;
    }
    if(t.manual_once && !t.enabled && t.status==='scheduled'){
      pause(t);t.manual_once=false;
      t.last_error='Однократная отправка отменена при перезапуске. Она не будет запущена без нового подтверждения.';
    }
    // A receipt contradicting the nominal inactive/pre-click state is not
    // permission to discard it. Quarantine the task for owner reconciliation.
    if((t.status==='checking'&&t.verification)||
       (!['checking','sending','verifying','unknown'].includes(t.status)&&
        (t.verification||t.active_slot_id))){
      t.enabled=false;t.status='unknown';t.next_at=null;t.manual_once=false;
      t.last_error='Обнаружено незавершённое подтверждение доставки. Повтор Send запрещён.';
      continue;
    }
    // An explicit manual kick on an ENABLED result-driven task is not an
    // automatically replayable event. If it was only queued (no click/receipt)
    // before restart, retire the queue flag so the owner can restart it.
    if(t.manual_once&&t.enabled&&t.status==='scheduled'&&
       t.schedule_mode==='after_response'&&!t.verification&&!t.active_slot_id){
      t.manual_once=false;t.next_at=null;
      t.last_error='Ручной запуск отменён перезапуском до Send. Проверь чат и запусти заново при необходимости.';
    }
    if(t.status==='checking'){
      // No click was committed: re-arm safely after one full interval.
      if(t.active_slot_id){recordSlot(t,t.active_slot_id,t.active_scheduled_at||t.last_attempt_at,'skipped');}
      rescheduleAfterAttempt(t);
      t.active_slot_id=null;t.active_scheduled_at=null;
      t.last_error='Проверка прервана перезапуском до Send; пропущенный запуск не повторяется.';
    }
    if(t.status==='sending' && Number.isInteger(t.verification?.baselineUserCount)){
      // A persisted click receipt survives process restart; reconciliation is
      // read-only and cannot dispatch the message a second time.
      t.status='verifying';t.next_at=null;t.delivery_stage='verifying';
      t.verification.nextCheckAt=new Date().toISOString();
      t.last_error='Восстанавливаем проверку ранее нажатой отправки без повторного Send.';
    } else if(t.status==='sending' || (t.status==='verifying' && !t.verification)){
      t.enabled=false;t.status='unknown';t.next_at=null;t.manual_once=false;
      t.last_error='Неизвестно, была ли отправка завершена до перезапуска. Проверь чат вручную; повтор запрещён.';
    }
    if(t.status==='verifying' && t.verification){
      t.next_at=null;
      t.verification.nextCheckAt=new Date().toISOString();
    }
    if(t.url?.startsWith('codex://') || (t.enabled && !t.url?.startsWith('https://chatgpt.com/c/') && !t.url?.startsWith('https://chatgpt.com/g/g-p-'))){
      t.enabled=false;t.status='blocked';t.next_at=null;t.manual_once=false;
      t.last_error='Устаревший адрес Codex. Для AutoSend необходим URL разговора /c/.';
    }
  }
}

export function dueTasks(state,now=Date.now()) {
  return state.tasks.filter(t=>t.enabled && t.status==='scheduled' && t.next_at && Date.parse(t.next_at)<=now);
}
