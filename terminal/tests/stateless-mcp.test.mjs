import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {modernHeaders,modernParams,MODERN_PROTOCOL,SERVER_META_KEY} from '../../playwright/mcp-modern-protocol.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo-mcp-test-'));
const config=path.join(root,'config.json'),data=path.join(root,'jobs');
const sparePort=()=>new Promise(resolve=>{
 const l=net.createServer().listen(0,'127.0.0.1',()=>{const p=l.address().port;l.close(()=>resolve(p))});
});
const port=await sparePort();
const binary=fileURLToPath(new URL('../stateless_server.js',import.meta.url));
const processMcp=spawn(process.execPath,[binary],{env:{...process.env,
 MCPGO_ONESHOT_PORT:String(port),MCPGO_ONESHOT_CONFIG:config,MCPGO_JOB_ROOT:data,
 MCPGO_TERMINAL_SYNC_WAIT_MS:'750'},
 stdio:['ignore','pipe','pipe']});
let stderr='';processMcp.stderr.on('data',b=>stderr+=b.toString().slice(-800));
for(let i=0;i<70;i++){
 if(processMcp.exitCode!==null)throw Error('Server exited: '+stderr);
 try{
  const status=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(100)});
  if(status.ok)break;
 }catch{}
 await new Promise(r=>setTimeout(r,50));
}
if(!fs.existsSync(config))throw Error('No isolated MCP configuration: '+stderr);
const endpoint='http://127.0.0.1:'+port+'/'+JSON.parse(fs.readFileSync(config,'utf8')).mcpPath;
after(async()=>{
 processMcp.kill('SIGTERM');
 if(processMcp.exitCode===null)await new Promise(resolve=>processMcp.once('close',resolve));
 fs.rmSync(root,{recursive:true,force:true});
});
let sequence=0;
async function tool(method,params={}){
 const wrapped=modernParams(params,'McpGoTests');
 const res=await fetch(endpoint,{method:'POST',headers:modernHeaders(method,wrapped),body:
  JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params:wrapped})});
 const response=await res.json();
 assert.equal(res.status,200,JSON.stringify(response));
 assert.notEqual(response.result?.isError,true,JSON.stringify(response));
 assert.equal(response.result?.resultType,'complete');
 assert.equal(res.headers.get('mcp-session-id'),null);
 return method==='tools/call'?JSON.parse(response.result.content[0].text):response.result;
}
test('Terminal supports modern stateless MCP alongside temporary existing ChatGPT compatibility',async()=>{
 const discover=await tool('server/discover');
 const expected=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../mcp-version.json',import.meta.url)),'utf8')).version;
 assert.deepEqual(discover.supportedVersions,[MODERN_PROTOCOL]);
 assert.equal(discover._meta[SERVER_META_KEY].version,expected);
 assert.equal(expected,'1.3.0');
 const old=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})});
 assert.equal(old.status,200);assert.equal((await old.json()).result.protocolVersion,'2025-06-18');
});
test('modern MCP rejects session IDs without touching terminal state',async()=>{
 const params=modernParams({},'McpGoTests');
 const response=await fetch(endpoint,{method:'POST',headers:{...modernHeaders('tools/list',params),
  'Mcp-Session-Id':'old-session-id'},body:JSON.stringify({jsonrpc:'2.0',id:456,
  method:'tools/list',params})});
 assert.equal(response.status,400);
 assert.match((await response.json()).error.message,/Mcp-Session-Id/);
});
test('MCP advertises durability, watch, pagination and cancel tools',async()=>{
 const names=(await tool('tools/list')).tools.map(x=>x.name);
 for(const n of ['job_start','job_recent','job_status','job_watch','job_logs','job_result','job_output','job_cancel'])
  assert.ok(names.includes(n),n);
});
test('MCP calls preserve job identity and return persisted completion',async()=>{
 const request={command:'printf hello',request_id:'mcp-recovery-0001'};
 const a=await tool('tools/call',{name:'job_start',arguments:request});
 const b=await tool('tools/call',{name:'job_start',arguments:request});
 assert.equal(a.job_id,b.job_id);assert.equal(b.deduplicated,true);
 let status=await tool('tools/call',{name:'job_watch',arguments:{job_id:a.job_id,wait_ms:2500}});
 for(let i=0;i<20&&status.state!=='exited';i++)
  status=await tool('tools/call',{name:'job_watch',arguments:{job_id:a.job_id,wait_ms:250}});
 assert.equal(status.state,'exited');assert.equal(status.exit_code,0);
 const final=await tool('tools/call',{name:'job_result',arguments:{job_id:a.job_id}});
 assert.equal(final.result_ready,true);assert.equal(final.summary.version,1);
 const chunk=await tool('tools/call',{name:'job_output',arguments:{job_id:a.job_id,max_bytes:100}});
 assert.equal(Buffer.from(chunk.data_base64,'base64').toString(),'hello');
 const recent=await tool('tools/call',{name:'job_recent',arguments:{limit:1}});
 assert.equal(recent.jobs[0].job_id,a.job_id);
});

