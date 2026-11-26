import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSchedule,nextCalendarSlot,nextAfterRun,stableSlotId,recordSlot,safeSlotStatus,localSlotDay} from '../schedule.mjs';
import {trackSmartContinuation} from '../smart-continuation.mjs';
import {newTask,arm,rescheduleAfterAttempt,markUnknownOnBoot,setIntervalOffset} from '../core.mjs';
import {finishVerified} from '../reconciliation.mjs';
const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const opts=(mode,extras={})=>({url,message:'Продолжи',schedule_mode:mode,interval_seconds:1800,...extras});

test('one-time schedule is future-only and pauses permanently after verified send',()=>{
 const at='2026-11-15T14:00:00.000Z';
 const t=newTask(opts('once',{run_at:at}));
 arm(t,Date.parse('2026-11-14T03:00:00Z'));
 assert.equal(t.next_at,at);
 t.active_slot_id=stableSlotId(t,at);t.active_scheduled_at=at;
 finishVerified(t,Date.parse(at)+1000);
 assert.equal(t.enabled,false);assert.equal(t.status,'paused');assert.equal(t.next_at,null);
 assert.equal(safeSlotStatus(t,t.last_slot_id),'verified');
 assert.throws(()=>arm(t,Date.parse(at)+2000),/нет будущих/);
});
test('daily and weekly recurrence preserve local time, date and timezone',()=>{
 const daily=validateSchedule({schedule_mode:'daily',time_zone:'Europe/Moscow',local_time:'10:00'});
 const t={...daily,interval_seconds:3600};
 assert.equal(nextCalendarSlot(t,Date.parse('2026-11-14T04:00:00Z')),'2026-11-14T07:00:00.000Z');
 const weekly={...validateSchedule({schedule_mode:'weekly',time_zone:'Europe/Moscow',local_time:'10:00',weekdays:[1,3]})};
 assert.equal(nextCalendarSlot(weekly,Date.parse('2026-11-14T04:00:00Z')),'2026-11-16T07:00:00.000Z');
});
test('DST gap skips nonexistent wall time, fall overlap never repeats same local day',()=>{
 const t={...validateSchedule({schedule_mode:'daily',time_zone:'Europe/Berlin',local_time:'02:30'})};
 assert.equal(nextCalendarSlot(t,Date.parse('2026-03-29T00:00:00Z')),'2026-03-30T00:30:00.000Z');
 const first=nextCalendarSlot(t,Date.parse('2026-10-25T00:00:00Z'));
 assert.equal(first,'2026-10-25T00:30:00.000Z');
 const afterFirst={...t,active_scheduled_at:first};
 assert.equal(nextAfterRun(afterFirst,Date.parse(first)+1000),'2026-10-26T01:30:00.000Z');
 assert.equal(localSlotDay(t,first),'2026-10-25');
});
test('end date caps recurring calendar slots',()=>{
 const t=validateSchedule({schedule_mode:'daily',time_zone:'UTC',local_time:'10:00',end_at:'2026-11-14T09:00:00Z'});
 assert.equal(nextCalendarSlot(t,Date.parse('2026-11-13T12:00:00Z')),null);
});
test('schedule validation rejects invalid days, zones, delays and times',()=>{
 for(const rule of [
  {schedule_mode:'weekly',time_zone:'UTC',local_time:'10:00',weekdays:[]},
  {schedule_mode:'weekly',time_zone:'UTC',local_time:'10:00',weekdays:[1,1]},
  {schedule_mode:'daily',time_zone:'Mars/Olympus',local_time:'10:00'},
  {schedule_mode:'daily',time_zone:'UTC',local_time:'25:00'},
  {schedule_mode:'after_response',delay_seconds:0,max_continuations:20},
  {schedule_mode:'after_response',delay_seconds:30,max_continuations:500},
 ])assert.throws(()=>validateSchedule(rule));
});
test('smart continuation never sends on idle alone, requires seen busy and two stable clean samples',()=>{
 const t=newTask(opts('after_response',{delay_seconds:30,max_continuations:2}));
 arm(t,1000);assert.equal(t.next_at,null);
 const idle={urlValid:true,stop:false,busyText:false,connectionInterrupted:false,
  pageReady:'complete',editorCount:1,editorText:'',userCount:4,lastUserHash:'hash',assistantRevision:3};
 assert.equal(trackSmartContinuation(t,idle,1000),false);
 assert.equal(t.next_at,null);
 assert.equal(trackSmartContinuation(t,{...idle,stop:true},2000),true);
 assert.equal(trackSmartContinuation(t,idle,5000),true);
 assert.equal(trackSmartContinuation(t,idle,34999),false);
 assert.equal(trackSmartContinuation(t,idle,35000),true);
 assert.equal(t.next_at,new Date(35000).toISOString());
 assert.equal(trackSmartContinuation(t,idle,36000),false);
 t.active_slot_id=stableSlotId(t,t.next_at);t.active_scheduled_at=t.next_at;
 finishVerified(t,37000);
 assert.equal(t.status,'scheduled');assert.equal(t.next_at,null);
 assert.equal(t.continuations_sent,1);
 trackSmartContinuation(t,{...idle,stop:true},38000);
 trackSmartContinuation(t,{...idle,assistantRevision:4},39000);
 trackSmartContinuation(t,{...idle,assistantRevision:4},70000);
 t.active_slot_id=stableSlotId(t,t.next_at);t.active_scheduled_at=t.next_at;
 finishVerified(t,71000);
 assert.equal(t.status,'paused');assert.equal(t.enabled,false);
 assert.equal(t.continuations_sent,2);
});
test('persistent dedupe slot ID survives reload and commits cannot be re-reserved',()=>{
 const t=newTask(opts('interval'));
 const at='2026-11-14T01:00:00.000Z',id=stableSlotId(t,at);
 recordSlot(t,id,at,'checking');recordSlot(t,id,at,'committed');
 const reloaded=JSON.parse(JSON.stringify(t));
 assert.equal(stableSlotId(reloaded,at),id);
 assert.equal(safeSlotStatus(reloaded,id),'committed');
 assert.equal(reloaded.slot_ledger.length,1);
});

