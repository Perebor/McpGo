'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Runtime,assertTunnelId,clientArgs,terminalEndpoint,runtimePaths,CORE_SERVICES}=require('../app/runtime.cjs');
test('tunnel keys never appear in command arguments',()=>{
 const args=clientArgs({tunnelId:'tunnel_secure_4',url:'http://127.0.0.1:8940/mcp',
   config:'C:\\tunnel.yaml',healthFile:'C:\\health.url'});
 assert.equal(args.includes('super-secret'),false);
 assert.deepEqual(args.slice(0,2),['run','--config']);
 assert.equal(args[args.indexOf('--control-plane.api-key')+1],'env:CONTROL_PLANE_API_KEY');
 for(const unsafe of ['http://evil/mcp','http://0.0.0.0:8940/mcp','http://127.0.0.1:8940/secret'])
   assert.throws(()=>clientArgs({tunnelId:'tunnel_valid',url:unsafe}),/INVALID_LOCAL_MCP_URL/);
 assert.throws(()=>assertTunnelId('tunnel_../bad'),/INVALID_TUNNEL_ID/);
});
test('private terminal endpoint is validated and never hardcoded',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-win-test-'));
 try{
  const config=path.join(root,'config.json');
  assert.throws(()=>terminalEndpoint(config),/ENOENT/);
  fs.writeFileSync(config,JSON.stringify({mcpPath:'exec/'+'a'.repeat(64)}));
  assert.equal(terminalEndpoint(config),'http://127.0.0.1:12848/exec/'+'a'.repeat(64));
  fs.writeFileSync(config,JSON.stringify({mcpPath:'../../secrets'}));
  assert.throws(()=>terminalEndpoint(config),/INVALID_LOCAL_MCP_CONFIG/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('Windows plans reuse existing MCP source rather than a second fork',async()=>{
 const root='C:\\McpGo';
 const p=runtimePaths(root,'C:\\User\\McpGo');
 assert.match(p.terminal,/stateless_server.js$/);
 assert.match(p.browser,/cli.js$/);
 const runtime=new Runtime({resourceRoot:root,userData:'C:\\User\\McpGo',
   nodeExecutable:'McpGo.exe',credentials:()=>null,browser:'msedge'});
 assert.deepEqual((await runtime.plan('terminal')).args.slice(0,1),[p.terminal]);
 assert.equal((await runtime.plan('terminal')).env.ELECTRON_RUN_AS_NODE,'1');
 assert.ok((await runtime.plan('terminal')).env.MCPGO_NODE_PTY_MODULE);
 assert.equal('stateful' in runtime.state(),false);
 assert.equal(await runtime.plan('terminalTunnel'),null);
});


test('dedicated AutoSend browser is a core Windows service, isolated from Browser MCP',async t=>{
 assert.ok(CORE_SERVICES.includes('autosendBrowser'));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-windows-browser-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cli=path.join(root,'playwright','node_modules','@playwright','mcp','cli.js');
 fs.mkdirSync(path.dirname(cli),{recursive:true});
 fs.writeFileSync(cli,'');
 const calls=[];
 const secret='abcdefghijklmnopqrstuvwxyz012345';
 const runtime=new Runtime({resourceRoot:root,userData:path.join(root,'data'),
  nodeExecutable:'node.exe',credentials:async name=>{
   calls.push(name);
   return name==='playwrightExtension'?{token:secret}:null;
  },browser:'msedge'});
 const agent=await runtime.plan('browser');
 const autosend=await runtime.plan('autosendBrowser');
 assert.ok(agent.args.includes('--extension'));
 assert.ok(autosend.args.includes('--extension'));
 assert.ok(agent.args.includes('--shared-browser-context'));
 assert.ok(autosend.args.includes('--shared-browser-context'));
 assert.equal(agent.args[agent.args.indexOf('--port')+1],'8931');
 assert.equal(autosend.args[autosend.args.indexOf('--port')+1],'8932');
 assert.equal(autosend.env.PLAYWRIGHT_MCP_SESSION_NAME,'MCPGO AutoSend');
 assert.equal(autosend.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN,secret);
 assert.equal(agent.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN,secret);
 assert.ok(!autosend.args.includes(secret),'never leak browser token in command arguments');
 assert.ok(!agent.args.includes(secret),'never leak browser token in command arguments');
 assert.ok(calls.every(name=>name==='playwrightExtension'));
});
test('Windows fails closed when official Extension token has not been configured',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-windows-browser-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cli=path.join(root,'playwright','node_modules','@playwright','mcp','cli.js');
 fs.mkdirSync(path.dirname(cli),{recursive:true});
 fs.writeFileSync(cli,'');
 const runtime=new Runtime({resourceRoot:root,userData:path.join(root,'data'),
  nodeExecutable:'node.exe',credentials:async()=>null,browser:'chrome'});
 assert.equal(await runtime.plan('browser'),null);
 assert.equal(await runtime.plan('autosendBrowser'),null);
});
