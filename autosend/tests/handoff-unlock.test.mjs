import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.mjs';
import {planChatHandoff} from '../chat-handoff.mjs';

const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8')
 .match(/function operation\(action,body\)\{[\s\S]*?\r?\n\}\r?\n(?=function expireAmbiguous\()/);
assert.ok(source,'AutoSend native route handler not found');
const oldUrl='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000001';
const newUrl='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000002';
const checkpoint={task_id:'MCP-11',branch:'work/mcp11-checkpoint',commit:'a'.repeat(40),
 evidence_sha256:'b'.repeat(64),receipt_id:'receipt-123',last_ack_id:'ack-456',
 summary:'Owner-approved evidence to continue after migration'};
function fixture({browser=true}={}){
 const old=core.newTask({url:oldUrl,message:'continue',interval_seconds:900});
 old.id='old-task';
 const moved=planChatHandoff({version:1,tasks:[old],attempts:[]},
  {source_id:'old-task',target_url:newUrl,owner_confirmed_target:newUrl,
   idempotency_key:'e99f2c39-2222-4222-8222-222222222222',checkpoint},
  {newId:'new-task'});
 const db=moved.state,target=db.tasks.find(x=>x.id==='new-task');
 let writes=0;
 const op=vm.runInNewContext(source[0]+'\noperation',{
  db,find:id=>db.tasks.find(x=>x.id===id),persist:()=>writes++,
  approvedTabs:{has:id=>browser&&id==='new-task',update:()=>{},size:0},
  workerBusy:false,hasUnresolvedTask:core.hasUnresolvedTask,
  now:()=>new Date(0).toISOString()
 });
 const req={action:'unlock_handoff',id:target.id,
  owner_confirmed_target:target.url,checkpoint_sha256:moved.receipt.checkpoint_sha256,
  owner_confirmed_hub:true,owner_confirmed_browser:true};
 return {db,target,op,req,getWrites:()=>writes};
}
test('verified owner+browser approval unlocks only the successor and still does not start a Send',()=>{
 const f=fixture();
 assert.equal(f.target.handoff_requires_owner_reconfigure,true);
 assert.equal(f.op('unlock_handoff',f.req).unlocked,true);
 assert.equal(f.target.handoff_requires_owner_reconfigure,false);
 assert.equal(f.target.status,'paused');
 assert.equal(f.target.enabled,false);
 assert.equal(f.target.next_at,null);
 assert.equal(f.getWrites(),1);
 assert.equal(f.db.tasks[0].handoff_archived_at!=null,true);
 assert.equal(f.op('unlock_handoff',f.req).alreadyUnlocked,true);
 assert.equal(f.getWrites(),1);
});
test('wrong checkpoint or no browser approval cannot unlock a paused handoff',()=>{
 for(const bad of [
  f=>({...f.req,checkpoint_sha256:'f'.repeat(64)}),
  f=>({...f.req,owner_confirmed_target:oldUrl}),
  f=>({...f.req,owner_confirmed_hub:false}),
  f=>({...f.req,owner_confirmed_browser:false})
 ]){
  const f=fixture();
  assert.throws(()=>f.op('unlock_handoff',bad(f)));
  assert.equal(f.getWrites(),0);
  assert.equal(f.target.handoff_requires_owner_reconfigure,true);
 }
 const f=fixture({browser:false});
 assert.throws(()=>f.op('unlock_handoff',f.req),/browser|вкладк/i);
 assert.equal(f.getWrites(),0);
});
