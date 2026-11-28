import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verificationReceipt} from '../reconciliation.mjs';

const CHAT_URL='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
async function sparePort(){
 const listener=net.createServer();
 await new Promise((resolve,reject)=>listener.listen(0,'127.0.0.1',e=>e?reject(e):resolve()));
 const port=listener.address().port;
 await new Promise(resolve=>listener.close(resolve));
 return port;
}
async function startIsolated(state){
 const folder=await mkdtemp(path.join(os.tmpdir(),'mcpgo-autosend-test-'));
 const stateFile=path.join(folder,'state.json');
 if(state)await writeFile(stateFile,JSON.stringify(state));
 const port=await sparePort();
 const env={...process.env,
  MCPHUB_AUTOSEND_PORT:String(port),
  MCPHUB_AUTOSEND_STATE:stateFile,
  MCPHUB_AUTOSEND_BROWSER_PORT:'65412',
  MCPHUB_AUTOSEND_BROWSER_MCP_URL:'http://127.0.0.1:65412/mcp',
  MCPHUB_AUTOSEND_CHECK_MS:'50',
  NODE_ENV:'test'
 };
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],
  {env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',v=>stdout+=v.toString().slice(0,1000));
 child.stderr.on('data',v=>stderr+=v.toString().slice(0,1000));
 const base='http://127.0.0.1:'+port;
 let started=false;
 for(let i=0;i<50;i++){
  if(child.exitCode!==null)break;
  try{
   const tokenPath=path.join(folder,'control-token');
   let token='';try{token=readFileSync(tokenPath,'utf8').trim()}catch{}
   const response=await fetch(base+'/api/status',{headers:{'X-MCPHub-Client':'native','X-MCPHub-Token':token}});
   if(response.ok){started=true;break;}
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,30));
 }
 if(!started){
  child.kill('SIGTERM');
  await rm(folder,{recursive:true,force:true});
  throw Error('Isolated AutoSend failed to start: '+stdout+' '+stderr);
 }
 return {child,folder,stateFile,base,headers:{'X-MCPHub-Client':'native','Content-Type':'application/json','X-MCPHub-Token':readFileSync(path.join(folder,'control-token'),'utf8').trim()}};
}
async function shutdown(s){
 s.child.kill('SIGTERM');
 await Promise.race([
  new Promise(resolve=>s.child.once('close',resolve)),
  new Promise(resolve=>setTimeout(resolve,2000))
 ]);
 if(s.child.exitCode===null)s.child.kill('SIGKILL');
 await rm(s.folder,{recursive:true,force:true});
}

test('isolated HTTP server creates a paused schedule without sending or touching other installations',async()=>{
 const instance=await startIsolated();
 try{
  const posted=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'create',url:CHAT_URL,message:'test',interval_seconds:900})
  });
  assert.equal(posted.status,200);
  const created=await posted.json();
  assert.equal(created.task.status,'paused');
  assert.equal(created.task.enabled,false);
  const response=await fetch(instance.base+'/api/status',{headers:instance.headers});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.tasks.length,1);
  assert.equal(result.tasks[0].delivery_count,0);
  assert.deepEqual(result.attempts,[]);
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].status,'paused');
  const forbidden=await fetch(instance.base+'/api/status');
  assert.equal(forbidden.status,403);
 }finally{await shutdown(instance);}
});
test('server restart preserves pending click proof and never dispatches automatically',async()=>{
 const task={
  id:'fake-schedule-1',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:true,status:'sending',manual_once:false,next_at:null,
  last_attempt_at:new Date().toISOString(),last_error:'',
  delivery_count:0,delivery_stage:'click-committed',
  verification:verificationReceipt({userCount:3,lastUserText:'Old user text'}),
 };
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/status',{headers:instance.headers});
  const result=await response.json();
  assert.equal(result.tasks[0].status,'verifying');
  assert.equal(result.tasks[0].delivery_count,0);
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].status,'verifying');
  assert.equal(disk.tasks[0].verification.baselineUserCount,3);
  assert.equal(disk.tasks[0].verification.baselineLastUserText,undefined);
 }finally{await shutdown(instance);}
});

