'use strict';
/**
 * MCP-06: passive, evidence-driven health and bounded recovery policy.
 * No token, chat URL, message text, PID or task IDs enter this contract.
 * All external probes are read-only and have fixed loopback destinations.
 */
const fs=require('node:fs');
const FRESH_MS=30000;
const HOUR_MS=3600000;
const MAX_RESTARTS=3;
const ISO=v=>Number.isFinite(v)&&v>0?new Date(v).toISOString():null;
const observed=(v,now)=>Number.isFinite(v)&&v>0&&v<=now&&now-v<=FRESH_MS;
const safeDate=(v,now)=>Number.isFinite(v)&&v>0&&v<=now?ISO(v):null;
const row=(status,reason,lastSeen,lastAttempt,nextSafeAction,now)=>({
 status,reason,lastSeen:safeDate(lastSeen,now),lastAttempt:safeDate(lastAttempt,now),nextSafeAction
});
function processFault(value){
 return typeof value==='string'&&(
  value.startsWith('exited:')||value.startsWith('error:')||
  value.startsWith('blocked:')||value==='stopped');
}
function buildHealthContract({processes={},connections={},probes={}}={},now=Date.now()){
 const components={};
 // PID/process presence alone never certifies MCP/tunnel/Chrome readiness.
 const terminal=connections.terminal,terminalAttempt=terminal?.checkedAt;
 if(processFault(processes.terminal))
  components.terminal=row('FAIL','SERVICE_STOPPED',null,terminalAttempt,'RECHECK',now);
 else if(processes.terminal!=='running'||!observed(terminalAttempt,now))
  components.terminal=row('UNKNOWN','HEALTH_NOT_VERIFIED',null,terminalAttempt,'RECHECK',now);
 else if(terminal.state==='ready'&&terminal.mcp===true&&terminal.tunnel==='ready')
  components.terminal=row('PASS','VERIFIED_MCP',terminalAttempt,terminalAttempt,'NONE',now);
 else if(['stopped','degraded','auth'].includes(terminal.state))
  components.terminal=row('FAIL',terminal.reason||'TERMINAL_UNHEALTHY',null,terminalAttempt,
   terminal.state==='auth'?'NEED_OWNER':'RECHECK',now);
 else components.terminal=row('UNKNOWN',terminal.reason||'TERMINAL_NOT_VERIFIED',
  null,terminalAttempt,'RECHECK',now);

 const browser=connections.browser,browserAttempt=browser?.checkedAt;
 if(processFault(processes.browser)||processFault(processes.proxy))
  components.chrome=row('FAIL','BROWSER_PROCESS_STOPPED',null,browserAttempt,'RECHECK',now);
 else if(processes.browser!=='running'||processes.proxy!=='running'||
         !observed(browserAttempt,now))
  components.chrome=row('UNKNOWN','BROWSER_NOT_VERIFIED',null,browserAttempt,'NEED_OWNER',now);
 else if(browser.state==='ready'&&browser.browser==='ready'&&
         observed(browser.lastBrowserAt,now))
  components.chrome=row('PASS','CHROME_EXTENSION_VERIFIED',
   browser.lastBrowserAt,browserAttempt,'NONE',now);
 else if(browser.state==='degraded'||browser.browser==='failed')
  components.chrome=row('FAIL',browser.reason||'BROWSER_CONNECTION_FAILED',
   null,browserAttempt,'NEED_OWNER',now);
 else components.chrome=row('UNKNOWN',browser.reason||'CHROME_NOT_CONFIRMED',
   null,browserAttempt,'NEED_OWNER',now);

 const hub=probes.hub,hubAttempt=hub?.checkedAt;
 if(processFault(processes.messaging))
  components.hub=row('FAIL','HUB_PROCESS_STOPPED',null,hubAttempt,'RECHECK',now);
 else if(processes.messaging!=='running'||!observed(hubAttempt,now))
  components.hub=row('UNKNOWN','HUB_NOT_VERIFIED',null,hubAttempt,'RECHECK',now);
 else if(hub.ok===true)
  components.hub=row('PASS','HUB_API_VERIFIED',hubAttempt,hubAttempt,'NONE',now);
 else components.hub=row('FAIL','HUB_API_UNAVAILABLE',null,hubAttempt,'RECHECK',now);

 const auto=probes.autosend,autoAttempt=auto?.checkedAt;
 if(processFault(processes.autosend))
  components.autosend=row('FAIL','AUTOSEND_PROCESS_STOPPED',null,autoAttempt,'RECHECK',now);
 else if(processes.autosend!=='running'||!observed(autoAttempt,now))
  components.autosend=row('UNKNOWN','AUTOSEND_NOT_VERIFIED',null,autoAttempt,'RECHECK',now);
 else if(auto.ok!==true)
  components.autosend=row('FAIL','AUTOSEND_API_UNAVAILABLE',null,autoAttempt,'RECHECK',now);
 else if((auto.unknownCount||0)>0||(auto.unresolvedCount||0)>0)
  components.autosend=row('UNKNOWN','UNRESOLVED_DELIVERY',
   autoAttempt,autoAttempt,'NEED_OWNER',now);
 else if((auto.pendingCount||0)>0)
  components.autosend=row('UNKNOWN','DELIVERY_IN_FLIGHT',
   autoAttempt,autoAttempt,'WAIT_RECEIPT',now);
 else if((auto.pausedCount||0)>0&&(auto.enabledCount||0)===0)
  components.autosend=row('PASS','OWNER_PAUSED',
   autoAttempt,autoAttempt,'KEEP_PAUSED',now);
 else components.autosend=row('PASS','AUTOSEND_API_VERIFIED',
   autoAttempt,autoAttempt,'NONE',now);
 return {version:1,checkedAt:ISO(now),components};
}
function planSafeRestart({service,owned=false,health='UNKNOWN',stateSafe=false,
 ownerPaused=false,inFlight=false,unknownReceipt=false,recentAttempts=[],now=Date.now()}={}){
 const safeService=['terminal','hub','autosend'].includes(service);
 if(!safeService||!owned||health!=='FAIL'||ownerPaused||inFlight||unknownReceipt||
    stateSafe!==true)
  return {action:'NONE',autoRestart:false,reason:'NOT_PROVEN_SAFE',nextSafeAction:'NEED_OWNER'};
 const count=Array.isArray(recentAttempts)?recentAttempts.filter(t=>Number.isFinite(t)&&
  t<=now&&now-t<HOUR_MS).length:MAX_RESTARTS;
 if(count>=MAX_RESTARTS)
  return {action:'NONE',autoRestart:false,reason:'RETRY_BUDGET_EXHAUSTED',nextSafeAction:'NEED_OWNER'};
 return {action:'RESTART_OWNED_SERVICE',autoRestart:true,reason:'SAFE_CRASH_RECOVERY',
  nextSafeAction:'RESTART_OWNED_SERVICE',attemptRemaining:MAX_RESTARTS-count};
}
/** A crashed AutoSend is only auto-startable if *every* stored task is
 * explicitly paused and there are no unresolved Send receipts or slots.
 * Fail closed on missing/corrupt, symlink or suspiciously large stores.
 */
