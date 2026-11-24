import {sameChatGPTConversation} from './chatgpt-url.mjs';
import {McpSseResultReader,responseMessage,transformMcpResponse} from './mcp-response.mjs';
import {BrowserActionQueue} from './browser-queue.mjs';
import {PAGE_INSPECT_TOOL,planPageInspection,lowAccessibilitySignal,visualSnapshotArgs} from './page-inspection.mjs';
import {validateToolProfile,filterTools} from './tool-profiles.mjs';
import http from 'node:http';
import {ActionGuard,isMutatingTool,ACTION_STATUS_TOOL} from './action-guard.mjs';
import {BrowserSessionManager,SHARED_CLIENT,BrowserReconnectError} from './browser-session-manager.mjs';
import {validTabIndex,parseTabIndices} from './tab-lease-manager.mjs';
import {PortableAgentTabs} from './portable-agent-tabs.mjs';
import {AgentScopeRegistry,validScopeHint} from './agent-scope.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {BrowserWorkspaceRegistry} from './browser-workspace.mjs';
import {attachWorkspace,withWorkspaceToolSchema} from './workspace-response.mjs';
import {MODERN_PROTOCOL,validateModernRequest,normalizedConversationHint,
  modernizeMessage,discoverResult,stripModernParams} from './mcp-modern-protocol.mjs';

const MODE = process.argv[2] || 'shared';
if (MODE !== 'shared') throw Error('Only the official Playwright Extension shared browser is supported');
// ChatGPT's existing installed MCPGO Browser plugin still invokes the 2025
// envelope (verified with a real browser_tabs tool, not a synthetic client).
// Temporarily negotiate both wire protocols until the existing plugin is
// refreshed. New clients get 2026; MCPGO_DISABLE_LEGACY=1 cuts over strictly.
const LEGACY_TEST_MODE=process.env.NODE_ENV==='test' && process.env.MCPGO_LEGACY_TEST_ONLY==='1';
const LEGACY_COMPAT=LEGACY_TEST_MODE||process.env.MCPGO_DISABLE_LEGACY!=='1';
const [LISTEN_PORT,BACKEND_PORT] = [Number(process.env.MCPGO_PROXY_PORT||8940),Number(process.env.MCPGO_BACKEND_PORT||8931)];
const TOOL_PROFILE=validateToolProfile(process.env.MCPGO_BROWSER_TOOL_PROFILE||'full');
const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
// Reuse one backend MCP session for all short-lived client connections.
// Preserve the Extension backend across transient MCP transport reconnects;
// re-attaching Chrome for each tool call disrupts browser continuity.
let sharedSessionId = null;
let cachedInit = null;
let initPayload = null;
let initVersion = '2025-03-26';
let initInFlight = null;
const actionGuard=new ActionGuard();
const browserSession=new BrowserSessionManager();
const agentTabs=new PortableAgentTabs();
const tabLeases=agentTabs.leases;
const agentScopes=new AgentScopeRegistry();
const workspaces=new BrowserWorkspaceRegistry();
// Only pseudonymous diagnostic aliases leave the proxy. Never log URLs,
// browser content, workspace capabilities, conversation IDs or auth tokens.
const scopeAlias=agent=>agent?
  createHash('sha256').update(agent).digest('hex').slice(0,10):'unbound';
function ownershipConflict(owner,caller,{mode='unknown',tool='unknown'}={}){
  const message='TAB_OWNED_BY_ANOTHER_AGENT owner_scope='+scopeAlias(owner)+
    ' requester_scope='+scopeAlias(caller)+' reason=workspace_mismatch'+
    ' (reuse workspace_id from YOUR previous browser result; reassignment denied)';
  console.warn('[McpGo ownership denied] owner_scope='+scopeAlias(owner)+
    ' requester_scope='+scopeAlias(caller)+' scope_mode='+mode+
    ' tool='+String(tool).replace(/[^A-Za-z0-9_-]/g,'').slice(0,50));
  return message;
}

// No identifiers, arguments, URLs, or tokens are logged. Count wire formats only.
const observedWireCalls={modern:0,legacy:0};
// Short privacy-safe failure history. No URLs, DOM, request bodies, user text,
// image captures, token values or workspace identifiers are ever stored here.
const recentFailures=[];
function noteFailure(status,reason){
 const code=String(reason||'').match(/^([A-Z][A-Z0-9_]{3,63})(?:\b|:)/)?.[1]||'HTTP_'+status;
 recentFailures.push({at:new Date().toISOString(),status,code});
 if(recentFailures.length>20)recentFailures.shift();
}
const upstreamCounts={catalog:0,tabLists:0,total:0};
const latencyBuckets=Object.create(null);
const responseSizes=Object.create(null);
function recordResponseSize(type,bytes){
 const bucket=responseSizes[type]??=[];bucket.push(bytes);
 if(bucket.length>500)bucket.shift();
}
function recordLatency(type,total,queue){
 const bucket=latencyBuckets[type]??={total:[],queue:[]};
 bucket.total.push(total);bucket.queue.push(queue);
 if(bucket.total.length>500){bucket.total.shift();bucket.queue.shift();}
}
const quantile=(samples,p)=>samples.length?([...samples].sort((a,b)=>a-b)[Math.ceil(samples.length*p)-1]??0):null;
const performanceStatus=()=>({upstream:{...upstreamCounts},commands:Object.fromEntries(
 Object.entries(latencyBuckets).map(([type,b])=>[type,{count:b.total.length,
  medianMs:quantile(b.total,0.5),p95Ms:quantile(b.total,0.95),
  queueMedianMs:quantile(b.queue,0.5),queueP95Ms:quantile(b.queue,0.95),
  responseMedianBytes:quantile(responseSizes[type]||[],0.5),
  responseP95Bytes:quantile(responseSizes[type]||[],0.95)}]))});
const sessionInfo=()=>({...browserSession.status(),...agentTabs.status(),...agentScopes.status(),...workspaces.status(),browserQueue:browserQueueStatus(),performance:performanceStatus(),recentFailures:[...recentFailures],
  publicProtocol:MODERN_PROTOCOL,legacyExternal:LEGACY_COMPAT,
  observedWireCalls:{...observedWireCalls},toolProfile:TOOL_PROFILE});
const BACKEND_INIT={jsonrpc:'2.0',id:'mcpgo-private-backend-init',method:'initialize',
  params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:SHARED_CLIENT,version:'1.0.0'}}};
const LOCAL_TOOL_NAMES=new Set(['mcpgo_workspace','mcpgo_agent_status','mcpgo_browser_status','mcpgo_action_status']);
let backendNotifiedSid=null,privateReadyInFlight=null;
async function ensurePrivatePlaywright(){
  try{await initializeOnce(BACKEND_INIT,'2025-03-26');}
  catch(e){browserSession.recordBrowserEvent('transport_unavailable');throw e;}
  const sid=sharedSessionId;
  if(backendNotifiedSid===sid)return;
  if(privateReadyInFlight)return privateReadyInFlight;
  const task=(async()=>{
    const ready=await upstreamRequest({jsonrpc:'2.0',method:'notifications/initialized'},
      {'mcp-session-id':sid},'POST',12000);
    if(![200,202,204].includes(ready.status))throw Error('Private Playwright notification failed');
    backendNotifiedSid=sid;
  })();
  privateReadyInFlight=task;
  try{await task;}
  catch(e){expireSession(sid);throw e;}
  finally{if(privateReadyInFlight===task)privateReadyInFlight=null;}
}

