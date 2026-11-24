import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {modernHeaders,modernParams,MODERN_PROTOCOL,SERVER_META_KEY} from '../mcp-modern-protocol.mjs';

const proxyFile=fileURLToPath(new URL('../restricted-proxy.mjs',import.meta.url));
const pages=[{uid:1,url:'https://start.example'}];let nextId=2,currentId=1,upstreamSid='backend-1';
const clicked=[],tabOperations=[],toolCalls=[];let upstreamInitializes=0;
const tabsText=()=>`### Result\n${pages.map((t,i)=>`- ${i}: ${t.uid===currentId?'(current) ':''}[Test](${t.url})`).join('\n')}`;
const response=(id,result)=>'event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id,result})+'\n\n';
const browser=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 let data={};try{data=JSON.parse(body||'{}')}catch{}
 if(data.method==='initialize'){
  upstreamInitializes++;
  res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':upstreamSid});
  return res.end(response(data.id,{protocolVersion:'2025-03-26',serverInfo:{name:'Fake Playwright'},capabilities:{tools:{}}}));
 }
 if(req.headers['mcp-session-id']!==upstreamSid){res.writeHead(404);return res.end('Session not found');}
 if(data.method==='notifications/initialized'){res.writeHead(202);return res.end();}
 if(data.method==='tools/list'){
  res.writeHead(200,{'content-type':'text/event-stream'});
  return res.end(response(data.id,{tools:[{name:'browser_tabs'},{name:'browser_navigate'},{name:'browser_click'},{name:'browser_snapshot'}]}));
 }
 if(data.method==='tools/call'){
  const name=data.params?.name,args=data.params?.arguments||{};
  toolCalls.push({name,args});
  if(data.params?._meta)throw Error('MODERN_META_LEAKED_TO_LEGACY_PLAYWRIGHT');
  if(Object.hasOwn(args,'workspace_id')){
    res.writeHead(400);return res.end('WORKSPACE_ID_LEAKED_TO_PLAYWRIGHT');
  }
  let result=tabsText();
  if(name==='browser_tabs'){
    tabOperations.push(args.action);
    if(args.action==='new'){
      const tab={uid:nextId++,url:args.url||'about:blank'};pages.push(tab);currentId=tab.uid;
      result=tabsText();
    }else if(args.action==='select'){
      if(!pages[args.index]){res.writeHead(400);return res.end('Missing tab');}
      currentId=pages[args.index].uid;result=tabsText();
    }else if(args.action==='close'){
      if(!pages[args.index]){res.writeHead(400);return res.end('Missing tab');}
      const [tab]=pages.splice(args.index,1);
      if(currentId===tab.uid)currentId=pages.at(-1)?.uid||0;
      result=tabsText();
    }
  }else if(name==='browser_navigate'){
    const tab=pages.find(x=>x.uid===currentId);
    if(tab)tab.url=args.url;
    result=tabsText();
  }else if(name==='browser_click'){
    clicked.push({tag:args.target,uid:currentId,url:pages.find(x=>x.uid===currentId)?.url});
    result='### Result\nClicked';
  }else if(name==='browser_snapshot')result='### Result\nSnapshot';
  res.writeHead(200,{'content-type':'text/event-stream'});
  return res.end(response(data.id,{content:[{type:'text',text:result}]}));
 }
 res.writeHead(400);res.end();
});

const start=async srv=>{srv.listen(0,'127.0.0.1');await new Promise(resolve=>srv.once('listening',resolve));return srv.address().port;};
const backendPort=await start(browser);
const reserved=http.createServer(),proxyPort=await start(reserved);await new Promise(resolve=>reserved.close(resolve));
const proxy=spawn(process.execPath,[proxyFile,'shared'],{env:{...process.env,
 MCPGO_PROXY_PORT:String(proxyPort),MCPGO_BACKEND_PORT:String(backendPort)},stdio:['ignore','pipe','pipe']});
