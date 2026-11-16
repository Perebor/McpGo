import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {modernParams,modernHeaders,MODERN_PROTOCOL} from '../mcp-modern-protocol.mjs';
const project=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const sparePort=async()=>{
 const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const port=server.address().port;await new Promise(done=>server.close(done));return port;
};
async function send(endpoint,method,params={}){
 const p=modernParams(params,'McpGo-Strict-Cutover-Test');
 const data={jsonrpc:'2.0',id:1,method,params:p};
 const res=await fetch(endpoint,{method:'POST',headers:modernHeaders(method,p),
   body:JSON.stringify(data),signal:AbortSignal.timeout(3000)});
 return {status:res.status,sessionId:res.headers.get('mcp-session-id'),body:await res.json()};
}
async function expectStarted(proc,health){
 for(let i=0;i<75;i++){
  if(proc.exitCode!==null)throw Error('Strict server exited prematurely');
  try{const res=await fetch(health,{signal:AbortSignal.timeout(120)});if(res.ok)return;}
  catch{}await sleep(50);
 }
 throw Error('Strict server readiness timeout');
}
async function stop(proc){
 if(proc.exitCode!==null)return;
 proc.kill('SIGTERM');
 await Promise.race([new Promise(ok=>proc.once('close',ok)),sleep(700)]);
 if(proc.exitCode===null)proc.kill('SIGKILL');
}
test('strict MCP 2026 Browser rejects old initialize but serves discovery without Chrome',async()=>{
 const port=await sparePort();
 const proc=spawn(process.execPath,[join(project,'playwright/restricted-proxy.mjs'),'shared'],{
  env:{...process.env,MCPGO_DISABLE_LEGACY:'1',MCPGO_PROXY_PORT:String(port),
    MCPGO_BACKEND_PORT:'1'},stdio:'ignore'});
 try{
  await expectStarted(proc,`http://127.0.0.1:${port}/healthz`);
  const endpoint=`http://127.0.0.1:${port}/mcp`;
  const d=await send(endpoint,'server/discover');
  assert.equal(d.status,200);assert.equal(d.sessionId,null);
  assert.equal(d.body.result.resultType,'complete');
  assert.deepEqual(d.body.result.supportedVersions,[MODERN_PROTOCOL]);
  const old=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-03-26'}})});
  assert.equal(old.status,400);assert.equal((await old.json()).error.code,-32022);
  const health=await fetch(`http://127.0.0.1:${port}/healthz`).then(r=>r.json());
  assert.equal(health.legacyExternal,false);
 }finally{await stop(proc)}
});
test('strict MCP 2026 Terminal rejects old initialize, modern tools run without sessions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mcpgo-strict-test-'));
 const port=await sparePort();
 const config=join(root,'config.json');
 const proc=spawn(process.execPath,[join(project,'terminal/stateless_server.js')],{
  env:{...process.env,MCPGO_DISABLE_LEGACY:'1',MCPGO_ONESHOT_PORT:String(port),
   MCPGO_ONESHOT_CONFIG:config,MCPGO_TERMINAL_CONFIG:join(root,'terminal.json'),
   MCPGO_JOB_ROOT:join(root,'jobs')},stdio:'ignore'});
 try{
  await expectStarted(proc,`http://127.0.0.1:${port}/health`);
  assert.equal(existsSync(config),true);
  const {mcpPath}=JSON.parse(readFileSync(config,'utf8'));
  const endpoint=`http://127.0.0.1:${port}/${mcpPath}`;
  const d=await send(endpoint,'server/discover');
  assert.equal(d.status,200);assert.equal(d.sessionId,null);
  assert.deepEqual(d.body.result.supportedVersions,[MODERN_PROTOCOL]);
  const l=await send(endpoint,'tools/list');assert.equal(l.status,200);
  assert.ok(l.body.result.tools.some(x=>x.name==='terminal_exec'));
  const old=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18'}})});
  assert.equal(old.status,400);assert.equal((await old.json()).error.code,-32022);
 }finally{await stop(proc);rmSync(root,{recursive:true,force:true})}
});