// A shared Chrome context is not safe for simultaneous browser tool calls:
// one client can otherwise change the active tab while another is clicking.
// Never retain an abandoned browser waiter. Previous promise-tail chaining
// kept timed-out/closed callers in the queue, starving AutoSend for minutes.
const browserQueue=new BrowserActionQueue({
 waitMs:process.env.NODE_ENV==='test'?Number(process.env.MCPGO_TEST_QUEUE_WAIT_MS||12000):12000
});
const browserQueueStatus=()=>browserQueue.status();
const acquireBrowserLock=opts=>browserQueue.acquire(opts);

// Always scope requests to the upstream session. Do not leak downstream
// session IDs from different MCP clients into the shared Chrome backend.
function upstreamRequest(payload, headers={}, method='POST', timeout=12000) {
  return new Promise((resolve,reject) => {
    const data=Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));
    let requestId=null,metric='upstream:other';
    const upstreamStarted=Date.now();
    try{
      const requested=JSON.parse(data.toString('utf8'));
      metric=requested.method==='tools/call'
        ?'upstream:'+(requested.params?.name==='browser_tabs'
            ?'tabs:'+(requested.params?.arguments?.action||'unknown')
            :String(requested.params?.name||'unknown').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40))
        :'upstream:'+String(requested.method||'other').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,30);
      requestId=requested.id??null;
      upstreamCounts.total++;
      if(requested.method==='tools/list')upstreamCounts.catalog++;
      if(requested.method==='tools/call'&&requested.params?.name==='browser_tabs'&&
        requested.params?.arguments?.action==='list')upstreamCounts.tabLists++;
    }catch{}
    let finished=false,deadline;
    const settle=(err,result)=>{
      if(finished)return;
      finished=true;clearTimeout(deadline);
      recordLatency(metric,Date.now()-upstreamStarted,0);
      if(result?.body)recordResponseSize(metric,result.body.length);
      if(err)reject(err);else resolve(result);
    };
    const request=http.request({hostname:'127.0.0.1',port:BACKEND_PORT,path:'/mcp',
      method,timeout,headers:{host:'localhost:'+BACKEND_PORT,
        accept:'application/json, text/event-stream','content-type':'application/json',
        'mcp-protocol-version':initVersion,...headers,
        ...(method==='POST'?{'content-length':String(data.length)}:{})}},up=>{
      const parts=[];let size=0;
      const sse=/\btext\/event-stream\b/i.test(String(up.headers['content-type']||''));
      const reader=sse&&requestId!==null?new McpSseResultReader(requestId):null;
      up.on('data',chunk=>{
        if(finished)return;
        size+=chunk.length;
        if(size>MAX_RESPONSE){up.destroy(Error('MCP response too large'));return;}
        parts.push(chunk);
        if(!reader)return;
        const complete=reader.push(chunk);
        if(complete){
          settle(null,{status:up.statusCode||502,headers:up.headers,
            body:complete.body,message:complete.message});
          up.destroy();return;
        }
      });
      up.on('end',()=>{
        if(reader)return settle(Error('MCP backend closed before matching complete SSE result'));
        const body=Buffer.concat(parts),status=up.statusCode||502;
        let message=null;
        try{if(status===200&&requestId!==null)
          message=responseMessage(body,up.headers['content-type'],requestId);
        }catch(e){return settle(e);}
        settle(null,{status,headers:up.headers,body,message});
      });
      up.on('error',err=>settle(err));
      up.on('close',()=>{if(!finished)settle(Error('MCP backend closed before final response'));});
    });
    // Node's socket timeout measures inactivity, NOT wall-clock duration.
    // An SSE heartbeat can keep it alive forever. Enforce an absolute deadline.
    deadline=setTimeout(()=>request.destroy(Error('MCP backend wall-clock timeout')),timeout);
    deadline.unref?.();
    request.on('timeout',()=>request.destroy(Error('MCP backend inactivity timeout')));
    request.on('error',err=>settle(err));
    request.end(method==='POST'?data:undefined);
  });
}
function expireSession(expected=sharedSessionId){
  // Do not erase a newer session while another concurrent request finishes.
  if (expected!==sharedSessionId) return;
  sharedSessionId=null;
  cachedInit=null;
  if(browserSession.status().mcp!=='unavailable')browserSession.markMcpUnavailable();
  agentTabs.reset();
}
async function initializeOnce(payload,protocolVersion){
  if(cachedInit && sharedSessionId)return cachedInit;
  if(initInFlight)return initInFlight;
  // The proxy is the single owner of the upstream browser. Keep its identity
  // stable even if ChatGPT, AutoSend, Dashboard, or other clients reconnect.
  const stablePayload={...payload,params:{...payload.params,
    clientInfo:{name:SHARED_CLIENT,version:'1.0.0'}}};
  initPayload=stablePayload;
  initVersion=protocolVersion||'2025-03-26';
  const pending=(async()=>{
    const response=await upstreamRequest(stablePayload,{},'POST',16000);
    const sid=response.headers['mcp-session-id'];
    if(response.status!==200||typeof sid!=='string'||!sid.length)
      throw Error('MCP initialize unsuccessful ('+response.status+')');
    sharedSessionId=sid;
    cachedInit=response.body.toString('utf8');
    browserSession.markMcpReady();
    return cachedInit;
  })();
  initInFlight=pending;
  try{return await pending;}finally{if(initInFlight===pending)initInFlight=null;}
}
function isExpired(response){
  return response.status===404 && /Session not found/i.test(response.body.toString('utf8'));
}
// Revalidate on each downstream initialize, because backend can restart while
// this proxy remains alive. One tools/list is a read-only liveness probe.
async function ensureValidInitialize(payload,protocolVersion){
  if(sharedSessionId&&cachedInit){
    const previous=sharedSessionId;
    try{
      const check=await upstreamRequest({jsonrpc:'2.0',id:'session-health',method:'tools/list'},
        {'mcp-session-id':previous});
      if(check.status===200)return cachedInit;
      if(!isExpired(check))throw Error('MCP health failed ('+check.status+')');
      expireSession(previous);
    }catch(e){
      if(sharedSessionId===previous&&!/Session not found/.test(e.message))throw e;
    }
  }
  return initializeOnce(payload,protocolVersion);
}
function safeToRetry(payload){
  // Never re-run a potentially modifying browser tool after an unknown outcome.
  return payload?.method==='notifications/initialized'||payload?.method==='tools/list'||
    (payload?.method==='tools/call' && payload?.params?.name==='browser_tabs' &&
      payload?.params?.arguments?.action==='list');
}
async function ensureSessionAfterExpiry(payload,oldSession){
  expireSession(oldSession);
  if(!initPayload)throw Error('No initialization payload available');
  await initializeOnce(initPayload,initVersion);
  const newSession=sharedSessionId;
  if(payload?.method!=='notifications/initialized'){
    const ready=await upstreamRequest({jsonrpc:'2.0',method:'notifications/initialized'},
      {'mcp-session-id':newSession});
    if(ready.status!==200&&ready.status!==202&&ready.status!==204)throw Error('MCP session initialization notification failed');
  }
  return newSession;
}
const rewriteJsonRpcId=(raw,id)=>transformMcpResponse(raw,
  raw.trimStart().startsWith('{')?'application/json':'text/event-stream',
  message=>Object.hasOwn(message,'id')?{...message,id}:message).toString();