let stderr='';proxy.stderr.on('data',b=>stderr+=b.toString());
after(async()=>{proxy.kill('SIGTERM');await new Promise(resolve=>browser.close(resolve));});
const url=`http://127.0.0.1:${proxyPort}/mcp`;
for(let i=0;i<40;i++){
 if(proxy.exitCode!==null)throw Error('Proxy exited: '+stderr);
 try{await fetch(`http://127.0.0.1:${proxyPort}/healthz`,{signal:AbortSignal.timeout(200)});break}
 catch{await new Promise(resolve=>setTimeout(resolve,50));}
}
function client(session=null,headers={}){
 let requestId=0,sessionValue=session;
 return {
  async send(method,params={},override={}){
   const body={jsonrpc:'2.0',id:++requestId,method,params:modernParams(params,'ChatGPT')};
   if(sessionValue)body.params._meta['openai/session']=sessionValue;
   const outHeaders={...modernHeaders(method,body.params),...headers,...override};
   const res=await fetch(url,{method:'POST',headers:outHeaders,body:JSON.stringify(body),
     signal:AbortSignal.timeout(15000)});
   const txt=await res.text();const first=txt.trim().startsWith('{')?txt:
      txt.split(/\r?\n/).find(x=>x.startsWith('data: '))?.slice(6);
   return {status:res.status,result:first?JSON.parse(first):null,session:res.headers.get('mcp-session-id'),body:txt};
  },
  tool(name,args={}){return this.send('tools/call',{name,arguments:args})},
  setSession(next){sessionValue=next},
 };
}
const payload=r=>{
 const text=r.result?.result?.content?.find(c=>c.type==='text')?.text;
 try{return JSON.parse(text)}catch{return text}
};
const expectModern=r=>{
 assert.equal(r.status,200,JSON.stringify(r.result));
 assert.equal(r.session,null,'2026-07-28 MUST NOT emit Mcp-Session-Id');
 assert.equal(r.result?.result?.resultType,'complete');
 assert.equal(r.result.result._meta[SERVER_META_KEY].name,'McpGo-Browser');
};