test('manual unknown verification via HTTP only rechecks saved receipt; never queues Send',async()=>{
 const task={id:'unknown-1',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:false,status:'unknown',manual_once:false,next_at:null,
  last_error:'Unknown result',delivery_count:0,delivery_stage:'verification-expired',
  verification:verificationReceipt({userCount:3,lastUserText:'Older message'},Date.now()-500000)};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'recheck_unknown',id:task.id})
  });
  assert.equal(response.status,200);
  const started=await response.json();
  assert.equal(started.checking,true);
  assert.equal(started.sendBlocked,true);
  const result=await (await fetch(instance.base+'/api/status',{
   headers:instance.headers
  })).json();
  const updated=result.tasks[0];
  assert.equal(updated.enabled,false);
  assert.equal(updated.manual_once,false);
  assert.equal(updated.status,'verifying');
  assert.equal(updated.verification.manualRechecks,1);
  assert.equal(updated.verification.baselineUserCount,3);
  const forbidden=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'send_once',id:task.id})
  });
  assert.equal(forbidden.status,400,'manual recheck cannot be turned into new send');
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].enabled,false);
  assert.equal(disk.attempts.length,0);
 }finally{await shutdown(instance)}
});
test('manual unknown recheck without a baseline returns an error, never creates a job',async()=>{
 const task={id:'missing-receipt',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:false,status:'unknown',manual_once:false,next_at:null,delivery_count:0,last_error:'Unknown'};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'recheck_unknown',id:task.id})
  });
  assert.equal(response.status,400);
  const result=await (await fetch(instance.base+'/api/status',{
   headers:instance.headers
  })).json();
  assert.equal(result.tasks[0].status,'unknown');
 }finally{await shutdown(instance)}
});

test('HTTP conversation FSM blocks only the same chat, while other chats stay runnable',async()=>{
 const u2='https://chatgpt.com/c/00000000-0000-4000-8000-000000000002';
 const unknown={id:'u1',url:CHAT_URL,message:'first',interval_seconds:900,
  enabled:false,status:'unknown',manual_once:false,next_at:null,
  delivery_count:0,last_error:'Lost reply'};
 const sibling={id:'s1',url:CHAT_URL,message:'second',interval_seconds:900,
  enabled:false,status:'paused',manual_once:false,next_at:null,
  delivery_count:0,last_error:''};
 const independent={id:'i1',url:u2,message:'other chat',interval_seconds:900,
  enabled:false,status:'paused',manual_once:false,next_at:null,
  delivery_count:0,last_error:''};
 const instance=await startIsolated({version:1,tasks:[unknown,sibling,independent],attempts:[]});
 try {
  const same=await fetch(instance.base+'/api/tasks',{method:'POST',headers:instance.headers,
    body:JSON.stringify({action:'start',id:'s1'})});
  assert.equal(same.status,400,'unresolved receipt forbids a second schedule in the same chat');
  const other=await fetch(instance.base+'/api/tasks',{method:'POST',headers:instance.headers,
    body:JSON.stringify({action:'start',id:'i1'})});
  assert.equal(other.status,200,'another conversation remains schedulable');
  const status=await (await fetch(instance.base+'/api/status',{
   headers:instance.headers})).json();
  assert.equal(status.conversations[CHAT_URL].state,'UNKNOWN');
  assert.equal(status.conversations[CHAT_URL].blocked,true);
  assert.equal(status.conversations[u2].state,'READY');
  assert.equal(status.conversations[u2].blocked,false);
  assert.equal(status.tasks.find(x=>x.id==='i1').enabled,true);
  assert.equal(status.tasks.find(x=>x.id==='s1').enabled,false);
  assert.equal(status.attempts.length,0,'no browser actions occurred');
 }finally{await shutdown(instance)}
});