const WORKSPACE_TOOL={
  name:'mcpgo_workspace',
  description:'Get or resume the current McpGo browser workspace. Reuse workspace_id from a previous browser tool result when ChatGPT starts a fresh MCP session. An explicit workspace ID is a recovery locator, NOT a substitute for MCP authorization.',
  inputSchema:{type:'object',properties:{workspace_id:{type:'string',description:'Optional workspace_id from a prior browser result to resume the same tabs.'}},additionalProperties:false}
};
const TAB_LEASE_TOOL={
  name:'mcpgo_tab_lease',
  description:'Cooperative tab ownership for local multi-agent clients. Requires x-mcpgo-agent-id header: action claim, release or inspect. The browser is contacted only on explicit claim. Not a security boundary against a malicious local client.',
  inputSchema:{type:'object',properties:{
    action:{type:'string',enum:['claim','release','inspect']},
    index:{type:'integer',minimum:0}
  },required:['action'],additionalProperties:false}
};
const AGENT_SCOPE_STATUS_TOOL={
  name:'mcpgo_agent_status',
  description:'Read-only status of the current client scope: legacy, MCP transport session, or stable external conversation. Does not open Chrome or disclose IDs, URLs, tokens or other agents.',
  inputSchema:{type:'object',properties:{},additionalProperties:false}
};
const STABLE_TAB_ACTION_TOOL={
  name:'mcpgo_tab_action',
  description:'Select or close an identified browser tab using an opaque tab_id, not a stale numeric index. The proxy resolves and checks ownership against a fresh Chrome tabs list under the browser lock. Works with Chrome and Edge on macOS/Windows.',
  inputSchema:{type:'object',properties:{
    action:{type:'string',enum:['select','close']},tab_id:{type:'string'}
  },required:['action','tab_id'],additionalProperties:false}
};
const TAB_HANDLE_TOOL={
  name:'mcpgo_tab_handle',
  description:'Return opaque tab IDs safe across numeric index changes when URL identity is unique. Use action list, claim, resolve, or release. For ambiguous duplicate URLs refuse rather than operate on another tab.',
  inputSchema:{type:'object',properties:{
    action:{type:'string',enum:['list','claim','resolve','release']},
    tab_id:{type:'string'}
  },required:['action'],additionalProperties:false}
};
const SESSION_STATUS_TOOL={
  name:'mcpgo_browser_status',
  description:'Read-only McpGo browser session diagnostics. Never contacts Chrome, creates tabs, or opens a Playwright extension connection. Browser state is last observed by a real tool, not a background probe.',
  inputSchema:{type:'object',properties:{},additionalProperties:false}
};
const UNSAFE = new Set(['browser_run_code_unsafe','browser_close']);

const inspectCall = payload => {
  const entries = Array.isArray(payload) ? payload : [payload];
  for (const entry of entries) {
    if (entry?.method !== 'tools/call') continue;
    const name = entry?.params?.name;
    if (typeof name !== 'string' || UNSAFE.has(name)) return 'Unsafe or missing tool name';
    const args = entry.params?.arguments || {};
    if(entries.length>1 && isMutatingTool(name,args))
      return 'Mutating browser actions must be submitted one at a time';
  }
  return null;
};
const isToolsList = payload => (Array.isArray(payload) ? payload : [payload]).some(x => x?.method === 'tools/list');
const stripTools = (message,{requireWorkspace=false}={}) => {
  if (!message || typeof message !== 'object') return message;
  if (Array.isArray(message)) return message.map(item=>stripTools(item,{requireWorkspace}));
  if (Array.isArray(message.result?.tools)) {
    message.result.tools = message.result.tools.filter(t => !UNSAFE.has(t.name)).map(t=>withWorkspaceToolSchema(t,{requireWorkspace}));
    if(!message.result.tools.some(t=>t.name===ACTION_STATUS_TOOL.name))message.result.tools.push(ACTION_STATUS_TOOL);
    if(!message.result.tools.some(t=>t.name===SESSION_STATUS_TOOL.name))message.result.tools.push(SESSION_STATUS_TOOL);
    if(!message.result.tools.some(t=>t.name===TAB_LEASE_TOOL.name))message.result.tools.push(TAB_LEASE_TOOL);
    if(!message.result.tools.some(t=>t.name===TAB_HANDLE_TOOL.name))message.result.tools.push(TAB_HANDLE_TOOL);
    if(!message.result.tools.some(t=>t.name===STABLE_TAB_ACTION_TOOL.name))message.result.tools.push(STABLE_TAB_ACTION_TOOL);
    if(!message.result.tools.some(t=>t.name===AGENT_SCOPE_STATUS_TOOL.name))message.result.tools.push(AGENT_SCOPE_STATUS_TOOL);
    if(!message.result.tools.some(t=>t.name===WORKSPACE_TOOL.name))message.result.tools.push(WORKSPACE_TOOL);
    if(!message.result.tools.some(t=>t.name===PAGE_INSPECT_TOOL.name))message.result.tools.push(PAGE_INSPECT_TOOL);
    message.result.tools=filterTools(message.result.tools,TOOL_PROFILE).map(t=>withWorkspaceToolSchema(t,{requireWorkspace}));
  }
  return message;
};
const error = (res, status, reason, id = null, rpcCode=null) => {
  noteFailure(status,reason);
  const body = JSON.stringify({jsonrpc:'2.0', id,
    error:{code:rpcCode??(status===403 ? -32601 : -32600),message:reason}});
  res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'});
  res.end(body);
};
/** A page-scoped modifying action must target the exact active tab.
 * Read the current URL inside the same serialized critical section immediately
 * before dispatching a browser action. Fail closed if Playwright cannot prove it.
 */
