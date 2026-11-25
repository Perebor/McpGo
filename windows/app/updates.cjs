'use strict';
// Unsigned distributions do NOT support unattended installation. This module
// only discovers the next *GitHub-hosted prerelease* and opens its official page
// after an explicit user click. No remote executable or updater code is run.
const OWNER='Perebor';
const REPO='McpGo';
const RELEASES_API='https://api.github.com/repos/'+OWNER+'/'+REPO+'/releases?per_page=20';
const VERSION=/^v(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/;
const ASSET=/^McpGo\.Setup\.\d+\.\d+\.\d+-preview\.\d+\.exe$/;

function parseVersion(version){
 const value=VERSION.exec('v'+String(version).replace(/^v/,''));
 return value?value.slice(1).map(Number):null;
}
function cmp(left,right){
 for(let i=0;i<4;i++)if(left[i]!==right[i])return left[i]-right[i];
 return 0;
}
function latestWindowsPreview(rows,current){
 const base=parseVersion(current);
 if(!base||!Array.isArray(rows))throw Error('RELEASE_DATA_INVALID');
 const valid=rows.filter(row=>{
  if(!row||!row.prerelease||row.draft)return false;
  const tag=parseVersion(row.tag_name);
  if(!tag||cmp(tag,base)<=0)return false;
  if(row.tag_name!=='v'+tag.slice(0,3).join('.')+'-preview.'+tag[3])return false;
  return Array.isArray(row.assets)&&row.assets.some(asset=>
   typeof asset?.name==='string'&&ASSET.test(asset.name)&&
   asset.name==='McpGo.Setup.'+row.tag_name.slice(1)+'.exe'&&
   Number.isSafeInteger(asset.size)&&asset.size>10000000&&asset.size<=1073741824&&
   typeof asset.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(asset.digest));
 });
 valid.sort((a,b)=>cmp(parseVersion(b.tag_name),parseVersion(a.tag_name)));
 const tag=valid[0]?.tag_name;
 if(!tag)return {current,available:false,reason:rows.length===0?'NO_RELEASES':'NO_VERIFIABLE_NEWER_RELEASE'};
 const asset=valid[0].assets.find(a=>a.name==='McpGo.Setup.'+tag.slice(1)+'.exe'&&
  Number.isSafeInteger(a.size)&&a.size>10000000&&a.size<=1073741824&&
  typeof a.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(a.digest));
 return {current,available:true,version:tag.slice(1),
  asset:{name:asset.name,size:asset.size,sha256:asset.digest.slice(7)},
  url:'https://github.com/'+OWNER+'/'+REPO+'/releases/tag/'+tag};
}
async function checkUpdates(version,{fetcher=fetch}={}){
 const response=await fetcher(RELEASES_API,{headers:{
  'Accept':'application/vnd.github+json','User-Agent':'McpGo-Desktop'},
  redirect:'error',signal:AbortSignal.timeout(8500)});
 if(!response.ok)throw Error('RELEASE_CHECK_HTTP_'+response.status);
 const raw=await response.text();
 if(raw.length>1024*1024)throw Error('RELEASES_RESPONSE_TOO_LARGE');
 return latestWindowsPreview(JSON.parse(raw),version);
}
function safeReleaseUrl(url){
 if(typeof url!=='string')throw Error('INVALID_RELEASE_URL');
 const parsed=new URL(url);
 if(parsed.origin!=='https://github.com'||parsed.username||parsed.password||
   !/^\/Perebor\/McpGo\/releases\/tag\/v\d+\.\d+\.\d+-preview\.\d+$/.test(parsed.pathname)||
   parsed.search||parsed.hash)throw Error('UNTRUSTED_RELEASE_URL');
 return parsed.href;
}
// Verify a user-selected file against GitHub metadata; never execute it.
async function verifyInstaller(file,asset){
 const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
 if(!asset||!ASSET.test(asset.name)||!Number.isSafeInteger(asset.size)||asset.size<=0||
    asset.size>1073741824||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256)||
    path.basename(file)!==asset.name)throw Error('INSTALLER_INTEGRITY_METADATA');
 const before=await fs.lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.size!==asset.size)throw Error('INSTALLER_INTEGRITY_SIZE');
 const handle=await fs.open(file,'r');
 try{
  const start=await handle.stat();
  if(!start.isFile()||start.size!==asset.size||start.dev!==before.dev||start.ino!==before.ino)
   throw Error('INSTALLER_INTEGRITY_SIZE');
  const hash=crypto.createHash('sha256');let bytes=0;
  for await(const chunk of handle.createReadStream({autoClose:false})){
   bytes+=chunk.length;if(bytes>asset.size)throw Error('INSTALLER_INTEGRITY_SIZE');hash.update(chunk);
  }
  const end=await handle.stat(),named=await fs.lstat(file),sha256=hash.digest('hex');
  if(bytes!==asset.size||end.size!==start.size||end.mtimeMs!==start.mtimeMs||
     !named.isFile()||named.isSymbolicLink()||named.dev!==end.dev||named.ino!==end.ino||
     named.size!==end.size||named.mtimeMs!==end.mtimeMs||sha256!==asset.sha256)
   throw Error('INSTALLER_INTEGRITY_MISMATCH');
  return {verified:true,sha256};
 }finally{await handle.close()}
}
module.exports={parseVersion,latestWindowsPreview,checkUpdates,safeReleaseUrl,verifyInstaller,RELEASES_API};
