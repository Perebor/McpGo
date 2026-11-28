'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const renderer=fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8');
const begin=renderer.indexOf('const healthLabels=');
const end=renderer.indexOf('setInterval(()=>{if(lastOverview)',begin);
assert.ok(begin>0&&end>begin);

test('MCP-06 overview displays independent statuses and actionable safe next step, not false green',()=>{
 assert.match(html,/id="health-contract-list"/);
 const elements=new Map();
 const ctx={$:id=>{
  if(!elements.has(id))elements.set(id,{textContent:'',className:'',hidden:false});
  return elements.get(id);
 }};
 vm.runInNewContext(renderer.slice(begin,end)+';globalThis.renderConnection=renderConnection;',ctx);
 const now=Date.now();
 const make=(status,nextSafeAction)=>({status,nextSafeAction,
  reason:status==='UNKNOWN'?'CHROME_NOT_CONFIRMED':status==='PASS'?'HUB_API_VERIFIED':'SERVICE_STOPPED',
  lastSeen:null,lastAttempt:new Date(now).toISOString()});
 const data={readiness:{connectionHealth:{},history:[],healthContract:{version:1,
  components:{terminal:make('PASS','NONE'),chrome:make('UNKNOWN','NEED_OWNER'),
   hub:make('PASS','NONE'),autosend:make('FAIL','RECHECK')}}}};
 ctx.renderConnection(data);
 const view=elements.get('health-contract-list').textContent;
 assert.match(view,/Terminal.*PASS/);
 assert.match(view,/Chrome.*UNKNOWN.*владелец/i);
 assert.match(view,/Hub.*PASS/);
 assert.match(view,/AutoSend.*FAIL.*повторная проверка/i);
 assert.doesNotMatch(view,/Все сервисы готовы/i);
 data.readiness.healthContract={version:1,components:{}};
 ctx.renderConnection(data);
 assert.match(elements.get('health-contract-list').textContent,/UNKNOWN|не подтвержд/);
});