test('user can explicitly confirm already-sent unknown without a new Send or rearming the timer',async()=>{
 const task={id:'manual-confirm-1',url:CHAT_URL,message:'repeated test',
  interval_seconds:900,enabled:false,status:'unknown',manual_once:false,
  next_at:null,last_error:'Unconfirmed',delivery_count:3,delivery_stage:'verification-expired',
  verification:verificationReceipt({userCount:6,lastUserText:'repeated test'},Date.now()-600000)};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'confirm_received',id:task.id})
  });
  assert.equal(response.status,200);
  const confirmed=await response.json();
  assert.equal(confirmed.confirmed,true);
  assert.equal(confirmed.sendBlocked,true);
  assert.equal(confirmed.paused,true);
  const status=await (await fetch(instance.base+'/api/status',{
   headers:instance.headers})).json();
  const updated=status.tasks[0];
  assert.equal(updated.enabled,false);
  assert.equal(updated.manual_once,false);
  assert.equal(updated.status,'paused');
  assert.equal(updated.next_at,null);
  assert.equal(updated.delivery_count,4);
  assert.equal(updated.delivery_stage,'manual-confirmed');
  assert.equal(updated.verification,undefined);
  assert.equal(status.attempts.length,1);
  assert.equal(status.attempts[0].result,'verified_manual');
  const duplicate=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'confirm_received',id:task.id})
  });
  assert.equal(duplicate.status,400,'manual confirmation must not be counted twice');
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks[0].enabled,false);
  assert.equal(disk.attempts.length,1);
 }finally{await shutdown(instance)}
});
test('manual confirmation is refused for a scheduled task with no attempted Send',async()=>{
 const task={id:'not-sent',url:CHAT_URL,message:'test',interval_seconds:900,
  enabled:false,status:'paused',manual_once:false,next_at:null,
  delivery_count:0,last_error:''};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'confirm_received',id:task.id})
  });
  assert.equal(response.status,400);
  const status=await (await fetch(instance.base+'/api/status',{
   headers:instance.headers})).json();
  assert.equal(status.tasks[0].delivery_count,0);
  assert.equal(status.attempts.length,0);
 }finally{await shutdown(instance)}
});

test('preview without sending reports unavailable browser and preserves a paused task',async()=>{
 const instance=await startIsolated();
 try{
  const created=await (await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,
   body:JSON.stringify({action:'create',url:CHAT_URL,message:'DO_NOT_SEND',interval_seconds:900})
  })).json();
  const response=await fetch(instance.base+'/api/tasks',{
   method:'POST',headers:instance.headers,body:JSON.stringify({action:'preview',id:created.task.id})
  });
  assert.equal(response.status,200);
  const checked=await response.json();
  assert.equal(checked.ready,false);
  assert.equal(checked.sendBlocked,true);
  assert.match(checked.reason,/Playwright Extension backend/);
  const state=await (await fetch(instance.base+'/api/status',{headers:instance.headers})).json();
  assert.equal(state.tasks[0].status,'paused');
  assert.equal(state.tasks[0].delivery_count,0);
  assert.deepEqual(state.attempts,[]);
 }finally{await shutdown(instance);}
});
test('spoofed native header without control token is forbidden',async()=>{
 const instance=await startIsolated();
 try{
  const bad=await fetch(instance.base+'/api/status',{headers:{'X-MCPHub-Client':'native'}});
  assert.equal(bad.status,403);
  const forged=await fetch(instance.base+'/api/status',{headers:{...instance.headers,'X-MCPHub-Token':'f'.repeat(64)}});
  assert.equal(forged.status,403);
 }finally{await shutdown(instance);}
});