function extractMcpToolText(response){
 const message=response.message??responseMessage(response.body,response.headers?.['content-type']);
 return (message?.result?.content||[]).filter(c=>c?.type==='text').map(c=>c.text||'').join('\n');
}
function parseActiveUrl(response){
 if(response.status!==200)return null;
 try{
  const content=extractMcpToolText(response);
  const section=content.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
  const raw=(section?.[1]||content).trim();
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const value=JSON.parse((fenced?.[1]||raw).trim());
  return typeof value?.url==='string'?value.url:null;
 }catch{return null}
}
// Read the live tab index table only when the user explicitly requests a
// tab lease or an agent is working with leased tabs. Never used by healthz.
async function tabSnapshot(headers,{track=true,deadlineAt=Infinity}={}){
  const started=Date.now();
  try{
  browserSession.beforeBrowserCall();
  let response;
  try{
    response=await upstreamRequest({jsonrpc:'2.0',id:'mcpgo-tab-lease-read',
      method:'tools/call',params:{name:'browser_tabs',arguments:{action:'list'}}},headers,'POST',
      Math.max(1,Math.min(12000,deadlineAt-Date.now())));
    browserSession.recordBrowserResult(response);
  }catch(e){
    // A previous tab inspection may still be running on the shared active tab.
    // Do not admit another command until a controlled backend restart.
    browserSession.recordBrowserEvent('outcome_unknown');
    browserQueue.quarantine();
    throw e;
  }
  if(response.status!==200 || browserTransportFailedFromTabList(response))return null;
  const text=extractMcpToolText(response);
  if(!text.includes('### Result'))return null;
  if(!track)return {...parseTabIndices(text),text};
  const snapshot=agentTabs.refresh(text);
  return {...parseTabIndices(text),view:snapshot,currentHandle:snapshot.current,text};
  }finally{recordLatency('stage_tab_verification',Date.now()-started,0);}
}
function browserTransportFailedFromTabList(response){
  try{const text=extractMcpToolText(response);
    return /extension did not connect|browser (?:has been )?closed/i.test(text);
  }catch{return true}
}
const sendLocalTool=(res,id,value,clientSid=sharedSessionId,workspaceId=null)=>{
  const result=attachWorkspace({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value},workspaceId);
  const message={jsonrpc:'2.0',id,result};
  const body=Buffer.from(JSON.stringify(res.mcpModern?modernizeMessage(message):message));
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store',
    ...(!res.mcpModern?{'mcp-session-id':clientSid}:{}),'content-length':String(body.length)});
  res.end(body);
};
async function verifyActiveUrl(headers,expected,deadlineAt=Infinity){
 let answer;
 try{answer=await upstreamRequest({jsonrpc:'2.0',id:'mcpgo-scope-check',method:'tools/call',
  params:{name:'browser_evaluate',arguments:{function:'() => ({url: location.href})'}}},headers,'POST',
  Math.max(1,Math.min(12000,deadlineAt-Date.now())));
 }catch(e){
  browserSession.recordBrowserEvent('outcome_unknown');
  browserQueue.quarantine();
  throw e;
 }
 const active=parseActiveUrl(answer);
 return active===expected||sameChatGPTConversation(active,expected);
}

