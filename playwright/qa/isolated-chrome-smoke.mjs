/** Opt-in real Google Chrome acceptance with its OWN profile and processes.
 * Does NOT test the installed Playwright Extension or user Chrome profile.
 * Default 100 warm iterations; MCPGO_SMOKE_REPS=3 for a quick diagnostic.
 * Run: MCPGO_LIVE_BROWSER_SMOKE=1 node playwright/qa/isolated-chrome-smoke.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {modernHeaders,modernParams,MODERN_PROTOCOL} from '../mcp-modern-protocol.mjs';
import {responseMessage} from '../mcp-response.mjs';
if(process.env.MCPGO_LIVE_BROWSER_SMOKE!=='1')throw Error('Explicit opt-in required: MCPGO_LIVE_BROWSER_SMOKE=1');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-chrome-isolated-'));
const report=process.env.MCPGO_SMOKE_REPORT||path.join(os.tmpdir(),'mcpgo-chrome-smoke-'+Date.now()+'.json');
const clientsCount=Number(process.env.MCPGO_SMOKE_CLIENTS||3);
const reps=Number(process.env.MCPGO_SMOKE_REPS||100);
const settleMs=Number(process.env.MCPGO_SMOKE_SETTLE_MS??500);
const snapshotMode=process.env.MCPGO_SMOKE_SNAPSHOT_MODE||'full';
if(!['full','none'].includes(snapshotMode))throw Error('Unknown QA snapshot mode');
const inspect=process.env.MCPGO_SMOKE_INSPECT==='1';
const concurrent=process.env.MCPGO_SMOKE_CONCURRENT==='1';
const toolProfile=process.env.MCPGO_SMOKE_TOOL_PROFILE||'full';
if(!['full','core','vision','diagnostics'].includes(toolProfile))throw Error('Unknown QA tool profile');
if(![0,100,200,500].includes(settleMs))throw Error('MCPGO_SMOKE_SETTLE_MS must be 0, 100, 200 or 500');
if(![1,3].includes(clientsCount)||!Number.isInteger(reps)||reps<1||reps>500)
 throw Error('MCPGO_SMOKE_CLIENTS must be 1/3, MCPGO_SMOKE_REPS between 1 and 500');
const running=[];const logs={};
let server;
const result={kind:'isolated-headed-chrome-qa',extensionTested:false,
  clients:clientsCount,repetitions:reps,settleMs,snapshotMode,toolProfile,inspectionTested:inspect,concurrent,passed:false,startedAt:new Date().toISOString(),
  failures:[],stages:{},profileIsTemporary:true};
function listen(server){return new Promise((resolve,reject)=>{
 server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
});}
async function freePort(){const s=http.createServer();const port=await listen(s);
 await new Promise(resolve=>s.close(resolve));return port;}
function start(name,cmd,args,env={}){
 const child=spawn(cmd,args,{env:{...process.env,...env},cwd:root,
  stdio:['ignore','pipe','pipe'],detached:true});
 logs[name]='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{
  logs[name]=(logs[name]+b.toString()).slice(-12000);
 });
 running.push(child);return child;
}
async function ready(url,child){for(let attempt=0;attempt<120;attempt++){
 if(child.exitCode!==null)throw Error('Process exited before ready: '+logs[child===running[0]?'backend':'proxy']);
 try{const response=await fetch(url,{signal:AbortSignal.timeout(350)});
  if(response.status<500)return; }catch{}
 await pause(200);
}throw Error('Could not start '+url);}
let rid=0;let proxyPort,backendPort,fixturePort;
async function send(client,method,params={}){
 const begin=performance.now();const body={jsonrpc:'2.0',id:++rid,method,
  params:modernParams(params,'McpGo-Isolated-QA')};
 if(client.scope)body.params._meta['openai/session']=client.scope;
 const response=await fetch(`http://127.0.0.1:${proxyPort}/mcp`,{
  method:'POST',headers:modernHeaders(method,body.params),
  body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 const raw=await response.text();
 const parsed=responseMessage(raw,response.headers.get('content-type'),body.id);
 if(!response.ok||parsed.error||parsed.result?.isError)
  throw Error(method+' '+(params.name||'')+' HTTP '+response.status+': '+
   (parsed.error?.message||parsed.result?.content?.map(c=>c.text).join(' ').slice(0,600)));
 if(parsed.result?.resultType!=='complete')throw Error('No complete resultType');
 const type=params?.name==='browser_tabs'?params.arguments?.action:
  params?.name==='mcpgo_tab_action'?params.arguments?.action:
  params?.name?.replace(/^browser_/,'')||method;
 const stage=result.stages[type]??={elapsed:[],count:0};
 stage.elapsed.push(Math.round((performance.now()-begin)*10)/10);stage.count++;
 (stage.responseBytes??=[]).push(Buffer.byteLength(raw,'utf8'));
 (stage.responseTextChars??=[]).push((parsed.result?.content||[]).filter(c=>c.type==='text').reduce((n,c)=>n+(c.text?.length||0),0));
 return parsed.result;
}
async function tool(client,name,args={}){
 return send(client,'tools/call',{name,arguments:{...args,
  ...(client.workspace?{workspace_id:client.workspace}:{})}});
}
const text=result=>(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
async function establish(client){
 const d=await send(client,'server/discover');
 if(!d.supportedVersions?.includes(MODERN_PROTOCOL))throw Error('Unsupported discovery');
 const w=await tool(client,'mcpgo_workspace');
 client.workspace=w.structuredContent?.workspace_id;
 if(!/^ws_[A-Za-z0-9_-]{32}$/.test(client.workspace||''))throw Error('Missing workspace');
}
async function open(client){
 const opened=await tool(client,'browser_tabs',{action:'new',url:`http://127.0.0.1:${fixturePort}/?client=${client.name}&heavy=${inspect?'1':'0'}`});
 if(opened.structuredContent?.workspace_id!==client.workspace)throw Error('Wrong workspace on new tab');
 const handles=await tool(client,'mcpgo_tab_handle',{action:'list'});
 const ids=handles.structuredContent?.owned;
 if(!Array.isArray(ids)||ids.length!==1)throw Error('Expected exactly one owned tab for '+client.name+': '+ids.length);
 return ids[0];
}
async function select(client,tab){await tool(client,'mcpgo_tab_action',{action:'select',tab_id:tab});}
async function close(client,tab){await tool(client,'mcpgo_tab_action',{action:'close',tab_id:tab});}
function summary(values){const sorted=[...values].sort((a,b)=>a-b);
 const q=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;
 return {n:sorted.length,medianMs:q(0.5),p95Ms:q(0.95)};}
try{
 const html='<!doctype html><html><body><button id="increment" onclick="n++; document.getElementById(\'counter\').textContent=\'Clicks \'+n">Increment</button><p id="counter">Clicks 0</p><button id="deferred" onclick="setTimeout(()=>{document.getElementById(\'status\').textContent=\'Saved\'},280)">Save later</button><p id="status">Pending</p><canvas id="chart" width="300" height="120"></canvas><script>let n=0;document.getElementById(\'chart\').getContext(\'2d\').fillRect(0,0,150,50);</script></body></html>';
 server=http.createServer((req,res)=>{
  if(req.url?.startsWith('/probe-resource.js')){res.writeHead(200,{'content-type':'text/javascript'});return res.end('window.localResourceLoaded=true;')}
  if(req.url?.startsWith('/drawing.svg')){res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="purple"/><circle cx="120" cy="80" r="38" fill="white"/></svg>');}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  const list=req.url?.includes('heavy=1')?'<section aria-label="Unrelated content"><ul>'+Array.from({length:160},(_,i)=>
    '<li><a href="#item-'+i+'">Other navigation item '+i+'</a></li>').join('')+'</ul></section>':'';
  const extra=inspect?`<iframe id="same-origin-frame" srcdoc="<button id='frame-ready'>Frame Ready</button>"></iframe>
  <div id="virtual" style="height:110px;overflow:auto;position:relative"><div style="height:2300px">
  <span id="virtual-caption">Loading virtual list</span></div></div>
  <script src="/probe-resource.js"></script>
  <script>document.getElementById('virtual').addEventListener('scroll', function(){
   const caption=document.getElementById('virtual-caption');
   if(this.scrollTop>620){caption.innerHTML='<span id="virtual-needle">Virtual Target Loaded</span>'}
  });</script>`:'';
  res.end(html.replace('</body>',list+extra+'</body>'));
 });
 fixturePort=await listen(server);backendPort=await freePort();proxyPort=await freePort();
 const backend=start('backend',process.execPath,[path.join(root,'node_modules/@playwright/mcp/cli.js'),
  '--browser','chrome','--headless','--host','127.0.0.1','--port',String(backendPort),
  '--timeout-settle',String(settleMs),'--snapshot-mode',snapshotMode,'--user-data-dir',path.join(dir,'chrome-profile')]);
 await ready(`http://127.0.0.1:${backendPort}/mcp`,backend);
 const proxy=start('proxy',process.execPath,[process.env.MCPGO_SMOKE_PROXY_SCRIPT||path.join(root,'restricted-proxy.mjs'),'shared'],{
  MCPGO_PROXY_PORT:String(proxyPort),MCPGO_BACKEND_PORT:String(backendPort),
  MCPGO_ACTION_ROOT:path.join(dir,'action-receipts'),MCPGO_DISABLE_LEGACY:'1',
  MCPGO_BROWSER_TOOL_PROFILE:toolProfile});
 await ready(`http://127.0.0.1:${proxyPort}/healthz`,proxy);
 if(toolProfile!=='full'){
  const catalog=await send({name:'catalog',scope:'catalog-profile-test'},'tools/list');
  const names=catalog.tools?.map(t=>t.name)||[];
  if(!names.includes('mcpgo_inspect_page')||!names.includes('mcpgo_workspace'))
   throw Error('Core tool catalog missing required workspace/inspection tools');
  if(toolProfile==='core'&&(names.includes('browser_evaluate')||names.includes('browser_take_screenshot')))
   throw Error('Core catalog exposed diagnostic or visual tools');
  result.toolCatalogSize=names.length;
 }
 const clients=Array.from({length:clientsCount},(_,i)=>({name:String(i+1),scope:'isolated-chrome-client-'+i}));
 for(const client of clients)await establish(client);
 const coldStart=performance.now();
 const tabs=[];
 for(const client of clients)tabs.push(await open(client));
 result.coldStartMs=Math.round(performance.now()-coldStart);
 if(new Set(tabs).size!==tabs.length)throw Error('Tab handle collision');
 // New transport with same workspace must recover the owned tab.
 const resumed={name:'resumed',scope:null,workspace:clients[0].workspace};
 const recovered=await tool(resumed,'mcpgo_workspace',{workspace_id:resumed.workspace});
 if(recovered.structuredContent?.ownedTabs!==1)throw Error('Workspace resume failed');
 clients[0]=resumed;
 // Concurrent clients contend for ONE shared selected tab. Each agent's
 // read-after-click must still be routed to ITS owned tab by the proxy.
 if(concurrent){
  await Promise.all(clients.map(async(client,i)=>{
   for(let j=0;j<reps;j++){
    await tool(client,'browser_click',{target:'#increment',element:'Increment button'});
    const verified=await tool(client,'mcpgo_inspect_page',{
     strategy:'verify',expectedText:'Clicks '+(j+1),timeoutSeconds:4});
    if(!text(verified).includes('Clicks '+(j+1)))throw Error('Concurrent client '+i+' lost own tab');
   }
  }));
 }
 for(let i=0;i<clients.length;i++){
  const client=clients[i];await select(client,tabs[i]);
  const snapshot=await tool(client,'browser_snapshot');
  const fullSnapshotChars=text(snapshot).length;
  if(!text(snapshot).includes('Increment'))throw Error('Missing button in real Chrome snapshot');
  // Warm operations. Never parallelize clicks against the shared selected tab.
  for(let j=0;!concurrent&&j<reps;j++){
   await select(client,tabs[i]);
   await tool(client,'browser_snapshot');
   await tool(client,'browser_click',{target:'#increment',element:'Increment button'});
   const after=text(await tool(client,'browser_snapshot'));
   if(!after.includes('Clicks '+(j+1)))throw Error('Expected Clicks '+(j+1)+' for client '+i);
  }
  if(inspect){
   await select(client,tabs[i]);
   const found=await tool(client,'mcpgo_inspect_page',{strategy:'auto',query:'Increment',maxResults:3});
   if(!text(found).includes('Increment'))throw Error('Targeted search missed button');
   const scopedMetrics={fullChars:fullSnapshotChars,findChars:text(found).length};
   const scoped=await tool(client,'mcpgo_inspect_page',{strategy:'snapshot',target:'#counter',depth:3});
   if(!text(scoped).includes('Clicks '+reps))throw Error('Scoped snapshot missed counter');
   scopedMetrics.sectionChars=text(scoped).length;
   await tool(client,'browser_click',{target:'#deferred',element:'Save later'});
   const verified=await tool(client,'mcpgo_inspect_page',{strategy:'verify',expectedText:'Saved',timeoutSeconds:6});
   if(!text(verified).includes('Saved'))throw Error('Deferred state was not verified');
   const recoveredRef=await tool(client,'mcpgo_inspect_page',{strategy:'recover',query:'Increment',maxResults:2});
   if(!text(recoveredRef).includes('Increment'))throw Error('Stale ref read-only recovery failed');
   const urlCheck=await tool(client,'mcpgo_inspect_page',{strategy:'state',
    expectedUrl:`http://127.0.0.1:${fixturePort}/?client=${i+1}&heavy=1`,timeoutSeconds:3});
   if(!text(urlCheck).includes('matched'))throw Error('Semantic URL check failed');
   const frameCheck=await tool(client,'mcpgo_inspect_page',{strategy:'state',
    selector:'#frame-ready',includeFrames:true,timeoutSeconds:3});
   if(!text(frameCheck).includes('matched'))throw Error('Same-origin iframe check failed');
   const resourceCheck=await tool(client,'mcpgo_inspect_page',{strategy:'state',
    expectedRequestPath:'/probe-resource.js',timeoutSeconds:3});
   if(!text(resourceCheck).includes('matched'))throw Error('Resource timing observation failed');
   const scrolled=await tool(client,'mcpgo_inspect_page',{strategy:'scroll',
    selector:'#virtual-needle',containerSelector:'#virtual',maxSteps:6,stepPixels:500,timeoutSeconds:4});
   if(!text(scrolled).includes('matched'))throw Error('Virtual-list bounded scroll did not resolve');
   const visual=await tool(client,'mcpgo_inspect_page',{strategy:'visual',target:'#chart',depth:2});
   if(!Array.isArray(visual.content)||visual.content.length<2)throw Error('Visual DOM+image not combined');
   result.visualKinds=(visual.content||[]).map(c=>c.type);
   result.contextMetrics=scopedMetrics;
  }
 }
 // Measure close operations with owned throwaway tabs, not other users' tabs.
 for(let i=0;i<clients.length;i++){
  const client=clients[i];
  await close(client,tabs[i]);
  for(let j=1;j<reps;j++){
   const ephemeral=await open(client);
   await close(client,ephemeral);
  }
 }
 if(inspect){
  const client=clients[0];
  await tool(client,'browser_tabs',{action:'new',url:`http://127.0.0.1:${fixturePort}/drawing.svg`});
  const images=await tool(client,'mcpgo_inspect_page',{strategy:'visual',screenshotOnly:true});
  if(!images.content?.some(c=>c.type==='image'))throw Error('SVG/no-body screenshot fallback unavailable');
  const handles=await tool(client,'mcpgo_tab_handle',{action:'list'});
  const owned=handles.structuredContent?.owned;
  if(!Array.isArray(owned)||owned.length!==1)throw Error('SVG tab ownership ambiguity');
  await close(client,owned[0]);
  result.svgImageFallback=true;
 }
 result.health=await fetch(`http://127.0.0.1:${proxyPort}/healthz`).then(r=>r.json());
 const names=['snapshot','click','select','close'];
 result.timings=Object.fromEntries(Object.entries(result.stages).map(([k,v])=>[k,{...summary(v.elapsed),responseBytes:summary(v.responseBytes||[]),responseTextChars:summary(v.responseTextChars||[])}]));
 result.passed=true;
 console.log('REAL_CHROME_SMOKE_PASS clients='+clientsCount+' reps='+reps+' catalog='+result.health.performance?.upstream?.catalog+' tabLists='+result.health.performance?.upstream?.tabLists);
}catch(e){result.failures.push(e.stack||String(e));console.error('REAL_CHROME_SMOKE_FAIL '+e.message);
 process.exitCode=1;
}finally{
 result.finishedAt=new Date().toISOString();
 result.processLogs=Object.fromEntries(Object.entries(logs).map(([k,v])=>[k,v.slice(-3000)]));
 fs.writeFileSync(report,JSON.stringify(result,null,2),{mode:0o600});
 console.log('QA_REPORT='+report);
 for(const proc of running.reverse()){
  try{process.kill(-proc.pid,'SIGTERM')}catch{try{proc.kill('SIGTERM')}catch{}}
 }
 await pause(400);
 for(const proc of running){if(proc.exitCode===null){try{process.kill(-proc.pid,'SIGKILL')}catch{}}}
 await new Promise(resolve=>server?.close(resolve)??resolve());
 fs.rmSync(dir,{recursive:true,force:true});
}