test('ordinary terminal_exec creates a durable operation ID and can be recovered without guessing',async()=>{
 const request_id='exec-durable-0007';
 const first=await tool('tools/call',{name:'terminal_exec',
  arguments:{command:'printf durable-hello',request_id}});
 assert.match(first.job_id,/^[a-f0-9]{48}$/);
 assert.equal(first.operation_id,first.job_id);
 assert.equal(first.exit_code,0);
 assert.equal(first.result_ready,true);
 assert.match(first.stdout,/durable-hello/);
 const repeated=await tool('tools/call',{name:'terminal_exec',
  arguments:{command:'printf durable-hello',request_id}});
 assert.equal(repeated.job_id,first.job_id);
 assert.equal(repeated.deduplicated,true);
 const recovery=await tool('tools/call',{name:'mcpgo_recover',arguments:{limit:20}});
 assert.ok(recovery.operations.jobs.some(x=>x.job_id===first.job_id));
 assert.ok(Array.isArray(recovery.resources.locks));
});
test('terminal_exec promotes to an existing durable job instead of holding the MCP stream',async()=>{
 const marker=path.join(root,'promoted-marker.txt');
 const cmd='sleep 1.6; printf x >> '+JSON.stringify(marker);
 const request={command:cmd,request_id:'promote-idempotent-001'};
 const startedAt=Date.now();
 const first=await tool('tools/call',{name:'terminal_exec',arguments:request});
 assert.ok(Date.now()-startedAt<1500,'must not wait until command finishes');
 assert.match(first.job_id,/^[a-f0-9]{48}$/);
 assert.equal(first.wait_limit_ms,750);
 assert.equal(first.job_timeout_ms,1200000);
 assert.equal(first.result_ready,false);
 assert.equal(first.promoted_to_job,true);
 assert.equal(first.exit_code,null);
 assert.match(first.note,/NOT cancelled/);
 const duplicate=await tool('tools/call',{name:'terminal_exec',arguments:request});
 assert.equal(duplicate.job_id,first.job_id);
 assert.equal(duplicate.deduplicated,true);
 let status=await tool('tools/call',{name:'job_status',arguments:{job_id:first.job_id}});
 for(let i=0;i<20&&status.state!=='exited';i++){
  await new Promise(resolve=>setTimeout(resolve,150));
  status=await tool('tools/call',{name:'job_status',arguments:{job_id:first.job_id}});
 }
 assert.equal(status.state,'exited');
 assert.equal(status.exit_code,0);
 const final=await tool('tools/call',{name:'job_result',arguments:{job_id:first.job_id}});
 assert.equal(final.result_ready,true);
 assert.equal(fs.readFileSync(marker,'utf8'),'x','same request_id must not execute command twice');
});
test('explicit command timeout remains enforced after promotion',async()=>{
 const first=await tool('tools/call',{name:'terminal_exec',arguments:{
  command:'sleep 5',timeout_ms:1200,request_id:'promotion-timeout-001'}});
 assert.equal(first.promoted_to_job,true);
 assert.equal(first.job_timeout_ms,1200);
 let status=await tool('tools/call',{name:'job_status',arguments:{job_id:first.job_id}});
 for(let i=0;i<25&&!['exited','cancelled','launch_error'].includes(status.state);i++){
  await new Promise(resolve=>setTimeout(resolve,150));
  status=await tool('tools/call',{name:'job_status',arguments:{job_id:first.job_id}});
 }
 assert.equal(status.timed_out,true);
 const final=await tool('tools/call',{name:'job_result',arguments:{job_id:first.job_id}});
 assert.equal(final.result_ready,true);
 assert.equal(final.timed_out,true);
});
test('lock contention refuses the second conflicting command but allows independent agent',async()=>{
 const resource_key='deploy:gafus-prod';
 const first=await tool('tools/call',{name:'job_start',arguments:{
  command:'sleep 2; printf release-done',resource_key,request_id:'deploy-lock-0001'}});
 const blockedParams=modernParams({name:'terminal_exec',arguments:{command:'printf conflict',resource_key}},'McpGoTests');
 const blocked=await fetch(endpoint,{method:'POST',headers:modernHeaders('tools/call',blockedParams),
  body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:blockedParams})});
 const blockedPayload=await blocked.json();
 assert.equal(blockedPayload.result.isError,true);
 assert.match(blockedPayload.result.content[0].text,/RESOURCE_BUSY/);
 const independent=await tool('tools/call',{name:'terminal_exec',
  arguments:{command:'printf independent',resource_key:'release:other-project'}});
 assert.equal(independent.exit_code,0);
 const status=await tool('tools/call',{name:'resource_lock_status',
  arguments:{resource_key}});
 assert.equal(status.owner_job_id,first.job_id);
 for(let i=0;i<20;i++){
  const s=await tool('tools/call',{name:'job_status',arguments:{job_id:first.job_id}});
  if(s.state==='exited')break;
  await new Promise(resolve=>setTimeout(resolve,160));
 }
 assert.equal((await tool('tools/call',{name:'job_status',
  arguments:{job_id:first.job_id}})).exit_code,0);
 const after=await tool('tools/call',{name:'terminal_exec',
  arguments:{command:'printf lock-reused',resource_key}});
 assert.equal(after.exit_code,0);
});
test('four independent jobs run concurrently without a global resource mutex',async()=>{
 const jobs=await Promise.all([1,2,3,4].map(i=>tool('tools/call',{
  name:'job_start',arguments:{command:'sleep 2; printf agent-'+i,resource_key:'custom:agent'+i}
 })));
 assert.equal(new Set(jobs.map(j=>j.job_id)).size,4);
 // None should be rejected due to an unrelated resource.
 await Promise.all(jobs.map(async j=>{
  for(let i=0;i<25;i++){
   const s=await tool('tools/call',{name:'job_status',arguments:{job_id:j.job_id}});
   if(s.state==='exited'){assert.equal(s.exit_code,0);return}
   await new Promise(resolve=>setTimeout(resolve,170));
  }
  assert.fail('Independent job did not complete');
 }));
});

