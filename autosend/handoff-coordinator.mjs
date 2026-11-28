// MCP-11 local owner-controlled, crash-stop two-service handoff saga.
// The AutoSend JSON and Messaging Hub SQLite cannot commit atomically together.
// NEVER retry an unknown side effect; read-only reconcile or NEED_OWNER.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {normalizeTarget} from './core.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const HEX=/^[a-f0-9]{64}$/;
function fingerprint(item){
 return crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
}
function validateIntent(intent){
 if(!intent||typeof intent!=='object'||Array.isArray(intent)||
    Object.keys(intent).sort().join(',')!=='auto,hub')
  throw Error('Invalid cross-service intent');
 const auto=intent.auto,hub=intent.hub;
 if(!auto||!hub||Object.keys(auto).sort().join(',')!==
    'checkpoint,idempotency_key,owner_confirmed_target,source_id,target_url'||
    Object.keys(hub).sort().join(',')!=='label,new_id,old_id')
  throw Error('Invalid scoped intent schema');
 if(!UUID.test(auto.idempotency_key)||typeof auto.source_id!=='string'||
    !auto.source_id||auto.source_id.length>120)
  throw Error('Invalid stable handoff identity');
 const canonical=normalizeTarget(auto.target_url);
 if(auto.owner_confirmed_target!==canonical)
  throw Error('Owner must approve exact canonical ChatGPT URL');
 if(!ID.test(hub.old_id)||!ID.test(hub.new_id)||hub.old_id===hub.new_id||
    typeof hub.label!=='string'||hub.label.trim().length<2||hub.label.length>80)
  throw Error('Invalid Hub owner-agent replacement');
 if(!auto.checkpoint||typeof auto.checkpoint!=='object')throw Error('Missing checkpoint');
 return {key:auto.idempotency_key.toLowerCase(),hash:fingerprint(intent)};
}
function ensureJournal(dir,key){
 if(!UUID.test(key))throw Error('Invalid handoff key');
 const root=path.resolve(dir);
 if(fs.existsSync(root)&&fs.lstatSync(root).isSymbolicLink())
  throw Error('Unsafe handoff storage directory');
 const folder=path.join(root,'.mcpgo-handoff-journal');
 fs.mkdirSync(folder,{recursive:true,mode:0o700});
 if(fs.lstatSync(folder).isSymbolicLink())throw Error('Symlink journal forbidden');
 return path.join(folder,key.toLowerCase()+'.json');
}
function writeDurable(file,record,create=false){
 const encoded=JSON.stringify(record,null,2)+'\n';
 if(create){
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,encoded);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
 }else{
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  let fd;
  try{
   fd=fs.openSync(tmp,'wx',0o600);
   fs.writeFileSync(fd,encoded);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   fs.renameSync(tmp,file);
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp)}catch{}}
 }
 if(process.platform!=='win32'){
  const fd=fs.openSync(path.dirname(file),'r');
  try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 }
}
function load(file){
 if(!fs.existsSync(file))return null;
 if(fs.lstatSync(file).isSymbolicLink())throw Error('Symlink journal forbidden');
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!saved||saved.schema!=='MCPGO_CHAT_HANDOFF_V1'||
    !['CLAIMED','AUTOSEND_STAGED','UNKNOWN','NEED_OWNER','COMPLETE'].includes(saved.stage))
  throw Error('Invalid durable handoff journal: owner inspection required');
 return saved;
}
function stage(file,record,stage,extra={}){
 const updated={...record,...extra,stage,updated_at:new Date().toISOString()};
 writeDurable(file,updated);
 return updated;
}
export function readHandoffJournal(dir,key){
 return load(ensureJournal(dir,key));
}
function validateClients(clients){
 if(!clients||!HEX.test(clients.autoToken)||!HEX.test(clients.hubToken)||
    ![clients.autoPort,clients.hubPort].every(v=>Number.isSafeInteger(v)&&v>0&&v<=65535))
  throw Error('Trusted localhost owner credentials unavailable');
}
async function requestJson(port,token,route,method='GET',body=null){
 const raw=body===null?null:Buffer.from(JSON.stringify(body),'utf8');
 // Native http.request preserves the explicit Host header required by Hub.
 // No redirects, retries, remote destinations, or arbitrary request paths.
 const host=route.startsWith('/api/agents')?'127.0.0.1:8971':'127.0.0.1:'+port;
 return await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:route,method,timeout:6500,
   headers:{Host:host,'X-MCPHub-Client':'native','X-MCPHub-Token':token,
    ...(raw===null?{}:{'Content-Type':'application/json','Content-Length':raw.length})}
  },res=>{
   const chunks=[];let total=0;
   res.on('data',chunk=>{
    total+=chunk.length;
    if(total>32768){req.destroy(new Error('Oversize local receipt'));return}
    chunks.push(chunk);
   });
   res.on('end',()=>{
    try{
     const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Unexpected local receipt');
     resolve({status:res.statusCode,data});
    }catch(error){reject(error)}
   });
   res.on('error',reject);
  });
  req.on('timeout',()=>req.destroy(new Error('Local response timeout')));
  req.on('error',reject);
  req.end(raw??undefined);
 });
}
function publicStatus(record,status=record.stage){
 return {status,target_task_id:record.target_task_id||null,
  forwarded:record.forwarded??null,sendBlocked:true};
}
/** Owner-only operation; network POSTs are one-shot and receipts are durable. */
export async function coordinateChatHandoff(dir,intent,clients){
 const {key,hash}=validateIntent(intent);
 validateClients(clients);
 const file=ensureJournal(dir,key);
 let record=load(file);
 if(record){
  if(record.intent_sha256!==hash)throw Error('Conflicting reuse of handoff key');
  return publicStatus(record,record.stage==='COMPLETE'?'ALREADY_COMPLETE':'NEED_OWNER');
 }
 record={schema:'MCPGO_CHAT_HANDOFF_V1',key,intent_sha256:hash,
  old_agent_id:intent.hub.old_id,new_agent_id:intent.hub.new_id,
  old_task_id:intent.auto.source_id,
  target_url_sha256:fingerprint(normalizeTarget(intent.auto.target_url)),stage:'CLAIMED',
  created_at:new Date().toISOString()};
 try{writeDurable(file,record,true)}
 catch(error){
  if(error.code==='EEXIST'){
   const winner=load(file);
   if(winner?.intent_sha256!==hash)throw Error('Conflicting reuse of handoff key');
   return publicStatus(winner,'NEED_OWNER');
  }
  throw error;
 }
 let autoReply;
 try{
  autoReply=await requestJson(clients.autoPort,clients.autoToken,'/api/tasks','POST',{
   action:'handoff_chat',...intent.auto});
 }catch{
  record=stage(file,record,'UNKNOWN',{failure_stage:'AUTOSEND_UNCERTAIN'});
  return publicStatus(record);
 }
 if(autoReply.status!==200){
  record=stage(file,record,'NEED_OWNER',{failure_stage:'AUTOSEND_REJECTED',http_status:autoReply.status});
  return publicStatus(record);
 }
 const answer=autoReply.data;
 if(!['STAGED_PAUSED','ALREADY_STAGED'].includes(answer.status)||
    answer.source_id!==intent.auto.source_id||
    typeof answer.target_id!=='string'||!answer.target_id){
  record=stage(file,record,'UNKNOWN',{failure_stage:'AUTOSEND_RECEIPT_UNVERIFIED'});
  return publicStatus(record);
 }
 record=stage(file,record,'AUTOSEND_STAGED',{target_task_id:answer.target_id});
 let hubReply;
 try{
  hubReply=await requestJson(clients.hubPort,clients.hubToken,'/api/agents/replace','POST',{
   old_id:intent.hub.old_id,id:intent.hub.new_id,
   label:intent.hub.label,chat_url:intent.auto.target_url});
 }catch{
  record=stage(file,record,'UNKNOWN',{failure_stage:'HUB_REPLACEMENT_UNCERTAIN'});
  return publicStatus(record);
 }
 if(hubReply.status!==200){
  record=stage(file,record,'NEED_OWNER',{failure_stage:'HUB_REPLACEMENT_REJECTED',http_status:hubReply.status});
  return publicStatus(record);
 }
 const h=hubReply.data;
 if(h.archived!==intent.hub.old_id||h.agent?.id!==intent.hub.new_id||
    !Number.isSafeInteger(h.forwarded)||h.forwarded<0){
  record=stage(file,record,'UNKNOWN',{failure_stage:'HUB_RECEIPT_UNVERIFIED'});
  return publicStatus(record);
 }
 record=stage(file,record,'COMPLETE',{forwarded:h.forwarded});
 return publicStatus(record);
}
/** Read-only reconciliation; NEVER reissues POST after an unknown outcome. */
export async function reconcileChatHandoff(dir,key,clients){
 validateClients(clients);
 const file=ensureJournal(dir,key);
 let record=load(file);
 if(!record)throw Error('Unknown handoff; cannot infer owner intent');
 if(record.stage==='COMPLETE')return publicStatus(record);
 if(!record.target_task_id)return publicStatus(record,'NEED_OWNER');
 let active,archived,autosend;
 try{
  [active,archived,autosend]=await Promise.all([
   requestJson(clients.hubPort,clients.hubToken,'/api/agents'),
   requestJson(clients.hubPort,clients.hubToken,'/api/agents/archived'),
   requestJson(clients.autoPort,clients.autoToken,'/api/status')]);
 }catch{return publicStatus(record,'UNKNOWN')}
 if(active.status!==200||archived.status!==200||autosend.status!==200||
    !Array.isArray(active.data.agents)||!Array.isArray(archived.data.agents)||
    !Array.isArray(autosend.data.tasks))
  return publicStatus(record,'UNKNOWN');
 const successor=active.data.agents.find(x=>x.id===record.new_agent_id&&!x.archived_at);
 const predecessor=archived.data.agents.find(x=>x.id===record.old_agent_id&&
    x.replaced_by===record.new_agent_id&&x.archived_at);
 const pausedTask=autosend.data.tasks.find(x=>x.id===record.target_task_id&&
    x.enabled===false&&x.status==='paused'&&
    fingerprint(x.url)===record.target_url_sha256);
 const matchingChat=successor&&typeof successor.chat_url==='string'&&
    fingerprint(successor.chat_url)===record.target_url_sha256;
 if(pausedTask&&matchingChat&&predecessor){
  // Hub replacement copies unread in one transaction. Count is not
  // independently recoverable here, so leave forwarded=null.
  record=stage(file,record,'COMPLETE',{reconciled_readonly:true});
  return publicStatus(record);
 }
 return publicStatus(record,'NEED_OWNER');
}
