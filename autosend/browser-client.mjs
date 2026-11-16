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
const DEFAULT_URL='http://127.0.0.1:8932/mcp';
const ACCEPT='application/json, text/event-stream';
const PROTOCOL='2025-03-26';

function decode(text){
 if(text.trimStart().startsWith('{'))return JSON.parse(text);
 for(const line of text.split(/\r?\n/)){
  if(line.startsWith('data:')){
   try{return JSON.parse(line.slice(5).trim())}catch{}
  }
 }
 throw Error('Official Playwright MCP returned unreadable JSON-RPC');
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
  const text=await response.text();
  if(method==='notifications/initialized')return null;
  return decode(text);
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
