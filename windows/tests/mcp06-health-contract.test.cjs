'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {
 buildHealthContract,planSafeRestart,autoSendStateSafety,readOnlyProbe,
}=require('../app/health-contract.cjs');

const NOW=Date.parse('2026-11-27T06:50:00Z');
const fresh=NOW-1000;
const proc=()=>({terminal:'running',browser:'running',proxy:'running',
 autosendBrowser:'running',messaging:'running',autosend:'running'});
const readyConn=()=>({
 terminal:{state:'ready',checkedAt:fresh,mcp:true,tunnel:'ready',lastCallAt:fresh},
 browser:{state:'ready',checkedAt:fresh,mcp:true,tunnel:'ready',browser:'ready',
  lastBrowserAt:fresh}
});
const probes=()=>({hub:{ok:true,checkedAt:fresh},
 autosend:{ok:true,checkedAt:fresh,pausedCount:2,enabledCount:0,
  pendingCount:0,unknownCount:0,unresolvedCount:0}});

test('MCP-06 no telemetry is UNKNOWN for all four components, never PASS',()=>{
 const h=buildHealthContract({},NOW);
 assert.deepEqual(Object.keys(h.components),['terminal','chrome','hub','autosend']);
 for(const c of Object.values(h.components)){
  assert.equal(c.status,'UNKNOWN');assert.equal(c.lastSeen,null);
  assert.equal(c.lastAttempt,null);assert.ok(c.nextSafeAction);
 }
 assert.equal(h.version,1);
});
test('MCP-06 fresh independent probes show PASS; owner-paused AutoSend remains paused',()=>{
 const h=buildHealthContract({processes:proc(),connections:readyConn(),probes:probes()},NOW);
 for(const c of Object.values(h.components))assert.equal(c.status,'PASS');
 assert.equal(h.components.autosend.reason,'OWNER_PAUSED');
 assert.equal(h.components.autosend.nextSafeAction,'KEEP_PAUSED');
 assert.equal(h.components.terminal.lastAttempt,new Date(fresh).toISOString());
 assert.equal(h.components.chrome.lastSeen,new Date(fresh).toISOString());
});
test('MCP-06 stale or missing extension evidence cannot become green',()=>{
 const connections=readyConn();
 connections.terminal.checkedAt=NOW-60000;
 connections.browser.browser='unknown';
 const p=probes();p.hub.checkedAt=NOW-60000;
 delete p.autosend;
 const h=buildHealthContract({processes:proc(),connections,probes:p},NOW);
 assert.equal(h.components.terminal.status,'UNKNOWN');
 assert.equal(h.components.chrome.status,'UNKNOWN');
 assert.equal(h.components.chrome.nextSafeAction,'NEED_OWNER');
 assert.equal(h.components.hub.status,'UNKNOWN');
 assert.equal(h.components.autosend.status,'UNKNOWN');
});
test('MCP-06 fault injection for each service: no unexplained PASS',()=>{
 for(const channel of ['terminal','chrome','hub','autosend']){
  const processes=proc(),connections=readyConn(),p=probes();
  const processName={terminal:'terminal',chrome:'browser',hub:'messaging',autosend:'autosend'}[channel];
  processes[processName]='exited: 1';
  const h=buildHealthContract({processes,connections,probes:p},NOW);
  assert.equal(h.components[channel].status,'FAIL',channel);
  assert.equal(h.components[channel].nextSafeAction,'RECHECK',channel);
 }
});
test('MCP-06 ambiguous or in-flight receipt blocks recovery, not an unexplained pause',()=>{
 for(const p of [
  {...probes().autosend,pendingCount:1},
  {...probes().autosend,unknownCount:1},
  {...probes().autosend,unresolvedCount:1}
 ]){
  const h=buildHealthContract({processes:proc(),connections:readyConn(),
   probes:{hub:probes().hub,autosend:p}},NOW);
  assert.notEqual(h.components.autosend.status,'PASS');
  assert.equal(h.components.autosend.nextSafeAction,
   p.pendingCount?'WAIT_RECEIPT':'NEED_OWNER');
 }
});
test('MCP-06 no auto restart for unknown state, unknown ownership, owner pause or unresolved AutoSend',()=>{
 const base={service:'autosend',owned:true,health:'FAIL',now:NOW,recentAttempts:[]};
 for(const changes of [{owned:false},{health:'UNKNOWN'},{ownerPaused:true},
  {stateSafe:false},{inFlight:true},{unknownReceipt:true}]){
  const plan=planSafeRestart({...base,stateSafe:true,...changes});
  assert.equal(plan.action,'NONE');
  assert.equal(plan.autoRestart,false);
 }
});
test('MCP-06 retry budget: at most three safe retries in an hour, never infinite',()=>{
 const base={service:'hub',owned:true,health:'FAIL',stateSafe:true,now:NOW};
 let history=[];
 for(let i=0;i<3;i++){
  const plan=planSafeRestart({...base,recentAttempts:history});
  assert.equal(plan.action,'RESTART_OWNED_SERVICE');
  history.push(NOW-i*1000);
 }
 const exhausted=planSafeRestart({...base,recentAttempts:history});
 assert.equal(exhausted.action,'NONE');
 assert.equal(exhausted.reason,'RETRY_BUDGET_EXHAUSTED');
 assert.equal(exhausted.nextSafeAction,'NEED_OWNER');
 assert.equal(planSafeRestart({...base,recentAttempts:history.map(x=>x-3700000)}).autoRestart,true);
});
test('MCP-06 safety requires existing, small, regular AutoSend state; no unknown receipts',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp06-state-'));
 const file=path.join(folder,'tasks.json');
 try{
  assert.equal(autoSendStateSafety(file).safe,false);
  const mk=(task)=>fs.writeFileSync(file,JSON.stringify({version:1,tasks:[task],attempts:[]}));
  mk({id:'paused',status:'paused',enabled:false,verification:null});
  assert.equal(autoSendStateSafety(file).safe,true);
  for(const entry of [{status:'unknown',enabled:true},
   {status:'sending',enabled:true},
   {status:'paused',enabled:false,verification:{stage:'click-committed'}},
   {status:'paused',enabled:false,active_slot_id:'slot'}]){
   mk({id:'test',...entry});
   assert.equal(autoSendStateSafety(file).safe,false);
  }
  fs.writeFileSync(file,'not json');
  assert.equal(autoSendStateSafety(file).safe,false);
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
test('MCP-06 local probes require validated structured status and never write',async()=>{
 const calls=[];
 const probe=await readOnlyProbe('hub',{fetchImpl:async(url,params)=>{
  calls.push({url,method:params.method,headers:params.headers});
  return {ok:true,json:async()=>({ok:true,agents:1})};
 },now:NOW});
 assert.equal(probe.ok,true);
 assert.equal(probe.checkedAt,NOW);
 assert.equal(calls[0].method,'GET');
 assert.match(calls[0].url,/^http:\/\/127\.0\.0\.1:8971\/api\/status$/);
 assert.equal(calls[0].headers['X-MCPHub-Client'],'native');
 const failed=await readOnlyProbe('autosend',{fetchImpl:async()=>({ok:true,json:async()=>({ok:true,tasks:[
  {status:'paused',enabled:false},{status:'unknown',enabled:false,verification:{id:'x'}}
 ]})}),token:'a'.repeat(64),now:NOW});
 assert.equal(failed.ok,true);
 assert.equal(failed.unknownCount,1);assert.equal(failed.unresolvedCount,1);
 assert.equal(JSON.stringify(failed).includes('verification'),false);
});
test('MCP-06 runtime actually exposes the new health contract and bounded restart',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../app/runtime.cjs'),'utf8');
 assert.match(src,/buildHealthContract\(/);
 assert.match(src,/planSafeRestart\(/);
 assert.match(src,/autoSendStateSafety\(/);
 assert.match(src,/healthContract:/);
});

test('MCP-06 actual supervisor stops after 3 restarts; a user-paused state is never rearmed',()=>{
 const {Runtime}=require('../app/runtime.cjs');
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp06-runtime-'));
 try{
  const sup=new Runtime({resourceRoot:folder,userData:folder,nodeExecutable:process.execPath,
   credentials:async()=>null});
  sup.running=true;sup.report=()=>({});
  const record={state:'exited: 1',attempts:0,child:null,timer:null};
  sup.entries.set('terminal',record);
  let scheduled=0;
  for(let i=0;i<4;i++){
   sup.schedule('terminal',record);
   if(record.timer){scheduled++;clearTimeout(record.timer);record.timer=null;}
  }
  assert.equal(scheduled,3);
  assert.equal(record.state,'blocked: RETRY_BUDGET_EXHAUSTED');
  assert.equal(record.timer,null);
  const target=path.join(folder,'AutoSend');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'tasks.json'),JSON.stringify({
   version:1,tasks:[{status:'paused',enabled:false,verification:{stage:'click-committed'}}]}));
  const auto={state:'exited: 1',attempts:0,child:null,timer:null};
  sup.entries.set('autosend',auto);
  sup.schedule('autosend',auto);
  assert.equal(auto.timer,null);
  assert.equal(auto.state,'blocked: NEED_OWNER');
  assert.equal(sup.recoveryBudget['process:autosend']?.attempts?.length||0,0);
 }finally{fs.rmSync(folder,{recursive:true,force:true})}
});