test('deferred manual send-once never turns into recurring enabled schedule',()=>{
 const t=newTask(opts('interval'));
 t.manual_once=true;t.enabled=false;t.status='scheduled';t.next_at='2026-11-14T10:00:00.000Z';
 rescheduleAfterAttempt(t,Date.parse('2026-11-14T10:00:00Z'));
 assert.equal(t.enabled,false);assert.equal(t.manual_once,true);
 const single=newTask(opts('after_response',{max_continuations:5}));
 single.manual_once=true;single.enabled=false;single.status='scheduled';
 rescheduleAfterAttempt(single);
 assert.equal(single.status,'paused');assert.equal(single.manual_once,false);
});
test('reboot does not auto-continue a stale smart response',()=>{
 const t=newTask(opts('after_response',{max_continuations:3}));
 arm(t);
 t.smart_seen_busy=true;t.smart_ready_since=new Date().toISOString();
 t.next_at=new Date().toISOString();
 markUnknownOnBoot({tasks:[t]});
 assert.equal(t.next_at,null);assert.equal(t.smart_seen_busy,false);
});


test('optional phase keeps interval spacing after the immediate first enabled attempt',()=>{
 const now=Date.parse('2026-11-25T15:00:00Z');
 const a=newTask(opts('interval',{interval_seconds:300,interval_offset_seconds:0}));
 const b=newTask(opts('interval',{interval_seconds:300,interval_offset_seconds:180}));
 assert.equal(a.enabled,false);assert.equal(b.enabled,false);
 arm(a,now);arm(b,now);
 // Owner Start always queues the initial attempt immediately, regardless of phase.
 assert.equal(a.next_at,'2026-11-25T15:00:00.000Z');
 assert.equal(b.next_at,'2026-11-25T15:00:00.000Z');
 a.active_scheduled_at=a.next_at;b.active_scheduled_at=b.next_at;
 assert.equal(nextAfterRun(a,now+1000),'2026-11-25T15:05:00.000Z');
 assert.equal(nextAfterRun(b,now+1000),'2026-11-25T15:08:00.000Z');
 a.active_scheduled_at='2026-11-25T15:05:00.000Z';
 b.active_scheduled_at='2026-11-25T15:08:00.000Z';
 assert.equal(nextAfterRun(a,Date.parse('2026-11-25T15:05:01Z')),'2026-11-25T15:10:00.000Z');
 assert.equal(nextAfterRun(b,Date.parse('2026-11-25T15:08:01Z')),'2026-11-25T15:13:00.000Z');
 const legacy=newTask(opts('interval',{interval_seconds:300}));
 arm(legacy,now+1000);assert.equal(legacy.next_at,'2026-11-25T15:00:01.000Z');
 for(const offset of [-1,300,0.5,'180',true])
  assert.throws(()=>newTask(opts('interval',{interval_seconds:300,interval_offset_seconds:offset})));
});


test('phase editing never rearms or discards unresolved delivery evidence',()=>{
 const t=newTask(opts('interval',{interval_seconds:300}));
 setIntervalOffset(t,180);
 assert.equal(t.interval_offset_seconds,180);assert.equal(t.next_at,null);assert.equal(t.enabled,false);
 setIntervalOffset(t,null);assert.equal(t.interval_offset_seconds,null);
 const receipt={baselineUserCount:3};t.status='unknown';t.verification=receipt;
 assert.throws(()=>setIntervalOffset(t,0));assert.equal(t.verification,receipt);assert.equal(t.status,'unknown');
 t.status='paused';assert.throws(()=>setIntervalOffset(t,0));
 delete t.verification;arm(t,1000);assert.throws(()=>setIntervalOffset(t,0));
 const daily=newTask(opts('daily',{time_zone:'UTC',local_time:'10:00'}));assert.throws(()=>setIntervalOffset(daily,0));
});

test('a completed phased slot does not lose the next grid position to small verification latency',()=>{
 const a=newTask(opts('interval',{interval_seconds:300,interval_offset_seconds:0}));
 const b=newTask(opts('interval',{interval_seconds:300,interval_offset_seconds:180}));
 a.active_scheduled_at='2026-11-25T15:05:00.000Z';
 b.active_scheduled_at='2026-11-25T15:08:00.000Z';
 assert.equal(nextAfterRun(a,Date.parse('2026-11-25T15:05:04Z')),'2026-11-25T15:10:00.000Z');
 assert.equal(nextAfterRun(b,Date.parse('2026-11-25T15:08:04Z')),'2026-11-25T15:13:00.000Z');
 assert.equal(nextAfterRun(a,Date.parse('2026-11-25T15:21:03Z')),'2026-11-25T15:25:00.000Z');
});
