'use strict';
/** Offline, explicit-only profile snapshot and rollback.
 * No installer, network, child process or live task API is invoked here.
 * Callers must verify quiescence independently; never wire automatic restore.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {snapshotSensitiveState,compareSensitiveState}=require('./upgrade-safety.cjs');
const DEFAULT_FILES=['AutoSend/tasks.json','AutoSend/control-token','AutoSend/message-key'];
function safeDirectory(dir){
 if(typeof dir!=='string'||!path.isAbsolute(dir))throw Error('UPGRADE_BACKUP_UNSAFE_PATH');
 const full=path.resolve(dir);
 let current=full;
 while(true){
  if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())
   throw Error('UPGRADE_BACKUP_UNSAFE_PATH');
  const parent=path.dirname(current);
  if(parent===current)break;
  current=parent;
 }
 return full;
}
function validatedLocations(profileRoot,backupDir){
 const profile=safeDirectory(profileRoot),backup=safeDirectory(backupDir);
 if(backup===profile||backup.startsWith(profile+path.sep)||
    profile.startsWith(backup+path.sep))throw Error('UPGRADE_BACKUP_UNSAFE_PATH');
 const parent=path.dirname(backup);
 if(!fs.existsSync(parent)||!fs.lstatSync(parent).isDirectory())
  throw Error('UPGRADE_BACKUP_UNSAFE_PATH');
 return {profile,backup};
}
function sourceFile(root,name){
 return path.join(root,...name.split('/'));
}
function backupProfileState({profileRoot,backupDir,files=DEFAULT_FILES,version}={}){
 const {profile,backup}=validatedLocations(profileRoot,backupDir);
 if(fs.existsSync(backup))throw Error('UPGRADE_BACKUP_EXISTS');
 if(typeof version!=='string'||!/^preview\.\d{1,4}$/.test(version))
  throw Error('UPGRADE_BACKUP_VERSION');
 const manifest=snapshotSensitiveState(profile,files);
 let created=false;
 try{
  fs.mkdirSync(backup,{mode:0o700});created=true;
  for(const entry of manifest.files){
   const destination=sourceFile(backup,entry.name);
   fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
   fs.copyFileSync(sourceFile(profile,entry.name),destination,fs.constants.COPYFILE_EXCL);
   fs.chmodSync(destination,entry.mode);
  }
  if(compareSensitiveState(backup,manifest).status!=='PRESERVED')
   throw Error('UPGRADE_BACKUP_INTEGRITY');
  const summary={schemaVersion:1,version,files:manifest.files};
  const data=JSON.stringify(summary,null,2)+'\n';
  fs.writeFileSync(path.join(backup,'manifest.json'),data,{flag:'wx',mode:0o600});
  if(verifyProfileBackup(backup).status!=='PRESERVED')
   throw Error('UPGRADE_BACKUP_INTEGRITY');
  return summary;
 }catch(e){if(created)fs.rmSync(backup,{recursive:true,force:true});throw e}
}
function verifyProfileBackup(backupDir){
 try{
  const backup=safeDirectory(backupDir);
  const manifestFile=path.join(backup,'manifest.json');
  const stat=fs.lstatSync(manifestFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)return {status:'DRIFT'};
  const data=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(data?.schemaVersion!==1||typeof data.version!=='string'||
     !/^preview\.\d{1,4}$/.test(data.version)||!Array.isArray(data.files)||
     data.files.length===0||data.files.length>16)return {status:'DRIFT'};
  const snapshot={version:1,files:data.files};
  return compareSensitiveState(backup,snapshot).status==='PRESERVED'?
   {status:'PRESERVED',manifest:data}:{status:'DRIFT'};
 }catch{return {status:'DRIFT'}}
}
function restoreProfileState({profileRoot,backupDir,confirmed=false,quiescent=false,
 expectedLiveSnapshot,beforeReplace=()=>{},afterReplace=()=>{}}={}){
 if(confirmed!==true)throw Error('UPGRADE_RESTORE_UNCONFIRMED');
 if(quiescent!==true)throw Error('UPGRADE_RESTORE_UNSAFE');
 if(expectedLiveSnapshot?.version!==1||!Array.isArray(expectedLiveSnapshot.files))
  throw Error('UPGRADE_RESTORE_STALE');
 const {profile,backup}=validatedLocations(profileRoot,backupDir);
 const verified=verifyProfileBackup(backup);
 if(verified.status!=='PRESERVED')throw Error('UPGRADE_RESTORE_INTEGRITY');
 const manifest=verified.manifest;
 const names=manifest.files.map(x=>x.name);
 const expectedNames=expectedLiveSnapshot.files.map(x=>x.name);
 if(names.length!==expectedNames.length||names.some((x,i)=>x!==expectedNames[i])||
    compareSensitiveState(profile,expectedLiveSnapshot).status!=='PRESERVED')
  throw Error('UPGRADE_RESTORE_STALE');
 const id=crypto.randomUUID();
 const staged=[],preimages=[];
 let recoveryRequired=false;
 try{
  // Copy every archive file to verified adjacent staging before touching live files.
  for(const entry of manifest.files){
   const target=sourceFile(profile,entry.name);
   const temp=target+'.mcpgo-restore-'+id+'.tmp';
   const old=target+'.mcpgo-preimage-'+id+'.tmp';
   if(fs.existsSync(temp)||fs.existsSync(old))throw Error('UPGRADE_RESTORE_UNSAFE');
   staged.push({target,temp,old,name:entry.name});
   fs.copyFileSync(sourceFile(backup,entry.name),temp,fs.constants.COPYFILE_EXCL);
   fs.chmodSync(temp,entry.mode);
   fs.copyFileSync(target,old,fs.constants.COPYFILE_EXCL);
   fs.chmodSync(old,expectedLiveSnapshot.files.find(x=>x.name===entry.name).mode);
   preimages.push(old);
  }
  for(const row of staged){
   beforeReplace(row.name);
   // Windows rename does not replace existing files; keep a preimage on disk
   // so a synchronous failure can return the original content.
   fs.unlinkSync(row.target);
   fs.renameSync(row.temp,row.target);
   afterReplace(row.name);
  }
  if(compareSensitiveState(profile,{version:1,files:manifest.files}).status!=='PRESERVED')
   throw Error('UPGRADE_RESTORE_INTEGRITY');
  return {status:'RESTORED',version:manifest.version,filesRestored:staged.length};
 }catch(e){
  for(const row of staged){
   if(preimages.includes(row.old)){
    try{
     if(fs.existsSync(row.target))fs.unlinkSync(row.target);
     fs.renameSync(row.old,row.target);
    }catch{recoveryRequired=true}
   }
  }
  if(recoveryRequired)throw Error('UPGRADE_RESTORE_RECOVERY_REQUIRED');
  throw e;
 }finally{
  for(const row of staged){
   try{fs.rmSync(row.temp,{force:true})}catch{}
   // Keep recoverable preimages if a filesystem error prevents restoring.
   if(!recoveryRequired){try{fs.rmSync(row.old,{force:true})}catch{}}
  }
 }
}
module.exports={backupProfileState,restoreProfileState,verifyProfileBackup};
