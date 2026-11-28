'use strict';
// Browser-only MCP-13 rendering fixture, never connects to real local services.
(function(){
 const chat='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
 const tasks=[
  {id:'fixture-paused',project_label:'Fixture Alpha',url:chat,
   message:'PRIVATE PROMPT MUST REMAIN IN DIAGNOSTICS',status:'paused',enabled:false,
   guided_first_run:true,schedule_mode:'after_response',browserConfirmed:false,
   interval_seconds:600,work_efficiency:{last_work_result_status:'VERIFIED',
     verified_work_results:2,self_report_only_results:1}},
  {id:'fixture-unknown',project_label:'Fixture Beta',url:chat.replace('000000000001','000000000002'),
   message:'Do not repeat a send with an unknown receipt',
   status:'unknown',enabled:false,interval_seconds:600,
   last_error:'Квитанция отправки не подтверждена'},
  {id:'fixture-running',project_label:'Fixture Gamma',url:chat.replace('000000000001','000000000003'),
   message:'Owner fixture for testing the Pause button',
   status:'scheduled',enabled:true,schedule_mode:'after_response',interval_seconds:600},
  {id:'fixture-handoff',project_label:'Fixture Delta',url:chat.replace('000000000001','000000000004'),
   message:'Owner fixture for handoff gate',
   status:'paused',enabled:false,handoff_requires_owner_reconfigure:true,interval_seconds:600}
 ];
 const calls=[];
 window.__mcp13Mock={tasks,calls};
 const fake={
  onStatus:()=>()=>{},
  status:async()=>({status:{},readiness:{chrome:true},terminal:{configured:true,id:'fixture-terminal'},browserTunnel:{configured:true,id:'fixture-browser'},
       playwrightExtension:{configured:false}}),
  verifyConnection:async()=>({status:{},readiness:{}}),
  onboard:async()=>({wizardDismissed:true,tunnels:{},chatgptInstructionsViewed:true}),
  serviceRead:async(service,route)=>{
   if(service==='autosend')return {tasks,browserBackendReachable:true,extensionConnected:false};
   if(route==='/api/agents')return {agents:[]};
   if(route==='/api/history')return {messages:[]};
   return {};
  },
  serviceAction:async(service,route,payload)=>{
   calls.push({service,route,action:payload?.action,id:payload?.id});
   if(service==='autosend'&&payload?.action==='create'){
    const task={id:'fixture-new-'+tasks.length,url:payload.url,
     project_label:payload.project_label,message:payload.message,
     guided_first_run:true,status:'paused',enabled:false,schedule_mode:'after_response',
     interval_seconds:payload.interval_seconds};
    tasks.push(task);return {task};
   }
   if(service==='autosend'&&['pause','start','start_first'].includes(payload?.action)){
    const task=tasks.find(t=>t.id===payload.id);
    if(task){task.status=payload.action==='pause'?'paused':'scheduled';task.enabled=payload.action!=='pause'}
   }
   // Simulates a local response, NEVER a network Send.
   return {ok:true,ready:false,reason:'MCP13_FIXTURE_NO_BROWSER_SEND'};
  },
  skillRead:async()=>({content:'Fixture skill text'}),
  checkUpdates:async()=>({}),
 };
 window.mcpgo=new Proxy(fake,{get(obj,key){
  if(key in obj)return obj[key];
  return async()=>({});
 }});
})();
