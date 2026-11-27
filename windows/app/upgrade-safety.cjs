'use strict';
/**
 * MCP-07 read-only update gate. Never pauses, sends, installs, restores or
 * infers success from an installed version. Actual NSIS installation needs a
 * separate quiescent handoff and a verified rollback snapshot.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {autoSendStateSafety}=require('./health-contract.cjs');
const MAX_HEALTH_AGE_MS=30000;
const REQUIRED_PROFILE_FILES=Object.freeze([
 'AutoSend/tasks.json','AutoSend/control-token','AutoSend/message-key'
]);
const ALLOWED_PROFILE_FILES=new Set([...REQUIRED_PROFILE_FILES,
 'AutoSend/browser-generation.json','AutoSend/tab-consent.json',
 'connection-health-history.json','terminal/stateless-config.json'
]);
function result(status,reason,nextSafeAction,taskCount=null){
 return Object.freeze({status,reason,nextSafeAction,canInstall:false,taskCount});
}
function assessUpgradeSafety({stateFile,live,healthEvidence,now=Date.now()}={}){
 if(typeof stateFile!=='string'||!stateFile)
  return result('BLOCKED','STATE_UNAVAILABLE','NEED_OWNER');
 if(!autoSendStateSafety(stateFile).safe)
  return result('BLOCKED','AUTOSEND_NOT_QUIESCENT','NEED_OWNER');
 let disk;
 try{
  const stat=fs.lstatSync(stateFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2000000)
   return result('BLOCKED','STATE_UNTRUSTED','NEED_OWNER');
  disk=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  if(!disk||!Array.isArray(disk.tasks)||disk.tasks.length>500)
   return result('BLOCKED','STATE_UNTRUSTED','NEED_OWNER');
 }catch{return result('BLOCKED','STATE_UNAVAILABLE','NEED_OWNER')}
 if(live?.ok!==true||!Array.isArray(live.tasks)||live.busyTask)
  return result('UNKNOWN','LIVE_AUTOSEND_UNAVAILABLE','RECHECK');
 if(live.tasks.length!==disk.tasks.length)
  return result('UNKNOWN','LIVE_STATE_MISMATCH','RECHECK');
 const liveById=new Map();
 for(const t of live.tasks){
  if(typeof t?.id!=='string'||!t.id||liveById.has(t.id))
   return result('UNKNOWN','LIVE_STATE_MISMATCH','RECHECK');
  liveById.set(t.id,t);
 }
 for(const t of disk.tasks){
  const cur=liveById.get(t.id);
  if(!cur||cur.status!==t.status||cur.enabled!==t.enabled||
     cur.delivery_count!==t.delivery_count||
     cur.verification||cur.active_slot_id)
   return result('UNKNOWN','LIVE_STATE_MISMATCH','RECHECK');
 }
 const timestamp=healthEvidence?.checkedAt;
 if(!Number.isFinite(timestamp)||timestamp>now||
    now-timestamp>MAX_HEALTH_AGE_MS)
  return result('UNKNOWN','TELEMETRY_NOT_FRESH','RECHECK');
 const t=healthEvidence.th,b=healthEvidence.bh?.browserQueue;
 if(!Number.isSafeInteger(t?.active)||t.active<0||
    !Number.isSafeInteger(t?.interactive_sessions)||t.interactive_sessions<0||
    !Number.isSafeInteger(b?.waiting)||b.waiting<0||
    !(b.active===false||b.active===true||b.active===0||b.active===1))
  return result('UNKNOWN','QUIESCENCE_NOT_PROVEN','RECHECK');
 if(t.active!==0||t.interactive_sessions!==0||
    b.active===true||b.active===1||b.waiting!==0)
  return result('BLOCKED','ACTIVE_LOCAL_OPERATION','WAIT_FOR_IDLE');
 return result('READY_FOR_BACKUP','QUIESCENT','CREATE_VERIFIED_BACKUP',disk.tasks.length);
}
function validatedProfileFile(profileRoot,relative){
 if(typeof profileRoot!=='string'||!path.isAbsolute(profileRoot)||
    typeof relative!=='string'||!ALLOWED_PROFILE_FILES.has(relative))
  throw Error('INVALID_UPGRADE_FILE');
 const root=path.resolve(profileRoot);
 const file=path.resolve(root,...relative.split('/'));
 if(!file.startsWith(root+path.sep))throw Error('INVALID_UPGRADE_FILE');
 let current=root;
 for(const part of relative.split('/')){
  current=path.join(current,part);
  const stat=fs.lstatSync(current);
  if(stat.isSymbolicLink())throw Error('INVALID_UPGRADE_FILE');
 }
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.size>2000000)throw Error('INVALID_UPGRADE_FILE');
 return {file,stat};
}
/** Metadata only; hashes identify changes without copying or exposing secrets.
 * ACLs must be preserved and validated by the external Windows upgrade runner.
 */
function snapshotSensitiveState(profileRoot,relativePaths=REQUIRED_PROFILE_FILES){
 if(!Array.isArray(relativePaths)||relativePaths.length===0||relativePaths.length>16)
  throw Error('INVALID_UPGRADE_FILE');
 const seen=new Set(),files=[];
 for(const relative of relativePaths){
  if(seen.has(relative))throw Error('DUPLICATE_UPGRADE_FILE');
  seen.add(relative);
  const {file,stat}=validatedProfileFile(profileRoot,relative);
  files.push({name:relative,size:stat.size,mode:stat.mode&0o777,
   sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
 }
 return Object.freeze({version:1,files});
}
function compareSensitiveState(profileRoot,manifest){
 if(manifest?.version!==1||!Array.isArray(manifest.files)||
    manifest.files.length===0||manifest.files.length>16)
  return {status:'UNKNOWN',nextSafeAction:'NEED_OWNER',filesChanged:[]};
 const changed=[];
 try{
  const names=new Set();
  for(const entry of manifest.files){
   if(!entry||typeof entry.name!=='string'||names.has(entry.name)||
      !Number.isSafeInteger(entry.size)||entry.size<0||
      typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||
      !Number.isSafeInteger(entry.mode))
    return {status:'UNKNOWN',nextSafeAction:'NEED_OWNER',filesChanged:[]};
   names.add(entry.name);
   let actual;
   try{actual=snapshotSensitiveState(profileRoot,[entry.name]).files[0]}
   catch{changed.push(entry.name);continue}
   if(actual.size!==entry.size||actual.sha256!==entry.sha256||actual.mode!==entry.mode)
    changed.push(entry.name);
  }
  return changed.length?
   {status:'DRIFT',nextSafeAction:'NEED_OWNER',filesChanged:changed}:
   {status:'PRESERVED',nextSafeAction:'NONE',filesChanged:[]};
 }catch{return {status:'UNKNOWN',nextSafeAction:'NEED_OWNER',filesChanged:[]}}
}
module.exports={assessUpgradeSafety,snapshotSensitiveState,compareSensitiveState};
