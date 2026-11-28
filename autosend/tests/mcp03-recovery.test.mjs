import test from 'node:test';
import assert from 'node:assert/strict';
import {PersistentTabRecovery} from '../persistent-tabs.mjs';
import {TabApproval} from '../tab-approval.mjs';

const target='https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-moi-muzei-istoriia/c/11111111-1111-4111-8111-111111111111';
const consent={version:1,enabled:true,chats:[{task_id:'museum',project:'Museum',url:target}]};
const task=()=>({id:'museum',smart_v2_project:'Museum',url:target,enabled:true,status:'scheduled',
  smart_v2:true,smart_result_gate:true,schedule_mode:'after_response',verification:null,
  active_slot_id:null,manual_once:false,smart_v2_pending_action:null});
const tabList=url=>'### Result\n- 0: [McpGo test]('+url+')';

test('MCP-03: reconnect failure revokes previously approved tab and never dispatches anything',async()=>{
  const approval=new TabApproval();
  approval.update('museum',true);
  let browserCalls=0;
  const client={session:'session-before-drop',async connect(){throw Error('Disconnected')},
    async tool(){browserCalls++;throw Error('Should not be called')}};
  const recovery=new PersistentTabRecovery({client,config:consent,approval,verify:async()=>{throw Error('No preview')}});
  const result=await recovery.run([task()]);
  assert.equal(result.errors,1);
  assert.equal(browserCalls,0);
  assert.equal(approval.has('museum'),false,'stale browser approval must be revoked');
});

test('MCP-03: browser tab listing failure revokes previous approval and fails closed',async()=>{
  const approval=new TabApproval();
  approval.update('museum',true);
  const calls=[];
  const client={session:'reconnected',async connect(){},
    async tool(name,{action}){calls.push(action);throw Error('Lost browser session')}};
  const recovery=new PersistentTabRecovery({client,config:consent,approval,verify:async()=>({ready:true,chatFound:true})});
  const result=await recovery.run([task()]);
  assert.equal(result.errors,1);
  assert.deepEqual(calls,['list']);
  assert.equal(approval.has('museum'),false,'a failed tab list cannot preserve proof of a tab');
});

test('MCP-03: malformed browser tab result does not create an unverified tab',async()=>{
  const calls=[];
  const client={session:'reconnected',async connect(){},
    async tool(name,{action}){calls.push(action);return '### Error\nUnable to inspect browser tabs';}};
  const approval=new TabApproval();
  approval.update('museum',true);
  const recovery=new PersistentTabRecovery({client,config:consent,approval,verify:async()=>({ready:true,chatFound:true})});
  const result=await recovery.run([task()]);
  assert.equal(result.created,0);
  assert.equal(result.errors,1);
  assert.deepEqual(calls,['list']);
  assert.equal(approval.has('museum'),false);
});

test('MCP-03: after reload an exact existing consented tab revalidates without a new tab or Send',async()=>{
  const calls=[];
  let verified=0;
  const client={session:'new-session',async connect(){},
    async tool(name,{action}){calls.push(action);assert.equal(name,'browser_tabs');assert.equal(action,'list');
      return tabList(target);}};
  const approval=new TabApproval();
  const recovery=new PersistentTabRecovery({client,config:consent,approval,
    verify:async(t)=>{verified++;assert.equal(t.url,target);return {ready:true,chatFound:true};}});
  const result=await recovery.run([task()]);
  assert.equal(result.approved,1);
  assert.equal(result.created,0);
  assert.equal(verified,1);
  assert.equal(approval.has('museum'),true);
  assert.deepEqual(calls,['list']);
});

test('MCP-03: paused owner tasks cannot be reopened by recovery even with prior consent',async()=>{
  const a=task();a.status='paused';a.enabled=false;
  let called=0;
  const client={session:'new-session',async connect(){called++},
    async tool(){called++;throw Error('No browser use for paused tasks')}};
  const approval=new TabApproval();
  const recovery=new PersistentTabRecovery({client,config:consent,approval,verify:async()=>({ready:true,chatFound:true})});
  const result=await recovery.run([a]);
  assert.equal(result.created,0);
  assert.equal(result.approved,0);
  assert.equal(called,0);
  assert.equal(a.enabled,false);
});
test('MCP-03: malformed owner consent cannot approve a non-canonical ChatGPT conversation',async()=>{
  const {allowedTarget}=await import('../persistent-tabs.mjs');
  const invalid='https://chatgpt.com/g/g-p-abc123-moi-muzei-istoriia/c/11111111-1111-4111-8111-111111111111';
  const cfg={version:1,enabled:true,chats:[{task_id:'museum',project:'Museum',url:invalid}]};
  const t={...task(),url:invalid};
  assert.equal(allowedTarget(t,cfg),false,'consent may only identify canonically parsed chats');
});