test('modern discovery is independent; existing ChatGPT legacy client remains supported temporarily',async()=>{
 const a=client();
 const initial=upstreamInitializes;
 const d=await a.send('server/discover');expectModern(d);
 assert.deepEqual(d.result.result.supportedVersions,[MODERN_PROTOCOL]);
 assert.equal(d.result.result.cacheScope,'private');assert.equal(d.result.result.ttlMs,0);
 assert.equal(upstreamInitializes,initial,'discovery must be passive');
 const old=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:4,method:'initialize',
   params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ChatGPT',version:'1'}}})});
 assert.equal(old.status,200);const sid=old.headers.get('mcp-session-id');
 assert.match(sid,/^[a-f0-9-]{36}$/);
 const legacyList=await fetch(url,{method:'POST',headers:{'content-type':'application/json',
  'mcp-session-id':sid},body:JSON.stringify({jsonrpc:'2.0',id:6,method:'tools/list'})});
 assert.equal(legacyList.status,200);
 assert.equal(legacyList.headers.get('mcp-session-id'),sid);
 const legacyText=await legacyList.text();
 assert.match(legacyText,/browser_tabs/);
 assert.doesNotMatch(legacyText,/resultType/);
 const ended=await fetch(url,{method:'DELETE',headers:{'mcp-session-id':sid}});
 assert.equal(ended.status,200);
});
test('tools/list returns a stable private cacheable catalog without a public session',async()=>{
 const a=client();
 const list=await a.send('tools/list');expectModern(list);
 assert.equal(list.result.result.cacheScope,'private');assert.equal(list.result.result.ttlMs,0);
 assert.ok(upstreamInitializes>=1);
 assert.ok(list.result.result.tools.some(t=>t.name==='mcpgo_workspace'));
 assert.ok(!list.result.result.tools.some(t=>t.name==='browser_run_code_unsafe'));
 assert.ok(!list.result.result.tools.some(t=>t.name==='browser_close'));
 assert.ok(list.result.result.tools.some(t=>t.name==='mcpgo_inspect_page'));
 assert.ok(list.result.result.tools.find(t=>t.name==='mcpgo_inspect_page').inputSchema.required.includes('workspace_id'));
 assert.equal(list.result.result.tools.find(t=>t.name==='browser_click').inputSchema.properties.workspace_id.type,'string');
 assert.ok(list.result.result.tools.find(t=>t.name==='browser_click').inputSchema.required.includes('workspace_id'));
 assert.ok(list.result.result.tools.find(t=>t.name==='browser_snapshot').inputSchema.required.includes('workspace_id'));
 assert.ok(!list.result.result.tools.find(t=>t.name==='mcpgo_workspace').inputSchema.required?.includes('workspace_id'));
 const second=await a.send('tools/list');expectModern(second);
 assert.deepEqual(list.result.result.tools,second.result.result.tools,'catalog order deterministic');
});
test('three concurrent sessions share ONE Chrome and isolate three browser workspaces',async()=>{
 const clients=['chat-A','chat-B','chat-C'].map(s=>client(s));
 const names=['A','B','C'];
 const ws=[];
 for(let i=0;i<clients.length;i++){
  const c=clients[i];
  const bootstrap=await c.tool('mcpgo_workspace');expectModern(bootstrap);
  const id=bootstrap.result.result.structuredContent.workspace_id;
  const created=await c.tool('browser_tabs',{action:'new',workspace_id:id});expectModern(created);
  ws.push(created.result.result.structuredContent.workspace_id);
  assert.match(ws[i],/^ws_[A-Za-z0-9_-]{32}$/);
  const navigated=await c.tool('browser_navigate',{url:`https://${names[i].toLowerCase()}.example`,workspace_id:ws[i]});
  expectModern(navigated);assert.equal(navigated.result.result.structuredContent.workspace_id,ws[i]);
 }
 assert.equal(new Set(ws).size,3);
 assert.equal(upstreamInitializes,1,'three model clients must reuse one private browser session');
 const outcome=await Promise.all(clients.map((c,i)=>c.tool('browser_click',{target:names[i],workspace_id:ws[i]})));
 outcome.forEach(expectModern);
 const byTag=Object.fromEntries(clicked.map(c=>[c.tag,c.url]));
 assert.equal(byTag.A,'https://a.example');assert.equal(byTag.B,'https://b.example');assert.equal(byTag.C,'https://c.example');
 const invalid=await clients[1].tool('browser_click',{target:'NO',workspace_id:ws[0]});
 assert.equal(invalid.status,409);
 assert.match(invalid.body,/WORKSPACE_CURRENT_AGENT_HAS_TABS/);
 const fresh=client('chat-A');
 const restored=await fresh.tool('mcpgo_workspace',{workspace_id:ws[0]});expectModern(restored);
 assert.equal(payload(restored).workspace_id,ws[0]);
 for(let i=0;i<clients.length;i++){
  const listed=await clients[i].tool('mcpgo_tab_handle',{action:'list',workspace_id:ws[i]});expectModern(listed);
  const owned=payload(listed).owned;
  assert.equal(owned.length,1);
  const closed=await clients[i].tool('mcpgo_tab_action',{action:'close',tab_id:owned[0],workspace_id:ws[i]});expectModern(closed);
 }
});
test('rotating OpenAI per-request session cannot steal ownership; one workspace survives 20 operations',async()=>{
 const a=client('session-rotated-0001');
 const bootstrap=await a.tool('mcpgo_workspace');expectModern(bootstrap);
 const workspaceId=bootstrap.result.result.structuredContent.workspace_id;
 const created=await a.tool('browser_tabs',{action:'new',url:'https://owned-session.example',workspace_id:workspaceId});
 expectModern(created);
 assert.equal(created.result.result.structuredContent.workspace_id,workspaceId);
 const missing=await a.tool('browser_snapshot',{});
 assert.equal(missing.status,409);
 assert.match(missing.body,/WORKSPACE_ID_REQUIRED/);
 for(let i=0;i<20;i++){
   a.setSession(`session-rotated-${i+2}`);
   const value=i%2===0?
     await a.tool('browser_snapshot',{workspace_id:workspaceId}):
     await a.tool('browser_click',{target:`tick-${i}`,workspace_id:workspaceId});
   expectModern(value);
   assert.equal(value.result.result.structuredContent.workspace_id,workspaceId);
 }
 const separate=client('independent-client-session');
 const separateWs=(await separate.tool('mcpgo_workspace')).result.result.structuredContent.workspace_id;
 assert.notEqual(separateWs,workspaceId);
 const denied=await separate.tool('browser_snapshot',{workspace_id:separateWs});
 assert.equal(denied.status,409,'separate agent cannot act on first agent tab');
 assert.match(denied.body,/TAB_OWNED_BY_ANOTHER_AGENT/);
 assert.match(denied.body,/owner_scope=[a-f0-9]{10}/);
 assert.match(denied.body,/requester_scope=[a-f0-9]{10}/);
 assert.doesNotMatch(denied.body,/https:\/\/owned-session/);
 const recovered=await a.tool('browser_snapshot',{workspace_id:workspaceId});expectModern(recovered);
 const handles=payload(await a.tool('mcpgo_tab_handle',{action:'list',workspace_id:workspaceId}));
 assert.equal(handles.owned.length,1);
 const closed=await a.tool('mcpgo_tab_action',{action:'close',tab_id:handles.owned[0],workspace_id:workspaceId});
 expectModern(closed);
});
test('without trusted conversation metadata, model must first request and reuse workspace_id',async()=>{
 const anonymous=client();
 const blocked=await anonymous.tool('browser_tabs',{action:'new'});
 assert.equal(blocked.status,409);assert.match(blocked.body,/WORKSPACE_ID_REQUIRED/);
 const workspace=await anonymous.tool('mcpgo_workspace');expectModern(workspace);
 const handle=workspace.result.result.structuredContent.workspace_id;
 const second=await anonymous.tool('browser_tabs',{action:'new',workspace_id:handle});expectModern(second);
 assert.equal(second.result.result.structuredContent.workspace_id,handle);
 const list=await anonymous.tool('mcpgo_tab_handle',{action:'list',workspace_id:handle});expectModern(list);
 const tabId=payload(list).owned.at(-1);
 const closed=await anonymous.tool('mcpgo_tab_action',{action:'close',tab_id:tabId,workspace_id:handle});expectModern(closed);
});
test('wrong modern version and HTTP routing headers fail closed',async()=>{
 const a=client('valid');
 const wrongMethod=await a.send('tools/list',{}, {'mcp-method':'tools/call'});
 assert.equal(wrongMethod.status,400);assert.equal(wrongMethod.result.error.code,-32020);
 const wrongName=await a.send('tools/call',{name:'browser_tabs',arguments:{action:'list'}},{'mcp-name':'browser_click'});
 assert.equal(wrongName.status,400);assert.equal(wrongName.result.error.code,-32020);
 const wrongVersion=await a.send('tools/list',{}, {'mcp-protocol-version':'2025-03-26'});
 assert.equal(wrongVersion.status,400);assert.equal(wrongVersion.result.error.code,-32022);
 const invalidBodyMeta=await fetch(url,{method:'POST',headers:modernHeaders('tools/list'),body:JSON.stringify({jsonrpc:'2.0',id:12,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}})});
 assert.equal(invalidBodyMeta.status,400);
 assert.equal((await invalidBodyMeta.json()).error.code,-32021);
});