const server = http.createServer(async (req,res) => {
  const requestReceivedAt=Date.now();
  const reqHost = String(req.headers.host || '').toLowerCase();
  if (!['localhost:'+LISTEN_PORT,'127.0.0.1:'+LISTEN_PORT].includes(reqHost)) return error(res,403,'Host forbidden');
  // Unique inert first page for newly-created tabs. The official Playwright
  // MCP rejects navigation to about:blank#... and cannot distinguish several
  // about:blank tabs by URL. This loopback page works on macOS and Windows,
  // leaks no credentials and runs no scripts or remote requests.
  if(req.method==='GET' && /^\/mcpgo-blank\/[a-f0-9-]{36}$/.test(req.url)){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store','content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
    return res.end('<!doctype html><meta charset="utf-8"><title>Новая вкладка McpGo</title>');
  }
  if(req.url==='/healthz' && req.method==='GET'){
    // Passive telemetry: NO MCP initialize, tools/list, or browser tool call.
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify(sessionInfo()));
  }
  if (req.url !== '/mcp') return error(res,404,'Only /mcp is exposed');
  if (req.method!=='POST' && !LEGACY_COMPAT)return error(res,405,'MCP 2026-07-28 accepts POST only');
  if (!['GET','POST','DELETE'].includes(req.method)) return error(res,405,'Method forbidden');
  // The proxy accepts authenticated MCP traffic over the local tunnel, not
  // script-initiated requests from arbitrary websites opened in personal Chrome.
  // Reject browser simple requests even when they contain syntactically valid
  // JSON; no CORS headers are emitted for third-party origins.
  const allowedOrigin=new Set([`http://127.0.0.1:${LISTEN_PORT}`,`http://localhost:${LISTEN_PORT}`]);
  if(req.headers.origin && !allowedOrigin.has(req.headers.origin))
    return error(res,403,'Cross-origin browser request refused');
  if(req.method==='POST' && !/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type']||'')))
    return error(res,415,'MCP requests must use application/json');

  const chunks = [];
  let count = 0;
  try {
    for await (const part of req) {
      count += part.length;
      if (count > MAX_BODY) return error(res,413,'MCP request too large');
      chunks.push(part);
    }
    const body = Buffer.concat(chunks);
    let data = null;
    if (req.method === 'POST') {
      try { data = JSON.parse(body.toString('utf8')); }
      catch { return error(res,400,'Invalid MCP JSON'); }
      const reason = inspectCall(data);
      if (reason) return error(res,403,reason,data?.id ?? null);
    }
    const modernEnvelope=!LEGACY_TEST_MODE && (req.headers['mcp-method']!==undefined ||
      req.headers['mcp-protocol-version']==='2026-07-28' ||
      data?.method==='server/discover' ||
      data?.params?._meta?.['io.modelcontextprotocol/protocolVersion']!==undefined);
    res.mcpModern=modernEnvelope;
    if(data?.method==='tools/call')observedWireCalls[modernEnvelope?'modern':'legacy']++;
    if(!modernEnvelope&&!LEGACY_COMPAT)
      return error(res,400,'Unsupported MCP protocol; only 2026-07-28 is exposed',data?.id??null,-32022);
    if(modernEnvelope){
      const problem=validateModernRequest(req.headers,data);
      if(problem)return error(res,400,problem.message,data?.id??null,problem.code);
      if(data.method==='server/discover'){
        const message={jsonrpc:'2.0',id:data.id,result:discoverResult()};
        const result=Buffer.from(JSON.stringify(message));
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store',
          'content-length':String(result.length)});
        return res.end(result);
      }
    }
    // Transport identities are generated per downstream MCP session. A stable
    // externally supplied agent/conversation ID survives reconnects; never
    // guess a user chat from clientInfo.name (multiple chats share that name).
    const hint=req.headers['x-mcpgo-agent-id']??req.headers['x-mcpgo-conversation-id'];
    if(hint!==undefined&&!validScopeHint(hint))return error(res,400,'Invalid agent/conversation scope',data?.id??null);
    if(req.headers['x-mcpgo-agent-id']&&req.headers['x-mcpgo-conversation-id']&&
       req.headers['x-mcpgo-agent-id']!==req.headers['x-mcpgo-conversation-id'])
      return error(res,409,'AGENT_IDENTITY_CONFLICT',data?.id??null);
    // A fresh ChatGPT connection may share an upstream Chrome session, but
    // we must verify it actually still exists before advertising readiness.
    if(!res.mcpModern&&req.method==='POST'&&data?.method==='initialize'){
      try{
        const initial=await ensureValidInitialize(data,req.headers['mcp-protocol-version']);
        const result=rewriteJsonRpcId(initial,data.id);
        const transport=agentScopes.create(req.headers);
        res.writeHead(200,{'content-type':initial.trim().startsWith('{')?'application/json':'text/event-stream',
          'mcp-session-id':transport.sessionId,'cache-control':'no-store'});
        return res.end(result);
      }catch{
        return error(res,502,'Shared MCP initialization failed');
      }
    }
    if(!res.mcpModern&&req.method==='DELETE'){
      // Do not tear down the shared browser session on client disconnect.
      agentScopes.remove(req.headers);
      res.writeHead(200,{'cache-control':'no-store'});return res.end();
    }
    let scope;
    if(res.mcpModern){
      const hint=normalizedConversationHint(req.headers,data?.params?._meta);
      if(hint){
        // openai/session may be per-request, not per ChatGPT conversation.
        // Only an explicit x-mcpgo-* header is an immutable stable scope.
        const explicitStable=!!(req.headers['x-mcpgo-agent-id']||
          req.headers['x-mcpgo-conversation-id']);
        const scopeHeaders={...req.headers,
          'x-mcpgo-conversation-id':req.headers['x-mcpgo-conversation-id']||hint};
        scope=agentScopes.resolve(scopeHeaders);
        if(!explicitStable&&!scope.error)scope={...scope,mode:'observed'};
      }else{
        const requested=data?.params?.arguments?.workspace_id;
        const known=requested?workspaces.lookup(requested):null;
        scope=known?{agent:known.agent,mode:'workspace',sessionId:null}
          : data?.params?.name==='mcpgo_workspace'&&!requested
            ?{agent:'agent-'+randomUUID(),mode:'workspace',sessionId:null}
            :{agent:null,mode:'stateless',sessionId:null};
      }
      if(data.method==='tools/list'||(data.method==='tools/call' &&
        !LOCAL_TOOL_NAMES.has(data.params?.name))){
        const initStarted=Date.now();
        try{await ensurePrivatePlaywright()}
        catch{return error(res,502,'Private Playwright initialization unavailable',data.id)}
        finally{recordLatency('stage_session_prepare',Date.now()-initStarted,0)}
      }
    }else{
      scope=req.headers['mcp-session-id']===sharedSessionId
        ? {agent:null,mode:'legacy',sessionId:null}
        : agentScopes.resolve(req.headers);
    }
    if(scope.error)return scope.error==='MCPGO_SESSION_EXPIRED'
      ? error(res,404,'Session not found',data?.id??null)
      : error(res,409,scope.error,data?.id??null);
    const clientSid=res.mcpModern?null:(scope.sessionId||sharedSessionId);
    if(!sharedSessionId&&!res.mcpModern)return error(res,503,'MCP session not initialized');
    if(res.mcpModern&&data.method==='tools/call'&&!scope.agent&&
       !['mcpgo_browser_status','mcpgo_action_status'].includes(data.params.name))
      return error(res,409,'WORKSPACE_ID_REQUIRED: call mcpgo_workspace first and reuse workspace_id',data.id);
    const isToolRequest=req.method==='POST'&&data?.method==='tools/call';
    let workspaceId=null,workspaceWasResumed=false;
    if(isToolRequest){
      const argumentsValue=data.params?.arguments||{};
      if(!argumentsValue||typeof argumentsValue!=='object'||Array.isArray(argumentsValue))
        return error(res,400,'Invalid browser tool arguments',data?.id??null);
      const requested=argumentsValue.workspace_id;
      if(requested!==undefined && typeof requested!=='string')
        return error(res,400,'Invalid workspace_id',data?.id??null);
      // Never silently create a new identity because openai/session rotated.
      // The agent must carry its workspace capability across all tool calls.
      if(res.mcpModern&&scope.mode==='observed'&&!requested&&
         data.params?.name!==WORKSPACE_TOOL.name&&
         !['mcpgo_browser_status','mcpgo_action_status'].includes(data.params?.name))
        return error(res,409,'WORKSPACE_ID_REQUIRED: openai/session is not a stable conversation identity; call mcpgo_workspace once and pass workspace_id in every subsequent browser tool call',data.id);
      const result=workspaces.resolve(scope.agent,scope.mode,requested,
        {hasOwnedTabs:!!scope.agent&&agentTabs.owned(scope.agent).length>0});
      if(result.error)return error(res,409,result.error,data?.id??null);
      if(result.resumed){
        if(res.mcpModern){
          scope={agent:result.agent,mode:'workspace',sessionId:null};
        }else{
          const adopted=agentScopes.adoptWorkspace(req.headers,result.agent);
          if(adopted.error)return error(res,409,adopted.error,data?.id??null);
          workspaces.adopt(result.oldAgent,result.agent);
          scope=adopted;
        }
      }
      workspaceId=result.workspaceId;
      workspaceWasResumed=!!result.resumed;
    }
    if(isToolRequest&&data.params?.name===WORKSPACE_TOOL.name){
      return sendLocalTool(res,data.id,{workspace_id:workspaceId,
        resumed:workspaceWasResumed,
        mode:scope.mode,ownedTabs:scope.agent?agentTabs.owned(scope.agent).length:0},
        clientSid,workspaceId);
    }
    if(req.method==='POST'&&data?.method==='tools/call'&&data.params?.name===AGENT_SCOPE_STATUS_TOOL.name){
      return sendLocalTool(res,data.id,{
        mode:scope.mode,automaticIsolation:!!scope.agent,
        survivesMcpReconnect:scope.mode==='stable',
        ownedTabs:scope.agent?agentTabs.owned(scope.agent).length:0,
        requiresStableScopeForReconnect:false,
        requiresWorkspaceIdAfterReconnect:scope.mode!=='stable',
      },clientSid,workspaceId);
    }
    if(req.method==='POST'&&data?.method==='tools/call'&&data.params?.name===SESSION_STATUS_TOOL.name){
      return sendLocalTool(res,data.id,sessionInfo(),clientSid,workspaceId);
    }
    if(req.method==='POST'&&data?.method==='tools/call'&&data.params?.name===ACTION_STATUS_TOOL.name){
      try{
       const value=actionGuard.lookup(data.params.arguments?.request_id);
       return sendLocalTool(res,data.id,value,clientSid,workspaceId);
      }catch{return error(res,400,'Invalid browser action receipt ID',data?.id??null);}
    }
    const isTabLeaseCall=req.method==='POST'&&data?.method==='tools/call'&&data.params?.name===TAB_LEASE_TOOL.name;
    const isTabHandleCall=req.method==='POST'&&data?.method==='tools/call'&&data.params?.name===TAB_HANDLE_TOOL.name;
    const isStableTabAction=req.method==='POST'&&data?.method==='tools/call'&&data.params?.name===STABLE_TAB_ACTION_TOOL.name;
    const isBrowserCall=req.method==='POST'&&data?.method==='tools/call'&&!isTabLeaseCall&&!isTabHandleCall;
    let unlock=null;
    const waitingSince=Date.now();let queueWait=0;
    const metricType=data?.params?.name==='mcpgo_tab_action' ?
      data.params.arguments?.action : data?.params?.name==='browser_tabs' ?
      data.params.arguments?.action : data?.params?.name?.replace(/^browser_/, '')||'other';
    // One wall-clock budget, including queue wait and tab verification.
    const deadlineAt=requestReceivedAt+Number(process.env.MCPGO_BROWSER_ACTION_BUDGET_MS||60000);
    const remaining=()=>Math.max(0,deadlineAt-Date.now());
    const lockAbort=new AbortController();
    res.once('close',()=>lockAbort.abort());
    try{
     if(isBrowserCall||isTabLeaseCall||isTabHandleCall)
      unlock=await acquireBrowserLock({signal:lockAbort.signal,
       budgetMs:remaining(),
       priority:typeof scope.agent==='string'&&scope.agent.startsWith('autosend-')});
      queueWait=Date.now()-waitingSince;
    }catch(e){
     if(res.destroyed)return;
     return error(res,e.message==='BROWSER_ACTION_OUTCOME_UNKNOWN'?503:429,
      e.message==='BROWSER_ACTION_OUTCOME_UNKNOWN'?
        'BROWSER_ACTION_OUTCOME_UNKNOWN: shared Chrome queue quarantined; no replay':
      e.message==='BROWSER_QUEUE_CLIENT_GONE'?'Browser client disconnected before dispatch':
      e.message==='BROWSER_QUEUE_WAIT_TIMEOUT'?'Browser action queue wait timed out':
        'Browser action queue full',data?.id??null);
    }
    try {
     // Never dispatch queued actions after the requesting client vanished.
     if(res.destroyed||remaining()===0)
       return error(res,429,'Browser action deadline exceeded before dispatch',data?.id??null);
     const name=data?.params?.name;
     const dispatchData=res.mcpModern?stripModernParams(data):data;
     // workspace_id belongs to our proxy, not the upstream Playwright schema.
     const {workspace_id:_workspaceHandle,...args}=data?.params?.arguments||{};
     const agent=scope.agent;
     const mutating=isBrowserCall&&isMutatingTool(name,args);
     const actionId=req.headers['x-mcpgo-action-id'];
     if(actionId && !mutating)return error(res,400,'Action ID is only valid for a modifying browser tool',data?.id??null);
    const oldSession=sharedSessionId;
    const headers={'mcp-session-id':oldSession,'mcp-protocol-version':initVersion};
    if(isTabHandleCall){
      if(!agent)return error(res,400,'Agent scope required',data?.id??null);
      if(args.action==='release')return sendLocalTool(res,data.id,agentTabs.release(agent,args.tab_id),clientSid,workspaceId);
      try{
        const snapshot=await tabSnapshot(headers,{deadlineAt});
        if(!snapshot)return error(res,503,'Chrome tabs cannot be inspected',data?.id??null);
        if(args.action==='list')return sendLocalTool(res,data.id,agentTabs.list(agent),clientSid,workspaceId);
        if(args.action==='resolve'){
          const item=agentTabs.identities.resolve(args.tab_id);
          if(!item)return error(res,409,'TAB_HANDLE_STALE_OR_AMBIGUOUS',data?.id??null);
          const owner=agentTabs.owner(args.tab_id);
          if(owner&&owner!==agent)return error(res,409,ownershipConflict(owner,agent,{mode:scope.mode,tool:name}),data?.id??null);
          return sendLocalTool(res,data.id,{tab_id:item.id,index_hint:item.index,current:item.current},clientSid,workspaceId);
        }
        if(args.action==='claim'){
          const value=agentTabs.claim(agent,args.tab_id);
          if(!value.ok)return error(res,409,value.reason,data?.id??null);
          return sendLocalTool(res,data.id,value,clientSid,workspaceId);
        }
        return error(res,400,'Unknown stable tab handle action',data?.id??null);
      }catch(e){return error(res,503,e instanceof BrowserReconnectError?e.code:'Tab handle inspection failed',data?.id??null);}
    }
    if(isTabLeaseCall){
      if(!agent)return error(res,400,'Tab lease requires x-mcpgo-agent-id',data?.id??null);
      const operation=args.action,index=args.index;
      if(operation==='inspect')return sendLocalTool(res,data.id,{
        ...agentTabs.status(),ownedTabIds:agentTabs.owned(agent)},clientSid,workspaceId);
      if(!validTabIndex(index)||!['claim','release'].includes(operation))
        return error(res,400,'Invalid tab lease request',data?.id??null);
      try{
        const snapshot=await tabSnapshot(headers,{deadlineAt});
        if(!snapshot)return error(res,503,'Cannot verify Chrome tabs for lease',data?.id??null);
        const tabId=agentTabs.byIndex(index);
        if(!tabId)return error(res,409,'TAB_HANDLE_STALE_OR_AMBIGUOUS',data?.id??null);
        const value=operation==='release'?agentTabs.release(agent,tabId):agentTabs.claim(agent,tabId);
        if(!value.ok)return error(res,409,value.reason,data?.id??null);
        return sendLocalTool(res,data.id,value,clientSid,workspaceId);
      }catch(e){return error(res,503,e instanceof BrowserReconnectError?e.code:'Tab lease check unavailable',data?.id??null);}
    }
    let effectiveName=name,effectiveArgs=args,inspectPlan=null,precheckedTabs=null,forwardedBody=Buffer.from(JSON.stringify({
      ...dispatchData,params:{...dispatchData.params,arguments:args}}));
    if(name===PAGE_INSPECT_TOOL.name){
      try{inspectPlan=planPageInspection(args);}
      catch(e){return error(res,400,e.message,data?.id??null)}
      effectiveName=inspectPlan.tool;effectiveArgs=inspectPlan.args;
      forwardedBody=Buffer.from(JSON.stringify({...dispatchData,params:{...dispatchData.params,
        name:effectiveName,arguments:effectiveArgs}}));
    }
    if(isStableTabAction){
      if(!agent || !['select','close'].includes(args.action))
        return error(res,400,'Stable tab action requires an agent and select/close',data?.id??null);
      try{
        const fresh=await tabSnapshot(headers,{deadlineAt});
        if(!fresh)return error(res,503,'Cannot resolve stable tab handle',data?.id??null);
        precheckedTabs=fresh; // Same serialized request: reuse this verified index map.
        const entry=agentTabs.identities.resolve(args.tab_id);
        if(!entry)return error(res,409,'TAB_HANDLE_STALE_OR_AMBIGUOUS',data?.id??null);
        const owner=agentTabs.owner(args.tab_id);
        if(owner&&owner!==agent)return error(res,409,ownershipConflict(owner,agent,{mode:scope.mode,tool:name}),data?.id??null);
        if(args.action==='close'&&owner!==agent)return error(res,409,'TAB_LEASE_REQUIRED',data?.id??null);
        effectiveName='browser_tabs';effectiveArgs={action:args.action,index:entry.index};
        forwardedBody=Buffer.from(JSON.stringify({...dispatchData,params:{...dispatchData.params,
          name:effectiveName,arguments:effectiveArgs}}));
      }catch(e){return error(res,503,e instanceof BrowserReconnectError?e.code:'Tab handle resolution failed',data?.id??null);}
    }
    let tabs=effectiveName==='browser_tabs' ? effectiveArgs : null;
    if(tabs?.action==='new'&&(!tabs.url||tabs.url==='about:blank')){
      // Populate the blank page URL BEFORE Playwright creates the tab: no
      // follow-up navigate call, no duplicate about:blank target ambiguity.
      tabs={...tabs,url:`http://127.0.0.1:${LISTEN_PORT}/mcpgo-blank/${randomUUID()}`};
      effectiveArgs=tabs;
      forwardedBody=Buffer.from(JSON.stringify({...dispatchData,params:{...dispatchData.params,
        name:effectiveName,arguments:effectiveArgs}}));
    }
    let preTab=null,preTabIndex=null;
    if(req.method==='POST'&&['select','close'].includes(tabs?.action)&&Number.isInteger(tabs?.index)){
      const before=agentTabs.byIndex(tabs.index);
      const fresh=precheckedTabs??await tabSnapshot(headers,{deadlineAt});
      if(!fresh)return error(res,503,'Cannot verify tab index before action',data?.id??null);
      preTab=agentTabs.byIndex(tabs.index);preTabIndex=tabs.index;
      if(before&&preTab!==before)return error(res,409,'TAB_INDEX_CHANGED_USE_STABLE_ID',data?.id??null);
    }
    // All tab checks occur in the same serialized browser action queue.
    if(tabs&&['select','close'].includes(tabs.action)){
      if(!validTabIndex(tabs.index))return error(res,400,'Invalid tab index',data?.id??null);
      if(!preTab)return error(res,409,'TAB_HANDLE_STALE_OR_AMBIGUOUS',data?.id??null);
      const owner=agentTabs.owner(preTab);
      if(owner&&owner!==agent)return error(res,409,ownershipConflict(owner,agent,{mode:scope.mode,tool:name}),data?.id??null);
      if(tabs.action==='close'&&agent&&!owner)return error(res,409,'TAB_LEASE_REQUIRED',data?.id??null);
    }
    if(isBrowserCall&&effectiveName!=='browser_tabs'&&(agent||tabLeases.count())){
      try{
        let snapshot=await tabSnapshot(headers,{deadlineAt});
        if(!snapshot)
          return error(res,503,'Chrome tabs cannot be inspected',data?.id??null);
        const owned=agentTabs.resolveOwned(agent);
        // The active tab may be ambiguous (e.g. several other agents opened
        // the same ChatGPT conversation). That must not prevent an agent with
        // a DIFFERENT, uniquely identified owned tab from restoring its own
        // tab under the serialized browser lock. Never guess the ambiguous
        // current tab's identity or send actions to it.
        if(owned && owned.id!==snapshot.currentHandle){
          const select=await upstreamRequest({jsonrpc:'2.0',id:'mcpgo-agent-select',method:'tools/call',
            params:{name:'browser_tabs',arguments:{action:'select',index:owned.index}}},headers,'POST',12000);
          if(select.status!==200)return error(res,503,'Could not restore agent tab',data?.id??null);
          snapshot=await tabSnapshot(headers,{deadlineAt});
          if(!snapshot||snapshot.currentHandle!==owned.id)
            return error(res,409,'Agent tab changed during selection',data?.id??null);
        }
        if(!snapshot.currentHandle)
          return error(res,503,'Current tab identity cannot be verified',data?.id??null);
        const decision=agentTabs.allowed(agent,snapshot.currentHandle);
        if(!decision.ok)return error(res,409,
          decision.reason==='TAB_OWNED_BY_ANOTHER_AGENT'?
            ownershipConflict(agentTabs.owner(snapshot.currentHandle),agent,{mode:scope.mode,tool:name}):
            decision.reason,data?.id??null);
        if(agent && !agentTabs.owner(snapshot.currentHandle)){
          const claimed=agentTabs.claim(agent,snapshot.currentHandle);
          if(!claimed.ok)return error(res,409,claimed.reason,data?.id??null);
        }
        preTab=snapshot.currentHandle;
        preTabIndex=agentTabs.identities.resolve(preTab)?.index??null;
      }catch(e){return error(res,503,e instanceof BrowserReconnectError?e.code:'Agent tab verification unavailable',data?.id??null);}
    }
    const expected=req.headers['x-mcpgo-expected-url'];
    if(expected){
     if(!mutating||typeof expected!=='string'||expected.length>2048)
      return error(res,400,'Invalid browser action URL guard',data?.id??null);
     let url;
     try{url=new URL(expected)}catch{return error(res,400,'Invalid expected URL',data?.id??null)}
     if(!['https:','http:'].includes(url.protocol) || url.href!==expected)
      return error(res,400,'Expected URL must be a canonical HTTP(S) URL',data?.id??null);
     let same=false;
     try{same=await verifyActiveUrl(headers,expected,deadlineAt)}catch{}
     if(!same)return error(res,409,'Active Chrome tab does not match expected URL. No action dispatched.',data?.id??null);
    }
     if(actionId){
      if(typeof actionId!=='string')return error(res,400,'Invalid action ID',data?.id??null);
      let receipt;
      try{receipt=actionGuard.claim(actionId,name,args)}
      catch{return error(res,400,'Invalid browser action ID or receipt store',data?.id??null)}
      if(!receipt.claimed)
       return error(res,409,'Browser action already dispatched or unknown. Use mcpgo_action_status; never replay.',data?.id??null);
     }
    if(isBrowserCall){
      try{browserSession.beforeBrowserCall();}
      catch(e){
        if(e instanceof BrowserReconnectError) return error(res,503,e.code,data?.id??null);
        throw e;
      }
    }
    // Never dispatch a modifying tool if its owner already disconnected or
    // the end-to-end action budget has been consumed by tab prechecks.
    if(res.destroyed||remaining()===0)
      return error(res,429,'Browser action expired or client disconnected before dispatch',data?.id??null);
    let upstream;
    const executionStarted=Date.now();
    try{upstream=await upstreamRequest(forwardedBody,headers,req.method,
      Math.max(1,Math.min(data?.method==='tools/call'?40000:12000,remaining())))}
    catch(e){
      if(actionId)actionGuard.finish(actionId,'unknown',null);
      // Even a read-only upstream request can still be operating on the
      // shared active tab after its HTTP response is lost. Fail closed until
      // a controlled backend restart rather than overlap a later click.
      if(isBrowserCall||isTabHandleCall||isTabLeaseCall){
        browserSession.recordBrowserEvent('outcome_unknown');
        browserQueue.quarantine();
        return error(res,503,'BROWSER_ACTION_OUTCOME_UNKNOWN: no replay; restart controlled browser session after verifying outcome',data?.id??null);
      }
      throw e;
    }finally{recordLatency('stage_execution',Date.now()-executionStarted,0)}
    // Explicit visual requests pair a scoped accessibility tree with a small
    // WebP viewport screenshot. Auto mode only requests an image when enabled
    // by the caller AND the DOM snapshot/find has inadequate signal.
    if(inspectPlan&&upstream.status===200&&inspectPlan.visualFallback&&
       (inspectPlan.kind==='visual'||lowAccessibilitySignal(upstream.message)) &&
       !upstream.message?.error&&!upstream.message?.result?.isError){
      const first=upstream.message;
      if(res.destroyed||remaining()===0)
        return error(res,429,'Page inspection deadline reached before visual fallback',data?.id??null);
      try{
        const imageReply=await upstreamRequest({jsonrpc:'2.0',id:'mcpgo-inspect-visual',
          method:'tools/call',params:{name:'browser_take_screenshot',arguments:visualSnapshotArgs()}},
          headers,'POST',Math.max(1,Math.min(20000,remaining())));
        if(imageReply.status===200&&!imageReply.message?.error&&!imageReply.message?.result?.isError){
          const composed={...first,result:{...first.result,
            content:[...(first.result.content||[]),...(imageReply.message.result.content||[])]}};
          upstream={...upstream,headers:{...upstream.headers,'content-type':'application/json'},
            body:Buffer.from(JSON.stringify(composed)),message:composed};
        }else{
          const failed={...first,result:{...first.result,isError:true,
            content:[...(first.result.content||[]),{type:'text',text:'Visual inspection unavailable; no screenshot was confirmed.'}]}};
          upstream={...upstream,headers:{...upstream.headers,'content-type':'application/json'},
            body:Buffer.from(JSON.stringify(failed)),message:failed};
        }
      }catch(e){
        // A screenshot can still be using the active tab after the connection
        // disappears. Never dispatch another browser action while uncertain.
        browserSession.recordBrowserEvent('outcome_unknown');
        browserQueue.quarantine();
        return error(res,503,'BROWSER_ACTION_OUTCOME_UNKNOWN: visual fallback interrupted',data?.id??null);
      }
    }
    if(actionId)actionGuard.finish(actionId,upstream.status===200?'completed':'unknown',upstream.status);
    if(isBrowserCall)browserSession.recordBrowserResult(upstream);
    if(isBrowserCall&&upstream.status===200&&!browserTransportFailedFromTabList(upstream)){
      if(tabs?.action==='list')agentTabs.refresh(extractMcpToolText(upstream));
      if(tabs?.action==='select'&&agent&&preTab)agentTabs.claim(agent,preTab);
      if(tabs?.action==='close'&&preTab){
        if(agent)agentTabs.release(agent,preTab);
        try{await tabSnapshot(headers,{deadlineAt});}catch{} // already closed; do not replay
      }
      if(tabs?.action==='new'){
        try{
          const created=await tabSnapshot(headers,{deadlineAt});
          if(agent&&created?.currentHandle)agentTabs.claim(agent,created.currentHandle);
        }catch{} // already opened; never repeat an uncertain tab creation
      }
      if(effectiveName!=='browser_tabs'&&isMutatingTool(name,args)&&agent&&preTab&&preTabIndex!==null){
        try{
          // Navigation changes a URL fingerprint. Rebind the old opaque ID
          // only when the same selected index can be proved after navigation.
          const fresh=await tabSnapshot(headers,{track:false,deadlineAt});
          if(fresh)agentTabs.explicitNavigation(agent,preTab,preTabIndex,fresh.text);
        }catch{} // action may already have committed; next list will fail closed
      }
    }
    if(isExpired(upstream)){
      expireSession(oldSession);
      if(req.method!=='POST'||!safeToRetry(data))
        return error(res,409,'MCP session expired; action not replayed. Reconnect and verify outcome.',data?.id??null);
      try{
        const sid=await ensureSessionAfterExpiry(data,oldSession);
        upstream=await upstreamRequest(forwardedBody,{'mcp-session-id':sid},req.method,data?.method==='tools/call'?40000:12000);
        if(isBrowserCall)browserSession.recordBrowserResult(upstream);
      }catch{return error(res,502,'MCP session recovery failed',data?.id??null);}
    }
    if(isExpired(upstream)){
      expireSession(sharedSessionId);
      return error(res,503,'MCP session expired during recovery',data?.id??null);
    }
    if(isToolsList(data)&&upstream.status===200){
      try{
        const sourceType=String(upstream.headers['content-type']||'application/json');
        // One parse, one transform, one serialization per outbound response.
        const output=transformMcpResponse(upstream.body,sourceType,message=>{
          const filtered=stripTools(message,{requireWorkspace:res.mcpModern});
          return res.mcpModern?modernizeMessage(filtered,{cache:true}):filtered;
        });
        res.writeHead(200,{'content-type':sourceType,
          ...(!res.mcpModern?{'mcp-session-id':clientSid}:{}),
          'content-length':String(output.length),'cache-control':'no-store'});
        return res.end(output);
      }catch{return error(res,502,'Failed to sanitize tools/list response',data?.id??null);}
    }
    let responseBody=upstream.body;
    if(upstream.status===200&&((isToolRequest&&workspaceId)||res.mcpModern)){
      try{
        responseBody=transformMcpResponse(upstream.body,
          String(upstream.headers['content-type']||'application/json'),message=>{
            const decorated=isToolRequest&&workspaceId&&Array.isArray(message?.result?.content)
              ? {...message,result:attachWorkspace(message.result,workspaceId)}:message;
            return res.mcpModern?modernizeMessage(decorated):decorated;
          });
      }catch{return error(res,502,'Could not transform upstream tool result',data?.id??null);}
    }
    const responseHeaders={...upstream.headers,
      ...(!res.mcpModern?{'mcp-session-id':clientSid}:{}),
      'content-length':String(responseBody.length),'cache-control':'no-store'};
    if(res.mcpModern)delete responseHeaders['mcp-session-id'];
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders['content-encoding'];
    res.writeHead(upstream.status,responseHeaders);
    res.end(responseBody);
    }finally{
      if(unlock){recordLatency(metricType,Date.now()-waitingSince,queueWait);unlock();}
    }
  } catch {
    if (!res.writableEnded) error(res,502,'MCP backend request failed or timed out');
  }
});
server.listen(LISTEN_PORT,'127.0.0.1',()=>{
  console.log('Safe Playwright MCP proxy at http://localhost:' + LISTEN_PORT + '/mcp');
  console.log('Serializes shared-browser tool calls; optional durable write receipts; unsafe arbitrary code blocked');
});
