import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

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
 NODE_ENV:'test',MCPGO_LEGACY_TEST_ONLY:'1',MCPGO_PROXY_PORT:String(proxyPort),MCPGO_BACKEND_PORT:String(backendPort)},stdio:['ignore','pipe','pipe']});
let stderr='';proxy.stderr.on('data',b=>stderr+=b.toString());
after(async()=>{proxy.kill('SIGTERM');await new Promise(resolve=>browser.close(resolve));});
const url=`http://127.0.0.1:${proxyPort}/mcp`;
for(let i=0;i<40;i++){
 if(proxy.exitCode!==null)throw Error('Proxy exited: '+stderr);
 try{await fetch(url,{signal:AbortSignal.timeout(200)});break}catch{await new Promise(resolve=>setTimeout(resolve,50));}
}
function client(extraHeaders={}){
 let sid='',id=0;
 const post=async(method,params)=>{
  const data={jsonrpc:'2.0',method};if(method!=='notifications/initialized')data.id=++id;
  if(params)data.params=params;
  const h={'content-type':'application/json',accept:'application/json, text/event-stream',...extraHeaders};
  if(sid)h['mcp-session-id']=sid;
  const r=await fetch(url,{method:'POST',headers:h,body:JSON.stringify(data),signal:AbortSignal.timeout(12000)});
  sid=r.headers.get('mcp-session-id')||sid;
  const txt=await r.text();
  const first=txt.trim().startsWith('{')?txt:txt.split(/\r?\n/).find(x=>x.startsWith('data: '))?.slice(6);
  return {status:r.status,result:first?JSON.parse(first):null,session:sid};
 };
 return {post,tool:(name,args)=>post('tools/call',{name,arguments:args}),init:async()=>{
  const response=await post('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'ChatGPT',version:'1'}});
  assert.equal(response.status,200);await post('notifications/initialized');return sid;
 },close:async()=>{if(sid)await fetch(url,{method:'DELETE',headers:{'mcp-session-id':sid},signal:AbortSignal.timeout(2000)});}};
}
const payload=r=>{
 const text=r.result?.result?.content?.find(c=>c.type==='text')?.text;
 try{return JSON.parse(text)}catch{return text}
};

test('3 identical-named ChatGPT clients automatically own unique tabs and safely alternate',async()=>{
 const a=client(),b=client(),c=client();
 const sessions=await Promise.all([a.init(),b.init(),c.init()]);
 assert.equal(new Set(sessions).size,3,'distinct opaque transport identities');
 assert.equal(upstreamInitializes,1,'only one backend session and Chrome connection');
 const nav=await a.tool('browser_navigate',{url:'https://a.example'});
 assert.equal(nav.status,200,JSON.stringify(nav.result));
 const aList=payload(await a.tool('mcpgo_tab_handle',{action:'list'}));
 assert.equal(aList.owned.length,1);const aId=aList.owned[0];
 for(const [agent,letter] of [[b,'b'],[c,'c']]){
  const created=await agent.tool('browser_tabs',{action:'new'});
  assert.equal(created.status,200,JSON.stringify(created.result));
  const page=await agent.tool('browser_navigate',{url:`https://${letter}.example`});
  assert.equal(page.status,200,JSON.stringify(page.result));
  const list=payload(await agent.tool('mcpgo_tab_handle',{action:'list'}));
  assert.equal(list.owned.length,1,'new tab belongs to requesting agent');
 }
 const bId=payload(await b.tool('mcpgo_tab_handle',{action:'list'})).owned[0];
 const cId=payload(await c.tool('mcpgo_tab_handle',{action:'list'})).owned[0];
 assert.equal(new Set([aId,bId,cId]).size,3);
 const results=await Promise.all([a.tool('browser_click',{target:'A'}),b.tool('browser_click',{target:'B'}),c.tool('browser_click',{target:'C'})]);
 assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
 const byTag=Object.fromEntries(clicked.map(c=>[c.tag,c.url]));
 assert.deepEqual(byTag,{A:'https://a.example',B:'https://b.example',C:'https://c.example'});
 const hijack=await c.tool('mcpgo_tab_action',{action:'select',tab_id:aId});
 assert.equal(hijack.status,409);assert.match(JSON.stringify(hijack.result),/TAB_OWNED_BY_ANOTHER_AGENT/);
 const closed=await a.tool('mcpgo_tab_action',{action:'close',tab_id:aId});
 assert.equal(closed.status,200,JSON.stringify(closed.result));
 const bAfter=payload(await b.tool('mcpgo_tab_handle',{action:'resolve',tab_id:bId}));
 assert.equal(bAfter.index_hint,0,'stable handle resolves after earlier tab closes');
 const bClick=await b.tool('browser_click',{target:'B-again'});
 assert.equal(bClick.status,200,JSON.stringify(bClick.result));
 assert.equal(clicked.at(-1).url,'https://b.example');
 const health=await fetch(`http://127.0.0.1:${proxyPort}/healthz`).then(r=>r.json());
 assert.equal(health.shared,true);assert.equal(health.activeMcpSessions,3);
});

test('blank tabs use unique CSP-restricted local URLs before Playwright creates them',async()=>{
 const extra=client();await extra.init();
 const created=await extra.tool('browser_tabs',{action:'new',url:'about:blank'});
 assert.equal(created.status,200,JSON.stringify(created.result));
 const tab=pages.find(page=>page.uid===currentId);
 assert.match(tab.url,new RegExp('^http://127\\.0\\.0\\.1:'+proxyPort+'/mcpgo-blank/[a-f0-9-]{36}$'));
 const blank=await fetch(tab.url);
 assert.equal(blank.status,200);
 assert.match(blank.headers.get('content-security-policy'),/default-src 'none'/);
 assert.doesNotMatch(await blank.text(),/<script/);
 const handles=payload(await extra.tool('mcpgo_tab_handle',{action:'list'}));
 assert.equal(handles.owned.length,1);
 assert.equal((await extra.tool('mcpgo_tab_action',{action:'close',tab_id:handles.owned[0]})).status,200);
});


test('workspace_id repeats in every browser result and recovers owned tab after MCP session recreation',async()=>{
 const original=client();await original.init();
 const tools=await original.post('tools/list');
 for(const toolName of ['browser_tabs','browser_click','mcpgo_tab_handle','mcpgo_workspace']){
  const schema=tools.result.result.tools.find(t=>t.name===toolName)?.inputSchema;
  assert.equal(schema?.properties?.workspace_id?.type,'string','missing workspace parameter for '+toolName);
 }
 const opened=await original.tool('browser_tabs',{action:'new'});
 assert.equal(opened.status,200,JSON.stringify(opened.result));
 const ws=opened.result.result.structuredContent.workspace_id;
 assert.match(ws,/^ws_[A-Za-z0-9_-]{32}$/);
 assert.equal(opened.result.result.content.filter(c=>c.type==='text'&&c.text.includes('workspace_id: '+ws)).length,1);
 const nav=await original.tool('browser_navigate',{url:'https://recover.example',workspace_id:ws});
 assert.equal(nav.status,200,JSON.stringify(nav.result));
 assert.equal(nav.result.result.structuredContent.workspace_id,ws);
 const handles=payload(await original.tool('mcpgo_tab_handle',{action:'list',workspace_id:ws}));
 assert.equal(handles.owned.length,1);
 const tabId=handles.owned[0];
 await original.close();
 const reconnect=client();await reconnect.init();
 const result=await reconnect.tool('mcpgo_workspace',{workspace_id:ws});
 assert.equal(result.status,200,JSON.stringify(result.result));
 assert.equal(payload(result).workspace_id,ws);
 assert.equal(result.result.result.structuredContent.workspace_id,ws);
 const clickedAgain=await reconnect.tool('browser_click',{target:'recovered',workspace_id:ws});
 assert.equal(clickedAgain.status,200,JSON.stringify(clickedAgain.result));
 assert.equal(clicked.at(-1).url,'https://recover.example');
 const resolved=payload(await reconnect.tool('mcpgo_tab_handle',{action:'resolve',tab_id:tabId,workspace_id:ws}));
 assert.equal(resolved.tab_id,tabId);
 // Other sessions do not silently inherit workspace when they omit its ID.
 const fresh=client();await fresh.init();
 const denied=await fresh.tool('browser_click',{target:'stranger'});
 assert.equal(denied.status,409);
 // Fail closed instead of guessing an unknown, expired, malformed workspace.
 const unknown=await fresh.tool('mcpgo_workspace',{workspace_id:'ws_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'});
 assert.equal(unknown.status,409);
 const malformed=await fresh.tool('mcpgo_workspace',{workspace_id:'ws_a'});
 assert.equal(malformed.status,409);
 // Once the fresh client owns other tabs, explicit workspace switch is denied.
 const newTab=await fresh.tool('browser_tabs',{action:'new'});
 assert.equal(newTab.status,200);
 const deniedSwitch=await fresh.tool('mcpgo_workspace',{workspace_id:ws});
 assert.equal(deniedSwitch.status,409);
 const freshOwned=payload(await fresh.tool('mcpgo_tab_handle',{action:'list'})).owned;
 assert.equal(freshOwned.length,1);
 assert.equal((await fresh.tool('mcpgo_tab_action',{action:'close',tab_id:freshOwned[0]})).status,200);
 const wrongStable=client({'x-mcpgo-conversation-id':'another-chat'});await wrongStable.init();
 const stableDenied=await wrongStable.tool('mcpgo_workspace',{workspace_id:ws});
 assert.equal(stableDenied.status,409);
 assert.match(JSON.stringify(stableDenied.result),/WORKSPACE_STABLE_SCOPE_CONFLICT/);
 assert.equal((await reconnect.tool('mcpgo_tab_action',{action:'close',tab_id:tabId,workspace_id:ws})).status,200);
 await reconnect.close();await fresh.close();await wrongStable.close();
});

test('stable conversation identity automatically gets the same workspace without model-supplied ID',async()=>{
 const a=client({'x-mcpgo-conversation-id':'workspace-chat-A'});await a.init();
 const first=await a.tool('mcpgo_workspace',{});
 assert.equal(first.status,200);
 const ws=first.result.result.structuredContent.workspace_id;
 await a.close();
 const again=client({'x-mcpgo-conversation-id':'workspace-chat-A'});await again.init();
 const repeated=await again.tool('mcpgo_workspace',{});
 assert.equal(repeated.result.result.structuredContent.workspace_id,ws);
 assert.equal(payload(repeated).resumed,false,'stable header already binds agent without explicit rebind');
 const other=client({'x-mcpgo-conversation-id':'workspace-chat-B'});await other.init();
 const separate=await other.tool('mcpgo_workspace',{});
 assert.notEqual(separate.result.result.structuredContent.workspace_id,ws);
 await again.close();await other.close();
});


test('owned tab is restored even if the active tab has duplicate URLs',async()=>{
 const owner=client(),other=client();
 await owner.init();await other.init();
 const first=await owner.tool('browser_tabs',{action:'new',url:'https://autosend-owned.test/conversation'});
 assert.equal(first.status,200,JSON.stringify(first.result));
 const ownerHandle=payload(await owner.tool('mcpgo_tab_handle',{action:'list'})).owned[0];
 assert.ok(ownerHandle,'owner receives a stable handle for its unique tab');
 for(let i=0;i<2;i++){
  const duplicate=await other.tool('browser_tabs',{action:'new',url:'https://same-chat.test/conversation'});
  assert.equal(duplicate.status,200,JSON.stringify(duplicate.result));
 }
 const ambiguous=payload(await other.tool('mcpgo_tab_handle',{action:'list'}));
 assert.ok(ambiguous.ambiguous>=2,'same-URL tabs have no safe opaque handle');
 const restore=await owner.tool('browser_snapshot',{});
 assert.equal(restore.status,200,JSON.stringify(restore.result));
 assert.equal(pages.find(page=>page.uid===currentId)?.url,'https://autosend-owned.test/conversation',
   'the proxy restores the unique owner rather than running inside the duplicate tab');
 const owned=payload(await owner.tool('mcpgo_tab_handle',{action:'resolve',tab_id:ownerHandle}));
 assert.equal(owned.current,true);
 await owner.close();await other.close();
});
