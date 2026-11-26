'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..');
const mod=name=>import(pathToFileURL(path.join(root,'autosend',name)).href);
const M='https://chatgpt.com/g/g-p-6afed792e5208191a02d8bef5e2de418-moi-muzei-istoriia/c/6b07a214-5ea0-83ed-a821-69149d6237a0';
const T='https://chatgpt.com/g/g-p-6ab3db7d00b48191819f67204e276bd7-td-astra6/c/6b072c3d-223c-83ed-93c3-7e6ca9015179';
const task=(id,project,url)=>({id,smart_v2_project:project,url,enabled:true,status:'scheduled',
 smart_v2:true,smart_result_gate:true,schedule_mode:'after_response',verification:null,
 active_slot_id:null,manual_once:false,smart_v2_pending_action:null});
const consent={version:1,enabled:true,chats:[{task_id:'museum',project:'Museum',url:M},{task_id:'td',project:'TD',url:T}]};

test('local recovery is scoped to two approved conversations and never invokes Send',async()=>{
 const {PersistentTabRecovery}=await mod('persistent-tabs.mjs');
 const {TabApproval}=await mod('tab-approval.mjs');
 const tabs=['about:blank'],calls=[];
 const fake={
  session:'session-1',async connect(){},
  async tool(name,args){
   calls.push([name,args.action,args.url||null]);
   assert.equal(name,'browser_tabs');
   if(args.action==='new')tabs.push(args.url);
   assert.ok(['new','list'].includes(args.action));
   return '### Result\n'+tabs.map((url,i)=>'- '+i+': ['+(url==='about:blank'?'':'ChatGPT')+']('+url+')').join('\n');
  }
 };
 const approval=new TabApproval();
 const r=new PersistentTabRecovery({client:fake,config:consent,approval,verify:async()=>({chatFound:true,ready:true})});
 const a=task('museum','Museum',M),b=task('td','TD',T);
 const result=await r.run([a,b]);
 assert.equal(result.created,2);assert.equal(result.approved,2);
 assert.equal(approval.has(a.id),true);assert.equal(approval.has(b.id),true);
 assert.deepEqual(tabs,['about:blank',M,T]);
 assert.ok(calls.every(([name,action])=>name==='browser_tabs'&&['new','list'].includes(action)));
});

test('owner-paused tasks cannot be reopened by tab recovery',async()=>{
 const {PersistentTabRecovery}=await mod('persistent-tabs.mjs');
 const {TabApproval}=await mod('tab-approval.mjs');
 const ops=[];
 const fake={session:'s',async connect(){},async tool(name,args){ops.push(args.action);return '### Result\n- 0: [blank](about:blank)'}};
 const a=task('museum','Museum',M);a.status='paused';a.enabled=false;
 const recovery=new PersistentTabRecovery({client:fake,config:consent,approval:new TabApproval(),verify:async()=>({chatFound:true,ready:true})});
 const result=await recovery.run([a]);
 assert.equal(result.created,0);assert.equal(ops.length,0);
 assert.equal(a.status,'paused');assert.equal(a.enabled,false);
});

test('verified prompt identity survives edits to the stored task template',async()=>{
 const {smartV2Sentinel,promoteSmartReceipt,reportBelongsToLastSmartMessage}=await mod('smart-v2.mjs');
 const t={id:'fixture',smart_v2:true,smart_v2_project:'TD',message:'original',
  smart_v2_pending_action:'BOOTSTRAP'};
 const sentinel=smartV2Sentinel(t,'BOOTSTRAP');
 t.smart_v2_pending_sentinel=sentinel;
 assert.equal(promoteSmartReceipt(t),'BOOTSTRAP');
 assert.equal(t.smart_v2_last_sent_sentinel,sentinel);
 t.message='later edited prompt';
 assert.equal(reportBelongsToLastSmartMessage(t,'SMART AUTOSEND V2 · TD · BOOTSTRAP\nAUTO_V2_SENTINEL: '+sentinel),true);
 assert.equal(reportBelongsToLastSmartMessage(t,'AUTO_V2_SENTINEL: '+'0'.repeat(20)),false);
});

test('confirmed no-click event retry requires an approved marker; unresolved click is never retried',async()=>{
 const {rescheduleAfterAttempt}=await mod('core.mjs');
 const at=Date.parse('2026-11-26T14:00:00Z');
 const t={enabled:true,status:'checking',schedule_mode:'after_response',smart_v2:true,smart_result_gate:true,
  smart_v2_last_action:'BOOTSTRAP',smart_work_ready_marker:'f'.repeat(64),
  smart_work_expected_action:'CONTINUE_DEVELOPMENT',manual_once:false,verification:null};
 rescheduleAfterAttempt(t,at);
 assert.equal(t.next_at,new Date(at+60000).toISOString());
 const unknown={...t,status:'checking',verification:{actionId:'unknown'}};
 rescheduleAfterAttempt(unknown,at);
 assert.equal(unknown.next_at,null);
});
