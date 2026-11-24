'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Runtime}=require('../app/runtime.cjs');
function directory(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-supervisor-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return dir;
}
async function waitFor(fn,timeout=2500){
 const start=Date.now();
 while(Date.now()-start<timeout){
  if(fn())return;
  await new Promise(r=>setTimeout(r,25));
 }
 throw Error('WAIT_TIMEOUT');
}
test('supervisor starts existing JS service, exposes status and cleans process tree',async t=>{
 const dir=directory(t),script=path.join(dir,'playwright/node_modules/@playwright/mcp/cli.js');
 fs.mkdirSync(path.dirname(script),{recursive:true});
 fs.writeFileSync(script,"setInterval(()=>{},1000);\n");
 const agent=new Runtime({resourceRoot:dir,userData:path.join(dir,'user'),
   nodeExecutable:process.execPath,portProbe:async()=>false,credentials:async name=>
     name==='playwrightExtension'?{token:'abcdefghijklmnopqrstuvwxyz012345'}:null});
 t.after(()=>agent.stop());
 agent.running=true;
 await agent.launch('browser');
 await waitFor(()=>agent.state().browser==='running');
 const pid=agent.entries.get('browser').child.pid;
 assert.equal(typeof pid,'number');
 agent.stop();
 assert.equal(agent.state().browser,'stopped');
 assert.equal(agent.running,false);
});
test('missing executable does not masquerade as a connected service',async t=>{
 const dir=directory(t);
 const agent=new Runtime({resourceRoot:dir,userData:path.join(dir,'user'),
   nodeExecutable:path.join(dir,'missing-node'),portProbe:async()=>false,credentials:async()=>null});
 t.after(()=>agent.stop());
 agent.running=true;
 await agent.launch('terminal');
 await waitFor(()=>agent.state().terminal.startsWith('error:'));
 assert.ok(agent.entries.get('terminal').timer);
 agent.stop();
 assert.equal(agent.entries.get('terminal'),undefined);
});

test('foreign listener blocks launch without spawning or retrying',async t=>{
 const dir=directory(t);
 const agent=new Runtime({resourceRoot:dir,userData:path.join(dir,'user'),
   nodeExecutable:process.execPath,portProbe:async()=>true,credentials:async()=>null});
 t.after(()=>agent.stop());
 agent.running=true;
 await agent.launch('terminal');
 assert.equal(agent.state().terminal,'error: PORT_OCCUPIED');
 assert.equal(agent.entries.get('terminal').child,null);
 assert.equal(agent.entries.get('terminal').timer,null);
});

// Exercise the same publication callback as Electron main.cjs on fresh start,
// service changes, restart and before-quit, with no browser token or tunnel.
test('fresh-install readiness publication and shutdown do not throw',async t=>{
 const dir=directory(t);const published=[];
 let agent;
 agent=new Runtime({resourceRoot:dir,userData:path.join(dir,'user'),
  nodeExecutable:path.join(dir,'missing-node'),portProbe:async()=>false,credentials:async()=>null,
  onChange:()=>published.push(agent.readinessState())});
 t.after(()=>agent.stop());
 assert.equal(agent.readinessState().connectionHealth.browser.state,'stopped');
 assert.doesNotThrow(()=>agent.stop());
 await agent.start();
 assert.ok(published.length>0);
 await agent.restart();
 assert.doesNotThrow(()=>agent.stop());
 assert.equal(published.at(-1).connectionHealth.browser.state,'stopped');
 assert.equal(published.at(-1).chrome,null);
});
test('missing browser child and stale failure record never dereference null',t=>{
 const dir=directory(t);const agent=new Runtime({resourceRoot:dir,userData:dir,nodeExecutable:process.execPath,credentials:async()=>null});
 for(const failure of [null,{}, {pid:123,at:Date.now()}]){
  agent.browserVerificationFailure=failure;
  for(const child of [undefined,null,{exitCode:null}]){
   agent.entries.set('browser',{child});
   assert.doesNotThrow(()=>agent.readinessState());
  }
 }
 agent.entries.clear();assert.doesNotThrow(()=>agent.stop());
});
