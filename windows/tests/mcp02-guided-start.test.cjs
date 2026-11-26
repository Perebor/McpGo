'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
const server=fs.readFileSync(path.join(root,'autosend/server.mjs'),'utf8');
const renderer=fs.readFileSync(path.join(root,'windows/app/renderer.js'),'utf8');
const html=fs.readFileSync(path.join(root,'windows/app/index.html'),'utf8');

function getOperation({approved=true,conflict=false}={}){
 const first=server.indexOf('function operation(action,body){');
 const last=server.indexOf('function expireAmbiguous(){',first);
 assert.ok(first>0&&last>first,'production mutation handler exists');
 const task={id:'guided-a',url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
   project_label:'Fixture',message:'Продолжай работу',
   interval_seconds:600,schedule_mode:'after_response',guided_first_run:true,
   enabled:false,status:'paused',manual_once:false,next_at:null,
   first_cycle_started_at:null,delivery_count:0};
 let commits=0,arms=0;
 const ctx={
   db:{tasks:[task]},
   find:id=>{if(id!==task.id)throw Error('missing');return task},
   assertTaskMutable:t=>{if(t.verification||t.active_slot_id||['unknown','checking','sending','verifying'].includes(t.status))throw Error('unsafe')},
   competingScheduleForChat:()=>conflict?{id:'competing-a',status:'unknown'}:null,
   approvedTabs:{has:()=>approved,update:()=>{},size:0},
   arm:t=>{arms++;t.enabled=true;t.status='scheduled';t.next_at=null},
   now:()=>new Date('2026-11-26T20:00:00.000Z').toISOString(),
   persist:()=>{commits++},
   workerBusy:false,currentScheduledTaskId:null,
   resumeSmartTaskFromOwnerPause:()=>{},crypto:{randomUUID:()=> 'guideda'},
   newTask:()=>task
 };
 vm.runInNewContext(server.slice(first,last)+';globalThis.handle=operation;',ctx);
 return {task,run:(type='start_first')=>ctx.handle(type,{id:task.id}),get commits(){return commits},get arms(){return arms}};
}
test('new guided task retains project and is paused with no first-run queue; legacy task is unchanged',async()=>{
 const {newTask}=await import('../../autosend/core.mjs');
 const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
 const guided=newTask({url,project_label:'  Мой проект  ',guided_first_run:true,
  message:'Продолжай работу',schedule_mode:'after_response',interval_seconds:600});
 assert.equal(guided.project_label,'Мой проект');
 assert.equal(guided.guided_first_run,true);
 assert.equal(guided.status,'paused');
 assert.equal(guided.enabled,false);
 assert.equal(guided.manual_once,undefined);
 assert.equal(guided.first_cycle_started_at,undefined);
 const legacy=newTask({url,message:'test',interval_seconds:600});
 assert.equal(legacy.guided_first_run,false);
 assert.equal(legacy.schedule_mode,'interval');
 assert.equal(legacy.enabled,false);
});
test('guided first cycle refuses to queue without a confirmed exact browser tab',()=>{
 const x=getOperation({approved:false});
 assert.throws(()=>x.run(),/подтвержден|провер/i);
 assert.equal(x.task.enabled,false);assert.equal(x.commits,0);
});
test('a single user-approved start queues first cycle exactly once across repeated calls',()=>{
 const x=getOperation();
 const first=x.run();
 assert.equal(first.queued,true);
 assert.equal(x.task.enabled,true);
 assert.equal(x.task.manual_once,true);
 assert.equal(x.task.status,'scheduled');
 assert.equal(x.task.next_at,'2026-11-26T20:00:00.000Z');
 assert.equal(x.task.first_cycle_started_at,'2026-11-26T20:00:00.000Z');
 assert.equal(x.commits,1);assert.equal(x.arms,1);
 const duplicate=x.run();
 assert.equal(duplicate.alreadyStarted,true);
 assert.equal(x.commits,1);assert.equal(x.arms,1);
 x.task.manual_once=false;x.task.status='paused';x.task.enabled=false;
 const restarted=x.run();
 assert.equal(restarted.alreadyStarted,true,'persisted first-run intent prevents replay after restart');
 assert.equal(x.commits,1);
});
test('guided first cycle refuses conflicting or unsafe task states',()=>{
 const competing=getOperation({conflict:true});
 assert.throws(()=>competing.run(),/другое|дубл|разговор|расписание/i);
 assert.equal(competing.commits,0);
 const unknown=getOperation();unknown.task.status='unknown';unknown.task.verification={actionId:'unknown'};
 assert.throws(()=>unknown.run(),/незаверш|unsafe/i);
 assert.equal(unknown.commits,0);
 const legacy=getOperation();legacy.task.guided_first_run=false;
 assert.throws(()=>legacy.run(),/нового|упрощ|guided/i);
 assert.equal(legacy.commits,0);
});
test('guided first run uses a single read-only browser preview before committing any send',()=>{
 assert.match(server,/if\s*\(\s*body\.action\s*===\s*'start_first'\s*\)/);
 assert.match(server,/await previewTask\(body\.id\)/);
 assert.match(server,/result\.ready\s*!==\s*true|result\.chatFound\s*!==\s*true/);
});
test('simple task form exposes project and chat; timing is under Advanced and mode defaults to result-driven',()=>{
 assert.match(html,/id="task-project"/);
 assert.match(html,/id="task-url"/);
 assert.match(html,/<details[^>]*id="task-advanced"/);
 assert.match(html,/id="task-interval"/);
 assert.match(html,/id="task-offset"/);
 assert.match(html,/id="task-mode"/);
 assert.match(html,/value="after_response"\s+selected/);
 assert.match(renderer,/guided_first_run:\s*true/);
 assert.match(renderer,/project_label:\s*\$\('task-project'\)/);
 assert.match(renderer,/\?'start_first':'start'/);
 assert.match(html,/Создать.*без отправки/);
});

