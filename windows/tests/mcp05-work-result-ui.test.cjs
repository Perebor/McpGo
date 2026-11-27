const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const renderer=fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');
const begin=renderer.indexOf('function autosendTabHealth(status,task){');
const end=renderer.indexOf("$('refresh-tasks').onclick=refreshTasks;",begin);
assert.ok(begin>0&&end>begin);

test('MCP-05 real AutoSend card visibly distinguishes independent verified work from self-report',async()=>{
 const rows=[],sends=[];
 const task={
  id:'museum-verified',url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
  project_label:'Museum',message:'DO_NOT_SEND',status:'paused',enabled:false,
  interval_seconds:900,schedule_mode:'after_response',delivery_count:37,
  work_efficiency:{last_work_result_status:'VERIFIED',
   verified_work_results:2,self_report_only_results:1}
 };
 const context={
  $:()=>({replaceChildren(){rows.length=0;},append(x){rows.push(x)}}),
  previewResults:new Map(),taskRefreshRevision:0,
  window:{mcpgo:{serviceRead:async()=>({tasks:[task],browserBackendReachable:true})}},
  item:(title,lines,buttons)=>({title,lines,buttons}),
  doTask:(action,id)=>sends.push({action,id}),confirm:()=>false
 };
 vm.runInNewContext(renderer.slice(begin,end)+';globalThis.refresh=refreshTasks;',context);
 await context.refresh();
 assert.equal(rows.length,1);
 assert.ok(rows[0].lines.some(x=>x.includes('Git/CI/тест')&&x.includes('2')&&x.includes('1')),
  'Visible task card must show verified work and unverified self-report separately');
 assert.ok(rows[0].lines.some(x=>x.includes('Последний результат: проверен')));
 assert.equal(sends.length,0,'Rendering must be read-only');
 task.work_efficiency={last_work_result_status:'SELF_REPORT',
  verified_work_results:2,self_report_only_results:2};
 await context.refresh();
 assert.ok(rows[0].lines.some(x=>x.includes('Последний результат: самоотчёт')));
 task.work_efficiency={last_work_result_status:'UNKNOWN',
  verified_work_results:0,self_report_only_results:0};
 await context.refresh();
 assert.equal(rows[0].lines.some(x=>x.includes('Git/CI/тест')),false,
  'No noisy metrics line for a task without a work result');
});
