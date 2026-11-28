'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const {presentProject}=require('../app/project-view.js');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const URL='https://chatgpt.com/c/00000000-0000-4000-8000-000000000001';
const task=(override={})=>({id:'fixture-task',url:URL,project_label:'Fixture project',
  status:'paused',enabled:false,smart_v2:false,guided_first_run:true,
  ...override});
test('MCP-13 front card prioritizes project/chat/state/verified result/next step; no private prompts or intervals',()=>{
 const t=task({message:'This is a secret continuation instruction',interval_seconds:600});
 const v=presentProject(t,{browserBackendReachable:true});
 assert.equal(v.title,'Fixture project');
 assert.equal(v.chat,URL);
 assert.equal(v.state,'На паузе');
 assert.equal(v.result,'Нет подтверждённых изменений кода');
 assert.match(v.next,/Проверьте.*вкладк|Проверить.*вкладк/i);
 assert.match(v.reason,/подтвержден|проверен/i);
 assert.equal(v.primaryAction,'start_first');
 assert.equal(v.primaryDisabled,false);
 assert.equal(JSON.stringify(v).includes('secret'),false);
 assert.equal(JSON.stringify(v).includes('600'),false);
});
test('MCP-13 queued, busy and ambiguous outcomes cannot offer a second Send',()=>{
 const waiting=presentProject(task({status:'scheduled',enabled:true}));
 assert.equal(waiting.primaryAction,'pause');
 assert.match(waiting.next,/результат|ответ/i);
 const unknown=presentProject(task({status:'unknown',enabled:false}));
 assert.equal(unknown.primaryAction,'recheck_unknown');
 assert.match(unknown.reason,/не подтвержд|неизвестн/i);
 assert.match(unknown.next,/Перепроверь/i);
 for(const status of ['sending','checking','verifying']){
  const busy=presentProject(task({status,enabled:true}));
  assert.equal(busy.primaryAction,null);
  assert.equal(busy.primaryDisabled,true);
  assert.match(busy.next,/ожида|дождитесь|провер/i);
 }
});
test('MCP-13 handoff remains locked, independent verified work differs from self-report',()=>{
 const locked=presentProject(task({handoff_requires_owner_reconfigure:true}));
 assert.equal(locked.primaryAction,null);
 assert.equal(locked.primaryDisabled,true);
 assert.match(locked.reason,/перенос|подтвержден/i);
 const verified=presentProject(task({last_success_at:'2026-11-25T10:00:00Z',
  work_efficiency:{last_work_result_status:'VERIFIED',verified_work_results:2,
                   self_report_only_results:1}}));
 assert.match(verified.result,/2.*проверен|проверен.*2/i);
 const self=presentProject(task({work_efficiency:{
  last_work_result_status:'SELF_REPORT',verified_work_results:0,
  self_report_only_results:7}}));
 assert.match(self.result,/самоотчёт|без независимой проверки/i);
 assert.doesNotMatch(self.result,/Подтверждено.*7/);
 const plain=presentProject(task({last_success_at:'2026-11-25T10:00:00Z'}));
 assert.equal(plain.result,'Нет подтверждённых изменений кода');
});
test('MCP-13 actual Windows renderer keeps emergency deletion always visible and moves technical fields into details',()=>{
 const html=read('windows/app/index.html'),js=read('windows/app/renderer.js'),css=read('windows/app/style.css');
 assert.match(html,/<script defer src="project-view\.js"><\/script>/);
 assert.match(js,/function projectCard\(/);
 assert.match(js,/project-diagnostics/);
 assert.match(js,/Удалить принудительно/);
 assert.match(js,/project-main-actions/);
 assert.match(js,/details\.open/);
 assert.match(css,/\.project-card/);
 assert.match(html,/id="task-project"/);
 assert.match(html,/id="task-url"/);
 assert.match(html,/id="task-advanced"/);
});