test('real task-card renderer offers Start only for a new guided task and preserves legacy controls',async()=>{
 const begin=renderer.indexOf('function autosendTabHealth(status,task){');
 const end=renderer.indexOf("$('refresh-tasks').onclick=refreshTasks;",begin);
 assert.ok(begin>0&&end>begin);
 const rows=[],actions=[];
 const task={id:'guided-a',url:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001',
   project_label:'Fixture project',guided_first_run:true,status:'paused',enabled:false,
   schedule_mode:'after_response',interval_seconds:600,message:'work',delivery_count:0};
 const context={
  $:()=>({replaceChildren(){rows.length=0;},append(item){rows.push(item)}}),
  previewResults:new Map(),taskRefreshRevision:0,
  window:{mcpgo:{serviceRead:async()=>({tasks:[task],browserBackendReachable:true})}},
  item:(title,lines,buttons,offsetEditor)=>({title,lines,buttons,offsetEditor}),
  doTask:(action,id)=>actions.push({action,id}),
  confirm:()=>false
 };
 vm.runInNewContext(renderer.slice(begin,end)+';globalThis.refresh=refreshTasks;',context);
 await context.refresh();
 assert.equal(rows[0].title,'Fixture project');
 assert.ok(rows[0].lines.some(x=>x.startsWith('Чат: https://chatgpt.com/')));
 assert.equal(rows[0].buttons[0].label,'Запустить');
 assert.equal(actions.length,0,'Rendering must never send or queue');
 rows[0].buttons[0].run();
 assert.equal(actions[0].action,'start_first');
 task.guided_first_run=false;rows.length=0;await context.refresh();
 assert.equal(rows[0].buttons[0].label,'Включить','Existing schedule keeps legacy resume behavior');
});
test('real form creates disabled guided task with after-response mode and no start call',async()=>{
 const begin=renderer.indexOf('function showTaskScheduleOptions(){');
 const end=renderer.indexOf('async function refreshAgents(){',begin);
 assert.ok(begin>0&&end>begin);
 const posted=[];
 const elements={
   'task-mode':{value:'after_response'},'task-timing':{hidden:true},
   'task-project':{value:'  Demo  '},'task-url':{value:' https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 '},
   'task-message':{value:'Продолжай работу'},'task-interval':{value:'10'},'task-offset':{value:''},
   'task-create':{reset(){elements['task-mode'].value='after_response'}},
   'autosend-feedback':{textContent:''}
 };
 const ctx={
  $:id=>elements[id],
  message:msg=>{throw Error('Unexpected error: '+msg)},
  refreshTasks:async()=>{},
  window:{mcpgo:{serviceAction:async(app,uri,body)=>{
   assert.equal(app,'autosend');assert.equal(uri,'/api/tasks');
   posted.push(body);return {task:{status:'paused',enabled:false}};
  }}}
 };
 vm.runInNewContext(renderer.slice(begin,end),ctx);
 const submitter={disabled:false};
 await elements['task-create'].onsubmit({preventDefault(){},submitter});
 assert.equal(posted.length,1);
 assert.equal(posted[0].action,'create');
 assert.equal(posted[0].project_label,'Demo');
 assert.equal(posted[0].guided_first_run,true);
 assert.equal(posted[0].schedule_mode,'after_response');
 assert.equal(posted[0].interval_offset_seconds,null);
 assert.equal(submitter.disabled,false);
 assert.equal(elements['task-timing'].hidden,true);
 assert.match(elements['autosend-feedback'].textContent,/создано выключенным/i);
});

test('invalid project metadata cannot become a guided AutoSend task',async()=>{
 const {newTask,markUnknownOnBoot}=await import('../../autosend/core.mjs');
 const url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
 const fields={url,message:'test',interval_seconds:600,schedule_mode:'after_response',guided_first_run:true};
 assert.throws(()=>newTask(fields),/название проекта/i);
 assert.throws(()=>newTask({...fields,project_label:' '.repeat(65)}),/название проекта/i);
 assert.throws(()=>newTask({...fields,project_label:99}),/должно быть текстом/i);
 assert.throws(()=>newTask({...fields,project_label:'Fixture',guided_first_run:'true'}),/тип/i);
 const t=newTask({...fields,project_label:'Fixture'});
 t.enabled=true;t.status='scheduled';t.manual_once=true;t.next_at='2026-11-26T20:01:00Z';
 t.first_cycle_started_at='2026-11-26T20:00:00Z';
 markUnknownOnBoot({tasks:[t]});
 assert.equal(t.first_cycle_started_at,'2026-11-26T20:00:00Z','first-run intent survives restart');
 assert.equal(t.manual_once,false,'no automatic resending after crash');
 assert.equal(t.next_at,null,'old queued first click is retired');
});
