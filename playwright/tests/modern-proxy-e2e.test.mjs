import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {modernHeaders,modernParams,MODERN_PROTOCOL,SERVER_META_KEY} from '../mcp-modern-protocol.mjs';

const proxyFile=fileURLToPath(new URL('../restricted-proxy.mjs',import.meta.url));
const pages=[{uid:1,url:'https://start.example'}];let nextId=2,currentId=1,upstreamSid='backend-1';
const clicked=[];let upstreamInitializes=0;
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
  if(data.params?._meta)throw Error('MODERN_META_LEAKED_TO_LEGACY_PLAYWRIGHT');
  if(Object.hasOwn(args,'workspace_id')){
    res.writeHead(400);return res.end('WORKSPACE_ID_LEAKED_TO_PLAYWRIGHT');
  }
  let result=tabsText();
  if(name==='browser_tabs'){
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
 let requestId=0;
 return {
  async send(method,params={},override={}){
   const body={jsonrpc:'2.0',id:++requestId,method,params:modernParams(params,'ChatGPT')};
   if(session)body.params._meta['openai/session']=session;
   const outHeaders={...modernHeaders(method,body.params),...headers,...override};
   const res=await fetch(url,{method:'POST',headers:outHeaders,body:JSON.stringify(body),
     signal:AbortSignal.timeout(15000)});
   const txt=await res.text();const first=txt.trim().startsWith('{')?txt:
      txt.split(/\r?\n/).find(x=>x.startsWith('data: '))?.slice(6);
   return {status:res.status,result:first?JSON.parse(first):null,session:res.headers.get('mcp-session-id'),body:txt};
  },
  tool(name,args={}){return this.send('tools/call',{name,arguments:args})},
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
 assert.equal(list.result.result.tools.find(t=>t.name==='browser_click').inputSchema.properties.workspace_id.type,'string');
 const second=await a.send('tools/list');expectModern(second);
 assert.deepEqual(list.result.result.tools,second.result.result.tools,'catalog order deterministic');
});
test('three concurrent sessions share ONE Chrome and isolate three browser workspaces',async()=>{
 const clients=['chat-A','chat-B','chat-C'].map(s=>client(s));
 const names=['A','B','C'];
 const ws=[];
 for(let i=0;i<clients.length;i++){
  const c=clients[i];
  const created=await c.tool('browser_tabs',{action:'new'});expectModern(created);
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
 assert.match(invalid.body,/WORKSPACE_STABLE_SCOPE_CONFLICT/);
 const fresh=client('chat-A');
 const restored=await fresh.tool('mcpgo_workspace',{workspace_id:ws[0]});expectModern(restored);
 assert.equal(payload(restored).workspace_id,ws[0]);
 for(let i=0;i<clients.length;i++){
  const listed=await clients[i].tool('mcpgo_tab_handle',{action:'list'});expectModern(listed);
  const owned=payload(listed).owned;
  assert.equal(owned.length,1);
  const closed=await clients[i].tool('mcpgo_tab_action',{action:'close',tab_id:owned[0]});expectModern(closed);
 }
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
