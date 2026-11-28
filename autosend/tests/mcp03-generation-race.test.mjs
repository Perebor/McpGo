import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const GEN_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function listen(server){
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 return server.address().port;
}
async function fixture(t){
 const folder=await mkdtemp(path.join(os.tmpdir(),'mcpgo-mcp03-race-'));
 const generation=path.join(folder,'generation.json');
 const state=path.join(folder,'state.json');
 const setGeneration=value=>writeFile(generation,JSON.stringify({version:1,generation:value}));
 await setGeneration(GEN_A);
 await writeFile(state,JSON.stringify({version:1,tasks:[],attempts:[]}));
 let announceList,releaseList;
 const listStarted=new Promise(resolve=>announceList=resolve);
 const listReleased=new Promise(resolve=>releaseList=resolve);
 const methods=[];
 const backend=http.createServer(async(req,res)=>{
  try{
   let body='';for await(const chunk of req)body+=chunk;
   const rpc=JSON.parse(body);
   methods.push(rpc.method);
   if(rpc.method==='notifications/initialized'){res.writeHead(202);res.end();return}
   if(!['initialize','tools/list'].includes(rpc.method)){res.writeHead(405);res.end();return}
   let result;
   if(rpc.method==='initialize')result={protocolVersion:'2025-03-26',serverInfo:{name:'isolated-fixture',version:'1'},capabilities:{tools:{}}};
   else{announceList();await listReleased;result={tools:[{name:'browser_tabs'},{name:'browser_snapshot'}]}}
   res.writeHead(200,{'Content-Type':'application/json','mcp-session-id':'fixture-session-1234'});
   res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  }catch{res.writeHead(400);res.end()}
 });
 const backendPort=await listen(backend);
 const spare=http.createServer();
 const port=await listen(spare);await new Promise(resolve=>spare.close(resolve));
 const env={};
 for(const k of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
 Object.assign(env,{APPDATA:folder,LOCALAPPDATA:folder,USERPROFILE:folder,HOME:folder,NODE_ENV:'test',
  MCPHUB_AUTOSEND_PORT:String(port),MCPHUB_AUTOSEND_STATE:state,
  MCPHUB_AUTOSEND_BROWSER_GENERATION_FILE:generation,
  MCPHUB_AUTOSEND_BROWSER_PORT:String(backendPort),
  MCPHUB_AUTOSEND_BROWSER_MCP_URL:'http://127.0.0.1:'+backendPort+'/mcp',
  MCPHUB_AUTOSEND_CHECK_MS:'10000'});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env,stdio:'ignore'});
 t.after(async()=>{
  releaseList();
  if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(2000)]);}
  if(child.exitCode===null)child.kill('SIGKILL');
  backend.closeAllConnections();
  await new Promise(resolve=>backend.close(resolve));
  await rm(folder,{recursive:true,force:true});
 });
 const base='http://127.0.0.1:'+port;
 let headers;
 const status=async()=>{const r=await fetch(base+'/api/status',{headers,signal:AbortSignal.timeout(1500)});assert.equal(r.status,200);return r.json()};
 for(let i=0;i<100;i++){
  try{
   headers={'X-MCPHub-Client':'native','X-MCPHub-Token':(await readFile(path.join(folder,'control-token'),'utf8')).trim(),'Content-Type':'application/json'};
   if((await status()).browserBackendReachable)break;
  }catch{}
  await delay(30);
 }
 assert.equal((await status()).browserBackendReachable,true,'isolated mock backend must be reachable');
 const probe=async()=>{const r=await fetch(base+'/api/tasks',{method:'POST',headers,body:JSON.stringify({action:'probe_extension'}),signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json()};
 return {status,probe,listStarted,releaseList,setGeneration,methods};
}

test('MCP-03 unchanged browser generation accepts the current diagnostic result', {timeout:15000},async t=>{
 const f=await fixture(t);const pending=f.probe();await f.listStarted;f.releaseList();
 const result=await pending;
 assert.equal(result.connected,true);
 const status=await f.status();
 assert.equal(status.extensionTransportConnected,true);
 assert.equal(status.chatTabApprovedCount,0);
 assert.equal(status.extensionConnected,false);
 assert.equal(status.tasks.length,0);
 assert.deepEqual(f.methods,['initialize','notifications/initialized','tools/list']);
});

test('MCP-03 diagnostic from a replaced browser generation must not report healthy', {timeout:15000},async t=>{
 const f=await fixture(t);const pending=f.probe();await f.listStarted;
 await f.setGeneration(GEN_B);
 const afterRestart=await f.status();
 assert.notEqual(afterRestart.extensionTransportConnected,true);
 f.releaseList();const old=await pending;
 assert.equal(old.connected,false,'late response from old generation must be discarded');
 const status=await f.status();
 assert.notEqual(status.extensionTransportConnected,true);
 assert.equal(status.chatTabApprovedCount,0);
 assert.equal(status.tasks.length,0);
 assert.equal(status.attempts.length,0);
 assert.deepEqual(f.methods,['initialize','notifications/initialized','tools/list']);
});

test('MCP-03 rechecks browser generation at diagnostic completion without status polling', {timeout:15000},async t=>{
 const f=await fixture(t);const pending=f.probe();await f.listStarted;
 await f.setGeneration(GEN_B);
 f.releaseList();const old=await pending;
 assert.equal(old.connected,false,'late response must be discarded even without a status reader');
 const status=await f.status();
 assert.notEqual(status.extensionTransportConnected,true);
 assert.equal(status.chatTabApprovedCount,0);
 assert.equal(status.attempts.length,0);
});