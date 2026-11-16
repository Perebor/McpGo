import {createHash} from 'node:crypto';

const DAY_MS=86400000;
const MODES=new Set(['interval','once','daily','weekly','after_response']);
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const HHMM=/^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateSchedule(input){
 const mode=input.schedule_mode??'interval';
 if(!MODES.has(mode))throw Error('Недопустимый режим расписания.');
 const out={schedule_mode:mode};
 if(mode==='interval')return out;
 if(mode==='after_response'){
  const delay=Number(input.delay_seconds??30);
  const limit=Number(input.max_continuations??20);
  if(!Number.isInteger(delay)||delay<10||delay>3600)throw Error('Задержка продолжения: 10–3600 секунд.');
  if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Максимум продолжений: 1–200.');
  return {...out,delay_seconds:delay,max_continuations:limit};
 }
 if(mode==='once'){
  const iso=input.run_at;
  if(typeof iso!=='string'||!ISO.test(iso)||!Number.isFinite(Date.parse(iso)))
   throw Error('Укажи дату и время однократной отправки в UTC ISO 8601.');
  return {...out,run_at:new Date(iso).toISOString()};
 }
 const zone=String(input.time_zone||'');
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(new Date());}
 catch{throw Error('Некорректный часовой пояс.');}
 if(!zone||zone.length>128)throw Error('Укажи часовой пояс.');
 const time=String(input.local_time||'');
 if(!HHMM.test(time))throw Error('Время должно быть в формате ЧЧ:ММ.');
 let weekdays=[];
 if(mode==='weekly'){
  if(!Array.isArray(input.weekdays)||input.weekdays.length===0||input.weekdays.length>7||
   !input.weekdays.every(x=>Number.isInteger(x)&&x>=0&&x<=6)||
   new Set(input.weekdays).size!==input.weekdays.length)
   throw Error('Выбери дни недели от 0 (воскресенье) до 6 (суббота).');
  weekdays=[...input.weekdays].sort((a,b)=>a-b);
 }
 let end_at=null;
 if(input.end_at!=null&&input.end_at!==''){
  if(typeof input.end_at!=='string'||!ISO.test(input.end_at)||!Number.isFinite(Date.parse(input.end_at)))
   throw Error('Неверная дата окончания расписания.');
  end_at=new Date(input.end_at).toISOString();
 }
 return {...out,time_zone:zone,local_time:time,weekdays,end_at};
}
function zoneParts(ms,fmt){
 const map=Object.fromEntries(fmt.formatToParts(new Date(ms)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
 return map;
}
function timeFormatter(zone){return new Intl.DateTimeFormat('en-US',{
 timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',
 second:'2-digit',hourCycle:'h23'});
}
function localISO(p){return `${String(p.year).padStart(4,'0')}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
function localDateAt(now,fmt){
 const p=zoneParts(now,fmt);
 return new Date(Date.UTC(p.year,p.month-1,p.day));
}
function matchingInstants(y,m,d,h,min,fmt){
 const utc=Date.UTC(y,m-1,d,h,min);
 const seen=new Set();const found=[];
 // Probe offsets across a DST transition; UTC candidates are checked against
 // the requested local wall clock. Nonexistent DST minutes are skipped.
 for(const sample of [utc-36e5*24,utc-36e5*12,utc,utc+36e5*12,utc+36e5*24]){
  const z=zoneParts(sample,fmt);
  const offset=Date.UTC(z.year,z.month-1,z.day,z.hour,z.minute,z.second)-Math.floor(sample/1000)*1000;
  const result=utc-offset;
  if(seen.has(result))continue;
  seen.add(result);
  const actual=zoneParts(result,fmt);
  if(actual.year===y&&actual.month===m&&actual.day===d&&actual.hour===h&&actual.minute===min)
   found.push(result);
 }
 return found.sort((a,b)=>a-b);
}
/** Compute next allowed slot strictly after `after`. Never replay the same local
 * calendar day after a successful daily/weekly delivery (DST backward fold).
 */
export function nextCalendarSlot(task,after=Date.now(),excludeDay=null){
 const mode=task.schedule_mode||'interval';
 if(mode==='interval')return new Date(after+task.interval_seconds*1000).toISOString();
 if(mode==='once'){
  const at=Date.parse(task.run_at);
  return Number.isFinite(at)&&at>after?new Date(at).toISOString():null;
 }
 if(mode==='after_response')return null;
 const fmt=timeFormatter(task.time_zone);
 const base=localDateAt(after,fmt);
 const [h,m]=task.local_time.split(':').map(Number);
 const finish=task.end_at?Date.parse(task.end_at):Infinity;
 for(let i=0;i<=8;i++){
  const day=new Date(base.getTime()+i*DAY_MS);
  const y=day.getUTCFullYear(),mo=day.getUTCMonth()+1,d=day.getUTCDate();
  if(mode==='weekly'&&!task.weekdays.includes(day.getUTCDay()))continue;
  if(excludeDay===`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`)continue;
  for(const t of matchingInstants(y,mo,d,h,m,fmt))if(t>after&&t<=finish)return new Date(t).toISOString();
 }
 return null;
}
export function localSlotDay(task,iso){
 if(!iso||!['daily','weekly'].includes(task.schedule_mode))return null;
 return localISO(zoneParts(Date.parse(iso),timeFormatter(task.time_zone)));
}
export function nextAfterRun(task,after=Date.now()){
 const mode=task.schedule_mode||'interval';
 if(mode==='once'||mode==='after_response')return null;
 return nextCalendarSlot(task,after,mode==='interval'?null:localSlotDay(task,task.active_scheduled_at));
}
export function stableSlotId(task,scheduledAt){
 return createHash('sha256').update(`${task.id}|${task.schedule_revision||0}|${scheduledAt}`).digest('hex').slice(0,32);
}
export function recordSlot(task,id,scheduledAt,state,now=Date.now()){
 task.slot_ledger??=[];
 const existing=task.slot_ledger.find(x=>x.id===id);
 if(existing){existing.state=state;existing.updated_at=new Date(now).toISOString();return existing;}
 const entry={id,scheduled_at:scheduledAt,state,updated_at:new Date(now).toISOString()};
 task.slot_ledger.push(entry);
 // Keep committed or unresolved slots forever in this task, prune only safe
 // historic settled entries; never prune unresolved slots to enable retries.
 if(task.slot_ledger.length>512){
  const settled=task.slot_ledger.findIndex(x=>['verified','skipped','refused'].includes(x.state));
  if(settled>=0)task.slot_ledger.splice(settled,1);
 }
 return entry;
}
export function safeSlotStatus(task,id){return task.slot_ledger?.find(x=>x.id===id)?.state||null;}
