import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {newTask,writeState,readState} from '../core.mjs';
import {planChatHandoff} from '../chat-handoff.mjs';
import {coordinateChatHandoff,reconcileChatHandoff,readHandoffJournal} from '../handoff-coordinator.mjs';

const OLD='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000001';
const NEW='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000002';
const KEY='e99f2c39-2222-4222-8222-222222222222';
const token='e'.repeat(64),hubToken='f'.repeat(64);
function intent(changes={}){
 return {auto:{source_id:'fixture-old',target_url:NEW,owner_confirmed_target:NEW,
  idempotency_key:KEY,
  checkpoint:{task_id:'MCP-11',branch:'work/mcp11-checkpoint',commit:'a'.repeat(40),
   evidence_sha256:'b'.repeat(64),receipt_id:'receipt-123',last_ack_id:'ack-456',
   summary:'Owner-approved evidence to continue after migration'}},
  hub:{old_id:'agent_old',new_id:'agent_new',label:'Fixture new chat'},
  ...changes};
}
function env(){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mcpgo11-saga-'));
 const stateFile=path.join(folder,'tasks.json');
 const source=newTask({url:OLD,message:'Owner source instruction',interval_seconds:900});
 source.id='fixture-old';
 writeState({version:1,tasks:[source],attempts:[]},stateFile);
 const registry={old:{id:'agent_old',role:'agent',archived_at:'',replaced_by:''},
   new:null,unread:['message:100','message:101'],forwarded:[],calls:0,replyLost:false,refuse:false};
 let autoCalls=0,hubCalls=0;
 const autosend=http.createServer(async(req,res)=>{
  assert.equal(req.headers['x-mcphub-token'],token);
  assert.equal(req.headers['x-mcphub-client'],'native');
  if(req.method==='GET'&&req.url==='/api/status'){
   const tasks=readState(stateFile).tasks.filter(t=>!t.handoff_archived_at).map(t=>({
    id:t.id,url:t.url,enabled:t.enabled,status:t.status
   }));
   return reply(res,200,{ok:true,tasks});
  }
  const data=await collect(req);
  if(req.method!=='POST'||req.url!=='/api/tasks')return reply(res,404,{error:'route'});
  autoCalls++;
  try{
   assert.equal(data.action,'handoff_chat');
   const {state,receipt}=planChatHandoff(readState(stateFile),{
    source_id:data.source_id,target_url:data.target_url,
    owner_confirmed_target:data.owner_confirmed_target,
    idempotency_key:data.idempotency_key,checkpoint:data.checkpoint
   },{newId:'fixture-new'});
   if(receipt.status==='STAGED_PAUSED')writeState(state,stateFile);
   reply(res,200,{ok:true,...receipt});
  }catch(error){reply(res,400,{error:error.message})}
 });
 const hub=http.createServer(async(req,res)=>{
  assert.equal(req.headers['x-mcphub-token'],hubToken);
  assert.equal(req.headers['x-mcphub-client'],'native');
  if(req.method==='GET'){
   if(req.url==='/api/agents')return reply(res,200,{agents:[registry.new||registry.old].filter(x=>x&&!x.archived_at)});
   if(req.url==='/api/agents/archived')return reply(res,200,{agents:registry.old.archived_at?[registry.old]:[]});
   return reply(res,404,{error:'route'});
  }
  if(req.method!=='POST'||req.url!=='/api/agents/replace')return reply(res,404,{error:'route'});
  const data=await collect(req);hubCalls++;
  if(registry.refuse)return reply(res,403,{error:'owner decision required'});
  if(data.old_id!=='agent_old'||data.id!=='agent_new'||registry.old.archived_at)
   return reply(res,400,{error:'invalid'});
  registry.new={id:'agent_new',role:'agent',archived_at:'',replaced_by:'',chat_url:data.chat_url};
  registry.old.archived_at=new Date().toISOString();
  registry.old.replaced_by='agent_new';
  registry.forwarded=[...registry.unread];
  registry.unread=[];
  if(registry.replyLost){req.socket.destroy();return}
  reply(res,200,{agent:registry.new,archived:'agent_old',forwarded:registry.forwarded.length});
 });
 return {folder,stateFile,autosend,hub,registry,
  autoCalls:()=>autoCalls,hubCalls:()=>hubCalls};
}
async function collect(req){
 let b='';for await(const chunk of req)b+=chunk;
 return JSON.parse(b);
}
function reply(res,status,data){
 res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
}
async function listen(server){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return server.address().port;
}
async function fixture(fn){
 const f=env();
 try{
  const autoPort=await listen(f.autosend),hubPort=await listen(f.hub);
  const clients={autoPort,hubPort,autoToken:token,hubToken};
  await fn(f,clients);
 }finally{
  await Promise.all([new Promise(resolve=>f.autosend.close(resolve)),
                     new Promise(resolve=>f.hub.close(resolve))]);
  fs.rmSync(f.folder,{recursive:true,force:true});
 }
}
test('real two-service HTTP sequence stages AutoSend paused, forwards Hub unread once and journals complete',async()=>{
 await fixture(async(f,clients)=>{
  const result=await coordinateChatHandoff(f.folder,intent(),clients);
  assert.equal(result.status,'COMPLETE');
  assert.equal(result.target_task_id,'fixture-new');
  assert.equal(result.forwarded,2);
  assert.equal(f.autoCalls(),1);assert.equal(f.hubCalls(),1);
  assert.equal(readState(f.stateFile).tasks.length,2);
  assert.equal(readState(f.stateFile).tasks[1].enabled,false);
  assert.equal(f.registry.old.replaced_by,'agent_new');
  assert.deepEqual(f.registry.forwarded,['message:100','message:101']);
  const replay=await coordinateChatHandoff(f.folder,intent(),clients);
  assert.equal(replay.status,'ALREADY_COMPLETE');
  assert.equal(f.autoCalls(),1);assert.equal(f.hubCalls(),1);
  const journal=readHandoffJournal(f.folder,KEY);
  assert.equal(journal.stage,'COMPLETE');
  assert.equal(JSON.stringify(journal).includes(token),false);
  assert.equal(JSON.stringify(journal).includes('Owner-approved evidence'),false);
 });
});
test('hub commits replacement then response disappears: no replay, reconcile with read-only GET',async()=>{
 await fixture(async(f,clients)=>{
  f.registry.replyLost=true;
  const result=await coordinateChatHandoff(f.folder,intent(),clients);
  assert.equal(result.status,'UNKNOWN');
  assert.equal(f.hubCalls(),1);
  const replay=await coordinateChatHandoff(f.folder,intent(),clients);
  assert.equal(replay.status,'NEED_OWNER');
  assert.equal(f.hubCalls(),1);
  const fixed=await reconcileChatHandoff(f.folder,KEY,clients);
  assert.equal(fixed.status,'COMPLETE');
  assert.equal(f.hubCalls(),1);
  assert.deepEqual(f.registry.forwarded,['message:100','message:101']);
 });
});
test('hub rejects registered replacement: AutoSend stays paused, unread remains, owner required',async()=>{
 await fixture(async(f,clients)=>{
  f.registry.refuse=true;
  const result=await coordinateChatHandoff(f.folder,intent(),clients);
  assert.equal(result.status,'NEED_OWNER');
  assert.equal(readState(f.stateFile).tasks.length,2);
  assert.equal(readState(f.stateFile).tasks[1].enabled,false);
  assert.equal(f.hubCalls(),1);assert.equal(f.registry.unread.length,2);
  assert.equal((await coordinateChatHandoff(f.folder,intent(),clients)).status,'NEED_OWNER');
  assert.equal(f.hubCalls(),1);
 });
});
test('same intent key with modified owner target fails without network activity',async()=>{
 await fixture(async(f,clients)=>{
  await coordinateChatHandoff(f.folder,intent(),clients);
  const changed=intent();
  changed.auto={...changed.auto,checkpoint:{...changed.auto.checkpoint,summary:'A completely different owner-confirmed summary'}};
  await assert.rejects(coordinateChatHandoff(f.folder,changed,clients),/conflict|key|fingerprint/i);
  assert.equal(f.hubCalls(),1);assert.equal(f.autoCalls(),1);
 });
});

test('read-only reconcile rejects wrong new chat URL or active replacement, without replaying Hub POST',async()=>{
 await fixture(async(f,clients)=>{
  f.registry.replyLost=true;
  const result=await coordinateChatHandoff(f.folder,intent(),clients);
  assert.equal(result.status,'UNKNOWN');
  f.registry.new.chat_url='https://chatgpt.com/c/00000000-0000-4000-8000-000000000099';
  assert.equal((await reconcileChatHandoff(f.folder,KEY,clients)).status,'NEED_OWNER');
  f.registry.new.chat_url=NEW;
  const state=readState(f.stateFile);
  state.tasks[1].enabled=true;state.tasks[1].status='scheduled';
  state.tasks[1].next_at=new Date(0).toISOString();
  writeState(state,f.stateFile);
  assert.equal((await reconcileChatHandoff(f.folder,KEY,clients)).status,'NEED_OWNER');
  assert.equal(f.hubCalls(),1);
 });
});