test('local tool fields are available to structured-only clients',async()=>{
 const browserClient=client('diagnostic-regression');
 const workspace=await browserClient.tool('mcpgo_workspace');expectModern(workspace);
 const workspaceId=workspace.result.result.structuredContent.workspace_id;
 const status=await browserClient.tool('mcpgo_agent_status',{workspace_id:workspaceId});expectModern(status);
 assert.equal(typeof payload(status).automaticIsolation,'boolean');
 assert.deepEqual(status.result.result.structuredContent,{...payload(status),workspace_id:workspaceId});
});

test('numeric tab actions need only one fresh list before dispatch',async()=>{
 const browserClient=client('numeric-tab-regression');
 const workspace=await browserClient.tool('mcpgo_workspace');expectModern(workspace);
 const workspaceId=workspace.result.result.structuredContent.workspace_id;
 const url='https://numeric.example/';
 expectModern(await browserClient.tool('browser_tabs',{action:'new',url,workspace_id:workspaceId}));
 const index=pages.findIndex(page=>page.url===url);assert.notEqual(index,-1);
 for(const action of ['select','close']){
  const start=tabOperations.length;
  expectModern(await browserClient.tool('browser_tabs',{action,index,workspace_id:workspaceId}));
  const ops=tabOperations.slice(start);
  assert.deepEqual(ops.slice(0,ops.indexOf(action)+1),['list',action]);
 }
});