test('guided project creation is paused, deduplicated and never bootstraps without browser verification',async()=>{
 const instance=await startIsolated();
 try{
  const args={action:'create',url:CHAT_URL,message:'Продолжай работу',
   project_label:'Новый проект',guided_first_run:true,schedule_mode:'after_response',interval_seconds:600};
  const first=await fetch(instance.base+'/api/tasks',{method:'POST',headers:instance.headers,body:JSON.stringify(args)});
  assert.equal(first.status,200);
  const created=(await first.json()).task;
  assert.equal(created.project_label,'Новый проект');
  assert.equal(created.guided_first_run,true);
  assert.equal(created.schedule_mode,'after_response');
  assert.equal(created.status,'paused');
  assert.equal(created.enabled,false);
  const duplicate=await fetch(instance.base+'/api/tasks',{method:'POST',headers:instance.headers,body:JSON.stringify(args)});
  assert.equal(duplicate.status,400);
  const start=await fetch(instance.base+'/api/tasks',{method:'POST',headers:instance.headers,body:JSON.stringify({action:'start_first',id:created.id})});
  assert.equal(start.status,400,'no verified Chrome tab, no first run');
  const view=await(await fetch(instance.base+'/api/status',{headers:instance.headers})).json();
  assert.equal(view.tasks.length,1);
  assert.equal(view.tasks[0].enabled,false);
  assert.equal(view.tasks[0].status,'paused');
  assert.equal(view.tasks[0].first_cycle_started_at,undefined);
  assert.equal(view.tasks[0].manual_once,undefined);
  assert.equal(view.attempts.length,0);
  assert.equal(JSON.parse(await readFile(instance.stateFile,'utf8')).tasks.length,1);
 }finally{await shutdown(instance)}
});

test('MCP-04 HTTP migration journals pre-existing click proof without any new Send',async()=>{
 const task={id:'legacy-click',url:CHAT_URL,message:'DO_NOT_SEND',interval_seconds:900,
  enabled:true,status:'sending',manual_once:false,next_at:null,
  last_attempt_at:new Date().toISOString(),last_error:'',delivery_count:0,
  delivery_stage:'click-committed',verification:verificationReceipt({userCount:1,lastUserText:'old'})};
 const s=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const response=await (await fetch(s.base+'/api/status',{headers:s.headers})).json();
  assert.equal(response.tasks[0].status,'verifying');
  assert.equal(response.tasks[0].delivery_count,0);
  const disk=JSON.parse(await readFile(s.stateFile,'utf8'));
  assert.equal(disk.transition_sequence,2);
  assert.deepEqual(disk.transition_log.map(x=>x.kind),['BASELINE_IMPORTED','STATUS_CHANGED']);
  assert.equal(disk.transition_log.at(-1).from.status,'sending');
  assert.equal(disk.transition_log.at(-1).to.status,'verifying');
  assert.equal(disk.transition_log.at(-1).to.receipt,true);
  assert.doesNotMatch(JSON.stringify(disk.transition_log),/DO_NOT_SEND|chatgpt.com/);
 }finally{await shutdown(s)}
});

test('MCP-05 HTTP status presents independent result counters, not self-reported claims as verified',async()=>{
 const task={id:'museum-metric',url:CHAT_URL,message:'do not send',interval_seconds:900,
  enabled:false,status:'paused',manual_once:false,next_at:null,delivery_count:0,
  smart_v2_project:'Museum',work_result:{version:1,project:'Museum',status:'SELF_REPORT',fingerprint:'a'.repeat(64)},
  work_result_metrics:{self_report_only:1,verified:0}};
 const instance=await startIsolated({version:1,tasks:[task],attempts:[]});
 try{
  const result=await (await fetch(instance.base+'/api/status',{headers:instance.headers})).json();
  const metrics=result.tasks[0].work_efficiency;
  assert.equal(metrics.last_work_result_status,'SELF_REPORT');
  assert.equal(metrics.self_report_only_results,1);
  assert.equal(metrics.verified_work_results,0);
  assert.equal(result.tasks[0].status,'paused');
  assert.equal(result.tasks[0].delivery_count,0);
 }finally{await shutdown(instance)}
});

