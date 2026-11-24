'use strict';
// Shared, passive, fail-closed connection state for macOS and Windows.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const FRESH_MS=30000, BROWSER_FRESH_MS=300000;
const fresh=(at,now,ttl=FRESH_MS)=>Number.isFinite(at)&&at<=now&&now-at<=ttl;
function browserEvidence(telemetry,now=Date.now(),failedAt=null){
  if(!telemetry)return {state:'unknown',reason:'BROWSER_TELEMETRY_UNAVAILABLE',lastConnectedAt:null};
  const last=Date.parse(telemetry.lastConnectedAt||'');
  if(Number.isFinite(failedAt)&&(!Number.isFinite(last)||last<=failedAt))return {state:'failed',reason:'BROWSER_CONNECTION_FAILED',lastConnectedAt:Number.isFinite(last)?last:null};
  if(telemetry.browser==='degraded'||telemetry.transport==='unavailable')
    return {state:'failed',reason:'BROWSER_CONNECTION_FAILED',lastConnectedAt:Number.isFinite(last)?last:null};
  if(telemetry.browser==='connected'&&fresh(last,now,BROWSER_FRESH_MS))
    return {state:'ready',reason:null,lastConnectedAt:last};
  return {state:'unknown',reason:'BROWSER_NOT_RECENTLY_VERIFIED',lastConnectedAt:Number.isFinite(last)?last:null};
}
function evaluate({running,mcp,tunnel,browser,checkedAt,lastCallAt},now=Date.now()){
  const current=fresh(checkedAt,now);
  let state='ready',reason=null;
  if(!running){state='stopped';reason='SERVICE_STOPPED'}
  else if(!current){state='unknown';reason='HEALTH_STALE'}
  else if(mcp!==true){state='degraded';reason='LOCAL_MCP_UNAVAILABLE'}
  else if(tunnel!=='ready'){state=tunnel==='auth'?'auth':tunnel==='unmonitored'?'unknown':'degraded';reason='TUNNEL_'+String(tunnel||'UNKNOWN').toUpperCase()}
  else if(browser&&browser.state!=='ready'){state=browser.state==='failed'?'degraded':'unknown';reason=browser.reason}
  return {state,reason,checkedAt:checkedAt||null,mcp:current&&mcp===true,tunnel:current?tunnel||'unknown':'unknown',
    browser:browser?current?browser.state:'unknown':null,lastBrowserAt:browser?.lastConnectedAt??null,
    lastCallAt:Number.isFinite(lastCallAt)?lastCallAt:null,
    // A local MCP tool call cannot prove which ChatGPT conversation invoked it.
    chatgpt:'unverified'};
}
async function probeMcp(url,required,fetchImpl=fetch){
  try{
    const parsed=new URL(url);
    if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password)return false;
    const protocol='2026-07-28';
    for(const method of ['server/discover','tools/list']){
      const params={_meta:{'io.modelcontextprotocol/protocolVersion':protocol,
        'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'McpGo-Readiness',version:'1.0.0'}}};
      const res=await fetchImpl(url,{method:'POST',redirect:'error',headers:{
        'content-type':'application/json','accept':'application/json, text/event-stream',
        'mcp-protocol-version':protocol,'mcp-method':method},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
        signal:AbortSignal.timeout(4000)});
      if(!res.ok)return false;
      const txt=await res.text();
      const reply=JSON.parse(txt.trim().startsWith('{')?txt:txt.split(/\r?\n/).find(x=>x.startsWith('data: '))?.slice(6));
      if(reply.error||reply.result?.resultType!=='complete')return false;
      if(method==='server/discover'&&!reply.result.supportedVersions?.includes(protocol))return false;
      if(method==='tools/list'&&(!required.every(name=>reply.result.tools?.some(t=>t.name===name))||
        (required.includes('browser_tabs')&&reply.result.tools?.some(t=>t.name==='browser_run_code_unsafe'))))return false;
    }
    return true;
  }catch{return false}
}
async function readTelemetry(url,fetchImpl=fetch){
  try{
    const r=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(1500)});
    return r.ok?await r.json():null;
  }catch{return null}
}
async function tunnelHealth(file,fetchImpl=fetch){
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2048)return 'unmonitored';
    if(process.platform!=='win32'&&(stat.mode&0o077)!==0)return 'unmonitored';
    const url=new URL(fs.readFileSync(file,'utf8').trim());
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return 'unmonitored';
    const live=await fetchImpl(url.origin+'/healthz',{redirect:'error',signal:AbortSignal.timeout(2500)});
    if(live.status===401||live.status===403)return 'auth';
    if(live.status===429)return 'throttled';
    if(live.status!==200)return 'down';
    const ready=await fetchImpl(url.origin+'/readyz',{redirect:'error',signal:AbortSignal.timeout(2500)});
    return ready.status===200?'ready':ready.status===401||ready.status===403?'auth':ready.status===429?'throttled':'starting';
  }catch(e){return e?.code==='ENOENT'?'unmonitored':'down'}
}
// Only write state transitions and fixed codes. Bounded and atomic, no URL/token/tool args.
class HealthHistory {
  constructor(file){this.file=file;this.events=[];this.previous={};try{
    const st=fs.lstatSync(file);
    if(st.isFile()&&!st.isSymbolicLink()&&st.size<262144){
      const old=JSON.parse(fs.readFileSync(file,'utf8'));
      if(Array.isArray(old))this.events=old.filter(e=>e&&['terminal','browser'].includes(e.channel)&&
        ['ready','stopped','degraded','unknown','auth'].includes(e.state)&&Number.isFinite(e.at)&&
        (e.reason===null||typeof e.reason==='string'&&/^[A-Z_]{1,64}$/.test(e.reason))).slice(-200);
    }
  }catch{}}
  observe(channel,value,now=Date.now()){
    if(!['terminal','browser'].includes(channel))return;
    const state=value.state,reason=value.reason||null,key=state+':'+reason;
    if(this.previous[channel]===key)return;
    this.previous[channel]=key;
    this.events.push({channel,state,reason,at:now});this.events=this.events.slice(-200);
    let tmp;
    try{
      const dir=path.dirname(this.file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
      if(fs.lstatSync(dir).isSymbolicLink())return;
      tmp=this.file+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';
      fs.writeFileSync(tmp,JSON.stringify(this.events)+'\n',{flag:'wx',mode:0o600});
      fs.renameSync(tmp,this.file);
    }catch{}finally{if(tmp)try{fs.unlinkSync(tmp)}catch{}}
  }
  snapshot(){return this.events.slice(-20)}
}
module.exports={evaluate,browserEvidence,fresh,probeMcp,tunnelHealth,readTelemetry,HealthHistory,FRESH_MS,BROWSER_FRESH_MS};
