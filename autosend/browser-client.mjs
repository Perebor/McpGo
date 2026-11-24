/**
 * Single long-lived MCP connection to the dedicated Playwright Extension
 * backend (MCPGO AutoSend group, localhost:8932).
 *
 * Deliberately NOT the general-purpose Browser MCP proxy. The scheduler has
 * no access to the other agents' tabs and does not create/navigate/close tabs.
 * The official backend uses MCP 2025-03-26 on its PRIVATE port; external
 * ChatGPT clients continue to use the modern public proxy on port 8940.
 *
 * No user text, URLs or browser output are logged.
 */
import {McpSseResultReader,isSse,responseMessage} from '../playwright/mcp-response.mjs';

const DEFAULT_URL='http://127.0.0.1:8932/mcp';
const ACCEPT='application/json, text/event-stream';
const PROTOCOL='2025-03-26';

async function readReply(response,requestId){
 const type=response.headers?.get?.('content-type')||'application/json';
 if(isSse(type)&&response.body?.getReader){
  const stream=response.body.getReader(),decoder=new McpSseResultReader(requestId);
  let receivedBytes=0;
  try{
   while(true){
    const {done,value}=await stream.read();
    if(done)throw Error('Official Playwright MCP closed before a matching complete response');
    receivedBytes+=value.byteLength;
    if(receivedBytes>8*1024*1024)throw Error('Official Playwright MCP response exceeded 8MB');
    const reply=decoder.push(value);
    if(reply)return reply.message;
   }
  }finally{
   // A compliant SSE backend can keep streaming heartbeats after the result.
   // Stop reading immediately, releasing the private client for its next call.
   try{await stream.cancel()}catch{}
   try{stream.releaseLock()}catch{}
  }
 }
 return responseMessage(await response.text(),type,requestId);
}
function contentOf(reply){
 if(reply?.error)throw Error('Playwright MCP: '+String(reply.error.message||'transport error').slice(0,220));
 if(reply?.result?.isError)throw Error('Playwright: '+(reply.result.content||[]).map(c=>c.text||'').join(' ').slice(0,220));
 if(!Array.isArray(reply?.result?.content))throw Error('Invalid Playwright tool response');
 return reply.result.content.map(c=>c.text||'').join('\n');
}
export class ExtensionMcpClient {
 constructor(url=DEFAULT_URL,fetcher=fetch){
  const endpoint=new URL(url);
  if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost'].includes(endpoint.hostname)||
     endpoint.pathname!=='/mcp'||endpoint.search||endpoint.hash)
   throw Error('AutoSend browser must use a loopback MCP endpoint');
  this.url=url;this.fetcher=fetcher;this.session='';this.initialized=false;this.id=0;this.initPromise=null;
 }
 async request(method,params=undefined){
  const body={jsonrpc:'2.0',method};
  if(method!=='notifications/initialized')body.id=++this.id;
  if(params!==undefined)body.params=params;
  const headers={'accept':ACCEPT,'content-type':'application/json',
   'mcp-protocol-version':PROTOCOL};
  if(this.session)headers['mcp-session-id']=this.session;
  const response=await this.fetcher(this.url,{method:'POST',headers,body:JSON.stringify(body),
   signal:AbortSignal.timeout(35000)});
  if(response.status===404){this.session='';this.initialized=false;throw Error('Playwright MCP session expired');}
  const sid=response.headers?.get?.('mcp-session-id');
  if(sid&&/^[A-Za-z0-9._-]{8,256}$/.test(sid))this.session=sid;
  if(!response.ok)throw Error('Playwright MCP HTTP '+response.status);
  if(method==='notifications/initialized')return null;
  return readReply(response,body.id);
 }
 async connect(){
  if(this.initialized&&this.session)return;
  if(!this.initPromise){
   this.initPromise=(async()=>{
    try{
     const init=await this.request('initialize',{protocolVersion:PROTOCOL,capabilities:{},
      clientInfo:{name:'MCPGO AutoSend',version:'2.0.0'}});
     if(!init?.result?.serverInfo)throw Error('Official Playwright MCP initialization failed');
     await this.request('notifications/initialized');
     this.initialized=true;
    }catch(e){
     this.initialized=false;this.session='';
     throw e;
    }
   })().finally(()=>{this.initPromise=null;});
  }
  return this.initPromise;
 }
 async tool(name,args={}){
  await this.connect();
  // Retrying an ambiguous MCP tool after HTTP failure is forbidden. A next
  // scheduled slot may connect afresh; an unknown click remains unreplayable.
  return contentOf(await this.request('tools/call',{name,arguments:args}));
 }
 async listTools(){
  await this.connect();
  return (await this.request('tools/list'))?.result?.tools||[];
 }
 async close(){/* Shared process-owned session; disposing per task would force reconnects. */}
}
let instance;
export function autosendMcp(){
 return instance||(instance=new ExtensionMcpClient(process.env.MCPHUB_AUTOSEND_BROWSER_MCP_URL||DEFAULT_URL));
}
