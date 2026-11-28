'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'../..');
const serverSource=fs.readFileSync(path.join(root,'autosend/server.mjs'),'utf8');
const rendererSource=fs.readFileSync(path.join(root,'windows/app/renderer.js'),'utf8');
const makeTask=(fields={})=>({
 id:'browser-tristate-task',url:'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
 message:'Fixture only, never send',enabled:true,status:'scheduled',
 manual_once:false,verification:null,active_slot_id:null,next_at:null,
 smart_v2:true,smart_result_gate:true,smart_v2_last_action:'CONTINUE_DEVELOPMENT',
 schedule_mode:'after_response',interval_seconds:300,browserConfirmed:false,...fields
});

function viewWith({backendOnline=false,browserOnline=false,approved=false}={}){
 const first=serverSource.indexOf('function view(){');
 const last=serverSource.indexOf('async function previewTask(id){',first);
 assert.ok(first>0&&last>first,'real production status view exists');
 const task=makeTask();
 const context={
  backendOnline,browserOnline,backendLastError:backendOnline?'':'port unavailable',
  browserLastSeen:null,extensionProtocolReady:null,extensionProbeAt:null,
  approvedTabs:{has:id=>id===task.id&&approved,size:approved?1:0},
  modelUsageStatus:()=>({state:'LOCAL_AUTOSEND_RECEIPTS',rows:[]}),
  invalidateForBrowserGeneration:()=>false,
  db:{tasks:[task],attempts:[]},
  visibleTasks:state=>state.tasks,
  workEfficiency:()=>({confirmed_deliveries:0}),
  historySummary:()=>({}),conversationStates:()=>[],
  now:()=>new Date('2026-11-26T17:00:00Z').toISOString()
 };
 vm.runInNewContext(serverSource.slice(first,last)+';globalThis.viewStatus=view;',context);
 return context.viewStatus();
}

async function renderWith(state){
 const first=rendererSource.indexOf('function autosendTabHealth(status,task){');
 const refresh=rendererSource.indexOf('async function refreshTasks(){');
 const last=rendererSource.indexOf("$('refresh-tasks').onclick=refreshTasks;",refresh);
 assert.ok(first>0&&refresh>first&&last>refresh,'production renderer has a task-specific browser diagnostic');
 const lines=[],actions=[];
 const list={replaceChildren(){lines.length=0;},append(x){lines.push(x)}};
 const context={
  $:id=>id==='tasks-list'?list:null,
  taskRefreshRevision:0,previewResults:new Map(),
  window:{mcpgo:{
   serviceRead:async(app,uri)=>{assert.equal(app,'autosend');assert.equal(uri,'/api/status');return state},
   serviceAction:()=>{throw Error('Read-only render may never mutate or send')}
  }},
  item:(title,body,buttons)=>({title,body,buttons}),
  doTask:(...a)=>actions.push(a),
  Date,Set,Map,String,Boolean
 };
 const source=rendererSource.slice(first,last)+';globalThis.renderTasks=refreshTasks;';
 vm.runInNewContext(source,context);
 await context.renderTasks();
 assert.equal(actions.length,0,'reading status cannot send/queue/approve tab');
 assert.equal(lines.length,1);
 return lines[0].body;
}

test('AutoSend status separates reachable Playwright backend from approved Chrome tabs',()=>{
 const reachable=viewWith({backendOnline:true,browserOnline:false,approved:false});
 assert.equal(reachable.browserBackendReachable,true);
 assert.equal(reachable.extensionConnected,false,'preserve legacy flag for older clients');
 assert.equal(reachable.tasks[0].browserConfirmed,false);
 const approved=viewWith({backendOnline:true,browserOnline:true,approved:true});
 assert.equal(approved.browserBackendReachable,true);
 assert.equal(approved.extensionConnected,true);
 assert.equal(approved.tasks[0].browserConfirmed,true);
 const down=viewWith({backendOnline:false,browserOnline:false,approved:false});
 assert.equal(down.browserBackendReachable,false);
 assert.equal(down.extensionConnected,false);
});

test('GUI distinguishes unreachable backend from unverified tab, and requires proof of tab identity',async()=>{
 const down=await renderWith(viewWith({backendOnline:false,browserOnline:false}));
 assert.ok(down.some(x=>/локальный Playwright backend недоступен/i.test(x)));
 const unverified=await renderWith(viewWith({backendOnline:true,browserOnline:false}));
 assert.ok(unverified.some(x=>/backend доступен/i.test(x)&&/вкладка не подтверждена/i.test(x)),'reachable backend is not disconnected Chrome');
 assert.ok(!unverified.some(x=>/Chrome отключён|Chrome недоступен/i.test(x)));
 const verified=await renderWith(viewWith({backendOnline:true,browserOnline:true,approved:true}));
 assert.ok(verified.some(x=>/вкладка подтверждена/i.test(x)),'only task-specific approval confirms a tab');
});

test('missing backend status remains unknown and cannot falsely turn green',async()=>{
 const status=viewWith({backendOnline:true,browserOnline:true,approved:true});
 delete status.browserBackendReachable; // older AutoSend service during partial upgrade
 const labels=await renderWith(status);
 assert.ok(labels.some(x=>/статус транспорта не подтверждён/i.test(x)));
 assert.ok(!labels.some(x=>/вкладка подтверждена/i.test(x)));
});

test('an approved tab of another task does not confirm this conversation',async()=>{
 const status=viewWith({backendOnline:true,browserOnline:true,approved:false});
 assert.equal(status.extensionConnected,true,'legacy transport flag can be true for another tab');
 const labels=await renderWith(status);
 assert.ok(labels.some(x=>/вкладка не подтверждена/i.test(x)));
 assert.ok(!labels.some(x=>/вкладка подтверждена/i.test(x)));
});
