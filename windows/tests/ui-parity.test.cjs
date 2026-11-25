'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const html=read('windows/app/index.html');
const css=read('windows/app/style.css');
const renderer=read('windows/app/renderer.js');

test('Windows desktop shell has macOS-style navigation with matching visible sections',()=>{
 const nav=[...html.matchAll(/data-nav="([^"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(nav,['overview','onboarding','messages','settings','skills','autosend','updates']);
 for(const section of nav){
  assert.match(html,new RegExp('data-section="'+section+'"'));
  assert.match(renderer,new RegExp(' '+section+':\\['));
 }
 assert.match(html,/class="sidebar"/);
 assert.match(html,/id="active-count"/);
 assert.match(html,/id="summary-count"/);
 assert.match(renderer,/element\.hidden=element\.dataset\.section!==section/);
 assert.match(renderer,/setAttribute\('aria-current','page'\)/);
 assert.match(renderer,/if\(!data\.terminal\?\.id \|\| !data\.browserTunnel\?\.id\)navigate\('onboarding'\)/);
});
test('Windows color palette follows macOS and logo is bundled locally',()=>{
 const mac=read('native/main.swift');
 for(const hex of ['0D1016','11151D','191E28','131822','303747','8795FF','56D4C5']){
  assert.match(mac,new RegExp('0x'+hex));
  assert.ok(css.toLowerCase().includes('#'+hex.toLowerCase()),hex+' missing in Windows palette');
 }
 assert.match(html,/src="logo\.png"/);
 assert.ok(require('../package.json').build.files.includes('app/logo.png'));
 assert.ok(fs.statSync(path.join(root,'windows/app/logo.png')).size>1024);
 assert.match(html,/Content-Security-Policy/);
 assert.doesNotMatch(html,/<script[^>]+src="https?:/);
});
test('Windows UI still declares all renderer control IDs and two system status cards',()=>{
 const ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]));
 for(const match of renderer.matchAll(/\$\('([a-z][a-z0-9-]*)'\)/g))
  assert.ok(ids.has(match[1]),'Missing element: '+match[1]);
 for(const name of ['terminal','terminalTunnel','browser','proxy','browserTunnel','autosendBrowser','autosend','messaging'])
  assert.ok(ids.has('state-'+name),'Missing status: '+name);
 assert.ok(ids.has('terminal-pill') && ids.has('browser-pill'));
 assert.match(renderer,/fresh\(h\.terminal\)&&h\.terminal\.state==='ready'/);
 assert.match(renderer,/fresh\(h\.browser\)&&h\.browser\.state==='ready'/);
});
test('sidebar tools use fixed allowlisted Electron handlers, not renderer filesystem access',()=>{
 const main=read('windows/app/main.cjs');
 const preload=read('windows/app/preload.cjs');
 const toolIds=[...html.matchAll(/data-open="([^"]+)"/g)].map(x=>x[1]);
 assert.deepEqual(toolIds,['folder','logs','docs']);
 assert.match(renderer,/window\.mcpgo\.openLocation\(button\.dataset\.open\)/);
 assert.match(preload,/openLocation:kind=>ipcRenderer\.invoke\('mcpgo:open-location',kind\)/);
 assert.match(main,/kind!=='folder'&&kind!=='logs'/);
 assert.match(main,/INVALID_LOCATION/);
 assert.match(main,/mcpgo:skill-read/);
 assert.match(main,/mcpgo:skill-copy/);
 assert.match(main,/mcpgo:skill-open/);
 assert.match(main,/shell\.openPath\(target\)/);
 assert.doesNotMatch(renderer,/require\(|eval\(/);
});


// Execute the actual renderer task-list function against a synthetic UI and API.
// No network, browser automation, or live schedules are touched.
async function renderAutoSendTask(status,enabled=false,accept=false){
 const vm=require('node:vm');
 const source=renderer.match(/async function refreshTasks\(\)\{[\s\S]*?\n\}\n(?=\$\('refresh-tasks'\)\.onclick=refreshTasks;)/);
 assert.ok(source,'task renderer not found');
 const rows=[],calls=[],prompts=[];
 const task={id:'fixture-task',url:'https://example.invalid/conversation',status,enabled,interval_seconds:300};
 const context={
  $:()=>({replaceChildren(){rows.length=0},append(row){rows.push(row)}}),
  window:{mcpgo:{serviceRead:async()=>({tasks:[task]})}},
  item:(title,lines,buttons,offsetEditor)=>({title,lines,buttons,offsetEditor}),
  doTask:(action,id,extra)=>calls.push(extra===undefined?{action,id}:{action,id,extra}),
  confirm:(prompt)=>{prompts.push(prompt);return accept}
 };
 await vm.runInNewContext(source[0]+'\nrefreshTasks()',context,{timeout:1000});
 assert.equal(rows.length,1);
 return {buttons:rows[0].buttons,lines:rows[0].lines,offsetEditor:rows[0].offsetEditor,calls,prompts};
}
test('UNKNOWN exposes only the manual receipt and verification-only reconciliation actions',async()=>{
 const ui=await renderAutoSendTask('unknown');
 assert.deepEqual(Array.from(ui.buttons,b=>b.label),['Перепроверить доставку','Подтвердить получение','Проверить без отправки']);
 assert.equal(ui.calls.length,0);
 assert.ok(ui.lines.some(line=>line.includes('Повторная отправка заблокирована')));
 ui.buttons[0].run();
 assert.deepEqual(ui.calls,[{action:'recheck_unknown',id:'fixture-task'}]);
});
test('manual receipt requires affirmative user attestation; cancel performs no action',async()=>{
 const cancelled=await renderAutoSendTask('unknown',false,false);
 cancelled.buttons[1].run();
 assert.equal(cancelled.prompts.length,1);
 assert.equal(cancelled.calls.length,0);
 const accepted=await renderAutoSendTask('unknown',false,true);
 accepted.buttons[1].run();
 assert.deepEqual(accepted.calls,[{action:'confirm_received',id:'fixture-task'}]);
 assert.equal(accepted.prompts.length,1);
});
test('in-flight tasks remain locked; paused and scheduled controls are unchanged',async()=>{
 for(const status of ['sending','checking','verifying']){
  const ui=await renderAutoSendTask(status,true);
  assert.equal(ui.buttons.length,0);
  assert.equal(ui.calls.length,0);
 }
 const paused=await renderAutoSendTask('paused');
 assert.deepEqual(Array.from(paused.buttons,b=>b.label),['Включить','Удалить','Проверить без отправки']);
 assert.equal(paused.calls.length,0);
 const scheduled=await renderAutoSendTask('scheduled',true);
 assert.deepEqual(Array.from(scheduled.buttons,b=>b.label),['Пауза','Проверить без отправки']);
});


test('paused interval task offers a read-only preview and displays last successful delivery',async()=>{
 const ui=await renderAutoSendTask('paused');
 assert.ok(ui.buttons.some(b=>b.label==='Проверить без отправки'));
 assert.ok(ui.lines.some(l=>l.startsWith('Последняя успешная доставка:')));
 assert.match(html,/id="task-offset"/);
 assert.match(renderer,/interval_offset_seconds/);
});


test('preview uses only preview action and offset editor is paused-only',async()=>{
 const paused=await renderAutoSendTask('paused');
 paused.buttons.find(b=>b.label==='Проверить без отправки').run();
 assert.deepEqual(paused.calls,[{action:'preview',id:'fixture-task'}]);
 paused.offsetEditor.save(180);
 assert.equal(paused.calls[1].action,'set_interval_offset');
 assert.equal(paused.calls[1].extra.interval_offset_seconds,180);
 assert.equal((await renderAutoSendTask('unknown')).offsetEditor,null);
 assert.equal((await renderAutoSendTask('scheduled',true)).offsetEditor,null);
});
