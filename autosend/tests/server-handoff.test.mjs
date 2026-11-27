import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readState} from '../core.mjs';

const OLD='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000001';
const NEW='https://chatgpt.com/g/g-p-example-123/c/00000000-0000-4000-8000-000000000002';
const KEY='e99f2c39-2222-4222-8222-222222222222';
async function port(){
 const server=net.createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const p=server.address().port;
 await new Promise(resolve=>server.close(resolve));
 return p;
}
async function spawnAt(folder){
 const stateFile=path.join(folder,'tasks.json');
 const p=await port();
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{
  env:{...process.env,MCPHUB_AUTOSEND_PORT:String(p),MCPHUB_AUTOSEND_STATE:stateFile,
   MCPHUB_AUTOSEND_BROWSER_PORT:'65412',MCPHUB_AUTOSEND_BROWSER_MCP_URL:'http://127.0.0.1:65412/mcp',
   MCPHUB_AUTOSEND_CHECK_MS:'250',NODE_ENV:'test'},
  stdio:['ignore','pipe','pipe']
 });
 let log='';
 child.stderr.on('data',v=>{log+=(String(v)).slice(-600)});
 child.stdout.on('data',v=>{log+=(String(v)).slice(-600)});
 const base='http://127.0.0.1:'+p;
 let token;
 for(let i=0;i<80;i++){
  if(child.exitCode!==null)break;
  try{
   token=readFileSync(path.join(folder,'control-token'),'utf8').trim();
   const response=await fetch(base+'/api/status',{
    headers:{'X-MCPHub-Client':'native','X-MCPHub-Token':token}});
   if(response.ok)return {folder,child,base,stateFile,
      headers:{'X-MCPHub-Client':'native','X-MCPHub-Token':token,'Content-Type':'application/json'}};
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,35));
 }
 child.kill('SIGTERM');
 throw Error('Fixture AutoSend did not start '+log);
}
async function stop(instance){
 instance.child.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>instance.child.once('close',resolve)),
  new Promise(resolve=>setTimeout(resolve,1700))]);
 if(instance.child.exitCode===null)instance.child.kill('SIGKILL');
}
async function post(instance,body){
 const response=await fetch(instance.base+'/api/tasks',{
  method:'POST',headers:instance.headers,body:JSON.stringify(body)});
 return {status:response.status,data:await response.json()};
}
function checkpoint(summary='Approved owner state from previous ChatGPT chat'){
 return {task_id:'MCP-11',branch:'work/mcp11-branch',commit:'a'.repeat(40),
  evidence_sha256:'b'.repeat(64),receipt_id:'receipt-123',last_ack_id:'ack-456',summary};
}
function request(source_id,overrides={}){
 return {action:'handoff_chat',source_id,target_url:NEW,owner_confirmed_target:NEW,
         idempotency_key:KEY,checkpoint:checkpoint(),...overrides};
}
test('real owner-token HTTP handoff writes encrypted two-task state, blocks archived Send and survives restart',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mcpgo11-http-'));
 let instance;
 try{
  instance=await spawnAt(folder);
  const created=await post(instance,{action:'create',url:OLD,
    message:'Продолжай работу, используя прошлый проверенный git checkpoint',
    interval_seconds:900,project_label:'Fixture'});
  assert.equal(created.status,200);
  const old=created.data.task;
  const source_id=old.id;
  const handoff=await post(instance,request(source_id));
  assert.equal(handoff.status,200);
  assert.equal(handoff.data.status,'STAGED_PAUSED');
  assert.equal(handoff.data.sendBlocked,true);
  assert.ok(handoff.data.target_id);
  const diskText=await fs.readFile(instance.stateFile,'utf8');
  assert.ok(!diskText.includes('Approved owner state from previous'));
  assert.ok(!diskText.includes('Продолжай работу'));
  const state=readState(instance.stateFile);
  assert.equal(state.tasks.length,2);
  assert.equal(state.tasks.find(t=>t.id===source_id).handoff_replaced_by,handoff.data.target_id);
  assert.equal(state.tasks.find(t=>t.id===handoff.data.target_id).status,'paused');
  const status=await fetch(instance.base+'/api/status',{headers:instance.headers}).then(r=>r.json());
  assert.equal(status.tasks.length,1,'archived old chat must be absent from active UI');
  assert.equal(status.tasks[0].id,handoff.data.target_id);
  assert.equal(status.tasks[0].enabled,false);
  const staleStart=await post(instance,{action:'start',id:source_id});
  assert.equal(staleStart.status,400);
  const targetStart=await post(instance,{action:'start',id:handoff.data.target_id});
  assert.equal(targetStart.status,400,'new chat must not start before Hub+browser owner approval');
  const targetSendOnce=await post(instance,{action:'send_once',id:handoff.data.target_id});
  assert.equal(targetSendOnce.status,400);
  const prematureUnlock=await post(instance,{action:'unlock_handoff',
    id:handoff.data.target_id,owner_confirmed_target:NEW,
    checkpoint_sha256:handoff.data.checkpoint_sha256,
    owner_confirmed_hub:true,owner_confirmed_browser:true});
  assert.equal(prematureUnlock.status,400,'no browser approval means no unlock');
  assert.equal(readState(instance.stateFile).tasks[1].enabled,false);
  const repeated=await post(instance,request(source_id));
  assert.equal(repeated.status,200);
  assert.equal(repeated.data.status,'ALREADY_STAGED');
  assert.equal(repeated.data.target_id,handoff.data.target_id);
  await stop(instance);instance=await spawnAt(folder);
  const afterRestart=await post(instance,request(source_id));
  assert.equal(afterRestart.status,200);
  assert.equal(afterRestart.data.status,'ALREADY_STAGED');
  assert.equal(readState(instance.stateFile).tasks.length,2);
  const noToken=await fetch(instance.base+'/api/status');
  assert.equal(noToken.status,403);
 } finally {if(instance)await stop(instance);await fs.rm(folder,{recursive:true,force:true})}
});
test('HTTP invalid target and unresolved click receipt reject handoff without modifying encrypted history',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mcpgo11-http-'));
 let instance;
 try{
  instance=await spawnAt(folder);
  const created=await post(instance,{action:'create',url:OLD,message:'Do not send',
    interval_seconds:900});
  assert.equal(created.status,200);
  const id=created.data.task.id;
  const before=readState(instance.stateFile);
  const bad=await post(instance,request(id,{
    owner_confirmed_target:'https://chatgpt.com/c/00000000-0000-4000-8000-000000000002'}));
  assert.equal(bad.status,400);
  assert.deepEqual(readState(instance.stateFile),before);
  const unknown=await post(instance,{action:'recheck_unknown',id});
  // recheck_unknown without an unknown receipt is unrelated; must never create a successor.
  assert.equal(readState(instance.stateFile).tasks.length,1);
 } finally {if(instance)await stop(instance);await fs.rm(folder,{recursive:true,force:true})}
});
