import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {modernHeaders,modernParams} from '../mcp-modern-protocol.mjs';
// General browser proxy test client, distinct from the dedicated AutoSend
// extension backend. This verifies browser queue isolation without importing
// scheduler code.
class ProxyTestClient{
 constructor(url,fetcher,scope){this.url=url;this.fetcher=fetcher;this.scope=scope;this.id=0;}
 async request(method,params={}){
  const args=modernParams(params,'McpGo Browser Test');
  const req={jsonrpc:'2.0',id:++this.id,method,params:args};
  const response=await this.fetcher(this.url,{method:'POST',headers:{
   ...modernHeaders(method,args),'x-mcpgo-conversation-id':this.scope
  },body:JSON.stringify(req)});
  if(!response.ok)throw Error('MCP HTTP '+response.status);
  const body=await response.text();
  const line=body.trimStart().startsWith('{')?body:body.split(/\r?\n/).find(v=>v.startsWith('data: '))?.slice(6);
  const parsed=JSON.parse(line);
  if(parsed.error)throw Error(parsed.error.message);
  return parsed;
 }
 async connect(){await this.request('server/discover');}
 async tool(name,args){
  const result=await this.request('tools/call',{name,arguments:args});
  return (result.result?.content||[]).map(c=>c.text||'').join('\n');
 }
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const respond=(res,id,result)=>{
 res.writeHead(200,{'content-type':'application/json','mcp-session-id':'backend-test'});
 res.end(JSON.stringify({jsonrpc:'2.0',id,result}));
};
async function listen(server){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return server.address().port;
}
test('stalled browser calls do not retain dead queue entries or hide saturation from healthz',
 {timeout:15000},async()=>{
 const backend=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  const data=JSON.parse(body||'{}');
  if(data.method==='initialize')return respond(res,data.id,{protocolVersion:'2025-03-26',serverInfo:{name:'Fake Playwright'},capabilities:{tools:{}}});
  if(data.method==='notifications/initialized'){res.writeHead(202);return res.end();}
  if(data.method==='tools/call'){
   await delay(650);
   return respond(res,data.id,{content:[{type:'text',text:'### Result\n- 0: (current) [Home](https://chatgpt.com/)'}]});
  }
  return respond(res,data.id,{tools:[{name:'browser_tabs'}]});
 });
 const backendPort=await listen(backend);
 const reserved=http.createServer();const proxyPort=await listen(reserved);
 await new Promise(resolve=>reserved.close(resolve));
 const proxy=spawn(process.execPath,[fileURLToPath(new URL('../restricted-proxy.mjs',import.meta.url)),'shared'],{
  env:{...process.env,NODE_ENV:'test',MCPGO_TEST_QUEUE_WAIT_MS:'120',
   MCPGO_PROXY_PORT:String(proxyPort),MCPGO_BACKEND_PORT:String(backendPort)},
  stdio:['ignore','pipe','pipe']});
 try{
  const healthUrl=`http://127.0.0.1:${proxyPort}/healthz`;
  for(let i=0;i<60;i++){
   try {const r=await fetch(healthUrl);if(r.ok)break;}catch{}
   await delay(25);
  }
  const mcp=new ProxyTestClient(`http://127.0.0.1:${proxyPort}/mcp`,fetch,'autosend-queue-test');
  await mcp.connect();
  const calls=Array.from({length:22},async()=>{
   try{await mcp.tool('browser_tabs',{action:'list'});return 'ok';}
   catch(e){return /HTTP 429/.test(e.message)?'busy':'other';}
  });
  let activeHealth;
  for(let i=0;i<12;i++){
   activeHealth=await (await fetch(healthUrl)).json();
   if(activeHealth.browserQueue.waiting>0)break;
   await delay(25);
  }
  assert.ok(activeHealth.browserQueue.waiting>0,'health reports browser lock queue depth');
  const outcomes=await Promise.all(calls);
  assert.ok(outcomes.includes('busy'),'full/expired calls get an explicit bounded error');
  assert.ok(outcomes.includes('ok'),'original call finishes');
  await delay(60);
  const finalHealth=await (await fetch(healthUrl)).json();
  assert.equal(finalHealth.browserQueue.waiting,0,'abandoned queue waiters are removed');
  const final=await mcp.tool('browser_tabs',{action:'list'});
  assert.match(final,/### Result/,'queue still serves following browser tools');
 } finally {
  proxy.kill('SIGTERM');
  backend.closeAllConnections?.();await new Promise(resolve=>backend.close(resolve));
 }
});

test('SSE final JSON-RPC result releases the browser lock even if heartbeat stream stays open',
 {timeout:9000},async()=>{
 const backend=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  const data=JSON.parse(body||'{}');
  if(data.method==='initialize')return respond(res,data.id,{protocolVersion:'2025-03-26',serverInfo:{name:'Fake Playwright'},capabilities:{tools:{}}});
  if(data.method==='notifications/initialized'){res.writeHead(202);return res.end();}
  if(data.method==='tools/call'){
   res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':'backend-test'});
   res.write('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:data.id,
    result:{content:[{type:'text',text:'### Result\n- 0: (current) [Home](https://chatgpt.com/)'}]}})+'\n\n');
   const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),35);
   res.on('close',()=>clearInterval(heartbeat));
   return;
  }
  return respond(res,data.id,{tools:[{name:'browser_tabs'}]});
 });
 const backendPort=await listen(backend);
 const reserved=http.createServer();const proxyPort=await listen(reserved);
 await new Promise(resolve=>reserved.close(resolve));
 const proxy=spawn(process.execPath,[fileURLToPath(new URL('../restricted-proxy.mjs',import.meta.url)),'shared'],{
  env:{...process.env,NODE_ENV:'test',MCPGO_PROXY_PORT:String(proxyPort),MCPGO_BACKEND_PORT:String(backendPort)},
  stdio:['ignore','pipe','pipe']});
 try{
  const healthUrl=`http://127.0.0.1:${proxyPort}/healthz`;
  for(let i=0;i<50;i++){
   try {if((await fetch(healthUrl)).ok)break;}catch{}
   await delay(30);
  }
  const mcp=new ProxyTestClient(`http://127.0.0.1:${proxyPort}/mcp`,fetch,'autosend-sse-test');
  await mcp.connect();
  const start=Date.now();
  const first=await mcp.tool('browser_tabs',{action:'list'});
  assert.match(first,/### Result/);
  assert.ok(Date.now()-start<4000,'never wait for SSE heartbeat stream to close');
  const second=await mcp.tool('browser_tabs',{action:'list'});
  assert.match(second,/### Result/,'next tool is not blocked by previous stream');
  const health=await (await fetch(healthUrl)).json();
  assert.equal(health.browserQueue.active,false);
  assert.equal(health.browserQueue.waiting,0);
 }finally{
  proxy.kill('SIGTERM');backend.closeAllConnections?.();await new Promise(resolve=>backend.close(resolve));
 }
});