test('MCP-05 isolated HTTP end-to-end: TD and Museum independently verified results survive encrypted fixture store without Send',async()=>{
 const {KNOWN_WORK_PROFILES,KNOWN_WORK_POLICIES,inspectWorkResult,commitObservedWorkResult}=
  await import('../work-result.mjs');
 const policies=[KNOWN_WORK_PROFILES.TD_BENCHO_VARIANTS,KNOWN_WORK_POLICIES.Museum];
 const now=Date.now();
 const tasks=[];
 for(let i=0;i<policies.length;i++){
  const p=policies[i];
  const task={id:'isolated-'+p.project,url:'https://chatgpt.com/c/00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
   message:'DO_NOT_SEND',interval_seconds:900,enabled:false,status:'paused',
   manual_once:false,next_at:null,delivery_count:0,smart_v2_project:p.project,
   last_success_at:new Date(now-60000).toISOString()};
  const outcome={kind:'report',fingerprint:String(i+1).repeat(64),
   report:{status:'VERIFIED',task:'EXTERNAL-FIXTURE'},
   workEvidence:{source:'assistant_self_report',files_changed:1,tests_passed:2,tests_failed:0,commit:'a'.repeat(40)}};
  const proof={verified:true,testsVerified:true,source:'github_ci_verified',
   project:p.project,repo:p.repo,fingerprint:outcome.fingerprint,
   sha:'a'.repeat(40),prNumber:i+10,provenAt:new Date(now).toISOString(),
   workflows:p.requiredWorkflows.map((name,j)=>({name,runId:100+i*10+j}))};
  const classified=await inspectWorkResult(task,outcome,{policy:p,now,verify:async()=>proof});
  assert.equal(classified.status,'VERIFIED');
  assert.equal(commitObservedWorkResult(task,classified,now),true);
  tasks.push(task);
 }
 const instance=await startIsolated({version:1,tasks,attempts:[]});
 try{
  const result=await (await fetch(instance.base+'/api/status',{headers:instance.headers})).json();
  assert.equal(result.tasks.length,2);
  assert.deepEqual(result.tasks.map(t=>t.smart_v2_project).sort(),['Museum','TD']);
  for(const t of result.tasks){
   assert.equal(t.work_efficiency.verified_work_results,1);
   assert.equal(t.work_efficiency.self_report_only_results,0);
   assert.equal(t.work_efficiency.last_work_result_status,'VERIFIED');
   assert.equal(t.delivery_count,0);
   assert.equal(t.status,'paused');
   assert.equal(t.enabled,false);
  }
  assert.equal(result.attempts.length,0);
  const disk=JSON.parse(await readFile(instance.stateFile,'utf8'));
  assert.equal(disk.tasks.length,2);
  assert.equal(disk.tasks.every(t=>t.work_result_seen.length===1),true);
  assert.equal(disk.tasks.every(t=>t.work_result_metrics.verified===1),true);
  assert.equal(disk.transition_log.length,2);
 }finally{await shutdown(instance)}
});

test('MCP-03 HTTP transport check is owner-only, read-only and never approves a chat',async()=>{
 const s=await startIsolated({version:1,tasks:[],attempts:[]});
 try{
  const denied=await fetch(s.base+'/api/tasks',{method:'POST',
   headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'probe_extension'})});
  assert.equal(denied.status,403);
  const result=await fetch(s.base+'/api/tasks',{method:'POST',headers:s.headers,
   body:JSON.stringify({action:'probe_extension'})});
  assert.equal(result.status,200);
  const probe=await result.json();
  assert.equal(probe.connected,false,'A missing dedicated backend is not a healthy extension');
  assert.equal(probe.sendBlocked,true);
  const status=await (await fetch(s.base+'/api/status',{headers:s.headers})).json();
  assert.equal(status.extensionTransportConnected,false);
  assert.equal(status.extensionConnected,false);
  assert.equal(status.chatTabApprovedCount,0);
  assert.deepEqual(status.tasks,[]);
  assert.deepEqual(status.attempts,[]);
  assert.equal(status.modelUsage.state,'LOCAL_AUTOSEND_RECEIPTS');
  assert.deepEqual(status.modelUsage.rows,[]);
 }finally{await shutdown(s)}
});