test('100 warm browser snapshots reuse initialized Playwright without probing its tools catalog',async()=>{
 const c=client('mcpgo-hot-path');
 const w=await c.tool('mcpgo_workspace');expectModern(w);
 const workspaceId=w.result.result.structuredContent.workspace_id;
 expectModern(await c.tool('browser_tabs',{action:'new',url:'https://hot-path.example/',workspace_id:workspaceId}));
 const before=await fetch(`http://127.0.0.1:${proxyPort}/healthz`).then(r=>r.json());
 for(let n=0;n<100;n++)expectModern(await c.tool('browser_snapshot',{workspace_id:workspaceId}));
 const after=await fetch(`http://127.0.0.1:${proxyPort}/healthz`).then(r=>r.json());
 assert.equal(after.performance.upstream.catalog,before.performance.upstream.catalog,
  'already initialized session must not tools/list on each snapshot');
 assert.equal(after.performance.commands.snapshot.count>=100,true);
 assert.ok(after.performance.commands.snapshot.p95Ms!==null);
 assert.equal(after.performance.upstream.total>before.performance.upstream.total,true);
});

test('three simultaneous safe read requests recover one expired upstream session',async()=>{
 const before=upstreamInitializes;
 upstreamSid='backend-new-'+Date.now();
 const outcomes=await Promise.all(Array.from({length:3},(_,i)=>client('recover-'+i).send('tools/list')));
 for(const response of outcomes)expectModern(response);
 assert.equal(upstreamInitializes,before+1,'concurrent recovery must share one initialization');
});

test('context-efficient inspection never bypasses per-workspace tab guard and blocks browser_close',async()=>{
 const c=client('quality-read-test');
 const workspace=await c.tool('mcpgo_workspace');expectModern(workspace);
 const workspaceId=workspace.result.result.structuredContent.workspace_id;
 expectModern(await c.tool('browser_tabs',{action:'new',url:'https://quality-read.example/',workspace_id:workspaceId}));
 const find=await c.tool('mcpgo_inspect_page',{strategy:'find',query:'Publish',maxResults:3,workspace_id:workspaceId});
 expectModern(find);
 assert.equal(toolCalls.at(-1).name,'browser_find');
 assert.deepEqual(toolCalls.at(-1).args,{text:'Publish',maxResults:3});
 const verify=await c.tool('mcpgo_inspect_page',{strategy:'verify',expectedText:'Saved',timeoutSeconds:3,workspace_id:workspaceId});
 expectModern(verify);
 assert.equal(toolCalls.at(-1).name,'browser_wait_for');
 assert.deepEqual(toolCalls.at(-1).args,{text:'Saved',time:3});
 const before=toolCalls.length;
 const invalid=await c.tool('mcpgo_inspect_page',{query:'test',regex:'pattern',workspace_id:workspaceId});
 assert.equal(invalid.status,400);
 assert.equal(toolCalls.length,before,'bad inspection never reached Playwright');
 const forbidden=await c.tool('browser_close',{workspace_id:workspaceId});
 assert.equal(forbidden.status,403);
 const diagnostic=await c.tool('mcpgo_browser_status',{workspace_id:workspaceId});
 expectModern(diagnostic);
 assert.ok(Array.isArray(diagnostic.result.result.structuredContent.recentFailures));
 assert.ok(diagnostic.result.result.structuredContent.recentFailures.every(x=>
   !JSON.stringify(x).includes('https://quality-read.example/')));
});