function autoSendStateSafety(file){
 try{
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2000000)return {safe:false,reason:'STORE_NOT_TRUSTED'};
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  if(state?.version!==1||!Array.isArray(state.tasks)||state.tasks.length>500)
   return {safe:false,reason:'STATE_UNSUPPORTED'};
  for(const t of state.tasks){
   if(!t||t.enabled!==false||t.status!=='paused'||t.verification||
       t.active_slot_id||t.manual_once||t.next_at)
    return {safe:false,reason:'NEED_OWNER_OR_RECEIPT'};
  }
  return {safe:true,reason:'ALL_TASKS_OWNER_PAUSED'};
 }catch{return {safe:false,reason:'STATE_UNAVAILABLE'}}
}
/** Only fixed localhost GET endpoints; sensitive tasks are reduced to counts. */
async function readOnlyProbe(component,{fetchImpl=fetch,token=null,now=Date.now()}={}){
 const result={ok:false,checkedAt:now};
 if(!['hub','autosend'].includes(component))return result;
 if(component==='autosend'&&(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)))
  return result;
 const url=component==='hub'?'http://127.0.0.1:8971/api/status':
  'http://127.0.0.1:8972/api/status';
 const headers={'X-MCPHub-Client':'native'};
 if(component==='autosend')headers['X-MCPHub-Token']=token;
 try{
  const response=await fetchImpl(url,{method:'GET',headers,redirect:'error',
   signal:AbortSignal.timeout(1500)});
  if(!response?.ok)return result;
  const data=await response.json();
  if(data?.ok!==true)return result;
  if(component==='hub'){
   if(!Number.isSafeInteger(data.agents)||data.agents<0)return result;
   return {ok:true,checkedAt:now};
  }
  if(!Array.isArray(data.tasks)||data.tasks.length>500)return result;
  let pausedCount=0,enabledCount=0,pendingCount=0,unknownCount=0,unresolvedCount=0;
  for(const t of data.tasks){
   if(!t||typeof t.status!=='string'||typeof t.enabled!=='boolean')return result;
   if(t.status==='paused')pausedCount++;
   if(t.enabled)enabledCount++;
   if(['checking','sending','verifying'].includes(t.status))pendingCount++;
   if(t.status==='unknown')unknownCount++;
   if(t.verification||t.active_slot_id)unresolvedCount++;
  }
  return {ok:true,checkedAt:now,pausedCount,enabledCount,pendingCount,
   unknownCount,unresolvedCount};
 }catch{return result}
}
// Claim a recovery slot BEFORE retrying. Persist it across GUI restarts.
// Exclusive lock + fail-closed invalid state prevent unbounded crash loops.
const RESTART_SERVICES=Object.freeze(['terminal','messaging','autosend']);
function claimRestartAttempt(file,service,now=Date.now()){
 const blocked=reason=>({claimed:false,reason,nextSafeAction:'NEED_OWNER'});
 if(typeof file!=='string'||!file||!RESTART_SERVICES.includes(service)||
    !Number.isSafeInteger(now)||now<=0)return blocked('RESTART_BUDGET_UNAVAILABLE');
 let lock=null,temporary=null;
 try{
  const dir=require('node:path').dirname(file);
  const dirStat=fs.lstatSync(dir);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink())
   return blocked('RESTART_BUDGET_UNAVAILABLE');
  lock=fs.openSync(file+'.lock','wx',0o600);
  let attempts={};
  let stat=null;
  try{stat=fs.lstatSync(file)}catch(e){if(e.code!=='ENOENT')return blocked('RESTART_BUDGET_UNAVAILABLE')}
  if(stat){
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)
    return blocked('RESTART_BUDGET_UNAVAILABLE');
   const saved=JSON.parse(fs.readFileSync(file,'utf8'));
   if(!saved||saved.version!==1||!saved.attempts||
      typeof saved.attempts!=='object'||Array.isArray(saved.attempts)||
      Object.keys(saved).some(k=>!['version','attempts'].includes(k)))
    return blocked('RESTART_BUDGET_UNAVAILABLE');
   for(const [name,values] of Object.entries(saved.attempts)){
    if(!RESTART_SERVICES.includes(name)||!Array.isArray(values)||
       values.length>MAX_RESTARTS||!values.every((x,i)=>Number.isSafeInteger(x)&&
        x>0&&x<=now&&(i===0||x>=values[i-1])))
     return blocked('RESTART_BUDGET_UNAVAILABLE');
    attempts[name]=values.filter(x=>now-x<HOUR_MS);
   }
  }
  const old=attempts[service]||[];
  if(old.length>=MAX_RESTARTS)return blocked('RETRY_BUDGET_EXHAUSTED');
  attempts[service]=[...old,now];
  const next=JSON.stringify({version:1,attempts})+'\n';
  temporary=file+'.'+require('node:crypto').randomUUID()+'.tmp';
  const descriptor=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(descriptor,next);fs.fsyncSync(descriptor)}
  finally{fs.closeSync(descriptor)}
  fs.renameSync(temporary,file);
  temporary=null;
  return {claimed:true,reason:'PERSISTED_RESTART_SLOT',
   nextSafeAction:'RESTART_OWNED_SERVICE',attemptRemaining:MAX_RESTARTS-old.length-1};
 }catch{return blocked('RESTART_BUDGET_UNAVAILABLE')}
 finally{
  if(temporary){try{fs.unlinkSync(temporary)}catch{}}
  if(lock!==null){
   try{fs.closeSync(lock)}catch{}
   try{fs.unlinkSync(file+'.lock')}catch{}
  }
 }
}
module.exports={buildHealthContract,planSafeRestart,autoSendStateSafety,
 readOnlyProbe,claimRestartAttempt,FRESH_MS,MAX_RESTARTS};
