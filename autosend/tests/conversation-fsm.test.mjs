import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STATES,conversationState,conversationStates,eligibleToSend,nextDue,canObserveTask}
 from '../conversation-fsm.mjs';

const now=Date.parse('2026-11-09T12:00:00Z');
const url=n=>'https://chatgpt.com/c/00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const task=(n,status='scheduled')=>({id:'task-'+n,url:url(n),status,
 enabled:true,interval_seconds:60,next_at:new Date(now-60000).toISOString()});

test('four agents have independently derived durable states',()=>{
 const tasks=[task(1,'unknown'),task(2,'verifying'),task(3),task(4)];
 const status=conversationStates(tasks,now);
 assert.equal(status[url(1)].state,STATES.UNKNOWN);
 assert.equal(status[url(2)].state,STATES.VERIFYING_SEND);
 assert.equal(status[url(3)].state,STATES.READY);
 assert.equal(status[url(4)].state,STATES.READY);
 assert.equal(eligibleToSend(tasks[2],tasks,now),true);
 assert.equal(eligibleToSend(tasks[3],tasks,now),true);
 assert.equal(nextDue(tasks,now).id,'task-3');
 assert.equal(nextDue(tasks,now,'task-3').id,'task-4');
});

test('unconfirmed click blocks ONLY other schedules sharing the same conversation',()=>{
 const unknown=task(1,'unknown');
 const sibling={...task(6),url:unknown.url};
 const separate=task(2);
 const tasks=[unknown,sibling,separate];
 assert.equal(conversationState(tasks,unknown.url).blocked,true);
 assert.equal(eligibleToSend(sibling,tasks,now),false);
 assert.equal(eligibleToSend(separate,tasks,now),true);
 assert.equal(canObserveTask(sibling,tasks),false);
 assert.equal(canObserveTask(separate,tasks),true);
});

test('reloaded tasks.json reconstructs same state without a second state store',()=>{
 const tasks=[
  {...task(1),watchdog:{mode:'recovering'}},
  {...task(2),watchdog:{mode:'busy'}},
  task(3,'verifying'),
  {...task(4,'paused'),enabled:false}
 ];
 const first=conversationStates(tasks,now);
 const afterRestart=conversationStates(JSON.parse(JSON.stringify(tasks)),now);
 assert.deepEqual(first,afterRestart);
 assert.equal(first[url(1)].state,STATES.READY);
 assert.equal(first[url(2)].state,STATES.READY);
 assert.equal(first[url(3)].state,STATES.VERIFYING_SEND);
 assert.equal(first[url(4)].state,STATES.PAUSED);
});

test('legacy watchdog flags have no effect on the new scheduler',()=>{
 const t={...task(1),watchdog:{mode:'recovering'}};
 assert.equal(eligibleToSend(t,[t],now),true);
 assert.equal(nextDue([t],now).id,t.id);
});
test('project slug variants cannot evade the per-conversation send lock',()=>{
 const p='a'.repeat(32),c='00000000-0000-4000-8000-000000000001';
 const bare='https://chatgpt.com/g/g-p-'+p+'/c/'+c;
 const named='https://chatgpt.com/g/g-p-'+p+'-gafus-refactor/c/'+c;
 const unknown={...task(1,'unknown'),url:bare};
 const sibling={...task(2),url:named};
 assert.equal(conversationState([unknown,sibling],named).blocked,true);
 assert.equal(eligibleToSend(sibling,[unknown,sibling],now),false);
});
test('verification finished in chat A cannot unlock an unresolved B state',()=>{
 const a=task(1,'verifying'),b=task(2,'unknown'),c=task(3);
 assert.equal(eligibleToSend(c,[a,b,c],now),true);
 a.status='scheduled';a.next_at=new Date(now-1000).toISOString();
 assert.equal(eligibleToSend(a,[a,b,c],now),true);
 assert.equal(conversationState([a,b,c],b.url).state,STATES.UNKNOWN);
});

test('MCP-04 duplicate scheduled tasks for one conversation fail closed but other chats advance',()=>{
 const p='b'.repeat(32),chat='00000000-0000-4000-8000-000000000005';
 const first={...task(5),url:'https://chatgpt.com/g/g-p-'+p+'/c/'+chat};
 const duplicate={...task(6),url:'https://chatgpt.com/g/g-p-'+p+'-owner-project/c/'+chat};
 const unrelated=task(7);
 const tasks=[first,duplicate,unrelated];
 assert.equal(eligibleToSend(first,tasks,now),false);
 assert.equal(eligibleToSend(duplicate,tasks,now),false);
 assert.equal(canObserveTask(first,tasks),false);
 assert.equal(canObserveTask(duplicate,tasks),false);
 assert.equal(conversationState(tasks,first.url).state,STATES.CONFLICT);
 assert.equal(conversationState(tasks,duplicate.url).blocked,true);
 assert.equal(nextDue(tasks,now)?.id,unrelated.id);
});

test('MCP-04 a paused task with unresolved receipt never allows a second Send',()=>{
 const active=task(8);
 const interrupted={...task(9,'paused'),url:active.url,enabled:false,
   verification:{startedAt:'2026-11-09T11:00:00Z',messageHash:'receipt'}};
 const tasks=[active,interrupted];
 assert.equal(eligibleToSend(active,tasks,now),false);
 assert.equal(canObserveTask(active,tasks),false);
 assert.equal(conversationState(tasks,active.url).blocked,true);
});

test('MCP-04 completed paused historic schedule does not block a new one',()=>{
 const active=task(10);
 const old={...task(11,'paused'),url:active.url,enabled:false,
   verification:null,active_slot_id:null,manual_once:false};
 const tasks=[active,old];
 assert.equal(eligibleToSend(active,tasks,now),true);
 assert.equal(canObserveTask(active,tasks),true);
 assert.equal(conversationState(tasks,active.url).state,STATES.READY);
 assert.equal(nextDue(tasks,now)?.id,active.id);
});
test('MCP-04 duplicated IDs cannot bypass the conversation guard',()=>{
 const a={...task(12),id:'collision'};
 const b={...task(13),id:'collision',url:a.url};
 const unrelated=task(14);
 assert.equal(eligibleToSend(a,[a,b,unrelated],now),false);
 assert.equal(eligibleToSend(b,[a,b,unrelated],now),false);
 assert.equal(nextDue([a,b,unrelated],now)?.id,unrelated.id);
});

test('MCP-04 a scheduled task cannot dispatch or auto-observe its OWN unresolved receipt or slot',()=>{
 const other=task(20);
 for(const stale of [
  {...task(21),verification:{baselineUserCount:1}},
  {...task(22),active_slot_id:'slot-pending'}
 ]){
  const tasks=[stale,other];
  assert.equal(eligibleToSend(stale,tasks,now),false);
  assert.equal(canObserveTask(stale,tasks),false);
  assert.equal(nextDue(tasks,now)?.id,other.id);
  const state=conversationState(tasks,stale.url);
  assert.equal(state.blocked,true);
  assert.equal(state.state,STATES.UNKNOWN);
 }
});

test('MCP-04 an inactive task with its OWN unresolved receipt remains blocked after reload',()=>{
 const pending={...task(23,'paused'),enabled:false,
  verification:{baselineUserCount:1}};
 const state=conversationState(JSON.parse(JSON.stringify([pending])),pending.url);
 assert.equal(state.blocked,true);
 assert.equal(state.state,STATES.UNKNOWN);
});
