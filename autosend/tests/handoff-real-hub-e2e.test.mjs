// Full MCP-11 local fixture: *real* AutoSend HTTP + *real* Python Messaging
// Hub HTTP, separate private stores, archived chat, unread continuity.
// No ChatGPT browser, no installed user DB, no production sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readState} from '../core.mjs';
import {coordinateChatHandoff} from '../handoff-coordinator.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const OLD='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000001';
const NEW='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000002';
const K='e99f2c39-2222-4222-8222-222222222222';
async function freePort(){
 const s=net.createServer();
 await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
 const port=s.address().port;
 await new Promise(resolve=>s.close(resolve));
 return port;
}
async function waitHttp(base,tokenPath){
 let last='no request attempted';
 for(let attempt=0;attempt<110;attempt++){
  try{
   const token=readFileSync(tokenPath,'utf8').trim();
   const response=await get(base,token,'/api/status',{hub:path.basename(path.dirname(tokenPath))==='hub'});
   if(response.status===200)return token;
   last='HTTP '+response.status+' '+JSON.stringify(response.body).slice(0,200);
  }catch(error){last=String(error.message||error)}
  await new Promise(resolve=>setTimeout(resolve,35));
 }
 throw Error('Fixture HTTP service was not ready: '+last);
}
async function shutdown(p){
 if(!p||p.exitCode!==null)return;
 p.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>p.once('close',resolve)),
                   new Promise(resolve=>setTimeout(resolve,1200))]);
 if(p.exitCode===null)p.kill('SIGKILL');
}
function pythonExe(){
 if(process.env.MCPGO_TEST_PYTHON)return process.env.MCPGO_TEST_PYTHON;
 return process.platform==='win32'
  ?path.join(process.env.LOCALAPPDATA||'', 'Programs','McpGo','resources','mcpgo-runtime','python','python.exe')
  :'python3';
}
async function get(base,token,route,{hub=false}={}){
 const u=new URL(base);
 return await new Promise((resolve,reject)=>{
  const req=http.get({hostname:'127.0.0.1',port:Number(u.port),path:route,
   timeout:900,headers:{Host:hub?'127.0.0.1:8971':u.host,
    'X-MCPHub-Client':'native','X-MCPHub-Token':token}},res=>{
    let raw='';
    res.on('data',v=>raw+=String(v));
    res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(raw)})}catch(e){reject(e)}});
    res.on('error',reject);
   });
  req.on('timeout',()=>req.destroy(new Error('GET timeout')));
  req.on('error',reject);
 });
}
test('real Hub+AutoSend fixture copies only unread, preserves receipts and archives old chat, zero Send',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mcpgo11-realhub-'));
 const autoFolder=path.join(folder,'autosend'),hubFolder=path.join(folder,'hub');
 await fs.mkdir(autoFolder);await fs.mkdir(hubFolder);
 const stateFile=path.join(autoFolder,'tasks.json');
 const hubDb=path.join(hubFolder,'messages.sqlite3');
 const autoPort=await freePort(),hubPort=await freePort();
 const autoBase='http://127.0.0.1:'+autoPort,hubBase='http://127.0.0.1:'+hubPort;
 let auto,hub;
 try{
  const hubBootstrap=`
import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import hub
from http.server import ThreadingHTTPServer
hub.DATA=Path(sys.argv[2])
with hub.database() as db:
 hub.register(db,'agent_old','Old','agent',sys.argv[4])
 hub.register(db,'sender','Sender')
 a=hub.send(db,'sender','agent_old','already processed')
 hub.mark_read(db,'agent_old',[a['id']])
 hub.send(db,'sender','agent_old','unread one')
 hub.send(db,'sender','agent_old','unread two')
hub.ensure_owner_token()
with ThreadingHTTPServer(('127.0.0.1',int(sys.argv[3])),hub.Handler) as server:
 print('fixture hub ready',flush=True)
 server.serve_forever()
`;
  hub=spawn(pythonExe(),['-u','-c',hubBootstrap,path.join(ROOT,'messaging'),hubDb,String(hubPort),OLD],{
    stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}
  });
  const hubErr=[];
  hub.stderr.on('data',v=>{if(hubErr.length<5)hubErr.push(String(v).slice(0,500))});
  hub.stdout.on('data',v=>{if(hubErr.length<5)hubErr.push('STDOUT '+String(v).slice(0,200))});
  let hubToken;
  try{hubToken=await waitHttp(hubBase,path.join(hubFolder,'control-token'))}
  catch(e){throw Error(e.message+' '+hubErr.join(' ').slice(0,500))}
  auto=spawn(process.execPath,[path.join(ROOT,'autosend','server.mjs')],{
   env:{...process.env,MCPHUB_AUTOSEND_STATE:stateFile,
     MCPHUB_AUTOSEND_PORT:String(autoPort),MCPHUB_AUTOSEND_BROWSER_PORT:'65412',
     MCPHUB_AUTOSEND_BROWSER_MCP_URL:'http://127.0.0.1:65412/mcp',
     MCPHUB_AUTOSEND_CHECK_MS:'250',NODE_ENV:'test'},
   stdio:['ignore','pipe','pipe']
  });
  const autoToken=await waitHttp(autoBase,path.join(autoFolder,'control-token'));
  const posted=await fetch(autoBase+'/api/tasks',{method:'POST',
    headers:{Host:new URL(autoBase).host,'X-MCPHub-Client':'native',
             'X-MCPHub-Token':autoToken,'Content-Type':'application/json'},
    body:JSON.stringify({action:'create',url:OLD,message:'Approved migration instruction',
       interval_seconds:900,project_label:'Fixture'})});
  assert.equal(posted.status,200);
  const oldTask=(await posted.json()).task;
  const intent={
   auto:{source_id:oldTask.id,target_url:NEW,owner_confirmed_target:NEW,
         idempotency_key:K,checkpoint:{task_id:'MCP-11',branch:'work/mcp11-realhub',
           commit:'a'.repeat(40),evidence_sha256:'b'.repeat(64),
           receipt_id:'receipt-123',last_ack_id:'ack-456',
           summary:'Owner-approved evidence and instructions for continuity'}},
   hub:{old_id:'agent_old',new_id:'agent_new',label:'New fixture chat'}
  };
  const clients={autoPort,hubPort,autoToken,hubToken};
  const receipt=await coordinateChatHandoff(folder,intent,clients);
  assert.equal(receipt.status,'COMPLETE');
  assert.equal(receipt.forwarded,2);
  assert.equal((await coordinateChatHandoff(folder,intent,clients)).status,'ALREADY_COMPLETE');
  const [unread,archived,active,status]=await Promise.all([
    get(hubBase,hubToken,'/api/inbox?agent=agent_new',{hub:true}),
    get(hubBase,hubToken,'/api/agents/archived',{hub:true}),
    get(hubBase,hubToken,'/api/agents',{hub:true}),
    get(autoBase,autoToken,'/api/status')
  ]);
  assert.equal(unread.status,200);
  assert.equal(unread.body.messages.length,2);
  assert.ok(unread.body.messages.some(m=>m.body.includes('unread one')));
  assert.ok(unread.body.messages.some(m=>m.body.includes('unread two')));
  assert.ok(!unread.body.messages.some(m=>m.body.includes('already processed')));
  assert.equal(archived.body.agents.find(x=>x.id==='agent_old').replaced_by,'agent_new');
  assert.equal(active.body.agents.find(x=>x.id==='agent_new').chat_url,NEW);
  assert.equal(status.body.tasks.length,1);
  assert.equal(status.body.tasks[0].enabled,false);
  assert.equal(status.body.tasks[0].url,NEW);
  const autoState=readState(stateFile);
  assert.equal(autoState.tasks.length,2);
  assert.ok(autoState.tasks[0].handoff_archived_at);
  assert.equal(autoState.tasks[1].status,'paused');
  assert.equal(autoState.attempts.length,0);
  assert.equal((await get(hubBase,hubToken,'/api/inbox?agent=agent_old',{hub:true})).status,400);
  const journal=readFileSync(path.join(folder,'.mcpgo-handoff-journal',K+'.json'),'utf8');
  assert.ok(!journal.includes('Owner-approved evidence'));
  assert.ok(!journal.includes(hubToken));
  const raw=readFileSync(stateFile,'utf8');
  assert.ok(!raw.includes('Owner-approved evidence'));
 }finally{
  await shutdown(auto);await shutdown(hub);
  await fs.rm(folder,{recursive:true,force:true,maxRetries:7,retryDelay:120});
 }
});
