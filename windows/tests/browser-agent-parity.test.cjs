const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const url=require('node:url');
const repo=path.resolve(__dirname,'../..');
const required=['restricted-proxy.mjs','action-guard.mjs','agent-scope.mjs',
 'portable-tab-identity.mjs','portable-agent-tabs.mjs','tab-lease-manager.mjs',
 'browser-session-manager.mjs','browser-workspace.mjs','workspace-response.mjs','mcp-modern-protocol.mjs'];

test('Windows package includes the same portable browser-agent logic as macOS',()=>{
 const pkg=require('../package.json');
 const entry=pkg.build.extraResources.find(x=>x.to==='mcpgo-runtime/playwright');
 assert.ok(entry);
 for(const name of required){
  assert.ok(entry.filter.includes(name),'missing Windows packaged module '+name);
  assert.ok(fs.existsSync(path.join(repo,'playwright',name)));
 }
 const runner=fs.readFileSync(path.join(repo,'windows/app/runtime.cjs'),'utf8');
 assert.match(runner,/--shared-browser-context/);
 assert.match(runner,/--background/);
 assert.match(runner,/BrowserActions/);
});

test('portable tab identity and auto-scoped sessions work unchanged on a Windows runtime',async()=>{
 const {PortableAgentTabs}=await import(url.pathToFileURL(path.join(repo,'playwright/portable-agent-tabs.mjs')));
 const {AgentScopeRegistry}=await import(url.pathToFileURL(path.join(repo,'playwright/agent-scope.mjs')));
 const scoped=new AgentScopeRegistry();
 const a=scoped.create(),b=scoped.create(),c=scoped.create();
 assert.equal(new Set([a.agent,b.agent,c.agent]).size,3);
 const tabs=new PortableAgentTabs();
 const first=tabs.refresh('### Result\n- 0: (current) [A](https://a.test)\n- 1: [B](https://b.test)\n- 2: [C](https://c.test)');
 for(const [i,agent] of [a.agent,b.agent,c.agent].entries()){
  assert.ok(tabs.claim(agent,first.tabs[i].id).ok);
 }
 const bId=first.tabs[1].id;
 tabs.refresh('### Result\n- 0: [B](https://b.test)\n- 1: (current) [C](https://c.test)');
 assert.equal(tabs.identities.resolve(bId).index,0);
 assert.equal(tabs.allowed(a.agent,bId).reason,'TAB_OWNED_BY_ANOTHER_AGENT');
 assert.equal(tabs.allowed(b.agent,bId).ok,true);
});
