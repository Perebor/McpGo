import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserActionQueue} from '../browser-queue.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
test('priority cannot starve a manual request; oldest waiter uses actual earliest createdAt',async()=>{
 let now=0;const q=new BrowserActionQueue({now:()=>now,maxPriorityBurst:2,waitMs:5000});
 const first=await q.acquire();const observed=[];
 const manual=q.acquire().then(release=>{observed.push('manual');release();});
 now+=25;
 const highs=Array.from({length:6},(_,i)=>q.acquire({priority:true}).then(release=>{
  observed.push('high'+i);release();}));
 now+=75;
 assert.equal(q.status().oldestWaitMs,100);
 first();await Promise.all([manual,...highs]);
 assert.ok(observed.indexOf('manual')<=2,JSON.stringify(observed));
 assert.equal(q.status().waiting,0);
});
test('queued disconnect prevents dispatch and next client proceeds',async()=>{
 const q=new BrowserActionQueue();const release=await q.acquire();
 const controller=new AbortController();let invoked=false;
 const cancelled=q.acquire({signal:controller.signal}).then(()=>{invoked=true;},e=>e.message);
 controller.abort();assert.equal(await cancelled,'BROWSER_QUEUE_CLIENT_GONE');
 const subsequent=q.acquire().then(done=>{done();return true;});
 release();assert.equal(await subsequent,true);assert.equal(invoked,false);
});
test('mutating action with unknown outcome freezes dispatch and rejects outstanding waiters',async()=>{
 const q=new BrowserActionQueue();const release=await q.acquire();
 const pending=q.acquire().then(()=>false,e=>e.message);
 q.quarantine();release();
 assert.equal(await pending,'BROWSER_ACTION_OUTCOME_UNKNOWN');
 await assert.rejects(q.acquire(),/OUTCOME_UNKNOWN/);
 assert.equal(q.status().quarantined,true);
});
test('queue waiting budget expires without dispatch',async()=>{
 const q=new BrowserActionQueue({waitMs:100});const release=await q.acquire();
 await assert.rejects(q.acquire({budgetMs:2}),/WAIT_TIMEOUT/);
 assert.equal(q.status().waiting,0);release();
});