// The native macOS zsh PTY runs the user's interactive startup environment.
// Ubuntu CI has system-wide zsh compinit prompts that can steal terminal input;
// Windows exercises its own ConPTY tests. Keep the real PTY test on macOS.
test('unified listener advertises PTY tools and local dashboard without creating a shell',async()=>{
 const names=(await tool('tools/list')).tools.map(t=>t.name);
 for(const name of ['terminal_create','terminal_send','terminal_read','terminal_interrupt','terminal_close'])
   assert.ok(names.includes(name),name);
 const dashboard=await fetch('http://127.0.0.1:'+port+'/');
 assert.equal(dashboard.status,200);
 assert.match(await dashboard.text(),/терминал/i);
 const unauthorized=await fetch('http://127.0.0.1:'+port+'/api/sessions');
 assert.equal(unauthorized.status,401);
});

test('interactive PTY and local dashboard use the same MCP HTTP listener',
  {skip:process.platform!=='darwin'?'native macOS PTY test':false},async()=>{
 const names=(await tool('tools/list')).tools.map(t=>t.name);
 for(const name of ['terminal_create','terminal_send','terminal_read','terminal_interrupt','terminal_close'])
  assert.ok(names.includes(name),name);
 const dashboard=await fetch('http://127.0.0.1:'+port+'/');
 assert.equal(dashboard.status,200);
 assert.match(await dashboard.text(),/терминал/i);
 const unauthorized=await fetch('http://127.0.0.1:'+port+'/api/sessions');
 assert.equal(unauthorized.status,401);
 const created=await tool('tools/call',{name:'terminal_create',arguments:{name:'unified-mcp-test'}});
 // PTY occupancy prevents an idle-only restart of the unified listener.

 assert.ok(created.session_id&&created.session_key);
 const occupied=await (await fetch('http://127.0.0.1:'+port+'/health')).json();
 assert.equal(occupied.interactive_sessions,1);
 try{
  await tool('tools/call',{name:'terminal_send',arguments:{session_id:created.session_id,
   session_key:created.session_key,text:'printf \"MCPGO_UNIFIED_%s\" PTY',enter:true}});
  let output='',since=0;
  for(let i=0;i<50;i++){
   const next=await tool('tools/call',{name:'terminal_read',arguments:{session_id:created.session_id,
    session_key:created.session_key,since}});
   since=next.next;output+=next.text;
   if(output.includes('MCPGO_UNIFIED_PTY'))break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.match(output,/MCPGO_UNIFIED_PTY/);
  const denied=await tool('tools/call',{name:'terminal_read',arguments:{session_id:created.session_id,
   session_key:'wrong',since:0}}).catch(e=>String(e));
  assert.match(String(denied),/SESSION_NOT_FOUND_OR_FORBIDDEN/);
 }finally{
  await tool('tools/call',{name:'terminal_close',arguments:{session_id:created.session_id,
   session_key:created.session_key}});
 }
});
